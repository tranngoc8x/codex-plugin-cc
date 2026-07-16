# Codex Worker Pool — Implementation Plan 1 (Phase 0 + Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cứng persistence layer (atomic + locked state writes, hardened reads) rồi thêm primitive `wait` đa-job — nền an toàn cho fan-out ở các plan sau.

**Architecture:** Bọc read-modify-write của `state.json` bằng directory-lock (mkdir atomic, có stale-break) + ghi temp-then-rename. Harden `readJobFile` trả `null` thay vì throw. Tổng quát hoá logic `waitForSingleJobSnapshot` sẵn có thành subcommand `wait` chờ nhiều job theo status, phục vụ coordinator loop.

**Tech Stack:** Node ESM (`.mjs`), stdlib `node:fs`/`node:crypto` only (KHÔNG thêm dependency), test bằng `node --test` + `node:assert/strict`.

## Global Constraints

- Node `>=18.18.0` (package.json engines) — verbatim.
- KHÔNG thêm npm dependency mới (ponytail: stdlib đủ cho lock).
- Mọi git/subprocess giữ `shell:false` như hiện tại (git.mjs:12-13).
- Commit message kết thúc bằng: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Làm trên **fork** `openai/codex-plugin-cc`, KHÔNG sửa clone marketplace.
- Đường dẫn gốc plugin trong repo: `plugins/codex/`.

---

## File Structure

- `plugins/codex/scripts/lib/state.mjs` — thêm lock helpers, `persistState` nội bộ, sửa `updateState`/`saveState`/`readJobFile`. (Modify)
- `plugins/codex/scripts/codex-companion.mjs` — thêm subcommand `wait` + handler + usage. (Modify)
- `plugins/codex/commands/wait.md` — command passthrough. (Create)
- `tests/state.test.mjs` — thêm test lock/atomic/readJobFile. (Modify)
- `tests/runtime.test.mjs` — thêm test subcommand `wait`. (Modify)

---

## Task 1: Atomic + locked state writes

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs:92-122` (`saveState`, `updateState`)
- Modify: `plugins/codex/scripts/lib/state.mjs:166-171` (`writeJobFile` → atomic)
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: `resolveStateDir(cwd)`, `resolveStateFile(cwd)`, `loadState(cwd)`, `ensureStateDir(cwd)`, `pruneJobs`, `removeJobFile`, `removeFileIfExists` (đã có trong state.mjs).
- Produces: `updateState(cwd, mutate)` và `saveState(cwd, state)` giữ nguyên signature nhưng nay atomic + mutually-exclusive; thêm nội bộ `persistState(cwd, state)` (không export), `acquireStateLock(cwd)`/`releaseStateLock(lockDir)` (không export).

- [ ] **Step 1: Viết test lost-update + atomic (fails)**

Thêm vào `tests/state.test.mjs` (dùng pattern có sẵn: `CLAUDE_PLUGIN_DATA` trỏ tmpdir để cô lập state dir):

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateState, loadState, resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-test-"));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

test("concurrent updateState does not lose job entries", async () => {
  const cwd = tmpWorkspace();
  // 20 concurrent-ish read-modify-write cycles, each adds a distinct job id.
  await Promise.all(
    Array.from({ length: 20 }, (_unused, index) =>
      Promise.resolve().then(() =>
        updateState(cwd, (state) => {
          state.jobs.push({ id: `job-${index}`, updatedAt: new Date().toISOString() });
        })
      )
    )
  );
  const ids = new Set(loadState(cwd).jobs.map((job) => job.id));
  for (let index = 0; index < 20; index += 1) {
    assert.ok(ids.has(`job-${index}`), `missing job-${index}`);
  }
});

test("state file is never left half-written", () => {
  const cwd = tmpWorkspace();
  updateState(cwd, (state) => {
    state.jobs.push({ id: "job-a", updatedAt: new Date().toISOString() });
  });
  const raw = fs.readFileSync(resolveStateFile(cwd), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw)); // parses = complete write
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — "concurrent updateState does not lose job entries" thiếu vài id (lost update do read-modify-write không lock).

- [ ] **Step 3: Thêm lock helpers + `persistState`, sửa `updateState`/`saveState`**

Trong `state.mjs`, thêm hằng gần đầu file (sau dòng 13 `const MAX_JOBS = 50;`):

```js
const LOCK_DIR_NAME = "state.lock";
const LOCK_STALE_MS = 10000;      // ponytail: coarse global lock/state-dir. writes tiny+rare.
const LOCK_TIMEOUT_MS = 5000;     // upgrade: per-job locks if throughput ever matters.
const LOCK_RETRY_MS = 25;

