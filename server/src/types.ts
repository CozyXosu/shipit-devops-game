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
  /** supply chain (P5a): image signed with cosign */
  signed?: boolean;
  /** supply chain (P5a): SBOM attestation attached */
  sbom?: boolean;
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
  /** connection pooler (pgbouncer) fronting the DB (P5b, optional) */
  pooler?: boolean;
  backups: DbBackupState;
}

// ---------- CI ----------
export interface PipelineStep {
  name: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  /** gate: production deploy must be approved before this step runs */
  needsApproval?: boolean;
}

export interface Pipeline {
  name: string;
  on: string;
  /** progressive delivery: canary | blue-green | rolling (default) */
  strategy?: string;
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
  status: 'running' | 'success' | 'failed' | 'waiting_approval' | 'rejected';
  stages: CiStage[];
  /** steps still to execute while the run waits for a production approval */
  pendingSteps?: PipelineStep[];
  /** image the run is trying to ship (for approval rendering) */
  image?: string;
}

/** Staging environment: the dress rehearsal stage before production. */
export interface StagingEnv {
  image: string | null;
  deployedAtMin: number;
  e2ePassed: boolean;
  e2eLog: string[];
}

export interface Deployment {
  id: string;
  service: string;
  image: string;
  createdAtMin: number;
  source: 'ci' | 'manual' | 'rollback';
  active: boolean;
}

// ---------- Terraform ----------
export interface TfResource {
  address: string; // "stratus_vm.web-01"
  type: string;
  name: string;
  attrs: Record<string, string>;
  id: string; // cloud resource id shown in state
}

export interface TerraformState {
  initialized: boolean;
  dir: string; // working directory (default /opt/infra)
  resources: Record<string, TfResource>; // address -> resource
  lastPlan: string[]; // rendered plan output
  lastPlanAtMin: number;
  lastPlanClean: boolean;
  driftDetected: boolean;
  driftResolved: boolean;
}

// ---------- Kubernetes ----------
export interface K8sPod {
  name: string;
  deployment: string;
  node: string;
  phase: 'Pending' | 'Running' | 'Ready' | 'CrashLoopBackOff' | 'Terminating';
  ready: boolean;
  restarts: number;
  image: string;
  startedAtMin: number;
  revision: number;
}

export interface K8sDeployment {
  name: string;
  image: string;
  replicas: number;
  readyReplicas: number;
  revision: number;
  strategy: 'RollingUpdate' | 'Recreate';
  containerPort: number;
  readinessProbe: boolean;
  livenessProbe: boolean;
  /** zero trust (P5a): manifest sets securityContext.runAsNonRoot */
  runAsNonRoot?: boolean;
  env: Record<string, string>;
  history: { revision: number; image: string; atMin: number }[];
  createdAtMin: number;
}

export interface K8sService {
  name: string;
  type: 'ClusterIP' | 'LoadBalancer';
  port: number;
  targetPort: number;
  selector: string;
  ingressIp?: string; // assigned by the cloud when type=LoadBalancer
}

export interface K8sIngress {
  name: string;
  host: string;
  path: string;
  service: string;
  servicePort: number;
}

export interface K8sHpa {
  name: string;
  deployment: string;
  minReplicas: number;
  maxReplicas: number;
  targetCpuPct: number;
  currentReplicas: number;
  peakedAtMin?: number; // last minute at which it scaled out beyond min
}

/** Zero-trust network policy (P5a): default-deny or an explicit allow rule. */
export interface K8sNetworkPolicy {
  name: string;
  /** true when podSelector is empty and no ingress rules exist (deny all) */
  defaultDeny: boolean;
  /** explicit ingress allowances: which selector may talk to the target, on which port */
  allows: { fromSelector: string; port: number }[];
}

/** Admission policy (P5a): cluster-level gate on what may be deployed. */
export interface K8sAdmissionPolicy {
  /** 'signed-images' — deployments of unsigned images are rejected */
  rule: 'signed-images';
  name: string;
  appliedAtMin: number;
}

