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
npm test               # 45 tests incl. a full m01→m14 mission-chain integration test
```

Requires Node 18+ (`node` on PATH).

## The game

- **BUILD PHASE (16 missions, playable):** SSH & Linux forensics → systemd →
  permissions → nginx reverse proxy → DNS → git (with a real merge conflict) →
  secrets → Docker (validated Dockerfile) → CI/CD pipeline → managed Postgres →
  monitoring → **INCIDENT: disk full** → **INCIDENT: bad deploy** →
  DB saturation under 6× traffic (EXPLAIN + index) → **HA: second VM + load
  balancer + chaos failover drill**.
- **OPERATE PHASE (unlocked after mission 16):** the world keeps happening —
  users, revenue, traffic spikes, ambient incidents, costs.
- Requirements are checked against **world state**, not clicks. Hints are
  progressive and cost rating (S/A/B/C). Failure is content: broken YAML gives
  you CrashLoop-style symptoms to debug.

## What's actually simulated (server-side)

| Module | What it does |
|---|---|
| `sim/fs.ts` + `sim/host.ts` | Virtual Linux host: ~50 commands (systemctl, journalctl, ss, ps, df, chmod, ufw, apt…), users, processes, services, packages, disk |
| `sim/shell.ts` | Real lexer/parser: quotes, pipes, redirects, `;`, `&&`/`||`, env expansion |
| `sim/net.ts` | In-sim HTTP: curl → DNS table → host → nginx config → app; load balancer with health-checked backends and failover; dig, ping |
| `sim/git.ts` | Commit DAG, staging, branches, three-way merge with conflicts, push/pull — plus revert, fetch, restore, reset (soft/mixed/hard), stash, cherry-pick, mv, rm, branch -d, show, blame, `git -C`, `git help` |
| `sim/docker.ts` | Dockerfile parser (multi-stage, USER/EXPOSE/HEALTHCHECK), layered builds with plausible sizes, run/stop/logs/push/registry |
| `sim/ci.ts` | Pipeline YAML validation + stage runner + deployments + rollback |
| `sim/dbsim.ts` | Postgres subset with EXPLAIN: Seq Scan → Index Scan changes live DB CPU |
| `world.ts` | Tick engine (simulated minutes): traffic, metrics, alerts, incidents, economy, audit |
| `engine.ts` + `missions/` | Data-driven missions, validators over world state, hints, ratings |

## Persistence

Games autosave to `data/games.json` (atomic writes) — close the tab, come back,
resume. The `Storage` interface (`server/src/state.ts`) is the seam for the
Phase-2 PostgreSQL backend (schema in [`db/schema.sql`](db/schema.sql)).

## Design & roadmap

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full product spec, domain model,
simulation architecture, the 20-mission curriculum, and the phased roadmap
(Phase 1+: Kubernetes, Terraform, load balancers, backups/DR; Phase 2+: team,
technical debt, multi-cloud, FinOps; Phase 3+: challenge mode, mission packs).
