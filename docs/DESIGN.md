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
    ci.ts             Pipeline YAML validation + stage runner + deployments
    metrics.ts        Series store + generators (req rate, error%, p95, cpu, disk…)
    world.ts          Tick engine (1 sim-minute), economy, event scheduler,
                      incident triggers/resolution, audit
    net.ts            In-sim HTTP router (curl→nginx→app→db), DNS resolver
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

## 10. The First 20 Missions

✅ = playable in the shipped vertical slice.

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
| 15 | Clicking on purpose | e2e tests, staging environment, approvals | Phase 2 |
| 16 | One server is a single point of failure | LB, 2nd VM, health checks, HA math | Phase 2 |
| 17 | Under new management | Terraform: import manual infra to code, plan/apply/drift | Phase 2 |
| 18 | Pods of plenty | Kubernetes: Deployment/Service/Ingress, probes, HPA | Phase 2 |
| 19 | The index that saved the bill | EXPLAIN, composite indexes, pooling, read replicas | Phase 2 (engine shipped) |
| 20 | Out of region, out of mind | backups, RPO/RTO, restore drill, regional failover | Phase 2 |

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

- **P0 (this delivery):** vertical slice above.
- **P1 — Platform depth:** Kubernetes sim (Deployments/Services/Ingress/probes/
  HPA/rolling updates), Terraform sim (HCL subset, plan/apply, drift), load
  balancer + second VM, backups/restore drill (missions 15–20).
- **P2 — Operate & Grow:** company sim depth (hiring w/ skill matrices,
  products, marketing events), technical-debt model, canary/blue-green,
  PostgreSQL storage backend (`db/schema.sql`), SLOs/error budgets.
- **P3 — Ecosystem:** fictional cloud providers (Stratus/Volt/Orbit) with
  regional pricing/reliability tradeoffs, migration projects, FinOps tooling.
- **P4 — Modes & content at scale:** Challenge mode (budget/availability/RTO
  constraints), mission pack format (JSON bundles), postmortem tournament,
  accessibility & localization.

## 13. Definition of Done — slice checklist

All spec §51 items: create company ✅ receive server ✅ terminal ✅ Linux
missions ✅ git ✅ deploy app ✅ containerize ✅ config ✅ infra (cloud console:
DNS, firewall, managed DB) ✅ deploy ✅ monitor ✅ architecture map ✅ costs ✅
incident → investigate → fix ✅ new version deploy ✅ company grows ✅
save & resume ✅. It must feel like a game, not a demo — the world reacts,
keeps score, and remembers.
