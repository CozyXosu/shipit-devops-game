# SHIP IT — DevOps Company Simulator
## Product & Technical Design (v0.1 — Vertical Slice)

> A learn-by-doing DevOps game: build a company's infrastructure from one flaky
> Linux box to a production platform, then run it through growth, incidents,
> and cost pressure. Everything is **simulated locally** — no real cloud, no
> real bills, no host execution of player input.

---

## 1. Product Specification (concise)

**Fantasy:** You are hired on day one as the first platform engineer of a tiny
startup. One developer, one broken server, no CI, no monitoring, no backups.
You build the platform, then you run the company.

**Player promise:** every concept is taught by making you *do the real task with
real artifacts* — shell commands on a simulated Linux host, real `git` syntax,
actual Dockerfiles, actual YAML pipelines, actual SQL — and the game **evaluates
what you built**, not what you clicked.

**Two phases:**
1. **BUILD** — structured mission chain (Linux → Git → Deploy → Docker → CI →
   Database → Monitoring → first incidents). This is the vertical slice.
2. **OPERATE & GROW** — open simulation: traffic growth, incidents, cost
   optimization, architecture evolution, team, products. (Phase 2+, designed for
   in §11–§12; the simulation engine shipped in the slice already drives
   economy/metrics/incidents so the phase has a foundation.)

**Modes:** Tutorial (guided, = slice missions), Career (default flow of the
slice + operate phase), Sandbox (budget + free build; the sandbox flag already
exists on game creation). Challenge mode: Phase 2.

**Anti-goals:** no multiple-choice quizzes, no fake buttons, no host command
execution, no required cloud spend.

## 2. Core Gameplay Loop

```
BUILD → DEPLOY → OBSERVE → BREAK → DEBUG → FIX → AUTOMATE → SCALE → OPTIMIZE → GROW
```

Concretely, in the slice: a mission gives you a realistic task → you
investigate with the terminal/editor/dashboards → you change real simulated
state (files, services, containers, DNS, pipelines) → validators check the
*state of the world* (not your clicks) → the world responds (metrics move,
users grow, incidents fire, costs change) → postmortem/retrospective closes
the loop and unlocks the next problem.

Failure is content: broken YAML produces CrashLoopBackOff-style symptoms to
debug, not "wrong answer".

**Fog of war (observability):** the loop above presumes you can OBSERVE — so
observation itself is a mechanic. The world simulates everything, but the
view-model exposes only what instrumentation has seen: `metricsView` gates
telemetry on the observability agent (collection starts at install, no
backfill), alert rules require a data source, and an emergent incident that
begins while you are blind is detected by customers after
`BLIND_DETECT_MIN` (40) sim minutes — `detectedBy: "customer report"` plus a
timeline note about the undetected window, versus instant alert-driven
detection once the agent runs. Support-ticket "signal" events drip into the
audit feed while blind. Manual channels stay open by design (terminal,
managed-DB provider console, cloud volume stats): automation buys
*continuous* sight, not truth.

## 3. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend | **Node.js + TypeScript** (Express, `tsx` runtime) | One language across stack; fast iteration; spec-endorsed |
| Frontend | **React 18 + TypeScript + Vite** | Spec-endorsed; Vite = zero-config local build |
| Terminal | Custom xterm-style component (client) driven by **server-side simulated shell** | The shell is the game engine, not a toy; no PTY, nothing escapes the sim |
| Code editor | Custom Monaco-style editor (line numbers, YAML/Dockerfile/nginx/bash/JS highlighting, validation markers) | Monaco via CDN breaks offline; custom = zero runtime deps |
| Charts | Custom SVG sparklines/area charts | Metrics are small series; no chart-lib weight |
| Architecture map | Custom interactive SVG (auto-layered by tier, click-for-detail) | Data comes from live sim state |
| Persistence (slice) | JSON snapshot store with write-through + atomic swap, pluggable `Storage` interface | Zero install friction on Windows/macOS/Linux |
| Persistence (Phase 2) | **PostgreSQL** via same `Storage` interface; schema already designed (`db/schema.sql`) | Spec requires PG for multi-user/cloud deploy; slice keeps the interface honest |
| Tests | **Vitest** (engine unit tests + full mission-chain integration test) | Native TS |

