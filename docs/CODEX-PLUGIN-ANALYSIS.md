# Phân tích sâu — Codex plugin cho Claude Code

> Repo: `openai/codex-plugin-cc` — bản local sync đúng upstream, **v1.0.6 (mới nhất)**.
> Phân tích ngày 16/07/2026. Người thực hiện: Tony (thang.tn@urbox.vn).
> File này là bản ghi nghiên cứu để tham chiếu lại, không phải plan thực thi.

---

## 0. TL;DR

- Plugin = **cầu nối** Claude Code ↔ Codex CLI local. Không có runtime riêng, không gọi API OpenAI trực tiếp — dùng lại `codex` binary + auth + config sẵn trên máy.
- Codebase **chín, kỷ luật cao**: ~5.3K LOC runtime, ~3.7K LOC test, security tốt, prose↔test đồng bộ.
- "Nâng cấp" ≠ pull bản mới (đã mới nhất). Giá trị thật ở **độ bền vận hành**: sửa race `state.json`, giảm process fan-out của broker, làm protocol-drift quan sát được.
- ⚠️ Thư mục này là **clone marketplace** (`~/.claude/plugins/marketplaces/...`), sửa trực tiếp sẽ bị ghi đè khi `/plugin update`. Làm thật nên **fork**.

---

## 1. Kiến trúc & luồng dữ liệu

Luồng 1 lệnh (`/codex:review`):

```
slash command (.md) → node codex-companion.mjs <sub> "$ARGS"
  → parseCommandInput → dispatch switch (codex-companion.mjs:1031-1066)
  → withAppServer → broker (Unix socket / Windows named pipe)
       ↓ nếu broker busy/chết → fallback spawn "codex app-server" trực tiếp
  → JSON-RPC 2.0 newline-delimited (JSONL) qua stdio
  → captureTurn: gom notification stream → state machine (lib/codex.mjs)
  → renderReviewResult → stdout verbatim về Claude
```

**Broker pattern** (điểm hay nhất): 1 process detached giữ **1 app-server ấm**, multiplex nhiều lần gọi companion (mỗi `/codex:*` là 1 Node process mới) vào đó → khỏi trả phí startup mỗi lệnh + cho phép `cancel` (`turn/interrupt`) chạm turn đang bay từ process khác. Lifecycle: `ensureBrokerSession` (broker-lifecycle.mjs:113) check `broker.json`, health-probe 150ms, respawn nếu chết. Lock single-flight global: caller thứ 2 nhận `BROKER_BUSY_RPC_CODE = -32001`, trừ `turn/interrupt` được cho qua.

### Phân tầng module

| Tầng | File | LOC | Trách nhiệm |
|------|------|-----|-------------|
| Entrypoint | `scripts/codex-companion.mjs` | 1073 | dispatch switch, parse arg, handlers |
| Core state machine | `scripts/lib/codex.mjs` | 1219 | turn-capture, multi-agent tracking, auth/provider, API công khai |
| Transport | `lib/app-server.mjs` + `app-server-broker.mjs` + `broker-lifecycle.mjs` + `broker-endpoint.mjs` | ~700 | JSON-RPC JSONL, direct vs broker |
| Persistence | `lib/state.mjs` + `lib/tracked-jobs.mjs` + `lib/job-control.mjs` | ~700 | state.json, per-job file, background job lifecycle |
| Support | `lib/git.mjs`, `render.mjs`, `args.mjs`, `process.mjs`, `fs.mjs`, `workspace.mjs`, `claude-session-transfer.mjs`, `prompts.mjs` | ~1200 | git target, render markdown, parse arg, kill process tree |

### Surface người dùng

8 slash command → cùng 1 dispatcher `codex-companion.mjs <sub> "$ARGUMENTS"`:

- **Passthrough thuần** (`disable-model-invocation:true`, `!node ...`): `cancel`, `result`, `status`, `transfer`
- **Model-mediated** (Claude reason rồi chạy node): `review`, `adversarial-review`, `setup`
- **Qua subagent**: `rescue` → forward tới subagent `codex:codex-rescue` (không gọi script trực tiếp). Map `spark`→`gpt-5.3-codex-spark`, `--effort` enum `none|minimal|low|medium|high|xhigh`, default `--write`.

Subcommand nội bộ (không expose): `task`, `task-worker`, `task-resume-candidate`.

