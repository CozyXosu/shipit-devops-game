# CURRENT_STATE

Concise snapshot of the repository's working state for future coding sessions.
Source of truth for design/roadmap: `docs/DESIGN.md`. If anything here looks stale,
verify against the repo (`git status --short`, recent log, actual files) — never
trust it blindly. Last updated: 2026-09-28.

## Project / Version

- SHIP IT — DevOps company simulator (TypeScript backend + React web UI). Player
  runs a fictional company's infrastructure through simulated Linux/Docker/CI/
  K8s/Terraform/cloud workflows, mission by mission.
- Version v0.3, all roadmap phases P0–P4 shipped (see `docs/DESIGN.md` §12).
  32 missions built (m01–m32).
- `package.json` version string still reads `0.1.0` — cosmetic, never bumped.

## Git

- Branch `main`. Last game release: `47c4668` (v0.3, 32-mission game, pushed).
- 2026-09-28 follow-up commit adds the agent workflow (`CURRENT_STATE.md`,
  `AGENTS.md` restore) and the P5 proposal draft (`docs/P5-PROPOSAL.md`) —
  local only, not pushed.
- `data/` is gitignored: live save games are NOT in git.

## Implemented (verified)

- Backend (`server/src/`): Express API (`api.ts`), entry (`index.ts`, port 4100),
  world model (`world.ts`), tick engine (`engine.ts`), types (`types.ts`).
- Infra simulators (`server/src/sim/`): shell/fs, git, docker + registry, CI,
  database, Kubernetes, Terraform, cloud providers (Stratus/Volt/Orbit),
  network/DNS/firewall, monitoring, challenge mode.
- Missions m01–m32 (`server/src/missions/missions.ts`) + mission-pack system
  (`server/src/missions/packs.ts`, packs in `packs/`; postmortem-tournament pack).
- Frontend (`web/src/`): React SPA — terminal, editors, cloud console, mission UI,
  accessibility (contrast/large text/reduced motion/Alt+number tabs), EN/ES/DE chrome.
- Storage: JSON file `data/games.json` by default; optional Postgres via
  `SHIPIT_PG_URL` behind the async `Storage` seam (`db/schema.sql`).
- Tests: 13 vitest suites (139 tests) in `tests/` covering every sim subsystem + missions.

## In Progress

- P5 proposal drafted (`docs/P5-PROPOSAL.md`) — awaiting user direction; not
  approved, not implemented.
- User's live playthrough: save `data/games.json`, game `69a00316`
  ("Mills Brothers"), m01–m09 completed, current mission `m10-ci` (CI).

## Planned

- Roadmap P0–P4 fully shipped. Next-phase candidate: `docs/P5-PROPOSAL.md`
  (P5a security arc m33–m36, P5b platform/endgame m37–m40) — proposal only,
  not approved.

## Known Bugs / Quirks

- Simulated shell has NO heredoc (`<<`) support: `cat > f <<EOF` collapses into
  plain `cat` and can write terminal error output into the target file. This
  corrupted the in-game `.gitignore` once and stalled the live game on m08
  (recovered in-save via EDITOR + commit).
- m08 `env-file` check (`server/src/missions/missions.ts:294`) accepts a
  commented-out `# DB_PASSWORD=` line (loose substring match). Quirk, not blocker.
- Two hardening fixes were offered 2026-09-28 and NOT approved — do not
  implement unless asked: (1) make `server/src/sim/shell.ts` reject `<<` with a
  clear "heredocs not supported, use the EDITOR" message; (2) tighten the
  env-file check to require an uncommented `DB_PASSWORD=` line.

## Architecture Facts

- The whole game is one serializable world state object (`server/src/types.ts`);
  the tick engine advances it; all logic is pure functions over that state.
- Missions are declarative checklists: each requirement is a `check(world)`
  predicate — completion is derived from world state, never stored as truth.
- When debugging "mission won't complete": read the live save from
  `data/games.json` first — check logic is usually right; player state is usually
  what's broken.

## Key Files

- `server/src/index.ts` — server entry (port 4100; `npm run dev:server`)
- `server/src/api.ts` — REST API
- `server/src/world.ts` — domain logic (largest file; grep before reading)
- `server/src/engine.ts` — tick loop
- `server/src/sim/host.ts` — hosts/VMs + shell command backends (very large)
- `server/src/missions/missions.ts` — all 32 missions
- `web/src/views.tsx` — all UI views (large)
- `tests/` — vitest suites; `db/schema.sql` — Postgres schema
- `data/games.json` — live saves (gitignored)

## Run / Verify

- Dev: `npm run dev:server` + `npm run dev:web` (or `npm start` = build + serve).
- Verify before done: `npx tsc --noEmit` (root), `cd web && npx tsc --noEmit`,
  then `npm test` (vitest).
- Verification status: see "Current Focus" below — updated after each session's run.

## Constraints

- LF line endings, `core.autocrlf=false` — never normalize or reformat unrelated files.
- Never hand-edit `data/games.json` outside explicit save debugging (live player data).
- GitHub pushes work as CozyXosu; personal account codyrmills28 has no write access.

## Current Focus

### Objective

Decide the next phase. Roadmap P0–P4 is exhausted; a P5 proposal
("Trust & Scale": security/compliance arc + platform-engineering endgame)
is drafted in `docs/P5-PROPOSAL.md` and awaiting the user's approval and
answers to its three open questions.

### Relevant Files

- `docs/P5-PROPOSAL.md` — the proposal; merge into `docs/DESIGN.md` §10/§12 on
  approval, then implement sub-phase by sub-phase (P5a first, recommended)
- `docs/DESIGN.md` — source of truth; §10 curriculum table, §12 roadmap
- `data/games.json` — live save; read first when debugging mission completion

### Current Problem

None blocking.

Final Verification (2026-09-28, this session): root `tsc --noEmit` clean,
`web/` `tsc --noEmit` clean, `npm test` 139/139 passed (13 files). Fully verified.

### Expected Outcome

User approves a direction → next session folds the proposal into DESIGN.md and
starts P5a (m33–m36, `sim/vault.ts` + net/k8s/docker extensions). Any P5 work
must keep the mid-campaign save (`69a00316`, m10) loadable: new world fields
optional with defaults on read.

### Do Not Touch

- `data/games.json` — live save, gitignored
- The two hardening fixes (see Known Bugs) — not approved by the user
- `docs/P5-PROPOSAL.md` content beyond editing for the user's answers — it is
  a pending decision record
- Line endings / formatting of unrelated files
