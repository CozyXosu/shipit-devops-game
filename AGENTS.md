# SHIP IT — DevOps Simulator

TypeScript vertical slice for a hands-on DevOps simulator.

## Repository State — read first

1. Read `CURRENT_STATE.md` at the beginning of every task. It is the concise
   snapshot of the repository's current working state (git state, what is
   implemented / in progress / broken, active focus).
2. Use `docs/DESIGN.md` as the source of truth for intended game design and
   roadmap. Do not invent mission requirements that conflict with it.
3. If `CURRENT_STATE.md` appears stale, verify against the repository
   (`git status --short`, recent log, the actual files). Never blindly trust
   stale state information.
4. After completing meaningful work, update the relevant sections of
   `CURRENT_STATE.md`: remove what is no longer true, record newly discovered
   blockers or bugs, refresh the Current Focus and verification status. Keep it
   concise. Do not update it for trivial changes.

## Layout

- `server/src/` — backend: `api.ts`, `index.ts`, `world.ts`, `engine.ts`,
  `types.ts`, `sim/` (infra simulators), `missions/` (missions + packs)
- `web/src/` — frontend: `App.tsx`, `views.tsx`
- `tests/` — Vitest tests
- `db/` — Postgres schema
- `packs/` — mission packs
- `docs/` — design and project documentation

## Verification

Before declaring a task complete, run:

```bash
npx tsc --noEmit
cd web && npx tsc --noEmit
cd .. && npm test
```

Do not claim a task is complete if required verification fails.

## Git / Files

- Repository uses LF line endings with `core.autocrlf=false`. Preserve this
  configuration.
- Do not reformat unrelated files.
- Do not normalize line endings.
- Do not modify generated/build artifacts unless explicitly required.
- Do not hand-edit `data/games.json` (live player saves) outside explicit save
  debugging.

## Token-Efficient Agent Behavior

### 1. Inspect narrowly

Do NOT scan the entire repository for ordinary tasks. Start with:

- The file named in the task.
- Its direct imports/dependencies.
- The tests covering that behavior.
- Relevant documentation only if needed.

Expand the search only when the evidence requires it.

### 2. Avoid redundant reads

- Do not reread files already inspected unless they changed.
- Do not repeatedly inspect the same large file merely to confirm information
  already established.
- Prefer targeted searches over dumping entire files.

### 3. Make targeted changes

- Modify the smallest set of files necessary.
- Do not refactor unrelated code.
- Do not rewrite an entire file when a localized edit solves the problem.
- Preserve existing architecture and APIs unless the task explicitly requires
  architectural changes.

### 4. Do not perform unsolicited audits

If asked to fix one bug, fix that bug. Do not automatically:

- redesign the application
- audit unrelated systems
- rewrite architecture
- improve unrelated UI
- clean up unrelated code
- upgrade dependencies
- modify documentation unrelated to the task

Mention adjacent problems only when they directly block the requested work.

### 5. Use existing patterns

Before introducing a new abstraction, search for an existing implementation or
pattern in the relevant subsystem. Prefer consistency with the current codebase
over introducing new frameworks or patterns.

### 6. Tests first, when practical

For behavior changes: inspect existing tests, modify/add focused tests when
appropriate, implement the smallest change, run the relevant test(s), then run
the required verification commands. Do not generate large new test suites unless
requested.

### 7. Keep command output focused

Avoid commands that dump huge files or the entire repository. Prefer targeted
grep/search, specific file ranges, focused test commands, and concise
status/diff output. Do not print large logs unless diagnosing a failure.

### 8. Preserve user changes

Before modifying files with existing uncommitted changes, inspect `git status`
and the relevant diff. Never discard, reset, checkout, or overwrite user work
unless explicitly instructed.

### 9. Stop when verified

Once the requested behavior works, relevant tests pass, and required TypeScript
checks pass — stop investigating. Do not continue exploring the repository
looking for additional work.

## Task Workflow

For every task:

1. Understand the requested outcome.
2. Read `CURRENT_STATE.md`.
3. Run `git status --short`.
4. Identify the smallest relevant set of files.
5. Inspect only those files and their necessary dependencies.
6. Make the smallest correct change.
7. Run focused tests/checks.
8. Run required verification before completion.
9. Update `CURRENT_STATE.md` if the work changed project state.
10. Report: what changed, files changed, verification results, any remaining
    issue.

## Scope Rule

The user's request defines the scope. If the request is ambiguous, inspect
enough context to resolve the ambiguity. Do not turn a focused task into a
repository-wide audit unless explicitly requested.
## Exploration Budget

Optimize for minimal context usage.

For normal tasks, follow this order:

1. Read CURRENT_STATE.md.
2. Run `git status --short`.
3. Inspect the file(s) directly related to the task.
4. Inspect only their direct dependencies when necessary.
5. Inspect relevant tests.
6. Make the change.
7. Verify.

Do NOT perform broad repository exploration unless the task explicitly requires it.

Default exploration budget:
- Maximum ~8 source files initially.
- Maximum ~3 test files initially.
- Maximum ~2 documentation files initially.
- Expand only when blocked by missing information.

If additional files are required, explain why internally and inspect only those files.

Never recursively read:
- the entire `server/`
- the entire `web/`
- the entire `tests/`
- all documentation
- all package files

unless explicitly asked.

Prefer targeted searches over reading large files.