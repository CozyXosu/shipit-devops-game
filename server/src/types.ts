// SHIP IT — core domain types. Everything is JSON-serializable (plain
// records/arrays, no Maps) because the world is persisted as a snapshot.

// ---------- Virtual filesystem ----------
export interface VFile {
  type: 'file';
  content: string;
  mode: number;
  owner: string;
  group?: string;
  mtime: number;
  /** Real on-disk size in MB when content is truncated (log files). */
  diskSizeMB?: number;
}

export interface VDir {
  type: 'dir';
  children: Record<string, VNode>;
  mode: number;
  owner: string;
  mtime: number;
}

export type VNode = VFile | VDir;

// ---------- Linux host simulation ----------
export interface SimProcess {
  pid: number;
  cmd: string;
  user: string;
  cpuPct: number;
  memMB: number;
  port?: number; // listening port
  state: 'running' | 'sleeping' | 'zombie';
  service?: string;
  startedAtMin: number;
}

export interface SimService {
  name: string; // e.g. "api" (unit api.service)
  description: string;
  state: 'active' | 'inactive' | 'failed';
  enabled: boolean;
  execStart: string;
  user: string;
  envFile?: string;
  port?: number;
  pid?: number;
  log: string[]; // journalctl ring buffer (newest last)
}

export interface SimUser {
  name: string;
  uid: number;
  sudo: boolean;
  groups: string[];
}

export interface SimHost {
  id: string;
  label: string;
  ip: string;
  os: string;
  fs: VDir;
  processes: SimProcess[];
  nextPid: number;
  services: Record<string, SimService>;
  users: Record<string, SimUser>;
  packages: string[];
  diskTotalMB: number;
  diskUsedBaseMB: number; // non-log disk usage
}

// ---------- Git ----------
export interface GitCommit {
  sha: string;
  message: string;
  parents: string[];
  author: string;
  email: string;
  timeMin: number;
  tree: Record<string, string>; // path -> content (tracked files at commit)
  changed: string[];
}

export interface GitRepo {
  path: string;
  head: string; // branch name
  branches: Record<string, { commit: string }>;
  commits: Record<string, GitCommit>;
  staging: Record<string, string | null>; // path -> content or null (deletion)
  remotes: Record<string, string>;
  remoteBranches: Record<string, string>; // "origin/main" -> sha
  merging: { into: string; from: string; conflicted: string[] } | null;
  lastBuildHash?: string;
  /** stash entries, newest first (optional so older saves load cleanly) */
  stash?: { id: number; message: string; files: Record<string, string | null> }[];
}

// ---------- Docker ----------
export interface DockerImage {
  id: string;
  repoTags: string[]; // "registry.acme.dev/acme/api:v1"
  sizeMB: number;
  baseImage: string;
  user?: string;
  ports: number[];
  env: Record<string, string>;
  healthcheck?: { test: string };
  workdir: string;
  cmd?: string[];
  layers: { cmd: string; sizeMB: number; cached: boolean }[];
  multiStage: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  env: Record<string, string>;
  hostPort?: number;
  containerPort?: number;
  status: 'running' | 'exited' | 'restarting';
  healthy: boolean;
  startedAtMin: number;
  serviceRef?: string;
  logs: string[];
  /** which SimHost the container runs on; undefined = web-01 (older saves) */
  hostId?: string;
}

/** Load balancer in front of the app backends (cloud-managed). */
export interface LoadBalancer {
  provisioned: boolean;
  ip: string;
  label: string;
}