function sleepSync(ms) {
  // stdlib sync sleep (no dep) — lock retry runs in a sync code path.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireStateLock(cwd) {
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir); // atomic: throws EEXIST if another writer holds it
      return lockDir;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      try {
        const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true }); // steal stale lock (crashed writer)
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring Codex state lock at ${lockDir}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseStateLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // best-effort; stale-break covers a leaked lock
  }
}
```

Thay `saveState` + `updateState` (dòng 92-122) bằng:

```js
function persistState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  const target = resolveStateFile(cwd);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target); // atomic replace on same filesystem
  return nextState;
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const lockDir = acquireStateLock(cwd);
  try {
    return persistState(cwd, state);
  } finally {
    releaseStateLock(lockDir);
  }
}

export function updateState(cwd, mutate) {
  ensureStateDir(cwd);
  const lockDir = acquireStateLock(cwd);
  try {
    const state = loadState(cwd);
    mutate(state);
    return persistState(cwd, state);
  } finally {
    releaseStateLock(lockDir);
  }
}
```

Sửa `writeJobFile` (dòng 166-171) sang atomic:

```js
export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const tmp = `${jobFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, jobFile);
  return jobFile;
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `node --test tests/state.test.mjs`
Expected: PASS cả 2 test mới + các test state cũ vẫn xanh.

- [ ] **Step 5: Chạy full suite (không hồi quy)**

Run: `npm test`
Expected: PASS toàn bộ. `state.lock` không được rò rỉ (nếu test fail vì lock sót → kiểm tra `finally`).

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/state.mjs tests/state.test.mjs
git commit -m "fix: atomic + locked state writes to prevent lost job entries"
```

---

