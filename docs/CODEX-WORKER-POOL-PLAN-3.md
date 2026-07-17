# Codex Worker Pool — Implementation Plan 3 (Phase 3: DAG fan-out)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let Claude run several Codex `task` workers in parallel (each isolated in its own git worktree + app-server) and coordinate them as a dependency DAG, so a big job decomposes into concurrent subtasks whose results are collected and merged.

**Architecture (locked, ponytail):** Claude IS the coordinator. Plan 1+2 already ship every runtime primitive fan-out needs — `task --background --worktree` (parallel isolated workers), `wait --jobs <csv>` (block on a specific set), `result <id>` (collect). Smoke-test A2 proved two `codex app-server` processes run concurrently on separate worktrees. So Phase 3 adds **no coordinator engine and no `orchestrate` subcommand** — it adds (1) the one missing datum the coordinator needs to review/merge a worker's output (its worktree path, surfaced in `status`/`result`), and (2) a skill teaching Claude the fan-out loop over the existing primitives. This matches the design's locked decision: "coordinator loop lives in skill prose + small primitives, not a hardcoded engine."

**Tech Stack:** Node ESM; no new deps; tests `node --test` + `node:assert/strict`; skill = Markdown.

## Global Constraints

- Node `>=18.18.0`; NO new npm dependencies.
- Test cmd (unset leaked env): `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`. Branch baseline: 107 passing.
- Process discipline (host hit fork-exhaustion before): run focused tests with `--test-concurrency=1`; run `pkill -f codex-companion; pkill -f "app-server"; true` before finishing a subagent. This plan's tests do NOT need real background workers or real Codex turns — seed job records + assert render/skill text.
- Commit body ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch `feat/worker-pool` in `/Users/tranngocthang/codex-plugin-cc`. Subagents cannot `git commit` — controller commits with `git -C <path>` (never `cd &&`).

## File Structure

- `plugins/codex/scripts/lib/render.mjs` — `pushJobDetails`: surface `worktreePath`. (Modify)
- `plugins/codex/skills/codex-orchestration/SKILL.md` — the fan-out coordinator pattern. (Create)
- `tests/render.test.mjs` — worktreePath render test. (Modify)
- `tests/commands.test.mjs` (or a skills-lint test) — drift-lint the orchestration skill's invariants. (Modify)

---

## Task 1: Surface worktreePath in status/result output

**Files:**
- Modify: `plugins/codex/scripts/lib/render.mjs` (`pushJobDetails`, ~124-164)
- Test: `tests/render.test.mjs`

**Interfaces:**
- Consumes: the `worktreePath` field written onto job records by Plan 2 (`handleTask`).
- Produces: `status`/`result` output includes a `  Worktree: <path>` line when the job has one — so the coordinator can `git -C <path> diff` to review a worker's changes.

- [ ] **Step 1: Write failing test**

Read the top of `tests/render.test.mjs` for how it calls the render helpers (e.g. `renderJobStatusReport(job)`), then add:

```js
test("job details surface the worktree path when present", () => {
  const out = renderJobStatusReport({
    id: "job-x",
    kind: "task",
    status: "completed",
    jobClass: "task",
    worktreePath: "/tmp/state/worktrees/job-x"
  });
  assert.match(out, /Worktree: \/tmp\/state\/worktrees\/job-x/);
});

test("job details omit the worktree line when absent", () => {
  const out = renderJobStatusReport({ id: "job-y", kind: "task", status: "completed", jobClass: "task" });
  assert.doesNotMatch(out, /Worktree:/);
});
```

> Verify the real exported helper name + the minimal job shape it needs by reading a nearby existing render test; adjust the seed object to match (e.g. required fields for `formatJobLine`).

- [ ] **Step 2: Run test, confirm fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/render.test.mjs`
Expected: FAIL — no `Worktree:` line.

- [ ] **Step 3: Implement**

In `render.mjs` `pushJobDetails`, after the `logFile` block (~147):

```js
  if (job.worktreePath) {
    lines.push(`  Worktree: ${job.worktreePath}`);
  }
```

- [ ] **Step 4: Run test, confirm pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/render.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`
Expected: PASS (109 = 107 + 2).

- [ ] **Step 6: Stage**

```bash
git -C /Users/tranngocthang/codex-plugin-cc add plugins/codex/scripts/lib/render.mjs tests/render.test.mjs
```
Controller commit: `feat: surface worktree path in status and result output`

---

## Task 2: codex-orchestration skill

**Files:**
- Create: `plugins/codex/skills/codex-orchestration/SKILL.md`
- Test: `tests/commands.test.mjs` (extend its markdown lint) OR a small `tests/skills.test.mjs`

**Interfaces:**
- Consumes: existing subcommands `task --background --worktree`, `wait --jobs <csv>`, `result <id>`, `cancel <id>`, and `git -C <worktreePath> diff` (worktree path now visible via Task 1).
- Produces: a skill that teaches Claude to fan out independent Codex subtasks in parallel worktrees and coordinate them by dependency. No runtime code.

- [ ] **Step 1: Write the drift-lint test first (failing)**

