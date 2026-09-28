// Kubernetes simulation: a managed cluster (k8s-01) the player provisions in
// the cloud console and drives with kubectl. Manifests are real YAML written
// in the editor; the cluster state (pods, rollouts, HPA) evolves in the tick.
import { World, K8sPod, OutLine } from '../types';
import { parseYaml } from './yaml';
import { readFile, resolvePath, getNode, listDir } from './fs';
import { hashStr } from './docker';

/** deterministic numeric hash for cosmetic values (cluster IPs, latencies) */
function numHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

const CLUSTER_IP = '203.0.113.30';
const LB_INGRESS_IP = '203.0.113.31'; // assigned to Services of type LoadBalancer

export function provisionCluster(world: World): { ok: boolean; message: string } {
  if (world.k8s?.provisioned) return { ok: false, message: 'cluster already provisioned' };
  world.k8s = {
    provisioned: true,
    name: 'k8s-01',
    version: 'v1.29.4+k3s1',
    ip: CLUSTER_IP,
    nodes: ['k8s-01-node-a', 'k8s-01-node-b', 'k8s-01-node-c'],
    deployments: {},
    services: {},
    ingresses: {},
    hpas: {},
    pods: [],
    nextPodSuffix: 1,
    zeroDowntimeProven: false
  };
  world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'cloud', text: 'Provisioned Kubernetes cluster k8s-01 (3 nodes, v1.29) — kubeconfig installed on web-01' });
  return { ok: true, message: 'cluster k8s-01 provisioned — kubectl is configured on web-01' };
}

/** Resize the managed node pool (2–4 nodes); pods on removed nodes get rescheduled. */
export function resizeNodePool(world: World, count: number): { ok: boolean; message: string } {
  const k = world.k8s;
  if (!k?.provisioned) return { ok: false, message: 'no cluster provisioned' };
  const n = Math.max(2, Math.min(4, Math.round(count)));
  if (n === k.nodes.length) return { ok: false, message: `pool already has ${n} nodes` };
  const before = k.nodes.length;
  if (n < k.nodes.length) {
    const removed = k.nodes.slice(n);
    k.nodes = k.nodes.slice(0, n);
    // the scheduler squeezes stranded pods onto the remaining nodes
    for (const pod of k.pods) {
      if (removed.includes(pod.node)) pod.node = k.nodes[pod.name.length % k.nodes.length];
    }
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'cloud', text: `Node pool resized ${before} → ${n} nodes (${removed.join(', ')} drained)` });
  } else {
    while (k.nodes.length < n) k.nodes.push(`k8s-01-node-${String.fromCharCode(97 + k.nodes.length)}`);
    world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'cloud', text: `Node pool grown ${before} → ${n} nodes` });
  }
  return { ok: true, message: `node pool now has ${n} nodes` };
}

/** Is the image resolvable from the registry or the local daemon? */
export function imageKnown(world: World, image: string): boolean {
  return world.registry.some((i) => i.repoTags.includes(image))
    || world.docker.images.some((i) => i.repoTags.includes(image));
}

/** Is the image signed (supply chain, P5a)? Registry copy wins. */
export function imageSigned(world: World, image: string): boolean {
  const reg = world.registry.find((i) => i.repoTags.includes(image));
  if (reg) return Boolean(reg.signed);
  const local = world.docker.images.find((i) => i.repoTags.includes(image));
  return Boolean(local?.signed);
}

