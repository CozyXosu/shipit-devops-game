# SHIP IT — DevOps simulator (TypeScript vertical slice)

- Verify before done: `npx tsc --noEmit` at root AND in `web/`, then `npm test` (vitest).
- Layout: `server/src/` (api.ts, index.ts, world.ts, sim/), `web/src/` (views.tsx), `tests/`, `db/`, `docs/`.
- Roadmap lives in `docs/DESIGN.md` — mission milestones m17–m32 built (P1–P4); all four phases shipped.
- Work is uncommitted on top of commit `9bb116d` (v0.2, 16-mission slice) — check `git status` before assuming.
- Repo uses LF line endings with `core.autocrlf=false` — keep it that way.
