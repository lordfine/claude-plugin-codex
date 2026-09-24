#!/usr/bin/env node
//
// claude-code MCP server.
//
// A tiny, zero-dependency MCP stdio server that lets Codex consult Claude Code.
// It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio
// transport). stdout carries ONLY protocol messages; all logging goes to stderr.
//
// `node claude-mcp-server.mjs`              → run the MCP stdio server.
// `node claude-mcp-server.mjs worker --job-id <id>` → run one background job.
//
import process from "node:process";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runClaude } from "./lib/claude-runner.mjs";
import { getLastSession, setLastSession } from "./lib/session-store.mjs";
import { openProgressLog, progressLogPath } from "./lib/progress-log.mjs";
import { generateJobId, listJobs, nowIso, pruneJobs, readJob, updateJob, writeJob } from "./lib/jobs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { runVerify, renderVerify } from "./lib/verify.mjs";
import { loadSettings } from "./lib/settings.mjs";
import { collectDiff } from "./lib/git-diff.mjs";
import { checkManagedReadiness } from "./lib/managed-readiness.mjs";
import {
  createManagedTask, createReviewTask, listManagedTasks, managedStatus, managedTranscript, control, waitManaged,
  pendingPermissions, decidePermission, openVisibleWindow, setConcurrencyLimit, cancelManaged,
  managedDiff, mergeManaged
} from "./lib/managed-service.mjs";

const SERVER_NAME = "claude-code";
const SERVER_VERSION = "0.12.1";

// claude CLI's --effort levels (claude --help).
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Default model: the newest Claude — the second opinion people install this
// for. Applied only when neither the call nor the settings pick a model, and
// always paired with a fallback so plans without access to the newest model
// degrade gracefully instead of erroring. `"inherit"` (per call or in
// settings) defers to the user's own Claude configuration.
const DEFAULT_MODEL = "fable";
// Tried in order when fable is unavailable: opus keeps the quality bar high,
// sonnet is the last-resort safety net for plans that have neither.
const DEFAULT_FALLBACK_MODEL = "opus,sonnet";
const INHERIT_MODEL = "inherit";
// Versions this server actually implements. If the client asks for something
// else, answer with the latest one we support (per the MCP spec) instead of
// echoing an arbitrary string back.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF_PATH = fileURLToPath(import.meta.url);

// Stability guards. The env overrides exist for tests (and unusual setups);
// normal installs should rely on the defaults.
const MAX_CONCURRENT_JOBS = 4;
const WORKER_MAX_RUNTIME_MS =
  Number(process.env.CC_PLUGIN_CODEX_WORKER_TIMEOUT_MS) > 0
    ? Number(process.env.CC_PLUGIN_CODEX_WORKER_TIMEOUT_MS)
    : 45 * 60 * 1000;
// Foreground cap: a bit under Codex's 1800s tool_timeout_sec (.mcp.json), so
// the caller gets a real error (and the claude process is reaped) instead of
// the client giving up while claude keeps burning tokens server-side.
const FOREGROUND_MAX_RUNTIME_MS =
  Number(process.env.CC_PLUGIN_CODEX_FG_TIMEOUT_MS) > 0
    ? Number(process.env.CC_PLUGIN_CODEX_FG_TIMEOUT_MS)
    : 28 * 60 * 1000;

// Live foreground consults by JSON-RPC request id, so notifications/cancelled
// and session shutdown can terminate them — a foreground claude must never
// outlive the request that started it.
const activeForegroundRuns = new Map();

function log(message) {
  process.stderr.write(`[claude-code-mcp] ${message}\n`);
}

function send(message) {
  // A write to a half-closed pipe must never take the server down — if the
  // host is truly gone, stdin 'end' handles the shutdown.
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (err) {
    log(`failed to write to stdout: ${err?.message ?? err}`);
  }
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const CONSULT_TOOL = {
  name: "consult",
  description:
    "Consult Claude Code on a task in this repository. Claude runs in the given directory using the user's existing Claude login and reports back a gentle, thorough second opinion. By default it only investigates and advises (no file edits); set edit=true to let it make changes. Claude also has access to the user's installed Claude Code skills (e.g. `frontend-design` for UI work) — name a skill in your prompt to have Claude use it, and pair it with edit=true for skills that generate code. For long tasks set background=true to return immediately with a job id, then poll consult_status / consult_result. Infer edit/background/verify from the user's intent (edit when they want changes made; background for anything beyond a quick task; verify=\"auto\" for edit tasks) instead of asking them to specify flags. Always pass the absolute path of the repo you are working in as `cwd`.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "What you'd like Claude to look at, investigate, or do. Be specific about the goal."
      },
      cwd: {
        type: "string",
        description:
          "Absolute path to the repository/directory Claude should work in (the directory you are currently working in). Required — it cannot be inferred."
      },
      edit: {
        type: "boolean",
        description: "Allow Claude to modify files. Default false (advisory / read-only)."
      },
      resume: {
        type: "boolean",
        description: "Continue the most recent Claude session for this directory instead of starting fresh. Default false."
      },
      model: {
        type: "string",
        description:
          "Optional Claude model: an alias ('sonnet', 'opus', 'fable') or a full model name. Default: 'fable' (the newest Claude, with automatic fallback to 'opus', then 'sonnet', if unavailable) unless the plugin settings say otherwise. Pass 'inherit' to use the user's own Claude configuration. Omit unless the user asks for a specific or cheaper model."
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description:
          "Optional effort level for the run. 'low' = quick and cheap, 'high'/'xhigh'/'max' = deeper work on hard problems. Default: the plugin settings' effort, else Claude's default — omit unless the user signals speed or depth."
      },
      background: {
        type: "boolean",
        description:
          "Run as a background job and return a job id immediately instead of blocking. Recommended for long tasks (large redesigns, multi-file work). Poll with consult_status and fetch with consult_result."
      },
      verify: {
        type: "string",
        description:
          "Optional command the SERVER runs (no approval gate) after Claude's edits, to verify them. Use \"auto\" to let the server pick a syntax check for whatever files Claude touched (recommended for edit tasks), or give a command like 'npm test' or 'python3 -m py_compile {files}' ({files} expands to the touched files). Its exit code and output are appended to the result. Note: explicit commands are subject to a safety policy (plain invocations of common build/test tools; no shell operators) — if a command is blocked, prefer \"auto\"."
      }
    },
    required: ["prompt", "cwd"],
    additionalProperties: false
  }
};