export interface K8sCluster {
  provisioned: boolean;
  name: string; // k8s-01
  version: string;
  ip: string; // load-balanced API endpoint of the cluster
  nodes: string[];
  deployments: Record<string, K8sDeployment>;
  services: Record<string, K8sService>;
  ingresses: Record<string, K8sIngress>;
  hpas: Record<string, K8sHpa>;
  /** zero-trust network policies (P5a); absent in older saves */
  networkPolicies?: Record<string, K8sNetworkPolicy>;
  /** admission control (P5a): blocks unsigned images when active */
  admissionPolicy?: K8sAdmissionPolicy;
  pods: K8sPod[];
  nextPodSuffix: number;
  /** set when a RollingUpdate completed without a no-ready-pods moment */
  zeroDowntimeProven: boolean;
}

/** Progressive delivery: a canary release serving a slice of traffic. */
export interface CanaryState {
  active: boolean;
  image: string;
  startedAtMin: number;
  trafficPct: number;
  /** last observed canary error rate while active */
  errorPct: number;
  status: 'running' | 'promoted' | 'aborted';
  reason?: string;
}

// ---------- Team / hiring ----------
export type EngineerRole = 'junior' | 'mid' | 'senior' | 'sre';

export interface Engineer {
  id: string;
  name: string;
  role: EngineerRole;
  salaryMonthly: number;
  hiredAtMin: number;
}

export interface TeamState {
  engineers: Engineer[];
  onCallId: string | null;
}

// ---------- Technical debt ----------
export interface RefactorProject {
  id: string;
  label: string;
  detail: string;
  debtRemoved: number;
  costCash: number;
  durationMin: number;
  startedAtMin?: number;
  done: boolean;
}

export interface DebtState {
  points: number;
  /** how the debt was earned — newest first */
  log: { atMin: number; text: string }[];
  projects: RefactorProject[];
}

// ---------- SLOs ----------
export interface SloState {
  configured: boolean;
  setAtMin?: number;
  availabilityTarget: number; // e.g. 99.5 (%)
  p95TargetMs: number;        // e.g. 600
}

// ---------- Cloud providers / multi-cloud (P3) ----------
/** An active provider-side outage: you cannot fix it, only ride it out. */
export interface ProviderOutage {
  provider: string;
  region: string;
  startedAtMin: number;
  durationMin: number;
  /** set when the provider recovers; the SLA credit is claimable until it expires */
  endedAtMin?: number;
  creditClaimed: boolean;
  incidentId?: string;
}

/** A whole-footprint migration between providers/regions. */
export interface MigrationState {
  toProvider: string;
  toRegion: string;
  startedAtMin: number;
  durationMin: number;        // prep + replicate time before the cutover
  downtimeMin: number;        // planned cutover downtime, reduced by preparation
  status: 'running' | 'cutover';
  cutoverEndsAtMin?: number;
  costBefore: number;         // monthly infra cost where the migration began
  narrated: number;           // progress narration steps already logged
}

export interface MigrationRecord {
  fromProvider: string;
  fromRegion: string;
  toProvider: string;
  toRegion: string;
  atMin: number;
  downtimeMin: number;
  costBefore: number;
  costAfter: number;
}

export interface CloudState {
  provider: string;           // provider id (stratus | volt | orbit)
  region: string;             // region id within the provider
  sinceMin: number;
  compared: boolean;          // ran the cost comparison (gates migration)
  lastComparison?: { provider: string; region: string; monthlyCost: number; note: string }[];
  outage?: ProviderOutage;    // active provider outage, if any
  outagesSeen: number;
  creditsTotal: number;       // SLA credits claimed, in dollars
  migration?: MigrationState; // in-flight migration
  migrations: MigrationRecord[];
}

// ---------- Products (P3) ----------
export interface Product {
  id: string;
  name: string;
  tagline: string;
  tier: 'addon' | 'growth' | 'enterprise';
  pricePerUserMonthly: number;
  adoptionPct: number;        // share of company users expected to buy
  infraMonthly: number;       // added infra cost once launched
  buildCost: number;
  buildDurationMin: number;
  requires?: { slos?: boolean; satisfaction?: number; teamSize?: number };
  startedAtMin?: number;
  launchedAtMin?: number;
}