Security rule (spec §47): **all player input is executed against an in-memory
simulation only.** There is no `child_process`, no eval, no network egress from
the server. The "SSH" you do is a state transition inside the sim.

## 4. Domain Model (complete)

```
Game 1─1 Company ── cash, users, satisfaction, uptimeWindow, day/minute, speed, paused
      │            skills{linux,git,docker,cicd,databases,networking,observability,security,architecture,cloud}
      │            xp, revenueHistory
      ├─1 World
      │   ├─ hosts: Map<hostId, SimHost>
      │   │     ├─ fs: VNode (dir|file; mode, owner, content, mtime, size)
      │   │     ├─ processes: Process[] (pid, cmd, user, cpu%, memMB, listeningPort?)
      │   │     ├─ services: Service[] (systemd unit: state, enabled, execStart, user, envFile)
      │   │     ├─ users: SimUser[] (name, uid, groups, sudo)
      │   │     ├─ packages: string[]
      │   │     └─ logs: LogSource[] (paths, ring buffers feeding journalctl/tail)
      │   ├─ session: { hostId, user, cwd, env, pendingPrompt? }   // the "SSH client"
      │   ├─ dns: Record<zone, Record<name, {type, value, ttl}>>
      │   ├─ git: Map<repoPath, Repo{ HEAD, branches{ref→commit}, staging, commits{sha→Commit}, remotes }>
      │   ├─ docker: { images: Image[], containers: Container[] }   // images have user, ports, healthcheck, layers
      │   ├─ registry: Image[] (registry.acme.dev/…)
      │   ├─ database: ManagedPostgres{ provisioned, plan, tables, indexes, connections, cpuPct, slowQueries }
      │   ├─ ci: { pipelines[], runs[], deployments[] }             // deployments support rollback
      │   ├─ monitoring: { agentInstalled, series{metric→Point[]}, alertRules[], incidents[] }
      │   ├─ economy: { infraLineItems[], monthlyCost, costHistory[] }
      │   ├─ audit: AuditEvent[]                                    // everything noteworthy, feeds postmortems
      │   └─ flags: Record<string, boolean>                         // durable world facts (logrotate installed, root ban, …)
      ├─1 MissionState ── completed[], current, hintsUsed{}, ratings{}, attempts{}
      └─* Incidents/Postmortems (owned by monitoring; PM has timeline, rootCause, correctiveActions)
```

**Key emergent couplings** (this is the game): missing DB index → seq scans →
db.cpuPct↑ → p95↑ → users/satisfaction↓. Disk growth without logrotate →
`ENOSPC` → error rate↑. Bad image deploy → error rate↑ → incident → rollback.
Every coupling is implemented in the tick engine, not scripted dialogue.

## 5. Database Schema

Slice: JSON snapshot via `Storage` (single-player local). Phase 2: PostgreSQL —
full DDL in [`db/schema.sql`](../db/schema.sql) (players, games, game_snapshots,
resources, mission_progress, incidents, deployments, audit_log, metrics_hourly,
costs_daily, skills). The slice's `Storage` interface (`load/save/list/delete`)
is the seam.

## 6. Backend Architecture