const SETUP_TOOL = {
  name: "setup",
  description:
    "检查 Node.js、Claude Code、当前模型配置和原生终端依赖；依赖缺失时在插件缓存目录安装。deep=true 会额外执行一次小型 Claude 登录验证。",
  inputSchema: {
    type: "object",
    properties: {
      deep: {
        type: "boolean",
        description: "通过一次简短真实 Claude 回复验证当前配置，消耗少量模型用量；默认 false。"
      }
    },
    additionalProperties: false
  }
};

const STATUS_TOOL = {
  name: "consult_status",
  description:
    "Check a background consult job: status (running/done/error/cancelled/timed_out), elapsed time, and recent activity from its live log. Omit job_id for the most recent job. Pass wait_seconds (e.g. 60) to long-poll: the call blocks until the job finishes or the wait elapses — much more efficient than polling in a loop.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job id from consult(background=true). Omit for the most recent job." },
      wait_seconds: {
        type: "number",
        description: "Block up to this many seconds (max 60) waiting for the job to finish before reporting. Recommended: 60."
      }
    },
    additionalProperties: false
  }
};

const RESULT_TOOL = {
  name: "consult_result",
  description:
    "Get the final result of a completed background consult job. Omit job_id for the most recent job. If it's still running, it tells you so.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job id from consult(background=true). Omit for the most recent job." }
    },
    additionalProperties: false
  }
};

const CANCEL_TOOL = {
  name: "consult_cancel",
  description:
    "Cancel a running background consult job (terminates the Claude process so it stops consuming usage). Omit job_id for the most recent job.",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job id from consult(background=true). Omit for the most recent job." }
    },
    additionalProperties: false
  }
};

const REVIEW_TOOL = {
  name: "review",
  description:
    "Have Claude Code review the changes in a repository — a careful, collaborative second pair of eyes (read-only, never edits). Reviews the uncommitted changes by default, or everything since a base ref (e.g. 'main') when comparing a branch. The server collects the git diff itself; Claude reads surrounding code for context and reports findings by severity with file:line references. Use background=true for large diffs and poll consult_status / consult_result.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Absolute path to the repository to review. Required — it cannot be inferred."
      },
      base: {
        type: "string",
        description: "Optional base ref (e.g. 'main'): review everything since its merge-base with HEAD instead of just uncommitted changes."
      },
      focus: {
        type: "string",
        description: "Optional focus — what the user is worried about (e.g. 'the retry logic', 'error handling in the new endpoints')."
      },
      model: { type: "string", description: "Optional Claude model (alias like 'sonnet'/'opus' or full name)." },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description: "Optional effort level — 'high' for a deep review of risky changes, 'low' for a quick pass."
      },
      background: {
        type: "boolean",
        description: "Run as a background job (recommended for large diffs). Returns a job id; poll consult_status / consult_result."
      }
    },
    required: ["cwd"],
    additionalProperties: false
  }
};

