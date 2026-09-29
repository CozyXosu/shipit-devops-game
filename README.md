# SHIP IT — DevOps Company Simulator

A learn-by-doing DevOps game. You are the first platform hire of a tiny startup:
one broken Linux server, a demo at 10:30, no CI, no monitoring, no backups.
Build the platform. Then run the company — through the acquisition and into
the endless Scale Era.

![Dashboard](docs/img/dashboard.png)

Everything runs **locally and fully simulated** — no real cloud, no real bills,
and player commands never touch your host OS.

| | |
|---|---|
| ![Missions](docs/img/missions.png) | ![Cloud console](docs/img/cloud.png) |

## Quick start

```bash
npm install
npm --prefix web install
npm run start          # builds the web UI, serves everything on http://localhost:4100
```

Open **http://localhost:4100**, found your company, and read the handoff note.

Dev mode (hot reload):

```bash
npm run dev:server     # API on :4100
npm run dev:web        # Vite dev server on :5173 (proxies /api)
```

Tests:

```bash
npm test               # 224 tests across 18 suites, incl. a full m01→m40 mission-chain integration test and the Scale Era economy
```

Requires Node 18+ (`node` on PATH).

## The game — 40 missions, five phases, then the Scale Era

- **BUILD (missions 1–20):** SSH & Linux forensics → systemd → permissions →
  nginx reverse proxy → DNS → git (with a real merge conflict) → secrets →
  Docker (validated Dockerfile) → CI/CD pipeline → managed Postgres →
  monitoring — **fog of war**: no telemetry exists before you install the
  agent, so outages surface as customer tickets instead of alerts →
  **INCIDENT: disk full** → **INCIDENT: bad deploy** →
  DB saturation under 6× traffic (EXPLAIN + index) → **HA: second VM + load
  balancer + chaos failover drill** → staging + e2e + **approval-gated deploys**
  → **Terraform** (import, plan, drift, apply) → **Kubernetes** (Deployment
  probes, Service, Ingress, zero-downtime rollout, HPA) → **backups & DR**
  (data-loss incident, PITR restore, RPO/RTO, postmortem).
- **OPERATE (21–24):** hire a **team** with an on-call rotation (SREs answer in
  40s, seniors calm incident odds) · a **technical-debt ledger** seeded from your
  actual history — refactoring projects pay it down, unpaid debt raises incident
  probability · **canary releases** (10% traffic, auto-abort on error spike,
  auto-promote when clean; blue-green also supported) · **SLOs with error
  budgets** (availability + p95, burn-rate math, budget-exhausted freeze).
- **ECOSYSTEM (25–28):** three fictional cloud providers (**Stratus / Volt /
  Orbit**) with regional price × reliability × latency tradeoffs, provider
  outages you cannot fix (only price — claim the SLA credit) · **migration
  projects** whose cutover downtime shrinks with preparation · **products** (a
  second product line; the enterprise tier is gated on SLOs, satisfaction and
  team size) · **FinOps**: budgets with a daily under/over scoreboard, unit
  economics, utilization-based rightsizing recommendations, reserved compute —
  every line item tagged by provider/region.
- **MODES AT SCALE (29–32):** **mission packs** — JSON bundles with a
  declarative requirement DSL, droppable into `packs/` · the **postmortem
  tournament** — five scored live-incident rounds (MTTR, corrective actions,
  SLA credits, restores) against rival teams on a live scoreboard ·
  **challenge mode** — three graded constraint runs (an austerity budget cap, a
  windowed availability audit, an unannounced database drop with an RTO
  stopwatch) · **accessibility & localization** — high contrast, large text,
  reduced motion, Alt+1…9/0 tab navigation, aria-live terminal, and interface
  chrome in English / Spanish / German.
- **TRUST (33–36):** a **secrets vault** with dynamic DB credentials and
  zero-downtime rotation · **zero trust** — service mesh with STRICT mTLS,
  default-deny NetworkPolicies, `runAsNonRoot` · the **supply chain** — cosign
  image signing, SBOM attestations, and an admission policy that physically
  blocks unsigned images from the cluster · **compliance** — live findings,
  access review, append-only audit store, evidence bundles for the auditor.
