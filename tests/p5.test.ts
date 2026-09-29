// P5 — Trust & Scale: the full security/compliance arc (m33–m36) and the
// platform-engineering endgame (m37–m40), driven like a player would.
import { describe, it, expect } from 'vitest';
import { GameState } from '../server/src/types';
import { MISSIONS } from '../server/src/missions/missions';
import { createWorld, tick, provisionDb, runMigrations, enableBackups, installMonitoringAgent, configureSlos, hireEngineer, setOnCall, ensureProducts, setFinopsBudget, ensureFinops, provisionK8sCluster, installMesh, setMtlsStrict, revokeSudo, enableAuditStore, collectEvidence, complianceFindings, enablePortal, publishTemplate, enableTracing, analyzeTraces, enablePooler, addAlertRule, dueDiligence, acceptTermSheet, monthlyInfraCost } from '../server/src/world';
import { runTerminalInput } from '../server/src/sim/host';
import { runPipeline, deployImage } from '../server/src/sim/ci';
import { applyManifests } from '../server/src/sim/k8s';
import { evaluateMissions, currentMission } from '../server/src/engine';
import { httpRequest } from '../server/src/sim/net';
import * as fs from '../server/src/sim/fs';

let state: GameState;
const sh = (cmd: string) => runTerminalInput(state.world, cmd).lines.map((l) => l.text).join('\n');
const W = () => state.world;
const write = (path: string, content: string) => fs.writeFile(W().hosts['web-01'].fs, path, content, 'dev');
const read = (path: string) => fs.readFile(W().hosts['web-01'].fs, path);
const evalM = () => evaluateMissions(state);

const PIPELINE_V2 = `name: deploy
on: push
steps:
  - name: checkout
    uses: git/checkout
  - name: test
    run: npm test
  - name: build
    run: npm run build
  - name: docker_build
    run: docker build -t registry.acme.dev/acme/api:v2 .
  - name: push
    run: docker push registry.acme.dev/acme/api:v2
  - name: deploy
    uses: sim/deploy
`;

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --omit=dev
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "server.js"]
`;

const DEPLOYMENT_YAML = `apiVersion: apps/v1
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
          image: registry.acme.dev/acme/api:v2
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
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

/** A save at the end of m32: platform built, k8s serving, economy running. */
function p5State(): GameState {
  const w = createWorld('Acme Metrics', 'you');
  const sh = (cmd: string) => runTerminalInput(w, cmd);
  const write = (path: string, content: string) => fs.writeFile(w.hosts['web-01'].fs, path, content, 'dev');
  w.company.launched = true;
  w.company.users = 20000;
  w.company.satisfaction = 4.7;
  w.flags.logrotateConfigured = true; // post-m13
  w.flags.logAccumMB = 40;
  // SSH onto web-01 like every late-game session
  w.session = { ...w.session, hostId: 'web-01', user: 'dev', cwd: '/home/dev', env: { ...w.session.env, HOME: '/home/dev', USER: 'dev' } };

  // docker + registry + running app
  sh('sudo apt-get install -y docker.io');
  write('/opt/app/Dockerfile', DOCKERFILE);
  sh('cd /opt/app && git init');
  sh('git config user.name "you" && git config user.email you@acme.dev');
  write('/opt/app/.ci/pipeline.yml', PIPELINE_V2);
  sh('git add -A && git commit -m "platform"');
  sh('cd /opt/app && docker build -t registry.acme.dev/acme/api:v2 .');
  sh('docker push registry.acme.dev/acme/api:v2');
  deployImage(w, 'registry.acme.dev/acme/api:v2', 'api', 'ci');

  // kubernetes cluster with the api deployment
  provisionK8sCluster(w);
  write('/opt/app/k8s/deployment.yaml', DEPLOYMENT_YAML);
  applyManifests(w, DEPLOYMENT_YAML);
  const svc = DEPLOYMENT_YAML.replace('kind: Deployment', 'kind: Service').replace(/replicas: 2/, 'type: LoadBalancer');
  applyManifests(w, `apiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  type: LoadBalancer\n  selector:\n    app: api\n  ports:\n    - port: 80\n      targetPort: 8080`);

  // data + observability + promises
  provisionDb(w, 'db.small');
  runMigrations(w);
  w.db.tables['orders'].indexes.push({ name: 'idx_orders_status', columns: ['status'] }); // post-m15
  enableBackups(w);
  installMonitoringAgent(w);
  configureSlos(w, 99.5, 1000);

  // team, products, finops (post m21/m27/m28)
  hireEngineer(w, 'sre');
  hireEngineer(w, 'senior');
  setOnCall(w, w.team!.engineers[0].id);
  const products = ensureProducts(w);
  for (const p of products.products) p.launchedAtMin = w.nowMin - 1440;
  setFinopsBudget(w, monthlyInfraCost(w));
  ensureFinops(w).daysUnderBudget = 3;

  const st: GameState = {
    id: 'p5', createdAt: 0, updatedAt: 0, world: w,
    missions: { completed: MISSIONS.filter((m) => m.index <= 32).map((m) => m.id), current: '', hintsUsed: {}, attempts: {}, ratings: {} },
    skills: {}, xp: 0
  };
  return st;
}