const MANAGED_TOOLS = [
  {
    name: "delegate_create",
    description: "创建托管 Claude Code 会话。新实现任务自动创建独立 Git 工作树；传入精确 session_id 时在原 cwd 续接既有会话。默认打开原生可见窗口，并复用当前 Claude Code/CCswitch 配置。",
    inputSchema: { type: "object", properties: {
      cwd: { type: "string", description: "绝对工作目录" },
      session_id: { type: "string", description: "仅接入既有会话时填写精确 UUID" },
      existing_idle_confirmed: { type: "boolean", description: "既有会话原进程已退出时才设 true；活动中的外部窗口不能被本桥接器直接接管" },
      model: { type: "string", description: "当前配置中的模型槽或实际模型名；省略则继承" },
      prompt: { type: "string", description: "可选的首条任务指令，待会话就绪后发送" },
      max_minutes: { type: "integer" }, max_turns: { type: "integer" }, subagent_limit: { type: "integer" },
      controller_id: { type: "string", description: "主控 Codex 任务 ID；通常从环境自动获取" },
      visible: { type: "boolean", description: "是否自动打开可见窗口，默认 true" }
    }, required: ["cwd"], additionalProperties: false }
  },
  {
    name: "delegate_list", description: "列出当前主控任务的托管 Claude 会话、并发名额和排队状态。",
    inputSchema: { type: "object", properties: { controller_id: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "delegate_status", description: "读取托管任务状态和增量事件。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, cursor: { type: "integer" }, limit: { type: "integer" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_transcript", description: "按需读取指定 Claude 会话近期的助手正文，用于查看实现交付或只读审查短报告。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, max_chars: { type: "integer" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_wait", description: "等待托管任务的关键事件；最长 60 秒，返回增量游标。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, cursor: { type: "integer" }, seconds: { type: "number" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_send", description: "向指定托管 Claude 会话排入一条指令，返回唯一指令 ID；状态须继续以事件确认。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, prompt: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id", "prompt"], additionalProperties: false }
  },
  {
    name: "delegate_takeover", description: "Codex 接管指定会话；默认等待当前轮结束，immediate=true 才中断。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, immediate: { type: "boolean" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_permissions", description: "读取或决定 Claude 敏感操作。未知操作由 Codex 决定；凭据等 user 类仅可拒绝，允许须用户在 Claude 窗口亲自操作。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, decision_id: { type: "string" }, decision: { type: "string", enum: ["allow", "deny"] }, reason: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_open", description: "打开或重新打开原生可见 Claude Code 窗口；Ctrl+D 只关闭窗口。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_limit", description: "设置当前 Codex 主控任务的顶层 Claude 并发上限（1 至 10；默认 3）。",
    inputSchema: { type: "object", properties: { limit: { type: "integer" }, controller_id: { type: "string" } }, required: ["limit"], additionalProperties: false }
  },
  {
    name: "delegate_cancel", description: "取消指定托管 Claude 会话。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_review", description: "为已空闲的实现任务创建独立只读 Claude 审查会话，输出短报告，Codex 负责最终验收。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, focus: { type: "string" }, model: { type: "string" }, max_minutes: { type: "integer" }, controller_id: { type: "string" }, visible: { type: "boolean" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_diff", description: "列出实现任务相对基准提交的改动范围，供 Codex 验收；临时 /交还 命令文件须排除。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_merge", description: "Codex 完成审查和定向检查后，把独立工作树合并进创建时的目标分支；要求对应只读审查任务和验收结论，冲突留给 Codex 处理。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, review_id: { type: "string" }, verification: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id", "review_id", "verification"], additionalProperties: false }
  }
];
const TOOLS = [SETUP_TOOL, ...MANAGED_TOOLS];

function managedResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function handleManagedCreate(args) {
  const created = createManagedTask(args);
  return managedResult({ ...created, window: args.visible === false ? "disabled" : "opens_when_started",
    initialPrompt: args.prompt ? "passed_to_claude_startup" : null });
}

async function handleManagedReview(args) {
  const created = createReviewTask(args.task_id, args);
  return managedResult({ ...created, window: args.visible === false ? "disabled" : "opens_when_started" });
}

// Separate files inside the task directory from artifacts written elsewhere
// (Claude's plan file, notes, …) — only the former are repo changes.
function splitTouchedFiles(touchedFiles, taskCwd) {
  const inRepo = [];
  const external = [];
  const root = path.resolve(taskCwd) + path.sep;
  for (const file of touchedFiles ?? []) {
    const resolved = path.resolve(taskCwd, String(file));
    (resolved.startsWith(root) ? inRepo : external).push(file);
  }
  return { inRepo, external };
}