```
server/src/
  index.ts            Express app: REST API + static hosting of built web app
  api.ts              Route handlers (thin; delegate to engine)
  state.ts            Storage interface + JSON snapshot implementation
  engine.ts           Mission engine: progression, validators, hints, scoring
  sim/
    fs.ts             Virtual filesystem (nodes, modes, owners, sizes)
    shell.ts          Lexer/parser: quotes, pipes, redirects, ;, env prefixes
    host.ts           SimHost + ~60 command implementations (ls, ps, systemctl,
                      ss, journalctl, curl, dig, chmod, apt, psql, bash …)
    git.ts            Git sim: init/add/commit/branch/merge/conflicts/log/diff
    docker.ts         Dockerfile parser + builder + container runtime + registry
    db.ts             Managed Postgres sim: SQL subset, planner (Seq vs Index Scan),
                      indexes, connections, cpu model
    ci.ts             Pipeline YAML validation + stage runner + deployments +
                      staging/e2e/approval gates
    k8s.ts            Kubernetes sim: manifest apply, pod lifecycle, rolling
                      updates, HPA, kubectl command engine
    terraform.ts      HCL subset parser, state, plan/apply/import, drift detection
    metrics.ts        Series store + generators (req rate, error%, p95, cpu, disk…)
    world.ts          Tick engine (1 sim-minute), economy, event scheduler,
                      incident triggers/resolution (incl. data-loss DR drills),
                      backups, audit
    net.ts            In-sim HTTP router (curl→nginx→app→db→k8s), DNS resolver
  missions/
    missions.ts       DATA: 20 missions (14 playable in slice) as typed records
    validators.ts     Requirement checks: pure functions over world state
```

REST API (all JSON, polled view-model at 1.5s + refresh-on-action):
`POST /api/games` · `GET /api/games` · `GET /api/games/:id` (view-model incl.
mission requirement pass/fail, metrics, architecture nodes) ·
`POST /api/games/:id/terminal` (command → output lines + prompt) ·
`GET/PUT /api/games/:id/file`, `GET …/fs` · `POST …/mission/:id/hint` ·
`POST …/ci/run` · `POST …/db/query` · `POST …/cloud/provision` ·
`POST …/deployments/:id/rollback` · `POST …/monitoring/alerts` ·
`POST …/time` (pause/speed) · `POST …/postmortem`.

## 7. Frontend Architecture

Single-page React app, dark IDE aesthetic. Components:

```
web/src/
  App.tsx            Landing (new/resume game) → GameShell
  GameShell.tsx      TopBar (cash/users/day/uptime/speed) + Sidebar + View router
                     + IncidentBanner + MissionDock
  views/ Dashboard (arch map + KPIs) · Terminal · Editor · CI · Database ·
        Monitoring · Costs · Postmortem modal
  components/ ArchMap (SVG, click-for-detail) · MissionCard (live ✓/✗ checklist,
        progressive hints) · Sparkline · CodeEditor · FileTree · MetricCard ·
        TerminalPane (history, ↑/↓, password prompts, tabs per host)
  lib/ api.ts (typed client) · highlight.ts (tokenizer for yaml/dockerfile/…)
```

UX rules (spec §44): the mission dock always shows *what's broken and what I
can inspect*; every metric that matters is one click deep; red = customer
impact; every panel answers "what can I change here?".

## 8. Infrastructure Simulation Architecture

The sim is a set of cooperating modules behind `World`, ticked at 1 sim-minute
per real second (speed ×1/×4/×16, pausable):

```
World.tick(dt)
 ├─ Traffic model: req/s = f(users, hour-of-day) 
 ├─ App model: cpu=f(req/s, capacity), error%=f(bugs, ENOSPC, deps), p95=f(cpu,db)
 ├─ Postgres model: cpu=f(queries, seqScanRatio), connections
 ├─ Disk model: logs grow unless logrotate flag; ENOSPC at 100%
 ├─ Metrics: push points into series (90 min window @1min, 30d @1h)
 ├─ Alerts: evaluate rules → firing/ok; open/auto-resolve incidents
 ├─ Events: scheduled & probabilistic (traffic spike, disk-full, bad deploy…)
 ├─ Economy: infra costs accrue; revenue = f(users, satisfaction)
 ├─ Uptime: downtime minutes accrue while error%>5 or health failing
 └─ Audit: append events
```

