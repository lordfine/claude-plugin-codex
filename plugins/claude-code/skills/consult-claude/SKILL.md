---
name: consult-claude
description: 当用户希望 Codex 指挥 Claude Code 执行、审查或继续指定会话的工作时使用。通过 claude-code MCP 的 delegate_* 工具管理可见窗口、实时事件、权限和验收。
metadata:
  short-description: Codex 指挥托管 Claude Code 会话
---

# Codex 指挥 Claude Code

Codex 负责拆分、关键判断、验收和必要的亲自修改；Claude Code 在明确边界内实现。使用 `delegate_*` 托管接口。

## 新任务

1. 用 `delegate_create` 传绝对仓库路径 `cwd` 与清楚的 `prompt`。新实现任务自动进入独立 Git 工作树。默认自动打开可见 Claude 窗口；若排队，空位出现后再用 `delegate_open` 打开。
2. `model` 省略即沿用当前 Claude Code/CCswitch 配置；只可在已配置的模型槽或实际模型名中选择。不得替用户修改 CCswitch。
3. 每个 Codex 主控任务默认最多 3 个顶层会话，可用 `delegate_limit` 调整到最多 10 个。每个 Claude 会话子代理默认 8 个，可单项调整到 20 个。任务默认 90 分钟和主会话 120 轮。
4. 用 `delegate_wait` 按 `cursor` 等关键事件，或用 `delegate_status` 查看状态。用 `delegate_transcript` 按需读取 Claude 交付正文。不要频繁拉取完整记录。
5. `delegate_send` 返回指令 ID 和排队/写入状态；只有 `instruction_submitted` 才证明 Claude 收到，`instruction_completed` 才证明该轮完成。回执不明时先查事件，不自动重发。

## 人工窗口与接管

用户可直接在可见窗口输入；`Ctrl+D` 只关闭窗口客户端，后台任务继续。重新打开用 `delegate_open`。窗口里 `/交还` 将控制权交回 Codex。Codex 主动接管用 `delegate_takeover`，默认等当前轮和人工输入队列结束；只有用户明确要求立即接管才设 `immediate=true`。

接入未托管的既有会话时，先让原 Claude 进程结束当前工作，再用精确 `session_id`、原 `cwd` 和 `existing_idle_confirmed=true` 续接。不能对另一个仍在运行的外部窗口直接注入指令。

## 权限与验收

普通本地操作由本地规则放行；`delegate_permissions` 返回待决敏感操作。Codex 审核命令和目标后决定允许或拒绝。凭据读取等 `user` 类只可由用户在 Claude 原生窗口批准；Codex 不代放行。桥接器失联时保持原生人工提示。

实现完成后，先检查工作树差异，再用 `delegate_review` 建独立只读 Claude 审查会话。读取短报告和相关定向检查，必要时自己复核关键代码。问题最多退回实现 Claude 两轮，之后 Codex 接手。最终合并前检查工作树范围和冲突；推送远端与部署依用户授权处理。

现有 `delegate_*` 仍处于实现验证阶段，遇到没有完成的能力应明确报告，不把任务已启动当作交付已验收。