- **PLATFORM (37–40):** an **internal developer portal** with golden paths and
  self-service deploys · **ephemeral preview environments** per CI run ·
  **distributed tracing** with latency attribution and a pgbouncer fix · the
  **acquisition capstone** — five-pillar due diligence over real world state, a
  term sheet, an announcement scale event.
- **THE SCALE ERA (after 40 — endless, no authored missions):** the sale is
  the starting gun. The **honest economy**: infra bills by usage — requests
  (first 2B/mo included), egress, log ingestion, backup storage, a managed-DB
  surcharge above 70% CPU — every VM/node serves ~200 req/s (latency bends at
  70% fleet utilization, overload past 100% is 5xx), and the COSTS tab shows a
  live burn view ($/sim-hour, projected month-end, cost per user, margin) ·
  **capacity levers**: a CDN whose edge hits never touch your origin bill,
  async queue workers with real backlogs, a read replica with replication lag
  (stale reads past 250 ms), a secondary region with genuine failover ·
  **scale stages S1–S5** (10k → 100M users) emerge from traffic: cache
  stampedes, a heavier write mix, log growth that re-opens the logrotate
  lesson at 100×/1000×, composite crises on random timers · **consequences of
  being big**: resolving an incident debits a refund ledger scaled to your
  users, the on-call load is an engineer-minutes economy (portal, golden paths
  and SLOs buy minutes back; 100% burnout = resignation), teams past six
  engineers without a portal ship regressions, and enterprise revenue drops
  while compliance findings are open · **era mode**: stage-scaled growth
  pacing, CRANK A DAY, R&D as a money sink, and a product pipeline that lives
  (ramp → mature → decay → refresh releases) while new ideas accrue in the
  backlog · **the race**: three rival companies with distinct strategies, a
  0–100 Robustness Rating, live valuation, the robustness-weighted Ship It
  Index, milestone badges, and offline-decodable share codes.
- Requirements are checked against **world state**, not clicks. Hints are
  progressive and cost rating (S/A/B/C). Failure is content: broken YAML gives
  you CrashLoop-style symptoms to debug.

## Built for learning, not for trivia

- **Fog of war.** The world simulates everything, but you only see what
  instrumentation has seen. Until the observability agent is installed the
  dashboards are empty, alert rules cannot exist, and an outage is detected
  by *customers* — after ~40 sim-minutes of undetected damage, with support
  tickets as the only breadcrumbs. The manual channel (ssh, `df`, `journalctl`,
  vendor consoles for the managed DB and cloud volume) always works; installing
  the agent buys *continuous* sight, starting at install time (no backfill).
- **Lessons, free, before every authoring task.** The 13 file-authoring
  missions (nginx conf, Dockerfile, pipeline YAML, K8s manifests, HCL,
  NetworkPolicies, …) ship with a collapsible 📘 lesson in the mission dock:
  what the format is and why it exists, a syntax cheat-sheet, a fully annotated
  line-by-line example, and where the file lives. Reading a lesson never costs
  a hint or your rating.
- **Starter scaffolds.** Eight of those missions also give you a commented TODO
  template — one click loads it in the editor, you fill the blanks with
  understanding and delete the training wheels.
