# Codex Worker Pool — Implementation Plan 4 (Phase 4: turn-boundary escalation)

> Chunked small so a session cut never leaves a half-done task. Each chunk ends in its own commit.

**Goal:** A Codex worker that lacks information to proceed safely stops and asks, instead of guessing. The coordinator answers and resumes that worker's thread. Turn-boundary only (mid-turn elicitation is unsupported by the app-server — deferred).

**Architecture (ponytail):** No new protocol, no new subcommand. Convention + existing `--resume-last`:
- Worker prompt tells it: if blocked, emit `NEEDS_INPUT: <question>` as the first line and stop.
- The final message (which carries that line) is already shown by `result <id>`.
- Coordinator reads it, answers, and resumes the worker in its own worktree: `task --cwd <worktreePath> --resume-last "<answer>"` (each worktree = its own thread, so `--resume-last` targets that worker).

## Global Constraints
- Node ≥18.18; no new deps; tests `node --test`; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; branch `feat/worker-pool`; `git -C` for commits (no `cd &&`); test env unset `CLAUDE_PLUGIN_DATA CODEX_COMPANION_SESSION_ID CODEX_COMPANION_TRANSCRIPT_PATH`; baseline 110.

## Chunks

### Chunk 1 — escalation convention in the orchestration skill (the feature)
Update `plugins/codex/skills/codex-orchestration/SKILL.md`: add an "Escalation" section instructing (a) prepend the NEEDS_INPUT instruction to each `--write` worker prompt, (b) after `result <id>`, if the output's first line is `NEEDS_INPUT:`, get the answer from the user and resume via `task --cwd <worktreePath> --resume-last "<answer>"`, (c) treat an escalated worker as blocking its dependents until resolved.
Test: extend the drift-lint in `tests/commands.test.mjs` to assert the skill mentions `NEEDS_INPUT` and `--resume-last`.
Deliverable: working escalation via convention. Commit: `feat: teach orchestration skill the NEEDS_INPUT escalation convention`.

### Chunk 2 — surface NEEDS_INPUT in `result` output (nicety)
In `executeTaskRun` (codex-companion.mjs ~499-531): detect a leading `NEEDS_INPUT:` in `rawOutput`; add `needsInput: true` + `question` to `payload`. In `renderStoredJobResult` (render.mjs): when `storedJob.result?.needsInput`, prepend a `⚠ NEEDS INPUT: <question>` banner + a resume hint line. So the coordinator spots escalation at a glance instead of eyeballing raw text.
Test: `render.test.mjs` — a stored job whose `result.needsInput` renders the banner; and `runtime.test.mjs` or a unit check that a `NEEDS_INPUT:`-leading final message sets `payload.needsInput`.
Deliverable: structured escalation signal. Commit: `feat: surface NEEDS_INPUT escalation in result output`.

## Deferred
- True mid-turn ask (app-server has no elicit/approval method — see analysis). Revisit if upstream adds it.
- Auto-answer / merge_ready.