3 skills (`user-invocable:false`, scope cho rescue subagent):
- `codex-cli-runtime` — hợp đồng forwarder: đúng 1 lần gọi `task` mỗi rescue, cấm `setup/review/status/result/cancel`, normalize flag, return stdout verbatim
- `codex-result-handling` — trình bày output: giữ verdict/summary/findings, sort theo severity, **cấm auto-apply fix từ review**
- `gpt-5-4-prompting` — steer prompt XML block-structured, "prompt Codex như operator, không như collaborator"

### Hook lifecycle (`hooks/hooks.json`)

- **SessionStart** (`session-lifecycle-hook.mjs`): append `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH`, `CLAUDE_PLUGIN_DATA` vào `CLAUDE_ENV_FILE`
- **SessionEnd**: shutdown broker, terminate process tree job queued/running của session, prune state
- **Stop** (`stop-review-gate-hook.mjs`, timeout 900s): nếu `config.stopReviewGate` bật → spawn `task --json <stop-review-prompt>`. `ALLOW:`→pass, `BLOCK:`→block. **Fail closed** (lỗi/timeout/invalid→block) trừ unavailable/disabled (**fail open**).

---

## 2. Điểm mạnh (giữ nguyên, đừng đụng)

- Broker single-runtime — tránh spawn app-server mỗi lệnh
- `tests/commands.test.mjs` = **linter cho prompt markdown** → chống drift prompt (verify frontmatter, tools, review-only framing, "continue" không expose)
- Stop-review-gate **fail closed** — đúng chuẩn an toàn
- Job isolation theo session
- Git args `shell:false` toàn bộ (git.mjs:12-13) → chống injection tốt
- CI SHA-pin actions
- Kỷ luật "verbatim passthrough" enforce cả prose lẫn test
- Test end-to-end mạnh: `runtime.test.mjs` (2259 dòng) drive toàn runtime qua `fake-codex-fixture.mjs` (658 dòng fake Codex/app-server)

---

## 3. Vấn đề nghiêm trọng (ranked)

### 🔴 P0 — Race condition trên state.json
`state.mjs:92-122`. `updateState` = load→mutate→`writeFileSync`, **không lock, không atomic** (không temp+rename). 2 background job song song → last-writer-wins, mất entry index 1 job. Crash giữa write → corrupt → `loadState` nuốt lỗi parse trả `defaultState()` (state.mjs:75-77) → **xoá sạch job index im lặng**. Bug đắt nhất: background concurrency chính là feature mà đang không an toàn.
Kèm: `runTrackedJob` writeJobFile **rồi** upsertJob = 2 op non-atomic (tracked-jobs.mjs:151-152) → reader ở giữa thấy state không nhất quán.

### 🔴 P0 — Broker fallback nhân đôi process
`codex.mjs:635`, `app-server-broker.mjs:170-198`. Lock single-flight global: background task chặn foreground review bằng `BROKER_BUSY`, `withAppServer` "giải quyết" bằng **spawn thêm 1 codex app-server đầy đủ** → phá mục tiêu shared-runtime, nhân process Codex. Im lặng, không log.

### 🟠 P1 — Protocol drift vô hình
`codex.mjs:554` (`applyTurnNotification` `default:break`), switch `item.type` (406-488) drop method lạ **im lặng**. Completion phụ thuộc thấy `agentMessage` phase `final_answer` + `turn/completed` (430,541). Codex đổi tên field → hang tới khi timer 250ms (383) hoặc parent-poll timeout cứu, **không 1 dòng cảnh báo**. Điểm dễ vỡ nhất khi Codex CLI lên version.

### 🟠 P1 — Coupling file nội bộ Codex
`codex.mjs:661-679`. `transfer` parse `$CODEX_HOME/external_agent_session_imports.json` — schema nội bộ không tài liệu. Codex đổi schema → cả feature `transfer` chết.

### 🟡 P2 — readJobFile không try/catch
`state.mjs:173-175`. File `.json` truncated (crash giữa write) → throw xuyên qua status/progress, khác `loadState` phòng thủ. Callers: job-control.mjs:188, tracked-jobs.mjs:109,139.