`tests/commands.test.mjs` already lints command/skill markdown. Read how it loads files, then add a test that reads `plugins/codex/skills/codex-orchestration/SKILL.md` and asserts the invariants below hold (so the skill can't silently drift from the real primitives):

```js
test("codex-orchestration skill drives the real primitives", () => {
  const doc = readFileSync(join(PLUGIN_ROOT, "skills/codex-orchestration/SKILL.md"), "utf8");
  // frontmatter
  assert.match(doc, /^---/);
  assert.match(doc, /name:\s*codex-orchestration/);
  // uses the real, existing primitives (not an invented `orchestrate` subcommand)
  assert.match(doc, /task --background --worktree/);
  assert.match(doc, /wait --jobs/);
  assert.match(doc, /\bresult\b/);
  assert.doesNotMatch(doc, /\borchestrate\b/); // no phantom subcommand
  // concurrency cap + review-before-merge guardrails
  assert.match(doc, /--max-?concurrent|at most|concurrency/i);
  assert.match(doc, /review|diff/i);
});
```

> Match the file-loading style already used in `commands.test.mjs` (it likely has a `PLUGIN_ROOT`/`readCommand` helper). If skills aren't covered there, add a minimal `tests/skills.test.mjs` mirroring its approach.

- [ ] **Step 2: Run test, confirm fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/commands.test.mjs`
Expected: FAIL — skill file missing.

- [ ] **Step 3: Create the skill**

Create `plugins/codex/skills/codex-orchestration/SKILL.md` with this content (adjust the `${CLAUDE_PLUGIN_ROOT}` invocation form to match how other skills reference the companion script — check `codex-cli-runtime/SKILL.md`):

```markdown
---
name: codex-orchestration
description: Use when the user wants several independent Codex tasks run in parallel, or a large task split into concurrent subtasks and their results collected — a fan-out / worker-pool over Codex. Not for a single delegation (use codex:rescue for that).
user-invocable: false
---

# Codex Orchestration (fan-out coordinator)

You are the coordinator. Codex workers run as background `task` jobs, each isolated in its own git worktree and its own app-server process (proven to run concurrently). You launch them, wait on them, review each worker's diff, and sequence dependent work.

## When to use
- The user asks to run multiple Codex tasks at once, or a job cleanly splits into independent subtasks (e.g. "have Codex refactor these 3 modules in parallel").
- NOT for one task — that is `codex:rescue`.

## The loop
1. **Decompose** the request into subtasks. Note dependencies (which must finish before others start). Independent subtasks form one "wave".
2. **Launch a wave** — for each ready subtask, run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --worktree --write "<subtask prompt>"`
   Capture each `jobId` from the output. Launch **at most --max-concurrent (default 3)** at a time to avoid exhausting the machine — running codex workers each spawn an app-server.
3. **Wait** for the wave:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait --jobs <id1,id2,...> --json`
4. **Collect + review** each finished worker:
   - `... result <jobId>` for Codex's summary.
   - The result/status output includes a `Worktree:` path. Inspect the actual changes with `git -C <worktreePath> diff HEAD`. Review before trusting.
5. **Merge deliberately.** Do not auto-apply. Present each worker's diff; apply to the main tree only after review (e.g. `git -C <repo> apply` of the worktree diff, or cherry-pick), resolving conflicts between workers yourself.
6. **Advance the DAG.** Once a wave's results unlock dependents, launch the next wave (back to step 2). Track wave/dependency state in your own todo list — there is no server-side DAG.
7. **On failure/escalation**, a worker job comes back `failed`; surface it, decide whether to retry (`--fresh`) or skip dependents.

## Guardrails
- Read-only subtasks: omit `--write`. Only pass `--write` when the subtask must edit code.
- Never merge a worker's diff without showing it to the user first.
- Worktrees are cleaned up automatically at session end; to reclaim earlier, `cancel <jobId>` a running job.
- Keep waves small (`--max-concurrent` 3). More workers = more app-server processes = more usage burn and machine load.
```

- [ ] **Step 4: Run test, confirm pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`
Expected: PASS.

- [ ] **Step 6: Stage**

```bash
git -C /Users/tranngocthang/codex-plugin-cc add plugins/codex/skills/codex-orchestration/SKILL.md tests/commands.test.mjs
```
Controller commit: `feat: add codex-orchestration skill for parallel worker fan-out`

---

## Self-Review

**Spec coverage (Phase 3):** DAG fan-out delivered via existing primitives + coordinator skill (matches locked "skill prose, no engine" decision). worktreePath surfaced (Task 1) closes the one real gap (reviewing worker output). Skill (Task 2) teaches the loop + guardrails. `--max-concurrent` is a skill-enforced cap (coordinator launches N at a time), not a runtime flag — no engine needed. **Deferred vs original design:** the standalone `orchestrate` subcommand + state.json DAG columns are intentionally NOT built — Claude's own reasoning + todo list is the DAG, which is lazier and equally capable for realistic wave sizes. If a future need arises for unattended/scripted orchestration (no Claude in the loop), revisit a subcommand then.

**Placeholder scan:** skill content is complete (not a stub); test helper names flagged as read-the-file verify-steps.

**Type consistency:** `worktreePath` field (Plan 2 writes it, Task 1 renders it, skill reads it from rendered output) consistent.

## Notes / follow-ups
- Merging parallel worker diffs is manual (coordinator reviews). A `merge_ready`-style helper (auto-apply a clean worktree diff) is the natural Phase-4 companion if fan-out sees heavy use.
- Escalation (Plan 4, `NEEDS_INPUT`) composes: a worker can stop and ask; the coordinator answers via `task --resume`.
