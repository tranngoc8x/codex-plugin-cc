---
name: codex-orchestration
description: Use when the user wants several independent Codex tasks run in parallel, or a large task split into concurrent subtasks and their results collected — a fan-out / worker-pool over Codex. Not for a single delegation (use codex:rescue for that).
user-invocable: false
---

# Codex Orchestration (fan-out coordinator)

You are the coordinator. Codex workers run as background `task` jobs, each isolated in its own git worktree and its own app-server process (verified to run concurrently). You launch them, wait on them, review each worker's diff, and sequence dependent work. There is no server-side engine — you are the DAG.

## When to use
- The user asks to run multiple Codex tasks at once, or a job cleanly splits into independent subtasks (e.g. "have Codex refactor these 3 modules in parallel").
- NOT for a single task — that is `codex:rescue`.

## The loop
1. **Decompose** the request into subtasks and note dependencies (which must finish before others start). Independent subtasks form one "wave". Track the wave/dependency state in your own todo list.
2. **Launch a wave** — for each ready subtask run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --worktree --write "<subtask prompt>"`
   Capture each `jobId` from the output. Launch **at most --max-concurrent (default 3)** at once — each running worker spawns an app-server, so more workers burn more usage and machine load.
3. **Wait** for the wave:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait --jobs <id1,id2,...> --json`
4. **Collect + review** each finished worker:
   - `... result <jobId>` for Codex's summary.
   - The result/status output includes a `Worktree:` path. Inspect the real changes with `git -C <worktreePath> diff HEAD`. Review before trusting.
5. **Merge deliberately.** Never auto-apply. Show each worker's diff to the user; apply to the main tree only after review, resolving conflicts between workers yourself.
6. **Advance the DAG.** Once a wave's results unlock dependents, launch the next wave (back to step 2).
7. **On failure/escalation**, a worker returns `failed`; surface it and decide whether to retry (`--fresh`) or skip its dependents.

## Escalation (a worker needs input)
A worker that lacks information to proceed safely should stop and ask rather than guess.
- When launching a `--write` worker, prepend this line to its prompt: `If you lack the information to proceed safely, output "NEEDS_INPUT: <your question>" as the very first line and stop — do not guess.`
- After `result <jobId>`, if the output's first line is `NEEDS_INPUT:`, that worker is **escalated**, not done: it blocks its dependents until resolved.
- Get the answer (ask the user if you don't have it), then resume that exact worker in its own worktree:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --cwd <worktreePath> --resume-last --write "<the answer>"`
  Each worktree has its own Codex thread, so `--resume-last` there continues that worker, not another.
- Re-review the resumed worker's diff before merging, same as any wave result.

## Guardrails
- Read-only subtasks: omit `--write`. Only pass `--write` when the subtask must edit code.
- Never merge a worker's diff without showing it to the user first.
- Worktrees are cleaned up automatically at session end; to reclaim one earlier, `cancel <jobId>`.
- Keep waves small (`--max-concurrent` 3). Coordinate concurrency yourself — there is no runtime cap.