function expectDone(missionId: string) {
  expect(state.missions.completed).toContain(missionId);
}

describe('P5: trust & scale — full chain m33 → m40', () => {
  it('m33 — vault: dynamic creds, rotation, leak scan', () => {
    state = p5State();
    evalM(); // picks up m33 (first uncompleted) and fires onStart (arms the leak)
    expect(currentMission(state)?.id).toBe('m33-vault');
    expect(W().scheduledEvents.some((e) => e.kind === 'secret_leak')).toBe(true);

    expect(sh('vault status')).toContain('command not found'); // not installed yet
    sh('sudo apt-get install -y vault');
    expect(sh('vault status')).toContain('Sealed          false');
    sh('vault put database/api');
    expect(sh('vault lease database/api')).toContain('auto-renewed');
    expect(W().vault?.credsLive).toBe(true);
    sh('vault rotate database/api');
    expect(W().vault?.secrets['database/api'].rotations).toBe(1);
    // app still healthy through the rotation
    expect(httpRequest(W(), 'http://localhost:8080/health').status).toBe(200);

    // the stray file appears ~40 sim minutes in
    tick(W(), 45);
    expect(Boolean(W().flags.vaultLeakPlanted)).toBe(true);
    expect(read('/opt/app/notes-old.txt')).toContain('db-vlt-');
    // clean scan finds nothing until the leak exists — and now it does
    expect(sh('vault scan')).toContain('LEAK');
    expect(Boolean(W().flags.vaultLeakDetected)).toBe(true);
    sh('vault rotate database/api');
    expect(Boolean(W().flags.vaultLeakRevoked)).toBe(true);
    expect(sh('vault scan')).toContain('Clean');
    evalM();
    expectDone('m33-vault');
  });

  it('m34 — zero trust: mesh, strict mTLS, netpol, runAsNonRoot', () => {
    expect(currentMission(state)?.id).toBe('m34-zerotrust');
    installMesh(W());
    expect(W().zeroTrust?.identities).toContain('db');
    setMtlsStrict(W(), true);

    write('/opt/app/k8s/netpol.yaml', NETPOL_YAML);
    expect(sh('cd /opt/app && kubectl apply -f k8s/')).toContain('networkpolicy.networking.k8s.io/allow-api-to-db created');
    expect(sh('kubectl get netpol')).toContain('deny-all ingress');

    // least privilege: re-apply the deployment with securityContext
    write('/opt/app/k8s/deployment.yaml', DEPLOYMENT_YAML.replace('          ports:\n', '          securityContext:\n            runAsNonRoot: true\n          ports:\n'));
    sh('cd /opt/app && kubectl apply -f k8s/deployment.yaml');
    expect(sh('kubectl describe deployment api')).toContain('runAsNonRoot=yes');
    evalM();
    expectDone('m34-zerotrust');
  });

  it('m35 — supply chain: admission policy blocks unsigned, cosign ships signed', () => {
    expect(currentMission(state)?.id).toBe('m35-supplychain');
    sh('sudo apt-get install -y cosign');
    write('/opt/app/k8s/policy.yaml', POLICY_YAML);
    expect(sh('cd /opt/app && kubectl apply -f k8s/policy.yaml')).toContain('require-signed-images');

    // build + push the next release unsigned, then watch the gate bounce it
    sh('cd /opt/app && docker build -t registry.acme.dev/acme/api:v3 .');
    sh('docker push registry.acme.dev/acme/api:v3');
    const denied = sh('kubectl set image deployment/api api=registry.acme.dev/acme/api:v3');
    expect(denied).toContain('admission webhook');
    expect(denied).toContain('not signed');
    expect(Boolean(W().flags.admissionBlocked)).toBe(true);
    expect(W().k8s!.deployments['api'].image).toContain(':v2'); // cluster untouched

    // sign + attest, then the rollout goes through
    sh('cosign sign registry.acme.dev/acme/api:v3');
    expect(sh('cosign attest --type sbom registry.acme.dev/acme/api:v3')).toContain('Attestation pushed');
    expect(sh('kubectl set image deployment/api api=registry.acme.dev/acme/api:v3')).toContain('image updated');
    expect(W().k8s!.deployments['api'].image).toContain(':v3');

    // make CI sign forever
    const pipeline = PIPELINE_V2.replaceAll(':v2', ':v3').replace('  - name: deploy', '  - name: sign\n    run: cosign sign registry.acme.dev/acme/api:v3\n  - name: attest\n    run: cosign attest --type sbom registry.acme.dev/acme/api:v3\n  - name: deploy');
    write('/opt/app/.ci/pipeline.yml', pipeline);
    sh('git add -A && git commit -m "sign in ci"');
    const run = runPipeline(W(), '.ci/pipeline.yml');
    expect(run.status).toBe('success');
    const active = W().ci.deployments.find((d) => d.active)!;
    expect(active.image).toContain(':v3');
    const reg = W().registry.find((i) => i.repoTags[0] === active.image)!;
    expect(reg.signed).toBe(true);
    expect(reg.sbom).toBe(true);
    evalM();
    expectDone('m35-supplychain');
  });

  it('m36 — the auditor: access review, append-only audit, evidence, zero findings', () => {
    expect(currentMission(state)?.id).toBe('m36-audit');
    expect(W().hosts['web-01'].users['contractor']?.sudo).toBe(true); // seeded by onStart
    expect(complianceFindings(W()).map((f) => f.id)).toContain('contractor-access');

    revokeSudo(W(), 'contractor');
    enableAuditStore(W());
    const bundle = collectEvidence(W());
    expect(bundle.checks.filter((c) => c.ok).length).toBeGreaterThanOrEqual(8);
    expect(complianceFindings(W())).toHaveLength(0);
    evalM();
    expectDone('m36-audit');
    expect(Boolean(W().flags.trustPhaseComplete)).toBe(true);
  });

  it('m37 — golden paths: portal live, devs ship, ticket queue drains', () => {
    expect(currentMission(state)?.id).toBe('m37-portal');
    enablePortal(W());
    publishTemplate(W(), 'web-service');
    tick(W(), 300); // a dev ships every 20 sim minutes; 14 tickets to drain
    const p = W().portal!;
    expect(p.devDeploys).toBeGreaterThanOrEqual(3);
    expect(p.ticketQueue).toBe(0);
    expect(p.deployLog.length).toBeGreaterThan(0);
    evalM();
    expectDone('m37-portal');
  });

  it('m38 — ephemeral previews: one stage per PR, auto-destroy', () => {
    expect(currentMission(state)?.id).toBe('m38-previews');
    // the pipeline keeps evolving: v3, signed, and now with a preview stage
    const pipeline = PIPELINE_V2
      .replaceAll(':v2', ':v3')
      .replace('  - name: deploy', '  - name: sign\n    run: cosign sign registry.acme.dev/acme/api:v3\n  - name: attest\n    run: cosign attest --type sbom registry.acme.dev/acme/api:v3\n  - name: preview\n    uses: sim/preview\n  - name: deploy');
    write('/opt/app/.ci/pipeline.yml', pipeline);
    sh('git add -A && git commit -m "preview envs"');
    runPipeline(W(), '.ci/pipeline.yml'); // pr-1
    tick(W(), 70);
    runPipeline(W(), '.ci/pipeline.yml'); // pr-2 (staggered ~1h later)
    expect(Number(W().flags.previewCounter)).toBe(2);

    const live = W().ci.previews!;
    expect(live.map((p) => p.id).join(',')).toContain('pr-2');
    const res = httpRequest(W(), `http://pr-2.preview.acme-metrics.dev/health`);
    expect(res.status).toBe(200);
    expect(res.headers?.join('\n')).toContain('X-Preview: pr-2');

    // pr-1 ages out; pr-2 stays alive
    tick(W(), 60);
    expect(Number(W().flags.previewsDestroyed)).toBe(1);
    expect(W().ci.previews!.map((p) => p.id)).toEqual(['pr-2']);
    expect(httpRequest(W(), 'http://pr-1.preview.acme-metrics.dev/health').status).toBe(404);
    evalM();
    expectDone('m38-previews');
  });

  it('m39 — tracing: attribute latency, fix the db, alert on the right metric', () => {
    expect(currentMission(state)?.id).toBe('m39-tracing');
    enableTracing(W());
    W().db.cpuPct = 35; // connection churn under load
    tick(W(), 60); // 12 traces sampled
    expect((W().traces ?? []).length).toBeGreaterThanOrEqual(10);
    const analysis = analyzeTraces(W());
    expect(analysis.ok).toBe(true);
    const db = analysis.attribution.find((a) => a.service === 'db')!;
    expect(db.sharePct).toBeGreaterThanOrEqual(40);
    expect(Boolean(W().flags.traceBottleneckFound)).toBe(true);

    enablePooler(W());
    addAlertRule(W(), 'db_p95_ms', '>', 900);
    tick(W(), 10); // fresh spans with the pooler
    const later = analyzeTraces(W());
    const dbAfter = later.attribution.find((a) => a.service === 'db')!;
    expect(dbAfter.avgMs).toBeLessThan(db.avgMs);
    evalM();
    expectDone('m39-tracing');
  });

  it('m40 — the acquisition: clean data room, term sheet, scale event survived', () => {
    expect(currentMission(state)?.id).toBe('m40-acquisition');
    const pillars = dueDiligence(W());
    const red = pillars.filter((p) => !p.pass);
    expect(red).toEqual([]); // the seeded post-m32 platform + P5 arc should be clean

    const usersBefore = W().company.users;
    expect(acceptTermSheet(W()).ok).toBe(true);
    expect(Boolean(W().endgame?.termSheetAccepted)).toBe(true);
    expect(W().company.users).toBeGreaterThan(usersBefore * 2); // announcement wave armed
    expect(W().scheduledEvents.some((e) => e.kind === 'exit_scale_check')).toBe(true);
    expect(W().era).toBeDefined(); // P6a: accepting the term sheet starts the Scale Era economy

    tick(W(), 50); // the announcement traffic hits at +45
    expect(Boolean(W().flags.scaleEventSurvived)).toBe(true);
    evalM();
    expectDone('m40-acquisition');
    expect(Boolean(W().flags.legendMode)).toBe(true);
    expect(state.missions.current).toBe(''); // campaign complete
  });
});

