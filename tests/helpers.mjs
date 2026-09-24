// Shared helpers for the test suite. Tests are Linux/macOS-oriented (the
// /proc scans are Linux-only; those assertions are skipped elsewhere).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "claude-code");
export const SERVER_PATH = path.join(PLUGIN_ROOT, "scripts", "claude-mcp-server.mjs");
export const FIXTURES_BIN = path.join(REPO_ROOT, "tests", "fixtures", "bin");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return value;
    await sleep(intervalMs);
  }
}

// A throwaway HOME so tests never touch the user's real
// ~/.cache/cc-plugin-codex or ~/.claude state.
export function makeTempHome(prefix = "cc-plugin-codex-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const jobsDir = (home) => path.join(home, ".cache", "cc-plugin-codex", "jobs");

// Env for a server/runner that should find the FAKE claude on PATH and keep
// all state under a temp HOME.
export function fakeClaudeEnv(tmpHome, extra = {}) {
  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PATH: `${FIXTURES_BIN}${path.delimiter}${process.env.PATH}`,
    // point the verify policy at a (normally nonexistent) file inside the temp
    // home so the user's real settings never leak into tests
    CC_PLUGIN_CODEX_SETTINGS: path.join(tmpHome, "settings.json"),
    ...extra
  };
  // cost rendering depends on this — make tests deterministic regardless of
  // the machine running them
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function writeFakeJob(home, id, patch = {}) {
  const dir = jobsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    status: "running",
    cwd: home,
    prompt: "fake",
    edit: false,
    resumeId: null,
    model: null,
    verify: null,
    summary: "fake test job",
    startedAt: new Date(Date.now() - 120000).toISOString(),
    completedAt: null,
    sessionId: null,
    logFile: null,
    pid: 999999,
    launcherPid: 999998,
    ...patch
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}

export const readJobFile = (home, id) => JSON.parse(fs.readFileSync(path.join(jobsDir(home), `${id}.json`), "utf8"));

// Scan /proc for fake-claude processes whose cwd sits under `cwdPrefix` —
// scoped so concurrent test files (and the user's own sessions) never collide.
export function claudeProcsUnder(cwdPrefix) {
  if (process.platform !== "linux") return "";
  const out = [];
  for (const ent of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${ent}/cwd`);
      if (!cwd.startsWith(cwdPrefix)) continue;
      const argv = fs.readFileSync(`/proc/${ent}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!argv.length) continue;
      const base0 = (argv[0] || "").split("/").pop();
      const base1 = (argv[1] || "").split("/").pop();
      if (base0 === "claude" || (base0 === "node" && base1 === "claude")) out.push(`${ent} ${argv.join(" ").slice(0, 90)}`);
    } catch {
      // process vanished mid-scan
    }
  }
  return out.join("\n");
}

// Minimal JSON-RPC stdio client around a spawned MCP server. Uses
// process.execPath (not "node" via the child PATH) so PATH-crippling tests
// and CI runners without a system node still work.
export function startServer(env = process.env) {
  const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      } catch {
        // non-JSON noise is a server bug surfaced by protocol tests
      }
    }
  });
  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderrBuf += c));

  let nextId = 1;
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const rpcWithId = (method, params, timeoutMs = 30000) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  };
  const rpc = (method, params, timeoutMs) => rpcWithId(method, params, timeoutMs).promise;
  const rpcRawId = (id, method, params, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const raw = (s) => child.stdin.write(s);
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  return { child, rpc, rpcWithId, rpcRawId, notify, raw, stop, stderr: () => stderrBuf };
}

export async function initialized(server) {
  const init = await server.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-suite", version: "0" }
  });
  server.notify("notifications/initialized", {});
  return init;
}

export const text = (resp) => resp?.result?.content?.map((c) => c.text).join("\n") ?? "";
