# Codex 指挥 Claude Code

这个 fork 让 Codex 通过本地 MCP 桥接器管理 Claude Code 原生窗口：创建独立工作树、持续接收进度、追加指令、处理敏感权限、安排只读审查，并在验收后合并。Codex 仍可亲自修改代码。

项目源自 [claude-plugin-codex](https://github.com/xavierchoi/claude-plugin-codex)。需求与边界见[协作需求](./docs/协作需求.md)、[实施方案](./docs/实施方案.md)、[最小验证记录](./docs/最小验证记录.md)。

## 环境与安装

- Node.js 20+、Claude Code CLI、Git。
- Windows 可见窗口需要 Windows Terminal 和 PowerShell 7；终端代理使用 `node-pty`。
- 继续使用用户当前的 Claude Code 登录及 CCswitch 配置。插件不会切换 CCswitch；指定模型时只能选择当前配置中的模型槽或实际标识，例如 `glm-5.3`。

开发此仓库时可在根目录执行 `npm install`。将仓库作为本地 Codex 插件市场添加并安装：

```powershell
codex plugin marketplace add D:\projects\claude-plugin-codex
codex plugin add claude-code@claude-plugin-codex
```

若克隆到其他位置，请替换第一条命令中的路径。首次创建托管会话时，插件会在 Codex 的已安装插件缓存内安装 `node-pty` 终端依赖，因此需要本机 `npm` 可用。Codex 插件配置位于 `plugins/claude-code/.mcp.json`，指向 `scripts/claude-mcp-server.mjs`。修改插件后需重新安装或刷新插件并重新加载 MCP 服务；正在运行的托管 Claude 会话由独立后台进程持有。

## 工作流程

1. Codex 用 `delegate_create` 传入绝对 `cwd` 和任务 `prompt`。新实现任务会创建独立 Git 工作树和可见 Claude Code 窗口。模型默认继承用户配置。
2. 用 `delegate_wait` 按游标等待关键事件，用 `delegate_status` 查看状态，用 `delegate_transcript` 按需读取交付正文。`delegate_send` 返回指令 ID；`instruction_submitted` 才证明 Claude 收到，`instruction_completed` 证明该轮结束。
3. 用户可以直接在 Claude 窗口输入；`/交还` 交回 Codex。Codex 用 `delegate_takeover` 接管；默认等当前轮和人工指令，`immediate=true` 才中断。`Ctrl+D` 只关闭可见窗口，后台会话继续；`delegate_open` 可重新打开。
4. `delegate_permissions` 列出待决敏感操作，Codex 审核后允许或拒绝。凭据读取等 `user` 类只能由用户在 Claude 窗口批准。桥接器失联时不自动放行。
5. 实现结束后，Codex 用 `delegate_diff` 核对范围，用 `delegate_review` 保存实现快照并创建独立审查工作树。审查会话可在隔离副本运行定向检查；Codex 读取短报告并最终验收。通过后用 `delegate_merge` 合并到创建任务时的目标分支；若实现分支在审查后变化，须重新审查。遇到冲突由 Codex 处理，意图不明时请用户决定。

每个 Codex 主控任务默认并发 3 个顶层 Claude 会话，可用 `delegate_limit` 调至最多 10 个；超额任务排队并在名额空出后启动。Claude 子代理不占顶层名额，单会话子代理并发默认 8、最多 20。任务默认 90 分钟、主会话 120 轮，可逐项调整。

## 既有会话

可用精确 Claude 会话 UUID 和原 `cwd` 续接。原会话进程必须先退出，再传 `session_id` 与 `existing_idle_confirmed=true`；桥接器不会向另一个正在运行的外部窗口注入指令。续接保留原目录和 Claude 会话记录。

## 当前限制

- 终端代理已在 Windows 的 Claude Code 2.1.259、当前 CCswitch 自定义模型环境中完成短任务验证；其他平台的可见终端仍需适配。
- Codex 默认接管通过当前轮结束后的静默期估计人工输入队列是否清空；复杂排队情形仍需验证。最明确的交接方式是窗口里的 `/交还`。
- `delegate_wait` 能在 Codex 正在等待时返回关键事件；Codex 任务结束后自动唤醒需要宿主提供后续调度能力，目前桥接器只会持久保存事件。
- 上游旧 `consult` 等短咨询实现仍留作历史参考，MCP 已不再提供这些接口；对应 Unix 测试不计入当前托管功能验收。

当前实现与逐项验证状态见[实现状态](./docs/实现状态.md)。