describe('P5 units', () => {
  it('admission policy rejects unsigned images on apply too', () => {
    state = p5State();
    const w = W();
    provisionK8sCluster(w);
    w.k8s!.admissionPolicy = { rule: 'signed-images', name: 'test', appliedAtMin: w.nowMin };
    sh('cd /opt/app && docker build -t registry.acme.dev/acme/api:v9 . && docker push registry.acme.dev/acme/api:v9');
    const res = applyManifests(w, DEPLOYMENT_YAML.replaceAll(':v2', ':v9'));
    expect(res.ok).toBe(false);
    expect(res.lines.map((l) => l.text).join('\n')).toContain('admission webhook');
  });

  it('vault scan is honest: no leak, no hit', () => {
    state = p5State();
    sh('sudo apt-get install -y vault');
    sh('vault status');
    sh('vault put database/api');
    expect(sh('vault scan')).toContain('Clean');
    expect(Boolean(W().flags.vaultLeakDetected)).toBe(false);
  });

  it('compliance findings map to real state', () => {
    state = p5State();
    const w = W();
    const ids = () => complianceFindings(w).map((f) => f.id);
    expect(ids()).toContain('secrets-plaintext'); // no vault yet
    expect(ids()).toContain('audit-mutable');
    expect(ids()).toContain('no-evidence');
    enableAuditStore(w);
    collectEvidence(w);
    expect(ids()).not.toContain('audit-mutable');
    expect(ids()).not.toContain('no-evidence');
    expect(ids()).toContain('secrets-plaintext'); // still real
  });
});
