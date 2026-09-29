# P6 Proposal — The Scale Era (infinite endgame + the race)

Status: **ALL FIVE PHASES SHIPPED (2026-09-28/29) — P6 COMPLETE.** This file
is the decision record (P5-PROPOSAL convention); roadmap lives in
`docs/DESIGN.md` §12.

6a decision record (deltas from the original spec):

- Era entry: accepting the m40 term sheet sets `world.era` — one continuous
  story, as recommended. The run keeps ticking in legend mode.
- The tuning-gate test pins what 6a alone can produce: naive infra/revenue
  ≈12% at 100k → ≈28% at 1M → ≈30% at 10M (superlinear via the spent included
  tier). The proposal's full naive bands (40–60% at 10M) and the engineered
  ≤25% guarantee need 6b's stage pressures and offload levers; the constants
  all live in one `ERA_ECON` block for that tuning pass.
- Compute: "you pay for it, it serves" — every VM host and k8s node is 200
  req/s of capacity. The node-pool ceiling (2–4 in campaign) lifts to 500 in
  the era, and the K8s tab gained a pool-resize control, because buying
  capacity is the only 6a answer to overload.

6b decision record (deltas from the original spec):

- All four levers shipped: CDN (basic/pro tiers, origin-basis billing for
  requests AND egress), queue + workers (backlog drains per tick, >20k
  backlog becomes user-visible errors), read replica (60% read split, lag
  from the replica's own db-cpu curve, >250 ms → stale-read errors), and
  secondary region (failover with a 3-minute DNS glitch window and
  half-fleet capacity during the outage).
- The standby duplicates compute + database only — logging and the edge CDN
  are global services, so duplication pricing follows.
- Stage engine: S1–S5 derived from users, announced once each via a
  `stageReached` watermark on `world.era`. S2 arms random cache stampedes;
  S3 moves the write share 0.2→0.35 and re-opens logrotate at 100× log
  growth (6000 MB/min at 1M users); S4 runs logs at 1000×; S5 rolls
  composite crises (spike + stampede + inbound outage) on random timers.
- Deferred from the 6b table: HPA bill-shock mechanics (HPA behavior is
  unchanged; nodes are the capacity currency) and S4 resharding (the db
  surcharge is the reminder until a shard lever lands in a later phase).
- Tuning gate now asserts the proposal's bands: naive ≈12% → ≈43% → ≈46%
  (superlinear), engineered ≤25% at 1M and 10M.

Pitch: P0–P5 taught building and trusting a platform, then ended at the
acquisition. P6 makes the game **endless on purpose**: after m40 the mission
chain stops but the company doesn't. Traffic compounds, every architecture
decision has a monthly bill, scale stages re-open old problems at new
intensity, and three rival companies race you on a live leaderboard for the
two things that matter at scale — **the most money** and **the most robust
systems**. The acquisition isn't the end; it's the starting gun.

## Design pillars

1. **Scale is the adversary.** No authored endgame missions — growth itself
   generates the pressure. Stages emerge from the tick engine, not a script.
2. **Money must be engineered.** Today infra cost is a flat line-item sum
   (`monthlyInfraCost`, world.ts:1283) while revenue is `users × $2` + products
   (world.ts:1572). Past m40 that means infinite money for nothing. P6 makes
   cost a function of load, so margin is something you *build*, not receive.
3. **The race is the game.** Competition needs a legible scoreboard, visible
   rivals, and short-term milestones — not just a final number.
4. **Same architecture.** One serializable world, tick engine, derived state.
   Everything below is new state blocks + derived views; no saves break, the
   auto-solver and fog layers keep working.

## 6a — Honest economy (the core patch, smallest phase, biggest lever)

**Traffic-coupled line items.** `baseCostItems()` items become functions of
load, not constants:

| New line item | Model (all constants tunable) |
|---|---|
| Requests (L7) | `$X per M requests`; monthly reqs = `avg(reqRateAt) × 2.6M s` |
| Egress | `$Y per GB`, ~8 KB/req → GB/mo from the same counter |
| Log ingestion | scales with `logGrowthPerMin` (already exists, world.ts:290) |
| Object storage | backups + artifacts, GB-held × price |
| Managed DB | plan price × utilization surcharge above 70% CPU |

**Compute utilization.** Each VM/node gets a capacity in req/s; `util =
reqRate / Σcapacity`. 70–100% bends latency (same shape as the DB's
`18 + cpuPct × 9` at world.ts:2224); >100% adds a 5xx term to
`errorSourcesOf` (world.ts:265). The DB already models this — generalize it.

**Unit economics as the core curve.** Infra/revenue is the number the whole
era orbits. Design targets (enforced by a tuning-gate test, not just hope):

- Naive play: ~10% of revenue at 100k users → 40–60% at 10M (linear revenue,
  superlinear naive cost — step-ups, multi-region duplication, noise alerts).
- Engineered play holds ≤25% at any scale. That gap *is* the endgame skill.

**Worked example (1M users, ~11k req/s avg, ~29B req/mo, $2M MRR):**
naive stack ≈ 34 undersized nodes flapping + unopted egress + DB at 90% CPU →
~$500–800k/mo. Engineered: CDN offload 80%, HPA on reserved instances, sharded
DB → ~$200–300k/mo. Same users, same revenue, wildly different margin.

**UI:** CLOUD tab gains a live burn view — $/sim-hour per resource, projected
month-end, cost per user, margin — in the spirit of the fog pass (money becomes
visible the way telemetry is).

## 6b — Capacity levers & scale stages

New levers (each a small sim extension + a billable line item):

| Lever | Teaches | Sim touch |
|---|---|---|
| Read replica | read/write split, replication lag | extend `sim/dbsim.ts` |
| Cache + CDN | hit-ratio offload: pay flat $ to save compute $ and latency | new, small `sim/cache.ts` or net.ts extension |
| Queue + async workers | peak shaving, backlogs | new, small `sim/queue.ts` |
| Multi-region | failover for real, ×1.5 infra duplication | extend `sim/cloud.ts` + net |

**Scale stages** (crossing a user threshold flips derived pressure on — soft
missions, no new mission objects):

| Stage | Users | Pressure that turns on | New failure mode |
|---|---|---|---|
| S1 | 10k | DB read load → pooler + replica | replica lag → stale reads |
| S2 | 100k | origin saturation → cache/CDN, HPA earns its keep | cache stampede; HPA bill shock at peak |
| S3 | 1M | write load, single-region risk | queue backlog; a provider outage now means *full* outage |
| S4 | 10M | hot partitions | resharding cutover (reuses P3 migration downtime math) |
| S5 | 100M | everything, at once | the endless era: composite crises on random timers |

Each stage also re-opens an old problem at new intensity: log growth at 100×
traffic (disk-full redux), rollouts across 50 nodes (bad-deploy redux). The
player who skipped logrotate at m11 meets it again at S3.

## 6c — Consequences of being big

- **Incidents cost cash directly**: SLA credits + refund events scale with
  users; at 1M a Sev-1 is a ledger event, not a badge.
- **On-call load**: pages scale with fleet size. Understaffed at scale →
  engineer burnout → satisfaction drop → churn. Automation (portal golden
  paths, runbooks, canary auto-abort) buys pages back — this is where the
  deferred **engineer-minutes economy** finally lands, as P6c.
- **Coordination tax**: beyond ~6 engineers without portal/CI maturity, deploy
  frequency drops and bad-deploy odds rise (couples to the debt ledger).
- **Concentration risk**: single-region S3+ is one outage away from zero.
- **Compliance at scale**: audit finding frequency rises; enterprise tier
  demands grow with users (revenue gates on posture).

## 6d — The Scale Era mode + infinite releases

- **Entry**: accepting the m40 term sheet no longer ends the run — the board
  demands growth and the era scoreboard starts. Legend mode becomes the Scale
  Era panel (era day, stage, rank, next milestone).
- **Growth pacing**: current compounding (~0.42%/day) takes hundreds of sim-days
  per 10×. Era mode accelerates growth and adds a "crank the clock" control —
  the endgame should pace like an incremental game with hands-on crises.
- **Product pipeline**: ideas accrue in a backlog → build with cash + engineer
  minutes → launch → adoption grows → matures → decays. Refresh releases keep
  "ship infinitely" true. Extends the existing `Product` type with lifecycle
  fields (optional, save-safe).
- **Money sinks** so rich stays meaningful: acquire rival companies, reserved-
  capacity purchases, R&D, region expansion, debt paydown.

## 6e — The race (competition)

- **Two boards + one index.**
  - **Wealth**: net worth = cash + live valuation. Valuation = f(MRR, growth,
    robustness multiple, capped), replacing the m40 one-shot term sheet.
  - **Robustness Rating (0–100)**: rolling 30-day availability vs target,
    error-budget remaining, MTTR, days since Sev-1, blast-radius containment.
  - **Ship It Index** = valuation × robustness multiple — one comparable
    number; robust systems literally make you richer (valuation premium), so
    both leaderboards pull the same direction.
- **Three rival companies** (extends the tournament pack's live-scoreboard
  pattern, no server): distinct strategies — one buys scale with money, one is
  lean and fragile (beats you on margin until a big outage), one is boring and
  reliable. They grow on the same tick, have outages, publish postmortems, and
  poach users when you falter. The board shows live rank + gap-to-next.
- **Milestones/badges** as short-term competitive targets: $1M MRR club,
  99.99% held at 1M users, provider outage survived with zero downtime,
  margin ≤25% at 10M.
- **Share codes**: end-of-era (or any-moment) run summary → compact
  deterministic code (key stats + hash) for forum/friends comparison. Keeps
  the "runs locally, no server" promise; online leaderboards stay deferred.

## Cross-cutting constraints

- Save compatibility: all new world fields optional with defaults on read;
  pre-m40 saves untouched (the economy patch only activates load-coupled items
  when `world.era` exists — mid-campaign balance is unchanged).
- Tests: tuning-gate test (seeded run to 1M/10M users asserts stage
  transitions + cost/revenue ratios in band), era-chain test in the
  solve.test.ts style, rivals as deterministic seeded agents.
- Perf: tick stays O(1) arithmetic; series caps unchanged (1500 pts).
- Auto-solver: era has no missions to solve; solver stops at m40 as today.

## Phasing (each independently shippable, in order)

| Phase | Content | Size |
|---|---|---|
| 6a | traffic-coupled costs + utilization + burn view | small |
| 6b | levers (replica/cache/CDN/queue) + stage engine | medium |
| 6c | consequences (cash-cost incidents, on-call load, engineer-minutes) | medium |
| 6d | era mode + growth pacing + product pipeline + sinks | medium |
| 6e | rivals + scoring + milestones + share codes | small-medium |

6a+6b alone make the post-m40 world worth living in; 6e is what makes it a
sport. Recommend shipping in order, playtesting the economy constants at each
step.

## Explicitly deferred

Online leaderboards/multiplayer (needs a server; share codes cover async play),
mobile/PWA, New Game+ branching (independent vs acquired start).

## Open questions for the user

1. Approve all five phases, or start with 6a+6b and re-decide?
2. Era entry: term-sheet acceptance flows into the era (recommended — one
   continuous story), or the era is a separate mode you can also start fresh?
3. Boards: two boards + combined index (recommended), or a single score?
4. Should rivals be *beatable content* (fixed personalities, learnable) or
   seeded/variable per run (replayability)? Recommended: seeded, 3 archetypes.

6c decision record (deltas from the original spec):

- The incident ledger debits on RESOLVE (one clean ledger event per incident):
  $0.03/user-hour for a Sev-1, $0.01 for Sev-2, cumulative total on the era
  state and the COMPANY tab. SLA credits stay a separate claimable income.
- The engineer-minutes economy: demand = fleet×15 + open incidents×90 +
  debt×8 minutes/day; supply = 240/480/660/720 min per junior/mid/senior/SRE.
  Automation discount: portal ×0.75, ×0.97 per published golden path, SLOs
  ×0.9 (floor ×0.3). Overload accrues burnout (on-call ×1.5); 100% burnout =
  resignation. The 6-engineer hiring cap lifts to 40 in the era — the
  coordination tax is unreachable otherwise.
- Coordination tax arms `nextDeployHasBug` on CI production deploys with
  odds 0.15×(engineers/6) while no portal exists; announced once.
- Concentration risk: S3+ single-region doubles the ambient outage odds and
  carries the new `single-region` compliance finding; enterprise-tier
  product revenue runs at ×0.7 while ANY compliance finding is open
  (posture gates revenue).
- Deferred to 6d: product-pipeline/enterprise-tier demand growth curves as
  user-count functions (the ×0.7 gate is the first slice of it).

6d decision record (deltas from the original spec):

- Entry was already landed by 6a (term sheet → era, legend keeps ticking), so
  6d is pacing + pipeline + sinks. "Rank" on the era panel waits for 6e
  (no rivals yet).
- Growth: (6 + stage×3) multiplier era-gated — ×9 at S1 to ×21 at S5 — so a
  10× takes sim-weeks, not hundreds of days; R&D adds ×(1 + 0.08/level).
- Crank = one full sim day per click (`POST era/crank`); the speed slider
  (×1–16) still exists for ambient pacing. Cranking is deliberately a
  hands-on-tradeoff: whatever breaks during the day is yours to fix.
- Product lifecycle: optional `Product.lifecycle` (peakAdoptionPct,
  matureAtMin, generation) — ramp 4%/day of the gap to peak, 3%/day decay
  past 30 days, floor 0.5%. Refresh (v-next) costs $8k + $4k/generation,
  resets decay, +15% peak. Ideas: one backlog addition per 10 sim days from a
  7-idea era pool, catalog capped at 12. Pre-era products keep static
  adoption; era launches initialize a lifecycle lazily (save-safe).
- Money sinks shipped: R&D (new), refresh releases (new), plus the existing
  secondary region, async workers, reserved compute and refactor projects.
  Acquiring rival companies waits for 6e's rivals.

6e decision record (deltas from the original spec):

- Rivals are relative, not seeded-random: users seed at 1.25×/0.75×/1.0× of
  yours when the era begins (lazily — older era saves seed on first tick),
  and each archetype has fixed growth/outage/margin/robustness curves, so
  they are learnable content. Outage rolls use ambient RNG; ending an outage
  publishes a postmortem and skips that minute's re-roll.
- Poaching: while your error_pct > 5, rivals add up to ~0.1%/day of your
  users (scaled by archetype aggression), announced once per episode.
- Robustness Rating: availability vs 99% (30 pts), SLO error budget (20, 8
  if no SLOs), MTTR of the last five incidents (20), days since Sev-1 (15),
  containment — HA + zero-downtime proof + backups (15). Valuation = annual
  MRR × (3 + robustness/100×5 + growth bonus ≤1.5). Ship It Index =
  valuation × robustness/100 — robustness-weighted worth on one ladder.
- Milestones shipped as era badges: mrr-1m, uptime-1m, outage-zero (failover
  held, error rate <2% when the region recovered), margin-10m, summit (100M).
- Share codes: `SI-<base36 day.stage.users.mrr.robustness.cash.badges.rd>-<hash4>`,
  checksummed and decodable offline via `parseShareCode` — no server, as
  promised; online leaderboards stay deferred.
