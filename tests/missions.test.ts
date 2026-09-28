// THE test: plays the entire vertical slice as a player would, mission by
// mission, driving the same engine functions the REST API uses.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { createWorld, tick, addDnsRecord, provisionDb, runMigrations, installMonitoringAgent, addAlertRule, filePostmortem, diskUsagePct, provisionVm, deployToVm, provisionLb } from '../server/src/world';
import { runTerminalInput } from '../server/src/sim/host';
import { runPipeline, rollback } from '../server/src/sim/ci';
import { evaluateMissions, currentMission } from '../server/src/engine';
import { MISSIONS } from '../server/src/missions/missions';
import * as fs from '../server/src/sim/fs';
import { httpRequest, hostServesApi } from '../server/src/sim/net';
import { runSql } from '../server/src/sim/dbsim';

let state: GameState;
const sh = (cmd: string) => runTerminalInput(state.world, cmd).lines.map((l) => l.text).join('\n');
const W = () => state.world;
const write = (path: string, content: string) => fs.writeFile(W().hosts['web-01'].fs, path, content, 'dev');
const read = (path: string) => fs.readFile(W().hosts['web-01'].fs, path);
const evalM = () => evaluateMissions(state);

function expectDone(missionId: string) {
  expect(state.missions.completed).toContain(missionId);
}

function reqsFor(missionId: string) {
  const m = MISSIONS.find((x) => x.id === missionId)!;
  return m.requirements.map((r) => ({ id: r.id, label: r.label, pass: (() => { try { return r.check(W()); } catch { return false; } })() }));
}

