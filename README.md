# SHIP IT — DevOps Company Simulator

A learn-by-doing DevOps game. You are the first platform hire of a tiny startup:
one broken Linux server, a demo at 10:30, no CI, no monitoring, no backups.
Build the platform. Then run the company.

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
npm test               # 113 tests incl. a full m01→m28 mission-chain integration test
```

Requires Node 18+ (`node` on PATH).

## The game

- **BUILD PHASE (20 missions, playable):** SSH & Linux forensics → systemd →
  permissions → nginx reverse proxy → DNS → git (with a real merge conflict) →
  secrets → Docker (validated Dockerfile) → CI/CD pipeline → managed Postgres →
  monitoring → **INCIDENT: disk full** → **INCIDENT: bad deploy** →
  DB saturation under 6× traffic (EXPLAIN + index) → **HA: second VM + load
  balancer + chaos failover drill** → staging + e2e + **approval-gated deploys**
  → **Terraform** (import, plan, drift, apply) → **Kubernetes** (Deployment
  probes, Service, Ingress, zero-downtime rollout, HPA) → **backups & DR**
  (data-loss incident, PITR restore, RPO/RTO, postmortem).
- **OPERATE PHASE (missions 21–24 + open-ended):** hire a **team** with an
  on-call rotation (SREs answer in 40s, seniors calm incident odds) · a
  **technical-debt ledger** seeded from your actual history — refactoring
  projects pay it down, unpaid debt raises incident probability · **canary
  releases** (10% traffic, auto-abort on error spike, auto-promote when clean;
  blue-green also supported) · **SLOs with error budgets** (availability + p95,
  burn-rate math, budget-exhausted freeze) · marketing campaigns, ambient
  incidents, and the world keeping happening.
- **ECOSYSTEM PHASE (missions 25–28 + open-ended):** three fictional cloud
  providers (**Stratus / Volt / Orbit**) with regional price × reliability ×
  latency tradeoffs, provider outages you cannot fix (only price — claim the
  SLA credit) · **migration projects** whose cutover downtime shrinks with
  preparation (backups, staging, LB, k8s) · **products** (a second product
  line; the enterprise tier is gated on SLOs, satisfaction and team size) ·
  **FinOps**: budgets with a daily under/over scoreboard, unit economics
  (cost/user, margin), utilization-based rightsizing recommendations (idle VM,
  oversized DB, node pool, reserved compute) — every line item tagged by
  provider/region.
- Requirements are checked against **world state**, not clicks. Hints are
  progressive and cost rating (S/A/B/C). Failure is content: broken YAML gives
  you CrashLoop-style symptoms to debug.

## What's actually simulated (server-side)

| Module | What it does |
|---|---|
| `sim/fs.ts` + `sim/host.ts` | Virtual Linux host: ~50 commands (systemctl, journalctl, ss, ps, df, chmod, ufw, apt…), users, processes, services, packages, disk |
| `sim/shell.ts` | Real lexer/parser: quotes, pipes, redirects, `;`, `&&`/`\|\|`, env expansion |
| `sim/net.ts` | In-sim HTTP: curl → DNS table → host → nginx config → app; load balancer with health-checked backends and failover; dig, ping |
| `sim/git.ts` | Commit DAG, staging, branches, three-way merge with conflicts, push/pull — plus revert, fetch, restore, reset (soft/mixed/hard), stash, cherry-pick, mv, rm, branch -d, show, blame, `git -C`, `git help` |
| `sim/docker.ts` | Dockerfile parser (multi-stage, USER/EXPOSE/HEALTHCHECK), layered builds with plausible sizes, run/stop/logs/push/registry |
| `sim/ci.ts` | Pipeline YAML validation + stage runner + deployments + rollback + **staging deploys, e2e gates, production approval gates, canary & blue-green strategies** |
| `sim/k8s.ts` | Kubernetes cluster: manifest apply (Deployment/Service/Ingress/HPA), pod lifecycle with CrashLoopBackOff, rolling updates with zero-downtime proof, HPA autoscaling, kubectl |
| `sim/terraform.ts` | HCL subset: init/validate/plan/apply/import, state management, console **drift detection** and reconciliation |
| `sim/cloud.ts` | Fictional cloud providers (Stratus/Volt/Orbit): regional price × reliability × latency catalog, footprint multipliers, SLA-credit and cutover-downtime math |
| `sim/dbsim.ts` | Postgres subset with EXPLAIN: Seq Scan → Index Scan changes live DB CPU |
| `world.ts` | Tick engine (simulated minutes): traffic, metrics, alerts, incidents (incl. data-loss DR drills), backups, **team/on-call, technical debt, canary lifecycle, SLOs, marketing**, **provider outages, migrations, products, FinOps budgets & recommendations**, economy, audit |
| `engine.ts` + `missions/` | Data-driven missions (build + operate phases), validators over world state, hints, ratings |

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
simulation architecture, the 32-mission curriculum, and the phased roadmap
(P1 ✅ staging/e2e/approvals, Terraform, Kubernetes, backups/DR; P2 ✅ team &
on-call, technical debt, canary/blue-green, SLOs, PostgreSQL storage; P3 ✅
multi-cloud providers, migrations, products, FinOps; P4 ✅ challenge mode
[budget/availability/RTO], mission packs as JSON bundles with the postmortem
tournament, accessibility [high contrast / large text / reduced motion,
Alt+tab navigation] and localization [EN/ES/DE chrome]).

### Mission packs (P4)

Packs are JSON bundles: drop `your-pack.json` into [`packs/`](packs/) and it
loads at startup (or `POST` it to the registry). Missions declare requirements
over world state in a small condition DSL (`flag`, `incidentResolved`,
`postmortemFiled`, `mttrWithin`, …) plus declarative `onStart` hooks — no code
required. The built-in [`packs/postmortem-tournament.json`](packs/postmortem-tournament.json)
is the reference implementation: five scored incident rounds against rival teams.
