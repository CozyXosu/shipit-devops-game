// World: creation (seed state), the tick engine (simulated time), incidents,
// economy, cloud-console actions, and audit. This module is the "game engine"
// the REST API drives.
import { World, GameState, Incident, AlertRule, MetricPoint, OutLine } from './types';
import { makeHost, addProcess } from './sim/host';
import * as fs from './sim/fs';
import { updateDbCpu, seedTables } from './sim/dbsim';
import { lbBackends, hostServesApi } from './sim/net';
import { hashStr } from './sim/docker';

/** Flags hold mixed types; arithmetic needs a numeric guard. */
function num(v: boolean | number | undefined, d = 0): number {
  return typeof v === 'number' ? v : d;
}

export function slugify(name: string): string {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'acme');
}

export function domainOf(world: World): string {
  return `${world.company.slug}.dev`;
}

export function audit(world: World, actor: string, kind: string, text: string): void {
  world.audit.push({ t: world.nowMin, actor, kind, text });
  if (world.audit.length > 900) world.audit.splice(0, world.audit.length - 800);
}

// ------------------------------------------------------------------
// World creation
// ------------------------------------------------------------------
const API_SERVICE_UNIT = `[Unit]
Description=BigMeter API server
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/app/server.js
User=root
Environment=NODE_ENV=production
Restart=always

[Install]
WantedBy=multi-user.target
`;

const SERVER_JS = `// api server — minimal express-like app (game-simulated)
const http = require('http');
const config = require('./config');
const { recordOrder, listOrders } = require('./orders');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }
  if (req.url.startsWith('/api/orders')) {
    return listOrders(req, res);   // SELECT * FROM orders WHERE status = ...
  }
  res.writeHead(404); res.end();
});

server.listen(config.port, () => console.log('listening on :' + config.port));
`;

const CONFIG_JS = `module.exports = {
  port: 8080,
  env: 'production',
  // NOTE: figure out a better place for this before anyone sees it --jd
  dbPassword: "b1gmeter-prod-2024",
  dbFile: "/opt/app/data/app.sqlite",
  apiTimeout: 30,
  retryMax: 3
};
`;

const PACKAGE_JSON = `{
  "name": "bigmeter-api",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node test/run.js"
  }
}
`;

const ORDERS_JS = `// data access — the query the DB mission is about:
//   SELECT * FROM orders WHERE status = $1
module.exports = { listOrders, recordOrder };
`;

const README_MD = `# bigmeter-api

The company's only product right now: a dashboard that tracks meter usage.

- GET /health      -> liveness
- GET /api/orders  -> order list (used by the dashboard)

Run locally: npm start (listens on :8080)
`;

const HANDOFF = `Hey — welcome aboard! Sorry to dump this on you on day one.

  Server:      203.0.113.10  (host "web-01")
  Login:       ssh dev@203.0.113.10     (password is "dev" — change it later)

Some things you should know:

1. The API is DOWN since I rebooted the box this morning. Marketing wants to
   demo to a customer in an hour. Previous dev left some notes on the server
   at ~/notes.txt (dev user).
2. Everything runs on that one machine. There is no CI, no monitoring, no
   backups. I know. That's your job now.
3. Budget for tooling is approved up to $300/month. Don't tell investors.

              — Jordan (founder)
`;

const DEV_NOTES = `notes from the previous dev
===========================

- the api unit is "api.service" (systemd). source lives in /opt/app.
- I used to run an old test server (legacy-server.js) by hand — it does NOT
  die on reboot, it just grabs :8080 again. If the api service fails with
  EADDRINUSE, that's why. Kill the old process first.
- ps aux   -> see processes
- ss -tulpn -> see who owns a port
- journalctl -u api -> service logs
- systemctl start|stop|enable api
- curl localhost:8080/health to check

- the app config is /opt/app/config.js (yes the password is in there, sorry)
`;

const APP_LOG_SEED = `Sep 24 09:14:03 web-01 api[1024]: listening on :8080
Sep 24 09:14:04 web-01 api[1024]: connected to local sqlite /opt/app/data/app.sqlite
`;

