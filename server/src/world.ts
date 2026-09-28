// World: creation (seed state), the tick engine (simulated time), incidents,
// economy, cloud-console actions, and audit. This module is the "game engine"
// the REST API drives.
import { World, GameState, Incident, AlertRule, MetricPoint, OutLine, Engineer, EngineerRole, RefactorProject, TeamState, DebtState, SloState, CloudState, Product, ProductState, FinOpsState, CostLineItem, ChallengeRunState, TournamentState, ZeroTrustState, ComplianceState, ComplianceFinding, EvidenceBundle, PortalState, Trace, EndgameState, DueDiligencePillar } from './types';
import { makeHost, addProcess } from './sim/host';
import * as fs from './sim/fs';
import { updateDbCpu, seedTables } from './sim/dbsim';
import { lbBackends, hostServesApi } from './sim/net';
import { hashStr } from './sim/docker';
import { tickK8s, provisionCluster, resizeNodePool, k8sServes, imageSigned } from './sim/k8s';
import { deployImage } from './sim/ci';
import { PROVIDERS, providerOf, regionOf, isRegion, costMultiplierOf, latencyMsOf, BASE_LATENCY_MS, plannedDowntimeMin, slaCreditFor, migrationCostOf, MIGRATION_DURATION_MIN } from './sim/cloud';
import { CHALLENGES, challengeOf, budgetCapOf, windowedAvailability } from './sim/challenges';

