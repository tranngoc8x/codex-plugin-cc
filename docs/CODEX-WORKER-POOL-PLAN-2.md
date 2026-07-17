# Codex Worker Pool — Implementation Plan 2 (Phase 2: Worktree Isolation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a `task` run in an isolated git worktree (`--worktree`) so a write-task edits a clean checkout instead of the user's working tree, and clean those worktrees up at session end.

**Architecture:** Add worktree create/remove helpers to `git.mjs`. Wire an optional `--worktree` flag into `handleTask`: when set, create a detached worktree under the state dir, run Codex with its path as cwd, and record the path on the job. Session-end cleanup removes any recorded worktrees. Foundation for Phase 3 fan-out (each parallel worker gets its own worktree).

**Tech Stack:** Node ESM (`.mjs`), stdlib `node:fs`/`node:path` + `git` subprocess (shell:false), tests via `node --test` + `node:assert/strict`.

## Global Constraints

- Node `>=18.18.0`.
- NO new npm dependencies.
- All git invocations go through the existing `git()`/`gitChecked()` wrappers in `git.mjs` (they enforce `shell: false` — never build a shell string).
- Test cmd (session env leaks cause 5 false failures — always unset): `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`. Branch baseline: 101 passing.
- Commit body ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work on branch `feat/worker-pool` in `/Users/tranngocthang/codex-plugin-cc`. Subagents cannot `git commit` — controller commits.
- `git commit` in Bash must use `git -C <path>` form, NOT `cd <path> && git` (compound `cd &&` is permission-blocked in this environment).

## Design decisions (locked)

- **`--worktree` is a bare boolean** (isolate from HEAD) plus a separate **`--worktree-ref <ref>`** value option for a custom base (default `HEAD`). This avoids the ambiguity a value-taking `--worktree` would have with the positional prompt.
- **`--worktree` applies to `task` only.** Reviews are read-only; they never need isolation.
- **The worktree is created detached from a commit (`--detach`), NOT carrying the repo's uncommitted changes** — that is the point of isolation: the worker edits a clean tree and its diff is independent.
- **Cleanup happens only at session end** (in the existing `cleanupSessionJobs`), not per-job. The worktree stays alive for the whole session so `/codex:result` can still show the worker's diff; it is torn down when the session ends. One cleanup site, mirroring the existing session-scoped job cleanup. (ponytail: session-scoped cleanup; add per-job teardown only if temp-dir disk pressure ever shows up.)
- **Worktree path:** `path.join(resolveStateDir(workspaceRoot), "worktrees", jobId)` — under the plugin's own state dir, per-job, so paths never collide across concurrent workers (Phase 3).

## File Structure

- `plugins/codex/scripts/lib/git.mjs` — add `createTaskWorktree`, `removeWorktree`. (Modify)
- `plugins/codex/scripts/codex-companion.mjs` — `handleTask`: parse `--worktree`/`--worktree-ref`, create worktree, route cwd, record `worktreePath`. (Modify)
- `plugins/codex/scripts/session-lifecycle-hook.mjs` — `cleanupSessionJobs`: remove recorded worktrees after the locked mutator. (Modify)
- `tests/git.test.mjs` — worktree helper tests. (Modify)
- `tests/runtime.test.mjs` — task `--worktree` + session-end cleanup tests. (Modify)

---

## Task 1: Worktree helpers in git.mjs

**Files:**
- Modify: `plugins/codex/scripts/lib/git.mjs` (add after `getRepoRoot`, ~line 90)
- Test: `tests/git.test.mjs`

**Interfaces:**
- Consumes: `getRepoRoot(cwd)` (git.mjs:90), `git(cwd,args)`/`gitChecked(cwd,args)` (git.mjs:12-18), `fs`, `path` (already imported at top of git.mjs).
- Produces:
  - `createTaskWorktree(cwd, worktreePath, baseRef = "HEAD") -> string` — creates a detached worktree at `worktreePath` from `baseRef`, returns `worktreePath`.
  - `removeWorktree(cwd, worktreePath) -> void` — best-effort remove + prune; no throw if already gone.