export interface ProductState {
  products: Product[];
}

// ---------- FinOps (P3) ----------
export interface FinOpsState {
  budgetMonthly?: number;
  budgetSetAtMin?: number;
  daysUnderBudget: number;
  daysOverBudget: number;
  baselineMonthly?: number;   // infra cost when the FinOps effort started
  baselineAtMin?: number;
  seen: string[];             // recommendation ids present last tick
  resolved: string[];         // recommendation ids acted on / no longer applicable
  reservedProvider?: string;  // 1-year reserved compute commitment
  reservedAtMin?: number;
}

// ---------- Challenges (P4) ----------
export interface ChallengeDayResult {
  day: number;
  ok: boolean;
  detail: string;
}

/** A scored run of one challenge against the live world. */
export interface ChallengeRunState {
  id: string;                  // challenge def id
  startedAtMin: number;
  durationMin: number;
  status: 'active' | 'passed' | 'failed';
  verdict?: string;
  score?: number;              // meaning depends on the rule (see ChallengeDef.scoreLabel)
  billAtStart?: number;        // budget rule: monthly infra snapshot
  capMonthly?: number;         // budget rule: the line that must not be crossed
  badMinAtStart?: number;      // availability rule: uptimeBadMin snapshot
  disasterAtMin?: number;      // rto rule: when the disaster actually fired
  days: ChallengeDayResult[];
}

// ---------- Postmortem tournament (P4) ----------
export interface TournamentRival {
  name: string;
  points: number;
}

export interface TournamentState {
  joinedAtMin: number;
  points: number;
  roundsWon: number;
  rivals: TournamentRival[];
  lastRivalTickMin?: number;
  finished: boolean;
  place?: number;
}

// ---------- Secrets manager / vault (P5a) ----------
/** A managed secret: value is generated by the vault, never typed by players. */
export interface VaultSecret {
  path: string;            // "database/api"
  value: string;           // current generated value (rotations replace it)
  createdAtMin: number;
  rotatedAtMin: number;
  rotations: number;       // how many times it was rotated
  dynamicLeases: number;   // dynamic credentials issued against it
}

export interface VaultState {
  enabled: boolean;
  enabledAtMin: number;
  secrets: Record<string, VaultSecret>;
  /** dynamic DB credentials are live: the app authenticates with vault-issued creds */
  credsLive: boolean;
}

// ---------- Zero trust (P5a) ----------
export interface ZeroTrustState {
  meshInstalled: boolean;      // service mesh present on the cluster
  meshInstalledAtMin: number;
  mtlsStrict: boolean;         // STRICT peer authentication (not permissive)
  identities: string[];        // service identities issued by the mesh
}

