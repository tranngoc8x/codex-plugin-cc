# Design — Codex Worker Pool (Tier 2 orchestration upgrade)

> Ngày: 16/07/2026 · Tác giả: Tony (thang.tn@urbox.vn)
> Base: fork của `openai/codex-plugin-cc` (v1.0.6)
> Nguồn ý tưởng: Orca orchestration SKILL (`stablyai/orca`)
> Tham chiếu phân tích: `CODEX-PLUGIN-ANALYSIS.md`

---

## 1. Mục tiêu & phi mục tiêu

**Mục tiêu.** Biến plugin từ "1 Codex helper" thành "coordinator điều phối 1 pool nhiều Codex worker chạy song song, an toàn, có phụ thuộc (DAG)". Lấy các primitive từ Orca (task DAG, dispatch song song, structured wait, escalation, decision gate) nhưng ép vào ràng buộc thực tế của Codex app-server đã verify bằng code.

**Phi mục tiêu (deferred / Tier 3).**
- Hỏi-lại **giữa chừng turn** (mid-turn elicitation). Protocol app-server **không hỗ trợ**: `AppServerMethodMap` cố định 9 method, không có `elicit/approval/question` (proto.d.ts:59-69); `approvalPolicy` hardcode `"never"` (codex.mjs:67,80). Chờ upstream.
- Nới broker lock theo threadId (phương án A1). Không làm — dùng A2 (process riêng mỗi worker) để né.
- Thay đổi giao thức JSON-RPC với app-server.

---

## 2. Quyết định kiến trúc (đã chốt, có bằng chứng)

| Quyết định | Lý do (bằng chứng code) |
|---|---|
| **A2**: mỗi worker = 1 `codex app-server` process riêng + git worktree riêng, KHÔNG dùng broker chung | Broker serialize toàn bộ app-server, không theo thread (broker:173-182, so `!== socket` kệ threadId). A2 né hẳn lock. cwd per-invocation đã hỗ trợ đầy đủ (companion:144-153 `-C/--cwd` → spawn app-server.mjs:190 + thread/start codex.mjs:63-72,733). |
| **Worktree là trụ cột**, không phải nice-to-have | Song song ghi code chỉ an toàn khi mỗi worker ở worktree riêng (không ghi đè). Hiện KHÔNG có code worktree (grep 0 hit) — worktree path chỉ là 1 cwd hợp lệ. |
| **B bản turn-boundary**, không mid-turn | Turn chạy tự trị tới `turn/completed` hoặc bị `turn/interrupt` giết (codex.mjs:490-556, 563). Escalation phải ở ranh giới turn: worker emit `NEEDS_INPUT` rồi dừng → coordinator `thread/resume` với câu trả lời (resume đã có: codex.mjs:75-83,751). |
| **Coordinator loop sống trong skill prose + primitive nhỏ**, không hardcode engine lớn | Claude đã là reasoning layer. Chỉ cần primitive `task-list --ready` + `wait`; loop do skill điều khiển. Giảm code, giảm bề mặt lỗi. |
| **Fix 2 P0 trước** (Phase 0) | DAG với worker song song làm race state.json tệ hơn. Không có nền atomic thì fan-out không an toàn. |

---

## 3. Kiến trúc tổng thể

```
Claude (coordinator, dùng skill mới codex-orchestration)
  │
  │  /codex:orchestrate  <plan nhiều subtask có deps>
  ▼
codex-companion.mjs  (dispatch mở rộng)
  │
  ├─ DAG store trong state.json  (job record + deps[]/parent)   [Phase 3]
  │
  ├─ coordinator loop:
  │     readyJobs() → dispatch tới --max-concurrent
  │        │
  │        ├─ worker 1 ──► git worktree #1 ──► codex app-server #1 (cwd=wt1)  [A2+C]
  │        ├─ worker 2 ──► git worktree #2 ──► codex app-server #2 (cwd=wt2)
  │        └─ worker N ...
  │
  ├─ wait(--types done,escalation --timeout)  block tới terminal   [Phase 1/D]
  │
  └─ escalation: worker emit NEEDS_INPUT → dừng → Claude reply → thread/resume  [Phase 4/B-lite]

session-end hook: cleanup worktrees + terminate worker processes  (mở rộng cleanupSessionJobs)
```

Nguyên tắc isolation: mỗi unit 1 nhiệm vụ rõ, giao tiếp qua interface hẹp, test độc lập được.

---

## 4. Thiết kế theo phase

### Phase 0 — Nền (prereq, ship độc lập)