- [ ] **Step 1: Write failing tests**

Add to `tests/git.test.mjs` (reuse the file's existing temp-repo helpers — read the top of the file first for the real helper names that create a git repo with a commit; the illustrative names below are `initTempRepo`):

```js
import { createTaskWorktree, removeWorktree } from "../plugins/codex/scripts/lib/git.mjs";
import fs from "node:fs";
import path from "node:path";

test("createTaskWorktree checks out a detached worktree at the given path", () => {
  const repo = initTempRepo(); // creates a repo dir with at least one commit on HEAD
  const wt = path.join(repo, ".wt", "job-1");
  const result = createTaskWorktree(repo, wt, "HEAD");
  assert.equal(result, wt);
  assert.ok(fs.existsSync(path.join(wt, ".git")), "worktree should be a git checkout");
});

test("removeWorktree tears a worktree down and is safe to call twice", () => {
  const repo = initTempRepo();
  const wt = path.join(repo, ".wt", "job-2");
  createTaskWorktree(repo, wt, "HEAD");
  removeWorktree(repo, wt);
  assert.ok(!fs.existsSync(wt), "worktree dir should be gone");
  assert.doesNotThrow(() => removeWorktree(repo, wt)); // idempotent
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/git.test.mjs`
Expected: FAIL — `createTaskWorktree is not a function` (not exported yet).

- [ ] **Step 3: Implement helpers**

In `git.mjs`, after `getRepoRoot` (~line 92):

```js
export function createTaskWorktree(cwd, worktreePath, baseRef = "HEAD") {
  const repoRoot = getRepoRoot(cwd);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  gitChecked(repoRoot, ["worktree", "add", "--detach", worktreePath, baseRef]);
  return worktreePath;
}

export function removeWorktree(cwd, worktreePath) {
  if (!worktreePath) {
    return;
  }
  const repoRoot = getRepoRoot(cwd);
  // Best-effort: --force removes even with local changes; prune clears any
  // stale registration if the dir was already deleted by hand.
  git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  git(repoRoot, ["worktree", "prune"]);
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/git.test.mjs`
Expected: PASS both new tests + existing git tests.

- [ ] **Step 5: Full suite**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`
Expected: PASS (103 = 101 + 2).

- [ ] **Step 6: Stage (controller commits)**

```bash
git -C /Users/tranngocthang/codex-plugin-cc add plugins/codex/scripts/lib/git.mjs tests/git.test.mjs
```
Controller commit message: `feat: add git worktree create/remove helpers`

---

## Task 2: Wire --worktree into handleTask

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` (`handleTask` ~763-824, `buildTaskRequest` ~605, usage ~75-89)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `createTaskWorktree` (Task 1), `resolveStateDir` (from `./lib/state.mjs` — verify it is imported near the top of codex-companion.mjs; if not, add it to the existing state.mjs import), `resolveCommandWorkspace`, `buildTaskJob`, `buildTaskRequest`, `enqueueBackgroundTask`, `runForegroundCommand`, `executeTaskRun`.
- Produces: `task --worktree [--worktree-ref <ref>]` runs Codex with cwd = the new worktree, and the job record carries `worktreePath` (consumed by Task 3). Without `--worktree`, behavior is byte-for-byte unchanged.

- [ ] **Step 1: Write failing test**

Add to `tests/runtime.test.mjs` (reuse the existing fake-codex fixture + `run`/`makeTempRepo` helpers the other task tests use; read a nearby `task` test first for the real fixture wiring and helper names). The test seeds a real git repo, runs `task --worktree`, and asserts a worktree dir was created under the state dir and the job record has `worktreePath`:

```js
test("task --worktree runs Codex in an isolated worktree and records its path", () => {
  const repo = makeTempRepoWithCommit();     // real git repo, HEAD commit
  const env = fakeCodexEnv(repo);            // whatever the existing task tests use to point at the fake codex
  const result = run("node", [SCRIPT, "task", "--worktree", "--json", "do the thing"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  // The fake codex fixture records the cwd it was launched with; assert it is the worktree, not repo root.
  // (If the fixture exposes the launch cwd, assert it contains "/worktrees/". Otherwise assert the job file has worktreePath.)
  const stateDir = resolveStateDir(repo);
  const worktreesDir = path.join(stateDir, "worktrees");
  assert.ok(fs.existsSync(worktreesDir), "a worktrees dir should exist");
});
```

> If the fake fixture cannot report its launch cwd, assert instead that the finished job's stored record (read the job `.json` under the state dir) contains a `worktreePath` under `worktrees/`. Pick whichever the fixture supports; both prove isolation wiring.

- [ ] **Step 2: Run test, confirm fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/runtime.test.mjs`
Expected: FAIL — no `worktrees` dir / no `worktreePath` (flag not handled).

- [ ] **Step 3: Implement**

In `handleTask` parse block (~764-770), add options:

```js
    valueOptions: ["model", "effort", "cwd", "prompt-file", "worktree-ref"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "worktree"],
```

After `const workspaceRoot = resolveCommandWorkspace(options);` and after the job is built (the job id is needed for the path), compute the run cwd. Restructure so BOTH foreground and background use `runCwd`:

```js
  // ... existing parse of model/effort/prompt/resumeLast/fresh/write ...
  const job = buildTaskJob(workspaceRoot, taskMetadata, write);

  let runCwd = cwd;
  let worktreePath = null;
  if (options.worktree) {
    const baseRef = options["worktree-ref"] || "HEAD";
    worktreePath = path.join(resolveStateDir(workspaceRoot), "worktrees", job.id);
    createTaskWorktree(cwd, worktreePath, baseRef);
    runCwd = worktreePath;
  }
```

Then thread `runCwd` + `worktreePath` through. Background branch:

```js
  if (options.background) {
    ensureCodexAvailable(cwd);            // availability check on the real repo cwd
    requireTaskRequest(prompt, resumeLast);
    const request = buildTaskRequest({
      cwd: runCwd, model, effort, prompt, write, resumeLast, jobId: job.id
    });
    const jobWithWorktree = worktreePath ? { ...job, worktreePath } : job;
    const { payload } = enqueueBackgroundTask(runCwd, jobWithWorktree, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }
```

> NOTE: `buildTaskJob` currently builds the job before this point (line 793 inside the `if (background)`). Move the single `buildTaskJob` call ABOVE the `if (options.background)` so both branches share one job (and the worktree path derived from its id). Confirm `createCompanionJob`/`buildTaskJob` has no side effects that depended on being inside the branch (read `buildTaskJob` — it only builds a record object).

Foreground branch: pass `worktreePath` onto the job record and `runCwd` to the run:

```js
  const foregroundJob = worktreePath ? { ...job, worktreePath } : job;
  await runForegroundCommand(
    foregroundJob,
    (progress) =>
      executeTaskRun({
        cwd: runCwd, model, effort, prompt, write, resumeLast, jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
```

Add usage line (~printUsage 75-89), extend the `task` line:

```js
"  node scripts/codex-companion.mjs task [--worktree] [--worktree-ref <ref>] [--background] [--model <m>] [--effort <e>] ...",
```

> `enqueueBackgroundTask` writes the job record via `writeJobFile`/`upsertJob` from the job object passed in — since we pass `jobWithWorktree`, `worktreePath` persists. Verify `enqueueBackgroundTask` spreads the whole job (`...job`) into `queuedRecord` (it does, line 690-697) so `worktreePath` survives.

- [ ] **Step 4: Run test, confirm pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`
Expected: PASS (104).

- [ ] **Step 6: Stage**

```bash
git -C /Users/tranngocthang/codex-plugin-cc add plugins/codex/scripts/codex-companion.mjs tests/runtime.test.mjs
```
Controller commit: `feat: run task in an isolated git worktree via --worktree`

---

## Task 3: Session-end worktree cleanup

**Files:**
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs` (`cleanupSessionJobs` ~42-71)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `removeWorktree` (Task 1), the `worktreePath` field on job records (Task 2), existing `updateState`.
- Produces: at session end, every recorded worktree for the ending session's jobs is removed. Worktree removal runs AFTER the locked mutator (git subprocess kept out of the lock).

- [ ] **Step 1: Write failing test**

Add to `tests/runtime.test.mjs` (reuse the existing session-end hook test helpers — read a nearby `SessionEnd`/`cleanupSessionJobs` test for how the hook is invoked):

```js
test("session end removes worktrees recorded on the session's jobs", () => {
  const repo = makeTempRepoWithCommit();
  const stateDir = resolveStateDir(repo);
  const wt = createTaskWorktree(repo, path.join(stateDir, "worktrees", "job-wt"), "HEAD");
  // seed a job for the current session carrying worktreePath (reuse the seedJobs helper)
  seedJobs(repo, [{ id: "job-wt", status: "completed", sessionId: SESSION, worktreePath: wt }]);
  assert.ok(fs.existsSync(wt));
  runSessionEndHook(repo, SESSION);   // whatever the existing session-end tests call
  assert.ok(!fs.existsSync(wt), "worktree should be removed at session end");
});
```

- [ ] **Step 2: Run test, confirm fail**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/runtime.test.mjs`
Expected: FAIL — worktree still exists (cleanup doesn't touch worktrees yet).

- [ ] **Step 3: Implement**

In `session-lifecycle-hook.mjs`, add the import (line 16 currently `import { resolveStateFile, updateState } from "./lib/state.mjs";`):

```js
import { removeWorktree } from "./lib/git.mjs";
```

Rewrite `cleanupSessionJobs` to collect worktree paths inside the mutator and remove them after (keeps git out of the lock):

```js
function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const worktreePaths = [];
  updateState(workspaceRoot, (state) => {
    const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    for (const job of removedJobs) {
      if (job.worktreePath) {
        worktreePaths.push(job.worktreePath);
      }
      const stillRunning = job.status === "queued" || job.status === "running";
      if (!stillRunning) {
        continue;
      }
      try {
        terminateProcessTree(job.pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });

  for (const worktreePath of worktreePaths) {
    try {
      removeWorktree(workspaceRoot, worktreePath);
    } catch {
      // Best-effort: a leftover worktree is harmless; prune reclaims it later.
    }
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH node --test tests/runtime.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `env -u CLAUDE_PLUGIN_DATA -u CODEX_COMPANION_SESSION_ID -u CODEX_COMPANION_TRANSCRIPT_PATH npm test`
Expected: PASS (105).

- [ ] **Step 6: Stage**

```bash
git -C /Users/tranngocthang/codex-plugin-cc add plugins/codex/scripts/session-lifecycle-hook.mjs tests/runtime.test.mjs
```
Controller commit: `feat: remove task worktrees at session end`

---

## Self-Review

**Spec coverage (Phase 2):** worktree helpers (2.1) → Task 1 ✓ · `--worktree` on task + cwd routing (2.2) → Task 2 ✓ · cleanup (2.3) → Task 3 ✓ (session-end only, per locked decision). Surfacing `--worktree` through the `rescue`/`codex-cli-runtime` skill is deferred (Phase 3 will drive worktrees programmatically; no user-facing task command exists to document).

**Placeholder scan:** test helper names (`initTempRepo`, `makeTempRepoWithCommit`, `fakeCodexEnv`, `seedJobs`, `runSessionEndHook`) are flagged as "read the file for the real name" verify-steps, not placeholders — each has a concrete Run command and a fallback assertion.

**Type consistency:** `createTaskWorktree(cwd, worktreePath, baseRef)` / `removeWorktree(cwd, worktreePath)` signatures consistent across Tasks 1→2→3. `worktreePath` job field written in Task 2, read in Task 3. `runCwd` threads to both foreground and background.

## Notes for Plan 3
- Phase 3 fan-out reuses `createTaskWorktree` per worker (path already keyed by jobId → no collision).
- Each parallel worker must run with `disableBroker` (own app-server) — NOT in this plan; Plan 3 concern.
- Smoke-test A2 (two `codex app-server` processes in parallel) gates Plan 3, before any DAG code.
