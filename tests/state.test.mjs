import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

// updateState is fully synchronous, so same-process Promise.all runs cycles
// sequentially and can never exercise the real hazard: two separate `node`
// processes each doing load -> mutate -> rename on the same state file. The
// tests below spawn genuine child processes to exercise that cross-process
// race, which is what the mkdir-based lock in state.mjs actually guards.

const STATE_MODULE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/codex/scripts/lib/state.mjs"
);

// ponytail: the sleep between load and mutate lives only in this test child,
// never in prod code — it widens the race window so a missing lock fails
// reliably instead of depending on lucky OS scheduling.
const SINGLE_UPDATE_CHILD_SOURCE = `
import { pathToFileURL } from "node:url";
const { updateState } = await import(pathToFileURL(process.argv[2]).href);
const cwd = process.argv[3];
const jobId = process.argv[4];
const sleepMs = Number(process.argv[5] || 0);

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

updateState(cwd, (state) => {
  sleepSync(sleepMs);
  state.jobs.push({ id: jobId, updatedAt: new Date().toISOString() });
});
`;

const LOOP_UPDATE_CHILD_SOURCE = `
import { pathToFileURL } from "node:url";
const { updateState } = await import(pathToFileURL(process.argv[2]).href);
const cwd = process.argv[3];
const prefix = process.argv[4];
const iterations = Number(process.argv[5] || 30);

for (let index = 0; index < iterations; index += 1) {
  updateState(cwd, (state) => {
    state.jobs.push({ id: \`\${prefix}-\${index}\`, updatedAt: new Date().toISOString() });
  });
}
`;

function writeChildScript(dir, name, source) {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

// resolveStateDir reads process.env.CLAUDE_PLUGIN_DATA at call time. Children
// get it via their own spawn `env` override regardless, but the parent
// process's calls (loadState/resolveStateFile below) need it set too, or
// they resolve a different directory than the one the children wrote to.
function withPluginDataEnv(cwd, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = cwd;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

function spawnChild(scriptPath, cwd, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, STATE_MODULE_PATH, cwd, ...extraArgs], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: cwd }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited with code ${code}: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

test("concurrent cross-process updateState does not lose job entries", async () => {
  const cwd = makeTempDir();
  const scriptPath = writeChildScript(cwd, "update-state-child.mjs", SINGLE_UPDATE_CHILD_SOURCE);
  const childCount = 20;

  // Spawn all children first, THEN await — same-process Promise.all around a
  // synchronous function would just serialize the calls and prove nothing.
  const children = Array.from({ length: childCount }, (_unused, index) =>
    spawnChild(scriptPath, cwd, [`job-${index}`, "20"])
  );
  await Promise.all(children);

  const ids = withPluginDataEnv(cwd, () => new Set(loadState(cwd).jobs.map((job) => job.id)));
  for (let index = 0; index < childCount; index += 1) {
    assert.ok(ids.has(`job-${index}`), `missing job-${index}`);
  }
});

test("state file reads are never torn while multiple processes write concurrently", async () => {
  const cwd = makeTempDir();
  const scriptPath = writeChildScript(cwd, "update-state-loop-child.mjs", LOOP_UPDATE_CHILD_SOURCE);
  const writerCount = 5;
  const iterations = 30;
  const stateFile = withPluginDataEnv(cwd, () => resolveStateFile(cwd));

  let readerActive = true;
  let readerError = null;
  const reader = (async () => {
    while (readerActive) {
      if (fs.existsSync(stateFile)) {
        try {
          JSON.parse(fs.readFileSync(stateFile, "utf8")); // raw read, not loadState (which swallows parse errors)
        } catch (error) {
          readerError = error;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();

  const writers = Array.from({ length: writerCount }, (_unused, index) =>
    spawnChild(scriptPath, cwd, [`writer${index}`, String(iterations)])
  );
  await Promise.all(writers);
  readerActive = false;
  await reader;

  assert.equal(readerError, null, `torn read detected: ${readerError?.message}`);
});
