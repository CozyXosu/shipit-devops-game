// Auto-solve walkthroughs: an executable solution for every mission, recorded
// step by step so the player can see exactly what was done. The sequences
// mirror the integration tests (tests/missions.test.ts, packs.test.ts,
// p5.test.ts) — the canonical way each mission is won — but every phase is
// guarded by its requirement so a partially-played mission only gets the
// missing pieces.
import { GameState, World, Incident } from '../types';
import { MissionDef } from './missions';
import { evalRequirements, evaluateMissions, currentMission } from '../engine';
import { currentPackMissionOf, activatePack, startFlagKey, getPack, packMissionsOf } from './packs';
import * as fs from '../sim/fs';
import { runTerminalInput } from '../sim/host';
import { runPipeline, rollback, approveRun, deployImage } from '../sim/ci';
import { runSql } from '../sim/dbsim';
import { resizeNodePool } from '../sim/k8s';
import {
  tick, addDnsRecord, provisionDb, runMigrations, installMonitoringAgent, addAlertRule,
  filePostmortem, diskUsagePct, provisionVm, deployToVm, provisionLb, provisionK8sCluster,
  enableBackups, restoreBackup, hireEngineer, setOnCall, startRefactorProject, configureSlos,
  runCloudComparison, claimSlcCredit, startMigration, decommissionVm, ensureProducts, startProduct,
  productMrrOf, baseMrrOf, reserveCompute, setFinopsBudget, monthlyInfraCost, ensureCloud,
  startChallenge, abandonChallenge, setPlayerSettings, installMesh, setMtlsStrict, revokeSudo,
  enableAuditStore, collectEvidence, complianceFindings, enablePortal, publishTemplate,
  enableTracing, analyzeTraces, enablePooler, dueDiligence, acceptTermSheet, sloReport
} from '../world';

export interface SolveStep {
  kind: 'cmd' | 'write' | 'action' | 'wait' | 'note';
  label: string;
  detail?: string;
  output?: string;
  minutes?: number;
}

export interface SolveResult {
  ok: boolean;
  missionId: string;
  missionTitle: string;
  completed: boolean;
  steps: SolveStep[];
  requirements: { id: string; label: string; pass: boolean }[];
  message?: string;
}

class Ctx {
  steps: SolveStep[] = [];
  constructor(public state: GameState, public m: MissionDef) {}
  get w(): World { return this.state.world; }
  req(id: string): boolean {
    const r = this.m.requirements.find((x) => x.id === id);
    if (!r) return false;
    try { return r.check(this.w); } catch { return false; }
  }
  /** True when the named requirement still needs work (skip guard). */
  need(id: string): boolean { return !this.req(id); }
  read(path: string): string { return fs.readFile(this.w.hosts['web-01'].fs, path) ?? ''; }
  write(label: string, path: string, content: string): void {
    fs.writeFile(this.w.hosts['web-01'].fs, path, content, 'dev');
    this.steps.push({ kind: 'write', label, detail: path, output: `${content.split('\n').length} lines` });
  }
  sh(label: string, cmd: string): string {
    const out = runTerminalInput(this.w, cmd);
    const text = out.lines.map((l) => l.text).filter(Boolean).join('\n');
    this.steps.push({ kind: 'cmd', label, detail: cmd, output: text.slice(0, 300) });
    return text;
  }
  act<T>(label: string, fn: () => T): T {
    try {
      const r = fn();
      this.steps.push({ kind: 'action', label, output: renderResult(r).slice(0, 300) });
      return r;
    } catch (e) {
      this.steps.push({ kind: 'action', label, output: `error: ${String(e)}` });
      return undefined as unknown as T;
    }
  }
  tick(minutes: number, label: string): void {
    tick(this.w, minutes);
    this.steps.push({ kind: 'wait', label, minutes });
  }
  /** Fast-forward sim time until `until` holds (or maxMin elapses). */
  wait(label: string, until: () => boolean, maxMin: number, stepMin = 5): boolean {
    const safe = () => { try { return until(); } catch { return false; } };
    const start = this.w.nowMin;
    let done = safe();
    const instant = done;
    while (!done && this.w.nowMin - start < maxMin) { tick(this.w, stepMin); done = safe(); }
    const minutes = this.w.nowMin - start;
    this.steps.push({ kind: 'wait', label: instant ? `${label} (already true)` : done ? label : `${label} — timed out`, minutes });
    return done;
  }
  note(label: string): void { this.steps.push({ kind: 'note', label }); }
  /** Evaluate the mission board mid-walkthrough (advances chained missions). */
  evalNow(): void {
    const r = evaluateMissions(this.state);
    if (r.completed.length) this.note(`✓ Completed: ${r.completed.map((m) => m.title).join(', ')}`);
  }
  /** Make sure the shell sits on web-01 as dev (idempotent). */
  ssh(): void {
    if (this.w.session.hostId === 'web-01' && this.w.session.user === 'dev') return;
    this.sh('SSH into web-01', 'ssh dev@203.0.113.10');
    if (this.w.session.pending) this.sh('…and the password', 'dev');
  }
  /** Do all requirements of an arbitrary mission pass right now? */
  allPass(m: MissionDef): boolean {
    return m.requirements.every((r) => { try { return r.check(this.w); } catch { return false; } });
  }
}

type Solver = (c: Ctx) => void;

/** Human-readable one-liner for an action result ({ok,message} shapes, SQL
 *  results, tournament standings…). */
function renderResult(r: unknown): string {
  if (r === null || r === undefined) return 'done';
  if (typeof r !== 'object') return String(r);
  const o = r as { message?: unknown; notice?: unknown; commandTag?: unknown; error?: unknown; rows?: unknown[][]; status?: unknown };
  if (o.message !== undefined) return String(o.message);
  if (o.notice !== undefined) return String(o.notice);
  if (o.commandTag !== undefined) return String(o.commandTag);
  if (o.error !== undefined) return `error: ${o.error}`;
  if (Array.isArray(o.rows) && o.rows.length) return String(o.rows.flat()[0] ?? '');
  if (o.status !== undefined) return String(o.status);
  return 'done';
}

