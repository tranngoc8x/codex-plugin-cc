---
description: Block until Codex background jobs in this session reach a terminal status
argument-hint: '[--types <csv>] [--jobs <csv>] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" wait "$ARGUMENTS"`

Present the command output to the user:
- If `status` is `resolved`, list which job IDs finished (the `matched` field) and their summaries.
- If `status` is `timeout`, say the wait timed out and the listed jobs are still running.
- Keep it compact. Do not summarize away job IDs or follow-up commands.
- Pass `--jobs <csv>` to scope matching to specific job IDs so an old, already-finished job doesn't cause an instant false match.
- `--timeout-ms 0` is not "no timeout" — it falls back to the default 240000ms wait.