### Vấn đề nhỏ khác
- String-match error `startThread` (codex.mjs:738-745) fragile — nên dùng `rpcCode===-32601` như đã có ở :1072
- `getCodexAvailability` double-spawn `codex --version` + `codex app-server --help` mỗi lần gọi (886-903), gọi 6+ lần/lệnh, **không memoize**
- 5 throw "not installed" trùng verbatim (codex.mjs:255/1005/1061/1098/1165)
- 2 impl `shorten()` khác nhau (companion:163 limit 96 vs codex.mjs:90 limit 72) — drift risk
- `reviewRange` tính mà không dùng (git.mjs:74); guard `supportedScopes` đặt sau return working-tree (git.mjs:152-164) — dead ordering
- Unknown flag nuốt im lặng (args.mjs:48,70): typo `--scop` thành positional, sai scope không báo lỗi
- `isProbablyText` chỉ scan null-byte 4KB đầu (fs.mjs:25-33) → UTF-16 misclassify thành text, dump vào prompt
- `buildResultStatus` (codex.mjs:754) key success theo `status==="completed"` nhưng inferred path synthesize `{status:"completed"}` (360-363) → turn force-complete luôn báo exit 0 dù `state.error` set

---

## 4. Cơ hội nâng cấp (ranked theo giá trị/công)

| # | Việc | File | Giá trị |
|---|------|------|---------|
| 1 | **Atomic + locked state write** (temp+`renameSync`, lock dir) | state.mjs:92-122,166-171 | Sửa P0 race — cao nhất |
| 2 | **Memoize `getCodexAvailability`** (Map theo cwd) | codex.mjs:886-904 | Bỏ hầu hết subprocess thừa, ~1 dòng |
| 3 | **Log khi broker fallback-spawn** + xét queue/per-thread routing | codex.mjs:635, broker:170-198 | Lộ process fan-out |
| 4 | **Protocol drift observable** — trace 1 dòng sau env flag ở default branch | codex.mjs:554, 406-488 | Chẩn đoán version-break |
| 5 | **Gom 5 throw "not installed"** → `assertCodexAvailable(cwd)` | codex.mjs:255/1005/1061/1098/1165 | DRY |
| 6 | **Thay string-match bằng `rpcCode===-32601`** ở `startThread` | codex.mjs:738-745 | Bớt fragile |
| 7 | **CI: thêm `npm run check-version`** | ci.yml, bump-version.mjs:214 | Chống desync marketplace.json, 1 dòng yaml |
| 8 | **Mở rộng tsconfig include** — hiện chỉ typecheck 4 file | tsconfig.app-server.json:15-22 | Static analysis file lớn nhất chưa được check |
| 9 | **Drift-lint test cho skills + codex-rescue.md** | tests/ | Chống drift 4 file prose |
| 10 | **Schema-validate review output** | tests/, schemas/review-output.schema.json | Đồng bộ prompt↔schema |
| 11 | **ESLint flat config + node matrix (20,22)** | ci.yml | Bắt lỗi style/unused; CI chỉ chứng minh node 22 |

**Hardcode nên đưa vào config** (tất cả đang cứng):
- `MAX_JOBS=50` (state.mjs:13)
- untracked 24KB (git.mjs:7)
- inline-diff 2 file/256KB (git.mjs:8-9)
- default-branch `main/master/trunk` (git.mjs:103)
- timer completion 250ms (codex.mjs:383)
- tên binary `"codex"` (app-server.mjs:190) — không có `CODEX_BIN` override

---

## 5. Gaps test/CI

- Skills + `codex-rescue.md`: **không có drift-guard** (khác commands.test). Mapping `spark`, enum `--effort`, default `--write` chỉ là prose, chưa assert.
- `prompts/` placeholders (`{{TARGET_LABEL}}`, `{{USER_FOCUS}}`, `{{REVIEW_COLLECTION_GUIDANCE}}`, `{{CLAUDE_RESPONSE_BLOCK}}`): không test khớp key
- `review-output.schema.json`: **chưa từng dùng làm schema** trong test
- CI (`.github/workflows/pull-request-ci.yml`): **node 22 only**, không lint, không chạy check-version, build chỉ typecheck 4 file (`app-server/codex/fs/process`), `tsconfig` `strict:false noImplicitAny:false`
- `prebuild` chạy `codex app-server generate-ts` → build phụ thuộc Codex CLI global cài sẵn; Codex đổi → CI build vỡ độc lập với repo code

---

## 6. Nhận định & hướng đi

Không phải "nâng cấp vì cũ" — đã version mới nhất. Cơ hội thật ở **độ bền vận hành**, 3 thứ dễ cắn khi Codex CLI lên version hoặc chạy nhiều background job:

1. Sửa race `state.json` (P0)
2. Giảm process fan-out của broker (P0)
3. Làm protocol-drift quan sát được (P1)

**Trước khi code**: fork repo (tránh bị `/plugin update` ghi đè), rồi làm theo thứ tự bảng mục 4. Việc #1 (atomic state) là highest-value; #2, #7 là 1-dòng/rẻ.