**Simulated network:** `curl api.acme.dev` → DNS table → IP → host → port →
nginx (parses its config file) → app process/container → response template.
`dig`, `ping`, `ss -tulpn` all read the same truth. There is one source of
truth (the World), so debugging is *real debugging*.

**Docker sim:** Dockerfile parser (FROM/WORKDIR/COPY/RUN/ENV/EXPOSE/USER/CMD/
HEALTHCHECK, multi-stage), layer sizes from a base-image table, build cache on
re-run, `docker run` binds ports into the host's listener table, healthchecks
after warmup, push to `registry.acme.dev`, non-root/port/health validations.

**Postgres sim:** tables `users`, `orders` (1M rows virtual), SELECT/INSERT/
UPDATE/DELETE/CREATE INDEX + `EXPLAIN` printing Seq Scan vs Index Scan; index
presence changes planner output *and* the live DB-CPU metric.

**Git sim:** real DAG (commits, parents, trees as file-maps), staging area,
branches, three-way merge with conflict markers on collision, `push` to a
simulated remote, tag. Requires `git config user.email` first — like the real thing.

## 9. Mission System Architecture

Missions are **data** (`missions/missions.ts`, spec §49): id, phase, title,
story (from "your manager"), objective, skills taught, requirements
`[{id, label, check(world)}]`, progressive hints ×3 (each costs score),
rewards (cash + skill XP + unlock), failure coaching (why common attempts
fail), triggers (event scheduling after completion).

The engine polls requirements after every mutating action and each tick;
the UI renders the live checklist. Completion → rating (S/A/B/C from hints +
failed attempts + sim-time), reward modal, next mission, audit entry.

## 10. The Mission Curriculum (40)

✅ = playable in the shipped build (P0 + P1 + P2).