export function createWorld(companyName: string, founder: string): World {
  const slug = slugify(companyName);
  const now = 7 * 1440 + 9 * 60 + 31; // day 8, 09:31

  const laptop = makeHost('laptop', 'Your laptop', '10.0.0.2', 'Darwin 23.5.0');
  fs.ensureDir(laptop.fs, '/Users/you');
  fs.writeFile(laptop.fs, '/Users/you/handoff.txt', HANDOFF);
  fs.ensureDir(laptop.fs, '/Users/you/.ssh');
  laptop.users['you'] = { name: 'you', uid: 501, sudo: true, groups: ['staff'] };

  const web = makeHost('web-01', 'web-01 (the box)', '203.0.113.10', 'NimbusOS 22.04 LTS');
  web.users['root'] = { name: 'root', uid: 0, sudo: true, groups: ['root'] };
  web.users['dev'] = { name: 'dev', uid: 1000, sudo: true, groups: ['dev', 'sudo'] };
  web.packages = ['nodejs', 'npm', 'git', 'curl', 'openssh-server'];
  web.diskUsedBaseMB = 6900;

  // filesystem
  fs.ensureDir(web.fs, '/opt/app');
  fs.writeFile(web.fs, '/opt/app/server.js', SERVER_JS);
  fs.writeFile(web.fs, '/opt/app/config.js', CONFIG_JS);
  fs.writeFile(web.fs, '/opt/app/package.json', PACKAGE_JSON);
  fs.writeFile(web.fs, '/opt/app/orders.js', ORDERS_JS);
  fs.writeFile(web.fs, '/opt/app/README.md', README_MD);
  fs.writeFile(web.fs, '/opt/app/legacy-server.js', '// old hand-run test server. TODO: delete me\nrequire("http").createServer((q,s)=>{s.end("legacy ok")}).listen(8080);\n');
  fs.writeFile(web.fs, '/opt/app/.env.example', '# copy to .env and fill in\n# DB_PASSWORD=\n');
  fs.writeFile(web.fs, '/etc/systemd/system/api.service', API_SERVICE_UNIT, 'root', 0o644);
  fs.ensureDir(web.fs, '/var/log');
  fs.writeFile(web.fs, '/var/log/app.log', APP_LOG_SEED, 'root', 0o644);
  fs.writeFile(web.fs, '/var/log/syslog', 'Sep 24 07:17:01 web-01 CRON[2210]: (root) CMD (cd / && run-parts --report /etc/cron.hourly)\n', 'root', 0o644);
  fs.writeFile(web.fs, '/var/log/auth.log', 'Sep 24 08:01:02 web-01 sshd[1991]: Accepted password for dev from 10.0.0.2 port 51482 ssh2\n', 'root', 0o644);
  fs.ensureDir(web.fs, '/home/dev');
  fs.writeFile(web.fs, '/home/dev/notes.txt', DEV_NOTES, 'dev', 0o644);
  fs.ensureDir(web.fs, '/etc/nginx/sites-enabled');
  fs.ensureDir(web.fs, '/etc/logrotate.d');
  fs.ensureDir(web.fs, '/opt/app/data');

  web.services['api'] = {
    name: 'api',
    description: 'BigMeter API server',
    state: 'inactive',
    enabled: false,
    execStart: '/usr/bin/node /opt/app/server.js',
    user: 'root',
    port: 8080,
    log: [
      'Sep 24 07:11:58 web-01 systemd[1]: Started BigMeter API server.',
      'Sep 24 07:11:59 web-01 api[1024]: listening on :8080',
      'Sep 24 07:12:00 web-01 api[1024]: Error: listen EADDRINUSE: address already in use :8080',
      'Sep 24 07:12:00 web-01 api[1024]:     at Server.setupListenListen (node:net:1734:16)',
      'Sep 24 07:12:01 web-01 systemd[1]: api.service: Main process exited, code=exited, status=1/FAILURE',
      'Sep 24 07:12:01 web-01 systemd[1]: api.service: Failed with result \'exit-code\'.'
    ]
  };

  // the stale process the notes mention
  addProcess(web, 'node /opt/app/legacy-server.js', 'root', 8080, undefined, 'sleeping');
  web.processes[0].pid = 1024;
  web.nextPid = 1040;

  const world: World = {
    createdAtMin: now,
    nowMin: now,
    company: { name: companyName, slug, founder, cash: 50000, users: 0, satisfaction: 4.6, launched: false, product: 'BigMeter dashboard' },
    hosts: { laptop, 'web-01': web },
    session: {
      hostId: 'laptop', user: 'you', cwd: '/Users/you',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/Users/you', USER: 'you' },
      pending: null, history: []
    },
    dns: { [`${slug}.dev`]: {} },
    firewall: { enabled: true, allowedPorts: [22] },
    git: {},
    docker: { images: [], containers: [] },
    registry: [],
    db: {
      provisioned: false, plan: 'db.small', endpoint: 'db-01.stratus.cloud', version: '16.3',
      tables: {}, connections: 0, cpuPct: 0, migrationsDone: false, seqScansPerSec: 0
    },
    ci: { runs: [], deployments: [] },
    monitoring: { agentInstalled: false, series: {}, alertRules: [], incidents: [] },
    app: { version: 'v1.0.0', mode: 'stopped', database: 'sqlite', env: {} },
    economy: { lineItems: baseLineItems(), payrollMonthly: 12000, revenueToday: 0, costHistory: [] },
    audit: [],
    flags: { logStartMin: now },
    scheduledEvents: []
  };

  audit(world, 'system', 'game', `Company "${companyName}" founded by ${founder}`);
  audit(world, 'system', 'game', 'Handoff note received. The API is down and the demo is at 10:30.');
  return world;
}

