# CURRENT_STATE

Concise snapshot of the repository's working state for future coding sessions.
Source of truth for design/roadmap: `docs/DESIGN.md`. If anything here looks stale,
verify against the repo (`git status --short`, recent log, actual files) — never
trust it blindly. Last updated: 2026-09-28 (P5 session).

## Project / Version

- SHIP IT — DevOps company simulator (TypeScript backend + React web UI). Player
  runs a fictional company's infrastructure through simulated Linux/Docker/CI/
  K8s/Terraform/cloud workflows, mission by mission.
- Version v0.4, roadmap P0–P5 all shipped (see `docs/DESIGN.md` §12).
  40 missions built (m01–m40).
- `package.json` version string still reads `0.1.0` — cosmetic, never bumped.

## Git

- Branch `main`. Last release: `47c4668` (v0.3, 32-mission game, pushed).
- Uncommitted local work: P5 ("Trust & Scale") implementation — missions
  m33–m40, sims, UI, tests, docs (this session). Not committed, not pushed.
- `data/` is gitignored: live save games are NOT in git.

## Implemented (verified)

- Backend (`server/src/`): Express API (`api.ts`), entry (`index.ts`, port 4100),
  world model (`world.ts`), tick engine, types (`types.ts`).
- Infra simulators (`server/src/sim/`): shell/fs, git, docker + registry, CI,
  database, Kubernetes, Terraform, cloud (Stratus/Volt/Orbit), net/DNS/firewall,
  monitoring, challenge mode, vault (P5).
- Missions m01–m40 (`server/src/missions/missions.ts`) + mission-pack system
  (`packs/`; postmortem-tournament pack).
- P5a security arc: `sim/vault.ts` (vault CLI: put/lease/rotate/scan),
  zero-trust mesh + STRICT mTLS (world.ts + CLOUD panel), NetworkPolicy +
  admission Policy manifest kinds + `cosign` CLI (host.ts, k8s.ts, docker
  signing/SBOM flags), compliance layer (live findings, access review,
  append-only audit store, evidence bundles — COMPANY tab panel).
- P5b platform endgame: developer portal (new PORTAL tab, golden paths,
  ticket-queue drain), ephemeral preview environments (`ci.previews`, preview
  step `uses: sim/preview`, URL serving in `sim/net.ts`), distributed tracing
  (`world.traces`, MONITORING → TRACING panel, pgbouncer in DATABASE tab),
  acquisition capstone (five-pillar due diligence, term sheet, announcement
  scale event, legend mode — COMPANY tab panel).
- Frontend (`web/src/`): React SPA — terminal, editors, cloud console, mission
  UI, PORTAL tab, accessibility, EN/ES/DE chrome (portal tab localized too).
- Storage: JSON file `data/games.json` by default; optional Postgres via
  `SHIPIT_PG_URL` behind the async `Storage` seam (`db/schema.sql`).
- Tests: 14 vitest suites (150 tests). `tests/p5.test.ts` plays the whole
  m33→m40 chain plus units (admission denial, vault scan, findings mapping).

## Save compatibility (verified this session)

- Live save `69a00316` ("Mills Brothers", m10) loads, evaluates missions and
  ticks cleanly. All new world fields are optional with defaults on read;
  new missions only trigger after m32 completes.

## Known Bugs / Quirks

- Simulated shell has NO heredoc (`<<`) support (unchanged; two hardening
  fixes still NOT approved — do not implement unless asked).
- m08 env-file check accepts a commented-out `DB_PASSWORD=` line (quirk).
- `git init -q` parses `-q` as a path (repo at `/opt/app/-q`) — sim quirk;
  tests use plain `git init`.
- Mission dock's "every mission complete" text still describes P4 content
  (cosmetic; legend-mode audit line covers the P5 ending).

## Architecture Facts

- One serializable world state object; tick engine advances it; missions are
  declarative `check(world)` predicates; completion derived, never stored.
- New P5 state blocks (types.ts): `vault`, `zeroTrust`, `compliance`, `portal`,
  `traces`, `endgame`, `ci.previews`, `db.pooler`, `k8s.networkPolicies`,
  `k8s.admissionPolicy`, image `signed`/`sbom` flags — all optional.
- Mission phases now include `trust` (m33–36) and `platform` (m37–40).

## Key Files

- `server/src/index.ts` — server entry (port 4100; `npm run dev:server`)
- `server/src/api.ts` — REST API (+ P5 endpoints: mesh, compliance, portal,
  tracing, pooler, endgame)
- `server/src/world.ts` — domain logic (+ P5 engine section at the end)
- `server/src/sim/vault.ts` — secrets manager CLI (P5a)
- `server/src/sim/k8s.ts` — + NetworkPolicy/Policy kinds, admission control
- `server/src/missions/missions.ts` — all 40 missions
- `web/src/views.tsx` — all UI views (+ Portal, CompliancePanel,
  AcquisitionPanel, TracingPanel)
- `tests/p5.test.ts` — P5 chain test; `data/games.json` — live saves

## Run / Verify

- Dev: `npm run dev:server` + `npm run dev:web` (or `npm start`).
- Verify before done: `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit`,
  then `npm test` (vitest).

## Constraints

- LF line endings, `core.autocrlf=false` — never normalize or reformat
  unrelated files.
- Never hand-edit `data/games.json` outside explicit save debugging.
- The two shell-hardening fixes remain unapproved (see Known Bugs).

## Current Focus

### Objective

None open. P5 proposal was approved and fully implemented (both sub-phases).
Decision record: `docs/P5-PROPOSAL.md` (status: shipped). Its three open
questions were resolved: both sub-phases, m40 = acquisition, security gates
the endgame via the due-diligence data room.

Final Verification (2026-09-28, this session): root `tsc --noEmit` clean,
`web/` `tsc --noEmit` clean, `npm test` 150/150 passed (14 files), live save
load-tested. Fully verified.

### Expected Outcome

Next session: commit/push P5 as v0.4 when the user asks; then pick from the
deferred list (multiplayer/leaderboards, mobile/PWA, data engineering, more
localizations) or new pitches.

### Do Not Touch

- `data/games.json` — live save, gitignored
- The two hardening fixes (see Known Bugs) — not approved by the user
- Line endings / formatting of unrelated files