| # | Mission | Teaches | Status |
|---|---|---|---|
| 1 | **Day One: the handoff note** | SSH, users, auth, the terminal itself | ✅ |
| 2 | **The case of the dead API** | ps, journalctl, ss, EADDRINUSE, kill, systemctl, curl | ✅ |
| 3 | **Root cause: permissions** | chmod/chown, service users, least privilege | ✅ |
| 4 | **The front door** | install nginx, reverse proxy 80→8080, firewall, reload | ✅ |
| 5 | **What's in a name?** | DNS A records, dig, TTL, curl by hostname | ✅ |
| 6 | **Version control or chaos** | git init/config/.gitignore/commit | ✅ |
| 7 | **Branches & the merge conflict** | branch/merge/resolve conflict markers | ✅ |
| 8 | **Secrets don't belong in code** | env vars, .env, config injection, rotation habit | ✅ |
| 9 | **Ship it in a box** | Dockerfile (non-root, EXPOSE 8080, HEALTHCHECK), build/run | ✅ |
| 10 | **Robots deploy on Fridays too** | CI pipeline YAML: test→build→docker→push→deploy | ✅ |
| 11 | **The database moves out** | provision managed Postgres, migrations, DATABASE_URL, psql | ✅ |
| 12 | **If you can't measure it** | metrics agent, dashboards, alert rules (error%, CPU) | ✅ |
| 13 | **INCIDENT: the disk that ate the logs** | df/du, ENOSPC forensics, logrotate | ✅ |
| 14 | **INCIDENT: Friday deploy gone wrong** | error-rate spike, rollback, postmortem + corrective actions | ✅ |
| 15 | **The index that saved the bill** | EXPLAIN, Seq→Index scan, live DB-CPU coupling | ✅ |
| 16 | **One server is a single point of failure** | LB, 2nd VM, health checks, chaos failover drill | ✅ |
| 17 | **Clicking on purpose** | staging deploys, e2e gates that catch regressions, production approvals | ✅ |
| 18 | **Under new management** | Terraform: describe+import manual infra, plan/apply, console drift | ✅ |
| 19 | **Pods of plenty** | Kubernetes: Deployment/Service/Ingress, probes, rolling updates, HPA | ✅ |
| 20 | **Out of region, out of mind** | backups, data-loss incident, PITR restore, RPO/RTO, postmortem | ✅ |
| 21 | **The platform team** | hiring, roles & salaries, on-call rotation, being paged | ✅ |
| 22 | **Paying down the mortgage** | technical-debt ledger, refactoring projects, incident odds | ✅ |
| 23 | **Canary in the coal mine** | progressive delivery: 10% canary, auto-abort, promotion | ✅ |
| 24 | **Promises you can keep** | SLOs, error budgets, burn rate, shipping within budget | ✅ |
| 25 | **Between two clouds** | provider comparison (price × reliability × latency), provider outages, SLA credits | ✅ |
| 26 | **Moving day** | migration project with a rehearsed cutover (downtime shrinks with preparation) | ✅ |
| 27 | **The second product** | product portfolio, gated enterprise tier, product MRR | ✅ |
| 28 | **Where the money goes** | FinOps: budgets, unit economics, rightsizing recommendations, reserved compute | ✅ |
| 29 | **The content engine** | mission packs: JSON bundles, bonus mission track, tournament activation | ✅ |
| 30 | **The postmortem tournament** | five scored incident rounds (MTTR, corrective actions, credits, restores) vs rival teams | ✅ |
| 31 | **The constraints game** | challenge mode: budget cap / windowed availability / RTO under a surprise disaster | ✅ |
| 32 | **Everyone ships** | accessibility (contrast, text size, motion, keyboard) + interface localization (EN/ES/DE) | ✅ |
| 33 | **The keys to the kingdom** | secrets manager: managed secrets, dynamic DB credentials, zero-downtime rotation, leak scan | ✅ |
| 34 | **Nobody gets root** | zero trust: service identities + STRICT mTLS, default-deny NetworkPolicy, runAsNonRoot | ✅ |
| 35 | **Chain of custody** | supply chain: cosign signing, SBOM attestations, admission policy blocking unsigned images | ✅ |
| 36 | **The auditor cometh** | compliance: access review, append-only audit store, live findings, evidence bundles | ✅ |
| 37 | **Golden paths** | internal developer portal: self-service deploy templates, devs shipping without tickets | ✅ |
| 38 | **Every PR gets a stage** | ephemeral preview environments per CI run with auto-destroy | ✅ |
| 39 | **Follow the trace** | distributed tracing: spans across lb→api→db, latency attribution, connection pooler fix, db-latency alerting | ✅ |
| 40 | **The acquisition** | capstone: five-pillar due diligence (security, reliability, FinOps, team, portfolio), term sheet, announcement scale event, legend mode | ✅ |

## 11. First Playable Vertical Slice (scope of this delivery)

Company creation → mission 1 → … → mission 14, covering: SSH & Linux
forensics, systemd, nginx, DNS, git with a real merge conflict, env/secrets,
Docker (validated Dockerfile), CI pipeline with runnable stages + deployments +
rollback, managed Postgres provisioning + SQL console with EXPLAIN, monitoring
agent + alert rules + live metrics, economy (cash, infra line items, revenue),
two full incidents (disk-full, bad deploy) with postmortems & corrective
actions, interactive architecture map, autosave/resume, tutorial + career +
sandbox flags. Plus: vitest suite covering shell, fs, git, docker, db planner,
CI, missions, incidents, economy, persistence, and a scripted end-to-end
mission-chain integration test.

## 12. Phased Roadmap

- **P0 (shipped):** vertical slice — missions 1–14 (Linux → Docker → CI → DB →
  monitoring → incidents) plus economy, autosave, tutorial/career/sandbox.