/** Admission check used by every path that puts a new image on the cluster. */
function admissionAllows(world: World, image: string): { ok: boolean; reason?: string } {
  const k = world.k8s;
  if (k?.admissionPolicy?.rule === 'signed-images' && !imageSigned(world, image)) {
    world.flags.admissionBlocked = true;
    world.audit.push({ t: world.nowMin, actor: 'admission', kind: 'security', text: `ADMISSION DENIED: ${image} is not signed — the require-signed-images policy blocked the rollout` });
    return { ok: false, reason: `admission webhook "require-signed-images" denied the request: image ${image} is not signed (cosign sign it first)` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// Manifest parsing
// ------------------------------------------------------------------
export interface ParsedManifest {
  kind: string;
  name: string;
  doc: Record<string, unknown>;
}

export function parseManifests(text: string): { manifests: ParsedManifest[]; error?: string } {
  const docs = text.split(/^---+\s*$/m).map((d) => d.trim()).filter(Boolean);
  const manifests: ParsedManifest[] = [];
  for (const doc of docs) {
    const parsed = parseYaml(doc);
    if (parsed.error) return { manifests: [], error: `YAML error: ${parsed.error.message}` };
    const value = parsed.value as Record<string, unknown>;
    if (!value || typeof value !== 'object') return { manifests: [], error: 'manifest must be a YAML mapping' };
    const kind = String(value.kind ?? '');
    const meta = value.metadata as Record<string, unknown> | undefined;
    const name = String(meta?.name ?? '');
    if (!kind) return { manifests: [], error: 'manifest is missing "kind:"' };
    if (!name) return { manifests: [], error: `${kind} manifest is missing "metadata.name"` };
    manifests.push({ kind, name, doc: value });
  }
  return { manifests };
}

function readEnvFromDotEnv(world: World): Record<string, string> {
  const envFile = readFile(world.hosts['web-01'].fs, '/opt/app/.env') ?? '';
  const env: Record<string, string> = {};
  for (const l of envFile.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function podsFor(world: World, deployment: string): K8sPod[] {
  return (world.k8s?.pods ?? []).filter((p) => p.deployment === deployment && p.phase !== 'Terminating');
}

/** Count pods that actually answer traffic. */
export function readyPods(world: World, deployment: string): number {
  return podsFor(world, deployment).filter((p) => p.phase === 'Ready').length;
}

/** Does the cluster currently serve the API end-to-end (ready pods + exposed)? */
export function k8sServes(world: World): boolean {
  const k = world.k8s;
  if (!k?.provisioned) return false;
  for (const dep of Object.values(k.deployments)) {
    if (!dep.image.includes('api') && dep.name !== 'api') continue;
    if (readyPods(world, dep.name) >= 1) {
      const exposed = Object.values(k.services).some((s) => s.selector === dep.name && s.type === 'LoadBalancer')
        || Object.values(k.ingresses).some(() => true);
      if (exposed) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------
// kubectl apply
// ------------------------------------------------------------------
export function applyManifests(world: World, text: string): { lines: OutLine[]; ok: boolean } {
  const k = world.k8s;
  if (!k?.provisioned) return { lines: [{ text: 'error: no cluster configured — provision one in the CLOUD console', cls: 'err' }], ok: false };
  const { manifests, error } = parseManifests(text);
  if (error) return { lines: [{ text: `error: ${error}`, cls: 'err' }], ok: false };
  const lines: OutLine[] = [];
  let ok = true;
  for (const m of manifests) {
    try {
      lines.push(...applyOne(world, m));
    } catch (e) {
      lines.push({ text: `error: ${m.kind}/${m.name}: ${String((e as Error).message ?? e)}`, cls: 'err' });
      ok = false;
    }
  }
  return { lines, ok };
}

function applyOne(world: World, m: ParsedManifest): OutLine[] {
  const k = world.k8s!;
  const spec = (m.doc.spec ?? {}) as Record<string, unknown>;
  switch (m.kind) {
    case 'Deployment': {
      const template = (spec.template ?? {}) as Record<string, unknown>;
      const podSpec = (template.spec ?? {}) as Record<string, unknown>;
      const containers = Array.isArray(podSpec.containers) ? podSpec.containers as Record<string, unknown>[] : [];
      const c = containers[0];
      if (!c) throw new Error('pod template needs at least one container');
      const image = String(c.image ?? '');
      if (!image) throw new Error('container is missing "image:"');
      const ports = Array.isArray(c.ports) ? c.ports as Record<string, unknown>[] : [];
      const containerPort = Number(ports[0]?.containerPort ?? 8080);
      // securityContext.runAsNonRoot (P5a least privilege)
      const secCtx = (c.securityContext ?? {}) as Record<string, unknown>;
      const runAsNonRoot = secCtx.runAsNonRoot === true || secCtx.runAsNonRoot === 'true';
      const strategy = ((spec.strategy as Record<string, unknown>)?.type ?? 'RollingUpdate') === 'Recreate' ? 'Recreate' : 'RollingUpdate';
      const replicas = Number(spec.replicas ?? 1);
      const env = readEnvFromDotEnv(world);
      const manifestEnv = Array.isArray(c.env) ? c.env as Record<string, unknown>[] : [];
      for (const e of manifestEnv) if (e.name && e.value !== undefined) env[String(e.name)] = String(e.value);

      const existing = k.deployments[m.name];
      // admission control (P5a): the cluster refuses unsigned images once the policy is on
      if (existing && existing.image !== image) {
        const admit = admissionAllows(world, image);
        if (!admit.ok) throw new Error(admit.reason!);
        // rolling update: new revision; old pods retire as the new ones go Ready
        existing.history.push({ revision: existing.revision, image: existing.image, atMin: world.nowMin });
        existing.revision += 1;
        existing.image = image;
        existing.replicas = replicas;
        existing.strategy = strategy;
        existing.containerPort = containerPort;
        existing.readinessProbe = Boolean(c.readinessProbe);
        existing.livenessProbe = Boolean(c.livenessProbe);
        existing.runAsNonRoot = runAsNonRoot;
        existing.env = env;
        if (strategy === 'Recreate') {
          for (const p of podsFor(world, m.name)) p.phase = 'Terminating';
        }
        spawnMissingPods(world, m.name);
        world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Rollout started: ${m.name} → ${image} (revision ${existing.revision}, ${strategy})` });
        return [{ text: `deployment.apps/${m.name} image updated`, cls: 'ok' }];
      }
      if (existing) {
        existing.replicas = replicas;
        existing.runAsNonRoot = runAsNonRoot || Boolean(existing.runAsNonRoot);
        spawnMissingPods(world, m.name);
        return [{ text: `deployment.apps/${m.name} configured`, cls: 'ok' }];
      }
      k.deployments[m.name] = {
        name: m.name,
        image,
        replicas,
        readyReplicas: 0,
        revision: 1,
        strategy,
        containerPort,
        readinessProbe: Boolean(c.readinessProbe),
        livenessProbe: Boolean(c.livenessProbe),
        runAsNonRoot,
        env,
        history: [],
        createdAtMin: world.nowMin
      };
      spawnMissingPods(world, m.name);
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Deployment ${m.name} created (${replicas} replica(s), image ${image})` });
      return [{ text: `deployment.apps/${m.name} created`, cls: 'ok' }];
    }
    case 'Service': {
      const type = String(spec.type ?? 'ClusterIP') === 'LoadBalancer' ? 'LoadBalancer' : 'ClusterIP';
      const port = Number((Array.isArray(spec.ports) ? (spec.ports as Record<string, unknown>[])[0]?.port : undefined) ?? 80);
      const targetPort = Number((Array.isArray(spec.ports) ? (spec.ports as Record<string, unknown>[])[0]?.targetPort : undefined) ?? port);
      const selector = String(((spec.selector ?? {}) as Record<string, unknown>).app ?? m.name);
      const prev = k.services[m.name];
      k.services[m.name] = { name: m.name, type, port, targetPort, selector, ingressIp: prev?.ingressIp ?? (type === 'LoadBalancer' ? LB_INGRESS_IP : undefined) };
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Service ${m.name} (${type}) → ${selector}:${targetPort}${type === 'LoadBalancer' ? ` — external IP ${LB_INGRESS_IP} registered with lb-01` : ''}` });
      return [{ text: `service/${m.name} ${prev ? 'configured' : 'created'}${type === 'LoadBalancer' ? ` — external IP: ${LB_INGRESS_IP}` : ''}`, cls: 'ok' }];
    }
    case 'Ingress': {
      const rules = Array.isArray(spec.rules) ? spec.rules as Record<string, unknown>[] : [];
      const ruleHttp = (rules[0]?.http ?? {}) as Record<string, unknown>;
      const paths = Array.isArray(ruleHttp.paths) ? ruleHttp.paths as Record<string, unknown>[] : [];
      const backend = (paths[0]?.backend ?? {}) as Record<string, unknown>;
      const svc = (backend.service ?? {}) as Record<string, unknown>;
      const service = String(svc.name ?? backend.serviceName ?? '');
      const host = String(rules[0]?.host ?? '');
      if (!service) throw new Error('ingress rule needs a backend service');
      const servicePort = Number((svc.port as Record<string, unknown> | undefined)?.number ?? svc.port ?? backend.servicePort ?? 80);
      k.ingresses[m.name] = { name: m.name, host, path: String(paths[0]?.path ?? '/'), service, servicePort };
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Ingress ${m.name}: ${host || '*'} → ${service}` });
      return [{ text: `ingress.networking.k8s.io/${m.name} created`, cls: 'ok' }];
    }
    case 'HorizontalPodAutoscaler': {
      const scaleTarget = (spec.scaleTargetRef ?? {}) as Record<string, unknown>;
      const deployment = String(scaleTarget.name ?? '');
      if (!deployment || !k.deployments[deployment]) throw new Error(`scaleTargetRef ${deployment || '(missing)'}: no such deployment`);
      const hpa = {
        name: m.name,
        deployment,
        minReplicas: Number(spec.minReplicas ?? 1),
        maxReplicas: Number(spec.maxReplicas ?? 4),
        targetCpuPct: 70,
        currentReplicas: k.deployments[deployment].replicas
      };
      k.hpas[m.name] = hpa;
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `HPA ${m.name}: ${deployment} ${hpa.minReplicas}..${hpa.maxReplicas} replicas (target CPU ${hpa.targetCpuPct}%)` });
      return [{ text: `horizontalpodautoscaler.autoscaling/${m.name} created`, cls: 'ok' }];
    }
    case 'NetworkPolicy': {
      // P5a zero trust: a default-deny policy selects every pod and allows
      // nothing; an allow policy permits explicit (selector, port) pairs.
      if (!k.networkPolicies) k.networkPolicies = {};
      const podSelector = (spec.podSelector ?? {}) as Record<string, unknown>;
      const matchLabels = (podSelector.matchLabels ?? {}) as Record<string, unknown>;
      const selectorKeys = Object.keys(matchLabels);
      const ingressRules = Array.isArray(spec.ingress) ? spec.ingress as Record<string, unknown>[] : [];
      const allows: { fromSelector: string; port: number }[] = [];
      for (const rule of ingressRules) {
        const from = Array.isArray(rule.from) ? rule.from as Record<string, unknown>[] : [];
        const ports = Array.isArray(rule.ports) ? rule.ports as Record<string, unknown>[] : [];
        for (const f of from) {
          const fSel = ((f.podSelector ?? {}) as Record<string, unknown>).matchLabels as Record<string, unknown> | undefined;
          const fromSel = fSel ? Object.entries(fSel).map(([kk, vv]) => `${kk}=${vv}`).join(',') : '*';
          const port = ports.length ? Number((ports[0].port as number | undefined) ?? 80) : 0;
          allows.push({ fromSelector: fromSel, port });
        }
      }
      const defaultDeny = selectorKeys.length === 0 && allows.length === 0;
      k.networkPolicies[m.name] = { name: m.name, defaultDeny, allows };
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `NetworkPolicy ${m.name}: ${defaultDeny ? 'default-deny (all ingress blocked unless explicitly allowed)' : allows.map((a) => `allow ${a.fromSelector} → :${a.port}`).join(', ')}` });
      return [{ text: `networkpolicy.networking.k8s.io/${m.name} created`, cls: 'ok' }];
    }
    case 'Policy': {
      // P5a admission control: require signed images cluster-wide.
      const requireSigned = spec.requireSignedImages === true || spec.requireSignedImages === 'true'
        || /signed/i.test(JSON.stringify(spec));
      if (!requireSigned) throw new Error('policy must set spec.requireSignedImages: true');
      k.admissionPolicy = { rule: 'signed-images', name: m.name, appliedAtMin: world.nowMin };
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'security', text: `Admission policy applied: ${m.name} — unsigned images can no longer be deployed to the cluster` });
      return [{ text: `policy.shipit.dev/${m.name} created (admission: require-signed-images)`, cls: 'ok' }];
    }
    default:
      throw new Error(`cannot handle object kind ${m.kind} (supported: Deployment, Service, Ingress, HorizontalPodAutoscaler, NetworkPolicy, Policy)`);
  }
}

