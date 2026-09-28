// THE test: plays the entire vertical slice as a player would, mission by
// mission, driving the same engine functions the REST API uses.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { createWorld, tick, addDnsRecord, provisionDb, runMigrations, installMonitoringAgent, addAlertRule, filePostmortem, diskUsagePct, provisionVm, deployToVm, provisionLb, provisionK8sCluster, enableBackups, restoreBackup, hireEngineer, setOnCall, startRefactorProject, configureSlos, sloReport, runCloudComparison, claimSlcCredit, startMigration, decommissionVm, ensureProducts, startProduct, productMrrOf, baseMrrOf, reserveCompute, setFinopsBudget, finopsRecommendations, monthlyInfraCost, latest } from '../server/src/world';
import { resizeNodePool } from '../server/src/sim/k8s';
import { runTerminalInput } from '../server/src/sim/host';
import { runPipeline, rollback, approveRun } from '../server/src/sim/ci';
import { evaluateMissions, currentMission } from '../server/src/engine';
import { MISSIONS } from '../server/src/missions/missions';
import * as fs from '../server/src/sim/fs';
import { httpRequest, hostServesApi, lbBackends } from '../server/src/sim/net';
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

describe('vertical slice: full mission chain m01 → m28', () => {
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
    expect(currentMission(state)?.id).toBe('m17-e2e');
  });

  it('m17 — staging + e2e catch the canary; approval gates production', () => {
    // upgrade the pipeline: staging deploy → e2e → approval gate → prod deploy
    write('/opt/app/.ci/pipeline.yml', `name: deploy
on: push
steps:
  - name: checkout
    uses: git/checkout
  - name: test
    run: npm test
  - name: docker_build
    run: docker build -t registry.acme.dev/acme/api:v3 .
  - name: push
    run: docker push registry.acme.dev/acme/api:v3
  - name: deploy_staging
    uses: sim/deploy-staging
  - name: e2e
    run: npm run e2e
  - name: approval
    uses: sim/approval
  - name: deploy
    uses: sim/deploy
`);
    sh('git add .ci/pipeline.yml');
    sh('git commit -m "staging + e2e + approval gate"');
    // QA's canary ships: e2e must catch it in staging, prod untouched
    const caught = runPipeline(W(), '.ci/pipeline.yml');
    expect(caught.status).toBe('failed');
    expect(caught.stages.find((s) => s.name === 'e2e')!.status).toBe('failed');
    expect(caught.stages.find((s) => s.name === 'deploy')!.status).toBe('skipped');
    expect(W().flags.stagingCaughtBug).toBe(true);
    expect(W().ci.staging!.image).toContain('api:v3');
    expect(W().flags.badDeployBug).toBeFalsy(); // production never saw the regression
    // teammate ships the fix: same pipeline, e2e passes, run pauses for approval
    const fixed = runPipeline(W(), '.ci/pipeline.yml');
    expect(fixed.status).toBe('waiting_approval');
    expect(W().ci.staging!.e2ePassed).toBe(true);
    const approved = approveRun(W(), fixed.id, true);
    expect(approved.ok).toBe(true);
    expect(W().ci.runs[W().ci.runs.length - 1].status).toBe('success');
    expect(W().flags.ciApprovalUsed).toBe(true);
    const active = W().ci.deployments.find((d) => d.active)!;
    expect(active.id).not.toBe(W().flags.stagingCaughtDeployId);
    expect(active.createdAtMin).toBeGreaterThanOrEqual(Number(W().flags.stagingCaughtAtMin));
    evalM();
    expectDone('m17-e2e');
    expect(currentMission(state)?.id).toBe('m18-terraform');
  });

  it('m18 — terraform: describe, import, clean plan, catch drift, reconcile', () => {
    expect(sh('sudo apt-get install -y terraform')).toContain('Setting up terraform');
    sh('mkdir -p /opt/infra');
    write('/opt/infra/main.tf', `provider "stratus" {
  region = "us-east-1"
}

resource "stratus_vm" "web-01" {
  size = "m3.medium"
}

resource "stratus_vm" "vm-02" {
  size = "m3.medium"
}

resource "stratus_lb" "lb01" {
}

resource "stratus_db" "main" {
  plan = "db.small"
}
`);
    sh('cd /opt/infra');
    expect(sh('terraform init')).toContain('successfully initialized');
    expect(sh('terraform plan')).toContain('to import');
    sh('terraform import stratus_vm.web-01 i-web01');
    sh('terraform import stratus_vm.vm-02 i-vm02');
    sh('terraform import stratus_lb.lb01 lb-main');
    sh('terraform import stratus_db.main db-main');
    expect(sh('terraform plan')).toContain('No changes');
    // the console drift lands ~45 sim minutes after the mission started
    for (let i = 0; i < 50 && W().db.plan === 'db.small'; i++) tick(W(), 5);
    expect(W().db.plan).toBe('db.micro');
    expect(sh('terraform plan')).toContain('drift detected');
    expect(sh('terraform apply -auto-approve')).toContain('Apply complete');
    expect(W().db.plan).toBe('db.small'); // forced back to the code
    expect(sh('terraform plan')).toContain('No changes');
    evalM();
    expectDone('m18-terraform');
    expect(currentMission(state)?.id).toBe('m19-k8s');
  });

  it('m19 — kubernetes: manifests, probes, LB service, rollout, HPA', () => {
    expect(provisionK8sCluster(W()).ok).toBe(true);
    write('/opt/app/k8s/deployment.yaml', `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.acme.dev/acme/api:v1
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
`);
    write('/opt/app/k8s/service.yaml', `apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8080
`);
    write('/opt/app/k8s/ingress.yaml', `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
spec:
  rules:
    - host: api.acme-metrics.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port: 80
`);
    sh('cd /opt/app');
    const applied = sh('kubectl apply -f k8s/');
    expect(applied).toContain('deployment.apps/api created');
    expect(applied).toContain('service/api created');
    expect(applied).toContain('ingress.networking.k8s.io/api created');
    // pods warm up: Pending → Running → Ready
    for (let i = 0; i < 8 && !sh('kubectl get pods').includes('Ready'); i++) tick(W(), 1);
    expect(sh('kubectl get pods')).toContain('Ready');
    expect(W().k8s!.deployments['api'].readyReplicas).toBe(2);
    // the LoadBalancer service registered the cluster behind lb-01
    expect(lbBackends(W()).some((b) => b.id === 'k8s-01' && b.healthy)).toBe(true);
    const zone = `${W().company.slug}.dev`;
    const viaCluster = httpRequest(W(), `http://api.${zone}/health`);
    expect(viaCluster.ok && viaCluster.status).toBe(200);
    // HPA before the load arrives
    expect(sh('kubectl autoscale deployment/api --min=2 --max=6 --cpu-percent=70')).toContain('autoscaled');
    // rolling update to v2 — zero downtime via RollingUpdate
    sh('kubectl set image deployment/api api=registry.acme.dev/acme/api:v2');
    const apiDep = () => W().k8s!.deployments['api'];
    for (let i = 0; i < 30 && !(W().k8s!.zeroDowntimeProven && apiDep().readyReplicas >= apiDep().replicas); i++) tick(W(), 1);
    expect(W().k8s!.zeroDowntimeProven).toBe(true);
    expect(sh('kubectl rollout status deployment/api')).toContain('successfully rolled out');
    expect(W().k8s!.deployments['api'].revision).toBeGreaterThanOrEqual(2);
    expect(W().k8s!.deployments['api'].image).toContain('v2');
    // HPA scales out under the armed traffic spike
    for (let i = 0; i < 40 && !Object.values(W().k8s!.hpas).some((h) => h.peakedAtMin !== undefined); i++) tick(W(), 5);
    expect(Object.values(W().k8s!.hpas).some((h) => h.peakedAtMin !== undefined)).toBe(true);
    expect(W().k8s!.deployments['api'].replicas).toBeGreaterThan(2);
    evalM();
    expectDone('m19-k8s');
    expect(currentMission(state)?.id).toBe('m20-dr');
  });

  it('m20 — backups BEFORE disaster, restore drill, RPO/RTO, postmortem', () => {
    expect(enableBackups(W()).ok).toBe(true);
    expect(W().db.backups.snapshots.length).toBeGreaterThan(0);
    // the bad migration lands ~90 sim minutes after the mission started
    let inc = W().monitoring.incidents.find((i) => i.kind === 'data_loss');
    for (let i = 0; i < 30 && !inc; i++) { tick(W(), 5); inc = W().monitoring.incidents.find((x) => x.kind === 'data_loss'); }
    expect(inc).toBeTruthy();
    expect(inc!.status).toBe('open');
    expect(W().db.tables['orders'].rowCount).toBe(0); // data GONE
    // restore from the pre-incident snapshot
    const restore = restoreBackup(W());
    expect(restore.ok).toBe(true);
    expect(W().db.tables['orders'].rowCount).toBeGreaterThanOrEqual(900000);
    expect(Number(W().flags.drRpoMin)).toBeLessThanOrEqual(1440);
    tick(W(), 1); // resolution check
    expect(inc!.status).toBe('resolved');
    expect(filePostmortem(W(), inc!.id, ['restore', 'backups', 'pitr', 'review']).ok).toBe(true);
    evalM();
    expectDone('m20-dr');
    expect(W().flags.buildPhaseComplete).toBe(true);
  });

  it('m21 — hire a team, put someone on call, survive the page', () => {
    evalM(); // operate phase auto-starts after the build chain
    expect(currentMission(state)?.id).toBe('m21-team');
    expect(hireEngineer(W(), 'senior').ok).toBe(true);
    expect(hireEngineer(W(), 'sre').ok).toBe(true);
    const sre = W().team!.engineers.find((e) => e.role === 'sre')!;
    expect(setOnCall(W(), sre.id).ok).toBe(true);
    // the ambient incident lands ~90 sim minutes after the mission started
    let inc = W().monitoring.incidents.find((i) => i.kind === 'traffic_spike');
    for (let i = 0; i < 30 && !inc; i++) { tick(W(), 5); inc = W().monitoring.incidents.find((x) => x.kind === 'traffic_spike'); }
    expect(inc).toBeTruthy();
    expect(W().flags.onCallPaged).toBe(true);
    expect(inc!.timeline.some((ev) => ev.text.includes('paged'))).toBe(true);
    // the surge subsides and the incident resolves
    for (let i = 0; i < 40 && inc!.status !== 'resolved'; i++) tick(W(), 5);
    expect(inc!.status).toBe('resolved');
    evalM();
    expectDone('m21-team');
    expect(currentMission(state)?.id).toBe('m22-debt');
  });

  it('m22 — the debt ledger: refactors pay it down below 10', () => {
    expect(W().debt).toBeTruthy(); // seeded from history during m21's ticking
    expect(W().debt!.points).toBeGreaterThan(0);
    expect(startRefactorProject(W(), 'rm-legacy').ok).toBe(true);
    expect(startRefactorProject(W(), 'runbooks').ok).toBe(true);
    for (let i = 0; i < 80 && W().debt!.projects.filter((p) => p.done).length < 2; i++) tick(W(), 10);
    expect(W().debt!.projects.filter((p) => p.done).length).toBe(2);
    expect(fs.getFile(W().hosts['web-01'].fs, '/opt/app/legacy-server.js')).toBeNull();
    expect(W().debt!.points).toBeLessThan(10);
    evalM();
    expectDone('m22-debt');
    expect(currentMission(state)?.id).toBe('m23-canary');
  });

  it('m23 — canary: auto-abort the leak, then promote the fix', () => {
    // switch the deploy step to canary strategy (the approval gate stays)
    write('/opt/app/.ci/pipeline.yml', read('/opt/app/.ci/pipeline.yml')!.replace(
      '  - name: deploy\n    uses: sim/deploy',
      '  - name: deploy\n    uses: sim/deploy\n    with:\n      strategy: canary'
    ));
    sh('git add .ci/pipeline.yml');
    sh('git commit -m "canary strategy"');
    const leaky = runPipeline(W(), '.ci/pipeline.yml');
    expect(leaky.status).toBe('waiting_approval'); // the m17 gate still applies
    expect(approveRun(W(), leaky.id, true).ok).toBe(true);
    expect(W().ci.canary!.active).toBe(true);
    expect(W().ci.canary!.trafficPct).toBe(10);
    // the runtime leak surfaces and the canary aborts itself (~8 sim min)
    for (let i = 0; i < 12 && W().ci.canary!.active; i++) tick(W(), 1);
    expect(W().ci.canary!.status).toBe('aborted');
    expect(W().flags.canaryAutoAbort).toBe(true);
    expect(W().flags.badDeployBug).toBeFalsy(); // prod never saw it
    // QA ships the fix; the clean canary promotes after the observation window
    const clean = runPipeline(W(), '.ci/pipeline.yml');
    expect(clean.status).toBe('waiting_approval');
    expect(approveRun(W(), clean.id, true).ok).toBe(true);
    for (let i = 0; i < 35 && W().ci.canary!.active; i++) tick(W(), 1);
    expect(W().ci.canary!.status).toBe('promoted');
    expect(W().flags.canaryPromoted).toBe(true);
    evalM();
    expectDone('m23-canary');
    expect(currentMission(state)?.id).toBe('m24-slo');
  });

  it('m24 — commit SLOs and hold them for a sim day', () => {
    expect(configureSlos(W(), 99.5, 1000).ok).toBe(true);
    const before = W().nowMin;
    for (let i = 0; i < 150 && (W().nowMin - before) < 1450; i++) tick(W(), 10);
    const report = sloReport(W());
    expect(report.availabilityMet).toBe(true);
    expect(report.p95Met).toBe(true);
    expect(report.budgetRemainingPct).toBeGreaterThan(0);
    evalM();
    expectDone('m24-slo');
    expect(W().flags.operatePhaseComplete).toBe(true);
    expect(currentMission(state)?.id).toBe('m25-clouds'); // P3 auto-starts
  });

  it('m25 — between two clouds: compare, survive the outage, claim the credit', () => {
    expect(W().cloud).toBeTruthy(); // seeded by the mission's onStart
    expect(runCloudComparison(W()).ok).toBe(true);
    expect(W().cloud!.compared).toBe(true);
    expect(W().cloud!.lastComparison!.length).toBeGreaterThanOrEqual(7); // every provider × region
    // the armed provider outage lands ~240 sim minutes after m25 started
    let out = W().cloud!.outage;
    for (let i = 0; i < 80 && !out; i++) { tick(W(), 10); out = W().cloud!.outage; }
    expect(out).toBeTruthy();
    tick(W(), 1); // the outage opens after that minute's metrics — sample the next one
    const inc = W().monitoring.incidents.find((i) => i.kind === 'provider_outage')!;
    expect(inc.status).toBe('open');
    expect(latest(W(), 'error_pct')).toBe(80); // the whole footprint is down
    // provider outages end on their own — nothing to fix
    for (let i = 0; i < 40 && W().cloud!.outage?.endedAtMin === undefined; i++) tick(W(), 5);
    expect(W().cloud!.outage?.endedAtMin).toBeDefined();
    expect(inc.status).toBe('resolved');
    const cashBefore = W().company.cash;
    expect(claimSlcCredit(W()).ok).toBe(true);
    expect(W().company.cash).toBeGreaterThan(cashBefore);
    expect(W().cloud!.creditsTotal).toBeGreaterThan(0);
    expect(W().cloud!.outage).toBeUndefined(); // claimed and cleared
    expect(filePostmortem(W(), inc.id, ['credit', 'statuspage', 'migrate']).ok).toBe(true);
    evalM();
    expectDone('m25-clouds');
    expect(currentMission(state)?.id).toBe('m26-migrate');
  });

  it('m26 — moving day: rehearsed cutover to Volt, bill actually drops', () => {
    const before = monthlyInfraCost(W());
    // backups + staging + LB (+ k8s) from earlier missions keep the cutover short
    expect(startMigration(W(), 'volt', 'us-central-1').ok).toBe(true);
    expect(W().cloud!.migration!.downtimeMin).toBeLessThanOrEqual(15);
    // prep (6h) + cutover run themselves in the tick
    for (let i = 0; i < 90 && W().cloud!.migration; i++) tick(W(), 10);
    expect(W().cloud!.migration).toBeUndefined();
    expect(W().cloud!.provider).toBe('volt');
    expect(W().cloud!.region).toBe('us-central-1');
    const rec = W().cloud!.migrations[0];
    expect(rec.downtimeMin).toBeLessThanOrEqual(15);
    expect(rec.costAfter).toBeLessThan(rec.costBefore);
    expect(monthlyInfraCost(W())).toBeLessThan(before);
    expect(W().db.endpoint).toContain('volt');
    evalM();
    expectDone('m26-migrate');
    expect(currentMission(state)?.id).toBe('m27-products');
  });

  it('m27 — the second product: Insights + the gated Enterprise Grid', () => {
    expect(startProduct(W(), 'insights').ok).toBe(true);
    // gates: SLOs written (m24), satisfaction ≥ 4, two engineers (m21)
    expect(startProduct(W(), 'ent-grid').ok).toBe(true);
    for (let i = 0; i < 60 && ensureProducts(W()).products.filter((p) => p.launchedAtMin !== undefined).length < 2; i++) tick(W(), 10);
    const launched = ensureProducts(W()).products.filter((p) => p.launchedAtMin !== undefined);
    expect(launched.length).toBe(2);
    expect(launched.some((p) => p.id === 'ent-grid')).toBe(true);
    expect(productMrrOf(W())).toBeGreaterThanOrEqual(0.1 * baseMrrOf(W()));
    evalM();
    expectDone('m27-products');
    expect(currentMission(state)?.id).toBe('m28-finops');
  });

  it('m28 — FinOps: recommendations resolved, 15% under baseline, budget held', () => {
    const baseline = W().finops!.baselineMonthly!; // captured when m28 started
    expect(baseline).toBeGreaterThan(0);
    // bring the api deployment back to 2 replicas so the node-pool rec applies
    // (deterministically: an ambient traffic spike would legitimately scale
    // the HPA back out and hide the rec — clear the surge first)
    const api = W().k8s!.deployments['api'];
    api.replicas = 2;
    for (const h of Object.values(W().k8s!.hpas)) h.currentReplicas = Math.min(h.currentReplicas, 2);
    W().flags.trafficSpike = false;
    W().scheduledEvents = W().scheduledEvents.filter((e) => e.kind !== 'traffic_spike');
    tick(W(), 2); // the recommendation scan runs
    const ids = finopsRecommendations(W()).map((r) => r.id);
    expect(ids).toContain('reserve-compute');
    expect(ids).toContain('k8s-pool');
    expect(ids).toContain('decomm-vm'); // kubernetes has served the API since m19
    expect(reserveCompute(W()).ok).toBe(true);
    expect(decommissionVm(W(), 'vm-02').ok).toBe(true);
    expect(resizeNodePool(W(), 2).ok).toBe(true);
    tick(W(), 2); // resolved recs are recorded by the seen-diff
    expect(W().finops!.resolved.length).toBeGreaterThanOrEqual(3);
    const now = monthlyInfraCost(W());
    expect(now).toBeLessThanOrEqual(0.85 * baseline);
    // budget at the optimized bill, then hold it for two sim days
    expect(setFinopsBudget(W(), Math.ceil(now)).ok).toBe(true);
    for (let i = 0; i < 3; i++) tick(W(), 1440);
    expect(W().finops!.daysUnderBudget).toBeGreaterThanOrEqual(2);
    evalM();
    expectDone('m28-finops');
    expect(W().flags.ecosystemPhaseComplete).toBe(true);
    expect(currentMission(state)?.id).toBe('m29-packs'); // P4 bonus chain continues
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
    expect(state.skills.cicd).toBeGreaterThan(140);
    expect(state.skills.cloud).toBeGreaterThan(100);
    expect(state.skills.finops).toBeGreaterThan(40);
  });
});