## Task 2: Harden `readJobFile` against corrupt files

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs:173-175` (`readJobFile`)
- Verify callers: `plugins/codex/scripts/lib/job-control.mjs:188`, `codex-companion.mjs:849`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Produces: `readJobFile(jobFile)` nay trả `null` khi file thiếu HOẶC JSON hỏng (trước đây throw). Callers `tracked-jobs.mjs:109,139` đã guard `existsSync` và tolerate null (`{...null}` = `{}`, `?? runningRecord`); `job-control.mjs:188 readStoredJob` trả thẳng → phải null-safe ở caller.

- [ ] **Step 1: Viết test corrupt-file (fails)**

Thêm vào `tests/state.test.mjs`:

```js
import { writeJobFile, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";

test("readJobFile returns null on truncated json instead of throwing", () => {
  const cwd = tmpWorkspace();
  writeJobFile(cwd, "job-x", { id: "job-x", status: "running" });
  const jobFile = resolveJobFile(cwd, "job-x");
  fs.writeFileSync(jobFile, '{"id":"job-x","stat', "utf8"); // simulate crash mid-write
  assert.equal(readJobFile(jobFile), null);
});

test("readJobFile returns null when file is missing", () => {
  const cwd = tmpWorkspace();
  assert.equal(readJobFile(resolveJobFile(cwd, "nope")), null);
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — test 1 throw `SyntaxError` (JSON.parse), test 2 throw `ENOENT`.

- [ ] **Step 3: Sửa `readJobFile`**

Thay dòng 173-175 trong `state.mjs`:

```js
export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null; // missing or corrupt (e.g. truncated by a crashed writer)
  }
}
```

- [ ] **Step 4: Null-safe caller `readStoredJob` (job-control.mjs)**

Mở `job-control.mjs` quanh dòng 188. Nếu `readStoredJob` trả thẳng `readJobFile(jobFile)`, giữ nguyên (null hợp lệ). Kiểm tra `codex-companion.mjs:849` (`readStoredJob(workspaceRoot, options["job-id"])`): nếu sau đó truy cập thuộc tính của kết quả mà không `?? {}`/null-check thì thêm. Dòng 919 (`renderStoredJobResult(job, storedJob)`) và 972 (`?? {}`) đã null-safe.

Kiểm tra bằng:

Run: `grep -n "readStoredJob" plugins/codex/scripts/codex-companion.mjs`
Với mỗi kết quả, đảm bảo giá trị được `?? {}`/`?? null` hoặc truyền vào hàm render đã tolerate null. Sửa tại chỗ nếu chưa.

- [ ] **Step 5: Chạy test + full suite**

Run: `node --test tests/state.test.mjs && npm test`
Expected: PASS toàn bộ.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/lib/job-control.mjs plugins/codex/scripts/codex-companion.mjs
git commit -m "fix: readJobFile returns null on corrupt/missing file instead of throwing"
```

---

## Task 3: `wait` subcommand — chờ nhiều job theo status

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs` — thêm `handleWait`, case dispatch (:1031-1066), usage (:75-89)
- Test: `tests/runtime.test.mjs`

**Interfaces:**
- Consumes: `sleep(ms)` (companion:159), `parseCommandInput`, `resolveCommandCwd`, `buildStatusSnapshot(cwd,{all})` (companion:906 dùng nó), `listJobs`, `filterJobsForCurrentSession`/`sortJobsNewestFirst`, `isActiveJobStatus` (companion:331 dùng nó).
- Produces: subcommand `wait` in JSON `{ status: "resolved"|"timeout", matched: string[], jobs: [...] }` khi `--json`. `matched` = id các job đạt status trong `--types`.

- [ ] **Step 1: Viết test wait (fails)**

Thêm vào `tests/runtime.test.mjs` (theo pattern có sẵn dùng `fake-codex-fixture` + chạy companion qua helper). Test này chạy `wait` trên state đã dựng sẵn (không cần fake codex):

```js
test("wait resolves immediately when a job already reached a terminal status", async () => {
  // Dựng state: 1 job completed + 1 job running, trong CLAUDE_PLUGIN_DATA tmp.
  // (dùng cùng helper tạo cwd/state như các test runtime khác)
  const { cwd } = setupWorkspaceWithJobs([
    { id: "job-done", status: "completed", sessionId: SESSION },
    { id: "job-run", status: "running", sessionId: SESSION }
  ]);
  const out = await runCompanion(["wait", "--json", "--types", "completed,failed", "--timeout-ms", "1000"], {
    env: { CODEX_COMPANION_SESSION_ID: SESSION }
  });
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.status, "resolved");
  assert.deepEqual(payload.matched, ["job-done"]);
});

test("wait times out when no tracked job reaches a target status", async () => {
  const { cwd } = setupWorkspaceWithJobs([
    { id: "job-run", status: "running", sessionId: SESSION }
  ]);
  const out = await runCompanion(["wait", "--json", "--types", "completed", "--timeout-ms", "300", "--poll-interval-ms", "100"], {
    env: { CODEX_COMPANION_SESSION_ID: SESSION }
  });
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.status, "timeout");
  assert.deepEqual(payload.matched, []);
});
```

> Ghi chú: `setupWorkspaceWithJobs`/`runCompanion`/`SESSION` — dùng helper tương đương đã có trong `tests/helpers.mjs`/`runtime.test.mjs` cho status/result/cancel. Nếu chưa có `setupWorkspaceWithJobs`, thêm 1 helper nhỏ dùng `upsertJob`+`writeJobFile` để seed job (mirror cách các test status seed job).

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `node --test tests/runtime.test.mjs`
Expected: FAIL — `Unknown subcommand: wait` (chưa có case).

- [ ] **Step 3: Thêm `handleWait`**

Thêm vào `codex-companion.mjs` (gần `handleStatus`, sau dòng 908):

```js
const DEFAULT_WAIT_TARGET_STATUSES = ["completed", "failed"];

async function handleWait(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms", "types"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const targetStatuses = new Set(
    String(options.types ?? DEFAULT_WAIT_TARGET_STATUSES.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const timeoutMs = Math.max(0, Number(options["timeout-ms"]) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options["poll-interval-ms"]) || 1000);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const snapshot = buildStatusSnapshot(cwd, { all: options.all });
    const matched = snapshot.jobs.filter((job) => targetStatuses.has(job.status)).map((job) => job.id);
    if (matched.length > 0) {
      const payload = { status: "resolved", matched, jobs: snapshot.jobs };
      outputCommandResult(payload, renderStatusPayload(snapshot, false), options.json);
      return;
    }
    if (Date.now() >= deadline) {
      const payload = { status: "timeout", matched: [], jobs: snapshot.jobs };
      outputCommandResult(payload, renderStatusPayload(snapshot, false), options.json);
      return;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}
```

> Kiểm tra tên thật của builder/renderer status: dòng 906-907 dùng `buildStatusSnapshot(cwd, {all})` + `renderStatusPayload(report, json)`. Dùng đúng tên đó. Nếu `buildStatusSnapshot` trả shape khác `{jobs:[...]}`, chỉnh `.jobs` cho khớp (đọc định nghĩa `buildStatusSnapshot`).

- [ ] **Step 4: Đăng ký dispatch + usage**

Trong `switch` dispatch (companion:1031-1066) thêm:

```js
    case "wait":
      await handleWait(argv);
      break;
```

Trong `printUsage` (companion:75-89) thêm dòng:

```js
"  node scripts/codex-companion.mjs wait [--types <csv>] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--json]",
```

- [ ] **Step 5: Chạy test, xác nhận pass**

Run: `node --test tests/runtime.test.mjs`
Expected: PASS 2 test wait.

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/scripts/codex-companion.mjs tests/runtime.test.mjs
git commit -m "feat: add wait subcommand to block on multi-job terminal status"
```

---

## Task 4: `/codex:wait` command

**Files:**
- Create: `plugins/codex/commands/wait.md`
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Consumes: subcommand `wait` (Task 3).
- Produces: slash command `/codex:wait` passthrough thuần (mirror `status.md`).

- [ ] **Step 1: Thêm assertion vào `commands.test.mjs` (fails)**

`tests/commands.test.mjs` đã lint từng command markdown. Thêm case cho `wait.md`:

```js
test("wait command is a deterministic passthrough", () => {
  const doc = readCommand("wait.md"); // dùng helper đọc command đã có trong file test này
  assert.match(doc.frontmatter, /disable-model-invocation:\s*true/);
  assert.match(doc.frontmatter, /allowed-tools:\s*Bash\(node:\*\)/);
  assert.match(doc.body, /codex-companion\.mjs" wait/);
});
```

> Dùng đúng helper đọc command mà `commands.test.mjs` đang dùng cho `status.md`/`cancel.md` (mở file test xem tên helper: ví dụ `loadCommand`/`readCommand`).

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `node --test tests/commands.test.mjs`
Expected: FAIL — không tìm thấy `commands/wait.md`.

- [ ] **Step 3: Tạo `commands/wait.md`**

```markdown
---
description: Block until Codex background jobs in this session reach a terminal status
argument-hint: '[--types <csv>] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"`

Present the command output to the user:
- If `status` is `resolved`, list which job IDs finished (the `matched` field) and their summaries.
- If `status` is `timeout`, say the wait timed out and the listed jobs are still running.
- Keep it compact. Do not summarize away job IDs or follow-up commands.
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `node --test tests/commands.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full suite + build**

Run: `npm test && npm run build`
Expected: PASS. (build chỉ typecheck 4 file; wait nằm trong companion nên không bị typecheck — không sao ở plan này.)

- [ ] **Step 6: Commit**

```bash
git add plugins/codex/commands/wait.md tests/commands.test.mjs
git commit -m "feat: add /codex:wait slash command"
```

---

## Self-Review (đã chạy)

**Spec coverage (Phase 0+1):** 0.1 atomic+lock → Task 1 ✓ · 0.2 readJobFile → Task 2 ✓ · Phase 1 wait subcommand → Task 3 ✓ · `/codex:wait` command → Task 4 ✓. Phase 2/3/4 KHÔNG thuộc plan này (sẽ viết plan riêng sau khi Phase 0-1 land + smoke test A2).

**Placeholder scan:** không có TBD/TODO. 2 chỗ ghi "kiểm tra tên helper/builder thật" là *verify step có Run command cụ thể*, không phải placeholder — engineer chạy grep để lấy tên đúng vì tên helper test nội bộ chưa đọc hết.

**Type consistency:** `readJobFile` trả `null` (Task 2) — callers Task 2 Step 4 xử lý. `handleWait` payload `{status, matched, jobs}` nhất quán Task 3↔4. `buildStatusSnapshot`/`renderStatusPayload` dùng đúng tên tại companion:906-907.

## Ghi chú chuyển tiếp
- Plan 2 (Phase 2 worktree) + Plan 3 (Phase 3 DAG/fan-out) viết SAU khi plan này land. Phase 3 bắt buộc **smoke test A2** (chạy 2 `codex app-server` process song song thật) trước khi code — giả định chưa verify trong repo.