function spawnMissingPods(world: World, deployment?: string): void {
  const k = world.k8s!;
  for (const dep of Object.values(k.deployments)) {
    if (deployment && dep.name !== deployment) continue;
    // rolling-update surge: the desired count is pods of the CURRENT revision;
    // older-revision pods retire once the new ones are Ready
    const current = podsFor(world, dep.name).filter((p) => p.revision === dep.revision);
    for (let i = current.length; i < dep.replicas; i++) {
      const suffix = hashStr(dep.name + k.nextPodSuffix).slice(0, 5);
      k.nextPodSuffix++;
      k.pods.push({
        name: `${dep.name}-${dep.revision}-${suffix}`,
        deployment: dep.name,
        node: k.nodes[k.nextPodSuffix % k.nodes.length],
        phase: 'Pending',
        ready: false,
        restarts: 0,
        image: dep.image,
        startedAtMin: world.nowMin,
        revision: dep.revision
      });
    }
  }
}

// ------------------------------------------------------------------
// Cluster tick — pod lifecycle, rollouts, HPA
// ------------------------------------------------------------------
export function tickK8s(world: World, reqRate: number): void {
  const k = world.k8s;
  if (!k?.provisioned) return;

  // pods marked Terminating last tick are gone now
  k.pods = k.pods.filter((p) => p.phase !== 'Terminating');

  // pod lifecycle
  for (const p of k.pods) {
    if (p.phase === 'Pending') {
      if (!imageKnown(world, p.image)) {
        p.phase = 'CrashLoopBackOff';
        p.restarts++;
        continue;
      }
      if (world.nowMin - p.startedAtMin >= 1) p.phase = 'Running';
    }
    if (p.phase === 'Running' && world.nowMin - p.startedAtMin >= 3) {
      p.phase = 'Ready';
      p.ready = true;
    }
  }

  // rollout completion: when pods of the current revision are Ready, retire older ones
  for (const dep of Object.values(k.deployments)) {
    const current = podsFor(world, dep.name).filter((p) => p.revision === dep.revision);
    const currentReady = current.filter((p) => p.phase === 'Ready').length;
    dep.readyReplicas = currentReady;
    const older = podsFor(world, dep.name).filter((p) => p.revision < dep.revision && p.phase !== 'Terminating');
    if (currentReady >= 1 && older.length) {
      for (const p of older) p.phase = 'Terminating';
      if (dep.strategy === 'RollingUpdate' && dep.revision > 1) {
        k.zeroDowntimeProven = true;
      }
      world.audit.push({ t: world.nowMin, actor: 'k8s', kind: 'k8s', text: `Rollout complete: ${dep.name} revision ${dep.revision} (${currentReady}/${dep.replicas} ready)` });
    }
    if (current.length < dep.replicas) spawnMissingPods(world, dep.name);
    if (current.length > dep.replicas) {
      // scale down: retire ready pods beyond the desired count
      for (const p of current.filter((p) => p.phase === 'Ready').slice(dep.replicas)) p.phase = 'Terminating';
    }
  }

  // HPA evaluation every 5 sim minutes
  if (world.nowMin % 5 === 0) {
    for (const hpa of Object.values(k.hpas)) {
      const dep = k.deployments[hpa.deployment];
      if (!dep) continue;
      // rough load model: each pod comfortably handles ~60 req/s at target CPU
      const desired = Math.max(hpa.minReplicas, Math.min(hpa.maxReplicas, Math.ceil(reqRate / 60)));
      if (desired !== dep.replicas) {
        const up = desired > dep.replicas;
        dep.replicas = desired;
        hpa.currentReplicas = desired;
        world.audit.push({ t: world.nowMin, actor: 'hpa', kind: 'k8s', text: `HPA ${hpa.name}: ${dep.name} scaled ${up ? 'up' : 'down'} to ${desired} replica(s) (load ${Math.round(reqRate)} req/s, target CPU ${hpa.targetCpuPct}%)` });
      }
      if (desired > hpa.minReplicas) hpa.peakedAtMin = world.nowMin;
      spawnMissingPods(world, dep.name);
    }
  }

  // the cluster becomes the primary serving platform once it serves the API
  if (k8sServes(world) && world.app.mode !== 'stopped') {
    const dep = Object.values(k.deployments).find((d) => readyPods(world, d.name) >= 1);
    if (dep) {
      world.app = {
        ...world.app,
        mode: 'k8s',
        image: dep.image,
        version: dep.image.split(':').pop() ?? world.app.version,
        env: dep.env,
        uptimeSinceMin: world.app.mode === 'k8s' ? world.app.uptimeSinceMin : world.nowMin
      };
    }
  }
}