function baseLineItems(): { category: string; label: string; monthlyCost: number }[] {
  return [
    { category: 'Compute', label: 'VM m3.medium (web-01)', monthlyCost: 73 },
    { category: 'Storage', label: 'Block volume 40 GB', monthlyCost: 4 }
  ];
}

// ------------------------------------------------------------------
// Tick engine
// ------------------------------------------------------------------
export function pushPoint(world: World, metric: string, v: number): void {
  const series = world.monitoring.series;
  if (!series[metric]) series[metric] = [];
  const arr = series[metric];
  const last = arr[arr.length - 1];
  if (last && last.t === world.nowMin) { last.v = v; return; }
  arr.push({ t: world.nowMin, v: Math.round(v * 100) / 100 });
  if (arr.length > 1500) arr.splice(0, arr.length - 1400);
}

export function reqRateAt(world: World): number {
  if (!world.company.launched) return 0;
  const hour = (world.nowMin % 1440) / 60;
  const diurnal = 0.55 + 0.45 * Math.sin(((hour - 6) / 24) * Math.PI * 2);
  let rate = world.company.users * 0.02 * diurnal;
  if (world.flags.trafficSpike) rate *= 1.6;
  return rate;
}

function errorSourcesOf(world: World): { n: number; disk: boolean; bad: boolean; db: boolean; drill: boolean } {
  const disk = diskUsagePct(world) >= 99.5;
  const bad = Boolean(world.flags.badDeployBug);
  const db = world.db.provisioned && world.db.cpuPct > 90 && !hasStatusIndex(world);
  const drill = Boolean(world.flags.web01Down) && !haReady(world);
  return { n: (disk ? 2 : 0) + (bad ? 3 : 0) + (db ? 1 : 0) + (drill ? 3 : 0), disk, bad, db, drill };
}

/** Can the load balancer survive losing web-01 right now? */
export function haReady(world: World): boolean {
  if (!world.lb?.provisioned) return false;
  return lbBackends(world).some((b) => b.id !== 'web-01' && b.healthy);
}

function hasStatusIndex(world: World): boolean {
  const t = world.db.tables['orders'];
  return Boolean(t?.indexes.some((ix) => ix.columns.includes('status')));
}

export function diskUsagePct(world: World): number {
  const host = world.hosts['web-01'];
  return ((host.diskUsedBaseMB + logVolumeMB(world)) / host.diskTotalMB) * 100;
}

export function logGrowthPerMin(world: World): number {
  return world.company.launched ? 60 : 0.12; // launched apps log a LOT
}

export function logVolumeMB(world: World): number {
  if (world.flags.logrotateConfigured) return Math.min(52, num(world.flags.logAccumMB));
  return num(world.flags.logAccumMB);
}

export function tick(world: World, minutes: number): void {
  for (let i = 0; i < minutes; i++) tickOne(world);
}