/** Flags hold mixed types; arithmetic needs a numeric guard. */
function num(v: boolean | number | string | undefined, d = 0): number {
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
      tables: {}, connections: 0, cpuPct: 0, migrationsDone: false, seqScansPerSec: 0,
      backups: { enabled: false, retentionDays: 7, snapshots: [] }
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

function errorSourcesOf(world: World): { n: number; disk: boolean; bad: boolean; db: boolean; drill: boolean; dataLoss: boolean } {
  const disk = diskUsagePct(world) >= 99.5;
  const bad = Boolean(world.flags.badDeployBug);
  const db = world.db.provisioned && world.db.cpuPct > 90 && !hasStatusIndex(world);
  const drill = Boolean(world.flags.web01Down) && !haReady(world);
  const dataLoss = (world.db.tables['orders']?.rowCount ?? 1) === 0;
  return { n: (disk ? 2 : 0) + (bad ? 3 : 0) + (db ? 1 : 0) + (drill ? 3 : 0) + (dataLoss ? 4 : 0), disk, bad, db, drill, dataLoss };
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
    let growthPerMin = (c.users * 0.0042 + 90) * (c.satisfaction / 5) / 1440;
    if (num(world.flags.marketingUntilMin) > world.nowMin) growthPerMin *= 2.5;
    c.users = Math.max(0, c.users + growthPerMin);
    const revenuePerMin = (c.users * 2) / 30 / 1440;
    c.cash += revenuePerMin;
    world.economy.revenueToday += revenuePerMin;
    // product revenue (P3): launched products bill their share of users
    const pmrr = productMrrOf(world);
    if (pmrr > 0) {
      const pPerMin = pmrr / 30 / 1440;
      c.cash += pPerMin;
      world.economy.revenueToday += pPerMin;
    }
  }
  // costs accrue
  const infraMonthly = monthlyInfraCost(world);
  c.cash -= (infraMonthly + payrollOf(world)) / 30 / 1440;

  // metrics
  const req = reqRateAt(world);
  tickK8s(world, req);
  const src = errorSourcesOf(world);
  const running = world.app.mode !== 'stopped';
  // a provider outage or migration cutover takes the whole footprint down
  const cloudDown = Boolean(world.cloud?.outage) || world.cloud?.migration?.status === 'cutover';
  const latAdj = latencyMsOf(world.cloud?.provider, world.cloud?.region) - BASE_LATENCY_MS;
  // two healthy backends share the load
  const haScale = haReady(world) ? 0.55 : 1;
  const cpu = running && !cloudDown ? Math.min(98, (6 + req * 0.5 + (src.bad ? 9 : 0) + (world.flags.trafficSpike ? 14 : 0)) * haScale) : 0;
  updateDbCpu(world, req);
  const errorPct = running ? (cloudDown ? 80 : Math.min(80, 0.08 + src.n * 6 + (cpu > 95 ? 1.5 : 0))) : 0;
  const p95 = running
    ? cloudDown
      ? 3000 + latAdj
      : Math.round(38 + latAdj + cpu * 1.6 + world.db.cpuPct * 2.1 + (src.bad ? 2400 : 0) + (src.disk ? 700 : 0) + (cpu > 95 ? 900 : 0))
    : 0;
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

  // satisfaction drift (far-away regions slowly annoy users)
  if (c.launched) {
    const target = errorPct > 5 ? 3.4 : latAdj >= 118 ? 4.5 : 4.7;
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
    if (e.kind === 'marketing_end') audit(world, 'system', 'marketing', 'Marketing campaign finished — growth back to organic');
    if (e.kind === 'ambient_incident') openAmbientIncident(world);
    if (e.kind === 'provider_outage') {
      if (world.cloud?.outage) {
        // one at a time — try again shortly so the armed outage still lands
        world.scheduledEvents.push({ atMin: world.nowMin + 120, kind: 'provider_outage' });
      } else if (world.cloud) {
        openProviderOutage(world);
      }
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
    if (e.kind === 'tf_drift') {
      if (world.db.provisioned && world.db.plan !== 'db.micro') {
        world.db.plan = 'db.micro';
        audit(world, 'intern (console)', 'cloud', 'DRIFT: someone resized the managed database to db.micro from the console "to save money" — terraform was not used');
      }
    }
    if (e.kind === 'dr_drill') {
      const orders = world.db.tables['orders'];
      if (orders && orders.rowCount > 0) {
        orders.rowCount = 0;
        openDataLossIncident(world);
        world.scheduledEvents.push({ atMin: world.nowMin + 240, kind: 'dr_drill_recover' });
      }
    }
    if (e.kind === 'dr_drill_recover') {
      const inc = world.monitoring.incidents.find((i) => i.kind === 'data_loss' && i.status === 'open');
      if (inc) {
        // the player could not restore: provider emergency recovery, painful and slow
        const orders = world.db.tables['orders'];
        if (orders) orders.rowCount = 1048576;
        world.company.cash -= 2000;
        resolveIncident(world, inc, 'Provider emergency snapshot restored orders after ~19h (RPO breached, $2,000 support fee)');
        audit(world, 'system', 'incident', 'DATA LOST for good measure: without your own backups the recovery took a support ticket, 19 hours and $2,000.');
      }
      if (!world.flags.drRestoreDone) {
        // the drill will come back — enable backups and prove a clean restore
        world.scheduledEvents.push({ atMin: world.nowMin + 360, kind: 'dr_drill' });
      }
    }
    if (e.kind === 'tournament_incident') {
      openIncidentOfKind(world, String(e.payload?.kind ?? 'traffic_spike'));
    }
    if (e.kind === 'secret_leak') {
      // P5a (m33): a stray backup file appears with the live secret inside
      const v = world.vault;
      const s = v?.secrets['database/api'];
      if (s) {
        fs.writeFile(world.hosts['web-01'].fs, '/opt/app/notes-old.txt', `# old migration notes (do not delete)\n# db password at time of writing: ${s.value}\nnote to self: rotate this someday\n`, 'dev');
        world.flags.vaultLeakPlanted = true;
        audit(world, 'intern', 'security', 'A stray file /opt/app/notes-old.txt appeared — an old migration note. It looks like it contains a password.');
      }
    }
    if (e.kind === 'exit_scale_check') {
      // P5b (m40): did the platform hold through the announcement traffic?
      const open = world.monitoring.incidents.some((i) => i.status === 'open');
      if (!open && (latest(world, 'error_pct') ?? 99) < 2) {
        world.flags.scaleEventSurvived = true;
        audit(world, 'system', 'game', 'SCALE EVENT SURVIVED: the announcement traffic hit, the platform absorbed it, and the acquirers watched it happen. That is the whole game.');
      } else {
        audit(world, 'system', 'chaos', 'Scale event strained the platform — stabilize it (open incident / error rate) and the check re-runs in 30 sim minutes.');
        world.scheduledEvents.push({ atMin: world.nowMin + 30, kind: 'exit_scale_check' });
      }
    }
    if (e.kind === 'challenge_disaster') {
      const run = world.challenge;
      if (run?.status === 'active' && run.disasterAtMin !== undefined) {
        const orders = world.db.tables['orders'];
        if (orders) orders.rowCount = 0;
        openDataLossIncident(world);
        audit(world, 'auditors', 'challenge', 'CHALLENGE DISASTER: the orders table was dropped. The RTO clock is running — restore from YOUR backups.');
        // if the player cannot restore in time, the provider's emergency path closes the round
        world.scheduledEvents.push({ atMin: world.nowMin + 240, kind: 'challenge_recover_fail' });
      }
    }
    if (e.kind === 'challenge_recover_fail') {
      const run = world.challenge;
      const inc = world.monitoring.incidents.find((i) => i.kind === 'data_loss' && i.status === 'open');
      if (run?.status === 'active' && inc) {
        const orders = world.db.tables['orders'];
        if (orders) orders.rowCount = 1048576;
        world.company.cash -= 2000;
        resolveIncident(world, inc, 'Provider emergency snapshot restored orders after ~19h (RPO breached, $2,000 support fee)');
        failChallenge(world, 'RTO blown: no verified restore inside the window — provider emergency recovery took over (19h, $2,000)');
      }
    }
  }
  // ambient events after the build phase — more likely the deeper the debt
  if (world.flags.buildPhaseComplete && Math.random() < ambientIncidentChance(world)) {
    const roll = Math.random();
    if (roll < 0.35) world.scheduledEvents.push({ atMin: world.nowMin + 5, kind: 'ambient_incident' });
    else if (roll < 0.7) world.scheduledEvents.push({ atMin: world.nowMin + 30, kind: 'traffic_spike' });
    else world.scheduledEvents.push({ atMin: world.nowMin + 60, kind: 'new_customer' });
  }

  // operate phase: canary observation, debt paydown, refactoring projects
  tickCanary(world);
  tickCloud(world); // provider outages + migration progression (P3)
  tickProducts(world); // product builds complete → launch (P3)
  tickFinops(world); // recommendation resolution + budget tracking (P3)
  tickChallenge(world); // challenge-mode constraint scoring (P4)
  tickTournament(world); // rival scoreboard (P4)
  tickPreviews(world); // ephemeral preview environments expire (P5b)
  tickPortal(world); // golden-path self-service deploys (P5b)
  tickTraces(world); // distributed trace sampling (P5b)
  if (world.debt) {
    const team = world.team;
    if (team?.engineers.length) {
      const perDay = team.engineers.reduce((a, e) => a + (ROLE_INFO[e.role]?.debtPerDay ?? 0.2), 0);
      if (world.debt.points > 0) world.debt.points = Math.max(0, world.debt.points - perDay / 1440);
    }
    for (const p of world.debt.projects) {
      if (p.startedAtMin !== undefined && !p.done && world.nowMin - p.startedAtMin >= p.durationMin) {
        p.done = true;
        world.debt.points = Math.max(0, world.debt.points - p.debtRemoved);
        world.debt.log.unshift({ atMin: world.nowMin, text: `-${p.debtRemoved}: ${p.label} completed` });
        if (p.id === 'rm-legacy') {
          fs.rmNode(world.hosts['web-01'].fs, '/opt/app/legacy-server.js');
          world.hosts['web-01'].processes = world.hosts['web-01'].processes.filter((pr) => !pr.cmd.includes('legacy-server'));
        }
        audit(world, 'system', 'debt', `Refactor complete: ${p.label} (-${p.debtRemoved} debt, now ${Math.round(world.debt.points)})`);
      }
    }
  }

  // emergent incident triggers — fog of war: without the agent, incidents are
  // detected by customers, not by alerts, and customers are slow
  if (observeOutage(world, 'disk', diskUsagePct(world) >= 99.5 && !world.monitoring.incidents.some((i) => i.kind === 'disk_full'))) {
    openDiskFullIncident(world);
  }
  if (world.flags.badDeployBug) {
    if (world.flags.badDeployAtMin === undefined) world.flags.badDeployAtMin = world.nowMin + (world.monitoring.agentInstalled ? 3 : BLIND_DETECT_MIN);
    else if (world.nowMin >= num(world.flags.badDeployAtMin) && !world.monitoring.incidents.some((i) => i.kind === 'bad_deploy')) {
      openBadDeployIncident(world, world.app.image ?? 'unknown');
    }
  }
  emitBlindSignals(world, errorPct);

  // incident resolution checks
  for (const inc of world.monitoring.incidents.filter((x) => x.status === 'open')) {
    if (inc.kind === 'disk_full' && diskUsagePct(world) < 85 && world.flags.logrotateConfigured) resolveIncident(world, inc, 'Disk usage back under 85% with rotation in place');
    if (inc.kind === 'bad_deploy' && !world.flags.badDeployBug && errorPct < 2) resolveIncident(world, inc, 'Error rate recovered after rollback');
    if (inc.kind === 'data_loss' && (world.db.tables['orders']?.rowCount ?? 0) >= 900000) resolveIncident(world, inc, 'Orders table restored from backup');
    if (inc.kind === 'traffic_spike' && !world.flags.trafficSpike) resolveIncident(world, inc, 'Traffic surge subsided — capacity held');
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
    // FinOps budget scoreboard (P3)
    if (world.finops?.budgetMonthly) {
      if (infraMonthly <= world.finops.budgetMonthly) world.finops.daysUnderBudget += 1;
      else world.finops.daysOverBudget += 1;
    }
    // daily backup snapshot (if enabled)
    const b = world.db.backups;
    if (world.db.provisioned && b.enabled) {
      b.snapshots.push({
        atMin: world.nowMin,
        label: `snap-day${Math.floor(world.nowMin / 1440) + 1}`,
        ordersRows: world.db.tables['orders']?.rowCount ?? 0,
        sizeGB: 2.1
      });
      if (b.snapshots.length > b.retentionDays) b.snapshots.splice(0, b.snapshots.length - b.retentionDays);
      audit(world, 'system', 'db', `Automated backup completed: ${b.snapshots[b.snapshots.length - 1].label} (${(world.db.tables['orders']?.rowCount ?? 0).toLocaleString()} order rows captured)`);
    }
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
  const blind = !world.monitoring.agentInstalled;
  const inc: Incident = {
    id: 'inc-disk-' + Math.floor(world.nowMin % 100000),
    kind: 'disk_full',
    title: 'Uploads failing & API intermittently returning 500s',
    symptom: blind
      ? 'Customer report (ticket #4412): "Uploads fail with an unknown error, and the dashboard is flaky." No alert ever fired — there was no monitoring to fire one.'
      : 'Disk-usage alert firing. Uploads fail with an unknown error, and the dashboard is flaky. Error rate climbing.',
    severity: 'SEV2',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Application logs grow without rotation; / filled to 100% and the API hit ENOSPC.',
    customerImpact: 'Uploads fail; intermittent 5xx for all dashboard users while disk is full.',
    detectedBy: blind ? 'customer report — no monitoring installed' : 'disk/error alerts (monitoring agent)',
    timeline: blind ? [{ t: world.nowMin, actor: 'system', text: `Impact began earlier — the disk filled ~${BLIND_DETECT_MIN} sim minutes before anyone noticed (no alerting installed)` }] : [],
    corrective: [
      { id: 'rotate', label: 'Configure logrotate for /var/log/app.log', done: false },
      { id: 'diskalert', label: 'Add a disk-usage alert (>85%)', done: false },
      { id: 'resize', label: 'Expand the boot volume in the Cloud console', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  audit(world, 'system', 'incident', `PRODUCTION INCIDENT opened: ${inc.title}`);
  pageOnCall(world, inc);
}

export function openBadDeployIncident(world: World, image: string): void {
  if (world.monitoring.incidents.some((i) => i.kind === 'bad_deploy' && i.status === 'open')) return;
  const blind = !world.monitoring.agentInstalled;
  const inc: Incident = {
    id: 'inc-deploy-' + Math.floor(world.nowMin % 100000),
    kind: 'bad_deploy',
    title: `Error rate spike after deploying ${image}`,
    symptom: blind
      ? 'Customers report failed order lookups. It took complaints to notice — the regression has been live for a while.'
      : 'Error-rate alert fired minutes after the release. Customers see failed order lookups.',
    severity: 'SEV1',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Regression shipped in the release: the orders endpoint issues an unindexed query under load.',
    customerImpact: 'Order lookups fail or time out for a large share of users.',
    detectedBy: blind ? 'customer report — no monitoring installed' : 'error-rate alert (monitoring agent)',
    timeline: blind ? [{ t: world.nowMin, actor: 'system', text: `Impact began earlier — the bad release ran ~${BLIND_DETECT_MIN} sim minutes before detection (no alerting installed)` }] : [],
    corrective: [
      { id: 'rollback', label: 'Roll back to the previous release', done: false },
      { id: 'erralert', label: 'Have an error-rate alert (>2%)', done: false },
      { id: 'staging', label: 'Add a staging environment before prod (noted for Phase 2)', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  audit(world, 'system', 'incident', `PRODUCTION INCIDENT opened: ${inc.title}`);
  pageOnCall(world, inc);
  world.audit.push({ t: world.nowMin, actor: 'system', kind: 'incident', text: `Deploy of ${image} marked as the trigger` });
}

export function resolveIncident(world: World, inc: Incident, note: string): void {
  inc.status = 'resolved';
  inc.resolvedAtMin = world.nowMin;
  world.company.satisfaction = Math.min(5, world.company.satisfaction + 0.15);
  audit(world, 'system', 'incident', `INCIDENT RESOLVED: ${inc.title} — ${note}`);
  inc.timeline.push({ t: world.nowMin, actor: 'system', text: note });
}

/** Page the on-call engineer (if any) when an incident opens; SREs halve the damage. */
export function pageOnCall(world: World, inc: Incident): void {
  const team = world.team;
  const onCall = team?.engineers.find((e) => e.id === team.onCallId);
  addDebt(world, 1, `incident opened: ${inc.title}`);
  if (!onCall) {
    inc.timeline.push({ t: world.nowMin, actor: 'system', text: 'NOBODY IS ON CALL — the pager went to the founder. Again.' });
    return;
  }
  world.flags.onCallPaged = true;
  inc.timeline.push({ t: world.nowMin, actor: onCall.name, text: `paged via on-call rotation — acknowledged in ${onCall.role === 'sre' ? 40 : 180}s` });
  if (onCall.role === 'sre') inc.customerImpact += ' (SRE on call: impact halved by fast mitigation)';
  audit(world, onCall.name, 'incident', `${onCall.name} was paged and acknowledged "${inc.title}"`);
}

/** A minor, self-recovering incident of the operate phase (traffic surge). */
export function openAmbientIncident(world: World): void {
  if (world.monitoring.incidents.some((i) => i.status === 'open')) return;
  const inc: Incident = {
    id: 'inc-ambient-' + Math.floor(world.nowMin % 100000),
    kind: 'traffic_spike',
    title: 'Traffic surge: a big account is hammering the orders API',
    symptom: 'Request rate jumped ~60% — p95 climbing, CPU rising. Nobody broke anything; the world just happened.',
    severity: 'SEV2',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Organic demand spike (a large customer batch-importing orders).',
    customerImpact: 'Slower dashboards while the surge lasts; autoscaling should absorb it.',
    detectedBy: 'traffic alert / metrics',
    timeline: [],
    corrective: [
      { id: 'autoscale', label: 'Have autoscaling absorb the surge (HPA or enough replicas)', done: false },
      { id: 'trafficalert', label: 'Alert on request-rate spikes', done: false },
      { id: 'capacity', label: 'Right-size capacity after the surge', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  world.flags.trafficSpike = true;
  world.scheduledEvents.push({ atMin: world.nowMin + 120, kind: 'traffic_spike_end' });
  audit(world, 'system', 'incident', `INCIDENT opened: ${inc.title}`);
  pageOnCall(world, inc);
}

export function openDataLossIncident(world: World): void {
  if (world.monitoring.incidents.some((i) => i.kind === 'data_loss' && i.status === 'open')) return;
  const inc: Incident = {
    id: 'inc-dataloss-' + Math.floor(world.nowMin % 100000),
    kind: 'data_loss',
    title: 'DATA LOSS: the orders table was dropped by a migration',
    symptom: 'A teammate shipped a "cleanup" migration that dropped the orders table. Every order lookup returns empty results — the API is up but the data is gone.',
    severity: 'SEV1',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: 'Destructive migration shipped without a backup safety net: no automated database backups were verified before running it.',
    customerImpact: 'All order history is unavailable; new orders cannot be recorded while the table is empty.',
    detectedBy: 'error-rate alert + dashboard showing 0 orders',
    timeline: [],
    corrective: [
      { id: 'restore', label: 'Restore the database from backup (Cloud → Databases)', done: false },
      { id: 'backups', label: 'Have automated daily backups enabled BEFORE the incident', done: false },
      { id: 'pitr', label: 'Verify RPO ≤ 24h and record the restore drill RTO', done: false },
      { id: 'review', label: 'Require a second reviewer on destructive migrations', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  audit(world, 'system', 'incident', `PRODUCTION INCIDENT opened: ${inc.title}`);
  pageOnCall(world, inc);
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
  world.monitoring.agentInstalledAtMin ??= world.nowMin;
  audit(world, world.session.user, 'monitoring', 'Observability agent installed on web-01 — telemetry starts flowing NOW (nothing before this moment was ever collected)');
}

// ------------------------------------------------------------------
// Fog of war: the world simulates everything, but the player only sees
// what instrumentation has seen. Without the agent, dashboards are empty,
// alert rules cannot exist, and outages are detected by customers —
// slowly. Manual channels (terminal, provider consoles) stay open:
// automation is what buys continuous sight.
// ------------------------------------------------------------------
/** Sim minutes a customer-visible outage smolders undetected without monitoring. */
export const BLIND_DETECT_MIN = 40;

/**
 * Fog gate for emergent incident detection. Returns true when `condition`
 * has been continuously true long enough to be *detected*: instantly with
 * the observability agent (alerts page you), after customer reports without
 * it. Resets if the condition clears before anyone notices.
 */
function observeOutage(world: World, key: string, condition: boolean): boolean {
  const flag = `blind_${key}SinceMin`;
  if (!condition) {
    if (world.flags[flag] !== undefined) delete world.flags[flag];
    return false;
  }
  if (world.monitoring.agentInstalled) return true;
  if (world.flags[flag] === undefined) {
    world.flags[flag] = world.nowMin;
    return false;
  }
  return world.nowMin - num(world.flags[flag]) >= BLIND_DETECT_MIN;
}

const BLIND_SIGNALS = [
  'support ticket #4412: "checkout spins forever then fails — is it just me?"',
  'tweet: "hey @{slug} your site is throwing errors???"',
  'refund requests ticking up in the payments inbox',
  'customer email: "order lookups keep timing out, we are switching vendors"',
  'app-store-style review drops to 2 stars: "broken all morning"'
];

/** While blind, degradation reaches the player only as customer noise — vague and delayed. */
function emitBlindSignals(world: World, errorPct: number): void {
  if (!world.company.launched || world.monitoring.agentInstalled || errorPct < 5) return;
  if (world.nowMin % 12 !== 0) return;
  const text = BLIND_SIGNALS[Math.floor(world.nowMin / 12) % BLIND_SIGNALS.length].replace('{slug}', world.company.slug);
  audit(world, 'customer', 'signal', text);
}

/** The monitoring view-model: what the player may see of the metrics truth. */
export function metricsView(world: World): { fog: boolean; latest: Record<string, number>; series: Record<string, number[]> } {
  if (!world.monitoring.agentInstalled) return { fog: true, latest: {}, series: {} };
  const since = world.monitoring.agentInstalledAtMin ?? 0;
  const visible = (k: string) => (world.monitoring.series[k] ?? []).filter((p) => p.t >= since);
  const latestOf = (k: string) => {
    const v = visible(k);
    return v.length ? v[v.length - 1].v : 0;
  };
  return {
    fog: false,
    latest: {
      req_rate: latestOf('req_rate'), error_pct: latestOf('error_pct'), p95_ms: latestOf('p95_ms'),
      cpu_pct: latestOf('cpu_pct'), mem_pct: latestOf('mem_pct'), db_cpu_pct: latestOf('db_cpu_pct'),
      disk_pct: Math.round(diskUsagePct(world) * 10) / 10, users: latestOf('users')
    },
    series: {
      cpu_pct: visible('cpu_pct').slice(-120).map((p) => p.v),
      error_pct: visible('error_pct').slice(-120).map((p) => p.v),
      req_rate: visible('req_rate').slice(-90).map((p) => p.v),
      p95_ms: visible('p95_ms').slice(-90).map((p) => p.v),
      db_cpu_pct: visible('db_cpu_pct').slice(-120).map((p) => p.v),
      disk_pct: visible('disk_pct').slice(-200).map((p) => p.v)
    }
  };
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

// ------------------------------------------------------------------
// Cloud: Kubernetes cluster, backups, restore
// ------------------------------------------------------------------
export function provisionK8sCluster(world: World): { ok: boolean; message: string } {
  return provisionCluster(world);
}

export function enableBackups(world: World, retentionDays = 7): { ok: boolean; message: string } {
  if (!world.db.provisioned) return { ok: false, message: 'provision the managed database first' };
  const b = world.db.backups;
  if (b.enabled) return { ok: false, message: 'automated backups are already enabled' };
  b.enabled = true;
  b.enabledAtMin = world.nowMin;
  b.retentionDays = Math.max(1, Math.min(35, retentionDays));
  // an initial snapshot runs immediately when backups are first enabled
  b.snapshots.push({
    atMin: world.nowMin,
    label: 'snap-initial',
    ordersRows: world.db.tables['orders']?.rowCount ?? 0,
    sizeGB: 2.1
  });
  audit(world, world.session.user, 'db', `Automated backups enabled: daily snapshots, ${b.retentionDays}-day retention (first snapshot taken now)`);
  return { ok: true, message: `daily backups enabled (${b.retentionDays}-day retention) — first snapshot taken` };
}

export function restoreBackup(world: World): { ok: boolean; message: string } {
  const b = world.db.backups;
  if (!world.db.provisioned) return { ok: false, message: 'no managed database provisioned' };
  if (!b.enabled) return { ok: false, message: 'automated backups are not enabled (Cloud → Databases → Backups)' };
  const inc = world.monitoring.incidents.find((i) => i.kind === 'data_loss' && i.status === 'open');
  const incidentAt = inc?.openedAtMin;
  // point-in-time restore: latest snapshot taken BEFORE the destructive event
  const usable = incidentAt !== undefined
    ? [...b.snapshots].reverse().find((s) => s.atMin < incidentAt)
    : b.snapshots[b.snapshots.length - 1];
  if (!usable) {
    return { ok: false, message: 'no snapshot exists from before the data loss — there is nothing to restore from (backups must exist BEFORE disaster strikes)' };
  }
  const orders = world.db.tables['orders'];
  if (orders) orders.rowCount = usable.ordersRows;
  else seedTables(world);
  if (inc && incidentAt !== undefined) {
    const rpoMin = incidentAt - usable.atMin;
    const rtoMin = world.nowMin - incidentAt;
    b.lastRestore = { atMin: world.nowMin, fromSnapshotAtMin: usable.atMin, rpoMin, rtoMin };
    world.flags.drRestoreDone = true;
    world.flags.drRpoMin = rpoMin;
    world.flags.drRtoMin = rtoMin;
    world.flags.drRestoreIncident = inc.id;
    audit(world, world.session.user, 'db', `RESTORE DRILL: recovered ${usable.ordersRows.toLocaleString()} order rows from ${usable.label} — RPO ${(rpoMin / 60).toFixed(1)}h, RTO ${(rtoMin / 60).toFixed(1)}h`);
    return { ok: true, message: `restored ${usable.label}: ${usable.ordersRows.toLocaleString()} rows — RPO ${(rpoMin / 60).toFixed(1)}h, RTO ${(rtoMin / 60).toFixed(1)}h` };
  }
  audit(world, world.session.user, 'db', `Restored database from ${usable.label} (${usable.ordersRows.toLocaleString()} rows)`);
  return { ok: true, message: `restored ${usable.label} — ${usable.ordersRows.toLocaleString()} order rows` };
}

export function addAlertRule(world: World, metric: string, op: AlertRule['op'], threshold: number, forMinutes = 5): AlertRule | null {
  if (!world.monitoring.agentInstalled) {
    audit(world, world.session.user, 'monitoring', 'Alert rule rejected — no data source. Install the observability agent first: you cannot alert on data you do not collect.');
    return null;
  }
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
// Operate phase: team, technical debt, marketing, SLOs, canary
// ------------------------------------------------------------------
const ENGINEER_NAMES = ['Priya', 'Marcus', 'Ana', 'Kenji', 'Zoe', 'Ravi', 'Nadia', 'Tomas', 'Iris', 'Felix', 'Maya', 'Sam'];
export const ROLE_INFO: Record<string, { label: string; salary: number; blurb: string; debtPerDay: number }> = {
  junior: { label: 'Junior engineer', salary: 3500, blurb: 'eager, cheap, pays down debt slowly', debtPerDay: 0.15 },
  mid: { label: 'Mid-level engineer', salary: 6000, blurb: 'steady delivery, steady refactoring', debtPerDay: 0.3 },
  senior: { label: 'Senior engineer', salary: 9500, blurb: 'fewer shortcuts taken, calmer incidents', debtPerDay: 0.6 },
  sre: { label: 'SRE', salary: 11000, blurb: 'on-call hero: pages fast, halves customer impact', debtPerDay: 0.5 }
};

export function ensureTeam(world: World): TeamState {
  if (!world.team) world.team = { engineers: [], onCallId: null };
  return world.team;
}

export function hireEngineer(world: World, role: EngineerRole): { ok: boolean; message: string } {
  const team = ensureTeam(world);
  const info = ROLE_INFO[role];
  if (!info) return { ok: false, message: `unknown role "${role}"` };
  if (team.engineers.length >= 6) return { ok: false, message: 'the office only fits six engineers' };
  const taken = new Set(team.engineers.map((e) => e.name));
  const name = ENGINEER_NAMES.find((n) => !taken.has(n)) ?? ('Eng-' + (team.engineers.length + 1));
  const eng: Engineer = { id: 'eng-' + hashStr(name + role).slice(0, 6), name, role, salaryMonthly: info.salary, hiredAtMin: world.nowMin };
  team.engineers.push(eng);
  audit(world, world.session.user, 'team', `Hired ${name} (${info.label}, $${info.salary}/mo)`);
  return { ok: true, message: `${name} joined as ${info.label}` };
}

export function fireEngineer(world: World, id: string): { ok: boolean; message: string } {
  const team = ensureTeam(world);
  const eng = team.engineers.find((e) => e.id === id);
  if (!eng) return { ok: false, message: 'engineer not found' };
  team.engineers = team.engineers.filter((e) => e.id !== id);
  if (team.onCallId === id) team.onCallId = null;
  audit(world, world.session.user, 'team', `${eng.name} left the company`);
  return { ok: true, message: `${eng.name} left the company` };
}

export function setOnCall(world: World, engineerId: string | null): { ok: boolean; message: string } {
  const team = ensureTeam(world);
  if (engineerId && !team.engineers.some((e) => e.id === engineerId)) return { ok: false, message: 'engineer not found' };
  team.onCallId = engineerId;
  const eng = team.engineers.find((e) => e.id === engineerId);
  audit(world, world.session.user, 'team', eng ? `${eng.name} is now on call` : 'on-call rotation cleared');
  return { ok: true, message: eng ? `${eng.name} takes the pager` : 'on-call cleared' };
}

export function payrollOf(world: World): number {
  const team = world.team;
  return world.economy.payrollMonthly + (team ? team.engineers.reduce((a, e) => a + e.salaryMonthly, 0) : 0);
}

// ----- technical debt -----
const REFACTOR_CATALOG: Omit<RefactorProject, 'done'>[] = [
  { id: 'rm-legacy', label: 'Delete the legacy server', detail: 'remove /opt/app/legacy-server.js and its process for good', debtRemoved: 8, costCash: 500, durationMin: 120 },
  { id: 'pipeline-cleanup', label: 'Move manual deploy scripts into CI', detail: 'one pipeline, zero snowflake scripts', debtRemoved: 5, costCash: 1500, durationMin: 360 },
  { id: 'db-audit', label: 'Database query audit', detail: 'find and index the hot paths before they find you', debtRemoved: 5, costCash: 1200, durationMin: 240 },
  { id: 'runbooks', label: 'Write on-call runbooks', detail: 'the next 3 a.m. page answers itself', debtRemoved: 4, costCash: 800, durationMin: 180 }
];

export function ensureDebt(world: World): DebtState {
  if (world.debt) return world.debt;
  // seed from the company's actual history: every incident, shortcut and drift
  let seed = 4;
  const log: { atMin: number; text: string }[] = [{ atMin: world.nowMin, text: 'baseline entropy of a fast-growing platform' }];
  const incidents = world.monitoring.incidents.length;
  if (incidents) { seed += incidents * 2; log.push({ atMin: world.nowMin, text: `${incidents} incident(s) lived through` }); }
  if (fs.getFile(world.hosts['web-01'].fs, '/opt/app/legacy-server.js')) { seed += 4; log.push({ atMin: world.nowMin, text: 'legacy-server.js still lurks in /opt/app' }); }
  if (!world.ci.staging?.image) { seed += 4; log.push({ atMin: world.nowMin, text: 'no staging environment in the pipeline' }); }
  if (world.tf?.driftDetected) { seed += 3; log.push({ atMin: world.nowMin, text: 'unreconciled infrastructure drift' }); }
  world.debt = { points: seed, log, projects: REFACTOR_CATALOG.map((p) => ({ ...p, done: false })) };
  return world.debt;
}

export function addDebt(world: World, points: number, text: string): void {
  const debt = ensureDebt(world);
  debt.points += points;
  debt.log.unshift({ atMin: world.nowMin, text: `+${points}: ${text}` });
  if (debt.log.length > 40) debt.log.splice(debt.log.length - 30);
}

export function startRefactorProject(world: World, projectId: string): { ok: boolean; message: string } {
  const debt = ensureDebt(world);
  const project = debt.projects.find((p) => p.id === projectId);
  if (!project) return { ok: false, message: 'unknown project' };
  if (project.done || project.startedAtMin !== undefined) return { ok: false, message: `${project.label} is already done or running` };
  if (project.id === 'rm-legacy' && !fs.getFile(world.hosts['web-01'].fs, '/opt/app/legacy-server.js')) return { ok: false, message: 'the legacy server is already gone' };
  if (world.company.cash < project.costCash) return { ok: false, message: `not enough cash ($${project.costCash} needed)` };
  world.company.cash -= project.costCash;
  project.startedAtMin = world.nowMin;
  audit(world, world.session.user, 'debt', `Refactoring started: ${project.label} (-${project.debtRemoved} debt on completion)`);
  return { ok: true, message: `${project.label} underway (${Math.round(project.durationMin / 60)}h)` };
}

/** Ambient incident probability grows with unpaid technical debt. */
export function ambientIncidentChance(world: World): number {
  const debt = ensureDebt(world);
  const seniors = ensureTeam(world).engineers.filter((e) => e.role === 'senior').length;
  const dampen = Math.max(0.3, 1 - seniors * 0.15);
  return Math.min(0.004, 0.0009 * (1 + debt.points / 80)) * dampen;
}

// ----- marketing -----
export function runMarketingCampaign(world: World): { ok: boolean; message: string } {
  const cost = 2000;
  if (world.company.cash < cost) return { ok: false, message: 'not enough cash ($2,000 needed)' };
  if (num(world.flags.marketingUntilMin) > world.nowMin) return { ok: false, message: 'a campaign is already running' };
  world.company.cash -= cost;
  world.flags.marketingUntilMin = world.nowMin + 240;
  world.scheduledEvents.push({ atMin: world.nowMin + 240, kind: 'marketing_end' });
  audit(world, world.session.user, 'marketing', 'Marketing campaign launched ($2,000) — expect elevated signups for ~4 sim hours');
  return { ok: true, message: 'campaign live: user growth boosted for ~4 sim hours' };
}

// ----- SLOs / error budgets -----
export function ensureSlos(world: World): SloState {
  if (!world.slos) world.slos = { configured: false, availabilityTarget: 99.5, p95TargetMs: 600 };
  return world.slos;
}

export function configureSlos(world: World, availabilityTarget: number, p95TargetMs: number): { ok: boolean; message: string } {
  if (!(availabilityTarget >= 90 && availabilityTarget <= 99.95)) return { ok: false, message: 'availability target must be between 90 and 99.95' };
  if (!(p95TargetMs >= 200 && p95TargetMs <= 5000)) return { ok: false, message: 'p95 target must be between 200 and 5000 ms' };
  const slos = ensureSlos(world);
  const first = !slos.configured;
  slos.availabilityTarget = availabilityTarget;
  slos.p95TargetMs = p95TargetMs;
  slos.configured = true;
  if (first) slos.setAtMin = world.nowMin;
  audit(world, world.session.user, 'slo', `SLOs ${first ? 'committed' : 'updated'}: availability ≥ ${availabilityTarget}%, p95 < ${p95TargetMs}ms (30-day window)`);
  return { ok: true, message: `SLOs committed: availability ≥ ${availabilityTarget}%, p95 < ${p95TargetMs}ms` };
}

export interface SloReport {
  availability: number;          // current 30d-approx availability %
  availabilityMet: boolean;
  p95Avg: number;                // avg p95 over the last hour of sim time
  p95Met: boolean;
  budgetAllowedMin: number;      // total bad minutes allowed per 30d
  budgetBurnedMin: number;
  budgetRemainingPct: number;
  burnPerDay: number;            // bad minutes burned per sim day, current rate
}

export function sloReport(world: World): SloReport {
  const slos = ensureSlos(world);
  const availability = uptimePct(world);
  const recentP95 = (world.monitoring.series.p95_ms ?? []).slice(-60);
  const p95Avg = recentP95.length ? recentP95.reduce((a, p) => a + p.v, 0) / recentP95.length : 0;
  const windowMin = 30 * 1440;
  const allowed = (100 - slos.availabilityTarget) / 100 * windowMin;
  const burned = num(world.flags.uptimeBadMin);
  const remaining = Math.max(0, 100 - (allowed > 0 ? (burned / allowed) * 100 : 100));
  return {
    availability,
    availabilityMet: availability >= slos.availabilityTarget,
    p95Avg: Math.round(p95Avg),
    p95Met: recentP95.length > 0 && p95Avg < slos.p95TargetMs,
    budgetAllowedMin: Math.round(allowed * 10) / 10,
    budgetBurnedMin: Math.round(burned * 10) / 10,
    budgetRemainingPct: Math.round(remaining * 10) / 10,
    burnPerDay: Math.round(burned / Math.max(1, (world.nowMin - world.createdAtMin) / 1440) * 100) / 100
  };
}

// ----- canary / progressive delivery -----
// (startCanary lives in sim/ci.ts next to the deploy step that triggers it)

export function promoteCanary(world: World, note = 'observation window passed cleanly'): { ok: boolean; message: string } {
  const canary = world.ci.canary;
  if (!canary?.active) return { ok: false, message: 'no canary running' };
  canary.active = false;
  canary.status = 'promoted';
  deployImage(world, canary.image, 'api', 'ci');
  world.flags.canaryPromoted = true;
  world.flags.canaryBugLive = false;
  world.flags.canaryRuntimeBug = false;
  world.flags.nextDeployHasBug = false;
  audit(world, 'ci', 'deploy', `Canary PROMOTED to 100%: ${canary.image} (${note})`);
  return { ok: true, message: `${canary.image} promoted to 100%` };
}

export function abortCanary(world: World, reason: string): { ok: boolean; message: string } {
  const canary = world.ci.canary;
  if (!canary?.active) return { ok: false, message: 'no canary running' };
  canary.active = false;
  canary.status = 'aborted';
  canary.reason = reason;
  const wasBug = Boolean(world.flags.canaryBugLive);
  world.flags.canaryBugLive = false;
  world.flags.canaryRuntimeBug = false;
  world.flags.nextDeployHasBug = false;
  if (wasBug) {
    world.flags.canaryAutoAbort = true;
    addDebt(world, 1, 'regression reached canary stage (caught automatically)');
  }
  audit(world, 'ci', 'deploy', `Canary ABORTED: ${canary.image} — ${reason}. Production was never exposed.`);
  return { ok: true, message: `canary rolled back automatically — prod untouched (${reason})` };
}

/** Canary observation, run each sim minute from the tick. */
function tickCanary(world: World): void {
  const canary = world.ci.canary;
  if (!canary?.active) return;
  const observed = world.nowMin - canary.startedAtMin;
  if (world.flags.canaryBugLive) {
    // regression surfaces after ~5 minutes and trips the abort at ~8
    canary.errorPct = observed < 5 ? 0.2 : Math.min(24, 3 + (observed - 5) * 2.5);
    if (observed >= 8) abortCanary(world, `error rate ${(canary.errorPct).toFixed(1)}% on canary fleet`);
    return;
  }
  canary.errorPct = Math.max(0.05, (world.monitoring.series.error_pct?.at(-1)?.v ?? 0.1) / 2);
  if (observed >= 30) promoteCanary(world);
}
export function monthlyInfraCost(world: World): number {
  const items = costLineItems(world);
  return items.reduce((a, i) => a + i.monthlyCost, 0);
}

/** What the current stack would cost on a given provider+region footprint (list price). */
export function monthlyInfraCostAt(world: World, providerId: string, regionId: string): number {
  return baseCostItems(world).reduce((a, i) => a + (i.cloud ? Math.round(i.monthlyCost * costMultiplierOf(providerId, regionId)) : i.monthlyCost), 0);
}

interface BaseItem { category: string; label: string; monthlyCost: number; cloud: boolean }

/** The stack's line items at list price, before provider/region pricing. */
function baseCostItems(world: World): BaseItem[] {
  const items: BaseItem[] = [
    { category: 'Compute', label: 'VM m3.medium (web-01)', monthlyCost: 73, cloud: true },
    { category: 'Storage', label: `Block volume ${Math.round(world.hosts['web-01'].diskTotalMB / 1024)} GB`, monthlyCost: Math.round(world.hosts['web-01'].diskTotalMB / 10240), cloud: true }
  ];
  if (world.hosts['vm-02']) items.push({ category: 'Compute', label: 'VM m3.medium (vm-02)', monthlyCost: 73, cloud: true });
  if (world.k8s?.provisioned) items.push({ category: 'Compute', label: `Kubernetes cluster k8s-01 (${world.k8s.nodes.length} nodes)`, monthlyCost: 1 + 73 * world.k8s.nodes.length, cloud: true });
  if (world.lb?.provisioned) items.push({ category: 'Networking', label: 'Load balancer lb-01', monthlyCost: 25, cloud: true });
  if (world.db.provisioned) {
    items.push({ category: 'Database', label: `Managed Postgres (${world.db.plan})`, monthlyCost: world.db.plan === 'db.micro' ? 45 : world.db.plan === 'db.small' ? 120 : 260, cloud: true });
    if (world.db.backups.enabled) items.push({ category: 'Database', label: `Automated backups (${world.db.backups.retentionDays}-day retention)`, monthlyCost: 18, cloud: true });
  }
  if (world.ci.staging?.image) items.push({ category: 'CI/CD', label: 'Staging environment runner', monthlyCost: 15, cloud: true });
  if (world.zeroTrust?.meshInstalled) items.push({ category: 'Networking', label: 'Service mesh (identities + mTLS)', monthlyCost: 60, cloud: true });
  if ((world.ci.previews ?? []).length) items.push({ category: 'CI/CD', label: `Preview environments (${(world.ci.previews ?? []).length} live)`, monthlyCost: 8 * (world.ci.previews ?? []).length, cloud: true });
  if (world.db.pooler) items.push({ category: 'Database', label: 'Connection pooler (pgbouncer)', monthlyCost: 12, cloud: true });
  for (const p of world.products?.products ?? []) {
    if (p.launchedAtMin !== undefined) items.push({ category: 'Products', label: `${p.name} (infra)`, monthlyCost: p.infraMonthly, cloud: true });
  }
  if (world.monitoring.agentInstalled) items.push({ category: 'Monitoring', label: 'Observability agent + 5 GB metrics', monthlyCost: 25, cloud: false });
  return items;
}

export function costLineItems(world: World): CostLineItem[] {
  const cloud = world.cloud;
  const mult = cloud ? costMultiplierOf(cloud.provider, cloud.region) : 1;
  // 1-year reserved compute: 20% off compute while you stay on that provider
  const reserved = Boolean(cloud && world.finops?.reservedProvider && world.finops.reservedProvider === cloud.provider);
  return baseCostItems(world).map((i): CostLineItem => {
    let cost = i.cloud ? Math.round(i.monthlyCost * mult) : i.monthlyCost;
    if (reserved && i.category === 'Compute') cost = Math.round(cost * 0.8);
    return {
      category: i.category,
      label: i.label,
      monthlyCost: cost,
      provider: i.cloud && cloud ? `${cloud.provider}/${cloud.region}` : undefined
    };
  });
}

export function uptimePct(world: World): number {
  const bad = num(world.flags.uptimeBadMin);
  return Math.max(90, 100 - (bad / 43200) * 100);
}

// ------------------------------------------------------------------
// Ecosystem phase (P3): multi-cloud providers, migrations, products, FinOps
// ------------------------------------------------------------------
export function ensureCloud(world: World): CloudState {
  if (!world.cloud) {
    // the company has implicitly been on Stratus all along (see db endpoint)
    world.cloud = { provider: 'stratus', region: 'us-east-1', sinceMin: world.nowMin, compared: false, outagesSeen: 0, creditsTotal: 0, migrations: [] };
  }
  return world.cloud;
}

/** Price the current stack on every provider × region; gates migration. */
export function runCloudComparison(world: World): { ok: boolean; message: string; rows?: CloudState['lastComparison'] } {
  if (!world.cloud) return { ok: false, message: 'the provider market opens with the ecosystem missions (m25)' };
  const cloud = world.cloud;
  const rows: NonNullable<CloudState['lastComparison']> = [];
  for (const p of Object.values(PROVIDERS)) {
    for (const r of p.regions) {
      const cost = monthlyInfraCostAt(world, p.id, r.id);
      let note = '';
      if (p.id === cloud.provider && r.id === cloud.region) note = 'current footprint';
      rows.push({ provider: p.id, region: r.id, monthlyCost: cost, note });
    }
  }
  const cheapest = rows.reduce((a, b) => (b.monthlyCost < a.monthlyCost ? b : a));
  const fastest = rows.reduce((a, b) => (providerOf(b.provider).reliabilityPct > providerOf(a.provider).reliabilityPct ? b : a));
  for (const row of rows) {
    if (row === cheapest && !row.note) row.note = 'cheapest';
    if (row === fastest && row !== cheapest && !row.note) row.note = 'most reliable';
  }
  cloud.lastComparison = rows;
  cloud.compared = true;
  audit(world, world.session.user, 'cloud', `Provider comparison run: cheapest ${providerOf(cheapest.provider).name} ${regionOf(cheapest.provider, cheapest.region).id} at $${cheapest.monthlyCost}/mo vs current $${monthlyInfraCost(world)}/mo`);
  return { ok: true, message: `comparison ready — ${rows.length} provider regions priced`, rows };
}

/** A provider-side region outage: unfixable, timed, and billable. */
export function openProviderOutage(world: World): void {
  const cloud = world.cloud;
  if (!cloud || cloud.outage) return;
  const provider = providerOf(cloud.provider);
  const region = regionOf(cloud.provider, cloud.region);
  const durationMin = 15 + Math.floor(Math.random() * 31);
  const inc: Incident = {
    id: 'inc-outage-' + Math.floor(world.nowMin % 100000),
    kind: 'provider_outage',
    title: `${provider.name} ${region.id}: region-wide outage`,
    symptom: `Everything is down and nothing you own is broken: ${provider.name} reports a regional failure (${provider.reliabilityPct}% SLA, and today is why).`,
    severity: 'SEV1',
    openedAtMin: world.nowMin,
    status: 'open',
    rootCause: `Provider-side failure in ${provider.name} ${region.name}. Nothing in your stack caused it and nothing in your stack can fix it — this is what provider reliability ratings are for.`,
    customerImpact: `The entire footprint is unreachable for ~${durationMin} minutes. Multi-region failover would have kept serving; today, everyone waits.`,
    detectedBy: 'error-rate spike + provider status page',
    timeline: [{ t: world.nowMin, actor: 'system', text: `${provider.name} status page: "elevated error rates in ${region.id}"` }],
    corrective: [
      { id: 'credit', label: 'Claim the SLA credit (CLOUD tab — providers pay for their outages)', done: false },
      { id: 'statuspage', label: 'Check the provider status page before debugging your own stack', done: false },
      { id: 'migrate', label: 'Evaluate a footprint with better reliability (provider comparison)', done: false }
    ],
    postmortemFiled: false
  };
  world.monitoring.incidents.unshift(inc);
  cloud.outage = { provider: cloud.provider, region: cloud.region, startedAtMin: world.nowMin, durationMin, creditClaimed: false, incidentId: inc.id };
  cloud.outagesSeen += 1;
  audit(world, 'system', 'incident', `PROVIDER OUTAGE: ${provider.name} ${region.id} is down (${provider.reliabilityPct}% SLA) — ~${durationMin} min, nothing you can fix`);
  pageOnCall(world, inc);
}

/** Provider outages + migration progression, run each sim minute. */
export function tickCloud(world: World): void {
  const cloud = world.cloud;
  if (!cloud) return;
  if (cloud.outage) {
    const o = cloud.outage;
    if (o.endedAtMin === undefined && world.nowMin - o.startedAtMin >= o.durationMin) {
      o.endedAtMin = world.nowMin;
      const inc = world.monitoring.incidents.find((i) => i.id === o.incidentId);
      if (inc && inc.status === 'open') resolveIncident(world, inc, `${providerOf(o.provider).name} restored service after ${o.durationMin} min — claim your SLA credit (CLOUD tab)`);
    }
    // unclaimed credits expire after a sim day
    if (o.endedAtMin !== undefined && !o.creditClaimed && world.nowMin - o.endedAtMin > 1440) {
      audit(world, 'system', 'cloud', `The ${providerOf(o.provider).name} SLA-credit window expired unclaimed — read your provider's terms next time`);
      cloud.outage = undefined;
    }
    return;
  }
  const m = cloud.migration;
  if (m) {
    const elapsed = world.nowMin - m.startedAtMin;
    if (m.status === 'running') {
      const steps = [
        `provisioning the landing zone on ${providerOf(m.toProvider).name} ${regionOf(m.toProvider, m.toRegion).name}`,
        'replicating data and container images to the target region',
        world.ci.staging?.image ? 'rehearsing the cutover against staging' : 'waiting for the cutover window (no staging to rehearse on)'
      ];
      const step = Math.min(steps.length - 1, Math.floor((elapsed / m.durationMin) * 3));
      if (step > m.narrated) {
        m.narrated = step;
        audit(world, 'system', 'cloud', `Migration: ${steps[step]}`);
      }
      if (elapsed >= m.durationMin) {
        m.status = 'cutover';
        m.cutoverEndsAtMin = world.nowMin + m.downtimeMin;
        audit(world, 'system', 'cloud', `MIGRATION CUTOVER: traffic shifting to ${providerOf(m.toProvider).name} ${regionOf(m.toProvider, m.toRegion).id} — expect ~${m.downtimeMin} min of errors`);
      }
    } else if (m.cutoverEndsAtMin !== undefined && world.nowMin >= m.cutoverEndsAtMin) {
      finishMigration(world);
    }
    return;
  }
  // ambient provider outage roll (throttled for the first 10h on a new footprint)
  if (world.nowMin - cloud.sinceMin > 600) {
    const p = providerOf(cloud.provider);
    if (Math.random() < p.outageChancePerDay / 1440) openProviderOutage(world);
  }
}

function finishMigration(world: World): void {
  const cloud = world.cloud;
  const m = cloud?.migration;
  if (!cloud || !m) return;
  const fromProvider = cloud.provider;
  const fromRegion = cloud.region;
  const costAfter = monthlyInfraCostAt(world, m.toProvider, m.toRegion);
  cloud.provider = m.toProvider;
  cloud.region = m.toRegion;
  cloud.sinceMin = world.nowMin;
  if (world.db.provisioned) world.db.endpoint = `db-01.${m.toProvider}.cloud`;
  cloud.migrations.push({ fromProvider, fromRegion, toProvider: m.toProvider, toRegion: m.toRegion, atMin: world.nowMin, downtimeMin: m.downtimeMin, costBefore: m.costBefore, costAfter });
  cloud.migration = undefined;
  const delta = Math.round((1 - costAfter / Math.max(1, m.costBefore)) * 100);
  audit(world, 'system', 'cloud', `Migration complete: ${providerOf(m.toProvider).name} ${regionOf(m.toProvider, m.toRegion).id} now serves everything (cutover ${m.downtimeMin} min of downtime, bill ${delta >= 0 ? '-' : '+'}${Math.abs(delta)}%)`);
}

export function startMigration(world: World, toProvider: string, toRegion: string): { ok: boolean; message: string } {
  const cloud = world.cloud;
  if (!cloud) return { ok: false, message: 'the provider market opens with the ecosystem missions (m25)' };
  if (cloud.migration) return { ok: false, message: 'a migration is already in flight' };
  if (cloud.outage && cloud.outage.endedAtMin === undefined) return { ok: false, message: 'the region is down — wait for the outage to end before migrating into a fire' };
  if (!isRegion(toProvider, toRegion)) return { ok: false, message: `unknown provider/region "${toProvider}/${toRegion}"` };
  if (toProvider === cloud.provider && toRegion === cloud.region) return { ok: false, message: 'already running there' };
  if (!cloud.compared) return { ok: false, message: 'run the provider comparison first (CLOUD → Providers) — never migrate blind' };
  const cost = migrationCostOf(monthlyInfraCost(world));
  if (world.company.cash < cost) return { ok: false, message: `not enough cash (migration costs $${cost.toLocaleString()})` };
  const downtime = plannedDowntimeMin(world.db.backups.enabled, Boolean(world.ci.staging?.image), Boolean(world.lb?.provisioned), Boolean(world.k8s?.provisioned));
  world.company.cash -= cost;
  cloud.migration = {
    toProvider, toRegion,
    startedAtMin: world.nowMin,
    durationMin: MIGRATION_DURATION_MIN,
    downtimeMin: downtime,
    status: 'running',
    costBefore: monthlyInfraCost(world),
    narrated: 0
  };
  audit(world, world.session.user, 'cloud', `Migration to ${providerOf(toProvider).name} ${regionOf(toProvider, toRegion).id} started ($${cost.toLocaleString()}): ${MIGRATION_DURATION_MIN / 60}h of prep, planned cutover downtime ${downtime} min`);
  return { ok: true, message: `migration underway — cutover planned at ~${downtime} min of downtime` };
}

/** Claim the SLA credit for the last provider outage. */
export function claimSlcCredit(world: World): { ok: boolean; message: string } {
  const cloud = world.cloud;
  const o = cloud?.outage;
  if (!o || o.endedAtMin === undefined) return { ok: false, message: 'no settled provider outage to claim against' };
  if (o.creditClaimed) return { ok: false, message: 'credit already claimed' };
  const credit = slaCreditFor(monthlyInfraCost(world), o.durationMin, o.provider);
  o.creditClaimed = true;
  world.company.cash += credit;
  cloud!.creditsTotal += credit;
  const inc = world.monitoring.incidents.find((i) => i.id === o.incidentId);
  inc?.timeline.push({ t: world.nowMin, actor: world.session.user, text: `SLA credit claimed: $${credit} (${providerOf(o.provider).name}, ${providerOf(o.provider).creditMultiplier}× credit terms)` });
  audit(world, world.session.user, 'cloud', `SLA credit claimed from ${providerOf(o.provider).name}: $${credit} for a ${o.durationMin}-minute outage`);
  cloud!.outage = undefined;
  return { ok: true, message: `$${credit} SLA credit applied to your account` };
}

// ----- products -----
const PRODUCT_CATALOG: Omit<Product, 'startedAtMin' | 'launchedAtMin'>[] = [
  {
    id: 'insights', name: 'Insights', tagline: 'analytics dashboards on top of the data you already have',
    tier: 'addon', pricePerUserMonthly: 0.4, adoptionPct: 25, infraMonthly: 20, buildCost: 800, buildDurationMin: 240
  },
  {
    id: 'shiplink', name: 'ShipLink', tagline: 'webhooks + integrations so customers wire you into everything',
    tier: 'growth', pricePerUserMonthly: 1.2, adoptionPct: 15, infraMonthly: 45, buildCost: 1600, buildDurationMin: 360
  },
  {
    id: 'ent-grid', name: 'Enterprise Grid', tagline: 'SSO, audit logs, priority support — the tier big contracts require',
    tier: 'enterprise', pricePerUserMonthly: 6, adoptionPct: 2.5, infraMonthly: 90, buildCost: 3200, buildDurationMin: 480,
    requires: { slos: true, satisfaction: 4, teamSize: 2 }
  }
];

export function ensureProducts(world: World): ProductState {
  if (!world.products) world.products = { products: PRODUCT_CATALOG.map((p) => ({ ...p })) };
  return world.products;
}

/** Why this product cannot be started right now (empty = go). */
export function productBlockers(world: World, product: Product): string[] {
  const blockers: string[] = [];
  if (product.requires?.slos && !world.slos?.configured) blockers.push('enterprise customers need written SLOs first (mission 24)');
  if (product.requires?.satisfaction && world.company.satisfaction < product.requires.satisfaction) blockers.push(`needs satisfaction ≥ ${product.requires.satisfaction} (yours: ${world.company.satisfaction.toFixed(1)})`);
  if (product.requires?.teamSize && (world.team?.engineers.length ?? 0) < product.requires.teamSize) blockers.push(`needs ${product.requires.teamSize} engineers to support it`);
  if (world.company.cash < product.buildCost) blockers.push(`needs $${product.buildCost.toLocaleString()} cash`);
  return blockers;
}

export function startProduct(world: World, productId: string): { ok: boolean; message: string } {
  const state = ensureProducts(world);
  const product = state.products.find((p) => p.id === productId);
  if (!product) return { ok: false, message: 'unknown product' };
  if (product.launchedAtMin !== undefined) return { ok: false, message: `${product.name} is already live` };
  if (product.startedAtMin !== undefined) return { ok: false, message: `${product.name} is already being built` };
  const blockers = productBlockers(world, product);
  if (blockers.length) return { ok: false, message: blockers.join(' · ') };
  world.company.cash -= product.buildCost;
  product.startedAtMin = world.nowMin;
  audit(world, world.session.user, 'product', `Product build started: ${product.name} ($${product.buildCost.toLocaleString()}, ~${Math.round(product.buildDurationMin / 60)}h)`);
  return { ok: true, message: `${product.name} is being built (~${Math.round(product.buildDurationMin / 60)} sim hours)` };
}

/** Monthly recurring revenue from launched products, at current user count. */
export function productMrrOf(world: World): number {
  return (world.products?.products ?? [])
    .filter((p) => p.launchedAtMin !== undefined)
    .reduce((a, p) => a + world.company.users * (p.adoptionPct / 100) * p.pricePerUserMonthly, 0);
}

/** The core subscription: $2 per user per month. */
export function baseMrrOf(world: World): number {
  return world.company.users * 2;
}

/** Product builds complete → launch, run each sim minute. */
function tickProducts(world: World): void {
  for (const p of world.products?.products ?? []) {
    if (p.startedAtMin !== undefined && p.launchedAtMin === undefined && world.nowMin - p.startedAtMin >= p.buildDurationMin) {
      p.launchedAtMin = world.nowMin;
      world.company.satisfaction = Math.min(5, world.company.satisfaction + 0.15);
      const mrr = world.company.users * (p.adoptionPct / 100) * p.pricePerUserMonthly;
      audit(world, 'system', 'product', `PRODUCT LAUNCHED: ${p.name} (${p.tier} tier) — ~$${Math.round(mrr).toLocaleString()}/mo from ${p.adoptionPct}% of users, +$${p.infraMonthly}/mo infra`);
    }
  }
}

// ----- FinOps -----
export function ensureFinops(world: World): FinOpsState {
  if (!world.finops) world.finops = { daysUnderBudget: 0, daysOverBudget: 0, seen: [], resolved: [] };
  return world.finops;
}

/** Captured when the FinOps mission starts, so savings are measured against something real. */
export function setFinopsBaseline(world: World): void {
  const f = ensureFinops(world);
  if (f.baselineMonthly === undefined) {
    f.baselineMonthly = monthlyInfraCost(world);
    f.baselineAtMin = world.nowMin;
  }
}

export function setFinopsBudget(world: World, monthly: number): { ok: boolean; message: string } {
  if (!(monthly >= 100 && monthly <= 100000)) return { ok: false, message: 'budget must be between $100 and $100,000 per month' };
  const f = ensureFinops(world);
  f.budgetMonthly = Math.round(monthly);
  f.budgetSetAtMin = world.nowMin;
  audit(world, world.session.user, 'finops', `Monthly infra budget set: $${f.budgetMonthly.toLocaleString()} (current bill $${monthlyInfraCost(world).toLocaleString()})`);
  return { ok: true, message: `budget set at $${f.budgetMonthly.toLocaleString()}/mo — the daily scoreboard starts now` };
}

/** Commit to 1-year reserved compute on the current provider: 20% off, but only while you stay. */
export function reserveCompute(world: World): { ok: boolean; message: string } {
  const cloud = world.cloud;
  if (!cloud) return { ok: false, message: 'the multi-cloud view opens with the ecosystem missions' };
  const f = ensureFinops(world);
  if (f.reservedProvider) return { ok: false, message: `already committed to ${providerOf(f.reservedProvider).name} for a year` };
  f.reservedProvider = cloud.provider;
  f.reservedAtMin = world.nowMin;
  audit(world, world.session.user, 'finops', `Reserved compute committed: 1 year on ${providerOf(cloud.provider).name}, 20% off compute — void if you migrate away`);
  return { ok: true, message: `reserved: 20% off compute on ${providerOf(cloud.provider).name} for a year` };
}

export interface FinOpsRec {
  id: string;
  label: string;
  detail: string;
  savingsMonthly: number;
  action?: { label: string; kind: 'db-small' | 'db-micro' | 'decomm-vm' | 'k8s-pool' | 'reserve' | 'migrate' };
}

/** Rightsizing recommendations computed from live utilization — pure. */
export function finopsRecommendations(world: World): FinOpsRec[] {
  const recs: FinOpsRec[] = [];
  const mult = world.cloud ? costMultiplierOf(world.cloud.provider, world.cloud.region) : 1;
  // database: average CPU over the last hour decides if the plan is oversized
  if (world.db.provisioned && world.db.plan !== 'db.micro') {
    const recent = (world.monitoring.series.db_cpu_pct ?? []).slice(-60);
    const avg = recent.length ? recent.reduce((a, p) => a + p.v, 0) / recent.length : 0;
    if (avg < 25) {
      const to = world.db.plan === 'db.medium' ? 'db.small' : 'db.micro';
      const save = world.db.plan === 'db.medium' ? 140 : 75;
      recs.push({
        id: `db-${to.replace('db.', '')}`,
        label: `Downsize the database to ${to}`,
        detail: `db CPU has averaged ${avg.toFixed(0)}% for the last sim hour — you are paying for headroom nobody uses`,
        savingsMonthly: Math.round(save * mult),
        action: { label: `resize → ${to}`, kind: world.db.plan === 'db.medium' ? 'db-small' : 'db-micro' }
      });
    }
  }
  // vm-02: a relic once kubernetes took over serving
  if (world.hosts['vm-02'] && (k8sServes(world) || !hostServesApi(world, 'vm-02'))) {
    recs.push({
      id: 'decomm-vm',
      label: 'Decommission vm-02',
      detail: 'the Kubernetes cluster serves the API now — vm-02 is a $73 relic with a login prompt',
      savingsMonthly: Math.round(73 * mult),
      action: { label: 'decommission vm-02', kind: 'decomm-vm' }
    });
  }
  // kubernetes: three nodes for a two-replica workload
  if (world.k8s?.provisioned && world.k8s.nodes.length >= 3 && Object.values(world.k8s.deployments).every((d) => d.replicas <= 2)) {
    recs.push({
      id: 'k8s-pool',
      label: 'Scale the node pool 3 → 2',
      detail: 'every deployment runs ≤2 replicas — the third node is idle insurance',
      savingsMonthly: Math.round(73 * mult),
      action: { label: 'scale pool to 2 nodes', kind: 'k8s-pool' }
    });
  }
  // reserved pricing
  const f = world.finops;
  if (f && !f.reservedProvider) {
    const compute = baseCostItems(world).filter((i) => i.category === 'Compute').reduce((a, i) => a + i.monthlyCost, 0);
    recs.push({
      id: 'reserve-compute',
      label: 'Commit to 1-year reserved compute',
      detail: `20% off compute in exchange for staying put on ${world.cloud ? providerOf(world.cloud.provider).name : 'your provider'} for a year — savings plans reward stability`,
      savingsMonthly: Math.round(compute * mult * 0.2),
      action: { label: 'reserve 1 year', kind: 'reserve' }
    });
  }
  // provider arbitrage
  if (world.cloud && world.cloud.provider === 'stratus' && world.cloud.region === 'us-east-1') {
    const voltCost = monthlyInfraCostAt(world, 'volt', 'us-central-1');
    const now = monthlyInfraCost(world);
    if (voltCost < now) {
      recs.push({
        id: 'migrate-volt',
        label: 'Evaluate Volt us-central-1',
        detail: `same stack for ~$${voltCost.toLocaleString()}/mo instead of $${now.toLocaleString()} — but the SLA is 99.5% and outages are ~3.6× likelier`,
        savingsMonthly: now - voltCost,
        action: { label: 'plan the migration', kind: 'migrate' }
      });
    }
  }
  return recs;
}

/** Recommendation tracking: a rec that vanishes from the list was acted on. */
function tickFinops(world: World): void {
  const f = world.finops;
  if (!f) return;
  const ids = finopsRecommendations(world).map((r) => r.id);
  for (const id of f.seen) {
    if (!ids.includes(id) && !f.resolved.includes(id)) f.resolved.push(id);
  }
  f.seen = ids;
}

/** Remove a provisioned VM and everything running on it. */
export function decommissionVm(world: World, hostId: string): { ok: boolean; message: string } {
  if (hostId === 'web-01') return { ok: false, message: 'web-01 is the original box — it stays' };
  const host = world.hosts[hostId];
  if (!host) return { ok: false, message: 'no such VM' };
  delete world.hosts[hostId];
  world.docker.containers = world.docker.containers.filter((c) => (c.hostId ?? 'web-01') !== hostId);
  if (world.session.hostId === hostId) {
    world.session.hostId = 'laptop';
    world.session.cwd = '/Users/you';
    world.session.pending = null;
  }
  audit(world, world.session.user, 'cloud', `Decommissioned ${hostId} (${host.ip}) — containers retired, $${Math.round(73 * (world.cloud ? costMultiplierOf(world.cloud.provider, world.cloud.region) : 1))}/mo saved`);
  return { ok: true, message: `${hostId} decommissioned` };
}

// ------------------------------------------------------------------
// Modes & content at scale (P4): challenges, packs/tournament, access
// ------------------------------------------------------------------

/** Open a specific incident kind on demand (tournament rounds, packs). */
export function openIncidentOfKind(world: World, kind: string): void {
  switch (kind) {
    case 'disk_full':
      openDiskFullIncident(world);
      break;
    case 'bad_deploy':
      // arm the regression so the incident stays open until a rollback
      world.flags.badDeployBug = true;
      world.flags.badDeployAtMin = world.nowMin;
      openBadDeployIncident(world, world.app.image ?? 'registry/api:v1.9.0');
      break;
    case 'traffic_spike':
      openAmbientIncident(world);
      break;
    case 'data_loss': {
      const orders = world.db.tables['orders'];
      if (orders) orders.rowCount = 0;
      openDataLossIncident(world);
      break;
    }
    case 'provider_outage':
      openProviderOutage(world);
      break;
    default:
      openAmbientIncident(world);
  }
}

// ----- postmortem tournament -----

/** Seed the rival scoreboard the moment the tournament pack activates. */
export function ensureTournament(world: World): TournamentState {
  if (!world.tournament) {
    world.tournament = {
      joinedAtMin: world.nowMin,
      points: 0,
      roundsWon: 0,
      rivals: [
        { name: 'Cloud Nine', points: 0 },
        { name: 'Null Pointers', points: 0 },
        { name: 'Ping Payments', points: 0 }
      ],
      finished: false
    };
    audit(world, 'system', 'tournament', 'POSTMORTEM TOURNAMENT: you are on the board against Cloud Nine, Null Pointers and Ping Payments. Live standings in the MODES tab.');
  }
  return world.tournament;
}

/** Rivals play the same gauntlet: they score steadily while the clock runs. */
function tickTournament(world: World): void {
  const t = world.tournament;
  if (!t || t.finished) return;
  const last = t.lastRivalTickMin ?? t.joinedAtMin;
  if (world.nowMin - last < 15) return;
  t.lastRivalTickMin = world.nowMin;
  for (const r of t.rivals) {
    r.points = Math.round((r.points + 0.25 + Math.random() * 0.2) * 10) / 10;
  }
}

/** Freeze the board and place the player (1 = champion). */
export function finishTournament(world: World): void {
  const t = world.tournament;
  if (!t || t.finished) return;
  t.finished = true;
  t.place = 1 + t.rivals.filter((r) => r.points > t.points).length;
  if (t.place === 1) {
    audit(world, 'system', 'tournament', `TOURNAMENT CHAMPION — ${t.points} points vs ${t.rivals.map((r) => `${r.name} ${r.points}`).join(', ')}. The trophy is a postmortem template. Frame it.`);
  } else {
    audit(world, 'system', 'tournament', `Tournament finished in place ${t.place} (${t.points} points). The winners recovered faster and wrote it down — next season is another chance.`);
  }
}

/** Player settings from the Access & language panel (P4 mission flags). */
export function setPlayerSettings(world: World, opts: { locale?: string; highContrast?: boolean; largeText?: boolean; reducedMotion?: boolean }): { ok: boolean; message: string } {
  const changes: string[] = [];
  if (opts.locale !== undefined && typeof opts.locale === 'string' && ['en', 'es', 'de'].includes(opts.locale)) {
    world.flags.locale = opts.locale;
    changes.push(`language: ${opts.locale}`);
  }
  const toggles: [keyof typeof opts, string][] = [['highContrast', 'a11yHighContrast'], ['largeText', 'a11yLargeText'], ['reducedMotion', 'a11yReducedMotion']];
  for (const [opt, flag] of toggles) {
    const v = opts[opt];
    if (v === undefined) continue;
    world.flags[flag] = Boolean(v);
    changes.push(`${flag}: ${Boolean(v)}`);
  }
  if (world.flags.a11yHighContrast || world.flags.a11yLargeText || world.flags.a11yReducedMotion) world.flags.a11yUsed = true;
  if (typeof world.flags.locale === 'string' && world.flags.locale !== 'en') world.flags.localeUsed = true;
  if (!changes.length) return { ok: false, message: 'nothing to change' };
  return { ok: true, message: `settings saved (${changes.join(', ')})` };
}

// ----- challenge mode -----

export function startChallenge(world: World, challengeId: string): { ok: boolean; message: string } {
  if (world.challenge?.status === 'active') return { ok: false, message: 'a challenge is already running — finish or abandon it first' };
  const def = challengeOf(challengeId);
  if (!def) return { ok: false, message: `unknown challenge "${challengeId}"` };
  if (!world.flags.sandbox && !world.flags.ecosystemPhaseComplete) {
    return { ok: false, message: 'challenges open after mission 28 (or in sandbox) — the endgame assumes the whole toolbox' };
  }
  const run: ChallengeRunState = {
    id: def.id,
    startedAtMin: world.nowMin,
    durationMin: Math.round(def.durationDays * 1440),
    status: 'active',
    days: []
  };
  if (def.rule === 'budget') {
    run.billAtStart = monthlyInfraCost(world);
    run.capMonthly = budgetCapOf(def, run.billAtStart);
  }
  if (def.rule === 'availability') {
    run.badMinAtStart = num(world.flags.uptimeBadMin);
    // the auditors brought a pop quiz
    world.scheduledEvents.push({ atMin: world.nowMin + 200, kind: 'ha_drill' });
    world.scheduledEvents.push({ atMin: world.nowMin + 600, kind: 'traffic_spike' });
  }
  if (def.rule === 'rto') {
    const [lo, hi] = def.disasterWindowMin ?? [180, 540];
    run.disasterAtMin = world.nowMin + lo + Math.floor(Math.random() * (hi - lo));
    world.scheduledEvents.push({ atMin: run.disasterAtMin, kind: 'challenge_disaster' });
  }
  world.challenge = run;
  world.flags.challengesStarted = num(world.flags.challengesStarted) + 1;
  audit(world, world.session.user, 'challenge', `CHALLENGE ACCEPTED: ${def.name} — ${def.ruleLabel} (scoreboard in the MODES tab)`);
  return { ok: true, message: `${def.name} underway — ${def.ruleLabel}` };
}

export function abandonChallenge(world: World): { ok: boolean; message: string } {
  const run = world.challenge;
  if (!run || run.status !== 'active') return { ok: false, message: 'no active challenge' };
  failChallenge(world, 'abandoned by the operator');
  return { ok: true, message: 'challenge abandoned — the scoreboard keeps the scar' };
}

function passChallenge(world: World, score: number, verdict: string): void {
  const run = world.challenge;
  if (!run || run.status !== 'active') return;
  run.status = 'passed';
  run.score = Math.round(score * 100) / 100;
  run.verdict = verdict;
  world.flags.challengesPassed = num(world.flags.challengesPassed) + 1;
  world.company.cash += 5000;
  audit(world, 'system', 'challenge', `CHALLENGE PASSED: ${verdict} (+$5,000 prize money)`);
}

function failChallenge(world: World, verdict: string): void {
  const run = world.challenge;
  if (!run || run.status !== 'active') return;
  run.status = 'failed';
  run.verdict = verdict;
  audit(world, 'system', 'challenge', `CHALLENGE FAILED: ${verdict}`);
}

/** Live constraint readouts for the scoreboard (used by the API view). */
export function challengeLive(world: World): {
  billNow: number; capMonthly: number | null; windowedAvailabilityPct: number | null;
  badMinutes: number; minutesElapsed: number; restoredAfterDisaster: boolean;
} | null {
  const run = world.challenge;
  if (!run) return null;
  const def = challengeOf(run.id);
  if (!def) return null;
  const elapsed = world.nowMin - run.startedAtMin;
  const bad = Math.max(0, num(world.flags.uptimeBadMin) - (run.badMinAtStart ?? 0));
  return {
    billNow: monthlyInfraCost(world),
    capMonthly: run.capMonthly ?? null,
    windowedAvailabilityPct: def.rule === 'availability' ? Math.round(windowedAvailability(bad, elapsed) * 100) / 100 : null,
    badMinutes: Math.round(bad),
    minutesElapsed: elapsed,
    restoredAfterDisaster: run.disasterAtMin !== undefined
      ? Boolean(world.flags.drRestoreDone && (world.db.tables['orders']?.rowCount ?? 0) >= 900000)
      : false
  };
}

/** Daily constraint grading + RTO early pass/fail, run each sim minute. */
function tickChallenge(world: World): void {
  const run = world.challenge;
  if (!run || run.status !== 'active') return;
  const def = challengeOf(run.id);
  if (!def) return;
  const elapsed = world.nowMin - run.startedAtMin;

  if (def.rule === 'rto') {
    // early pass the moment a valid restore lands after the disaster
    if (run.disasterAtMin !== undefined && world.nowMin > run.disasterAtMin) {
      const rto = typeof world.flags.drRtoMin === 'number' && world.flags.drRestoreDone ? world.flags.drRtoMin : null;
      const restoredRows = (world.db.tables['orders']?.rowCount ?? 0) >= 900000;
      const rpoOk = typeof world.flags.drRpoMin === 'number' ? world.flags.drRpoMin <= 1440 : false;
      if (rto !== null && restoredRows && rpoOk) {
        passChallenge(world, rto, `restored in ${rto} min (target \u2264 ${def.rtoTargetMin}, RPO ${(num(world.flags.drRpoMin) / 60).toFixed(1)}h)`);
        return;
      }
    }
  }

  // daily verdicts
  const dayDue = Math.floor(elapsed / 1440);
  if (dayDue >= 1 && run.days.length < dayDue) {
    const day = run.days.length + 1;
    if (def.rule === 'budget') {
      const bill = monthlyInfraCost(world);
      const cap = run.capMonthly ?? Infinity;
      const ok = bill <= cap;
      run.days.push({ day, ok, detail: `day ${day}: $${bill}/mo vs cap $${cap}/mo` });
      if (!ok) {
        failChallenge(world, `day ${day} over the austerity cap: $${bill}/mo vs $${cap}/mo allowed`);
        return;
      }
    } else if (def.rule === 'availability') {
      const bad = Math.max(0, num(world.flags.uptimeBadMin) - (run.badMinAtStart ?? 0));
      const avail = windowedAvailability(bad, Math.min(elapsed, run.durationMin));
      const floor = def.availabilityFloorPct ?? 99.5;
      run.days.push({ day, ok: avail >= floor, detail: `day ${day}: ${avail.toFixed(2)}% windowed vs floor ${floor}%` });
      if (avail < floor) {
        failChallenge(world, `day ${day}: windowed availability ${avail.toFixed(2)}% below the ${floor}% floor`);
        return;
      }
    } else {
      run.days.push({ day, ok: true, detail: `day ${day}: disaster survived so far` });
    }
  }

  // final verdict at the window's end
  if (elapsed >= run.durationMin) {
    if (def.rule === 'budget') {
      const bill = monthlyInfraCost(world);
      const cap = run.capMonthly ?? Infinity;
      if (bill <= cap) {
        const start = run.billAtStart ?? bill;
        const score = start > 0 ? Math.round((1 - bill / start) * 10000) / 100 : 0; // cut achieved, %
        passChallenge(world, score, `held the bill at $${bill}/mo against a $${cap}/mo cap`);
      } else {
        failChallenge(world, `final day over the cap: $${bill}/mo vs $${cap}/mo`);
      }
    } else if (def.rule === 'availability') {
      const bad = Math.max(0, num(world.flags.uptimeBadMin) - (run.badMinAtStart ?? 0));
      const avail = windowedAvailability(bad, run.durationMin);
      passChallenge(world, avail, `${avail.toFixed(2)}% windowed availability over ${def.durationDays} days`);
    } else {
      const rto = typeof world.flags.drRtoMin === 'number' && world.flags.drRestoreDone ? world.flags.drRtoMin : null;
      if (rto !== null && rto <= (def.rtoTargetMin ?? 120) && (world.db.tables['orders']?.rowCount ?? 0) >= 900000) {
        passChallenge(world, rto, `restored in ${rto} min`);
      } else {
        failChallenge(world, 'window closed without a verified in-time restore');
      }
    }
  }
}

// =====================================================================
// P5 — Trust & Scale: zero trust, compliance, portal, previews,
// tracing, and the acquisition endgame.
// =====================================================================

// ----- zero trust (P5a, m34) -----

export function ensureZeroTrust(world: World): ZeroTrustState {
  if (!world.zeroTrust) {
    world.zeroTrust = { meshInstalled: false, meshInstalledAtMin: 0, mtlsStrict: false, identities: [] };
  }
  return world.zeroTrust;
}

export function installMesh(world: World): { ok: boolean; message: string } {
  const zt = ensureZeroTrust(world);
  if (zt.meshInstalled) return { ok: false, message: 'service mesh already installed' };
  zt.meshInstalled = true;
  zt.meshInstalledAtMin = world.nowMin;
  // the mesh issues a cryptographic identity to every serving component
  zt.identities = ['api', 'db', 'lb', 'nginx'];
  if (world.k8s?.provisioned) zt.identities.push('k8s-01');
  audit(world, world.session.user, 'security', `Service mesh installed: every component now has a cryptographic identity (${zt.identities.join(', ')}) and speaks mTLS`);
  return { ok: true, message: 'service mesh installed — identities issued, mTLS permissive until enforced' };
}

export function setMtlsStrict(world: World, strict: boolean): { ok: boolean; message: string } {
  const zt = ensureZeroTrust(world);
  if (!zt.meshInstalled) return { ok: false, message: 'install the service mesh first' };
  zt.mtlsStrict = strict;
  audit(world, world.session.user, 'security', strict
    ? 'mTLS mode STRICT: plaintext service-to-service traffic is now refused cluster-wide'
    : 'mTLS mode PERMISSIVE: plaintext tolerated again (interop window)');
  return { ok: true, message: strict ? 'mTLS STRICT enforced' : 'mTLS permissive' };
}

// ----- compliance (P5a, m36) -----

export function ensureCompliance(world: World): ComplianceState {
  if (!world.compliance) {
    world.compliance = { auditImmutable: false, bundles: [] };
  }
  return world.compliance;
}

/** The auditor's findings — derived live from world state, so remediation is real. */
export function complianceFindings(world: World): ComplianceFinding[] {
  const out: ComplianceFinding[] = [];
  const web = world.hosts['web-01'];
  const contractor = web.users['contractor'];
  if (contractor?.sudo) {
    out.push({ id: 'contractor-access', label: 'Contractor account retains sudo', severity: 'high', detail: 'user "contractor" still has sudo on web-01 — access review must revoke it' });
  }
  if (!world.compliance?.auditImmutable) {
    out.push({ id: 'audit-mutable', label: 'Audit log is local and mutable', severity: 'high', detail: 'the audit trail lives in the game state — ship it to an append-only store' });
  }
  const active = world.ci.deployments.find((d) => d.active);
  const img = active ? (world.registry.find((i) => i.repoTags.includes(active.image)) ?? world.docker.images.find((i) => i.repoTags.includes(active.image))) : undefined;
  if (active && (!img?.signed || !img?.sbom)) {
    out.push({ id: 'image-provenance', label: 'Running image lacks signature/SBOM', severity: 'medium', detail: `the production image ${active.image} has ${img?.signed ? 'no SBOM' : 'no signature'} — cosign sign + attest it` });
  }
  if (!world.vault?.credsLive) {
    out.push({ id: 'secrets-plaintext', label: 'Database credentials not vault-managed', severity: 'medium', detail: 'the app still authenticates with credentials from a file — lease dynamic creds from the vault' });
  }
  if (!(world.compliance?.bundles.length)) {
    out.push({ id: 'no-evidence', label: 'No evidence bundle collected', severity: 'low', detail: 'due diligence wants artifacts, not assertions — collect an evidence bundle' });
  }
  const unfiled = world.monitoring.incidents.filter((i) => i.status === 'resolved' && !i.postmortemFiled);
  if (unfiled.length) {
    out.push({ id: 'postmortems-missing', label: `${unfiled.length} resolved incident(s) without postmortems`, severity: 'low', detail: 'every resolved incident needs a filed postmortem (INCIDENTS tab)' });
  }
  return out;
}

/** Snapshot the security/reliability posture as a due-diligence artifact. */
export function collectEvidence(world: World): EvidenceBundle {
  const c = ensureCompliance(world);
  const s = ensureSlos(world);
  const vaultRotations = world.vault?.secrets['database/api']?.rotations ?? 0;
  const active = world.ci.deployments.find((d) => d.active);
  const bundle: EvidenceBundle = {
    atMin: world.nowMin,
    checks: [
      { id: 'backups', label: 'automated backups enabled', ok: world.db.provisioned && world.db.backups.enabled },
      { id: 'restore-drill', label: 'restore drill completed (RPO ≤ 24h)', ok: Boolean(world.flags.drRestoreDone) },
      { id: 'slos', label: 'SLOs written and configured', ok: s.configured },
      { id: 'vault', label: 'secrets vault-managed with rotation', ok: vaultRotations >= 1 },
      { id: 'image-signing', label: 'production image signed + SBOM', ok: Boolean(active && imageSigned(world, active.image)) },
      { id: 'netpol', label: 'default-deny network policy', ok: Object.values(world.k8s?.networkPolicies ?? {}).some((p) => p.defaultDeny) },
      { id: 'mtls', label: 'mTLS strict', ok: Boolean(world.zeroTrust?.mtlsStrict) },
      { id: 'postmortems', label: 'all incidents have postmortems', ok: world.monitoring.incidents.every((i) => i.postmortemFiled) },
      { id: 'budget', label: 'infra budget set', ok: Boolean(world.finops?.budgetMonthly) }
    ]
  };
  c.bundles.push(bundle);
  if (c.bundles.length > 10) c.bundles.splice(0, c.bundles.length - 10);
  audit(world, world.session.user, 'compliance', `Evidence bundle collected: ${bundle.checks.filter((x) => x.ok).length}/${bundle.checks.length} controls verified`);
  return bundle;
}

export function enableAuditStore(world: World): { ok: boolean; message: string } {
  const c = ensureCompliance(world);
  if (c.auditImmutable) return { ok: false, message: 'audit log already ships to the append-only store' };
  c.auditImmutable = true;
  audit(world, world.session.user, 'compliance', 'Audit log now ships to an append-only store (WORM) — the trail can be evidenced, not edited');
  return { ok: true, message: 'audit log append-only' };
}

export function revokeSudo(world: World, user: string): { ok: boolean; message: string } {
  const u = world.hosts['web-01'].users[user];
  if (!u) return { ok: false, message: `no user "${user}" on web-01` };
  if (!u.sudo) return { ok: false, message: `${user} has no sudo` };
  u.sudo = false;
  u.groups = u.groups.filter((g) => g !== 'sudo');
  audit(world, world.session.user, 'compliance', `Access review: sudo revoked for ${user} (least privilege)`);
  return { ok: true, message: `sudo revoked for ${user}` };
}

// ----- developer portal (P5b, m37) -----

export function ensurePortal(world: World): PortalState {
  if (!world.portal) {
    world.portal = {
      enabled: false,
      enabledAtMin: 0,
      templates: [
        { id: 'web-service', name: 'Web service (golden path)', description: 'build → test → scan → sign → deploy behind the LB. One click, all guardrails inherited.', published: false },
        { id: 'background-worker', name: 'Background worker', description: 'queue consumer with autoscaling, dashboards and alerts wired automatically.', published: false },
        { id: 'cron-job', name: 'Scheduled job', description: 'cron-shaped workload with retries, timeout and a dead-letter topic.', published: false }
      ],
      ticketQueue: 14,
      devDeploys: 0,
      deployLog: []
    };
  }
  return world.portal;
}

export function enablePortal(world: World): { ok: boolean; message: string } {
  const p = ensurePortal(world);
  if (p.enabled) return { ok: false, message: 'portal already launched' };
  p.enabled = true;
  p.enabledAtMin = world.nowMin;
  audit(world, world.session.user, 'platform', 'Internal developer portal launched — golden paths are one publish away');
  return { ok: true, message: 'portal live — publish a golden path for the devs' };
}

export function publishTemplate(world: World, id: string): { ok: boolean; message: string } {
  const p = ensurePortal(world);
  const t = p.templates.find((x) => x.id === id);
  if (!t) return { ok: false, message: `no template "${id}"` };
  if (t.published) return { ok: false, message: `${t.name} is already published` };
  t.published = true;
  audit(world, world.session.user, 'platform', `Golden path published: ${t.name} — self-service for every developer, guardrails included`);
  return { ok: true, message: `${t.name} published` };
}

const PORTAL_DEVS = ['priya', 'jaime', 'sam', 'wei', 'noor', 'diego'];

/** Golden-path self-service: once templates are live, devs ship without tickets. */
function tickPortal(world: World): void {
  const p = world.portal;
  if (!p?.enabled || !p.templates.some((t) => t.published)) return;
  if (world.nowMin % 20 !== 0) return;
  const dev = PORTAL_DEVS[Math.floor(world.nowMin / 20) % PORTAL_DEVS.length];
  const svc = ['checkout-api', 'pdf-exporter', 'insights-etl', 'webhooks-relay', 'billing-sync'][Math.floor(world.nowMin / 40) % 5];
  p.devDeploys += 1;
  p.ticketQueue = Math.max(0, p.ticketQueue - 1);
  p.deployLog.push({ atMin: world.nowMin, dev, service: `${svc} v${2 + (p.devDeploys % 9)}` });
  if (p.deployLog.length > 12) p.deployLog.splice(0, p.deployLog.length - 10);
  if (p.devDeploys % 3 === 1) {
    audit(world, dev, 'platform', `${dev} shipped ${svc} via the golden path — no ticket, no platform bottleneck`);
  }
  if (p.ticketQueue === 0 && !world.flags.portalQueueDrained) {
    world.flags.portalQueueDrained = true;
    audit(world, 'system', 'platform', 'The deploy-ticket queue is EMPTY. The platform team ships the platform; developers ship the product.');
  }
}

// ----- ephemeral preview environments (P5b, m38) -----

function tickPreviews(world: World): void {
  const previews = world.ci.previews;
  if (!previews?.length) return;
  const alive: typeof previews = [];
  for (const p of previews) {
    if (world.nowMin >= p.expiresAtMin) {
      world.flags.previewsDestroyed = num(world.flags.previewsDestroyed) + 1;
      audit(world, 'ci', 'deploy', `Preview ${p.id} auto-destroyed (expired) — ephemeral means ephemeral`);
    } else {
      alive.push(p);
    }
  }
  world.ci.previews = alive;
}

// ----- distributed tracing (P5b, m39) -----

export function enableTracing(world: World): { ok: boolean; message: string } {
  if (world.flags.tracingEnabled) return { ok: false, message: 'tracing already enabled' };
  world.flags.tracingEnabled = true;
  audit(world, world.session.user, 'observability', 'Distributed tracing enabled — spans sampled every 5 sim minutes across lb → api → db');
  return { ok: true, message: 'tracing live (MONITORING → TRACING)' };
}

/** Attribute recent latency to a service: the slowest span across recent traces. */
export function analyzeTraces(world: World): { ok: boolean; message: string; attribution: { service: string; sharePct: number; avgMs: number }[] } {
  const traces = (world.traces ?? []).slice(-10);
  if (traces.length < 5) return { ok: false, message: 'not enough traces yet — let it sample (5+ traces needed)', attribution: [] };
  const totals: Record<string, { sum: number; n: number }> = {};
  for (const t of traces) {
    for (const s of t.spans) {
      totals[s.service] = totals[s.service] ?? { sum: 0, n: 0 };
      totals[s.service].sum += s.durationMs;
      totals[s.service].n += 1;
    }
  }
  const grand = Object.values(totals).reduce((a, x) => a + x.sum, 0) || 1;
  const attribution = Object.entries(totals)
    .map(([service, x]) => ({ service, sharePct: Math.round((x.sum / grand) * 100), avgMs: Math.round(x.sum / x.n) }))
    .sort((a, b) => b.sharePct - a.sharePct);
  const top = attribution[0];
  if (top && top.service === 'db' && top.sharePct >= 40) {
    world.flags.traceBottleneckFound = true;
    audit(world, world.session.user, 'observability', `Trace analysis: ${top.sharePct}% of request latency is the DATABASE (avg ${top.avgMs}ms/span) — connection churn under load, not the app`);
  } else if (top) {
    audit(world, world.session.user, 'observability', `Trace analysis: top contributor is ${top.service} at ${top.sharePct}% (avg ${top.avgMs}ms/span)`);
  }
  return { ok: true, message: `analyzed ${traces.length} traces`, attribution };
}

function tickTraces(world: World): void {
  if (!world.flags.tracingEnabled || !world.monitoring.agentInstalled) return;
  if (world.app.mode === 'stopped') return;
  if (world.nowMin % 5 !== 0) return;
  // db span: connection churn dominates when the DB runs hot; a pooler halves it
  const dbMs = Math.round(18 + world.db.cpuPct * 9 * (world.db.pooler ? 0.5 : 1) + (world.flags.trafficSpike ? 30 : 0));
  const apiMs = Math.round(9 + (world.monitoring.series.cpu_pct?.at(-1)?.v ?? 20) * 0.4);
  const lbMs = 1 + (world.nowMin % 3);
  const total = lbMs + apiMs + dbMs;
  const trace: Trace = {
    id: hashStr('trace' + world.nowMin).slice(0, 10),
    atMin: world.nowMin,
    path: '/api/orders',
    durationMs: total,
    spans: [
      { service: 'lb', operation: 'lb-01 forward', durationMs: lbMs },
      { service: 'api', operation: 'GET /api/orders', durationMs: apiMs },
      { service: 'db', operation: 'SELECT orders', durationMs: dbMs }
    ]
  };
  if (!world.traces) world.traces = [];
  world.traces.push(trace);
  if (world.traces.length > 50) world.traces.splice(0, world.traces.length - 40);
  pushPoint(world, 'db_p95_ms', dbMs);
}

// ----- connection pooler (P5b, m39) -----

export function enablePooler(world: World): { ok: boolean; message: string } {
  if (!world.db.provisioned) return { ok: false, message: 'no managed database provisioned' };
  if (world.db.pooler) return { ok: false, message: 'pgbouncer already enabled' };
  world.db.pooler = true;
  audit(world, world.session.user, 'db', 'Connection pooler (pgbouncer) enabled in front of Postgres — connection churn no longer burns latency');
  return { ok: true, message: 'pgbouncer live — DB spans should shrink in the next traces' };
}

// ----- acquisition endgame (P5b, m40) -----

/** Due diligence across the five pillars — every check is real world state. */
export function dueDiligence(world: World): DueDiligencePillar[] {
  const s = ensureSlos(world);
  const report = sloReport(world);
  const team = ensureTeam(world);
  const products = ensureProducts(world);
  const launched = products.products.filter((p) => p.launchedAtMin !== undefined);
  const productShare = baseMrrOf(world) > 0 ? productMrrOf(world) / baseMrrOf(world) : 0;
  const pillars: DueDiligencePillar[] = [
    {
      id: 'security',
      label: 'Security & compliance posture',
      pass: complianceFindings(world).length === 0,
      detail: 'zero open audit findings (access reviewed, audit trail append-only, signed images, vault-managed secrets)'
    },
    {
      id: 'reliability',
      label: 'Reliability promises kept',
      pass: Boolean(s.configured) && report.availabilityMet && report.budgetRemainingPct > 0,
      detail: `SLOs ${s.configured ? 'written' : 'missing'}, availability ${report.availability.toFixed(2)}% (target ${s.availabilityTarget}%), error budget ${report.budgetRemainingPct.toFixed(0)}% remaining`
    },
    {
      id: 'finops',
      label: 'Unit economics under control',
      pass: Boolean(world.finops?.budgetMonthly) && (world.finops?.daysUnderBudget ?? 0) >= 2,
      detail: `budget ${world.finops?.budgetMonthly ? `$${world.finops.budgetMonthly}/mo` : 'not set'}, ${world.finops?.daysUnderBudget ?? 0} sim days held under it`
    },
    {
      id: 'team',
      label: 'The company runs without heroes',
      pass: team.engineers.length >= 2 && Boolean(team.onCallId),
      detail: `${team.engineers.length} engineer(s), on-call ${team.onCallId ? 'covered' : 'vacant'}`
    },
    {
      id: 'products',
      label: 'A portfolio, not a product',
      pass: launched.length >= 2 && productShare >= 0.1,
      detail: `${launched.length} product(s) launched, product MRR ${(productShare * 100).toFixed(0)}% of subscriptions`
    }
  ];
  if (!world.endgame) world.endgame = { termSheetAccepted: false, pillars };
  world.endgame.pillars = pillars;
  return pillars;
}

/** Accept the term sheet: the company sells, a scale event is armed. */
export function acceptTermSheet(world: World): { ok: boolean; message: string } {
  const pillars = dueDiligence(world);
  if (pillars.some((p) => !p.pass)) {
    return { ok: false, message: `due diligence not clean: ${pillars.filter((p) => !p.pass).map((p) => p.id).join(', ')} still red` };
  }
  if (!world.endgame) world.endgame = { termSheetAccepted: false, pillars };
  if (world.endgame.termSheetAccepted) return { ok: false, message: 'term sheet already accepted' };
  const payout = 1_500_000 + pillars.filter((p) => p.pass).length * 100_000 + Math.floor(world.company.satisfaction * 50_000);
  world.endgame.termSheetAccepted = true;
  world.endgame.acceptedAtMin = world.nowMin;
  world.endgame.payout = payout;
  world.company.cash += payout;
  // the announcement is the scale event: everyone tries the product at once
  world.company.users = Math.round(world.company.users * 2.2);
  world.scheduledEvents.push({ atMin: world.nowMin + 45, kind: 'exit_scale_check' });
  audit(world, 'board', 'game', `TERM SHEET ACCEPTED: the company sells for $${payout.toLocaleString()}. The acquirers announce it in ~45 sim minutes — the traffic that follows is the final exam.`);
  return { ok: true, message: `deal closed: +$${payout.toLocaleString()} — survive the announcement traffic` };
}