**0.1 Atomic + locked state write.**
- `state.mjs:92-122` `updateState`: bọc bằng lock (spin `fs.mkdirSync(lockDir)` với retry+timeout, hoặc `fs.openSync(lock, 'wx')`), ghi qua `state.json.tmp` rồi `fs.renameSync` (atomic trên cùng filesystem).
- `state.mjs:166-171` `writeJobFile`: cùng pattern temp+rename.
- Không thêm dependency (ponytail: dùng `fs` core, không `proper-lockfile`).

**0.2 Harden `readJobFile`** (`state.mjs:173-175`): thêm try/catch trả `null` như `loadState` (state.mjs:75-77). Route callers job-control.mjs:188, tracked-jobs.mjs:109,139 xử lý null.

**Test:** race test — spawn 2 process cùng `updateState` concurrent, assert không mất entry; corrupt tmp file → không ảnh hưởng `state.json` chính; truncated job file → `readJobFile` trả null không throw.

**Ship-worthy riêng:** background job hiện tại an toàn ngay.

---

### Phase 1 — Structured wait [D]

**1.1 subcommand `wait`** trong `codex-companion.mjs` dispatch (:1031-1066).
- Args: `--types done,escalation,failed` (default `done,failed`), `--timeout-ms` (default 0 = vô hạn có heartbeat log), `--job <id>` (default: tất cả job active của session).
- Logic: poll job state (filterJobsForCurrentSession đã có) tới khi job khớp `--types` reach terminal, hoặc timeout. Trả JSON `{status, jobs:[...]}`.
- Rẻ: build hoàn toàn trên state.json + `getCurrentSessionId`.

**1.2 command `/codex:wait`** (`commands/wait.md`): passthrough thuần (`disable-model-invocation:true`, `Bash(node:*)`), mirror `status.md`.

**Test:** wait trả ngay khi job đã done; timeout trả `{status:"timeout"}`; escalation surface đúng.

---

### Phase 2 — Worktree isolation [C]

**2.1 `git.mjs`: worktree helpers.**
- `createReviewWorktree(baseRef, {cwd})`: `git worktree add --detach <tmpPath> <baseRef>` (shell:false như hiện tại git.mjs:12-13). `tmpPath` dưới state dir (`worktrees/<jobId>/`).
- `removeWorktree(path)`: `git worktree remove --force <path>` + fallback `git worktree prune`.
- Trả path để truyền `--cwd`.

**2.2 `task` subcommand nhận `--worktree[=<ref>]`** (`codex-companion.mjs` parseCommandInput + buildTaskRequest:604): nếu set, tạo worktree từ ref (default: HEAD), chạy Codex với `cwd = worktreePath` (plumbing đã có), lưu `worktreePath` vào job record.

**2.3 Cleanup.** `session-lifecycle-hook.mjs` `cleanupSessionJobs`: sau khi terminate job, `removeWorktree(job.worktreePath)` nếu có. Cũng cleanup khi job kết thúc bình thường (tracked-jobs completion).

**Test:** worktree tạo đúng ref; Codex ghi vào worktree không đụng repo chính; cleanup xoá worktree; cleanup an toàn khi worktree đã bị xoá tay.

**Ship-worthy riêng:** 1 write-task chạy cô lập, review diff trước merge.

---

### Phase 3 — DAG + fan-out song song [A2 + F]  ← tính năng chính

**3.1 DAG data model.** Job record (state.mjs / tracked-jobs.mjs) thêm:
- `deps: string[]` (job id phụ thuộc)
- `parent: string | null`
- `orchestrationId: string` (nhóm các job cùng 1 lệnh orchestrate)
- status thêm `blocked` (deps chưa xong), `ready` (deps xong, chưa dispatch)

**3.2 `tracked-jobs.mjs`: `readyJobs(orchestrationId)`** = job status `blocked` mà mọi `deps` đã `completed` → chuyển `ready`.

**3.3 subcommand `orchestrate`.**
- Input: plan JSON `[{id, spec, deps:[], worktreeRef?}]` (qua `--plan-file` hoặc stdin — theo pattern `--prompt-file` companion:643-650).
- Tạo tất cả job (status `blocked`/`ready`).
- **Coordinator loop:**
  ```
  while (còn job chưa terminal):
    ready = readyJobs(orchId)
    while (running < maxConcurrent && ready còn):
      job = ready.shift()
      worktree = createReviewWorktree(job.worktreeRef ?? HEAD)   [A2+C]
      spawn worker: task-worker --cwd <worktree> (app-server RIÊNG, disableBroker)
    wait 1 job terminal (reuse Phase 1 wait logic, event-driven qua job state)
    mở khóa dependent
  gom result tất cả job → render
  ```