// ---------- canonical file contents (from the mission hints / tests) ----------

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
`;

const NGINX_CONF = `server {
  listen 80;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:8080;
  }
}
`;

const LOGROTATE_CONF = `/var/log/app.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
}
`;

const DEPLOY_STEP = '  - name: deploy\n    uses: sim/deploy';
const CANARY_WITH = '    with:\n      strategy: canary';
const SIGN_STEPS = '  - name: sign\n    run: cosign sign registry.acme.dev/acme/api:v3\n  - name: attest\n    run: cosign attest --type sbom registry.acme.dev/acme/api:v3\n';
const PREVIEW_STEP = '  - name: preview\n    uses: sim/preview\n';

const PIPELINE_V1 = `name: deploy
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
`;
/** m17: staging + e2e + approval gate before production. */
const PIPELINE_V3 = `name: deploy
on: push
steps:
  - name: checkout
    uses: git/checkout
  - name: test
    run: npm test
  - name: build
    run: npm run build
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
`;
/** m23 adds the canary strategy; m35 signs in CI; m38 adds preview envs. */
const PIPELINE_CANARY = PIPELINE_V3.replace(DEPLOY_STEP, `${DEPLOY_STEP}\n${CANARY_WITH}`);
const PIPELINE_SIGNED = PIPELINE_CANARY.replace(DEPLOY_STEP, `${SIGN_STEPS}${DEPLOY_STEP}`);
const PIPELINE_PREVIEW = PIPELINE_SIGNED.replace(DEPLOY_STEP, `${PREVIEW_STEP}${DEPLOY_STEP}`);

const MAIN_TF = `provider "stratus" {
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
`;

const NETPOL_YAML = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-to-db
spec:
  podSelector:
    matchLabels:
      app: api
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api
      ports:
        - port: 5432
`;

const POLICY_YAML = `apiVersion: policy.shipit.dev/v1
kind: Policy
metadata:
  name: require-signed-images
spec:
  requireSignedImages: true
`;

// ---------- shared helpers ----------

function gitCommit(c: Ctx, msg: string): void {
  c.sh('Stage the change', 'git add -A');
  c.sh('Commit', `git commit -m "${msg}"`);
}

/** Run the pipeline; approve it when it pauses at the gate. */
function runAndApprove(c: Ctx, label: string): void {
  const run = c.act(label, () => runPipeline(c.w, '.ci/pipeline.yml'));
  if (run && run.status === 'waiting_approval') {
    c.act('Approve the production deploy', () => approveRun(c.w, run.id, true));
  }
}

/** Every resolved incident needs a postmortem for the compliance audit. */
function sweepPostmortems(c: Ctx): void {
  for (const inc of c.w.monitoring.incidents.filter((i) => i.status === 'resolved' && !i.postmortemFiled)) {
    c.act(`File the missing postmortem: ${inc.title}`, () => filePostmortem(c.w, inc.id, inc.corrective.map((x) => x.id)));
  }
}

// =====================================================
// CAREER CHAIN m01 → m40
// =====================================================

const SOLVERS: Record<string, Solver> = {
  'm01-ssh': (c) => {
    if (c.need('note-read')) c.sh('Read the handoff note', 'cat handoff.txt');
    if (c.need('ssh-in')) {
      c.sh('SSH into the company server', 'ssh dev@203.0.113.10');
      if (c.w.session.pending) c.sh('…and the password', 'dev');
    }
  },

  'm02-dead-api': (c) => {
    c.ssh();
    if (c.need('stale-gone')) c.sh('Kill the stale legacy process holding :8080', 'sudo kill 1024');
    if (c.need('svc-active')) c.sh('Start the api service', 'sudo systemctl start api');
    if (c.need('svc-enabled')) c.sh('Enable api on boot', 'sudo systemctl enable api');
    if (c.need('port-listening')) c.sh('Verify the API answers', 'curl http://localhost:8080/health');
  },

  'm03-permissions': (c) => {
    c.ssh();
    if (c.need('unit-user')) {
      const unit = c.read('/etc/systemd/system/api.service');
      const next = /User\s*=\s*\S+/.test(unit) ? unit.replace(/User\s*=\s*\S+/, 'User=dev') : unit.replace('[Service]', '[Service]\nUser=dev');
      c.write('Set User=dev in the unit file', '/etc/systemd/system/api.service', next);
    }
    if (c.need('app-owned')) c.sh('Give /opt/app to dev', 'sudo chown -R dev:dev /opt/app');
    c.sh('Reload systemd', 'sudo systemctl daemon-reload');
    c.sh('Restart the api service', 'sudo systemctl restart api');
  },

  'm04-nginx': (c) => {
    c.ssh();
    if (c.need('nginx-installed')) c.sh('Install nginx', 'sudo apt-get install -y nginx');
    if (c.need('site-conf')) c.write('Write the reverse-proxy site config', '/etc/nginx/sites-enabled/acme.conf', NGINX_CONF);
    if (c.need('nginx-active')) {
      c.sh('Enable nginx on boot', 'sudo systemctl enable nginx');
      c.sh('Start nginx', 'sudo systemctl start nginx');
    }
    if (c.need('fw-80')) c.sh('Open port 80 in the firewall', 'sudo ufw allow 80/tcp');
    if (c.need('curl-80')) c.sh('Verify: nginx fronts the API', 'curl http://localhost/');
  },

  'm05-dns': (c) => {
    const zone = `${c.w.company.slug}.dev`;
    if (c.need('a-record')) c.act(`Add the DNS record api → 203.0.113.10`, () => addDnsRecord(c.w, 'api', 'A', '203.0.113.10'));
    if (c.w.session.hostId !== 'laptop') c.sh('Back to the laptop to verify from outside', 'exit');
    if (c.need('resolves')) c.sh('Verify the name resolves', `dig +short api.${zone}`);
    if (c.need('curl-domain')) c.sh('Verify the URL works', `curl http://api.${zone}/health`);
  },

  'm06-git': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('repo')) c.sh('Initialize the repository', 'git init');
    if (c.need('identity')) {
      c.sh('Configure git identity', 'git config user.name "You"');
      c.sh('…and email', 'git config user.email "you@acme.dev"');
    }
    if (c.need('gitignore')) c.write('Write .gitignore', '/opt/app/.gitignore', 'node_modules/\n.env\n*.log\n');
    if (c.need('commit') || c.need('gitignore') || c.need('clean')) gitCommit(c, 'initial import of api source');
  },

  'm07-branch': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('branch')) c.sh('Create the feature branch', 'git checkout -b feature/api-timeout');
    if (c.need('commit-feature')) {
      const cfg = c.read('/opt/app/config.js').replace(/apiTimeout:\s*\d+/, 'apiTimeout: 60');
      c.write('Raise the API timeout to 60', '/opt/app/config.js', cfg);
      gitCommit(c, 'raise timeout for partner API');
    }
    if (c.need('conflict-resolved')) {
      // base for the resolution: our side of the conflict (or the clean file)
      let base = c.read('/opt/app/config.js');
      if (base.includes('<<<<<<<')) base = base.slice(0, base.indexOf('=======')).replace(/^.*<<<<<<<.*$/gm, '');
      c.sh('Pull main — the teammate touched the same file', 'git pull origin main');
      const resolved = base.replace(/apiTimeout:\s*\d+/, 'apiTimeout: 60').replace(/retryMax:\s*\d+/, 'retryMax: 5');
      c.write('Resolve the conflict: timeout 60 AND retryMax 5 (no markers)', '/opt/app/config.js', resolved);
      c.sh('Stage the resolution', 'git add config.js');
      c.sh('Commit the merge', 'git commit -m "merge: timeout 60 + retry 5"');
    }
    if (c.need('merged')) {
      c.sh('Back to main', 'git checkout main');
      c.sh('Merge the feature branch', 'git merge feature/api-timeout');
    }
  },

  'm08-secrets': (c) => {
    c.ssh();
    if (c.need('env-file')) c.write('Create .env with the DB password', '/opt/app/.env', 'DB_PASSWORD=b1gmeter-prod-2024\n');
    if (c.need('config-clean')) {
      const cfg = c.read('/opt/app/config.js').replace(/dbPassword:\s*"[^"]*",/, 'dbPassword: process.env.DB_PASSWORD,');
      c.write('Read the secret from the environment', '/opt/app/config.js', cfg);
    }
    if (c.need('env-ignored')) {
      const gi = c.read('/opt/app/.gitignore');
      if (!gi.split('\n').includes('.env')) c.write('Keep .env out of git', '/opt/app/.gitignore', `${gi}${gi.endsWith('\n') ? '' : '\n'}.env\n`);
    }
    if (c.need('service-env')) {
      const unit = c.read('/etc/systemd/system/api.service');
      const next = unit.includes('EnvironmentFile=') ? unit : unit.replace(/Restart=\S+/, (r) => `${r}\nEnvironmentFile=/opt/app/.env`);
      c.write('Load the env file in the service', '/etc/systemd/system/api.service', next);
      c.sh('Reload systemd', 'sudo systemctl daemon-reload');
      c.sh('Restart the api service', 'sudo systemctl restart api');
    }
  },

  'm09-docker': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('docker-installed')) c.sh('Install Docker', 'sudo apt-get install -y docker.io');
    if (c.need('dockerfile')) c.write('Write a production-grade Dockerfile', '/opt/app/Dockerfile', DOCKERFILE);
    if (c.need('image-built')) c.sh('Build the image', 'docker build -t acme/api:v1 .');
    if (c.need('service-stopped')) c.sh('Stop the systemd api service (the box moves into the container)', 'sudo systemctl stop api');
    if (c.need('container-running')) {
      const holder = c.w.docker.containers.find((x) => x.status === 'running' && x.hostPort === 8080);
      if (holder) c.sh(`Stop the container holding :8080 (${holder.name})`, `docker stop ${holder.name}`);
      if (c.w.docker.containers.some((x) => x.name === 'api')) c.sh("Remove the old 'api' container", 'docker rm api');
      c.sh('Run the API as a container', 'docker run -d --name api -p 8080:8080 acme/api:v1');
    }
    if (c.need('healthy')) c.tick(3, 'Healthcheck warmup');
    if (c.need('healthy')) c.sh('Verify the container is healthy', 'docker ps');
  },

  'm10-ci': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    c.write('Write the pipeline: test → build → docker → push → deploy', '/opt/app/.ci/pipeline.yml', PIPELINE_V1);
    gitCommit(c, 'add deploy pipeline');
    if (c.need('run-success') || c.need('deployed')) c.act('Run the pipeline (CI tab → RUN PIPELINE)', () => runPipeline(c.w, '.ci/pipeline.yml'));
  },

  'm11-db': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('provisioned')) c.act('Provision managed Postgres (db.small)', () => provisionDb(c.w, 'db.small'));
    if (c.need('migrated')) c.act('Run the migrations', () => runMigrations(c.w));
    if (c.need('db-url')) {
      const env = c.read('/opt/app/.env');
      const next = env.includes('DATABASE_URL=') ? env.replace(/^DATABASE_URL=.*$/m, 'DATABASE_URL=postgresql://api:SECRET@db-01.stratus.cloud:5432/bigmeter') : `${env}DATABASE_URL=postgresql://api:SECRET@db-01.stratus.cloud:5432/bigmeter\n`;
      c.write('Point the app at Postgres via DATABASE_URL', '/opt/app/.env', next);
      const holder = c.w.docker.containers.find((x) => x.status === 'running' && x.hostPort === 8080);
      if (holder) c.sh(`Stop the container holding :8080 (${holder.name})`, `docker stop ${holder.name}`);
      if (c.w.docker.containers.some((x) => x.name === 'api')) c.sh("Remove the old 'api' container", 'docker rm api');
      c.sh('Recreate the container with the env file', 'docker run -d --name api -p 8080:8080 --env-file .env registry.acme.dev/acme/api:v1');
    }
    if (c.need('app-postgres')) c.sh('Verify: the app reports database=postgres', 'curl http://localhost:8080/health');
  },

  'm12-monitoring': (c) => {
    if (c.need('agent')) c.act('Install the observability agent', () => installMonitoringAgent(c.w));
    if (c.need('error-alert')) c.act('Alert rule: error_pct > 2', () => addAlertRule(c.w, 'error_pct', '>', 2));
    if (c.need('cap-alert')) c.act('Alert rule: cpu_pct > 85', () => addAlertRule(c.w, 'cpu_pct', '>', 85));
  },

  'm13-disk': (c) => {
    c.ssh();
    c.wait('The disk fills up and the incident fires', () => c.w.monitoring.incidents.some((i) => i.kind === 'disk_full'), 1250, 30);
    const inc = c.w.monitoring.incidents.find((i) => i.kind === 'disk_full');
    if (c.need('disk-ok')) c.sh('Truncate the runaway log', 'sudo sh -c "echo > /var/log/app.log"');
    if (c.need('logrotate')) {
      c.write('Configure logrotate so it cannot recur', '/etc/logrotate.d/acme-api', LOGROTATE_CONF);
      c.tick(8, 'logrotate picks up the policy');
    }
    c.wait('The incident auto-resolves', () => inc?.status === 'resolved', 30, 5);
    if (inc && !inc.postmortemFiled) c.act('File the postmortem with corrective actions', () => filePostmortem(c.w, inc.id, ['rotate', 'diskalert', 'resize']));
  },

  'm14-baddeploy': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('incident-fired')) {
      const cur = c.read('/opt/app/.ci/pipeline.yml');
      const next = cur.includes('acme/api:v1') ? cur.replaceAll('acme/api:v1', 'acme/api:v2') : PIPELINE_V1.replaceAll('acme/api:v1', 'acme/api:v2');
      c.write('Ship the next release (v2) through the pipeline', '/opt/app/.ci/pipeline.yml', next);
      gitCommit(c, 'release v2');
      c.act('Run the pipeline', () => runPipeline(c.w, '.ci/pipeline.yml'));
    }
    const inc = () => c.w.monitoring.incidents.find((i) => i.kind === 'bad_deploy');
    c.wait('The error rate spikes — the incident opens', () => Boolean(inc()), 20, 1);
    if (c.need('rolled-back')) c.act('ROLL BACK to the previous image', () => rollback(c.w, 'api'));
    c.wait('Error rate recovers, incident resolves', () => inc()?.status === 'resolved', 120, 2);
    if (inc() && !inc()!.postmortemFiled) c.act('File the postmortem (≥2 corrective actions)', () => filePostmortem(c.w, inc()!.id, ['rollback', 'erralert', 'staging']));
  },

  'm15-dbperf': (c) => {
    c.wait('Traffic peaks — DB CPU saturates on seq scans', () => Math.max(...(c.w.monitoring.series.db_cpu_pct ?? []).slice(-60).map((p) => p.v)) > 90, 950, 15);
    c.act('EXPLAIN the hot query (see the Seq Scan)', () => runSql(c.w, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'"));
    if (c.need('index')) c.act('Create the missing index', () => runSql(c.w, 'CREATE INDEX idx_orders_status ON orders (status)'));
    c.wait('DB CPU recovers at the new traffic level', () => {
      const recent = (c.w.monitoring.series.db_cpu_pct ?? []).slice(-60).map((p) => p.v);
      return recent.length >= 10 && Math.max(...recent) < 70 && (c.w.monitoring.series.error_pct.at(-1)?.v ?? 99) < 2;
    }, 650, 15);
    c.act('EXPLAIN again (Index Scan now)', () => runSql(c.w, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'paid'"));
  },

  'm16-ha': (c) => {
    if (c.need('vm02')) c.act('Provision vm-02', () => provisionVm(c.w));
    if (c.need('vm02-app')) {
      c.act('Deploy the latest registry image to vm-02', () => deployToVm(c.w, 'vm-02'));
      c.tick(3, 'Container healthcheck warmup on vm-02');
    }
    if (c.need('lb')) c.act('Provision the load balancer (lb-01)', () => provisionLb(c.w));
    if (c.need('dns-lb')) c.act('Point the api DNS record at the LB', () => addDnsRecord(c.w, 'api', 'A', c.w.lb!.ip));
    c.wait('The chaos drill kills web-01 — the LB fails over, users never notice', () => Boolean(c.w.flags.haDrillSurvived), 900, 15);
  },

  'm17-e2e': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('caught') || c.need('staging') || c.need('e2e')) {
      c.write('Extend the pipeline: staging → e2e → approval → deploy', '/opt/app/.ci/pipeline.yml', PIPELINE_V3);
      gitCommit(c, 'staging + e2e + approval gate');
      c.act('Run the pipeline — e2e CATCHES the planted canary in staging', () => runPipeline(c.w, '.ci/pipeline.yml'));
    }
    if (c.need('approved') || c.need('prod-fixed')) {
      c.write('The fixed release goes through the same pipeline', '/opt/app/.ci/pipeline.yml', PIPELINE_V3);
      gitCommit(c, 'ship the fixed release');
      runAndApprove(c, 'Run the pipeline — e2e passes, the run pauses for approval');
    }
  },

  'm18-terraform': (c) => {
    c.ssh();
    if (c.need('installed')) c.sh('Install terraform', 'sudo apt-get install -y terraform');
    c.sh('mkdir -p /opt/infra', 'mkdir -p /opt/infra');
    if (c.need('managed') || c.need('init')) {
      c.write('Describe the current infrastructure in main.tf', '/opt/infra/main.tf', MAIN_TF);
      c.sh('cd /opt/infra', 'cd /opt/infra');
      c.sh('Initialize the working directory', 'terraform init');
      c.sh('Import web-01', 'terraform import stratus_vm.web-01 i-web01');
      c.sh('Import vm-02', 'terraform import stratus_vm.vm-02 i-vm02');
      c.sh('Import lb-01', 'terraform import stratus_lb.lb01 lb-main');
      c.sh('Import the database', 'terraform import stratus_db.main db-main');
    }
    c.sh('cd /opt/infra', 'cd /opt/infra');
    c.wait("Maya's prediction: someone 'saves money' via the console (drift)", () => c.w.db.plan !== 'db.small' || Boolean(c.w.tf?.driftDetected), 260, 5);
    c.sh('terraform plan — the drift shows in red', 'terraform plan');
    if (!c.w.tf?.lastPlanClean) {
      c.sh('terraform apply forces the cloud back to the code', 'terraform apply -auto-approve');
      c.sh('plan again — "No changes"', 'terraform plan');
    }
  },

  'm19-k8s': (c) => {
    const domain = `${c.w.company.slug}.dev`;
    if (c.need('cluster')) c.act('Provision the Kubernetes cluster', () => provisionK8sCluster(c.w));
    c.ssh();
    c.write('Write the api Deployment (2 replicas + probes)', '/opt/app/k8s/deployment.yaml', `apiVersion: apps/v1
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
    c.write('Write the LoadBalancer Service', '/opt/app/k8s/service.yaml', `apiVersion: v1
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
    c.write('Write the Ingress', '/opt/app/k8s/ingress.yaml', `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
spec:
  rules:
    - host: api.${domain}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api
                port: 80
`);
    c.sh('cd /opt/app', 'cd /opt/app');
    c.sh('Apply the manifests', 'kubectl apply -f k8s/');
    c.wait('Pods go Pending → Running → Ready', () => (c.w.k8s?.deployments['api']?.readyReplicas ?? 0) >= 2, 10, 1);
    if (c.need('hpa')) c.sh('Autoscale 2–6 pods at 70% CPU', 'kubectl autoscale deployment/api --min=2 --max=6 --cpu-percent=70');
    if (c.need('rollout')) {
      c.sh('Rolling update to v2', 'kubectl set image deployment/api api=registry.acme.dev/acme/api:v2');
      c.wait('Zero-downtime rollout (old pods retire only when new ones are Ready)', () => {
        const d = c.w.k8s?.deployments['api'];
        return Boolean(c.w.k8s?.zeroDowntimeProven && d && d.readyReplicas >= d.replicas);
      }, 35, 1);
      c.sh('kubectl rollout status', 'kubectl rollout status deployment/api');
    }
    c.wait('The armed traffic spike arrives — the HPA scales out', () => Object.values(c.w.k8s?.hpas ?? {}).some((h) => h.peakedAtMin !== undefined), 700, 5);
  },

  'm20-dr': (c) => {
    if (c.need('backups')) c.act('Enable automated backups BEFORE disaster strikes', () => enableBackups(c.w));
    const inc = () => c.w.monitoring.incidents.find((i) => i.kind === 'data_loss');
    c.wait("The 'cleanup' migration drops the orders table", () => Boolean(inc()), 200, 5);
    if (c.need('restored')) c.act('RESTORE from the pre-incident snapshot', () => restoreBackup(c.w));
    c.wait('Rows verified — the incident resolves', () => inc()?.status === 'resolved', 30, 2);
    if (inc() && !inc()!.postmortemFiled) c.act('File the postmortem (≥3 corrective actions)', () => filePostmortem(c.w, inc()!.id, ['restore', 'backups', 'pitr', 'review']));
  },

  'm21-team': (c) => {
    if ((c.w.team?.engineers.length ?? 0) < 2) {
      c.act('Hire a senior engineer', () => hireEngineer(c.w, 'senior'));
      c.act('Hire an SRE', () => hireEngineer(c.w, 'sre'));
    }
    if (c.need('oncall')) {
      const sre = c.w.team?.engineers.find((e) => e.role === 'sre') ?? c.w.team?.engineers[0];
      if (sre) c.act(`Put ${sre.name} on call`, () => setOnCall(c.w, sre.id));
    }
    const inc = () => c.w.monitoring.incidents.find((i) => i.kind === 'traffic_spike' && i.timeline.some((ev) => ev.text.includes('paged')));
    c.wait('The ambient incident lands — the on-call engineer is paged', () => Boolean(c.w.flags.onCallPaged), 260, 5);
    c.wait('The surge subsides; the paged incident resolves', () => inc()?.status === 'resolved', 320, 5);
  },

  'm22-debt': (c) => {
    if ((c.w.debt?.projects.filter((p) => p.done).length ?? 0) < 2) {
      c.act('Start "Delete the legacy server"', () => startRefactorProject(c.w, 'rm-legacy'));
      c.act('Start a second project (runbooks)', () => startRefactorProject(c.w, 'runbooks'));
    }
    c.wait('The refactoring projects complete (the team pays the rest down)', () => (c.w.debt?.projects.filter((p) => p.done).length ?? 0) >= 2 && (c.w.debt?.points ?? 99) < 10, 850, 10);
  },

  'm23-canary': (c) => {
    c.ssh();
    c.sh('cd /opt/app', 'cd /opt/app');
    if (c.need('configured')) {
      c.write('Switch the deploy step to the canary strategy', '/opt/app/.ci/pipeline.yml', PIPELINE_CANARY);
      gitCommit(c, 'canary strategy');
    }
    if (c.need('aborted')) {
      runAndApprove(c, 'Ship the release — 10% canary, watching for the runtime leak');
      c.wait('The canary leaks under real traffic — it ABORTS itself (prod untouched)', () => c.w.ci.canary?.status === 'aborted', 20, 1);
    }
    if (c.need('promoted')) {
      runAndApprove(c, 'QA ships the fix — run the pipeline again');
      c.wait('The clean canary promotes to 100% after the observation window', () => c.w.ci.canary?.status === 'promoted', 45, 1);
    }
  },

  'm24-slo': (c) => {
    if (!(c.req('committed') && c.req('availability') && c.req('p95') && c.req('budget'))) {
      c.act('Commit honest SLOs: 99.5% availability, 1000ms p95', () => configureSlos(c.w, 99.5, 1000));
    }
    const setAt = () => c.w.slos?.setAtMin ?? 0;
    c.wait('Hold the promises for one full sim day', () => c.w.nowMin - setAt() >= 1440, 1460, 10);
  },

  'm25-clouds': (c) => {
    if (c.need('compared')) c.act('Run the provider comparison (price × reliability × latency)', () => runCloudComparison(c.w));
    const inc = () => c.w.monitoring.incidents.find((i) => i.kind === 'provider_outage');
    c.wait('The region-wide provider outage begins (nothing you own is broken)', () => Boolean(c.w.cloud?.outage), 900, 10);
    c.tick(1, 'The outage opens after this minute\u2019s metrics');
    c.wait('The outage burns out on its own', () => c.w.cloud?.outage?.endedAtMin !== undefined, 300, 5);
    if (inc() && !inc()!.timeline.some((ev) => ev.text.includes('SLA credit claimed'))) {
      c.act('Claim the SLA credit (providers pay for their own outages)', () => claimSlcCredit(c.w));
    }
    if (inc() && !inc()!.postmortemFiled) c.act('File the outage postmortem', () => filePostmortem(c.w, inc()!.id, ['credit', 'statuspage', 'migrate']));
  },

  'm26-migrate': (c) => {
    if (c.need('migrated')) c.act('Start the migration: Volt us-central-1 (the cheap row)', () => startMigration(c.w, 'volt', 'us-central-1'));
    c.wait('Prep, replication and cutover run themselves', () => !c.w.cloud?.migration, 950, 10);
  },

  'm27-products': (c) => {
    const products = () => ensureProducts(c.w).products;
    const started = (id: string) => products().some((p) => p.id === id && (p.startedAtMin !== undefined || p.launchedAtMin !== undefined));
    if (!started('insights')) c.act('Build Insights (the second product)', () => startProduct(c.w, 'insights'));
    if (!started('ent-grid')) c.act('Build Enterprise Grid (the gated tier)', () => startProduct(c.w, 'ent-grid'));
    c.wait('The products build and launch', () => products().filter((p) => p.launchedAtMin !== undefined).length >= 2, 650, 10);
    c.wait('Product MRR reaches 10% of subscriptions', () => productMrrOf(c.w) >= 0.1 * baseMrrOf(c.w), 200, 10);
  },

  'm28-finops': (c) => {
    if (c.need('recs') || c.need('cheaper')) {
      // an ambient spike would legitimately scale the HPA back out and hide
      // the node-pool recommendation — settle the traffic first (deterministic)
      c.act('Settle ambient traffic so the rightsizing scan is deterministic', () => {
        const w = c.w;
        const api = w.k8s?.deployments['api'];
        if (api && api.replicas > 2) api.replicas = 2;
        for (const h of Object.values(w.k8s?.hpas ?? {})) h.currentReplicas = Math.min(h.currentReplicas, 2);
        w.flags.trafficSpike = false;
        w.scheduledEvents = w.scheduledEvents.filter((e) => e.kind !== 'traffic_spike');
        return { ok: true, message: 'api back to 2 replicas, traffic surge cleared' };
      });
      c.tick(2, 'The recommendation scan runs');
      c.act('Commit 1-year reserved compute (−20%)', () => reserveCompute(c.w));
      c.act('Decommission vm-02 (Kubernetes serves now)', () => decommissionVm(c.w, 'vm-02'));
      c.act('Resize the node pool 3 → 2', () => resizeNodePool(c.w, 2));
      c.tick(2, 'Resolved recommendations are recorded');
    }
    if (c.need('budget')) c.act('Set the budget at the OPTIMIZED bill', () => setFinopsBudget(c.w, Math.ceil(monthlyInfraCost(c.w))));
    c.wait('Hold the budget for two sim days', () => (c.w.finops?.daysUnderBudget ?? 0) >= 2, 3 * 1440, 1440);
  },

  'm29-packs': (c) => {
    if (!(c.state.packs ?? []).includes('postmortem-tournament')) {
      c.act('Activate The Postmortem Tournament (MODES → Mission packs)', () => activatePack(c.state, 'postmortem-tournament'));
      const first = currentPackMissionOf(c.state);
      if (first?.id === 'pmr-01') c.act('Round 1 begins — a traffic surge is armed', () => { first.onStart?.(c.w); return { ok: true, message: 'round 1 started' }; });
    }
    playSurgeRound(c);
  },

  'm30-tournament': (c) => {
    for (let guard = 0; guard < 8; guard++) {
      const pm = currentPackMissionOf(c.state);
      if (!pm || !PACK_SOLVERS[pm.id]) break;
      PACK_SOLVERS[pm.id](c);
      c.evalNow();
      if (currentPackMissionOf(c.state)?.id === pm.id) break; // the round did not clear — report honestly
    }
  },

  'm31-challenge': (c) => {
    if (!c.need('passed')) return; // a challenge was already passed
    if (c.w.challenge?.status === 'active' && c.w.challenge.id !== 'back-from-dead') {
      c.act('Abandon the unrelated running challenge', () => abandonChallenge(c.w));
    }
    if (c.w.challenge?.status !== 'active' || c.w.challenge.id !== 'back-from-dead') {
      c.act('Accept the RTO challenge: "Back from the Dead"', () => startChallenge(c.w, 'back-from-dead'));
    }
    const at = c.w.challenge?.disasterAtMin;
    if (at !== undefined) {
      c.wait('The auditors drop the database at an unannounced minute', () => c.w.nowMin >= at, at - c.w.nowMin + 10, 5);
      c.act('RESTORE immediately — the stopwatch is running', () => restoreBackup(c.w));
      c.wait('The verdict lands', () => c.w.challenge?.status === 'passed', 40, 2);
    }
  },

  'm32-access': (c) => {
    if (c.need('a11y')) c.act('Enable high contrast (accessibility)', () => setPlayerSettings(c.w, { highContrast: true }));
    if (c.need('locale')) c.act('Switch the interface language to Deutsch', () => setPlayerSettings(c.w, { locale: 'de' }));
  },

  'm33-vault': (c) => {
    c.ssh();
    if (c.need('vault-installed')) c.sh('Install the vault', 'sudo apt-get install -y vault');
    if (c.need('secret-stored')) {
      c.sh('vault status — initializes the secrets engine', 'vault status');
      c.sh('Store the DB secret (value generated inside the vault)', 'vault put database/api');
    }
    if (c.need('dynamic-creds')) c.sh('Lease dynamic credentials to the app', 'vault lease database/api');
    if (c.need('rotated')) c.sh('Rotate the secret — zero downtime', 'vault rotate database/api');
    c.wait('A stray file with live secret material appears (~40 sim min)', () => Boolean(c.w.flags.vaultLeakPlanted), 60, 1);
    if (c.need('leak-cleaned')) {
      c.sh('Scan for leaks — it finds the stray file', 'vault scan');
      c.sh('Rotate the leaked value into oblivion', 'vault rotate database/api');
      c.sh('Scan again — clean', 'vault scan');
    }
  },

  'm34-zerotrust': (c) => {
    if (c.need('mesh')) c.act('Install the service mesh (identities issued)', () => installMesh(c.w));
    if (c.need('strict')) c.act('Enforce STRICT mTLS', () => setMtlsStrict(c.w, true));
    if (c.need('netpol-deny') || c.need('netpol-allow')) {
      c.ssh();
      c.write('Write the NetworkPolicies: default-deny + exactly api → db :5432', '/opt/app/k8s/netpol.yaml', NETPOL_YAML);
      c.sh('cd /opt/app', 'cd /opt/app');
      c.sh('Apply the policies', 'kubectl apply -f k8s/');
      c.sh('Verify', 'kubectl get netpol');
    }
    if (c.need('non-root')) {
      const cur = c.read('/opt/app/k8s/deployment.yaml');
      if (!cur.includes('runAsNonRoot')) {
        c.write('Add securityContext.runAsNonRoot to the api container', '/opt/app/k8s/deployment.yaml', cur.replace('          ports:\n', '          securityContext:\n            runAsNonRoot: true\n          ports:\n'));
        c.ssh();
        c.sh('cd /opt/app', 'cd /opt/app');
        c.sh('Re-apply the deployment', 'kubectl apply -f k8s/deployment.yaml');
        c.sh('Verify: runAsNonRoot=yes', 'kubectl describe deployment api');
      }
    }
  },

  'm35-supplychain': (c) => {
    c.ssh();
    if (c.need('policy')) {
      c.sh('Install cosign', 'sudo apt-get install -y cosign');
      c.write('Write the admission Policy: unsigned images rejected', '/opt/app/k8s/policy.yaml', POLICY_YAML);
      c.sh('cd /opt/app', 'cd /opt/app');
      c.sh('Apply the policy', 'kubectl apply -f k8s/policy.yaml');
    }
    if (c.need('gate-proven')) {
      c.sh('cd /opt/app', 'cd /opt/app');
      c.sh('Build the next release unsigned', 'docker build -t registry.acme.dev/acme/api:v3 .');
      c.sh('Push it', 'docker push registry.acme.dev/acme/api:v3');
      c.sh('Try to roll it out — DENIED by the admission webhook (the proof)', 'kubectl set image deployment/api api=registry.acme.dev/acme/api:v3');
    }
    if (c.need('signed') || c.need('sbom')) {
      c.sh('Sign the image', 'cosign sign registry.acme.dev/acme/api:v3');
      c.sh('Attach the SBOM attestation', 'cosign attest --type sbom registry.acme.dev/acme/api:v3');
      c.sh('Roll it out — the gate lets it through', 'kubectl set image deployment/api api=registry.acme.dev/acme/api:v3');
    }
    if (c.need('ci-signs')) {
      c.write('Make CI sign what it ships', '/opt/app/.ci/pipeline.yml', PIPELINE_SIGNED);
      c.ssh();
      c.sh('cd /opt/app', 'cd /opt/app');
      gitCommit(c, 'sign in ci');
      runAndApprove(c, 'Run the pipeline — signed end to end');
    }
  },

  'm36-audit': (c) => {
    if (c.w.hosts['web-01'].users['contractor']?.sudo) c.act('Access review: revoke the contractor\u2019s sudo', () => revokeSudo(c.w, 'contractor'));
    if (!c.w.compliance?.auditImmutable) c.act('Ship the audit log to the append-only store', () => enableAuditStore(c.w));
    sweepPostmortems(c);
    if (c.need('evidence')) c.act('Collect the evidence bundle', () => collectEvidence(c.w));
    const findings = complianceFindings(c.w);
    if (findings.length) c.note(`Still open: ${findings.map((f) => f.id).join(', ')}`);
  },

  'm37-portal': (c) => {
    if (c.need('portal-enabled')) c.act('Launch the developer portal', () => enablePortal(c.w));
    if (c.need('template-published')) c.act('Publish the "Web service" golden path', () => publishTemplate(c.w, 'web-service'));
    c.wait('Developers ship via the golden path; the ticket queue drains', () => (c.w.portal?.ticketQueue ?? 99) === 0 && (c.w.portal?.devDeploys ?? 0) >= 3, 450, 10);
  },

  'm38-previews': (c) => {
    c.ssh();
    c.write('Add a preview step — every run gets its own ephemeral environment', '/opt/app/.ci/pipeline.yml', PIPELINE_PREVIEW);
    c.sh('cd /opt/app', 'cd /opt/app');
    gitCommit(c, 'preview envs');
    runAndApprove(c, 'Run the pipeline — PR 1 gets pr-1.preview.<domain>');
    c.tick(70, 'Stagger the second PR ~1 sim hour later');
    runAndApprove(c, 'Run the pipeline — PR 2 gets its own environment');
    c.wait('pr-1 ages out and destroys itself (ephemerality proven)', () => Number(c.w.flags.previewsDestroyed ?? 0) >= 1, 200, 5);
  },

  'm39-tracing': (c) => {
    if (c.need('tracing-on')) c.act('Enable distributed tracing', () => enableTracing(c.w));
    c.wait('Traces sample (one every 5 sim minutes)', () => (c.w.traces ?? []).length >= 10, 70, 5);
    c.act('ANALYZE — the db span owns the latency (connection churn)', () => analyzeTraces(c.w));
    if (c.need('pooler')) c.act('Enable pgbouncer (the fix the trace pointed at)', () => enablePooler(c.w));
    if (c.need('latency-alert')) c.act('Alert rule: db_p95_ms > 900 (SLO-aware)', () => addAlertRule(c.w, 'db_p95_ms', '>', 900));
    c.tick(10, 'Fresh spans with the pooler in front');
    c.act('Analyze again — db spans shrink', () => analyzeTraces(c.w));
  },

  'm40-acquisition': (c) => {
    sweepPostmortems(c);
    c.wait('A calm incident board', () => !c.w.monitoring.incidents.some((i) => i.status === 'open'), 300, 5);
    let pillars = c.act('Open the data room — five-pillar due diligence', () => dueDiligence(c.w));
    if (pillars?.some((p) => p.id === 'reliability' && !p.pass)) {
      // the 99.5% error budget was burned by provider outages — renegotiate to
      // a promise the platform actually keeps (the honest move, per mission 24)
      for (const target of [99.0, 98.5, 98.0, 97.0, 95.0]) {
        c.act(`Re-commit to an honest SLO the platform keeps (${target}% availability)`, () => configureSlos(c.w, target, 1000));
        const report = sloReport(c.w);
        if (report.availabilityMet && report.budgetRemainingPct > 0) break;
      }
      pillars = c.act('Re-run due diligence with the honest promises', () => dueDiligence(c.w));
    }
    if (c.need('term-sheet')) c.act('Accept the term sheet', () => acceptTermSheet(c.w));
    if (c.need('scale-survived')) c.wait('The announcement wave hits — the platform holds', () => Boolean(c.w.flags.scaleEventSurvived), 240, 5);
    sweepPostmortems(c);
  }
};

// =====================================================
// BONUS TRACK — the postmortem tournament pack
// =====================================================

const roundStart = (c: Ctx, pmId: string): number => Number(c.w.flags[startFlagKey(pmId)] ?? 0);
const roundIncident = (c: Ctx, pmId: string, kind: string): Incident | undefined =>
  c.w.monitoring.incidents.find((i) => i.kind === kind && i.openedAtMin >= roundStart(c, pmId));

function pmDef(id: string): MissionDef | undefined {
  const pack = getPack('postmortem-tournament');
  return pack ? packMissionsOf(pack).find((m) => m.id === id) : undefined;
}

/**
 * Rounds with an MTTR requirement score EVERY incident since the round
 * started — an overlapping ambient incident (or a provider outage pinning
 * errors at 80%) can poison the window. Each attempt restarts the round with
 * a fresh scoring window, so only fast, deliberate resolutions count.
 */
function withRoundRetry(c: Ctx, pmId: string, eventKind: string, play: () => void): void {
  const def = pmDef(pmId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (def && c.allPass(def)) return;
    c.w.scheduledEvents = c.w.scheduledEvents.filter((e) => e.kind !== eventKind);
    c.act(attempt === 0 ? 'Open the round with a clean scoring window' : 'Restart the round — the previous window was not clean', () => {
      def?.onStart?.(c.w);
      return { ok: true, message: `${pmId} armed` };
    });
    play();
  }
}

function playSurgeRound(c: Ctx): void {
  let inc = roundIncident(c, 'pmr-01', 'traffic_spike');
  if (!inc) c.wait('The traffic surge opens (~10 sim min into the round)', () => Boolean(roundIncident(c, 'pmr-01', 'traffic_spike')), 90, 2);
  inc = roundIncident(c, 'pmr-01', 'traffic_spike');
  if (!inc) { c.note('The surge round did not open — the event may have been consumed'); return; }
  if (inc.status !== 'resolved') c.wait('The surge subsides and the incident auto-resolves (MTTR clock running)', () => roundIncident(c, 'pmr-01', 'traffic_spike')?.status === 'resolved', 250, 5);
  if (!inc.postmortemFiled) c.act('File the postmortem (≥2 corrective actions)', () => filePostmortem(c.w, inc!.id, ['autoscale', 'trafficalert']));
}

const PACK_SOLVERS: Record<string, Solver> = {
  'pmr-01': playSurgeRound,

  'pmr-02': (c) => {
    if (c.w.ci.deployments.length < 2) {
      c.act('Ship two releases so a rollback target exists', () => {
        deployImage(c.w, 'registry.acme.dev/api:v1.8.0', 'api', 'manual');
        deployImage(c.w, 'registry.acme.dev/api:v1.9.0', 'api', 'ci');
        return { ok: true, message: 'deployment history created' };
      });
    }
    withRoundRetry(c, 'pmr-02', 'tournament_incident', () => {
      let inc = roundIncident(c, 'pmr-02', 'bad_deploy');
      if (!inc) c.wait('A teammate ships a broken release (~10 sim min)', () => Boolean(roundIncident(c, 'pmr-02', 'bad_deploy')), 90, 2);
      inc = roundIncident(c, 'pmr-02', 'bad_deploy');
      if (!inc) { c.note('The bad-deploy round did not open'); return; }
      if (c.w.flags.badDeployBug) c.act('ROLL BACK — one click, seconds not hours', () => rollback(c.w, 'api'));
      c.wait('The blast radius shrinks; the incident resolves', () => roundIncident(c, 'pmr-02', 'bad_deploy')?.status === 'resolved', 300, 2);
      if (inc.status !== 'resolved') { c.note('The incident is still open (a provider outage can pin the error rate)'); return; }
      if (!inc.postmortemFiled) c.act('File the postmortem (≥3 corrective actions)', () => filePostmortem(c.w, inc!.id, ['rollback', 'erralert', 'staging']));
    });
  },

  'pmr-03': (c) => {
    if (!c.w.cloud) c.act('Bring up the provider market', () => ensureCloud(c.w));
    let inc = roundIncident(c, 'pmr-03', 'provider_outage');
    if (!inc) c.wait('The region-wide outage begins (~15 sim min)', () => Boolean(roundIncident(c, 'pmr-03', 'provider_outage')), 90, 5);
    inc = roundIncident(c, 'pmr-03', 'provider_outage');
    if (!inc) { c.note('The outage round did not open'); return; }
    if (inc.status !== 'resolved') c.wait('Same outage for every team — ride it out', () => roundIncident(c, 'pmr-03', 'provider_outage')?.status === 'resolved', 300, 5);
    if (!inc.timeline.some((ev) => ev.text.includes('SLA credit claimed'))) c.act('Claim the SLA credit', () => claimSlcCredit(c.w));
    if (!inc.postmortemFiled) c.act('File the postmortem (≥2 corrective actions)', () => filePostmortem(c.w, inc!.id, ['credit', 'statuspage']));
  },

  'pmr-04': (c) => {
    if (!c.w.db.provisioned) c.act('Provision the database', () => provisionDb(c.w, 'db.small'));
    if (!c.w.db.backups.enabled) c.act('Enable backups before the drop', () => enableBackups(c.w));
    withRoundRetry(c, 'pmr-04', 'dr_drill', () => {
      let inc = roundIncident(c, 'pmr-04', 'data_loss');
      if (!inc) c.wait('They drop the orders table on purpose (~10 sim min)', () => Boolean(roundIncident(c, 'pmr-04', 'data_loss')), 90, 2);
      inc = roundIncident(c, 'pmr-04', 'data_loss');
      if (!inc) { c.note('The database-drop round did not open'); return; }
      if (inc.status !== 'resolved') {
        c.act('RESTORE from the pre-drop snapshot — RTO clock running', () => restoreBackup(c.w));
        c.wait('Rows back; the incident resolves', () => roundIncident(c, 'pmr-04', 'data_loss')?.status === 'resolved', 30, 2);
      }
      if (!inc.postmortemFiled) c.act('File the postmortem (≥3 corrective actions)', () => filePostmortem(c.w, inc!.id, ['restore', 'backups', 'pitr']));
    });
  },

  'pmr-05': (c) => {
    c.act('Read the scoreboard', () => ({
      ok: true,
      message: `points ${c.w.tournament?.points ?? 0} — rivals: ${(c.w.tournament?.rivals ?? []).map((r) => `${r.name} ${r.points}`).join(', ')}`
    }));
    c.wait('A tidy board: no open incidents', () => !c.w.monitoring.incidents.some((i) => i.status === 'open'), 300, 5);
  }
};

// =====================================================
// RUNNER
// =====================================================

/**
 * Play the canonical walkthrough for the current mission (career chain, or
 * the pack bonus track with opts.pack). Steps are recorded; the mission board
 * is evaluated to fixpoint afterwards so pack-track completions that unlock
 * the career mission (m29/m30) land in the same call.
 */
export function solveMission(state: GameState, opts: { pack?: boolean } = {}): SolveResult {
  const m = opts.pack ? currentPackMissionOf(state) : currentMission(state);
  const base: SolveResult = { ok: true, missionId: m?.id ?? '', missionTitle: m?.title ?? '', completed: false, steps: [], requirements: [] };
  if (!m) {
    return { ...base, ok: false, message: opts.pack ? 'no pack mission is active' : 'no current mission (sandbox or campaign complete)' };
  }
  const already = evalRequirements(m, state.world);
  if (already.every((r) => r.pass)) {
    base.steps.push({ kind: 'note', label: 'Every requirement already passed — completing the mission.' });
  } else {
    const solver = SOLVERS[m.id] ?? PACK_SOLVERS[m.id];
    if (!solver) return { ...base, ok: false, message: 'no auto-solve walkthrough exists for this mission' };
    const c = new Ctx(state, m);
    try {
      solver(c);
    } catch (e) {
      c.note(`The walkthrough hit an error: ${String(e)}`);
    }
    base.steps = c.steps;
  }
  // evaluate to fixpoint (pack completions can unlock the career mission only
  // on the next pass, and one completion can cascade several)
  let last = -1;
  for (let i = 0; i < 4 && state.missions.completed.length !== last; i++) {
    last = state.missions.completed.length;
    evaluateMissions(state);
  }
  base.completed = state.missions.completed.includes(m.id);
  base.requirements = evalRequirements(m, state.world);
  if (!base.completed) base.message = 'the walkthrough ran but the mission did not complete — see the step log';
  return base;
}
