// REST API — the only bridge between the React client and the simulated world.
import { Router, Request, Response } from 'express';
import { GameState, OutLine } from './types';
import { Storage } from './state';
import { createWorld, tick, audit, costLineItems, monthlyInfraCost, uptimePct, addDnsRecord, allowPort, provisionDb, resizeDb, runMigrations, resizeDisk, installMonitoringAgent, addAlertRule, removeAlertRule, filePostmortem, latest, diskUsagePct, provisionVm, deployToVm, provisionLb, haReady, provisionK8sCluster, enableBackups, restoreBackup, hireEngineer, fireEngineer, setOnCall, runMarketingCampaign, startRefactorProject, configureSlos, sloReport, promoteCanary, abortCanary, ensureDebt, ensureTeam, ensureSlos, payrollOf, ROLE_INFO, runCloudComparison, claimSlcCredit, startMigration, decommissionVm, ensureProducts, startProduct, productBlockers, productMrrOf, baseMrrOf, ensureFinops, setFinopsBudget, reserveCompute, finopsRecommendations, startChallenge, abandonChallenge, challengeLive, setPlayerSettings } from './world';
import { runTerminalInput } from './sim/host';
import { resolveHostname, parseNginxSites, lbBackends, hostServesApi } from './sim/net';
import { runPipeline, rollback, approveRun } from './sim/ci';
import { runSql } from './sim/dbsim';
import { k8sServes, resizeNodePool } from './sim/k8s';
import { providerOf, regionOf } from './sim/cloud';
import { CHALLENGES, challengeOf, challengeStars } from './sim/challenges';
import { getFile, writeFile, resolvePath, getNode, listDir, nodeSizeMB } from './sim/fs';
import { currentMission, currentPackMission, evalRequirements, evaluateMissions, takeHint, fillTemplate, commandsRun, allMissionSummaries } from './engine';
import { availablePacks, activatePack, currentPackMissionOf, getPack, packMissionsOf } from './missions/packs';
import { status as gitStatus } from './sim/git';
import { complianceFindings, collectEvidence, enableAuditStore, revokeSudo, installMesh, setMtlsStrict, enablePortal, publishTemplate, enableTracing, analyzeTraces, enablePooler, dueDiligence, acceptTermSheet } from './world';
import { randomUUID } from 'crypto';