- `--max-concurrent` (default 2). Mỗi worker `disableBroker:true` → process app-server riêng (A2), né broker lock.

**3.4 `orchestrate` command + skill.**
- `commands/orchestrate.md`: model-mediated (Claude build plan từ yêu cầu user).
- **skill `codex-orchestration`** (mới): dạy Claude khi nào split thành DAG, cách viết plan, cách đọc kết quả gom, cách xử lý escalation. Mirror kỷ luật `codex-cli-runtime` nhưng cho nhiều worker.

**Test:** DAG 3 job (A→B, A→C) chạy đúng thứ tự; B,C song song sau A; maxConcurrent=1 ép tuần tự; 1 worker fail → dependent thành `blocked`/skip + báo; worktree mỗi worker độc lập.

---

### Phase 4 — Escalation [B-lite] (optional)

**4.1 Convention.** Prompt worker (trong skill/prompt): "Nếu thiếu thông tin để làm an toàn, in `NEEDS_INPUT: <câu hỏi>` ở dòng đầu và DỪNG, đừng đoán."
**4.2 Parse.** `parseStructuredOutput`/result: dòng đầu `NEEDS_INPUT:` → job status `escalation`, lưu question.
**4.3 Resume.** Coordinator (Claude) đọc escalation qua `/codex:wait`/`status`, trả lời, gọi `task --resume <threadId>` với câu trả lời (resume đã có codex.mjs:751). Loop tiếp.

**Test:** worker emit NEEDS_INPUT → job escalation, không đếm là done; resume với answer → tiếp tục cùng thread.

---

## 5. Error handling
- Worktree tạo fail (ref không tồn tại) → job fail sớm, message rõ, không spawn worker.
- Worker process chết bất ngờ → job `failed` (pid cleared), dependent `blocked`, coordinator báo, không treo loop.
- state.json lock timeout → throw rõ, không ghi đè mù (Phase 0).
- maxConcurrent worker + broker fallback: worker dùng `disableBroker` nên KHÔNG đụng broker chung; log rõ mỗi app-server process spawn (sửa luôn "fan-out vô hình" từ analysis).
- Protocol drift (unknown notification/item): log 1 dòng sau env flag `CODEX_COMPANION_DEBUG` ở default branch (codex.mjs:554) — kèm theo vì fan-out làm hang khó chẩn đoán hơn.

## 6. Testing tổng thể
- Mở rộng `fake-codex-fixture.mjs` để giả lập nhiều app-server process song song + delay khác nhau.
- Drift-lint test cho skill `codex-orchestration` + command mới (mirror `commands.test.mjs`).
- Thêm vào CI: `npm run check-version`, mở rộng `tsconfig` include các file mới, (khuyến nghị) node matrix 20+22.

## 7. Rủi ro & giả định
- **Giả định chưa verify:** `codex app-server` upstream chạy được nhiều process song song trên 1 máy (A2). Rủi ro thấp — mỗi process độc lập, auth/config dùng chung file read-only. **Cần smoke test thật đầu Phase 3.**
- N worker = N process Codex = tốn usage limit nhanh. `--max-concurrent` default thấp (2) + cảnh báo trong command (như warning review-gate hiện có).
- Worktree đẻ nhiều thư mục tạm → cleanup phải chắc (session-end + per-job). Rủi ro rác đĩa nếu cleanup miss.

## 8. Logistics (fork)
1. `gh repo fork openai/codex-plugin-cc --clone` ra thư mục làm việc riêng (ngoài `~/.claude/plugins/marketplaces`).
2. Copy `CODEX-PLUGIN-ANALYSIS.md` + design này vào fork, commit.
3. Làm theo phase, mỗi phase 1 nhánh + PR nội bộ.
4. Test local qua `/plugin marketplace add <đường-dẫn-fork>`.
5. (Optional) upstream các fix P0 (Phase 0) về `openai/codex-plugin-cc` — giá trị cho cộng đồng, không phụ thuộc phần orchestration.

## 9. Thứ tự thực thi & effort
Phase 0 (~1 ngày) → Phase 1 (~0.5 ngày) → Phase 2 (~1 ngày) → **smoke test A2** → Phase 3 (~3-4 ngày) → Phase 4 optional (~1 ngày).
Mỗi phase ship được độc lập; dừng sau bất kỳ phase nào vẫn có giá trị.