// ------------------------------------------------------------------
// kubectl command engine (called from the terminal)
// ------------------------------------------------------------------
export interface KubectlResult { lines: OutLine[]; code: number }

export function kubectlCmd(world: World, argv: string[]): KubectlResult {
  const k = world.k8s;
  if (!k?.provisioned) {
    return { lines: [{ text: 'kubectl: no cluster configured — provision Kubernetes in the CLOUD console first', cls: 'err' }], code: 1 };
  }
  const sub = argv[1];
  const e = (t: string): KubectlResult => ({ lines: [{ text: t, cls: 'err' }], code: 1 });

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      return {
        lines: [
          { text: 'kubectl — control the cluster (simulated)', cls: 'hdr' },
          { text: 'apply -f <file|dir>     create/update resources from YAML' },
          { text: 'get pods|deploy|svc|ingress|hpa|netpol|policy|nodes' },
          { text: 'describe pod <name> | deployment <name>' },
          { text: 'scale deployment/<name> --replicas=N' },
          { text: 'autoscale deployment/<name> --min=N --max=N --cpu-percent=P' },
          { text: 'set image deployment/<name> <container>=<image>' },
          { text: 'rollout status|history|undo deployment/<name>' },
          { text: 'logs deployment/<name>' }
        ], code: 0
      };
    case 'version':
      return { lines: [{ text: `Client Version: v1.29.4`, cls: 'dim' }, { text: `Server Version: v1.29.4 (${k.name})` }], code: 0 };
    case 'apply': {
      const fIdx = argv.indexOf('-f');
      const target = fIdx >= 0 ? argv[fIdx + 1] : undefined;
      if (!target) return e('error: no file passed with -f');
      const text = readManifestText(world, target);
      if (text === null) return e(`error: the path "${target}" does not exist`);
      const res = applyManifests(world, text);
      return { lines: res.lines, code: res.ok ? 0 : 1 };
    }
    case 'get': {
      const what = (argv[2] ?? '').toLowerCase();
      return { lines: getTable(world, what), code: 0 };
    }
    case 'describe': {
      const kind = (argv[2] ?? '').toLowerCase();
      const name = argv[3];
      const lines = describe(world, kind, name);
      return lines ? { lines, code: 0 } : e(kind === 'pod' ? `Error from server (NotFound): pods "${name}" not found` : `Error from server (NotFound): ${kind} "${name}" not found`);
    }
    case 'scale': {
      const target = argv[2] ?? '';
      const m = /^deployment[s]?\/(\S+)$/.exec(target);
      if (!m) return e('usage: kubectl scale deployment/<name> --replicas=N');
      const dep = k.deployments[m[1]];
      if (!dep) return e(`Error from server (NotFound): deployments.apps "${m[1]}" not found`);
      const n = Number(flagValue(argv, '--replicas') ?? NaN);
      if (!Number.isFinite(n) || n < 0) return e('usage: kubectl scale deployment/<name> --replicas=N');
      dep.replicas = n;
      spawnMissingPods(world, dep.name);
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `${dep.name} manually scaled to ${n} replicas` });
      return { lines: [{ text: `deployment.apps/${dep.name} scaled`, cls: 'ok' }], code: 0 };
    }
    case 'autoscale': {
      const m = /^deployment[s]?\/(\S+)$/.exec(argv[2] ?? '');
      if (!m) return e('usage: kubectl autoscale deployment/<name> --min=N --max=N --cpu-percent=P');
      const dep = k.deployments[m[1]];
      if (!dep) return e(`Error from server (NotFound): deployments.apps "${m[1]}" not found`);
      const min = Number(flagValue(argv, '--min') ?? 1);
      const max = Number(flagValue(argv, '--max') ?? 4);
      const cpu = Number(flagValue(argv, '--cpu-percent') ?? 70);
      if (!(min >= 1 && max >= min)) return e('autoscale needs --min >= 1 and --max >= min');
      k.hpas[dep.name] = { name: dep.name, deployment: dep.name, minReplicas: min, maxReplicas: max, targetCpuPct: cpu, currentReplicas: dep.replicas };
      dep.replicas = Math.max(dep.replicas, min);
      spawnMissingPods(world, dep.name);
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `HPA created: ${dep.name} ${min}..${max} replicas (target CPU ${cpu}%)` });
      return { lines: [{ text: `horizontalpodautoscaler.autoscaling/${dep.name} autoscaled`, cls: 'ok' }], code: 0 };
    }
    case 'set': {
      if (argv[2] !== 'image') return e('usage: kubectl set image deployment/<name> <container>=<image>');
      const m = /^deployment[s]?\/(\S+)$/.exec(argv[3] ?? '');
      if (!m) return e('usage: kubectl set image deployment/<name> <container>=<image>');
      const dep = k.deployments[m[1]];
      if (!dep) return e(`Error from server (NotFound): deployments.apps "${m[1]}" not found`);
      const pair = /^(\S+)=(\S+)$/.exec(argv[4] ?? '');
      if (!pair) return e('expected CONTAINER=IMAGE');
      const admit = admissionAllows(world, pair[2]);
      if (!admit.ok) return e(`Error from server (Forbidden): ${admit.reason}`);
      dep.history.push({ revision: dep.revision, image: dep.image, atMin: world.nowMin });
      dep.revision += 1;
      dep.image = pair[2];
      if (dep.strategy === 'Recreate') for (const p of podsFor(world, dep.name)) p.phase = 'Terminating';
      spawnMissingPods(world, dep.name);
      world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Rollout started: ${dep.name} → ${pair[2]} (revision ${dep.revision})` });
      return { lines: [{ text: `deployment.apps/${dep.name} image updated` }], code: 0 };
    }
    case 'rollout': {
      const action = argv[2];
      const m = /^deployment[s]?\/(\S+)$/.exec(argv[3] ?? '');
      const dep = m ? k.deployments[m[1]] : undefined;
      if (action === 'status') {
        if (!dep) return e(`Error from server (NotFound): deployments.apps "${m?.[1] ?? '?'}" not found`);
        const ready = readyPods(world, dep.name);
        if (ready >= dep.replicas && podsFor(world, dep.name).every((p) => p.revision === dep.revision)) {
          return { lines: [{ text: `deployment "${dep.name}" successfully rolled out`, cls: 'ok' }], code: 0 };
        }
        return { lines: [{ text: `Waiting for deployment "${dep.name}" rollout to finish: ${ready}/${dep.replicas} replicas updated…`, cls: 'warn' }], code: 0 };
      }
      if (action === 'history') {
        if (!dep) return e(`Error from server (NotFound): deployments.apps "${m?.[1] ?? '?'}" not found`);
        const lines: OutLine[] = [{ text: `deployment.apps/${dep.name}`, cls: 'hdr' }];
        const all = [...dep.history.map((h) => ({ ...h })), { revision: dep.revision, image: dep.image, atMin: world.nowMin }];
        for (const h of all) lines.push({ text: `${h.revision}${h.revision === dep.revision ? ' *' : '  '}   image: ${h.image}` });
        return { lines, code: 0 };
      }
      if (action === 'undo') {
        if (!dep) return e(`Error from server (NotFound): deployments.apps "${m?.[1] ?? '?'}" not found`);
        const prev = dep.history[dep.history.length - 1];
        if (!prev) return e('error: no rollout history to roll back to');
        dep.history.pop();
        const target = prev.image;
        dep.history.push({ revision: dep.revision, image: dep.image, atMin: world.nowMin });
        dep.revision += 1;
        dep.image = target;
        spawnMissingPods(world, dep.name);
        world.audit.push({ t: world.nowMin, actor: world.session.user, kind: 'k8s', text: `Rollback: ${dep.name} → ${target} (revision ${dep.revision})` });
        return { lines: [{ text: `deployment.apps/${dep.name} rolled back (now ${target})`, cls: 'ok' }], code: 0 };
      }
      return e(`unknown rollout action "${action}" (status | history | undo)`);
    }
    case 'logs': {
      const m = /^deployment[s]?\/(\S+)$/.exec(argv[2] ?? '');
      const dep = m ? k.deployments[m[1]] : Object.values(k.deployments)[0];
      if (!dep) return e('error: no deployment specified or found');
      const pod = podsFor(world, dep.name).find((p) => p.phase === 'Ready') ?? podsFor(world, dep.name)[0];
      if (!pod) return e(`error: no pods found for deployment ${dep.name}`);
      const lines: OutLine[] = [
        { text: `[${pod.name}] listening on :${dep.containerPort}` },
        { text: `[${pod.name}] connected to database (${dep.env.DATABASE_URL ? 'postgres' : 'sqlite'})` },
        { text: `[${pod.name}] GET /health 200 3ms` },
        { text: `[${pod.name}] GET /api/orders 200 ${40 + (numHash(pod.name) % 60)}ms` }
      ];
      return { lines, code: 0 };
    }
    case 'delete':
      return e('delete: retire workloads by applying a new manifest (or scale to 0) — teardown arrives later');
    default:
      return e(`unknown command "${sub ?? ''}" — try kubectl help`);
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + '='));
  return inline ? inline.slice(name.length + 1) : undefined;
}

/** Read a manifest file or every .yaml/.yml in a directory. */
function readManifestText(world: World, target: string): string | null {
  const host = world.hosts[world.session.hostId] ?? world.hosts['web-01'];
  const abs = resolvePath(world.session.cwd, target);
  const node = getNode(host.fs, abs);
  if (!node) return null;
  if (node.type === 'file') return node.content;
  const parts: string[] = [];
  for (const { name, node: child } of listDir(node, '') ?? []) {
    if (child.type === 'file' && /\.(ya?ml)$/.test(name)) {
      parts.push(`# ${name}\n${child.content}`);
    }
  }
  return parts.length ? parts.join('\n---\n') : null;
}

