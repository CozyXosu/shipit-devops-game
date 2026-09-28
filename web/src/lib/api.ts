// Typed API client for the SHIP IT backend.

export interface OutLine { text: string; cls?: 'err' | 'ok' | 'dim' | 'hdr' | 'warn' }

export interface GameSummary { id: string; name: string; day: number; updatedAt: number }

export interface ReqResult { id: string; label: string; pass: boolean }
export interface LessonView {
  intro: string;
  syntax?: { term: string; text: string }[];
  examples?: { label: string; code: string }[];
  where?: string;
  starter?: { path: string; content: string };
}

export interface SolveStep { kind: 'cmd' | 'write' | 'action' | 'wait' | 'note'; label: string; detail?: string; output?: string; minutes?: number }

export interface SolveResult {
  ok: boolean;
  missionId: string;
  missionTitle: string;
  completed: boolean;
  steps: SolveStep[];
  requirements: ReqResult[];
  message?: string;
}

export interface GameView {
  id: string;
  day: number;
  time: string;
  paused: boolean;
  speed: number;
  company: {
    name: string; slug: string; founder: string; cash: number; users: number;
    satisfaction: number; launched: boolean; product: string; domain: string;
    uptime: number; monthlyInfra: number;
  };
  skills: Record<string, number>;
  xp: number;
  missions: {
    summaries: { id: string; index: number; title: string; phase: string; status: string; rating: string | null; skills: string[] }[];
    completed: string[];
    phaseComplete: boolean;
    current: {
      id: string; title: string; story: string; objective: string; coaching: string;
      skills: string[]; hintsUsed: number; hintsTotal: number; requirements: ReqResult[];
      lesson: LessonView | null;
    } | null;
    pack: {
      id: string; title: string; story: string; objective: string; coaching: string;
      skills: string[]; hintsUsed: number; hintsTotal: number; requirements: ReqResult[];
      progress: { round: number; of: number; packName: string } | null;
    } | null;
  };
  metrics: {
    latest: Record<string, number>;
    series: Record<string, number[]>;
  };
  alerts: { id: string; metric: string; label: string; op: string; threshold: number; state: string }[];
  incidents: {
    id: string; kind: string; title: string; symptom: string; severity: string;
    status: string; openedAtMin: number; resolvedAtMin?: number;
    rootCause: string; customerImpact: string; detectedBy: string;
    timeline: { t: number; actor: string; text: string }[];
    corrective: { id: string; label: string; done: boolean }[];
    postmortemFiled: boolean;
  }[];
  openIncident: unknown;
  costs: { lineItems: { category: string; label: string; monthlyCost: number; provider?: string }[]; monthlyTotal: number; payroll: number };
  audit: { t: number; actor: string; kind: string; text: string }[];
  hosts: { id: string; ip: string; label: string; os: string }[];
  session: { hostId: string; user: string; cwd: string; pending: boolean; prompt: string };
  git: { branch: string; commits: number; dirty: number; pushed: boolean; conflicts: string[] } | null;
  docker: {
    images: { tag: string; sizeMB: number; user: string; healthcheck: boolean; layers: number; signed: boolean; sbom: boolean }[];
    containers: { name: string; image: string; status: string; healthy: boolean; port: number | null }[];
    registry: { tag: string; sizeMB: number; signed: boolean; sbom: boolean }[];
  };
  ci: {
    runs: { id: string; startedAtMin: number; pipelinePath: string; commitSha: string; status: string; image?: string; stages: { name: string; status: string; log: string[] }[] }[];
    deployments: { id: string; service: string; image: string; createdAtMin: number; source: string; active: boolean }[];
    staging: { image: string | null; e2ePassed: boolean; e2eLog: string[] } | null;
    previews: { id: string; image: string; url: string; createdAtMin: number; minutesLeft: number }[];
    previewsDestroyed: number;
  };
  db: {
    provisioned: boolean; plan: string; endpoint: string; cpu: number; connections: number;
    migrationsDone: boolean; pooler: boolean; tables: { name: string; rows: number; indexes: string[] }[];
    backups: {
      enabled: boolean; retentionDays: number;
      snapshots: { atMin: number; label: string; ordersRows: number }[];
      lastRestore: { atMin: number; fromSnapshotAtMin: number; rpoMin: number; rtoMin: number } | null;
    };
  };
  k8s: null | {
    name: string; version: string; ip: string; serving: boolean; zeroDowntimeProven: boolean;
    deployments: { name: string; image: string; replicas: number; ready: number; revision: number; strategy: string; readinessProbe: boolean; livenessProbe: boolean }[];
    pods: { name: string; phase: string; restarts: number; node: string; revision: number }[];
    services: { name: string; type: string; port: number; targetPort: number; selector: string; ingressIp: string | null }[];
    ingresses: { name: string; host: string; service: string }[];
    hpas: { name: string; deployment: string; min: number; max: number; current: number; peaked: boolean }[];
    networkPolicies: { name: string; defaultDeny: boolean; allows: { fromSelector: string; port: number }[] }[];
    admissionPolicy: { name: string; rule: string } | null;
  };
  tf: null | {
    initialized: boolean; managed: number; addresses: string[];
    lastPlanClean: boolean; driftDetected: boolean; driftResolved: boolean;
  };
  team: {
    engineers: { id: string; name: string; role: string; salary: number; roleLabel: string }[];
    onCallId: string | null;
    roles: { id: string; label: string; salary: number; blurb: string; debtPerDay: number }[];
  };
  debt: {
    points: number;
    log: { atMin: number; text: string }[];
    projects: { id: string; label: string; detail: string; debtRemoved: number; costCash: number; durationMin: number; startedAtMin: number | null; done: boolean; progress: number | null }[];
  };
  slos: {
    configured: boolean; setAtMin?: number; availabilityTarget: number; p95TargetMs: number;
    report: {
      availability: number; availabilityMet: boolean; p95Avg: number; p95Met: boolean;
      budgetAllowedMin: number; budgetBurnedMin: number; budgetRemainingPct: number; burnPerDay: number;
    };
  };
  canary: null | { active: boolean; image: string; startedAtMin: number; trafficPct: number; errorPct: number; status: string; reason?: string; minutesObserved: number | null };
  marketingActive: boolean;
  cloud: null | {
    provider: string; region: string; providerName: string; tagline: string; regionName: string;
    latencyMs: number; reliabilityPct: number; priceMult: number; compared: boolean;
    comparison: { provider: string; region: string; providerName: string; regionName: string; monthlyCost: number; latencyMs: number; reliabilityPct: number; deltaPct: number; note: string }[];
    outage: null | { provider: string; providerName: string; region: string; durationMin: number; minutesLeft: number; ended: boolean; creditClaimed: boolean; creditValue: number | null; incidentId: string | null };
    outagesSeen: number; creditsTotal: number;
    migration: null | { toProvider: string; toRegion: string; providerName: string; regionName: string; status: string; progressPct: number; downtimeMin: number; minutesLeft: number };
    migrations: { fromProvider: string; fromRegion: string; toProvider: string; toRegion: string; providerName: string; atMin: number; downtimeMin: number; costBefore: number; costAfter: number }[];
  };
  products: {
    products: {
      id: string; name: string; tagline: string; tier: string; pricePerUserMonthly: number; adoptionPct: number;
      infraMonthly: number; buildCost: number; buildHours: number;
      requires: { slos?: boolean; satisfaction?: number; teamSize?: number } | null;
      blockers: string[]; startedAtMin: number | null; launchedAtMin: number | null; progress: number | null; mrr: number | null;
    }[];
    productMrr: number; baseMrr: number;
  };
  finops: null | {
    budgetMonthly: number | null; daysUnderBudget: number; daysOverBudget: number; currentMonthly: number;
    baselineMonthly: number | null; vsBaselinePct: number | null;
    reserved: { provider: string; providerName: string; active: boolean } | null;
    recommendations: { id: string; label: string; detail: string; savingsMonthly: number; action?: { label: string; kind: string } }[];
    resolvedCount: number; resolvedIds: string[];
    unitEconomics: { costPerUser: number; revenuePerUser: number; grossMarginPct: number };
  };
  architecture: { nodes: { id: string; label: string; kind: string; tier: number; status: string; detail: string }[]; edges: [string, string][] };
  packs: {
    available: { id: string; name: string; version: number; author: string | null; description: string; tournament: boolean; missionCount: number; requiresCompleted: string | null }[];
    activated: string[];
    formatNote: string;
  };
  challenge: null | {
    id: string; name: string; tagline: string; rule: string; ruleLabel: string; scoreLabel: string; briefing: string;
    durationDays: number; status: string; minutesLeft: number; verdict: string | null; score: number | null; stars: number | null;
    days: { day: number; ok: boolean; detail: string }[];
    live: null | {
      billNow: number; capMonthly: number | null; windowedAvailabilityPct: number | null;
      badMinutes: number; minutesElapsed: number; restoredAfterDisaster: boolean;
    };
    rtoTargetMin: number | null; availabilityFloorPct: number | null; challengesPassed: number;
  };
  challengesCatalog: { id: string; name: string; tagline: string; rule: string; ruleLabel: string; durationDays: number }[];
  tournament: null | { points: number; roundsWon: number; rivals: { name: string; points: number }[]; finished: boolean; place: number | null };
  settings: { locale: string; highContrast: boolean; largeText: boolean; reducedMotion: boolean };
  dns: { zone: string; records: { name: string; type: string; value: string; ttl: number }[] };
  firewall: { enabled: boolean; allowedPorts: number[] };
  nginx: { file: string; listen: number; serverName: string; proxyPass?: string }[];
  lb: { provisioned: boolean; ip: string | null; backends: { id: string; healthy: boolean }[]; haReady: boolean; drillUnderway: boolean };
  vms: { id: string; ip: string; serving: boolean }[];
  registryTags: string[];
  agentInstalled: boolean;
  diskPct: number;
  // ---- P5a: trust ----
  vault: null | {
    enabled: boolean; credsLive: boolean;
    secrets: { path: string; rotations: number; leases: number; lastRotatedAtMin: number }[];
    leakDetected: boolean; leakRevoked: boolean;
  };
  zeroTrust: null | { meshInstalled: boolean; mtlsStrict: boolean; identities: string[] };
  compliance: {
    auditImmutable: boolean; bundlesCount: number;
    lastBundle: { atMin: number; checks: { id: string; label: string; ok: boolean }[] } | null;
    findings: { id: string; label: string; severity: string; detail: string }[];
    users: { name: string; sudo: boolean; groups: string[] }[];
  };
  // ---- P5b: platform ----
  portal: null | {
    enabled: boolean;
    templates: { id: string; name: string; description: string; published: boolean }[];
    ticketQueue: number; devDeploys: number;
    deployLog: { atMin: number; dev: string; service: string }[];
  };
  tracing: {
    enabled: boolean; bottleneckFound: boolean; dbP95: number;
    traces: { id: string; atMin: number; path: string; durationMs: number; spans: { service: string; operation: string; durationMs: number }[] }[];
  };
  endgame: {
    pillars: { id: string; label: string; pass: boolean; detail: string }[];
    termSheetAccepted: boolean; payout: number | null;
    scaleEventSurvived: boolean; legendMode: boolean;
  };
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export const api = {
  listGames: () => fetch('/api/games').then((r) => j<GameSummary[]>(r)),
  createGame: (company: string, founder: string, mode: string) =>
    fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company, founder, mode }) }).then((r) => j<{ id: string }>(r)),
  deleteGame: (id: string) => fetch(`/api/games/${id}`, { method: 'DELETE' }).then((r) => j<{ deleted: boolean }>(r)),
  view: (id: string) => fetch(`/api/games/${id}`).then((r) => j<GameView>(r)),
  terminal: (id: string, input: string) =>
    fetch(`/api/games/${id}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })
      .then((r) => j<{ lines: OutLine[]; session: { prompt: string; pending: boolean; hostId: string; user: string; cwd: string } }>(r)),
  fs: (id: string, path: string) => fetch(`/api/games/${id}/fs?path=${encodeURIComponent(path)}`).then((r) => j<{ path: string; entries: FsEntry[] | null }>(r)),
  readFile: (id: string, path: string) => fetch(`/api/games/${id}/file?path=${encodeURIComponent(path)}`).then((r) => j<{ path: string; content: string; owner: string; mode: string }>(r)),
  writeFile: (id: string, path: string, content: string) =>
    fetch(`/api/games/${id}/file`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content }) }).then((r) => j<{ ok: boolean; warnings: string[] }>(r)),
  hint: (id: string, pack = false) => fetch(`/api/games/${id}/mission/hint`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack }) }).then((r) => j<{ hint: string | null; index: number; remaining: number }>(r)),
  solve: (id: string, pack = false) => fetch(`/api/games/${id}/mission/solve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pack }) }).then((r) => j<SolveResult>(r)),
  listPacks: () => fetch('/api/packs').then((r) => j<GameView['packs']['available']>(r)),
  activatePack: (id: string, packId: string) => fetch(`/api/games/${id}/packs/${packId}/activate`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  challengeStart: (id: string, challengeId: string) =>
    fetch(`/api/games/${id}/challenge/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  challengeAbandon: (id: string) => fetch(`/api/games/${id}/challenge/abandon`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  setSettings: (id: string, opts: { locale?: string; highContrast?: boolean; largeText?: boolean; reducedMotion?: boolean }) =>
    fetch(`/api/games/${id}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  ciRun: (id: string, pipeline: string) =>
    fetch(`/api/games/${id}/ci/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipeline }) }).then((r) => j<{ run: GameView['ci']['runs'][number] }>(r)),
  ciApprove: (id: string, runId: string, approve: boolean) =>
    fetch(`/api/games/${id}/ci/${runId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  rollback: (id: string, depId: string) => fetch(`/api/games/${id}/deployments/${depId}/rollback`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  dbQuery: (id: string, sql: string) =>
    fetch(`/api/games/${id}/db/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) }).then((r) => j<SqlResult>(r)),
  dbMigrate: (id: string) => fetch(`/api/games/${id}/db/migrate`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string; lines: OutLine[] }>(r)),
  cloudDns: (id: string, name: string, type: string, value: string, ttl: number) =>
    fetch(`/api/games/${id}/cloud/dns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type, value, ttl }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudFw: (id: string, port: number) =>
    fetch(`/api/games/${id}/cloud/firewall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) }).then((r) => j<unknown>(r)),
  cloudDb: (id: string, plan: string) =>
    fetch(`/api/games/${id}/cloud/db`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }).then((r) => j<unknown>(r)),
  cloudDisk: (id: string, gb: number) =>
    fetch(`/api/games/${id}/cloud/disk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gb }) }).then((r) => j<unknown>(r)),
  cloudAgent: (id: string) => fetch(`/api/games/${id}/cloud/agent`, { method: 'POST' }).then((r) => j<unknown>(r)),
  cloudVm: (id: string) => fetch(`/api/games/${id}/cloud/vm`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudVmDeploy: (id: string, hostId: string) => fetch(`/api/games/${id}/cloud/vm/${hostId}/deploy`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudLb: (id: string) => fetch(`/api/games/${id}/cloud/lb`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudK8s: (id: string) => fetch(`/api/games/${id}/cloud/k8s`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudBackups: (id: string, retentionDays: number) =>
    fetch(`/api/games/${id}/cloud/backups`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retentionDays }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  dbRestore: (id: string) => fetch(`/api/games/${id}/db/restore`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  addAlert: (id: string, metric: string, op: string, threshold: number) =>
    fetch(`/api/games/${id}/alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metric, op, threshold }) }).then((r) => j<unknown>(r)),
  delAlert: (id: string, alertId: string) => fetch(`/api/games/${id}/alerts/${alertId}`, { method: 'DELETE' }).then((r) => j<unknown>(r)),
  postmortem: (id: string, incId: string, actions: string[]) =>
    fetch(`/api/games/${id}/incidents/${incId}/postmortem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  setTime: (id: string, paused: boolean, speed: number) =>
    fetch(`/api/games/${id}/time`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused, speed }) }).then((r) => j<unknown>(r)),
  hire: (id: string, role: string) =>
    fetch(`/api/games/${id}/team/hire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  fire: (id: string, engId: string) =>
    fetch(`/api/games/${id}/team/${engId}/fire`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  setOnCall: (id: string, engineerId: string | null) =>
    fetch(`/api/games/${id}/team/oncall`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engineerId }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  marketing: (id: string) => fetch(`/api/games/${id}/marketing`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  debtProject: (id: string, projectId: string) =>
    fetch(`/api/games/${id}/debt/project/${projectId}/start`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  setSlos: (id: string, availability: number, p95ms: number) =>
    fetch(`/api/games/${id}/slos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ availability, p95ms }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  canaryPromote: (id: string) => fetch(`/api/games/${id}/canary/promote`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  canaryAbort: (id: string) => fetch(`/api/games/${id}/canary/abort`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudCompare: (id: string) => fetch(`/api/games/${id}/cloud/compare`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  providerCredit: (id: string) => fetch(`/api/games/${id}/cloud/provider/credit`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  cloudMigrate: (id: string, toProvider: string, toRegion: string) =>
    fetch(`/api/games/${id}/cloud/migrate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toProvider, toRegion }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  vmDecommission: (id: string, hostId: string) => fetch(`/api/games/${id}/cloud/vm/${hostId}/decommission`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  productStart: (id: string, productId: string) => fetch(`/api/games/${id}/products/${productId}/start`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  finopsBudget: (id: string, monthly: number) =>
    fetch(`/api/games/${id}/finops/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthly }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  finopsReserve: (id: string) => fetch(`/api/games/${id}/finops/reserve`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  k8sNodes: (id: string, count: number) =>
    fetch(`/api/games/${id}/k8s/nodes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  // ---- P5 ----
  cloudMesh: (id: string, action: 'install' | 'strict') =>
    fetch(`/api/games/${id}/cloud/mesh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  complianceEvidence: (id: string) =>
    fetch(`/api/games/${id}/compliance/evidence`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  complianceAccess: (id: string, user: string) =>
    fetch(`/api/games/${id}/compliance/access`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  complianceAuditlog: (id: string) =>
    fetch(`/api/games/${id}/compliance/auditlog`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  portalEnable: (id: string) =>
    fetch(`/api/games/${id}/portal/enable`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  portalPublish: (id: string, templateId: string) =>
    fetch(`/api/games/${id}/portal/templates/${templateId}/publish`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  tracingEnable: (id: string) =>
    fetch(`/api/games/${id}/tracing/enable`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  tracingAnalyze: (id: string) =>
    fetch(`/api/games/${id}/tracing/analyze`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string; attribution: { service: string; sharePct: number; avgMs: number }[] }>(r)),
  dbPooler: (id: string) =>
    fetch(`/api/games/${id}/db/pooler`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r)),
  endgameAccept: (id: string) =>
    fetch(`/api/games/${id}/endgame/accept`, { method: 'POST' }).then((r) => j<{ ok: boolean; message: string }>(r))
};

export interface FsEntry { name: string; type: string; sizeMB: number; owner: string; mode: string; children?: FsEntry[] }
export interface SqlResult { columns: string[]; rows: (string | number | null)[][]; rowCount: number; error?: string; notice?: string; commandTag?: string }
