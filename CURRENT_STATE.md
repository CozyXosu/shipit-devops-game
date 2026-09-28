# CURRENT_STATE

Concise snapshot of the repository's working state for future coding sessions.
Source of truth for design/roadmap: `docs/DESIGN.md`. If anything here looks stale,
verify against the repo (`git status --short`, recent log, actual files) — never
trust it blindly. Last updated: 2026-09-28 (real-world curriculum layer + polish).

## Project / Version

- SHIP IT — DevOps company simulator (TypeScript backend + React web UI). Player
  runs a fictional company's infrastructure through simulated Linux/Docker/CI/
  K8s/Terraform/cloud workflows, mission by mission.
- Version v0.4, roadmap P0–P5 all shipped (see `docs/DESIGN.md` §12).
  40 missions built (m01–m40).
- `package.json` version reads `0.4.1` (bumped 2026-09-28 from the stale 0.1.0).

## Git

- Branch `main`. Last release: `05e8c02` (v0.4, 40-mission game, pushed to
  github.com/CozyXosu/shipit-devops-game). Auto-solve feature committed on
  top and pushed (solvers.ts, api.ts, web/, tests); working tree clean.
- History: `47c4668` (v0.3, P1–P4) → `b034a6f` (agent workflow + P5 proposal)
  → `05e8c02` (v0.4, P5).
- `data/` is gitignored: live save games are NOT in git.

## Implemented (verified)

- Backend (`server/src/`): Express API (`api.ts`), entry (`index.ts`, port 4100),
  world model (`world.ts`), tick engine, types (`types.ts`).
- Infra simulators (`server/src/sim/`): shell/fs, git, docker + registry, CI,
  database, Kubernetes, Terraform, cloud (Stratus/Volt/Orbit), net/DNS/firewall,
  monitoring, challenge mode, vault (P5).
- Missions m01–m40 (`server/src/missions/missions.ts`) + mission-pack system
  (`packs/`; postmortem-tournament pack).
- **Auto-solve** (`server/src/missions/solvers.ts`): an executable canonical
  walkthrough for every mission (career m01–m40 + tournament pmr-01…05).
  `POST /api/games/:id/mission/solve` (`{pack?}`) plays the current mission's
  solution with requirement guards (only missing pieces run), returns a step
  transcript (cmd/write/action/wait/note) the UI shows next to the Hint button
  (`⚡ Solve it for me`, EN/ES/DE chrome). Endpoint pauses the sim clock while
  solving so the 1s tick loop can't interleave. Unknown/custom pack missions
  decline gracefully (`ok:false`). Notable solver logic: m07 resolves the merge
  conflict from the HEAD side (explicit `git add config.js` clears the unmerged
  state — `git add -A` does not); pmr-02/pmr-04 restart their round when the
  MTTR window is poisoned by an overlapping ambient incident or provider
  outage (errors pinned at 80% block resolution); m40 re-commits an honest SLO
  target when the 99.5% budget was burned by provider outages (uptimeBadMin
  decays only 1/240 per good minute — waiting it out is not viable).
- **Lesson system** (`server/src/missions/lessons.ts` + UI): free teaching
  content for the 13 file-authoring missions (m04, m06, m07, m08, m09, m10,
  m13, m17, m18, m19, m34, m35, m38). Each lesson = intro prose (what the
  format is and why), syntax cheat-sheet table, annotated line-by-line
  examples, a "where" note, and (8 missions) a commented TODO **starter**
  scaffold. Attached to MissionDef via an id-keyed loop at the bottom of
  missions.ts; exposed as `lesson` in the view-model (`lessonFilled` resolves
  `{domain}` templates). Mission dock renders it as a collapsible 📘 panel
  between coaching and checklist — never costs a hint or rating. Starters are
  safe against false requirement passes: every sim parser skips `#` comments
  except nginx (regex over raw text) and the logrotate flag check, whose two
  starters therefore use prose-only TODOs.
- **Real-world curriculum layer** (`REAL_WORLD` in missions.ts + UI): every
  career mission m01–m40 carries a one-to-two-sentence "In a real job" note
  (transferable skill + real tool names, `{domain}` templates filled). Exposed
  as `realWorld` in the view-model, rendered in the mission dock between
  coaching and the lesson panel (blue-left-border block + RW tag, a11y-lg aware).
  `tests/realworld.test.ts` guards coverage (every mission has a note; no
  orphan keys) — 161 tests total. Curriculum map + honest gap list:
  `docs/CURRICULUM.md` (what the game teaches vs. the 12 things a real job
  needs that the sim does not cover).
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
  EDITOR: recursive file tree (subfolders like `.ci/` and `k8s/` navigable —
  they were unreachable before), `＋ New file` creation (no more terminal
  `touch` dance), and a `📘 Mission starter` button when the current mission
  has a starter scaffold.
- Storage: JSON file `data/games.json` by default; optional Postgres via
  `SHIPIT_PG_URL` behind the async `Storage` seam (`db/schema.sql`).
- Tests: 16 vitest suites (161 tests). `tests/p5.test.ts` plays the whole
  m33→m40 chain plus units (admission denial, vault scan, findings mapping).
  `tests/solve.test.ts` auto-solves the entire m01→m40 career chain plus the
  tournament pack track mission-by-mission (~0.5s wall clock).

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
- `data/games.json` currently holds a few stray games named "test" (day 24,
  created outside this session) alongside live save `69a00316` — left alone
  per save-file policy; delete from the UI if unwanted.

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
- `server/src/missions/solvers.ts` — auto-solve walkthroughs + transcript types
- `web/src/views.tsx` — all UI views (+ Portal, CompliancePanel,
  AcquisitionPanel, TracingPanel)
- `tests/solve.test.ts` — auto-solve chain test; `tests/p5.test.ts` — P5 chain
  test; `data/games.json` — live saves

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

Learning-coverage pass shipped on top of `main` (uncommitted): a real-world
mapping note on every career mission ("In a real job": transferable skill +
real tool names), the curriculum map + honest gap list in
`docs/CURRICULUM.md`, and polish (dock completion text now covers P5,
`package.json` → 0.4.1). Verified: root/web `tsc --noEmit` clean, `npm test`
161/161 (incl. new `tests/realworld.test.ts` coverage guard), live HTTP smoke
on the restarted :4100 server (realWorld in view-model; smoke game deleted;
two pre-existing stray "test" games left alone). User's dev server on :4100
was killed and restarted with current code; `web/dist` rebuilt so the static
UI served there includes the new dock block.

Prior state: lesson system + editor hand-holding committed as `a3956fc`,
README refresh `acf2d6d`; v0.4 released (`05e8c02`).

### Expected Outcome

Commit the learning-coverage pass when the user is happy with it. Next
content direction: pick from the deferred list (multiplayer/leaderboards,
mobile/PWA, data engineering, more localizations) or close curriculum gaps
from `docs/CURRICULUM.md` as new missions (caching, queues, load testing,
GitOps, feature flags — would each need a small sim engine).

### Do Not Touch

- `data/games.json` — live save, gitignored
- The two hardening fixes (see Known Bugs) — not approved by the user
- Line endings / formatting of unrelated files