function tickOne(world: World): void {
  world.nowMin += 1;
  const c = world.company;

  // users & revenue
  if (c.launched) {
    const growthPerMin = (c.users * 0.0042 + 90) * (c.satisfaction / 5) / 1440;
    c.users = Math.max(0, c.users + growthPerMin);
    const revenuePerMin = (c.users * 2) / 30 / 1440;
    c.cash += revenuePerMin;
    world.economy.revenueToday += revenuePerMin;
  }
  // costs accrue
  const infraMonthly = monthlyInfraCost(world);
  c.cash -= (infraMonthly + world.economy.payrollMonthly) / 30 / 1440;

  // metrics
  const req = reqRateAt(world);
  const src = errorSourcesOf(world);
  const running = world.app.mode !== 'stopped';
  // two healthy backends share the load
  const haScale = haReady(world) ? 0.55 : 1;
  const cpu = running ? Math.min(98, (6 + req * 0.5 + (src.bad ? 9 : 0) + (world.flags.trafficSpike ? 14 : 0)) * haScale) : 0;
  updateDbCpu(world, req);
  const errorPct = running ? Math.min(80, 0.08 + src.n * 6 + (cpu > 95 ? 1.5 : 0)) : 0;
  const p95 = running ? Math.round(38 + cpu * 1.6 + world.db.cpuPct * 2.1 + (src.bad ? 2400 : 0) + (src.disk ? 700 : 0) + (cpu > 95 ? 900 : 0)) : 0;
  pushPoint(world, 'req_rate', req);
  pushPoint(world, 'error_pct', errorPct);
  pushPoint(world, 'p95_ms', p95);
  pushPoint(world, 'cpu_pct', cpu);
  pushPoint(world, 'mem_pct', running ? 34 + (src.bad ? 22 : 0) + (world.nowMin % 7) * 0.3 : 2);
  pushPoint(world, 'db_cpu_pct', world.db.provisioned ? world.db.cpuPct : 0);
  pushPoint(world, 'disk_pct', diskUsagePct(world));
  pushPoint(world, 'users', Math.round(c.users));

  // uptime window (30d approximation)
  if (errorPct > 5) world.flags.uptimeBadMin = num(world.flags.uptimeBadMin) + 1;
  else world.flags.uptimeBadMin = Math.max(0, num(world.flags.uptimeBadMin) - 1 / 240);

  // app log growth + ENOSPC
  const appLog = fs.getFile(world.hosts['web-01'].fs, '/var/log/app.log');
  if (!appLog) {
    world.flags.logAccumMB = 0.2;
  } else {
    const truncated = appLog.content.length < 500 && num(world.flags.logAccumMB) > 10;
    if (truncated) {
      world.flags.logAccumMB = 0.5;
      audit(world, 'system', 'proc', '/var/log/app.log was truncated — space freed');
    }
    if (!world.flags.logrotateConfigured) world.flags.logAccumMB = num(world.flags.logAccumMB) + logGrowthPerMin(world);
    appLog.diskSizeMB = Math.min(52, world.flags.logrotateConfigured ? Math.min(50, num(world.flags.logAccumMB)) : num(world.flags.logAccumMB));
  }
  if (running && world.nowMin % 10 === 0 && appLog) {
      const day = Math.floor(world.nowMin / 1440) + 1;
      const hh = String(Math.floor((world.nowMin % 1440) / 60)).padStart(2, '0');
      const mm = String(world.nowMin % 60).padStart(2, '0');
      if (src.disk) appLog.content += `Sep ${((day - 1) % 28) + 1} ${hh}:${mm}:00 web-01 api[1024]: Error: ENOSPC: no space left on device, write /var/log/app.log\n`;
      else if (src.bad) appLog.content += `Sep ${((day - 1) % 28) + 1} ${hh}:${mm}:00 web-01 api[1024]: order query failed: 500 (regression v1.5.0)\n`;
      else appLog.content += `Sep ${((day - 1) % 28) + 1} ${hh}:${mm}:00 web-01 api[1024]: GET /api/orders 200 ${Math.round(p95)}ms\n`;
      const lines = appLog.content.split('\n');
      if (lines.length > 400) appLog.content = lines.slice(-300).join('\n');
  }
  if (src.disk && !world.flags.enospcLogged) {
    world.flags.enospcLogged = true;
    audit(world, 'system', 'incident', 'ENOSPC: / is at 100% — the API cannot write logs or receive uploads');
    const api = world.hosts['web-01'].services['api'];
    api?.log.push(`${stamp(world)} web-01 api[1024]: Error: ENOSPC: no space left on device`);
  }
  if (!src.disk) world.flags.enospcLogged = false;

  // logrotate detection
  if (!world.flags.logrotateConfigured && world.nowMin % 5 === 0) {
    const dir = fs.getDir(world.hosts['web-01'].fs, '/etc/logrotate.d');
    if (dir) {
      for (const f of Object.values(dir.children)) {
        if (f.type === 'file' && f.content.includes('/var/log/app.log') && /rotate\s+\d/.test(f.content)) {
          world.flags.logrotateConfigured = true;
          audit(world, 'system', 'config', 'logrotate picked up new configuration — /var/log/app.log will rotate');
        }
      }
    }
  }

  // container health after warmup
  for (const cont of world.docker.containers) {
    if (cont.status === 'running' && !cont.healthy && world.nowMin - cont.startedAtMin >= 2) {
      cont.healthy = true;
      cont.logs.push('health check passed (GET /health 200)');
    }
    if (cont.status === 'running' && cont.hostPort === 8080) {
      // app log lines
      if (world.nowMin % 10 === 0) cont.logs.push(`GET /api/orders 200 ${Math.round(p95)}ms`);
      if (cont.logs.length > 60) cont.logs.splice(0, cont.logs.length - 50);
    }
  }

  // satisfaction drift
  if (c.launched) {
    const target = errorPct > 5 ? 3.4 : 4.7;
    c.satisfaction += (target - c.satisfaction) * 0.01;
  }

  // scheduled events
  const due = world.scheduledEvents.filter((e) => e.atMin <= world.nowMin);
  for (const e of due) {
    world.scheduledEvents = world.scheduledEvents.filter((x) => x !== e);
    if (e.kind === 'traffic_spike') {
      world.flags.trafficSpike = true;
      world.scheduledEvents.push({ atMin: world.nowMin + 240, kind: 'traffic_spike_end' });
      audit(world, 'system', 'event', 'Traffic spike: marketing campaign went live — request rate +60%');
    }
    if (e.kind === 'traffic_spike_end') {
      world.flags.trafficSpike = false;
      audit(world, 'system', 'event', 'Campaign traffic returned to normal levels');
    }
    if (e.kind === 'new_customer') audit(world, 'system', 'sales', 'New enterprise customer signed — revenue up');
    if (e.kind === 'ha_drill') {
      world.flags.web01Down = true;
      audit(world, 'system', 'chaos', 'CHAOS DRILL: web-01 kernel panic — host offline for 30 sim minutes');
      world.scheduledEvents.push({ atMin: world.nowMin + 30, kind: 'ha_drill_end' });
    }
    if (e.kind === 'ha_drill_end') {
      world.flags.web01Down = false;
      if (haReady(world)) {
        world.flags.haDrillSurvived = true;
        audit(world, 'system', 'chaos', 'Failover drill PASSED — the load balancer served all traffic from the remaining backend');
      } else {
        world.company.satisfaction = Math.max(1, world.company.satisfaction - 0.3);
        audit(world, 'system', 'chaos', 'Failover drill FAILED — the site was unreachable while web-01 was down. Customers noticed.');
        world.scheduledEvents.push({ atMin: world.nowMin + 180, kind: 'ha_drill' }); // try again later
      }
    }
  }
  // ambient events after the build phase
  if (world.flags.buildPhaseComplete && Math.random() < 0.0009) {
    const roll = Math.random();
    if (roll < 0.5) world.scheduledEvents.push({ atMin: world.nowMin + 30, kind: 'traffic_spike' });
    else world.scheduledEvents.push({ atMin: world.nowMin + 60, kind: 'new_customer' });
  }

  // emergent incident triggers
  if (diskUsagePct(world) >= 99.5 && !world.monitoring.incidents.some((i) => i.kind === 'disk_full')) {
    openDiskFullIncident(world);
  }
  if (world.flags.badDeployBug) {
    if (world.flags.badDeployAtMin === undefined) world.flags.badDeployAtMin = world.nowMin + 3;
    else if (world.nowMin >= num(world.flags.badDeployAtMin) && !world.monitoring.incidents.some((i) => i.kind === 'bad_deploy')) {
      openBadDeployIncident(world, world.app.image ?? 'unknown');
    }
  }

  // incident resolution checks
  for (const inc of world.monitoring.incidents.filter((x) => x.status === 'open')) {
    if (inc.kind === 'disk_full' && diskUsagePct(world) < 85 && world.flags.logrotateConfigured) resolveIncident(world, inc, 'Disk usage back under 85% with rotation in place');
    if (inc.kind === 'bad_deploy' && !world.flags.badDeployBug && errorPct < 2) resolveIncident(world, inc, 'Error rate recovered after rollback');
  }

  // alert evaluation
  for (const rule of world.monitoring.alertRules) {
    const val = latest(world, rule.metric);
    if (val === null) continue;
    const breach = rule.op === '>' ? val > rule.threshold : rule.op === '<' ? val < rule.threshold : rule.op === '>=' ? val >= rule.threshold : val <= rule.threshold;
    if (breach && rule.state === 'ok') { rule.state = 'pending'; rule.sinceMin = world.nowMin; }
    if (breach && rule.state === 'pending' && rule.sinceMin !== undefined && world.nowMin - rule.sinceMin >= rule.forMinutes) {
      rule.state = 'firing';
      audit(world, 'system', 'alert', `ALERT FIRING: ${rule.label} (${rule.metric} ${rule.op} ${rule.threshold}, now ${val})`);
    }
    if (!breach && rule.state !== 'ok') { rule.state = 'ok'; rule.sinceMin = undefined; }
  }

  // daily economy history
  if (world.nowMin % 1440 === 0) {
    world.economy.costHistory.push({ day: Math.floor(world.nowMin / 1440) + 1, infra: Math.round(infraMonthly / 30), revenue: Math.round(world.economy.revenueToday) });
    world.economy.revenueToday = 0;
  }
}

