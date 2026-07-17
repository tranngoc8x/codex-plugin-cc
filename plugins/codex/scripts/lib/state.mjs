import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getMainRepoRoot } from "./git.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
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

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// Jobs/state are keyed by the main repo root, so the job index is shared
// between a repo and all its linked worktrees.
export function resolveStateDir(cwd) {
  return stateDirForRoot(getMainRepoRoot(cwd) ?? resolveWorkspaceRoot(cwd));
}

// Runtime (broker/app-server) state stays keyed per worktree toplevel:
// each worktree runs its own app-server so parallel workers don't contend.
export function resolveRuntimeStateDir(cwd) {
  return stateDirForRoot(resolveWorkspaceRoot(cwd));
}

function stateDirForRoot(workspaceRoot) {
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

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

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  const tmp = `${jobFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, jobFile);
  return jobFile;
}

export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch {
    return null; // missing or corrupt (e.g. truncated by a crashed writer)
  }
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