function resolveTaskCwd(rawCwd) {
  if (typeof rawCwd === "string" && rawCwd.trim()) {
    const resolved = path.resolve(rawCwd.trim());
    try {
      if (fs.statSync(resolved).isDirectory()) {
        return { cwd: resolved, error: null };
      }
    } catch {
      // fall through to the error below
    }
    return { cwd: null, error: `The path \`${rawCwd}\` is not an existing directory.` };
  }
  return { cwd: null, error: "Please pass `cwd`: the absolute path of the directory Claude should work in." };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

function renderResult(run, { taskCwd, edit, usedResume }) {
  const lines = [];
  const verb = edit ? "made changes in" : "advised on";
  const session = run.sessionId ? ` (session ${run.sessionId})` : "";
  lines.push(`🤝 Claude Code ${verb} ${taskCwd}${session}.`);
  if (usedResume) {
    lines.push("Continued the previous Claude session for this directory.");
  }
  lines.push("");
  lines.push(run.result?.trim() || "(Claude returned no text.)");

  if (run.touchedFiles?.length) {
    lines.push("");
    lines.push("Files Claude touched:");
    for (const file of run.touchedFiles) {
      lines.push(`- ${file}`);
    }
  } else if (edit) {
    lines.push("");
    lines.push("Claude did not modify any files.");
  }

  // Writes outside the repository (e.g. Claude's own plan file in
  // ~/.claude/plans/) are working notes, not changes — reported separately so
  // a read-only run never looks like it modified something.
  if (run.externalFiles?.length) {
    const sample = run.externalFiles[0];
    const where = run.externalFiles.length === 1 ? sample : `${sample} (+${run.externalFiles.length - 1} more)`;
    lines.push("");
    lines.push(
      run.touchedFiles?.length
        ? `(Claude also kept working notes outside the repository: ${where}.)`
        : `(Claude kept its working notes outside the repository — ${where} — no repository files were modified.)`
    );
  }

  const meta = [];
  if (run.model) {
    // the model that actually served the run — makes the default (and any
    // automatic fallback) visible
    meta.push(run.model);
  }
  if (run.numTurns != null) {
    meta.push(`${run.numTurns} turn${run.numTurns === 1 ? "" : "s"}`);
  }
  const duration = formatDuration(run.durationMs);
  if (duration) {
    meta.push(duration);
  }
  if (typeof run.costUsd === "number") {
    // With the user's Claude login this is plan usage, not a separate bill —
    // say so, or the dollar figure reads as a surprise charge.
    meta.push(process.env.ANTHROPIC_API_KEY ? `$${run.costUsd.toFixed(4)} API-billed` : `≈$${run.costUsd.toFixed(4)} of plan usage`);
  }
  if (meta.length) {
    lines.push("");
    lines.push(`( ${meta.join(" · ")} )`);
  }
  return lines.join("\n");
}

// Turn a failed launch into the next action, so recovery doesn't depend on the
// model having read the skill instructions.
function launchHint(error, stderr = "") {
  const haystack = `${error ?? ""}\n${stderr ?? ""}`;
  if (/ENOENT/.test(haystack)) {
    return "\n→ Claude Code doesn't seem to be installed. Install it with `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g @anthropic-ai/claude-code`), then run the `setup` tool to confirm.";
  }
  if (/(log ?in|sign ?in|credential|authenticat|api key|unauthorized|\b401\b)/i.test(haystack)) {
    return "\n→ Claude doesn't seem to be signed in. Run `claude` once in a terminal to log in, or run the `setup` tool with deep: true to diagnose.";
  }
  return "\n→ Run the `setup` tool to diagnose (it checks the install and login).";
}

function parseConsultArgs(args) {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return { error: "Please provide a `prompt` describing what to ask Claude." };
  }
  const { cwd: taskCwd, error: cwdError } = resolveTaskCwd(args?.cwd);
  if (cwdError) {
    return { error: cwdError };
  }
  const edit = Boolean(args?.edit);

  // Per-call argument > plugin settings > built-in default (fable, with an
  // automatic fallback). "inherit" at any level → no flags, Claude's own
  // configuration decides.
  const settings = loadSettings();
  const chosen =
    (typeof args?.model === "string" && args.model.trim() ? args.model.trim() : null) ??
    (typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : null);
  let model;
  let fallbackModel = null;
  if (chosen) {
    model = chosen.toLowerCase() === INHERIT_MODEL ? null : chosen;
  } else {
    model = DEFAULT_MODEL;
    fallbackModel = DEFAULT_FALLBACK_MODEL;
  }
  const effortArg = typeof args?.effort === "string" ? args.effort.trim().toLowerCase() : "";
  if (effortArg && !EFFORT_LEVELS.has(effortArg)) {
    return { error: `Unknown effort \`${args.effort}\` — use one of: low, medium, high, xhigh, max.` };
  }
  const effort = effortArg || (EFFORT_LEVELS.has(settings.effort) ? settings.effort : null);

  const resumeId = args?.resume ? getLastSession(taskCwd) : null;
  const verify = typeof args?.verify === "string" && args.verify.trim() ? args.verify.trim() : null;
  const summary = typeof args?.summary === "string" && args.summary.trim() ? args.summary.trim() : null;
  return { prompt, taskCwd, edit, model, fallbackModel, effort, resumeId, verify, summary };
}

