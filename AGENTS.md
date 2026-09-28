# SHIP IT — DevOps Simulator

## 1. Purpose

TypeScript vertical slice for a hands-on DevOps simulator.

Primary goal:

> Complete requested work correctly while using the minimum files, tools, output, and context required.

Sources of truth:

* `AGENTS.md` — agent operating rules.
* `CURRENT_STATE.md` — current implementation state.
* `docs/DESIGN.md` — intended design and roadmap.
* Source code and tests — actual implementation.

When sources disagree, verify against code.

---

# 2. Start Here

For every task:

1. Read `CURRENT_STATE.md`.
2. Run `git status --short`.
3. Identify the smallest relevant file set.
4. Read only what is required.
5. Implement the smallest correct solution.
6. Run focused verification.
7. Run full verification once stable.
8. Update `CURRENT_STATE.md` if meaningful.
9. Stop.

Do not explore the repository before knowing what information is needed.

---

# 3. Context Is Expensive

Minimize context growth.

### File access

* Prefer targeted search over broad exploration.
* Prefer line ranges over full-file reads.
* Read only relevant sections.
* Do not read entire large files when a symbol or line range is sufficient.
* Do not reread unchanged content.
* Reuse information already present in context.
* After editing a file, inspect only the changed/relevant section when possible.
* Do not inspect unrelated files.

### Search

* Search for the exact symbol, error, route, function, type, or behavior needed.
* Start narrow.
* Expand only when evidence requires it.
* Do not recursively inspect the repository without a specific reason.
* Do not repeat searches that already answered the question.

### Output

Keep tool output small.

Avoid:

* full file dumps
* full repository diffs
* unrestricted logs
* huge grep results
* lockfiles
* generated files
* build output
* repeated test output
* directory dumps

Prefer:

* `git status --short`
* targeted `git diff -- path`
* targeted search
* focused test output
* relevant log lines

### Conversation

Do not waste context on narration.

* No routine progress reports.
* No explaining obvious tool calls.
* No repeating known facts.
* No long summaries of files just read.
* Do not paste code that already exists in the repository.
* Do not describe every change individually unless needed.
* State each fact once.

---

# 4. Skills

Installed skills:

* `ponytail` — minimal implementation and YAGNI.
* `caveman` — compressed communication.
* `rtk` — reduced CLI output.

Use them as intended.

### Ponytail

For coding tasks:

* Prefer existing code.
* Prefer existing helpers and types.
* Prefer deletion over addition.
* Avoid speculative abstractions.
* Avoid unnecessary dependencies.
* Avoid unrelated refactors.
* Modify the fewest files possible.
* Fix root causes, not symptoms.

Do not sacrifice correctness to reduce code.

### Caveman

Use compressed communication during agent work.

* No filler.
* No routine narration.
* Short responses.
* Exact technical terms.
* Preserve commands, code, API names, and errors.
* Never omit `not`, `never`, `no`, `only`, or `except`.
* Prioritize clarity for security, destructive, or ambiguous operations.

Do not compress repository code or exact error messages.

### RTK

Write normal shell commands.

Do not manually prefix commands with `rtk` when the RTK bridge handles them.

Use raw output only when exact output is required for diagnosis.

---

# 5. Exploration Budget

Start with the smallest possible scope.

Typical initial target:

* `CURRENT_STATE.md`
* relevant source files
* relevant tests

Do not impose arbitrary repository-wide reading.

Expand only when:

* the implementation references another required component;
* a test reveals another dependency;
* the root cause cannot be determined;
* the requested behavior crosses a subsystem boundary.

Stop exploring once enough information exists to implement safely.

---

# 6. Scope Control

Solve the requested problem.

For a bug:

1. Reproduce or locate root cause.
2. Fix root cause.
3. Verify.
4. Stop.

Do not automatically:

* audit the repository;
* redesign architecture;
* refactor unrelated code;
* upgrade dependencies;
* improve unrelated UI;
* clean unrelated files;
* rewrite working systems;
* fix unrelated warnings.

If another issue is discovered, leave it alone unless it blocks the requested task.

No "while I'm here" work.

---

# 7. Research Before Editing

Do not edit blindly.

Before changing code:

1. Understand requested behavior.
2. Locate relevant implementation.
3. Trace the necessary flow.
4. Check existing patterns.
5. Check relevant tests.
6. Identify root cause.
7. Implement the smallest correct change.

Do not continue researching after the implementation path is clear.

Before modifying shared code, inspect its relevant callers.

---

# 8. Implementation

Use the smallest correct implementation.

Prefer:

1. Existing code.
2. Existing project utilities.
3. Existing types.
4. Standard library.
5. Native platform features.
6. Existing dependencies.
7. New code only when necessary.

Avoid:

* duplicate utilities;
* unnecessary managers;
* one-use abstractions;
* speculative interfaces;
* unnecessary configuration;
* new dependencies;
* boilerplate;
* whole-file rewrites.

Preserve existing APIs unless the task requires a change.

Preserve unrelated formatting.

---

# 9. Testing

Do not repeatedly run expensive verification after every small edit.

During development:

* Run the smallest relevant test/check.
* Fix failures before continuing.
* Avoid rerunning unchanged checks.

After implementation stabilizes, run complete verification.

Required final verification from repository root:

```text
npx tsc --noEmit
cd web && npx tsc --noEmit
cd .. && npm test
```

All must pass before declaring the task fully verified.

If a check fails:

1. Determine whether the current change caused it.
2. Fix if within scope.
3. Run the smallest relevant check.
4. Repeat final verification when stable.
5. Record unresolved in-scope failures in `CURRENT_STATE.md`.

Do not dump full test output into the response.

---

# 10. Git Safety

Always begin with:

```text
git status --short
```

The repository may contain user work.

Never:

* discard user changes;
* use `git reset --hard`;
* use `git clean`;
* use `git checkout -- <file>`;
* overwrite unrelated changes.

Before editing a file with existing changes, inspect the relevant diff.

Do not create commits unless explicitly requested.

---

# 11. Line Endings

Repository uses:

```text
core.autocrlf=false
```

Files use LF.

Preserve LF.

Do not normalize line endings or reformat unrelated files.

---

# 12. Project Structure

Relevant layout:

```text
server/src/
  api.ts
  index.ts
  world.ts
  sim/

web/src/
  views.tsx

tests/
db/
docs/
```

Do not assume this list is complete. Search when needed.

---

# 13. Current State

`CURRENT_STATE.md` exists to prevent repeated project discovery.

Keep it short and useful.

Record only:

* current focus;
* active bugs;
* incomplete work;
* important architecture facts;
* relevant files;
* verification state;
* important constraints.

Remove stale information.

Do not use it as a diary.

Do not put:

* source code;
* large logs;
* full diffs;
* repeated design documentation;
* historical task narration.

Update it after meaningful work.

---

# 14. Design

`docs/DESIGN.md` defines intended game design and roadmap.

Read it when the task concerns:

* missions;
* progression;
* game design;
* roadmap;
* intended player behavior;
* requirements defined there.

Do not read the entire design document for unrelated implementation tasks.

Known baseline may be stale:

* `m17–m32` built;
* P1–P4 shipped;
* v0.2 / 16-mission slice.

Verify current state when relevant.

Mission work must preserve variety.

Do not create repetitive mission structures when extending the mission system.

---

# 15. Architecture

Backend owns authoritative simulation and game state.

Frontend consumes backend/API state.

Do not move responsibilities between layers unless required.

Before creating a:

* manager;
* service;
* utility;
* state store;
* factory;
* interface;
* abstraction;

search for an existing equivalent.

Do not create duplicate systems.

---

# 16. Context-Saving Workflow

Use this loop:

```text
State
→ Scope
→ Targeted inspect
→ Implement
→ Focused verify
→ Final verify
→ State update
→ Stop
```

Do not use this loop:

```text
Explore everything
→ read everything
→ summarize everything
→ modify
→ reread everything
→ test everything
→ explore again
→ refactor unrelated code
```

When the requested task is complete, stop.

---
## Edit Safety

Prefer small, deterministic edits.

- Do not use large heredocs or shell-generated file rewrites for complex changes.
- Prefer targeted file edits.
- After a risky edit, verify only the affected region.
- Do not make multiple speculative edits before checking syntax.
- Avoid whole-file replacement when a targeted edit works.


# 17. Completion

Task is complete when:

* requested behavior works;
* relevant tests pass;
* required TypeScript checks pass;
* user changes remain intact;
* no unnecessary files changed;
* meaningful state changes are recorded;
* no known in-scope error remains.

Do not claim verification that was not performed.

Do not continue searching for additional work.

---

# 18. Final Response

Keep final responses minimal.

Use:

```text
Changed:
- ...

Verification:
- Root TypeScript: pass/fail
- Web TypeScript: pass/fail
- Vitest: pass/fail

Remaining:
- ...
```

If nothing remains, omit `Remaining`.

Do not:

* dump code;
* dump logs;
* repeat the task;
* explain every tool call;
* provide an essay;
* report internal reasoning.

Goal:

> Maximum useful work with minimum context consumption.