- **A real editor.** Recursive file tree (`.ci/`, `k8s/`, systemd units…),
  in-browser new-file creation, save warnings ("unit file changed — run
  `daemon-reload`").
- **⚡ Solve it for me.** Stuck? Every mission has an executable canonical
  walkthrough that plays the solution server-side and shows a step-by-step
  transcript of what it did — a worked demo you can learn from and replay by
  hand afterwards.

## What's actually simulated (server-side)

| Module | What it does |
|---|---|
| `sim/fs.ts` + `sim/host.ts` | Virtual Linux host: ~50 commands (systemctl, journalctl, ss, ps, df, chmod, ufw, apt…), users, processes, services, packages, disk |
| `sim/shell.ts` | Real lexer/parser: quotes, pipes, redirects, `;`, `&&`/`\|\|`, env expansion |
| `sim/net.ts` | In-sim HTTP: curl → DNS table → host → nginx config → app; load balancer with health-checked backends and failover; preview-environment URLs; dig, ping |
| `sim/git.ts` | Commit DAG, staging, branches, three-way merge with conflicts, push/pull — plus revert, fetch, restore, reset (soft/mixed/hard), stash, cherry-pick, mv, rm, branch -d, show, blame, `git -C`, `git help` |
| `sim/docker.ts` | Dockerfile parser (multi-stage, USER/EXPOSE/HEALTHCHECK), layered builds with plausible sizes, run/stop/logs/push/registry, cosign signing + SBOM flags |
| `sim/ci.ts` | Pipeline YAML validation + stage runner + deployments + rollback + staging deploys, e2e gates, production approval gates, canary & blue-green strategies, ephemeral previews |
| `sim/k8s.ts` | Kubernetes cluster: manifest apply (Deployment/Service/Ingress/HPA + NetworkPolicy & admission Policy), pod lifecycle with CrashLoopBackOff, rolling updates with zero-downtime proof, HPA autoscaling, kubectl, mTLS identities, signed-image admission |
| `sim/terraform.ts` | HCL subset: init/validate/plan/apply/import, state management, console **drift detection** and reconciliation |
| `sim/cloud.ts` | Fictional cloud providers (Stratus/Volt/Orbit): regional price × reliability × latency catalog, footprint multipliers, SLA-credit and cutover-downtime math |
| `sim/dbsim.ts` | Postgres subset with EXPLAIN: Seq Scan → Index Scan changes live DB CPU; pgbouncer pooler |
| `sim/vault.ts` | Secrets manager: generated secrets, dynamic DB credentials, zero-downtime rotation, leak scan |
| `world.ts` | Tick engine (simulated minutes): traffic, metrics, alerts, incidents (incl. data-loss DR drills), backups, team/on-call with burnout, technical debt, canary lifecycle, SLOs, marketing, provider outages, migrations, products with lifecycles, FinOps budgets & recommendations, zero-trust mesh, compliance findings, developer portal, traces, acquisition endgame, and the scale-era economy — usage billing, capacity levers (CDN/queue/replica/multi-region), stage engine, on-call load, rivals and race boards — economy, audit |
| `engine.ts` + `missions/` | Data-driven missions across five phases plus the endless era, validators over world state, hints, ratings, free lessons, auto-solve walkthroughs |

## Persistence

Games autosave to `data/games.json` (atomic writes) — close the tab, come back,
resume. Want PostgreSQL instead? Point the game at a database:

```bash
SHIPIT_PG_URL=postgres://user:pass@localhost:5432/shipit npm run start
```

The `Storage` interface (`server/src/state.ts`) is the seam; the PG backend
falls back to JSON automatically if the database is unreachable. The
multi-user schema target lives in [`db/schema.sql`](db/schema.sql).

## Design & roadmap

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full product spec, domain model,
simulation architecture, the 40-mission curriculum, and the phased roadmap —
all shipped: P0 vertical slice · P1 platform depth (HA, DB perf, staging/e2e/
approvals, Terraform, Kubernetes, backups/DR) · P2 operate & grow (team &
on-call, technical debt, canary/blue-green, SLOs, PostgreSQL storage) · P3
ecosystem (multi-cloud providers, migrations, products, FinOps) · P4 modes at
scale (challenge mode, mission packs + postmortem tournament, accessibility,
EN/ES/DE) · P5 trust & scale (vault, zero trust, supply chain, compliance,
developer portal, preview environments, tracing, acquisition capstone) · P6
the Scale Era (honest economy, capacity levers + scale stages, consequences
of being big, era mode, the race) — the game is endless on purpose.

### Mission packs (P4)

Packs are JSON bundles: drop `your-pack.json` into [`packs/`](packs/) and it
loads at startup (or `POST` it to the registry). Missions declare requirements
over world state in a small condition DSL (`flag`, `incidentResolved`,
`postmortemFiled`, `mttrWithin`, …) plus declarative `onStart` hooks — no code
required. The built-in [`packs/postmortem-tournament.json`](packs/postmortem-tournament.json)
is the reference implementation: five scored incident rounds against rival teams.
