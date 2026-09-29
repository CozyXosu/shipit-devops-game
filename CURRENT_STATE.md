# CURRENT_STATE

Concise snapshot of the repository's working state for future coding sessions.
Source of truth for design/roadmap: `docs/DESIGN.md`. If anything here looks stale,
verify against the repo (`git status --short`, recent log, actual files) — never
trust it blindly. Last updated: 2026-09-29 (P6e race pass — P6 complete).

## Project / Version

- SHIP IT — DevOps company simulator (TypeScript backend + React web UI). Player
  runs a fictional company's infrastructure through simulated Linux/Docker/CI/
  K8s/Terraform/cloud workflows, mission by mission.
- Version v0.5 — roadmap P0–P6 all shipped (see `docs/DESIGN.md` §12).
  40 missions built (m01–m40) plus the endless Scale Era; P6 phases 6a–6e,
  decision record in `docs/P6-SCALE-ERA.md`.
- `package.json` version reads `0.5.0` — the Scale Era release. (0.4.x were
  the per-pass bumps: 0.4.7 P6e race, 0.4.6 P6d, 0.4.5 P6c, 0.4.4 P6b,
  0.4.3 P6a, 0.4.2 fog-of-war.)

## Git

- Branch `main`, pushed to github.com/CozyXosu/shipit-devops-game. Last
  release: **v0.5.0 — the Scale Era** (P6 implementation commit + README/
  version release commit on top of the fog pass `cbd0f4a`).
- History: `47c4668` (v0.3, P1–P4) → `05e8c02` (v0.4, P5) → `cbd0f4a`
  (fog of war) → v0.5.0 (P6a–P6e, the Scale Era).
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
- **Fog of war (uncommitted, 2026-09-28)**: observability is now a mechanic —
  the world simulates everything but the view-model only exposes what the
  observability agent has seen. `metricsView(world)` in `world.ts` gates
  `metrics.latest/series` on `agentInstalled` and cuts series at
  `monitoring.agentInstalledAtMin` (new optional field, stamped at install —
  legacy saves without it default to full visibility). `addAlertRule` returns
  `null` pre-agent (API answers 400; UI locks the form). Emergent incidents
  (disk_full, bad_deploy) opened while blind are detected by customers after
  `BLIND_DETECT_MIN` (40) sim minutes via `observeOutage()` — resets if the
  condition clears undetected — with `detectedBy: "customer report — no
  monitoring installed"`, a blind-window timeline note, and periodic
  `kind: 'signal'` customer-ticket breadcrumbs in the audit feed
  (`emitBlindSignals`, every 12 min while errorPct ≥ 5). Staged incidents
  (`openIncidentOfKind`, tournament/packs) intentionally bypass the delay.
  UI: Dashboard fog banner + "—" metric cards, Monitoring no-agent panel +
  locked alert form, CLOUD install-agent copy. m12 story/objective/hints
  teach the mechanic. Vendor consoles stay visible by design (managed DB,
  cloud volume, LB health). Tests: `tests/fog.test.ts` (9 tests, incl. legacy
  save compat); 17 suites / 170 tests total.
- **Real-world curriculum layer** (`REAL_WORLD` in missions.ts + UI): every
  career mission m01–m40 carries a one-to-two-sentence "In a real job" note
  (transferable skill + real tool names, `{domain}` templates filled). Exposed
  as `realWorld` in the view-model, rendered in the mission dock between
  coaching and the lesson panel (blue-left-border block + RW tag, a11y-lg aware).
  `tests/realworld.test.ts` guards coverage (every mission has a note; no
  orphan keys) — 161 tests total. Curriculum map + honest gap list:
  `docs/CURRICULUM.md` (what the game teaches vs. the 12 things a real job
  needs that the sim does not cover).
- **Scale Era 6a — honest economy (uncommitted, 2026-09-28)**: accepting the
  m40 term sheet sets `world.era = { startedAtMin }` and turns on usage
  billing + compute utilization; everything keys off that field's existence,
  so mid-campaign balance is untouched. Load-coupled line items (appended in
  `baseCostItems` so provider multipliers/comparisons apply): L7 requests
  $20/M with first 2B/mo included, egress $0.12/GB at 8 KB/req, log ingestion
  $1.20/GB on `logGrowthPerMin`, backup object storage $0.03/GB, managed-DB
  surcharge +1.5% of plan price per db-CPU point above 70 (analytic curve via
  new pure `dbCpuFor` in dbsim.ts). Zero-cost items are skipped. Compute:
  every VM host / k8s node = 200 req/s capacity (`computeCapacityOf`);
  util >70% bends p95 (+2.1ms/point, era only), util >100% adds a 5xx term to
  `errorSourcesOf` (ceil((util−1)×12) → +6%/unit). Node-pool ceiling 2–4
  campaign / 500 era (`resizeNodePool`) + new RESIZE POOL control in the K8s
  tab. UI: COSTS tab era burn panel ($/sim-hour, projected month-end, cost
  per user, margin, fleet util) + $/sim-hour column in the line-items table.
  All money constants in `ERA_ECON` (world.ts). Tests: `tests/era.test.ts`
  (12: era-gating, legacy-save cost identity, tuning gate ≈12%@100k →
  ≈28%@1M → ≈30%@10M superlinear, overload 5xx, cap lift, burn math);
  `tests/p5.test.ts` asserts era starts on term-sheet accept — 18 suites /
  182 tests.