// ---------- Compliance (P5a) ----------
export interface ComplianceFinding {
  id: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface EvidenceBundle {
  atMin: number;
  checks: { id: string; label: string; ok: boolean }[];
}

export interface ComplianceState {
  /** audit log shipped to an append-only store */
  auditImmutable: boolean;
  bundles: EvidenceBundle[];
}

// ---------- Developer portal (P5b) ----------
export interface PortalTemplate {
  id: string;
  name: string;
  description: string;
  /** published templates are self-service for every developer */
  published: boolean;
}

export interface PortalDeployEvent { atMin: number; dev: string; service: string }

export interface PortalState {
  enabled: boolean;
  enabledAtMin: number;
  templates: PortalTemplate[];
  /** deploy tickets waiting before golden paths existed */
  ticketQueue: number;
  devDeploys: number;
  deployLog: PortalDeployEvent[];
}

// ---------- Ephemeral preview environments (P5b) ----------
export interface PreviewEnv {
  id: string;            // "pr-12"
  runId: string;
  image: string;
  url: string;           // pr-12.preview.<slug>.dev
  createdAtMin: number;
  expiresAtMin: number;  // auto-destroyed after this sim minute
}

// ---------- Distributed tracing (P5b) ----------
export interface TraceSpan {
  service: string;      // lb | api | db
  operation: string;    // "GET /api/orders"
  durationMs: number;
}

export interface Trace {
  id: string;
  atMin: number;
  path: string;
  durationMs: number;
  spans: TraceSpan[];
}

// ---------- Endgame (P5b) ----------
export interface DueDiligencePillar {
  id: string;           // security | reliability | finops | team | products
  label: string;
  pass: boolean;
  detail: string;
}

export interface EndgameState {
  /** the term sheet was accepted — the company sold */
  termSheetAccepted: boolean;
  acceptedAtMin?: number;
  payout?: number;
  pillars: DueDiligencePillar[];
}

// ---------- Backups / DR ----------
export interface DbSnapshot {
  atMin: number;
  label: string; // snap-20260929-0900
  ordersRows: number;
  sizeGB: number;
}

export interface DbBackupState {
  enabled: boolean;
  enabledAtMin?: number;
  retentionDays: number;
  snapshots: DbSnapshot[];
  lastRestore?: { atMin: number; fromSnapshotAtMin: number; rpoMin: number; rtoMin: number };
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
  kind: 'disk_full' | 'bad_deploy' | 'db_saturation' | 'traffic_spike' | 'data_loss' | 'provider_outage';
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
export interface CostLineItem {
  category: string;
  label: string;
  monthlyCost: number;
  /** provider+region tag for cloud-hosted items (FinOps allocation) */
  provider?: string;
}

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
  mode: 'service' | 'container' | 'k8s' | 'stopped';
  image?: string;
  database: 'sqlite' | 'postgres';
  env: Record<string, string>; // effective env vars the app currently runs with
  uptimeSinceMin?: number;
}

export interface Flags {
  [key: string]: boolean | number | string | undefined;
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
  ci: { runs: CiRun[]; deployments: Deployment[]; staging?: StagingEnv; canary?: CanaryState; blueGreen?: { activeImage: string; warmImage: string }; previews?: PreviewEnv[] };
  monitoring: {
    agentInstalled: boolean;
    series: Record<string, MetricPoint[]>;
    alertRules: AlertRule[];
    incidents: Incident[];
  };
  app: AppRuntime;
  /** present once the player provisions it (absent in saves from older versions) */
  lb?: LoadBalancer;
  /** kubernetes cluster; absent in saves from older versions */
  k8s?: K8sCluster;
  /** terraform working state; absent until the player initializes it */
  tf?: TerraformState;
  /** company team; absent until the first hire (older saves) */
  team?: TeamState;
  /** technical debt ledger; lazily seeded from history */
  debt?: DebtState;
  /** service level objectives; defaults exist, "configured" once edited */
  slos?: SloState;
  /** multi-cloud provider footprint; absent until the ecosystem phase (older saves) */
  cloud?: CloudState;
  /** product portfolio; the catalog is seeded lazily */
  products?: ProductState;
  /** FinOps tooling state; created by the FinOps mission or first budget action */
  finops?: FinOpsState;
  /** challenge run (P4); absent until the player accepts one */
  challenge?: ChallengeRunState;
  /** postmortem tournament standings (P4); seeded by the tournament pack */
  tournament?: TournamentState;
  /** secrets manager (P5a); absent until the player enables it */
  vault?: VaultState;
  /** zero-trust posture (P5a); absent until the mesh is installed */
  zeroTrust?: ZeroTrustState;
  /** compliance & audit trail (P5a); created by the audit mission */
  compliance?: ComplianceState;
  /** internal developer portal (P5b); absent until launched */
  portal?: PortalState;
  /** sampled distributed traces (P5b); ring buffer, newest last */
  traces?: Trace[];
  /** acquisition endgame (P5b) */
  endgame?: EndgameState;
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
    /** active mission-pack mission id (parallel bonus track, P4) */
    packCurrent?: string;
  };
  /** activated mission-pack ids (P4) */
  packs?: string[];
  skills: Record<string, number>;
  xp: number;
}

// Terminal output line with optional style class
export interface OutLine { text: string; cls?: 'err' | 'ok' | 'dim' | 'hdr' | 'warn' }
