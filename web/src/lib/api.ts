// Typed API client for the SHIP IT backend.

export interface OutLine { text: string; cls?: 'err' | 'ok' | 'dim' | 'hdr' | 'warn' }

export interface GameSummary { id: string; name: string; day: number; updatedAt: number }

export interface ReqResult { id: string; label: string; pass: boolean }

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
  costs: { lineItems: { category: string; label: string; monthlyCost: number }[]; monthlyTotal: number; payroll: number };
  audit: { t: number; actor: string; kind: string; text: string }[];
  hosts: { id: string; ip: string; label: string; os: string }[];
  session: { hostId: string; user: string; cwd: string; pending: boolean; prompt: string };
  git: { branch: string; commits: number; dirty: number; pushed: boolean; conflicts: string[] } | null;
  docker: {
    images: { tag: string; sizeMB: number; user: string; healthcheck: boolean; layers: number }[];
    containers: { name: string; image: string; status: string; healthy: boolean; port: number | null }[];
    registry: { tag: string; sizeMB: number }[];
  };
  ci: {
    runs: { id: string; startedAtMin: number; pipelinePath: string; commitSha: string; status: string; stages: { name: string; status: string; log: string[] }[] }[];
    deployments: { id: string; service: string; image: string; createdAtMin: number; source: string; active: boolean }[];
  };
  db: {
    provisioned: boolean; plan: string; endpoint: string; cpu: number; connections: number;
    migrationsDone: boolean; tables: { name: string; rows: number; indexes: string[] }[];
  };
  architecture: { nodes: { id: string; label: string; kind: string; tier: number; status: string; detail: string }[]; edges: [string, string][] };
  dns: { zone: string; records: { name: string; type: string; value: string; ttl: number }[] };
  firewall: { enabled: boolean; allowedPorts: number[] };
  nginx: { file: string; listen: number; serverName: string; proxyPass?: string }[];
  lb: { provisioned: boolean; ip: string | null; backends: { id: string; healthy: boolean }[]; haReady: boolean; drillUnderway: boolean };
  vms: { id: string; ip: string; serving: boolean }[];
  registryTags: string[];
  agentInstalled: boolean;
  diskPct: number;
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
  hint: (id: string) => fetch(`/api/games/${id}/mission/hint`, { method: 'POST' }).then((r) => j<{ hint: string | null; index: number; remaining: number }>(r)),
  ciRun: (id: string, pipeline: string) =>
    fetch(`/api/games/${id}/ci/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipeline }) }).then((r) => j<{ run: GameView['ci']['runs'][number] }>(r)),
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
  addAlert: (id: string, metric: string, op: string, threshold: number) =>
    fetch(`/api/games/${id}/alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metric, op, threshold }) }).then((r) => j<unknown>(r)),
  delAlert: (id: string, alertId: string) => fetch(`/api/games/${id}/alerts/${alertId}`, { method: 'DELETE' }).then((r) => j<unknown>(r)),
  postmortem: (id: string, incId: string, actions: string[]) =>
    fetch(`/api/games/${id}/incidents/${incId}/postmortem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions }) }).then((r) => j<{ ok: boolean; message: string }>(r)),
  setTime: (id: string, paused: boolean, speed: number) =>
    fetch(`/api/games/${id}/time`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused, speed }) }).then((r) => j<unknown>(r))
};

export interface FsEntry { name: string; type: string; sizeMB: number; owner: string; mode: string; children?: FsEntry[] }
export interface SqlResult { columns: string[]; rows: (string | number | null)[][]; rowCount: number; error?: string; notice?: string; commandTag?: string }
