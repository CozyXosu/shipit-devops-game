# SHIP IT — DevOps Simulator

## 1. Mission

TypeScript vertical slice for a hands-on DevOps simulator.

Goal:

> Complete the requested task correctly with the fewest necessary files, tool calls, output, and context.

Sources of truth:

* `AGENTS.md` — agent operating rules.
* `CURRENT_STATE.md` — current implementation state.
* `docs/DESIGN.md` — intended design and roadmap.
* Source code and tests — actual implementation.

When documentation conflicts with code, verify code.

---

# 2. Execution Communication

Minimize agent-generated text during work.

Use tools directly when the next action is clear.

Do NOT narrate:

* routine searches;
* routine reads;
* routine edits;
* routine tests;
* obvious next steps;
* findings already established;
* file contents already visible.

Do NOT produce a thought/summary before every tool call.

Prefer:

```text
tool → tool → tool → result
```

over:

```text
explanation → tool → explanation → tool → explanation → tool
```

Batch related independent operations when practical.

Only stop to explain when:

* a decision is ambiguous;
* destructive/irreversible action needs confirmation;
* new evidence changes the plan;
* a failure requires a new debugging strategy.

Final response should be concise.

---

# 3. Start

For every task:

1. Read `CURRENT_STATE.md`.
2. Run `git status --short`.
3. Identify the smallest relevant file set.
4. Inspect only required code/tests.
5. Implement.
6. Run focused verification.
7. Run final verification once stable.
8. Update `CURRENT_STATE.md` if meaningful.
9. Stop.

Do not explore the repository before knowing what information is needed.

---

# 4. Context Is Expensive

Treat context as a limited engineering resource.

Every read, search, command, test, and generated explanation must have a reason.

## Files

* Prefer targeted search over broad exploration.
* Prefer line ranges over full-file reads.
* Read only relevant sections.
* Do not reread unchanged content.
* Reuse information already in context.
* After editing, inspect only the affected section when possible.
* Never read unrelated files.

## Search

Start narrow:

* exact symbol;
* exact error;
* exact function;
* exact type;
* exact route;
* exact behavior.

Expand only when evidence requires it.

Do not perform repository-wide searches without a specific reason.

Do not repeat a search that already answered the question.

## Output

Keep output bounded.

Avoid:

* full files;
* full repository diffs;
* unrestricted logs;
* huge grep results;
* lockfiles;
* generated files;
* build directories;
* repeated test output;
* directory dumps.

Prefer:

* `git status --short`;
* targeted `git diff -- path`;
* targeted searches;
* focused tests;
* relevant log lines.

## Conversation

Do not duplicate information.

* No routine progress reports.
* No long summaries of tool results.
* No repeating known facts.
* No pasting repository code into chat.
* No explaining every edit.
* State each fact once.

---

# 5. Stop Exploring

Stop exploration when:

* relevant implementation is identified;
* requested behavior is understood;
* an existing test/example provides the required pattern;
* the next code change is clear.

Do not inspect additional subsystems "just in case."

Discover dependencies only when implementation or verification requires them.

If existing tests already demonstrate the required behavior, use them as the primary implementation reference.

---

# 6. Existing Tests Are Implementation References

Before implementing behavior that already exists in tests:

1. Find the relevant test.
2. Identify the proven command/API sequence.
3. Reuse existing APIs and patterns.
4. Implement from that evidence.
5. Inspect internals only when the test is insufficient.

Do not independently rediscover behavior already demonstrated by tests.

Tests can be treated as executable examples, not just verification.

---

# 7. Skills

Installed skills:

* `ponytail` — minimal implementation / YAGNI.
* `caveman` — compressed communication.
* `rtk` — reduced CLI output.

Use them together.

## Ponytail

For coding tasks:

* Prefer existing code.
* Prefer existing helpers and types.
* Prefer deletion over addition.
* Avoid speculative abstractions.
* Avoid unnecessary dependencies.
* Avoid unrelated refactors.
* Modify the fewest files possible.
* Fix root causes.

Do not sacrifice correctness for a smaller diff.

## Caveman

Use compressed communication during work.

* No filler.
* No routine narration.
* Short responses.
* Exact technical terms.
* Preserve commands, code, API names, and errors.
* Never omit `not`, `never`, `no`, `only`, or `except`.

Prioritize clarity for security, destructive, or ambiguous operations.

## RTK

Write normal shell commands.

Do not manually prefix commands with `rtk` when the RTK bridge handles them.

Use raw output only when exact output is required.

---

# 8. Scope

Solve the requested problem.

For bugs:

1. Locate root cause.
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
* rewrite working systems.

No "while I'm here" work.

If another issue is discovered, leave it alone unless it blocks the requested task.

---

# 9. Research Before Editing

Do not edit blindly.

Before changing code:

1. Understand requested behavior.
2. Locate relevant implementation.
3. Trace only the necessary flow.
4. Check existing patterns/tests.
5. Determine root cause.
6. Implement.

Stop researching when implementation is clear.

Before changing shared code, inspect relevant callers.

Do not inspect every caller when the function is local and its usage is already understood.

---

# 10. Implementation

Use the smallest correct implementation.

Preference order:

1. Existing code.
2. Existing utilities.
3. Existing types.
4. Standard library.
5. Native platform features.
6. Existing dependencies.
7. New code.

Avoid:

* duplicate utilities;
* unnecessary managers;
* one-use abstractions;
* speculative interfaces;
* unnecessary configuration;
* new dependencies;
* boilerplate;
* whole-file rewrites.

Preserve existing APIs unless required.

Preserve unrelated formatting.

---

# 11. Edit Safety

Prefer small, deterministic edits.

* Prefer targeted edits over whole-file rewrites.
* Avoid large heredocs for complex files.
* Avoid shell-generated rewrites when a targeted edit works.
* Do not make many speculative edits before checking syntax.
* After a risky edit, verify only the affected region.
* Do not reread the entire file after a small edit.

If an edit fails:

1. Inspect the affected region.
2. Fix the immediate problem.
3. Continue.
4. Do not restart broad exploration.

---

# 12. Debugging

Debug from evidence.

When something fails:

1. Read the exact failure.
2. Locate the relevant code.
3. Inspect the smallest state needed.
4. Form one likely cause.
5. Test that cause.
6. Fix.
7. Re-run the smallest relevant check.

Do not investigate unrelated hypothetical failures.

Do not reread the entire subsystem.

Do not restart repository discovery after a local failure.

When debugging reveals the cause, stop investigating alternatives.

---

# 13. Tool Call Efficiency

Minimize unnecessary tool calls.

Prefer:

```text
search → targeted read → edit → test
```

Avoid:

```text
search → summarize → search again → reread → summarize → search again
```

Batch independent searches/reads when practical.

Do not call a tool to confirm information already established by a previous result.

Do not run commands whose output cannot change the next decision.

---

# 14. Testing

Use focused verification during development.

Do not run expensive full verification after every edit.

During implementation:

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

1. Determine whether current changes caused it.
2. Fix if within scope.
3. Run the smallest relevant check.
4. Repeat final verification when stable.
5. Record unresolved in-scope failures in `CURRENT_STATE.md`.

Do not paste full test output into the response.

---

# 15. Git Safety

Always begin with:

```text
git status --short
```

Repository may contain user work.

Never use these to discard work unless explicitly instructed:

* `git reset --hard`;
* `git clean`;
* `git checkout -- <file>`.

Before modifying a file with existing user changes, inspect the relevant diff.

Do not create commits unless explicitly requested.

---

# 16. Line Endings

Repository uses:

```text
core.autocrlf=false
```

Files use LF.

Preserve LF.

Do not normalize line endings.

Do not reformat unrelated files.

---

# 17. Project Layout

Current major areas:

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

This is not an exhaustive file list.

Search when needed.

Do not inspect directories merely to learn their contents.

---

# 18. Current State

`CURRENT_STATE.md` prevents repeated project discovery.

Keep it short.

Record:

* current focus;
* active bugs;
* incomplete work;
* important architecture facts;
* relevant files;
* verification state;
* important constraints.

Remove stale information.

Do not maintain a task diary.

Do not copy `AGENTS.md` or `docs/DESIGN.md`.

Do not store source code, large logs, or full diffs.

Update after meaningful work.

---

# 19. Design

`docs/DESIGN.md` defines intended game design and roadmap.

Read it when the task concerns:

* missions;
* progression;
* roadmap;
* game design;
* intended player behavior;
* requirements defined there.

Do not read the entire document for unrelated implementation work.

Known baseline may be stale:

* `m17–m32` built;
* P1–P4 shipped;
* v0.2 / 16-mission slice.

Verify current code when relevant.

Mission work must preserve variety.

Avoid repetitive mission structures.

---

# 20. Architecture

Backend owns authoritative simulation/game state.

Frontend consumes backend/API state.

Do not move responsibilities between layers unless required.

Before creating a manager, service, utility, factory, interface, state store, or abstraction:

1. Search for an existing equivalent.
2. Reuse it if suitable.
3. Create a new one only if required.

Do not create duplicate systems.

---

# 21. Large Tasks

Break large tasks into bounded phases.

For each phase:

```text
inspect → implement → focused verify
```

Do not continuously expand the scope.

After each successful phase:

* retain only relevant context;
* do not repeat completed exploration;
* continue from known state.

If a phase is complete, move on.

Do not restart earlier phases unless new evidence requires it.

---

# 22. Context Growth Control

When context begins growing rapidly:

* stop unnecessary exploration;
* stop repeating summaries;
* stop rereading files;
* use targeted reads;
* use focused commands;
* finish the current scope;
* avoid optional improvements.

Do not add work merely because context is available.

The objective is not maximum investigation.

The objective is a correct completed task.

---

# 23. Completion

Task is complete when:

* requested behavior works;
* relevant tests pass;
* required TypeScript checks pass;
* user changes remain intact;
* no unnecessary files changed;
* meaningful state changes are recorded;
* no known in-scope error remains.

Do not claim checks that were not run.

Do not continue after completion.

---

# 24. Final Response

Keep final response minimal.

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

Omit `Remaining` when empty.

Do not:

* dump code;
* dump logs;
* repeat the task;
* explain every tool call;
* provide an essay;
* provide internal reasoning.

Goal:

> Maximum useful work. Minimum context.