function getTable(world: World, what: string): OutLine[] {
  const k = world.k8s!;
  const age = (min: number) => {
    const d = Math.floor((world.nowMin - min) / 1440);
    const h = Math.floor(((world.nowMin - min) % 1440) / 60);
    const m = (world.nowMin - min) % 60;
    return d > 0 ? `${d}d` : h > 0 ? `${h}h` : `${m}m`;
  };
  if (what === 'pods' || what === 'pod' || what === 'po') {
    const lines: OutLine[] = [{ text: 'NAME                       READY   STATUS              RESTARTS   AGE', cls: 'hdr' }];
    for (const p of k.pods) {
      lines.push({ text: `${p.name.padEnd(26)} ${p.phase === 'Ready' ? '1/1' : '0/1'}     ${p.phase.padEnd(19)} ${String(p.restarts).padEnd(10)} ${age(p.startedAtMin)}`, cls: p.phase === 'CrashLoopBackOff' ? 'err' : undefined });
    }
    if (!k.pods.length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'deployments' || what === 'deployment' || what === 'deploy') {
    const lines: OutLine[] = [{ text: 'NAME   READY   UP-TO-DATE   AVAILABLE   IMAGE', cls: 'hdr' }];
    for (const d of Object.values(k.deployments)) {
      lines.push({ text: `${d.name.padEnd(6)} ${d.readyReplicas}/${d.replicas}     ${podsFor(world, d.name).filter((p) => p.revision === d.revision).length}            ${d.readyReplicas}           ${d.image}` });
    }
    if (!Object.keys(k.deployments).length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'services' || what === 'service' || what === 'svc') {
    const lines: OutLine[] = [{ text: 'NAME   TYPE           CLUSTER-IP     EXTERNAL-IP   PORT(S)        SELECTOR', cls: 'hdr' }];
    for (const s of Object.values(k.services)) {
      lines.push({ text: `${s.name.padEnd(6)} ${s.type.padEnd(14)} 10.43.${(numHash(s.name) % 200) + 10}.12   ${(s.ingressIp ?? 'none').padEnd(13)} ${String(s.port).padEnd(14)} app=${s.selector}` });
    }
    if (!Object.keys(k.services).length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'ingress' || what === 'ing') {
    const lines: OutLine[] = [{ text: 'NAME   CLASS   HOSTS   ADDRESS   PATHS', cls: 'hdr' }];
    for (const i of Object.values(k.ingresses)) {
      lines.push({ text: `${i.name.padEnd(6)} nginx   ${i.host || '*'}   ${k.ip}   ${i.path} → ${i.service}:${i.servicePort}` });
    }
    if (!Object.keys(k.ingresses).length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'hpa' || what === 'horizontalpodautoscalers') {
    const lines: OutLine[] = [{ text: 'NAME   REFERENCE             TARGETS   MINPODS   MAXPODS   REPLICAS', cls: 'hdr' }];
    for (const h of Object.values(k.hpas)) {
      const dep = k.deployments[h.deployment];
      lines.push({ text: `${h.name.padEnd(6)} Deployment/${h.deployment.padEnd(15)} ${Math.round(30 + (world.monitoring.series.cpu_pct?.at(-1)?.v ?? 40))}%/70%   ${h.minReplicas}         ${h.maxReplicas}         ${dep?.replicas ?? '-'}` });
    }
    if (!Object.keys(k.hpas).length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'nodes' || what === 'node' || what === 'no') {
    const lines: OutLine[] = [{ text: 'NAME             STATUS   ROLES                  AGE   VERSION', cls: 'hdr' }];
    for (const n of k.nodes) lines.push({ text: `${n.padEnd(17)} Ready    control-plane,worker   ${age(world.createdAtMin)}   v1.29.4` });
    return lines;
  }
  if (what === 'netpol' || what === 'networkpolicies' || what === 'networkpolicy') {
    const lines: OutLine[] = [{ text: 'NAME             POD-SELECTOR   RULES', cls: 'hdr' }];
    for (const p of Object.values(k.networkPolicies ?? {})) {
      lines.push({ text: `${p.name.padEnd(17)} ${p.defaultDeny ? '<none>' : '<target>'}       ${p.defaultDeny ? 'deny-all ingress' : p.allows.map((a) => `allow ${a.fromSelector || '*'} :${a.port}`).join(', ')}` });
    }
    if (!Object.keys(k.networkPolicies ?? {}).length) lines.push({ text: 'No resources found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'policy' || what === 'policies') {
    const lines: OutLine[] = [{ text: 'NAME                    RULE', cls: 'hdr' }];
    if (k.admissionPolicy) lines.push({ text: `${k.admissionPolicy.name.padEnd(24)} require-signed-images` });
    else lines.push({ text: 'No admission policies found in default namespace.', cls: 'dim' });
    return lines;
  }
  if (what === 'all') {
    return [...getTable(world, 'deployments'), ...getTable(world, 'pods'), ...getTable(world, 'services')];
  }
  return [{ text: `error: the server doesn't have a resource type "${what}"`, cls: 'err' }];
}

function describe(world: World, kind: string, name?: string): OutLine[] | null {
  const k = world.k8s!;
  if (kind === 'pod' || kind === 'po') {
    const pod = k.pods.find((p) => p.name === name);
    if (!pod) return null;
    const lines: OutLine[] = [
      { text: `Name:         ${pod.name}`, cls: 'hdr' },
      { text: `Node:         ${pod.node}` },
      { text: `Status:       ${pod.phase}` },
      { text: `Restarts:     ${pod.restarts}` },
      { text: `Image:        ${pod.image}` }
    ];
    if (pod.phase === 'CrashLoopBackOff') {
      lines.push({ text: '', cls: undefined }, { text: 'Events:', cls: 'hdr' }, { text: '  Back-off pulling image — check the tag exists in the registry', cls: 'err' });
    }
    return lines;
  }
  if (kind === 'deployment' || kind === 'deployments' || kind === 'deploy') {
    const dep = k.deployments[name ?? ''];
    if (!dep) return null;
    return [
      { text: `Name:       ${dep.name}`, cls: 'hdr' },
      { text: `Image:      ${dep.image}` },
      { text: `Replicas:   ${dep.readyReplicas}/${dep.replicas} ready` },
      { text: `Strategy:   ${dep.strategy}` },
      { text: `Probes:     readiness=${dep.readinessProbe ? 'yes' : 'NO'} liveness=${dep.livenessProbe ? 'yes' : 'NO'}` },
      { text: `Security:   runAsNonRoot=${dep.runAsNonRoot ? 'yes' : 'NO'}` },
      { text: `Revision:   ${dep.revision} (history: ${dep.history.length})` }
    ];
  }
  return null;
}