export function createApi(storage: Storage): Router {
  const api = Router();

  // ---- game lifecycle ----
  api.post('/games', async (req: Request, res: Response) => {
    const { company, founder, mode } = req.body ?? {};
    if (!company || typeof company !== 'string') return res.status(400).json({ error: 'company name required' });
    const state: GameState = {
      id: randomUUID().slice(0, 8),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      world: createWorld(company.slice(0, 40), (founder ?? 'you').slice(0, 40)),
      missions: { completed: [], current: 'm01-ssh', hintsUsed: {}, attempts: {}, ratings: {} },
      skills: {},
      xp: 0
    };
    if (mode === 'sandbox') {
      state.world.company.cash = 250000;
      state.world.flags.sandbox = true;
    }
    await storage.save(state);
    res.json({ id: state.id });
  });

  api.get('/games', async (_req, res) => res.json(await storage.list()));

  api.delete('/games/:id', async (req, res) => {
    res.json({ deleted: await storage.delete(req.params.id) });
  });

  // ---- main view-model ----
  api.get('/games/:id', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    evaluateMissions(state); // time-based requirements complete on poll
    await storage.save(state);
    res.json(view(state));
  });

  // ---- terminal ----
  api.post('/games/:id/terminal', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const input = String(req.body?.input ?? '').slice(0, 2000);
    if (input) state.world.session.history.push(input);
    commandsRun(state);
    const out: { lines: OutLine[] } = runTerminalInput(state.world, input);
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ...out, session: sessionView(state) });
  });

  // ---- filesystem / editor ----
  api.get('/games/:id/fs', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const base = String(req.query.path ?? '/opt/app');
    const walk = (abs: string, depth: number): unknown => {
      const host = state.world.hosts['web-01'];
      const node = getNode(host.fs, abs);
      if (!node || node.type !== 'dir') return null;
      return listDir(host.fs, abs)?.map(({ name, node: n }) => ({
        name,
        type: n.type,
        sizeMB: Math.round(nodeSizeMB(n) * 100) / 100,
        owner: n.owner,
        mode: n.mode.toString(8),
        children: n.type === 'dir' && depth < 3 ? walk(`${abs}/${name}`, depth + 1) : undefined
      }));
    };
    res.json({ path: base, entries: walk(base, 0) });
  });

  api.get('/games/:id/file', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const f = getFile(state.world.hosts['web-01'].fs, String(req.query.path ?? ''));
    if (!f || f.type !== 'file') return res.status(404).json({ error: 'file not found' });
    res.json({ path: req.query.path, content: f.content, owner: f.owner, mode: f.mode.toString(8) });
  });

  api.put('/games/:id/file', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const p = resolvePath('/', String(req.body?.path ?? ''));
    const content = String(req.body?.content ?? '').slice(0, 200000);
    const r = writeFile(state.world.hosts['web-01'].fs, p, content, 'dev');
    if (!r.ok) return res.status(400).json(r);
    audit(state.world, state.world.session.user, 'file', `Edited ${p}`);
    // unit file changes and nginx reloads are player's responsibility; hint via warnings
    const warnings: string[] = [];
    if (p.endsWith('.service')) warnings.push('Unit file changed — run: sudo systemctl daemon-reload && sudo systemctl restart api');
    if (p.startsWith('/etc/nginx/')) warnings.push('nginx config changed — run: sudo systemctl restart nginx');
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true, warnings });
  });

  // ---- missions ----
  api.post('/games/:id/mission/hint', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = takeHint(state, Boolean(req.body?.pack));
    await storage.save(state);
    res.json(result ?? { hint: null, index: -1, remaining: 0 });
  });

  // ---- CI ----
  api.post('/games/:id/ci/run', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const pipelinePath = String(req.body?.pipeline ?? '.ci/pipeline.yml');
    const run = runPipeline(state.world, pipelinePath);
    evaluateMissions(state);
    await storage.save(state);
    res.json({ run });
  });

  api.post('/games/:id/deployments/:depId/rollback', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const active = state.world.ci.deployments.find((d) => d.id === req.params.depId);
    const result = rollback(state.world, active?.service ?? 'api');
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- CI: staging approval gate ----
  api.post('/games/:id/ci/:runId/approve', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const approve = req.body?.approve !== false;
    const result = approveRun(state.world, req.params.runId, approve);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- database ----
  api.post('/games/:id/db/query', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const sql = String(req.body?.sql ?? '').slice(0, 4000);
    const result = runSql(state.world, sql);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/db/migrate', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = runMigrations(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- cloud console ----
  api.post('/games/:id/cloud/dns', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { name, type, value, ttl } = req.body ?? {};
    const r = addDnsRecord(state.world, String(name ?? ''), String(type ?? 'A'), String(value ?? ''), Number(ttl ?? 300));
    evaluateMissions(state);
    await storage.save(state);
    res.json(r);
  });

  api.post('/games/:id/cloud/firewall', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    allowPort(state.world, Number(req.body?.port ?? 0));
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true, firewall: state.world.firewall });
  });

  api.post('/games/:id/cloud/db', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const plan = req.body?.plan ?? 'db.small';
    if (state.world.db.provisioned) resizeDb(state.world, plan);
    else provisionDb(state.world, plan);
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true, db: state.world.db });
  });

  api.post('/games/:id/cloud/disk', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    resizeDisk(state.world, Math.max(40, Math.min(200, Number(req.body?.gb ?? 40))));
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true });
  });

  api.post('/games/:id/cloud/agent', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    installMonitoringAgent(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true });
  });

  // ---- cloud: HA (second VM + load balancer) ----
  api.post('/games/:id/cloud/vm', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = provisionVm(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/vm/:hostId/deploy', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = deployToVm(state.world, req.params.hostId ?? 'vm-02');
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/lb', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = provisionLb(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- cloud: Kubernetes cluster ----
  api.post('/games/:id/cloud/k8s', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = provisionK8sCluster(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- database: backups + restore ----
  api.post('/games/:id/cloud/backups', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const retention = Number(req.body?.retentionDays ?? 7);
    const result = enableBackups(state.world, retention);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/db/restore', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = restoreBackup(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- company: team, marketing, debt, SLOs, canary ----
  api.post('/games/:id/team/hire', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const role = String(req.body?.role ?? '');
    const result = hireEngineer(state.world, role as never);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/team/:engId/fire', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = fireEngineer(state.world, req.params.engId);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/team/oncall', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const engineerId = req.body?.engineerId ?? null;
    const result = setOnCall(state.world, engineerId ? String(engineerId) : null);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/marketing', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = runMarketingCampaign(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/debt/project/:projectId/start', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = startRefactorProject(state.world, req.params.projectId);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/slos', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = configureSlos(state.world, Number(req.body?.availability ?? 99.5), Number(req.body?.p95ms ?? 600));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/canary/promote', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = promoteCanary(state.world, 'operator promoted early');
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/canary/abort', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = abortCanary(state.world, 'operator aborted');
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- trust (P5a): mesh, compliance ----
  api.post('/games/:id/cloud/mesh', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const action = String(req.body?.action ?? '');
    const result = action === 'strict'
      ? setMtlsStrict(state.world, true)
      : installMesh(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/compliance/evidence', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const bundle = collectEvidence(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true, message: `evidence collected: ${bundle.checks.filter((c) => c.ok).length}/${bundle.checks.length} controls verified`, bundle });
  });

  api.post('/games/:id/compliance/access', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = revokeSudo(state.world, String(req.body?.user ?? ''));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/compliance/auditlog', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = enableAuditStore(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- platform engineering (P5b): portal, tracing, pooler, endgame ----
  api.post('/games/:id/portal/enable', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = enablePortal(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/portal/templates/:templateId/publish', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = publishTemplate(state.world, req.params.templateId);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/tracing/enable', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = enableTracing(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/tracing/analyze', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = analyzeTraces(state.world);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/db/pooler', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = enablePooler(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/endgame/accept', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = acceptTermSheet(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- ecosystem (P3): providers, migration, products, FinOps ----
  api.post('/games/:id/cloud/compare', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = runCloudComparison(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/provider/credit', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = claimSlcCredit(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/migrate', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = startMigration(state.world, String(req.body?.toProvider ?? ''), String(req.body?.toRegion ?? ''));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/vm/:hostId/decommission', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = decommissionVm(state.world, req.params.hostId);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/products/:productId/start', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = startProduct(state.world, req.params.productId);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/finops/budget', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = setFinopsBudget(state.world, Number(req.body?.monthly ?? 0));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/finops/reserve', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = reserveCompute(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/k8s/nodes', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = resizeNodePool(state.world, Number(req.body?.count ?? 3));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- modes & content at scale (P4): packs, tournament, challenges, access ----
  api.get('/packs', (_req, res) => res.json(availablePacks()));

  api.post('/games/:id/packs/:packId/activate', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = activatePack(state, req.params.packId);
    if (result.ok) {
      const first = currentPackMissionOf(state);
      try { first?.onStart?.(state.world); } catch (e) { void e; }
      evaluateMissions(state);
    }
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/challenge/start', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = startChallenge(state.world, String(req.body?.challengeId ?? ''));
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/challenge/abandon', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = abandonChallenge(state.world);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/settings', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { locale, highContrast, largeText, reducedMotion } = req.body ?? {};
    const result = setPlayerSettings(state.world, { locale, highContrast, largeText, reducedMotion });
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- monitoring ----
  api.post('/games/:id/alerts', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { metric, op, threshold } = req.body ?? {};
    const rule = addAlertRule(state.world, String(metric ?? 'error_pct'), op ?? '>', Number(threshold ?? 2));
    evaluateMissions(state);
    await storage.save(state);
    res.json({ ok: true, rule });
  });

  api.delete('/games/:id/alerts/:alertId', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    removeAlertRule(state.world, req.params.alertId);
    await storage.save(state);
    res.json({ ok: true });
  });

  // ---- postmortems ----
  api.post('/games/:id/incidents/:incId/postmortem', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const actions = Array.isArray(req.body?.actions) ? req.body.actions.map(String) : [];
    const result = filePostmortem(state.world, req.params.incId, actions);
    evaluateMissions(state);
    await storage.save(state);
    res.json(result);
  });

  // ---- time ----
  api.post('/games/:id/time', async (req, res) => {
    const state = await storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { paused, speed } = req.body ?? {};
    if (paused !== undefined) state.world.flags.paused = Boolean(paused);
    if (speed !== undefined) state.world.flags.speed = Math.max(0, Math.min(16, Number(speed)));
    await storage.save(state);
    res.json({ ok: true });
  });

  return api;

  // ---- view model ----
  function sessionView(state: GameState) {
    const w = state.world;
    const host = w.hosts[w.session.hostId];
    return {
      hostId: w.session.hostId,
      user: w.session.user,
      cwd: w.session.cwd,
      pending: Boolean(w.session.pending),
      prompt: w.session.pending ? 'Password: ' : `${w.session.user}@${host.id}:${w.session.cwd.replace(`/home/${w.session.user}`, '~')}$`
    };
  }

  function view(state: GameState) {
    const w = state.world;
    const m = currentMission(state);
    const latestOf = (k: string) => latest(w, k) ?? 0;
    const tail = (k: string, n = 120) => (w.monitoring.series[k] ?? []).slice(-n).map((p) => p.v);
    const nginxUp = w.hosts['web-01'].services['nginx']?.state === 'active';
    const apiSvc = w.hosts['web-01'].services['api'];
    const repo = w.git['/opt/app'];
    const gitInfo = repo ? (() => {
      const s = gitStatus(w, repo);
      const head = repo.branches[repo.head]?.commit;
      return {
        branch: repo.head,
        commits: Object.keys(repo.commits).length,
        dirty: s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length,
        pushed: Boolean(head && repo.remoteBranches['origin/' + repo.head] === head),
        conflicts: s.conflicted
      };
    })() : null;

    // architecture map
    const nodes: { id: string; label: string; kind: string; tier: number; status: 'ok' | 'warn' | 'error'; detail: string }[] = [];
    const edges: [string, string][] = [];
    nodes.push({ id: 'users', label: `Users (${Math.round(w.company.users).toLocaleString()})`, kind: 'users', tier: 0, status: 'ok', detail: w.company.launched ? 'Public dashboard users' : 'No users yet — launch pending' });
    if (Object.keys(w.dns[`${w.company.slug}.dev`] ?? {}).length) {
      nodes.push({ id: 'dns', label: `DNS ${w.company.slug}.dev`, kind: 'dns', tier: 1, status: 'ok', detail: Object.entries(w.dns[`${w.company.slug}.dev`]).map(([k, v]) => `${k} ${v.type} ${v.value}`).join('\n') });
      edges.push(['users', 'dns']);
    }
    if (w.firewall.enabled) {
      nodes.push({ id: 'fw', label: `Firewall (${w.firewall.allowedPorts.join(', ')})`, kind: 'firewall', tier: 2, status: w.firewall.allowedPorts.includes(80) ? 'ok' : 'warn', detail: `Allowed ports: ${w.firewall.allowedPorts.join(', ')}` });
      edges.push([nodes[nodes.length - 2]?.id ?? 'users', 'fw']);
    }
    if (w.lb?.provisioned) {
      nodes.push({ id: 'lb', label: `lb-01 (${w.lb.ip})`, kind: 'loadbalancer', tier: 2.5, status: lbBackends(w).some((b) => b.healthy) ? 'ok' : 'error', detail: `Load balancer\nbackends: ${lbBackends(w).map((b) => `${b.id}${b.healthy ? '' : ' (DOWN)'}`).join(', ') || 'none registered'}\n${w.flags.web01Down ? 'CHAOS DRILL: web-01 is down' : 'all hosts up'}` });
      edges.push([w.firewall.enabled ? 'fw' : 'dns', 'lb']);
    }
    if (w.hosts['web-01'].packages.includes('nginx')) {
      nodes.push({ id: 'nginx', label: 'nginx :80', kind: 'proxy', tier: 3, status: nginxUp ? 'ok' : 'error', detail: nginxUp ? parseNginxSites(w.hosts['web-01']).map((s) => `${s.file}: :${s.listen} → ${s.proxyPass ?? 'static'}`).join('\n') : 'service not running' });
      edges.push([w.lb?.provisioned ? 'lb' : w.firewall.enabled ? 'fw' : 'dns', 'nginx']);
    }
    if (w.hosts['vm-02']) {
      const vm2Serving = hostServesApi(w, 'vm-02');
      nodes.push({ id: 'vm02', label: 'vm-02 · 203.0.113.11', kind: 'host', tier: 3.5, status: vm2Serving ? 'ok' : 'warn', detail: vm2Serving ? 'serving API on :8080' : 'provisioned but not serving the API yet' });
      edges.push([w.lb?.provisioned ? 'lb' : 'fw', 'vm02']);
    }
    if (w.k8s?.provisioned) {
      const deps = Object.values(w.k8s.deployments);
      const apiDep = deps.find((d) => d.name === 'api') ?? deps[0];
      const ready = apiDep ? `${apiDep.readyReplicas}/${apiDep.replicas}` : '—';
      nodes.push({
        id: 'k8s', label: `k8s-01 · ${deps.length} deployment(s)`, kind: 'cluster', tier: 3.7, status: k8sServes(w) ? 'ok' : 'warn',
        detail: `Kubernetes ${w.k8s.version} · nodes ${w.k8s.nodes.length}\npods: ${w.k8s.pods.length}\n${apiDep ? `api: ${ready} ready · image ${apiDep.image}\nprobes: readiness=${apiDep.readinessProbe ? '✓' : '✗'} liveness=${apiDep.livenessProbe ? '✓' : '✗'}` : 'no deployments'}${Object.keys(w.k8s.hpas).length ? `\nHPA: ${Object.values(w.k8s.hpas).map((h) => `${h.deployment} ${h.minReplicas}-${h.maxReplicas}`).join(', ')}` : ''}`
      });
      edges.push([w.lb?.provisioned ? 'lb' : 'fw', 'k8s']);
    }
    const appStatus: 'ok' | 'warn' | 'error' = w.app.mode === 'stopped' ? 'error' : w.monitoring.incidents.some((i) => i.status === 'open') ? 'warn' : 'ok';
    const apiNode = w.app.mode === 'container'
      ? { id: 'api', label: `api ${w.app.version} (container)`, kind: 'app', tier: 4, status: appStatus, detail: `image: ${w.app.image}\ndatabase: ${w.app.database}\nenv: ${Object.keys(w.app.env).join(', ') || 'none'}` }
      : { id: 'api', label: `api ${w.app.version} (systemd)`, kind: 'app', tier: 4, status: appStatus, detail: `service: ${apiSvc?.state ?? 'n/a'}\nuser: ${apiSvc?.user ?? 'n/a'}\ndatabase: ${w.app.database}` };
    nodes.push(apiNode);
    edges.push([w.lb?.provisioned ? 'lb' : w.hosts['web-01'].packages.includes('nginx') ? 'nginx' : 'fw', 'api']);
    if (w.db.provisioned) {
      nodes.push({ id: 'db', label: `Postgres (${w.db.plan})`, kind: 'database', tier: 5, status: w.db.cpuPct > 90 ? 'warn' : 'ok', detail: `${w.db.endpoint}\nCPU ${w.db.cpuPct}%  conns ${w.db.connections}\nseqScans/s ${w.db.seqScansPerSec}` });
      edges.push(['api', 'db']);
    } else {
      nodes.push({ id: 'db', label: 'sqlite (local file)', kind: 'database', tier: 5, status: 'warn', detail: '/opt/app/data/app.sqlite — single file, same box as the app' });
      edges.push(['api', 'db']);
    }
    if (w.docker.images.length || w.ci.runs.length) {
      nodes.push({ id: 'ci', label: 'CI + registry', kind: 'cicd', tier: 4.5 as unknown as number, status: 'ok', detail: `${w.ci.runs.length} runs · ${w.registry.length} images in registry` });
      edges.push(['ci', 'api']);
    }
    nodes.push({ id: 'host', label: 'web-01 · 203.0.113.10', kind: 'host', tier: 6, status: diskUsagePct(w) > 90 ? 'warn' : 'ok', detail: `disk ${diskUsagePct(w).toFixed(0)}% · packages: ${w.hosts['web-01'].packages.join(', ')}` });

    const openIncident = w.monitoring.incidents.find((i) => i.status === 'open') ?? null;

    return {
      id: state.id,
      day: Math.floor(w.nowMin / 1440) + 1,
      time: `${String(Math.floor((w.nowMin % 1440) / 60)).padStart(2, '0')}:${String(w.nowMin % 60).padStart(2, '0')}`,
      paused: Boolean(w.flags.paused),
      speed: Number(w.flags.speed ?? 1),
      company: { ...w.company, domain: `${w.company.slug}.dev`, uptime: uptimePct(w), monthlyInfra: monthlyInfraCost(w) },
      skills: state.skills,
      xp: state.xp,
      missions: {
        summaries: allMissionSummaries(state),
        completed: state.missions.completed,
        phaseComplete: Boolean(w.flags.buildPhaseComplete),
        current: m ? {
          id: m.id,
          title: fillTemplate(m.title, w),
          story: fillTemplate(m.story, w),
          objective: fillTemplate(m.objective, w),
          coaching: fillTemplate(m.coaching, w),
          skills: m.skills,
          hintsUsed: state.missions.hintsUsed[m.id] ?? 0,
          hintsTotal: m.hints.length,
          requirements: evalRequirements(m, w)
        } : null,
        pack: (() => {
          const pm = currentPackMission(state);
          if (!pm) return null;
          return {
            id: pm.id,
            title: fillTemplate(pm.title, w),
            story: fillTemplate(pm.story, w),
            objective: fillTemplate(pm.objective, w),
            coaching: fillTemplate(pm.coaching, w),
            skills: pm.skills,
            hintsUsed: state.missions.hintsUsed[pm.id] ?? 0,
            hintsTotal: pm.hints.length,
            requirements: evalRequirements(pm, w),
            progress: (() => {
              for (const packId of state.packs ?? []) {
                const pack = getPack(packId);
                if (!pack) continue;
                const idx = packMissionsOf(pack).findIndex((x) => x.id === pm.id);
                if (idx >= 0) return { round: idx + 1, of: pack.missions.length, packName: pack.name };
              }
              return null;
            })()
          };
        })()
      },
      metrics: {
        latest: {
          req_rate: latestOf('req_rate'), error_pct: latestOf('error_pct'), p95_ms: latestOf('p95_ms'),
          cpu_pct: latestOf('cpu_pct'), mem_pct: latestOf('mem_pct'), db_cpu_pct: latestOf('db_cpu_pct'),
          disk_pct: Math.round(diskUsagePct(w) * 10) / 10, users: latestOf('users')
        },
        series: {
          cpu_pct: tail('cpu_pct'), error_pct: tail('error_pct'), req_rate: tail('req_rate', 90),
          p95_ms: tail('p95_ms', 90), db_cpu_pct: tail('db_cpu_pct'), disk_pct: tail('disk_pct', 200)
        }
      },
      alerts: w.monitoring.alertRules,
      incidents: w.monitoring.incidents,
      openIncident,
      costs: { lineItems: costLineItems(w), monthlyTotal: monthlyInfraCost(w), payroll: payrollOf(w) },
      audit: w.audit.slice(-80).reverse(),
      hosts: Object.values(w.hosts).map((h) => ({ id: h.id, ip: h.ip, label: h.label, os: h.os })),
      session: sessionView(state),
      git: gitInfo,
      docker: {
        images: w.docker.images.map((i) => ({ tag: i.repoTags[0], sizeMB: i.sizeMB, user: i.user ?? 'root', healthcheck: Boolean(i.healthcheck), layers: i.layers.length, signed: Boolean(i.signed), sbom: Boolean(i.sbom) })),
        containers: w.docker.containers.map((c) => ({ name: c.name, image: c.image, status: c.status, healthy: c.healthy, port: c.hostPort })),
        registry: w.registry.map((i) => ({ tag: i.repoTags[0], sizeMB: i.sizeMB, signed: Boolean(i.signed), sbom: Boolean(i.sbom) }))
      },
      ci: {
        runs: w.ci.runs.slice(-6).reverse(),
        deployments: w.ci.deployments.slice(-8).reverse(),
        staging: w.ci.staging ? { image: w.ci.staging.image, e2ePassed: w.ci.staging.e2ePassed, e2eLog: w.ci.staging.e2eLog.slice(-6) } : null,
        previews: (w.ci.previews ?? []).map((p) => ({ id: p.id, image: p.image, url: p.url, createdAtMin: p.createdAtMin, minutesLeft: Math.max(0, p.expiresAtMin - w.nowMin) })),
        previewsDestroyed: Number(w.flags.previewsDestroyed ?? 0)
      },
      db: {
        provisioned: w.db.provisioned, plan: w.db.plan, endpoint: w.db.endpoint,
        cpu: w.db.cpuPct, connections: w.db.connections, migrationsDone: w.db.migrationsDone,
        pooler: Boolean(w.db.pooler),
        tables: Object.values(w.db.tables).map((t) => ({ name: t.name, rows: t.rowCount, indexes: t.indexes.map((i) => `${i.name}(${i.columns.join(',')})`) })),
        backups: {
          enabled: w.db.backups.enabled,
          retentionDays: w.db.backups.retentionDays,
          snapshots: w.db.backups.snapshots.slice(-5).reverse().map((s) => ({ atMin: s.atMin, label: s.label, ordersRows: s.ordersRows })),
          lastRestore: w.db.backups.lastRestore ?? null
        }
      },
      k8s: w.k8s?.provisioned ? {
        name: w.k8s.name,
        version: w.k8s.version,
        ip: w.k8s.ip,
        nodes: w.k8s.nodes.length,
        serving: k8sServes(w),
        zeroDowntimeProven: w.k8s.zeroDowntimeProven,
        deployments: Object.values(w.k8s.deployments).map((d) => ({ name: d.name, image: d.image, replicas: d.replicas, ready: d.readyReplicas, revision: d.revision, strategy: d.strategy, readinessProbe: d.readinessProbe, livenessProbe: d.livenessProbe })),
        pods: w.k8s.pods.map((p) => ({ name: p.name, phase: p.phase, restarts: p.restarts, node: p.node, revision: p.revision })),
        services: Object.values(w.k8s.services).map((s) => ({ name: s.name, type: s.type, port: s.port, targetPort: s.targetPort, selector: s.selector, ingressIp: s.ingressIp ?? null })),
        ingresses: Object.values(w.k8s.ingresses).map((i) => ({ name: i.name, host: i.host, service: i.service })),
        hpas: Object.values(w.k8s.hpas).map((h) => ({ name: h.name, deployment: h.deployment, min: h.minReplicas, max: h.maxReplicas, current: h.currentReplicas, peaked: h.peakedAtMin !== undefined })),
        networkPolicies: Object.values(w.k8s.networkPolicies ?? {}).map((p) => ({ name: p.name, defaultDeny: p.defaultDeny, allows: p.allows })),
        admissionPolicy: w.k8s.admissionPolicy ? { name: w.k8s.admissionPolicy.name, rule: w.k8s.admissionPolicy.rule } : null
      } : null,
      tf: w.tf ? {
        initialized: w.tf.initialized,
        managed: Object.keys(w.tf.resources).length,
        addresses: Object.keys(w.tf.resources),
        lastPlanClean: w.tf.lastPlanClean,
        driftDetected: w.tf.driftDetected,
        driftResolved: w.tf.driftResolved
      } : null,
      team: (() => {
        const team = ensureTeam(w);
        return {
          engineers: team.engineers.map((e) => ({ id: e.id, name: e.name, role: e.role, salary: e.salaryMonthly, roleLabel: ROLE_INFO[e.role]?.label ?? e.role })),
          onCallId: team.onCallId,
          roles: Object.entries(ROLE_INFO).map(([id, r]) => ({ id, ...r }))
        };
      })(),
      debt: (() => {
        const debt = ensureDebt(w);
        return {
          points: Math.round(debt.points * 10) / 10,
          log: debt.log.slice(0, 8),
          projects: debt.projects.map((p) => ({
            id: p.id, label: p.label, detail: p.detail, debtRemoved: p.debtRemoved,
            costCash: p.costCash, durationMin: p.durationMin,
            startedAtMin: p.startedAtMin ?? null, done: p.done,
            progress: p.startedAtMin !== undefined && !p.done ? Math.min(100, Math.round(((w.nowMin - p.startedAtMin) / p.durationMin) * 100)) : null
          }))
        };
      })(),
      slos: (() => {
        const s = ensureSlos(w);
        return { ...s, report: sloReport(w) };
      })(),
      canary: w.ci.canary ? { ...w.ci.canary, minutesObserved: w.ci.canary.active ? w.nowMin - w.ci.canary.startedAtMin : null } : null,
      marketingActive: Number(w.flags.marketingUntilMin ?? 0) > w.nowMin,
      cloud: (() => {
        const c = w.cloud;
        if (!c) return null;
        const p = providerOf(c.provider);
        const r = regionOf(c.provider, c.region);
        const nowCost = monthlyInfraCost(w);
        const o = c.outage;
        const m = c.migration;
        return {
          provider: c.provider,
          region: c.region,
          providerName: p.name,
          tagline: p.tagline,
          regionName: r.name,
          latencyMs: r.latencyMs,
          reliabilityPct: p.reliabilityPct,
          priceMult: Math.round(p.priceMult * r.priceMult * 100) / 100,
          compared: c.compared,
          comparison: (c.lastComparison ?? []).map((row) => ({
            provider: row.provider,
            region: row.region,
            providerName: providerOf(row.provider).name,
            regionName: regionOf(row.provider, row.region).name,
            monthlyCost: row.monthlyCost,
            latencyMs: regionOf(row.provider, row.region).latencyMs,
            reliabilityPct: providerOf(row.provider).reliabilityPct,
            deltaPct: Math.round((row.monthlyCost / Math.max(1, nowCost) - 1) * 100),
            note: row.note
          })),
          outage: o ? {
            provider: o.provider,
            providerName: providerOf(o.provider).name,
            region: o.region,
            durationMin: o.durationMin,
            minutesLeft: o.endedAtMin === undefined ? Math.max(0, o.startedAtMin + o.durationMin - w.nowMin) : 0,
            ended: o.endedAtMin !== undefined,
            creditClaimed: o.creditClaimed,
            creditValue: o.endedAtMin !== undefined && !o.creditClaimed ? Math.round(nowCost * (o.durationMin / 1440) * providerOf(o.provider).creditMultiplier) : null,
            incidentId: o.incidentId ?? null
          } : null,
          outagesSeen: c.outagesSeen,
          creditsTotal: c.creditsTotal,
          migration: m ? {
            toProvider: m.toProvider,
            toRegion: m.toRegion,
            providerName: providerOf(m.toProvider).name,
            regionName: regionOf(m.toProvider, m.toRegion).name,
            status: m.status,
            progressPct: m.status === 'cutover' ? 100 : Math.min(100, Math.round(((w.nowMin - m.startedAtMin) / m.durationMin) * 100)),
            downtimeMin: m.downtimeMin,
            minutesLeft: Math.max(0, (m.status === 'cutover' ? m.cutoverEndsAtMin ?? w.nowMin : m.startedAtMin + m.durationMin) - w.nowMin)
          } : null,
          migrations: c.migrations.map((rec) => ({ ...rec, providerName: providerOf(rec.toProvider).name }))
        };
      })(),
      products: (() => {
        const ps = ensureProducts(w);
        return {
          products: ps.products.map((p) => ({
            id: p.id, name: p.name, tagline: p.tagline, tier: p.tier,
            pricePerUserMonthly: p.pricePerUserMonthly, adoptionPct: p.adoptionPct, infraMonthly: p.infraMonthly,
            buildCost: p.buildCost, buildHours: Math.round(p.buildDurationMin / 60),
            requires: p.requires ?? null,
            blockers: p.startedAtMin === undefined && p.launchedAtMin === undefined ? productBlockers(w, p) : [],
            startedAtMin: p.startedAtMin ?? null,
            launchedAtMin: p.launchedAtMin ?? null,
            progress: p.startedAtMin !== undefined && p.launchedAtMin === undefined ? Math.min(100, Math.round(((w.nowMin - p.startedAtMin) / p.buildDurationMin) * 100)) : null,
            mrr: p.launchedAtMin !== undefined ? Math.round(w.company.users * (p.adoptionPct / 100) * p.pricePerUserMonthly) : null
          })),
          productMrr: Math.round(productMrrOf(w)),
          baseMrr: Math.round(baseMrrOf(w))
        };
      })(),
      finops: (() => {
        const f = w.finops;
        if (!f) return null;
        const infra = monthlyInfraCost(w);
        const totalMrr = baseMrrOf(w) + productMrrOf(w);
        const margin = totalMrr > 0 ? Math.round(((totalMrr - infra - payrollOf(w)) / totalMrr) * 100) : 0;
        return {
          budgetMonthly: f.budgetMonthly ?? null,
          daysUnderBudget: f.daysUnderBudget,
          daysOverBudget: f.daysOverBudget,
          currentMonthly: infra,
          baselineMonthly: f.baselineMonthly ?? null,
          vsBaselinePct: f.baselineMonthly ? Math.round((infra / f.baselineMonthly - 1) * 100) : null,
          reserved: f.reservedProvider ? { provider: f.reservedProvider, providerName: providerOf(f.reservedProvider).name, active: w.cloud?.provider === f.reservedProvider } : null,
          recommendations: finopsRecommendations(w),
          resolvedCount: f.resolved.length,
          resolvedIds: f.resolved,
          unitEconomics: {
            costPerUser: w.company.users > 0 ? Math.round((infra / w.company.users) * 1000) / 1000 : 0,
            revenuePerUser: Math.round((totalMrr / Math.max(1, w.company.users)) * 100) / 100,
            grossMarginPct: margin
          }
        };
      })(),
      // ---- P5a: trust ----
      vault: (() => {
        const v = w.vault;
        if (!v) return null;
        return {
          enabled: v.enabled,
          credsLive: v.credsLive,
          secrets: Object.values(v.secrets).map((s) => ({ path: s.path, rotations: s.rotations, leases: s.dynamicLeases, lastRotatedAtMin: s.rotatedAtMin })),
          leakDetected: Boolean(w.flags.vaultLeakDetected),
          leakRevoked: Boolean(w.flags.vaultLeakRevoked)
        };
      })(),
      zeroTrust: (() => {
        const zt = w.zeroTrust;
        if (!zt) return null;
        return { meshInstalled: zt.meshInstalled, mtlsStrict: zt.mtlsStrict, identities: zt.identities };
      })(),
      compliance: (() => {
        const c = w.compliance;
        return {
          auditImmutable: Boolean(c?.auditImmutable),
          bundlesCount: c?.bundles.length ?? 0,
          lastBundle: c?.bundles.slice(-1)[0] ? { atMin: c.bundles[c.bundles.length - 1].atMin, checks: c.bundles[c.bundles.length - 1].checks } : null,
          findings: complianceFindings(w),
          users: Object.values(w.hosts['web-01'].users).map((u) => ({ name: u.name, sudo: u.sudo, groups: u.groups }))
        };
      })(),
      // ---- P5b: platform ----
      portal: (() => {
        const p = w.portal;
        if (!p) return null;
        return {
          enabled: p.enabled,
          templates: p.templates,
          ticketQueue: p.ticketQueue,
          devDeploys: p.devDeploys,
          deployLog: p.deployLog.slice(-10).reverse()
        };
      })(),
      tracing: {
        enabled: Boolean(w.flags.tracingEnabled),
        bottleneckFound: Boolean(w.flags.traceBottleneckFound),
        dbP95: latestOf('db_p95_ms'),
        traces: (w.traces ?? []).slice(-8).reverse().map((t) => ({ id: t.id, atMin: t.atMin, path: t.path, durationMs: t.durationMs, spans: t.spans }))
      },
      endgame: (() => {
        const pillars = dueDiligence(w);
        return {
          pillars,
          termSheetAccepted: Boolean(w.endgame?.termSheetAccepted),
          payout: w.endgame?.payout ?? null,
          scaleEventSurvived: Boolean(w.flags.scaleEventSurvived),
          legendMode: Boolean(w.flags.legendMode)
        };
      })(),
      architecture: { nodes, edges },
      packs: {
        available: availablePacks(),
        activated: state.packs ?? [],
        formatNote: 'Mission packs are JSON bundles (id, name, missions[] with declarative requirements over world state). Drop a pack in packs/ or POST it to the registry — the loader turns data into playable missions.'
      },
      challenge: (() => {
        const run = w.challenge;
        if (!run) return null;
        const def = challengeOf(run.id);
        if (!def) return null;
        const live = challengeLive(w);
        return {
          id: def.id,
          name: def.name,
          tagline: def.tagline,
          rule: def.rule,
          ruleLabel: def.ruleLabel,
          scoreLabel: def.scoreLabel,
          briefing: def.briefing,
          durationDays: def.durationDays,
          status: run.status,
          startedAtMin: run.startedAtMin,
          endsAtMin: run.startedAtMin + run.durationMin,
          minutesLeft: Math.max(0, run.startedAtMin + run.durationMin - w.nowMin),
          verdict: run.verdict ?? null,
          score: run.score ?? null,
          stars: run.status === 'passed' && run.score !== undefined ? challengeStars(def.rule, run.score, def) : null,
          days: run.days,
          live,
          rtoTargetMin: def.rtoTargetMin ?? null,
          availabilityFloorPct: def.availabilityFloorPct ?? null,
          challengesPassed: Number(w.flags.challengesPassed ?? 0)
        };
      })(),
      challengesCatalog: CHALLENGES.map((c) => ({ id: c.id, name: c.name, tagline: c.tagline, rule: c.rule, ruleLabel: c.ruleLabel, durationDays: c.durationDays })),
      tournament: w.tournament ? {
        points: w.tournament.points,
        roundsWon: w.tournament.roundsWon,
        rivals: w.tournament.rivals,
        finished: w.tournament.finished,
        place: w.tournament.place ?? null
      } : null,
      settings: {
        locale: typeof w.flags.locale === 'string' ? w.flags.locale : 'en',
        highContrast: Boolean(w.flags.a11yHighContrast),
        largeText: Boolean(w.flags.a11yLargeText),
        reducedMotion: Boolean(w.flags.a11yReducedMotion)
      },
      dns: { zone: `${w.company.slug}.dev`, records: Object.entries(w.dns[`${w.company.slug}.dev`] ?? {}).map(([name, r]) => ({ name, type: r.type, value: r.value, ttl: r.ttl })) },
      firewall: w.firewall,
      nginx: parseNginxSites(w.hosts['web-01']),
      lb: {
        provisioned: Boolean(w.lb?.provisioned),
        ip: w.lb?.ip ?? null,
        backends: lbBackends(w),
        haReady: haReady(w),
        drillUnderway: Boolean(w.flags.web01Down)
      },
      vms: Object.keys(w.hosts).filter((h) => h !== 'laptop').map((h) => ({ id: h, ip: w.hosts[h].ip, serving: hostServesApi(w, h) })),
      registryTags: w.registry.map((i) => i.repoTags[0]),
      agentInstalled: w.monitoring.agentInstalled,
      diskPct: Math.round(diskUsagePct(w) * 10) / 10,
      resolveTest: resolveHostname(w, `api.${w.company.slug}.dev`).kind
    };
  }
}