describe('vertical slice: full mission chain m01 → m14', () => {
  it('m01 — read handoff and ssh in', () => {
    state = { id: 'test', createdAt: 0, updatedAt: 0, world: createWorld('Acme Metrics', 'you'), missions: { completed: [], current: 'm01-ssh', hintsUsed: {}, attempts: {}, ratings: {} }, skills: {}, xp: 0 };
    expect(sh('ls')).toContain('handoff.txt');
    expect(sh('cat handoff.txt')).toContain('203.0.113.10');
    expect(sh('ssh dev@203.0.113.10')).toContain('password');
    expect(sh('dev')).toContain('Welcome to');
    evalM();
    expectDone('m01-ssh');
  });

  it('m02 — diagnose EADDRINUSE, kill legacy, start+enable api', () => {
    expect(currentMission(state)?.id).toBe('m02-dead-api');
    expect(sh('journalctl -u api -n 8')).toContain('EADDRINUSE');
    expect(sh('ss -tulpn')).toContain(':8080');
    expect(sh('ps aux')).toContain('legacy-server');
    expect(sh('sudo kill 1024')).toBe('');
    expect(sh('sudo systemctl start api')).toBe('');
    expect(sh('sudo systemctl enable api')).toContain('Created symlink');
    const health = httpRequest(W(), 'http://localhost:8080/health');
    expect(health.status).toBe(200);
    evalM();
    expectDone('m02-dead-api');
  });

  it('m03 — run the api as dev, not root', () => {
    const unit = read('/etc/systemd/system/api.service')!;
    write('/etc/systemd/system/api.service', unit.replace('User=root', 'User=dev'));
    expect(sh('sudo chown -R dev:dev /opt/app')).toBe('');
    sh('sudo systemctl daemon-reload');
    sh('sudo systemctl restart api');
    expect(W().hosts['web-01'].services['api'].user).toBe('dev');
    evalM();
    expectDone('m03-permissions');
  });

  it('m04 — nginx front door', () => {
    expect(sh('sudo apt-get install -y nginx')).toContain('Setting up nginx');
    write('/etc/nginx/sites-enabled/acme.conf', `server {\n  listen 80;\n  server_name _;\n  location / {\n    proxy_pass http://127.0.0.1:8080;\n  }\n}\n`);
    sh('sudo systemctl enable nginx');
    sh('sudo systemctl start nginx');
    expect(sh('sudo ufw allow 80/tcp')).toContain('Rule added');
    const res = httpRequest(W(), 'http://localhost/');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).service ?? true).toBeTruthy();
    evalM();
    expectDone('m04-nginx');
  });

  it('m05 — DNS record for api.<zone>', () => {
    addDnsRecord(W(), 'api', 'A', '203.0.113.10');
    expect(sh('exit')).toContain('Connection to web-01 closed');
    const zone = `${W().company.slug}.dev`;
    expect(sh(`dig +short api.${zone}`)).toContain('203.0.113.10');
    const res = httpRequest(W(), `http://api.${zone}/health`);
    expect(res.status).toBe(200);
    evalM();
    expectDone('m05-dns');
  });

  it('m06 — git init, identity, gitignore, clean commit', () => {
    sh('ssh dev@203.0.113.10');
    sh('dev');
    sh('cd /opt/app');
    expect(sh('git init')).toContain('Initialized empty Git repository');
    sh('git config user.name "You"');
    sh('git config user.email "you@acme.dev"');
    write('/opt/app/.gitignore', 'node_modules/\n.env\n*.log\n');
    sh('git add -A');
    expect(sh('git commit -m "initial import of api source"')).toContain('initial import');
    expect(sh('git status')).toContain('working tree clean');
    evalM();
    expectDone('m06-git');
  });

  it('m07 — feature branch, teammate conflict, proper resolution', () => {
    expect(currentMission(state)?.id).toBe('m07-branch');
    expect(sh('git checkout -b feature/api-timeout')).toContain("Switched to branch 'feature/api-timeout'");
    const cfg = read('/opt/app/config.js')!;
    write('/opt/app/config.js', cfg.replace('apiTimeout: 30', 'apiTimeout: 60'));
    sh('git add config.js');
    sh('git commit -m "raise timeout for partner API"');
    // teammate pushed to origin/main meanwhile (onStart armed it)
    const pull = sh('git pull origin main');
    expect(pull).toContain('CONFLICT');
    expect(read('/opt/app/config.js')).toContain('<<<<<<<');
    // resolve: keep BOTH intents
    const merged = cfg.replace('apiTimeout: 30', 'apiTimeout: 60').replace('retryMax: 3', 'retryMax: 5');
    write('/opt/app/config.js', merged);
    sh('git add config.js');
    sh('git commit -m "merge: timeout 60 + retry 5"');
    sh('git checkout main');
    sh('git merge feature/api-timeout');
    const final = read('/opt/app/config.js')!;
    expect(final).not.toContain('<<<<<<<');
    expect(final).toContain('apiTimeout: 60');
    expect(final).toContain('retryMax: 5');
    evalM();
    expectDone('m07-branch');
  });

  it('m08 — secrets out of source, env file into the service', () => {
    write('/opt/app/.env', 'DB_PASSWORD=b1gmeter-prod-2024\n');
    const cfg = read('/opt/app/config.js')!;
    write('/opt/app/config.js', cfg.replace('dbPassword: "b1gmeter-prod-2024",', 'dbPassword: process.env.DB_PASSWORD,'));
    const unit = read('/etc/systemd/system/api.service')!;
    write('/etc/systemd/system/api.service', unit.replace('Restart=always', 'Restart=always\nEnvironmentFile=/opt/app/.env'));
    sh('sudo systemctl daemon-reload');
    sh('sudo systemctl restart api');
    expect(read('/opt/app/config.js')).toContain('process.env.DB_PASSWORD');
    evalM();
    expectDone('m08-secrets');
  });

  it('m09 — containerize with a production-grade Dockerfile', () => {
    expect(sh('sudo apt-get install -y docker.io')).toContain('Setting up docker.io');
    write('/opt/app/Dockerfile', `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
`);
    expect(sh('sudo systemctl stop api')).toBe('');
    const build = sh('docker build -t acme/api:v1 .');
    expect(build).toContain('naming to acme/api:v1');
    expect(sh('docker run -d --name api -p 8080:8080 acme/api:v1')).toContain('Running as non-root user');
    tick(W(), 3); // healthcheck warmup
    expect(sh('docker ps')).toContain('(healthy)');
    evalM();
    expectDone('m09-docker');
  });

  it('m10 — CI pipeline: test → build → docker → push → deploy', () => {
    write('/opt/app/.ci/pipeline.yml', `name: deploy
on: push
steps:
  - name: checkout
    uses: git/checkout
  - name: test
    run: npm test
  - name: build
    run: npm run build
  - name: docker_build
    run: docker build -t registry.acme.dev/acme/api:v1 .
  - name: push
    run: docker push registry.acme.dev/acme/api:v1
  - name: deploy
    uses: sim/deploy
`);
    sh('git add .ci/pipeline.yml');
    sh('git commit -m "add deploy pipeline"');
    const run = runPipeline(W(), '.ci/pipeline.yml');
    expect(run.status).toBe('success');
    expect(run.stages.map((s) => s.name)).toContain('deploy');
    expect(W().registry.some((i) => i.repoTags.includes('registry.acme.dev/acme/api:v1'))).toBe(true);
    expect(W().app.mode).toBe('container');
    expect(W().app.image).toBe('registry.acme.dev/acme/api:v1');
    evalM();
    expectDone('m10-ci');
  });

  it('m11 — managed Postgres + migrations + DATABASE_URL', () => {
    expect(provisionDb(W(), 'db.small').ok).toBe(true);
    expect(runMigrations(W()).ok).toBe(true);
    write('/opt/app/.env', 'DB_PASSWORD=b1gmeter-prod-2024\nDATABASE_URL=postgresql://api:SECRET@db-01.stratus.cloud:5432/bigmeter\n');
    // stop whatever container currently serves :8080 (CI-deployed one has a generated name)
    const running = W().docker.containers.find((c) => c.status === 'running');
    expect(running).toBeTruthy();
    sh(`docker stop ${running!.name}`);
    expect(sh('docker ps')).not.toContain('8080');
    const runOut = sh('docker run -d --name api -p 8080:8080 --env-file .env registry.acme.dev/acme/api:v1');
    expect(runOut).toContain('Container api started');
    const health = httpRequest(W(), 'http://localhost:8080/health');
    expect(JSON.parse(health.body!).database).toBe('postgres');
    expect(W().app.env.DATABASE_URL).toContain('db-01.stratus.cloud');
    evalM();
    expectDone('m11-db');
    expect(W().company.launched).toBe(true);
  });

  it('m12 — observability agent + alert rules', () => {
    installMonitoringAgent(W());
    addAlertRule(W(), 'error_pct', '>', 2);
    addAlertRule(W(), 'cpu_pct', '>', 85);
    expect(W().monitoring.agentInstalled).toBe(true);
    evalM();
    expectDone('m12-monitoring');
  });

  it('m13 — disk-full incident emerges; fix + logrotate + postmortem', () => {
    expect(diskUsagePct(W())).toBeLessThan(50);
    for (let i = 0; i < 40 && diskUsagePct(W()) < 99.5; i++) tick(W(), 30);
    expect(diskUsagePct(W())).toBeGreaterThanOrEqual(99.5);
    expect(W().monitoring.incidents.some((i) => i.kind === 'disk_full' && i.status === 'open')).toBe(true);
    // remediate: truncate the log now…
    sh('sudo sh -c "echo > /var/log/app.log"');
    // …and prevent recurrence
    write('/etc/logrotate.d/acme-api', `/var/log/app.log {\n  daily\n  rotate 7\n  compress\n  missingok\n  notifempty\n}\n`);
    tick(W(), 8);
    expect(W().flags.logrotateConfigured).toBe(true);
    expect(diskUsagePct(W())).toBeLessThan(85);
    const inc = W().monitoring.incidents.find((i) => i.kind === 'disk_full')!;
    expect(inc.status).toBe('resolved');
    expect(filePostmortem(W(), inc.id, ['rotate', 'diskalert', 'resize']).ok).toBe(true);
    evalM();
    expectDone('m13-disk');
  });

  it('m14 — bad deploy incident: detect, roll back, postmortem', () => {
    // ship the "next release" through the pipeline (armed with a regression)
    write('/opt/app/.ci/pipeline.yml', read('/opt/app/.ci/pipeline.yml')!.replaceAll('acme/api:v1', 'acme/api:v2'));
    sh('git add .ci/pipeline.yml');
    sh('git commit -m "release v2"');
    const run = runPipeline(W(), '.ci/pipeline.yml');
    expect(run.status).toBe('success');
    tick(W(), 5);
    const inc = W().monitoring.incidents.find((i) => i.kind === 'bad_deploy');
    expect(inc).toBeTruthy();
    expect(inc!.status).toBe('open');
    const latest = W().monitoring.series['error_pct'].at(-1)!.v;
    expect(latest).toBeGreaterThan(5);
    // roll back through the CI console
    const rb = rollback(W(), 'api');
    expect(rb.ok).toBe(true);
    tick(W(), 3);
    expect(W().monitoring.series['error_pct'].at(-1)!.v).toBeLessThan(2);
    expect(inc!.status).toBe('resolved');
    expect(filePostmortem(W(), inc!.id, ['rollback', 'erralert', 'staging']).ok).toBe(true);
    evalM();
    expectDone('m14-baddeploy');
    // the chain continues — HA and DB performance missions follow
    expect(currentMission(state)?.id).toBe('m15-dbperf');
  });

  it('m15 — traffic 6x: EXPLAIN, index, DB CPU recovers', () => {
    // mission start inflated the user base; ride to a traffic peak
    expect(W().company.users).toBeGreaterThan(6000);
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      tick(W(), 15);
      peak = Math.max(...W().monitoring.series.db_cpu_pct.map((p) => p.v));
      if (peak > 90) break;
    }
    expect(peak, `users=${Math.round(W().company.users)} plan=${W().db.plan} cpuNow=${W().db.cpuPct}`).toBeGreaterThan(90); // saturated on seq scans at peak
    // investigate…
    const before = runSql(W(), "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'");
    expect((before.rows.flat() as string[]).join('\n')).toContain('Seq Scan');
    // …fix the root cause…
    expect(runSql(W(), 'CREATE INDEX idx_orders_status ON orders (status)').error).toBeUndefined();
    // peak DB CPU must clear within the hour-long requirement window
    for (let i = 0; i < 40; i++) {
      tick(W(), 15);
      const recentPeak = Math.max(...W().monitoring.series.db_cpu_pct.slice(-60).map((p) => p.v));
      if (recentPeak < 70 && (W().monitoring.series.error_pct.at(-1)?.v ?? 99) < 2) break;
    }
    const recentPeak = Math.max(...W().monitoring.series.db_cpu_pct.slice(-60).map((p) => p.v));
    expect(recentPeak).toBeLessThan(70);
    const after = runSql(W(), "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'");
    expect((after.rows.flat() as string[]).join('\n')).toContain('Index Scan using idx_orders_status');
    evalM();
    expectDone('m15-dbperf');
    expect(currentMission(state)?.id).toBe('m16-ha');
  });

  it('m16 — HA: second VM, LB, DNS cutover, chaos drill passed', () => {
    // before HA, the drill must NOT be passable yet (armed ~90 min after start)
    tick(W(), 95);
    expect(W().flags.web01Down).toBe(true);
    const zone = `${W().company.slug}.dev`;
    expect(httpRequest(W(), `http://api.${zone}/health`).ok).toBe(false); // single box down = outage
    tick(W(), 30);
    expect(W().flags.haDrillSurvived).toBeFalsy();
    // build the HA architecture
    expect(provisionVm(W()).ok).toBe(true);
    expect(deployToVm(W(), 'vm-02').ok).toBe(true);
    tick(W(), 3); // container health warmup
    expect(provisionLb(W()).ok).toBe(true);
    addDnsRecord(W(), 'api', 'A', W().lb!.ip);
    expect(hostServesApi(W(), 'vm-02')).toBe(true);
    expect(hostServesApi(W(), 'web-01')).toBe(true);
    evalM();
    // drill requirement still open — wait for the retry (~180 min later)
    for (let i = 0; i < 40 && !W().flags.haDrillSurvived; i++) tick(W(), 15);
    expect(W().flags.haDrillSurvived).toBe(true);
    // during a drill the LB keeps serving
    W().flags.web01Down = true;
    const viaLb = httpRequest(W(), `http://api.${zone}/health`);
    expect(viaLb.ok).toBe(true);
    expect(viaLb.status).toBe(200);
    W().flags.web01Down = false;
    evalM();
    expectDone('m16-ha');
    expect(W().flags.buildPhaseComplete).toBe(true);
    expect(currentMission(state)).toBeNull();
  });

  it('company survived with users, revenue and skills earned', () => {
    expect(W().company.users).toBeGreaterThan(6000);
    expect(W().company.cash).toBeGreaterThan(10000);
    expect(state.skills.linux).toBeGreaterThan(50);
    expect(state.skills.git).toBeGreaterThan(80);
    expect(state.skills.docker).toBeGreaterThan(60);
    expect(state.skills.observability).toBeGreaterThan(100);
    expect(state.skills.databases).toBeGreaterThan(30);
    expect(state.skills.architecture).toBeGreaterThan(40);
  });
});