- **Scale Era 6b — capacity levers + scale stages (uncommitted, 2026-09-29)**:
  four era levers, each answering one pressure. CDN (`world.cdn`, basic 60% /
  pro 85% hit ratio): requests AND egress bill on origin-served traffic, edge
  hits are free of the origin bill/fleet; stampedes (S2+, random, `startStampede`)
  collapse the hit ratio ×0.25 for 30 min. Queue (`world.queue`): workers cost
  $35/mo, drain 40 jobs/s each; writes over the drain park in `backlog`
  (>20k → error term); the drain also caps what the DB sees. Read replica
  (`db.replica`): takes 60% of reads off the primary (dbQpsOf), lags per its
  own db-cpu curve (>250 ms → stale-read error term + `replica_lag_ms`
  metric/alert). Secondary region (`cloud.secondary`): bills half of
  compute+database as a standby line item; a regional outage fails over with
  a 3-min DNS glitch (errors 15) then half-fleet capacity, instead of the
  full 80%-error outage. Stage engine: `eraStageOf` (10k/100k/1M/10M/100M →
  S1–S5), `stageReached` watermark + audit copy once per stage; write share
  0.2→0.35 and 100× log growth at S3, 1000× logs at S4 (logGrowthPerMin),
  composite crises on random timers at S5. UI: CLOUD tab "capacity levers"
  panel (CDN/queue/secondary), DATABASE replica panel with lag pill,
  Monitoring charts + alert options for the two new metrics. Era burn view
  gained stage/cdn-hit/backlog/lag/failover fields. FinOps k8s
  "downsize the pool" rec suppressed from S2 (nodes are capacity).
  Tests: `tests/era.test.ts` now 28 (levers, stages, failover, stampede,
  log redux + the two-curve tuning gate: naive ≈12%/43%/46% superlinear,
  engineered ≤25% at 1M & 10M) — 18 suites / 198 tests total.
- **Scale Era 6c — consequences of being big (uncommitted, 2026-09-29)**:
  incident ledger (`resolveIncident` era branch): resolving debits refunds &
  SLA credits at $0.03/user-hour Sev-1 / $0.01 Sev-2 onto `era.incidentCashPaid`
  + a finance audit line. On-call economy (`oncallLoadOf` + `tickEraOnCall`):
  demand = fleetUnits×15 + open incidents×90 + debt×8 eng-min/day, discount =
  portal ×0.75 · ×0.97/published golden path · SLOs ×0.9 (floor 0.3); supply =
  240/480/660/720 min per junior/mid/senior/sre. Overload accrues
  `engineer.burnout` (on-call ×1.5, recovery −10/day); ≥100 → the engineer
  resigns (satisfaction −0.3). Hiring cap 6 campaign → 40 era. Coordination
  tax (`coordinationTaxRoll`, called from the CI deploy step): era + >6
  engineers + no portal → odds 0.15×(n/6) of arming `nextDeployHasBug`,
  announced once. Concentration: S3+ single-region doubles ambient outage
  odds (tickCloud) + new `single-region` compliance finding. Posture gate:
  enterprise-tier product MRR ×0.7 while any compliance finding is open
  (productMrrOf). UI: COMPANY on-call panel (demand/supply, automation
  discount, ledger total) + burnout column. Tests: era.test.ts now 37
  (ledger, burnout/churn/recovery, automation discount, tax via
  Math.random spy, concentration via spy, posture gate) — 18 suites / 207
  tests.
- **Scale Era 6d — era mode (uncommitted, 2026-09-29)**: growth paces like
  an incremental game — era growth multiplier `(6 + stage×3) × (1 + 0.08×rd)`
  (`eraGrowthMultOf`, era-gated) — so 10× takes sim-weeks. CRANK A DAY
  (`crankDay`, `POST era/crank`): one instant sim day, world happens at you.
  R&D money sink (`investRd`, `POST era/rd`): 5 levels × $50k escalating,
  +8% growth each. Product pipeline: optional `Product.lifecycle`
  {peakAdoptionPct, matureAtMin, generation} — ramp 4%/day of the gap,
  decay 3%/day past 30 days (floor 0.5%), `refreshProduct` (SHIP v-next,
  $8k+$4k/gen) resets decay +15% peak; era ideas accrue every 10 sim days
  from a 7-idea pool (catalog cap 12). MODES legend section = Scale Era
  panel (era day, stage, next milestone, crank, R&D); COMPANY product rows
  show lifecycle phase + refresh. Tests: era.test.ts now 44 (pacing, R&D,
  crank, lifecycle ramp/decay/refresh, idea accrual) — 18 suites / 214
  tests. Sim keeps adoption full-precision; the API rounds for display.
