# P5 Proposal — Trust & Scale (ACCEPTED & IMPLEMENTED)

Status: **SHIPPED 2026-09-28** (both sub-phases, m33–m40). The curriculum rows
live in `docs/DESIGN.md` §10 and the roadmap entry in §12; this file stays as
the decision record. Open questions were resolved as: both sub-phases approved;
m40 endgame flavor = acquisition; the security arc gates the endgame through
the due-diligence data room (mirroring how the enterprise tier gates on m27).

Pitch: P0–P4 taught running a platform. P5 teaches **earning trust in it**
(security & compliance) and **scaling past the founding team** (platform
engineering), then closes the campaign with an endgame capstone. Split into two
independently shippable sub-phases.

## P5a — Security & Compliance (m33–m36, one small new sim)

| # | Mission (working title) | Teaches | Systems |
|---|---|---|---|
| m33 | The keys to the kingdom | secrets manager: dynamic DB creds, rotation, leak detection via audit log | new `sim/vault.ts` (small); DB accepts rotated creds |
| m34 | Nobody gets root | zero trust: service identity + mTLS, network policy, least privilege revisited | extend `sim/net.ts` + firewall + host services |
| m35 | Chain of custody | supply chain: image signing, SBOM, admission policy blocking unsigned images | extend `sim/docker.ts` registry + `sim/k8s.ts` admission |
| m36 | The auditor cometh | compliance: evidence collection from the existing audit log, access review, findings → remediation | mostly checks over existing `world.audit`; new audit UI view |

Design constraints:

- No save-format breakage: new world fields optional with defaults on read
  (live save `69a00316` is mid-campaign at m10 and must keep working).
- Mission ids follow `mNN-slug`; add rows to DESIGN.md §10 on approval.
- Each extension gets a vitest suite; verify gates unchanged.

## P5b — Platform Engineering & Endgame (m37–m40)

| # | Mission (working title) | Teaches | Systems |
|---|---|---|---|
| m37 | Golden paths | internal developer portal: self-service deploy templates, devs ship without tickets | portal UI tab; templates over existing CI |
| m38 | Every PR gets a stage | ephemeral preview environments per CI run | extend `sim/ci.ts` |
| m39 | Follow the trace | distributed tracing: spans across LB→api→db, latency attribution, SLO-aware alert tuning | extend monitoring; span model in world state |
| m40 | The acquisition | capstone: due diligence passes on security posture + SLOs + FinOps + team; a scale event; then endless "legend mode" | cross-system checks; endgame scoring |

## Cross-cutting (either sub-phase)

- **Content flywheel:** `docs/PACKS.md` authoring guide + one new pack (a
  security-incident tournament variant) using the existing pack DSL — cheapest
  replayability per engineering hour.
- Challenge mode: add 1–2 security-flavored challenge runs once P5a lands.

## Explicitly deferred (separate pitches if ever wanted)

Multiplayer/leaderboards, mobile/PWA, data/analytics engineering, additional
localizations beyond EN/ES/DE.

## Open questions for the user

1. Approve P5a only, P5b only, or both? (Recommended: P5a first — it is the
   smaller, self-contained arc and directly deepens the weakest area, m08's
   secrets coverage.)
2. Endgame flavor for m40: acquisition, IPO, or viral-scale event?
3. Should the security arc gate late-game content, mirroring how the enterprise
   tier gates on m27?