- **P1 (shipped):** platform depth — HA (2nd VM + LB + chaos drill), DB
  performance (EXPLAIN + index), staging + e2e + approval-gated CI (m17),
  Terraform sim with drift (m18), Kubernetes sim with probes/rollouts/HPA
  (m19), backups + data-loss DR drill with RPO/RTO (m20).
- **P2 (shipped):** operate & grow — team hiring with roles/salaries and an
  on-call rotation (m21), technical-debt ledger seeded from play history with
  refactoring projects and incident-probability coupling (m22), canary
  releases with auto-abort/auto-promote plus blue-green (m23), SLOs with
  error-budget burn math (m24), marketing campaigns, and an optional
  PostgreSQL storage backend (`SHIPIT_PG_URL`) behind the async `Storage` seam.
- **P3 (shipped):** ecosystem — fictional cloud providers (Stratus/Volt/Orbit)
  with regional pricing/reliability/latency tradeoffs and ambient provider
  outages with claimable SLA credits (m25), whole-footprint migration projects
  whose cutover downtime shrinks with preparation (m26), a product portfolio
  with a gated enterprise tier (m27), and FinOps tooling: budgets with a daily
  scoreboard, unit economics, utilization-based rightsizing recommendations
  and reserved-compute commitments (m28).
- **P5 (shipped):** trust & scale — security & compliance arc (P5a): a vault sim with generated secrets, dynamic DB credentials and zero-downtime rotation (m33); zero trust via a service mesh with STRICT mTLS, NetworkPolicies and runAsNonRoot (m34); a supply chain with cosign signing/SBOM and a cluster admission policy that physically blocks unsigned images (m35); and a compliance layer with live findings, access review, append-only audit storage and evidence bundles (m36). Platform-engineering endgame (P5b): an internal developer portal with golden paths and a self-service deploy feed (m37); ephemeral per-run preview environments (m38); distributed tracing with latency attribution, a pgbouncer fix and db-latency alerting (m39); and the acquisition capstone — five due-diligence pillars over real world state, a term sheet, an announcement scale event and endless legend mode (m40).
- **P4 (shipped):** modes & content at scale — challenge mode (m31): three
  graded constraint runs (an 18% austerity budget cap, a 99.5% windowed
  availability audit with pop quizzes, an unannounced database drop with an
  RTO stopwatch), daily verdicts, scores and stars; mission pack format (m29):
  JSON bundles with a declarative requirement DSL over world state, a parallel
  bonus mission track, and packs droppable into `packs/`; the postmortem
  tournament (m30): the first pack — five live-incident rounds scored on MTTR,
  corrective actions, SLA credits and restores, against rival teams ticking on
  a live scoreboard; accessibility & localization (m32): high contrast, large
  text, reduced motion, Alt+1…9/0 tab navigation, aria-live terminal and
  status regions, and interface chrome in English/Spanish/German.