// ---------- Database ----------
export interface DbIndexDef {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface DbTable {
  name: string;
  columns: { name: string; type: string }[];
  rowCount: number;
  indexes: DbIndexDef[];
}

export interface ManagedPostgres {
  provisioned: boolean;
  plan: 'db.micro' | 'db.small' | 'db.medium';
  endpoint: string;
  version: string;
  tables: Record<string, DbTable>;
  connections: number;
  cpuPct: number;
  migrationsDone: boolean;
  seqScansPerSec: number;
}

// ---------- CI ----------
export interface PipelineStep {
  name: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

export interface Pipeline {
  name: string;
  on: string;
  steps: PipelineStep[];
  path: string; // repo-relative file path
  valid: boolean;
  problems: string[];
}

export interface CiStage {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  log: string[];
}

export interface CiRun {
  id: string;
  startedAtMin: number;
  pipelinePath: string;
  commitSha: string;
  status: 'running' | 'success' | 'failed';
  stages: CiStage[];
}

export interface Deployment {
  id: string;
  service: string;
  image: string;
  createdAtMin: number;
  source: 'ci' | 'manual' | 'rollback';
  active: boolean;
}

// ---------- Monitoring ----------
export interface MetricPoint { t: number; v: number }

export interface AlertRule {
  id: string;
  metric: string;
  label: string;
  op: '>' | '<' | '>=' | '<=';
  threshold: number;
  forMinutes: number;
  state: 'ok' | 'pending' | 'firing';
  sinceMin?: number;
}

export interface Incident {
  id: string;
  kind: 'disk_full' | 'bad_deploy' | 'db_saturation' | 'traffic_spike';
  title: string;
  symptom: string;
  severity: 'SEV2' | 'SEV1';
  openedAtMin: number;
  resolvedAtMin?: number;
  status: 'open' | 'resolved';
  rootCause: string;
  customerImpact: string;
  detectedBy: string;
  timeline: { t: number; actor: string; text: string }[];
  corrective: { id: string; label: string; done: boolean }[];
  postmortemFiled: boolean;
}

// ---------- Economy / company ----------
export interface CostLineItem { category: string; label: string; monthlyCost: number }

export interface Company {
  name: string;
  slug: string;
  founder: string;
  cash: number;
  users: number;
  satisfaction: number; // 0..5
  launched: boolean;
  product: string;
}

export interface AuditEvent { t: number; actor: string; kind: string; text: string }

// ---------- The world ----------
export interface AppRuntime {
  version: string;
  mode: 'service' | 'container' | 'stopped';
  image?: string;
  database: 'sqlite' | 'postgres';
  env: Record<string, string>; // effective env vars the app currently runs with
  uptimeSinceMin?: number;
}

export interface Flags {
  [key: string]: boolean | number | undefined;
}

export interface World {
  createdAtMin: number; // absolute sim minute counter origin
  nowMin: number; // absolute sim minutes since company founding (day = floor(now/1440)+1)
  company: Company;
  hosts: Record<string, SimHost>;
  session: {
    hostId: string;
    user: string;
    cwd: string;
    env: Record<string, string>;
    pending: { kind: 'ssh-password'; hostId: string; user: string } | null;
    history: string[];
  };
  dns: Record<string, Record<string, { type: string; value: string; ttl: number }>>; // zone -> name -> record
  firewall: { enabled: boolean; allowedPorts: number[] };
  git: Record<string, GitRepo>; // key: repo path
  docker: { images: DockerImage[]; containers: DockerContainer[] };
  registry: DockerImage[];
  db: ManagedPostgres;
  ci: { runs: CiRun[]; deployments: Deployment[] };
  monitoring: {
    agentInstalled: boolean;
    series: Record<string, MetricPoint[]>;
    alertRules: AlertRule[];
    incidents: Incident[];
  };
  app: AppRuntime;
  /** present once the player provisions it (absent in saves from older versions) */
  lb?: LoadBalancer;
  economy: { lineItems: CostLineItem[]; payrollMonthly: number; revenueToday: number; costHistory: { day: number; infra: number; revenue: number }[] };
  audit: AuditEvent[];
  flags: Flags;
  scheduledEvents: { atMin: number; kind: string; payload?: Record<string, unknown> }[];
}

export interface GameState {
  id: string;
  createdAt: number;
  updatedAt: number;
  world: World;
  missions: {
    completed: string[];
    current: string;
    hintsUsed: Record<string, number>;
    attempts: Record<string, number>;
    ratings: Record<string, string>;
  };
  skills: Record<string, number>;
  xp: number;
}

// Terminal output line with optional style class
export interface OutLine { text: string; cls?: 'err' | 'ok' | 'dim' | 'hdr' | 'warn' }