function launchBackgroundConsult({ prompt, taskCwd, edit, model, fallbackModel, effort, resumeId, verify, summary }) {
  const running = listJobs().filter((job) => job.status === "running").length;
  if (running >= MAX_CONCURRENT_JOBS) {
    return {
      content: [
        {
          type: "text",
          text: `Too many background consults already running (${running}/${MAX_CONCURRENT_JOBS}). Wait for one to finish, or cancel one with consult_cancel.`
        }
      ],
      isError: true
    };
  }

  const jobId = generateJobId();
  const logFile = progressLogPath(jobId);
  writeJob({
    id: jobId,
    status: "running",
    cwd: taskCwd,
    prompt,
    edit,
    resumeId,
    model,
    fallbackModel,
    effort,
    verify,
    summary: summary ?? prompt.replace(/\s+/g, " ").slice(0, 100),
    startedAt: nowIso(),
    completedAt: null,
    sessionId: null,
    logFile,
    pid: null,
    // Which server instance launched this job — session-end cleanup must only
    // ever touch its own jobs, never another live session's.
    launcherPid: process.pid
  });
  pruneJobs();

  const child = spawn(process.execPath, [SELF_PATH, "worker", "--job-id", jobId], {
    cwd: PLUGIN_ROOT,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  updateJob(jobId, { pid: child.pid ?? null });
  log(`launched background job ${jobId} (pid ${child.pid}) cwd=${taskCwd} edit=${edit}`);

  return {
    content: [
      {
        type: "text",
        text:
          `Started background consult job ${jobId} in ${taskCwd} (edit=${edit}).\n` +
          `- progress: consult_status ${jobId}\n` +
          `- result:   consult_result ${jobId}\n` +
          `- cancel:   consult_cancel ${jobId}\n` +
          `- live log: ${logFile}`
      }
    ]
  };
}

async function handleConsult(args, ctx) {
  const parsed = parseConsultArgs(args);
  if (parsed.error) {
    return { content: [{ type: "text", text: parsed.error }], isError: true };
  }
  const { prompt, taskCwd, edit, model, fallbackModel, effort, resumeId, verify } = parsed;

  if (args?.background) {
    return launchBackgroundConsult(parsed);
  }

  const progress = openProgressLog(taskCwd);
  progress.write(`consult · cwd=${taskCwd} · edit=${edit} · resume=${resumeId ?? "no"} · model=${model ?? "default"}`);
  log(`consult: cwd=${taskCwd} edit=${edit} resume=${resumeId ?? "no"} model=${model ?? "default"} log=${progress.file ?? "none"}`);

  // Register this run so notifications/cancelled and session shutdown can
  // terminate the claude process tree — it must never outlive the request.
  const requestId = ctx?.requestId;
  let childPid = null;
  const tracker = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      if (childPid != null) {
        terminateProcessTree(childPid);
      }
    }
  };
  if (requestId !== undefined && requestId !== null) {
    activeForegroundRuns.set(requestId, tracker);
  }

  try {
    const startedMs = Date.now();
    const run = await runClaude({
      cwd: taskCwd,
      prompt,
      edit,
      resumeId,
      model,
      fallbackModel,
      effort,
      progress,
      ownProcessGroup: true,
      maxRuntimeMs: FOREGROUND_MAX_RUNTIME_MS,
      onChild: (child) => {
        childPid = child.pid ?? null;
        if (tracker.cancelled) {
          terminateProcessTree(childPid);
        }
      }
    });
    run.durationMs = Date.now() - startedMs;
    childPid = null; // claude is done; only a verify child may need killing now

    if (tracker.cancelled) {
      progress.close("cancelled by client");
      log(`consult cancelled by client (request ${requestId})`);
      return { cancelled: true };
    }

    if (run.maxRuntimeExceeded) {
      progress.close();
      const logNote = progress.file ? `\n\n📋 Progress log: ${progress.file}` : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Claude Code hit the foreground time limit (${Math.round(FOREGROUND_MAX_RUNTIME_MS / 60000)}m) and was stopped. ` +
              `For work this long, use background=true and poll consult_status.${logNote}`
          }
        ],
        isError: true
      };
    }

    if (!run.ok && run.error) {
      progress.close();
      const logNote = progress.file ? `\n\n📋 Progress log: ${progress.file}` : "";
      return {
        content: [{ type: "text", text: `Could not run Claude Code: ${run.error}${launchHint(run.error, run.stderr)}${logNote}` }],
        isError: true
      };
    }

    const { inRepo: touchedInRepo, external: externalFiles } = splitTouchedFiles(run.touchedFiles, taskCwd);

    // Claude ran — optionally verify its edits from the server (no approval gate).
    let verifyResult = null;
    if (verify) {
      progress.write(`running verification: ${verify}`);
      verifyResult = await runVerify(taskCwd, verify, touchedInRepo, {
        onChild: (child) => {
          childPid = child.pid ?? null;
          if (tracker.cancelled) {
            terminateProcessTree(childPid);
          }
        }
      });
      childPid = null;
    }
    progress.close();

    if (tracker.cancelled) {
      log(`consult cancelled by client during verify (request ${requestId})`);
      return { cancelled: true };
    }

    if (run.sessionId) {
      setLastSession(taskCwd, run.sessionId);
    }

    let text = renderResult({ ...run, touchedFiles: touchedInRepo, externalFiles }, { taskCwd, edit, usedResume: Boolean(resumeId) });
    if (verifyResult) {
      text += renderVerify(verifyResult);
    }
    if (progress.file) {
      text += `\n\n📋 Progress log: ${progress.file} (tail -f to watch a run live)`;
    }
    if (run.isError) {
      const tail = run.stderr ? run.stderr.split("\n").slice(-3).join(" ") : "";
      text += `\n\n(Claude ended with: ${run.subtype ?? "error"}.${tail ? ` ${tail}` : ""})`;
      if (/(log ?in|sign ?in|credential|authenticat|api key|unauthorized|\b401\b)/i.test(run.stderr ?? "")) {
        text += launchHint("", run.stderr);
      }
      return { content: [{ type: "text", text }], isError: true };
    }
    return { content: [{ type: "text", text }] };
  } finally {
    if (requestId !== undefined && requestId !== null) {
      activeForegroundRuns.delete(requestId);
    }
  }
}

function buildReviewPrompt({ stat, patch, untracked, truncated, base, focus }) {
  const lines = [];
  lines.push(
    "Please review the following changes as a collaborative second pair of eyes — careful, specific, and kind."
  );
  lines.push("");
  lines.push("How to review:");
  lines.push(
    "- Read any files you need for context (you have read access to this repository); judge the change in its surroundings, not just the patch."
  );
  lines.push("- Report only findings you can ground in the code — no speculation. If something is fine, say so briefly.");
  lines.push("- Structure your reply as:");
  lines.push("  1. A two-or-three-sentence summary of what the change does.");
  lines.push("  2. What works well (brief).");
  lines.push("  3. Findings ordered by severity (bug / risk / suggestion), each with file:line and a concrete suggested fix.");
  lines.push("  4. An honest overall verdict.");
  if (focus) {
    lines.push("");
    lines.push(`Pay particular attention to: ${focus}`);
  }
  lines.push("");
  lines.push(base ? `Changes since the merge-base with \`${base}\`:` : "Uncommitted changes (staged + unstaged):");
  if (stat) {
    lines.push("", "```", stat, "```");
  }
  if (untracked?.length) {
    lines.push("", "Untracked files (not in the patch — read them directly if relevant):");
    for (const file of untracked) {
      lines.push(`- ${file}`);
    }
  }
  lines.push("", "```diff", patch, "```");
  if (truncated) {
    lines.push("", "(The patch was truncated for size — use your file tools in the repository for the full picture.)");
  }
  return lines.join("\n");
}

// Gentle code review: the server gathers the diff itself, then hands Claude a
// read-only consult with a collaborative review prompt. Everything else —
// cancellation, watchdogs, background jobs — is the consult machinery.
async function handleReview(args, ctx) {
  const { cwd: taskCwd, error: cwdError } = resolveTaskCwd(args?.cwd);
  if (cwdError) {
    return { content: [{ type: "text", text: cwdError }], isError: true };
  }
  const base = typeof args?.base === "string" && args.base.trim() ? args.base.trim() : null;
  const focus = typeof args?.focus === "string" && args.focus.trim() ? args.focus.trim() : null;
  log(`review: cwd=${taskCwd} base=${base ?? "working-tree"} background=${Boolean(args?.background)}`);

  const diff = await collectDiff(taskCwd, base);
  if (diff.error) {
    const fallback = /not inside a git repository/.test(diff.error)
      ? " You can still get a review: call the `consult` tool (read-only) and ask Claude to read and review the relevant files directly."
      : "";
    return { content: [{ type: "text", text: `Nothing to review: ${diff.error}.${fallback}` }], isError: true };
  }
  if (diff.empty) {
    return {
      content: [
        {
          type: "text",
          text: base
            ? `Nothing to review — no changes since \`${base}\`.`
            : "Nothing to review — the working tree is clean."
        }
      ]
    };
  }

  return handleConsult(
    {
      prompt: buildReviewPrompt({ ...diff, focus }),
      cwd: taskCwd,
      edit: false,
      background: Boolean(args?.background),
      model: args?.model,
      effort: args?.effort,
      summary: `review (${base ? `vs ${base}` : "working tree"})${focus ? `: ${focus}` : ""}`
    },
    ctx
  );
}

async function handleSetup(args) {
  const deep = Boolean(args?.deep);
  log(`setup: deep=${deep}`);
  const status = checkManagedReadiness({ deep });
  return managedResult(status);
}

// Resolve the target job, distinguishing "no jobs at all" from "the id you gave
// doesn't match any job" so the message isn't misleading.
function resolveJob(args) {
  const jobs = listJobs();
  const jobId = args?.job_id;
  if (jobId) {
    const job = jobs.find((j) => j.id === jobId);
    return job ? { job } : { error: `No job found with id \`${jobId}\`.` };
  }
  if (jobs.length === 0) {
    return { error: "No background consult jobs found." };
  }
  return { job: jobs[0] };
}

function formatElapsed(job) {
  const start = Date.parse(job.startedAt || "");
  if (!Number.isFinite(start)) {
    return "";
  }
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m${rest}s` : `${rest}s`;
}

function tailLog(file, count = 8) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-count).join("\n") || "(no activity yet)";
  } catch {
    return "(no log yet)";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleStatusTool(args) {
  let { job, error } = resolveJob(args);
  if (error) {
    return { content: [{ type: "text", text: error }] };
  }

  // Long-poll: park here until the job leaves "running" or the wait elapses,
  // so the caller doesn't burn turns polling in a loop.
  const waitMs = Math.min(Math.max(Number(args?.wait_seconds) || 0, 0), 60) * 1000;
  if (waitMs > 0 && job.status === "running") {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(1000, deadline - Date.now()));
      const fresh = readJob(job.id);
      if (fresh) {
        job = fresh;
      }
      if (job.status !== "running") {
        break;
      }
    }
    // Re-resolve through listJobs so a worker that died mid-wait is
    // reconciled instead of reported as eternally "running".
    job = listJobs().find((j) => j.id === job.id) ?? job;
  }

  const head = `Job ${job.id} · ${job.status} · ${formatElapsed(job)} · ${job.cwd}`;
  const task = job.summary ? `Task: ${job.summary}\n` : "";
  const footer =
    job.status === "running"
      ? `\n\n(still running — call consult_result ${job.id} when it's done)`
      : `\n\n(call consult_result ${job.id} for the full result)`;
  return {
    content: [{ type: "text", text: `${head}\n${task}\nRecent activity:\n${tailLog(job.logFile, 8)}${footer}` }]
  };
}

function handleResultTool(args) {
  const { job, error } = resolveJob(args);
  if (error) {
    return { content: [{ type: "text", text: error }] };
  }
  if (job.status === "running") {
    return {
      content: [
        { type: "text", text: `Job ${job.id} is still running (${formatElapsed(job)}). Use consult_status ${job.id} to watch progress.` }
      ]
    };
  }
  if (job.status === "cancelled") {
    return { content: [{ type: "text", text: `Job ${job.id} was cancelled.\n\n📋 Progress log: ${job.logFile}` }] };
  }
  if (job.status === "timed_out") {
    return {
      content: [
        { type: "text", text: `Job ${job.id} exceeded the max runtime and was terminated. ${job.error ?? ""}\n\n📋 Progress log: ${job.logFile}` }
      ],
      isError: true
    };
  }

  const r = job.result ?? {};

  // A job that never produced a result (launch failure, or a worker that died
  // and was reconciled) must explain itself, not render an empty result.
  if (job.status === "error" && (r.error || !job.result)) {
    const reason = r.error ?? job.error ?? "unknown error";
    const logNote = job.logFile ? `\n\n📋 Progress log: ${job.logFile}` : "";
    return {
      content: [{ type: "text", text: `Could not run Claude Code: ${reason}${launchHint(reason, r.stderr)}${logNote}` }],
      isError: true
    };
  }

  const durationMs = Date.parse(job.completedAt || "") - Date.parse(job.startedAt || "");
  let text = renderResult(
    { result: r.result, sessionId: r.sessionId, touchedFiles: r.touchedFiles, externalFiles: r.externalFiles, numTurns: r.numTurns, costUsd: r.costUsd, durationMs, model: r.model },
    { taskCwd: job.cwd, edit: job.edit, usedResume: Boolean(job.resumeId) }
  );
  if (r.verify) {
    text += renderVerify(r.verify);
  }
  if (job.logFile) {
    text += `\n\n📋 Progress log: ${job.logFile}`;
  }
  if (r.isError) {
    const tail = r.stderr ? r.stderr.split("\n").slice(-3).join(" ") : "";
    text += `\n\n(Claude ended with: ${r.subtype ?? "error"}.${tail ? ` ${tail}` : ""})`;
    return { content: [{ type: "text", text }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

function handleCancelTool(args) {
  const { job, error } = resolveJob(args);
  if (error) {
    return { content: [{ type: "text", text: error }] };
  }
  if (job.status !== "running") {
    return { content: [{ type: "text", text: `Job ${job.id} is not running (status: ${job.status}).` }] };
  }
  const killed = terminateProcessTree(job.pid);
  if (job.verifyPid != null) {
    terminateProcessTree(job.verifyPid); // verify shell runs in its own group
  }
  // Re-read before stamping: the worker may have finished in the meantime, and
  // a completed result must not be relabelled as cancelled.
  const fresh = readJob(job.id) ?? job;
  if (fresh.status !== "running") {
    return {
      content: [
        { type: "text", text: `Job ${job.id} finished just before cancellation (status: ${fresh.status}) — its result is preserved.` }
      ]
    };
  }
  updateJob(job.id, { status: "cancelled", completedAt: nowIso(), error: "cancelled by user" });
  return { content: [{ type: "text", text: `Cancelled job ${job.id}${killed ? "" : " (process was already gone)"}.` }] };
}

async function handleMessage(message) {
  const { id, method, params } = message ?? {};

  // Notifications carry no id and expect no reply.
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled") {
      const tracker = activeForegroundRuns.get(params?.requestId);
      if (tracker) {
        log(`client cancelled request ${params?.requestId}${params?.reason ? ` (${params.reason})` : ""}`);
        tracker.cancel();
      }
    }
    return;
  }

  switch (method) {
    case "initialize": {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
      reply(id, {
        protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const handlers = {
        setup: handleSetup,
        delegate_create: handleManagedCreate,
        delegate_list: (args) => managedResult(listManagedTasks(args.controller_id)),
        delegate_status: (args) => managedResult(managedStatus(args.task_id, args.controller_id, args.cursor, args.limit)),
        delegate_transcript: (args) => managedResult(managedTranscript(args.task_id, args.controller_id, args.max_chars)),
        delegate_wait: async (args) => managedResult(await waitManaged(args.task_id, args.cursor, args.seconds, args.controller_id)),
        delegate_send: async (args) => managedResult(await control(args.task_id, { type: "send", prompt: args.prompt }, args.controller_id)),
        delegate_takeover: async (args) => managedResult(await control(args.task_id, { type: "takeover", immediate: args.immediate }, args.controller_id)),
        delegate_permissions: (args) => managedResult(args.decision_id
          ? decidePermission(args.task_id, args.decision_id, args.decision, args.reason, args.controller_id)
          : pendingPermissions(args.task_id, args.controller_id)),
        delegate_open: (args) => managedResult(openVisibleWindow(args.task_id, args.controller_id)),
        delegate_limit: (args) => managedResult(setConcurrencyLimit(args.limit, args.controller_id)),
        delegate_cancel: async (args) => managedResult(await cancelManaged(args.task_id, args.controller_id)),
        delegate_review: handleManagedReview,
        delegate_diff: (args) => managedResult(managedDiff(args.task_id, args.controller_id)),
        delegate_merge: async (args) => managedResult(await mergeManaged(args.task_id, args.review_id, args.verification, args.controller_id))
      };
      const handler = handlers[params?.name];
      if (!handler) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const result = await handler(params?.arguments ?? {}, { requestId: id });
        // A request cancelled via notifications/cancelled gets no response
        // (the client already gave up on it — per the MCP cancellation spec).
        if (result?.cancelled === true && !result.content) {
          return;
        }
        reply(id, result);
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: `Unexpected error in ${params?.name}: ${err?.message ?? String(err)}` }],
          isError: true
        });
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

// One background job: read its stored request, run Claude with a live log, and
// write the outcome back to the job file. A watchdog bounds the runtime so a
// stuck/runaway run can never burn usage indefinitely.
async function runWorker() {
  const idx = process.argv.indexOf("--job-id");
  const jobId = idx >= 0 ? process.argv[idx + 1] : null;
  const job = jobId ? readJob(jobId) : null;
  if (!job) {
    log(`worker: no job found for ${jobId}`);
    process.exit(1);
    return;
  }

  updateJob(jobId, { status: "running", pid: process.pid });
  const progress = openProgressLog(job.cwd, { key: jobId });
  progress.write(`background job ${jobId} · cwd=${job.cwd} · edit=${job.edit} · resume=${job.resumeId ?? "no"}`);

  let timedOut = false;
  let verifyPid = null;
  const watchdog = setTimeout(() => {
    timedOut = true;
    progress.write("■ watchdog: exceeded max runtime — terminating");
    updateJob(jobId, {
      status: "timed_out",
      completedAt: nowIso(),
      error: `exceeded max runtime (${Math.round(WORKER_MAX_RUNTIME_MS / 60000)}m)`
    });
    progress.close();
    if (verifyPid != null) {
      terminateProcessTree(verifyPid); // verify runs in its own group
    }
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {
      // ignore
    }
    process.exit(1);
  }, WORKER_MAX_RUNTIME_MS);

  // claude joins THIS worker's process group (no ownProcessGroup), so killing
  // the worker group — by cancel or by the watchdog — also kills claude.
  const run = await runClaude({
    cwd: job.cwd,
    prompt: job.prompt,
    edit: job.edit,
    resumeId: job.resumeId,
    model: job.model,
    fallbackModel: job.fallbackModel ?? null,
    effort: job.effort ?? null,
    progress
  });
  if (timedOut) {
    return;
  }
  const { inRepo: touchedInRepo, external: externalFiles } = splitTouchedFiles(run.touchedFiles, job.cwd);
  let verifyResult = null;
  if (job.verify) {
    progress.write(`running verification: ${job.verify}`);
    // The verify shell is its own group (so its timeout can group-kill it);
    // record its pid so cancel/cleanup/watchdog can reach it too.
    verifyResult = await runVerify(job.cwd, job.verify, touchedInRepo, {
      onChild: (child) => {
        verifyPid = child.pid ?? null;
        updateJob(jobId, { verifyPid });
      }
    });
    verifyPid = null;
    updateJob(jobId, { verifyPid: null });
  }
  clearTimeout(watchdog);
  if (timedOut) {
    return;
  }
  progress.close();
  if (run.sessionId) {
    setLastSession(job.cwd, run.sessionId);
  }
  updateJob(jobId, {
    status: run.error || run.isError ? "error" : "done",
    completedAt: nowIso(),
    sessionId: run.sessionId ?? null,
    result: {
      result: run.result ?? "",
      isError: Boolean(run.isError),
      subtype: run.subtype ?? null,
      numTurns: run.numTurns ?? null,
      costUsd: run.costUsd ?? null,
      touchedFiles: touchedInRepo,
      externalFiles,
      sessionId: run.sessionId ?? null,
      model: run.model ?? null,
      error: run.error ?? null,
      stderr: run.stderr ?? "",
      verify: verifyResult
    }
  });
  process.exit(0);
}

function cleanupRunningJobsOnExit() {
  try {
    for (const job of listJobs()) {
      // Only reap jobs THIS server launched — a concurrent Codex session's
      // jobs belong to its own server instance.
      if (job.status === "running" && job.launcherPid === process.pid && Number.isFinite(Number(job.pid))) {
        terminateProcessTree(job.pid);
        if (job.verifyPid != null) {
          terminateProcessTree(job.verifyPid);
        }
        updateJob(job.id, { status: "cancelled", completedAt: nowIso(), error: "session ended" });
      }
    }
  } catch {
    // best effort
  }
}

// Session is ending — reap everything this server started: foreground claude
// runs AND this session's background workers. Nothing may outlive the session
// and keep burning usage.
function shutdown(why) {
  for (const tracker of activeForegroundRuns.values()) {
    try {
      tracker.cancel();
    } catch {
      // best effort
    }
  }
  activeForegroundRuns.clear();
  cleanupRunningJobsOnExit();
  log(`${why}, exiting`);
  process.exit(0);
}

function main() {
  log(`starting (plugin root: ${PLUGIN_ROOT})`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        log(`failed to parse incoming line: ${err.message}`);
        continue;
      }
      // 不阻塞输入循环，等待事件的工具与其他 MCP 请求可以并行。
      Promise.resolve(handleMessage(message)).catch((err) => log(`handler error: ${err?.message ?? err}`));
    }
  });
  process.stdin.on("end", () => shutdown("stdin closed"));
  // Lifecycle is stdin + SIGTERM/SIGHUP (host-initiated). SIGINT is a terminal
  // interrupt aimed at the host's turn, not at this server — a stdio MCP
  // server that exits on it takes the whole bridge down for the session.
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("SIGINT", () => log("ignoring SIGINT (terminal interrupt) — lifecycle is stdin/SIGTERM"));
  // A tool server should degrade, not die: log the unexpected, keep serving.
  process.stdout.on("error", (err) => log(`stdout error: ${err?.message ?? err}`));
  process.on("uncaughtException", (err) => log(`uncaught exception (continuing): ${err?.stack ?? err}`));
  process.on("unhandledRejection", (reason) => log(`unhandled rejection (continuing): ${reason?.stack ?? reason}`));
}

if (process.argv[2] === "worker") {
  runWorker().catch((err) => {
    log(`worker error: ${err?.message ?? err}`);
    process.exit(1);
  });
} else {
  main();
}