- **P6 (in progress — the Scale Era, see `docs/P6-SCALE-ERA.md`):** makes the
  game endless on purpose after the acquisition. **6a (shipped): the honest
  economy** — accepting the m40 term sheet starts `world.era`, which turns on
  load-coupled billing (L7 requests with a 2B/mo included tier, egress at
  8 KB/req, log ingestion, backup object storage, a managed-DB utilization
  surcharge above 70% CPU) and real compute utilization: every VM/node serves
  ~200 req/s, latency bends above 70% fleet utilization, overload past 100%
  becomes 5xx, and the k8s node pool can scale to 500 nodes (2–4 in the
  campaign). The COSTS tab grows a live burn view ($/sim-hour, projected
  month-end, cost per user, margin, fleet utilization). **6b (shipped):
  capacity levers + scale stages** — four era levers, each answering one
  pressure: a CDN/edge cache (basic 60% / pro 85% hit ratio; edge hits never
  touch the origin bill, egress or fleet), async queue workers ($35/mo each,
  40 jobs/s drained — writes beyond the drain wait in a backlog instead of
  hammering the DB), a read replica (~60% of reads off the primary, with real
  replication lag that turns into stale reads past 250 ms), and a secondary
  region (footprint ×1.5 with half-size standby — a regional outage now fails
  over through a 3-minute DNS glitch instead of ending the world). The stage
  engine derives S1–S5 from users (10k/100k/1M/10M/100M), announces each once
  in the audit feed, and turns on the pressure: cache stampedes at S2, write
  share 0.2→0.35 and 100× log growth at S3, 1000× logs at S4, composite
  crises on random timers at S5. The tuning gate now pins both curves: naive
  infra/revenue ≈12% at 100k → ≈43% at 1M → ≈46% at 10M; engineered (all
  levers pulled) holds ≤25% at any scale. **6c (shipped): consequences of
  being big** — incidents now cost cash directly (resolving debits refunds &
  SLA credits at $0.03/user-hour for a Sev-1, $0.01 for a Sev-2 — at 1M users
  a Sev-1 hour is a $30k ledger event); the on-call load is the engineer-
  minutes economy: demand = fleet×15 + open incidents×90 + debt×8 minutes/day,
  discounted by automation (developer portal −25%, each published golden path
  −3%, written SLOs −10%), and when pages outpace the team engineers accrue
  burnout — at 100% they quit, dragging satisfaction with them (the era lifts
  the 6-engineer hiring cap to 40). Beyond ~6 engineers without the portal,
  the coordination tax plants deploy regressions with odds scaling with
  headcount. Single-region fleets at S3+ draw provider outages at double odds
  and carry a `single-region` compliance finding, and enterprise-tier product
  revenue drops 30% while any compliance finding is open — posture gates
  revenue. The COMPANY tab shows the on-call load meter, per-engineer
  burnout, and the incident ledger total. **6d (shipped): the era mode** —
  growth paces like an incremental game (stage-scaled multiplier ×12 at S2 up
  to ×21 at S5, plus a CRANK A DAY control that fast-forwards a sim day and
  lets the world happen at you), R&D lands as the money sink (five levels,
  $50k escalating, +8% growth each), and the product pipeline comes alive:
  era products ramp toward a peak adoption, mature after 30 days, then decay
  — SHIP v-next refresh releases reset the decay and raise the ceiling — and
  a new backlog idea accrues every 10 sim days up to a 12-product catalog.
  The MODES tab legend section is now the Scale Era panel (era day, stage,
  next milestone, crank, R&D). **6e (shipped): the race** — three rival
  archetypes run the same market on the same tick: Goliath Cloud buys scale
  with money (fast growth, 42% margin, rare outages), Leanframe runs lean and
  fragile (best margin, big outages), Steady Systems is boring and reliable;
  they publish postmortems and poach your users whenever your error rate
  burns. The Robustness Rating (0–100) scores availability vs 99%, error
  budget, MTTR, days since Sev-1 and blast-radius containment; live valuation
  = annual MRR × a 3–9.5× robustness-and-growth multiple (the m40 term sheet,
  every day); the Ship It Index is robustness-weighted worth, so robust
  systems literally rank richer. Milestones ($1M MRR club, 99.99% held at
  1M users, provider outage survived with zero downtime, margin ≤25% at 10M,
  the 100M summit) land as badges, and any-moment run summaries compress into
  offline-decodable share codes (SI-…). **P6 complete — the game is endless
  on purpose.**

## 13. Definition of Done — slice checklist

All spec §51 items: create company ✅ receive server ✅ terminal ✅ Linux
missions ✅ git ✅ deploy app ✅ containerize ✅ config ✅ infra (cloud console:
DNS, firewall, managed DB) ✅ deploy ✅ monitor ✅ architecture map ✅ costs ✅
incident → investigate → fix ✅ new version deploy ✅ company grows ✅
save & resume ✅. It must feel like a game, not a demo — the world reacts,
keeps score, and remembers.
