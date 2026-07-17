import test from "node:test";
import assert from "node:assert/strict";

import { renderJobStatusReport, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderStoredJobResult flags a NEEDS_INPUT escalation with a banner", () => {
  const output = renderStoredJobResult(
    { id: "task-1", status: "completed", title: "Codex Task", jobClass: "task", threadId: "thr_1" },
    { threadId: "thr_1", result: { rawOutput: "NEEDS_INPUT: which database port?" } }
  );
  assert.match(output, /NEEDS INPUT: which database port\?/);
  assert.match(output, /--resume-last/);
});

test("renderStoredJobResult does not add a banner for ordinary output", () => {
  const output = renderStoredJobResult(
    { id: "task-2", status: "completed", title: "Codex Task", jobClass: "task", threadId: "thr_2" },
    { threadId: "thr_2", result: { rawOutput: "Done. Refactored the module." } }
  );
  assert.doesNotMatch(output, /NEEDS INPUT/);
});

test("job details surface the worktree path when present", () => {
  const output = renderJobStatusReport({
    id: "job-x",
    kind: "task",
    status: "completed",
    jobClass: "task",
    worktreePath: "/tmp/state/worktrees/job-x"
  });
  assert.match(output, /Worktree: \/tmp\/state\/worktrees\/job-x/);
});

test("job details omit the worktree line when absent", () => {
  const output = renderJobStatusReport({
    id: "job-y",
    kind: "task",
    status: "completed",
    jobClass: "task"
  });
  assert.doesNotMatch(output, /Worktree:/);
});
