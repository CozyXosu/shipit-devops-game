// REST API — the only bridge between the React client and the simulated world.
import { Router, Request, Response } from 'express';
import { GameState, OutLine } from './types';
import { Storage } from './state';
import { createWorld, tick, audit, costLineItems, monthlyInfraCost, uptimePct, addDnsRecord, allowPort, provisionDb, resizeDb, runMigrations, resizeDisk, installMonitoringAgent, addAlertRule, removeAlertRule, filePostmortem, latest, diskUsagePct, provisionVm, deployToVm, provisionLb, haReady } from './world';
import { runTerminalInput } from './sim/host';
import { resolveHostname, parseNginxSites, lbBackends, hostServesApi } from './sim/net';
import { runPipeline, rollback } from './sim/ci';
import { runSql } from './sim/dbsim';
import { getFile, writeFile, resolvePath, getNode, listDir, nodeSizeMB } from './sim/fs';
import { currentMission, evalRequirements, evaluateMissions, takeHint, fillTemplate, commandsRun, allMissionSummaries } from './engine';
import { status as gitStatus } from './sim/git';
import { randomUUID } from 'crypto';

export function createApi(storage: Storage): Router {
  const api = Router();

  // ---- game lifecycle ----
  api.post('/games', (req: Request, res: Response) => {
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
    storage.save(state);
    res.json({ id: state.id });
  });

  api.get('/games', (_req, res) => res.json(storage.list()));

  api.delete('/games/:id', (req, res) => {
    res.json({ deleted: storage.delete(req.params.id) });
  });

  // ---- main view-model ----
  api.get('/games/:id', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    evaluateMissions(state); // time-based requirements complete on poll
    storage.save(state);
    res.json(view(state));
  });

  // ---- terminal ----
  api.post('/games/:id/terminal', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const input = String(req.body?.input ?? '').slice(0, 2000);
    if (input) state.world.session.history.push(input);
    commandsRun(state);
    const out: { lines: OutLine[] } = runTerminalInput(state.world, input);
    evaluateMissions(state);
    storage.save(state);
    res.json({ ...out, session: sessionView(state) });
  });

  // ---- filesystem / editor ----
  api.get('/games/:id/fs', (req, res) => {
    const state = storage.load(req.params.id);
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

  api.get('/games/:id/file', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const f = getFile(state.world.hosts['web-01'].fs, String(req.query.path ?? ''));
    if (!f || f.type !== 'file') return res.status(404).json({ error: 'file not found' });
    res.json({ path: req.query.path, content: f.content, owner: f.owner, mode: f.mode.toString(8) });
  });

  api.put('/games/:id/file', (req, res) => {
    const state = storage.load(req.params.id);
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
    storage.save(state);
    res.json({ ok: true, warnings });
  });

  // ---- missions ----
  api.post('/games/:id/mission/hint', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = takeHint(state);
    storage.save(state);
    res.json(result ?? { hint: null, index: -1, remaining: 0 });
  });

  // ---- CI ----
  api.post('/games/:id/ci/run', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const pipelinePath = String(req.body?.pipeline ?? '.ci/pipeline.yml');
    const run = runPipeline(state.world, pipelinePath);
    evaluateMissions(state);
    storage.save(state);
    res.json({ run });
  });

  api.post('/games/:id/deployments/:depId/rollback', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const active = state.world.ci.deployments.find((d) => d.id === req.params.depId);
    const result = rollback(state.world, active?.service ?? 'api');
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  // ---- database ----
  api.post('/games/:id/db/query', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const sql = String(req.body?.sql ?? '').slice(0, 4000);
    const result = runSql(state.world, sql);
    storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/db/migrate', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = runMigrations(state.world);
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  // ---- cloud console ----
  api.post('/games/:id/cloud/dns', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { name, type, value, ttl } = req.body ?? {};
    const r = addDnsRecord(state.world, String(name ?? ''), String(type ?? 'A'), String(value ?? ''), Number(ttl ?? 300));
    evaluateMissions(state);
    storage.save(state);
    res.json(r);
  });

  api.post('/games/:id/cloud/firewall', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    allowPort(state.world, Number(req.body?.port ?? 0));
    evaluateMissions(state);
    storage.save(state);
    res.json({ ok: true, firewall: state.world.firewall });
  });

  api.post('/games/:id/cloud/db', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const plan = req.body?.plan ?? 'db.small';
    if (state.world.db.provisioned) resizeDb(state.world, plan);
    else provisionDb(state.world, plan);
    evaluateMissions(state);
    storage.save(state);
    res.json({ ok: true, db: state.world.db });
  });

  api.post('/games/:id/cloud/disk', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    resizeDisk(state.world, Math.max(40, Math.min(200, Number(req.body?.gb ?? 40))));
    evaluateMissions(state);
    storage.save(state);
    res.json({ ok: true });
  });

  api.post('/games/:id/cloud/agent', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    installMonitoringAgent(state.world);
    evaluateMissions(state);
    storage.save(state);
    res.json({ ok: true });
  });

  // ---- cloud: HA (second VM + load balancer) ----
  api.post('/games/:id/cloud/vm', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = provisionVm(state.world);
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/vm/:hostId/deploy', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = deployToVm(state.world, req.params.hostId ?? 'vm-02');
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  api.post('/games/:id/cloud/lb', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const result = provisionLb(state.world);
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  // ---- monitoring ----
  api.post('/games/:id/alerts', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { metric, op, threshold } = req.body ?? {};
    const rule = addAlertRule(state.world, String(metric ?? 'error_pct'), op ?? '>', Number(threshold ?? 2));
    evaluateMissions(state);
    storage.save(state);
    res.json({ ok: true, rule });
  });

  api.delete('/games/:id/alerts/:alertId', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    removeAlertRule(state.world, req.params.alertId);
    storage.save(state);
    res.json({ ok: true });
  });

  // ---- postmortems ----
  api.post('/games/:id/incidents/:incId/postmortem', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const actions = Array.isArray(req.body?.actions) ? req.body.actions.map(String) : [];
    const result = filePostmortem(state.world, req.params.incId, actions);
    evaluateMissions(state);
    storage.save(state);
    res.json(result);
  });

  // ---- time ----
  api.post('/games/:id/time', (req, res) => {
    const state = storage.load(req.params.id);
    if (!state) return res.status(404).json({ error: 'game not found' });
    const { paused, speed } = req.body ?? {};
    if (paused !== undefined) state.world.flags.paused = Boolean(paused);
    if (speed !== undefined) state.world.flags.speed = Math.max(0, Math.min(16, Number(speed)));
    storage.save(state);
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
        } : null
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
      costs: { lineItems: costLineItems(w), monthlyTotal: monthlyInfraCost(w), payroll: w.economy.payrollMonthly },
      audit: w.audit.slice(-80).reverse(),
      hosts: Object.values(w.hosts).map((h) => ({ id: h.id, ip: h.ip, label: h.label, os: h.os })),
      session: sessionView(state),
      git: gitInfo,
      docker: {
        images: w.docker.images.map((i) => ({ tag: i.repoTags[0], sizeMB: i.sizeMB, user: i.user ?? 'root', healthcheck: Boolean(i.healthcheck), layers: i.layers.length })),
        containers: w.docker.containers.map((c) => ({ name: c.name, image: c.image, status: c.status, healthy: c.healthy, port: c.hostPort })),
        registry: w.registry.map((i) => ({ tag: i.repoTags[0], sizeMB: i.sizeMB }))
      },
      ci: {
        runs: w.ci.runs.slice(-6).reverse(),
        deployments: w.ci.deployments.slice(-8).reverse()
      },
      db: {
        provisioned: w.db.provisioned, plan: w.db.plan, endpoint: w.db.endpoint,
        cpu: w.db.cpuPct, connections: w.db.connections, migrationsDone: w.db.migrationsDone,
        tables: Object.values(w.db.tables).map((t) => ({ name: t.name, rows: t.rowCount, indexes: t.indexes.map((i) => `${i.name}(${i.columns.join(',')})`) }))
      },
      architecture: { nodes, edges },
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