function stamp(world: World): string {
  const day = Math.floor(world.nowMin / 1440) + 1;
  const hh = String(Math.floor((world.nowMin % 1440) / 60)).padStart(2, '0');
  const mm = String(world.nowMin % 60).padStart(2, '0');
  return `Sep ${String(((day - 1) % 28) + 1).padStart(2, '0')} ${hh}:${mm}:00`;
}

export function latest(world: World, metric: string): number | null {
  const arr = world.monitoring.series[metric];
  return arr && arr.length ? arr[arr.length - 1].v : null;
}

// ------------------------------------------------------------------
// Incidents
// ------------------------------------------------------------------
export function openDiskFullIncident(world: World): void {
  if (world.flags.logrotateConfigured) return;
  if (world.monitoring.incidents.some((i) => i.kind === 'disk_full' && i.status === 'open')) return;
  const inc: Incident = {
    id: 'inc-disk-' + Math.floor(world.nowMin % 100000),
    kind: 'disk_full',
    title: 'Uploads failing & API intermittently returning 500s',
    symptom: 'Customer report (ticket #4412): "Uploads fail with an unknown error, and the dashboard is flaky." Error rate climbing.',
    severity: 'SEV2',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Application logs grow without rotation; / filled to 100% and the API hit ENOSPC.',
    customerImpact: 'Uploads fail; intermittent 5xx for all dashboard users while disk is full.',
    detectedBy: 'customer report + metrics',
    timeline: [],
    corrective: [
      { id: 'rotate', label: 'Configure logrotate for /var/log/app.log', done: false },
      { id: 'diskalert', label: 'Add a disk-usage alert (>85%)', done: false },
      { id: 'resize', label: 'Expand the boot volume in the Cloud console', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  audit(world, 'system', 'incident', `PRODUCTION INCIDENT opened: ${inc.title}`);
}

export function openBadDeployIncident(world: World, image: string): void {
  if (world.monitoring.incidents.some((i) => i.kind === 'bad_deploy' && i.status === 'open')) return;
  const inc: Incident = {
    id: 'inc-deploy-' + Math.floor(world.nowMin % 100000),
    kind: 'bad_deploy',
    title: `Error rate spike after deploying ${image}`,
    symptom: 'Error rate jumped minutes after the release. Customers see failed order lookups.',
    severity: 'SEV1',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Regression shipped in the release: the orders endpoint issues an unindexed query under load.',
    customerImpact: 'Order lookups fail or time out for a large share of users.',
    detectedBy: 'error-rate alert / metrics',
    timeline: [],
    corrective: [
      { id: 'rollback', label: 'Roll back to the previous release', done: false },
      { id: 'erralert', label: 'Have an error-rate alert (>2%)', done: false },
      { id: 'staging', label: 'Add a staging environment before prod (noted for Phase 2)', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  audit(world, 'system', 'incident', `PRODUCTION INCIDENT opened: ${inc.title}`);
  world.audit.push({ t: world.nowMin, actor: 'system', kind: 'incident', text: `Deploy of ${image} marked as the trigger` });
}

export function resolveIncident(world: World, inc: Incident, note: string): void {
  inc.status = 'resolved';
  inc.resolvedAtMin = world.nowMin;
  world.company.satisfaction = Math.min(5, world.company.satisfaction + 0.15);
  audit(world, 'system', 'incident', `INCIDENT RESOLVED: ${inc.title} — ${note}`);
  inc.timeline.push({ t: world.nowMin, actor: 'system', text: note });
}

export function filePostmortem(world: World, incidentId: string, actions: string[]): { ok: boolean; message: string } {
  const inc = world.monitoring.incidents.find((i) => i.id === incidentId);
  if (!inc) return { ok: false, message: 'incident not found' };
  for (const a of inc.corrective) if (actions.includes(a.id)) a.done = true;
  inc.postmortemFiled = true;
  inc.timeline.push({ t: world.nowMin, actor: world.session.user, text: `Postmortem filed (${inc.corrective.filter((c) => c.done).length} corrective actions)` });
  audit(world, world.session.user, 'postmortem', `Postmortem filed for "${inc.title}"`);
  return { ok: true, message: 'postmortem filed' };
}

// ------------------------------------------------------------------
// Cloud console actions
// ------------------------------------------------------------------
export function addDnsRecord(world: World, name: string, type: string, value: string, ttl = 300): { ok: boolean; message: string } {
  const zone = domainOf(world);
  if (!world.dns[zone]) world.dns[zone] = {};
  const fqdn = name.includes('.') ? name : `${name}.${zone}`;
  world.dns[zone][fqdn] = { type, value, ttl };
  audit(world, world.session.user, 'net', `DNS: ${fqdn} ${type} ${value} (TTL ${ttl}s)`);
  return { ok: true, message: `${fqdn} → ${value}` };
}

export function allowPort(world: World, port: number): void {
  if (!world.firewall.allowedPorts.includes(port)) world.firewall.allowedPorts.push(port);
  audit(world, world.session.user, 'net', `Firewall: allowed port ${port}/tcp (cloud console)`);
}

export function provisionDb(world: World, plan: 'db.micro' | 'db.small' | 'db.medium'): { ok: boolean; message: string } {
  if (world.db.provisioned) return { ok: false, message: 'database already provisioned' };
  world.db.provisioned = true;
  world.db.plan = plan;
  world.db.endpoint = 'db-01.stratus.cloud';
  seedTables(world);
  audit(world, world.session.user, 'cloud', `Provisioned managed Postgres (${plan}) at ${world.db.endpoint}`);
  return { ok: true, message: `${plan} provisioned at ${world.db.endpoint}` };
}

export function resizeDb(world: World, plan: 'db.micro' | 'db.small' | 'db.medium'): void {
  world.db.plan = plan;
  audit(world, world.session.user, 'cloud', `Managed database resized to ${plan}`);
}

export function runMigrations(world: World): { ok: boolean; message: string; lines: OutLine[] } {
  if (!world.db.provisioned) return { ok: false, message: 'provision a database first', lines: [] };
  const lines: OutLine[] = [
    { text: '== 20260927090000_create_users.js ==', cls: 'dim' },
    { text: 'CREATE TABLE users (id serial PRIMARY KEY, email text UNIQUE, plan text, created_at timestamptz);' },
    { text: '== 20260927090010_create_orders.js ==', cls: 'dim' },
    { text: 'CREATE TABLE orders (id serial PRIMARY KEY, user_id int REFERENCES users(id), status text, total_cents int, created_at timestamptz);' },
    { text: `copied 1,048,576 rows from sqlite → postgres`, cls: 'ok' },
    { text: 'migrations complete: 2 applied, 0 failed', cls: 'ok' }
  ];
  world.db.migrationsDone = true;
  world.flags.migrationsDone = true;
  world.app.database = 'postgres';
  audit(world, world.session.user, 'db', 'Ran migrations: schema moved to managed Postgres (1.0M orders copied)');
  return { ok: true, message: 'migrations applied', lines };
}

export function resizeDisk(world: World, gb: number): void {
  world.hosts['web-01'].diskTotalMB = gb * 1024;
  audit(world, world.session.user, 'cloud', `Boot volume expanded to ${gb} GB`);
}

export function installMonitoringAgent(world: World): void {
  if (world.monitoring.agentInstalled) return;
  world.monitoring.agentInstalled = true;
  audit(world, world.session.user, 'monitoring', 'Observability agent installed on web-01 (metrics flowing)');
}

// ------------------------------------------------------------------
// Cloud: second VM + load balancer (high availability)
// ------------------------------------------------------------------
export function provisionVm(world: World): { ok: boolean; message: string } {
  if (world.hosts['vm-02']) return { ok: false, message: 'vm-02 already provisioned' };
  const vm = makeHost('vm-02', 'vm-02 (the second box)', '203.0.113.11', 'NimbusOS 22.04 LTS');
  vm.users['root'] = { name: 'root', uid: 0, sudo: true, groups: ['root'] };
  vm.users['deploy'] = { name: 'deploy', uid: 1000, sudo: true, groups: ['deploy'] };
  vm.packages = ['nodejs', 'npm', 'docker.io', 'curl', 'openssh-server'];
  vm.diskUsedBaseMB = 5200;
  world.hosts['vm-02'] = vm;
  audit(world, world.session.user, 'cloud', 'Provisioned vm-02 (203.0.113.11, m3.medium)');
  return { ok: true, message: 'vm-02 provisioned at 203.0.113.11' };
}

export function deployToVm(world: World, hostId = 'vm-02'): { ok: boolean; message: string } {
  const image = [...world.registry].reverse().find((i) => i.repoTags[0].includes('/api:') || i.repoTags[0].includes('api:'));
  if (!image) return { ok: false, message: 'no API image in the registry — run the CI pipeline first' };
  const tag = image.repoTags[0];
  // retire the previous container on that host serving the app port
  for (const c of world.docker.containers) {
    if ((c.hostId ?? 'web-01') === hostId && c.status === 'running' && c.hostPort === 8080) c.status = 'exited';
  }
  const envFile = fs.readFile(world.hosts['web-01'].fs, '/opt/app/.env') ?? '';
  const env: Record<string, string> = {};
  for (const l of envFile.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  world.docker.containers.push({
    id: hashStr(tag + hostId + world.nowMin).slice(0, 12),
    name: 'api-' + hostId + '-' + hashStr(tag + hostId + world.nowMin).toLowerCase().slice(0, 5),
    image: tag,
    env,
    hostPort: 8080,
    containerPort: 8080,
    status: 'running',
    healthy: false, // health check flips after warmup in the tick
    startedAtMin: world.nowMin,
    serviceRef: 'api',
    hostId,
    logs: [`listening on :8080 (image ${tag})`]
  });
  audit(world, world.session.user, 'deploy', `Deployed ${tag} to ${hostId}`);
  return { ok: true, message: `${tag} deployed to ${hostId} (health check warms up in ~2 sim minutes)` };
}

export function provisionLb(world: World): { ok: boolean; message: string } {
  if (world.lb?.provisioned) return { ok: false, message: 'load balancer already provisioned' };
  world.lb = { provisioned: true, ip: '203.0.113.20', label: 'lb-01' };
  audit(world, world.session.user, 'cloud', `Provisioned load balancer lb-01 (${world.lb.ip}) — backends auto-registered by health check`);
  return { ok: true, message: `lb-01 provisioned at ${world.lb.ip} — point DNS at it` };
}

export function startFailoverDrill(world: World): void {
  world.scheduledEvents.push({ atMin: world.nowMin + 1, kind: 'ha_drill' });
}

export function addAlertRule(world: World, metric: string, op: AlertRule['op'], threshold: number, forMinutes = 5): AlertRule {
  const labels: Record<string, string> = {
    error_pct: 'Error rate', cpu_pct: 'CPU', db_cpu_pct: 'Database CPU', p95_ms: 'P95 latency',
    disk_pct: 'Disk usage', mem_pct: 'Memory', req_rate: 'Request rate'
  };
  const rule: AlertRule = {
    id: 'alert-' + Math.random().toString(16).slice(2, 8),
    metric, op, threshold, forMinutes, state: 'ok',
    label: labels[metric] ?? metric
  };
  world.monitoring.alertRules.push(rule);
  audit(world, world.session.user, 'monitoring', `Alert created: ${rule.label} ${op} ${threshold}`);
  return rule;
}

export function removeAlertRule(world: World, id: string): void {
  world.monitoring.alertRules = world.monitoring.alertRules.filter((r) => r.id !== id);
}

// ------------------------------------------------------------------
// Economy
// ------------------------------------------------------------------
export function monthlyInfraCost(world: World): number {
  const items = costLineItems(world);
  return items.reduce((a, i) => a + i.monthlyCost, 0);
}

export function costLineItems(world: World): { category: string; label: string; monthlyCost: number }[] {
  const items: { category: string; label: string; monthlyCost: number }[] = [
    { category: 'Compute', label: 'VM m3.medium (web-01)', monthlyCost: 73 },
    { category: 'Storage', label: `Block volume ${Math.round(world.hosts['web-01'].diskTotalMB / 1024)} GB`, monthlyCost: Math.round(world.hosts['web-01'].diskTotalMB / 10240) }
  ];
  if (world.hosts['vm-02']) items.push({ category: 'Compute', label: 'VM m3.medium (vm-02)', monthlyCost: 73 });
  if (world.lb?.provisioned) items.push({ category: 'Networking', label: 'Load balancer lb-01', monthlyCost: 25 });
  if (world.db.provisioned) {
    items.push({ category: 'Database', label: `Managed Postgres (${world.db.plan})`, monthlyCost: world.db.plan === 'db.micro' ? 45 : world.db.plan === 'db.small' ? 120 : 260 });
  }
  if (world.monitoring.agentInstalled) items.push({ category: 'Monitoring', label: 'Observability agent + 5 GB metrics', monthlyCost: 25 });
  return items;
}

export function uptimePct(world: World): number {
  const bad = num(world.flags.uptimeBadMin);
  return Math.max(90, 100 - (bad / 43200) * 100);
}
