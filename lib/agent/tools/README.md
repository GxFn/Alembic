# Agent Tools

`lib/agent/tools` 是 Alembic 内置 Agent runtime 调用的内部工具层。它不对外暴露 Codex MCP 插件协议，也不兼容旧项目的 V1/V2 tool envelope；外部插件工具继续放在 `lib/codex` 边界内。

## 边界

- `code.*`：项目内代码搜索、读取、结构、outline、写入和 guard 检查。
- `terminal.execute`：有界 shell 命令执行，默认走内部 Seatbelt 沙箱执行器。
- `knowledge.*`：Recipe / candidate 的查询、详情、提交和生命周期管理端口。
- `runtime.*`：向 agent 注入主线上下文、guard finding 和 source-ref repair 报告。
- `graph.*`：工程图谱 overview / query 端口。
- `memory.*`：Agent 工作记忆、发现记录和历史证据查询。
- `meta.*`：工具能力、计划和审查信息。

## 旧项目能力迁移对照

旧项目 `lib/tools/v2` 中已经稳定的 action surface 已迁入新的 `resource.action` 命名空间：

| 旧能力 | 新能力 |
| --- | --- |
| `code.search/read/outline/structure/write` | `code.search/read/outline/structure/write`，并补入 `code.guard` |
| `terminal.exec` | `terminal.execute` |
| `knowledge.search/submit/detail/manage` | `knowledge.search/submit/detail/manage` |
| `graph.overview/query` | `graph.overview/query` |
| `memory.save/recall/note_finding/get_previous_evidence` | 同名迁入 |
| `meta.tools/plan/review` | 同名迁入，并补入 `meta.capabilities` |

旧项目 `lib/sandbox` 的成熟执行链路已完整迁入 `sandbox/`，`sandbox.ts` 只作为内部公共入口：

- `ToolSandboxTerminalExecutor`：内部 agent terminal 的默认 executor。
- `createToolSandboxProfile`：从网络、文件系统、cwd、projectRoot、timeout 和 env 意图生成沙箱 profile。
- `buildToolSeatbeltProfile`：生成 macOS Seatbelt SBPL。
- `buildToolSandboxEnvironment`：仅透传白名单环境变量，注入 `HOME/TMPDIR/SANDBOX`，并剥离 API key、token、SSH、Kubeconfig、DB URL 等敏感变量。
- `executeWithToolSandbox`：优先 `sandbox-exec`，不可用或命中嵌套沙箱冲突时降级为净化环境直跑。
- `startToolSandboxProxy`：allowlisted 网络模式下的本地 CONNECT 代理。
- `parseToolSandboxViolations`：解析 Seatbelt deny 输出并摘要化。

## Terminal 默认策略

`ToolRouter` 默认注入 `new ToolSandboxTerminalExecutor()`，因此 agent 调用 `terminal.execute` 时会经过：

1. schema 校验与 cwd 项目边界检查；
2. shell payload 安全检查，阻断提权、破坏性系统命令、隐藏在分号/管道/子 shell 后的危险 executable、下载脚本 pipe 到 shell、`eval` 和 fork-bomb 形态；
3. Seatbelt profile 构建；
4. `sandbox-exec` 执行；
5. 输出合并、ANSI 清理和命令感知压缩；
6. 将 `sandboxed`、`degradeReason`、`sandboxViolations` 作为结果审计字段返回。

默认 terminal 文件系统意图是 `project-write`，网络意图是 `none`。这保留了 agent 在项目内运行测试、构建、生成文件的成熟能力，同时阻断出站网络和敏感宿主目录访问。

`terminal.execute` 也保留旧 terminal policy 的按次执行意图：调用方可以传入 `network`、`filesystem`、`env`。`env` 只允许少量非敏感字符串键，`CI/GIT_PAGER/GIT_TERMINAL_PROMPT/LESS/PAGER` 由策略统一控制，token、secret、password、cookie、private key 等疑似敏感键会被拒绝。

## 降级规则

以下场景不会直接失败，而是带审计字段降级执行：

- `ALEMBIC_SANDBOX_MODE=disabled`：返回 `sandboxed: false`、`degradeReason: "disabled"`。
- 当前系统无 `/usr/bin/sandbox-exec`：返回 `degradeReason: "sandbox-exec-unavailable"`，但仍使用净化环境。
- 当前宿主禁止再次应用 Seatbelt profile：返回 `degradeReason: "sandbox-apply-denied"`，但仍使用净化环境。
- 命令命中 `xcodebuild`、`swift`、`xcrun`、`codesign` 等嵌套沙箱冲突工具：返回 `degradeReason: "nested-sandbox-conflict"`，避免 macOS 嵌套 sandbox 崩溃。

## 输出压缩

默认 terminal compressor 保留旧项目的成熟解析面：`git status`、`git diff`、`git log`、测试输出、lint/tsc 输出、grep/rg 输出、tree/list 输出、包管理器输出。解析失败时退回清理后的原始输出，并按 token budget 截断。

## 不迁入的旧内容

这些旧模块不进入 agent tool 层：

- Dashboard、Mac system、Skill adapter、Capability catalog 等 IDE/宿主适配层；
- `lib/tools/v2/adapter` 的旧 envelope 兼容层；
- persistent PTY/session tool 的旧外壳。当前内部 agent tool 只保留非交互、可审计的 `terminal.execute`，后续如需 interactive terminal，应作为独立受控资源加入，而不是混入现有 action。