- **Scale Era 6e — the race (uncommitted, 2026-09-29)**: three rival
  archetypes (`EraRival` on `world.era.rivals`, lazy-seeded relative to your
  users: Goliath Cloud 1.25×/fast/fragile-margin, Leanframe 0.75×/lean/big
  outages, Steady Systems 1.0×/slow/solid) tick with the world — growth,
  ambient outages (badMin accrues like the player's uptime window),
  postmortems on recovery (no same-minute re-roll), and poaching: while
  player error_pct > 5 they add up to ~0.1%/day of your users. Boards
  (`robustnessOf` 0–100: availability/error-budget/MTTR/days-since-Sev-1/
  containment; `valuationOf` = annual MRR × 3–9.5× robustness+growth
  multiple; `raceBoardOf` ranks by Ship It Index = valuation × robustness/100
  with gap-to-next). Milestones land daily as era badges: mrr-1m, uptime-1m,
  outage-zero (granted at provider-outage end when failover held and errors
  <2%), margin-10m, summit. Share codes: `shareCodeOf`/`parseShareCode` —
  base36 stats + checksum, offline-decodable. UI: the MODES era panel carries
  the race table, milestone stars and the run code. Tests: era.test.ts now
  54 (rivals incl. outage/poach via Math.random spy, robustness spread,
  valuation math, board ranking, badges, share-code round-trip) — 18 suites /
  224 tests.
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
- Tests: 18 vitest suites (224 tests). `tests/p5.test.ts` plays the whole
  m33→m40 chain plus units (admission denial, vault scan, findings mapping).
  `tests/solve.test.ts` auto-solves the entire m01→m40 career chain plus the
  tournament pack track mission-by-mission (~0.5s wall clock).
  `tests/fog.test.ts` covers the observability fog (telemetry gate, alert
  gate, blind-vs-monitored incident detection, blind-window reset, legacy
  save compat). `tests/era.test.ts` covers P6a–P6e (54 tests).

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
- **Solve-chain flake — FIXED 2026-09-29** (was ~1-in-3 runs). It was four
  stacked issues, each fixed at the root: (1) a settled provider outage
  (unclaimed-credit window) blocked STAGED outages — `openProviderOutage` and
  the scheduled-event handler now only treat an ACTIVE outage as blocking;
  (2) ambient incidents/outages fired during live tournament rounds, poisoning
  scored MTTR windows — both rolls are gated while the tournament is
  unfinished; (3) the staged pmr-01 surge routed through the ambient guard and
  could be silently eaten by a stale open incident — staged surges force-open
  during a live tournament and pmr-01 got the `withRoundRetry` treatment;
  (4) at m40 the era announcement wave could overload the campaign-sized
  fleet and burn the error budget, flipping live due-diligence pillars — the
  m40 solver now sizes the fleet before signing (spike headroom, era pool cap)
  and re-runs the honest-SLO renegotiation + postmortem sweep + diligence
  after the wave. Verified: 14/14 clean full-suite runs (was ~1-in-3).
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

P6e (the race) shipped — P6 is COMPLETE (6a honest economy, 6b levers +
stages, 6c consequences, 6d era mode, 6e rivals/boards/milestones/share
codes). Verified: root and web `tsc --noEmit` clean, `npm test` 224/224,
everything era-gated. `web/dist` rebuilt. Note: `tests/solve.test.ts` still
has the documented pre-existing RNG flake (~1-in-3 runs) — re-run.

Prior state: P6d era mode, P6c consequences, P6b levers/stages, P6a honest
economy, and the fog pass (all uncommitted), learning-coverage pass
(`a3956fc`), v0.4 (`05e8c02`).

### Expected Outcome

Commit the accumulated passes when the user is happy (fog + P6a–P6e — six
commits or one). Post-P6 directions from the deferred list: online
leaderboards/multiplayer (needs a server; share codes cover async), mobile/
PWA, New Game+ branching, data engineering content, more localizations,
closing curriculum gaps from `docs/CURRICULUM.md`.

### Do Not Touch

- `data/games.json` — live save, gitignored
- The two hardening fixes (see Known Bugs) — not approved by the user
- Line endings / formatting of unrelated files
