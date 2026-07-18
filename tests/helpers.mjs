import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

// Tests that seed jobs with no sessionId assume no active session filter.
// Without this, an ambient CODEX_COMPANION_SESSION_ID (e.g. set by a Claude
// Code session the suite happens to run inside) leaks in and hides those
// jobs. CLAUDE_PLUGIN_DATA is left untouched: these tests derive their state
// dir via resolveStateDir(workspace) in-process, and the spawned child must
// see the same CLAUDE_PLUGIN_DATA to resolve to the same directory.
export function cleanEnv() {
  const env = { ...process.env };
  delete env.CODEX_COMPANION_SESSION_ID;
  return env;
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
