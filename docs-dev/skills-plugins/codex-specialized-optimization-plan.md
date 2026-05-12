# Alembic Codex 专项优化计划书

日期：2026-05-12

本文基于当前 Alembic 仓库真实代码扫描修正。目标不是把 Codex 插件做成独立空壳，也不是削减现有能力，而是把 Codex 作为稳定渠道入口，把插件、npm runtime、MCP shim、daemon job、冷启动/增量扫描、Guard/prime/search 等能力串成可维护、可验证、可扩展的 Codex 链路。

本次修正重点：

- `lib/codex` 已经建立，原计划中的 `CodexRuntimeContext`、插件注册表读取、runtime/plugin diagnostics 已部分落地，不再作为待办重复规划。
- `lib/codex/KnowledgeState.ts` 与 `lib/codex/ToolPolicy.ts` 已经建立，工具可见性与 workspace knowledge gate 不再由 `CodexMcpServer.ts` 内部硬编码。
- CLI status 与 MCP status 仍有重复实现，diagnostics 已开始复用 `lib/codex`。
- daemon job 已有 `source=codex`，但还没有完整 channel/session/tool 上下文。
- 当前 Codex channel 只服务 `alembic-codex` 这一个插件和 `alembic-ai` runtime；暂不规划多插件或多个非插件包扩展。
- 后续所有优化必须保持现有 MCP tools、daemon、cold-start、rescan、Guard、Recipes、Dashboard 能力完整可用。

## 代码扫描范围

本次重点扫描了这些代码与文档：

- 渠道入口：`channels/codex/channel.json`、`channels/codex/README.md`
- 插件包：`plugins/alembic-codex/.codex-plugin/plugin.json`、`plugins/alembic-codex/.mcp.json`、`plugins/alembic-codex/skills/*`
- Codex runtime 集中模块：`lib/codex/RuntimeContext.ts`、`lib/codex/PluginRegistry.ts`、`lib/codex/Diagnostics.ts`、`lib/codex/KnowledgeState.ts`、`lib/codex/ToolPolicy.ts`、`lib/codex/StatusService.ts`、`lib/codex/JobContext.ts`、`lib/codex/README.md`
- npm/发布入口：`package.json`、`scripts/verify-codex-channel.mjs`、`scripts/verify-codex-plugin.mjs`、`scripts/smoke-codex-plugin.mjs`、`scripts/release-codex-channel.mjs`、`scripts/release-codex-plugin.mjs`
- Codex runtime 入口：`bin/codex-mcp.ts`、`bin/cli.ts`
- Codex MCP 逻辑：`lib/external/mcp/CodexMcpServer.ts`、`lib/external/mcp/tools.ts`
- daemon/job：`lib/daemon/DaemonSupervisor.ts`、`lib/daemon/DaemonState.ts`、`lib/daemon/JobStore.ts`、`bin/daemon-server.ts`
- 初始化/Ghost：`lib/cli/SetupService.ts`、`lib/shared/WorkspaceResolver.ts`、`lib/shared/ProjectRegistry.ts`、`lib/shared/WorkspaceSettingsStore.ts`
- Codex 单测：`test/unit/CodexRuntimeContext.test.ts`、`test/unit/CodexMcpServer.test.ts`
- 既有设计文档：`docs-dev/skills-plugins/codex-plugin-transition-design.md`、`docs-dev/skills-plugins/codex-plugin-local-install-status.md`、`docs-dev/skills-plugins/codex-plugin-factory-design.md`

## 当前真实链路

### 1. 渠道与分发入口

`channels/codex/channel.json` 已经把 Codex 抽成渠道入口，当前登记：

- `id`：`codex`
- marketplace：`gxfn`，manifest 路径为 `.agents/plugins/marketplace.json`
- `plugins[]`：`alembic-codex`
- `packages[]`：`alembic-ai`
- `runtime.env.ALEMBIC_CHANNEL_ID`：`codex`

这说明 Codex 不只是一个插件目录，而是 Alembic 的一个渠道。当前阶段只维护 `alembic-codex` 这个插件和 `alembic-ai` runtime，不做多插件或多个非插件包扩展。

### 2. `lib/codex` 已经成为插件入口事实层

当前已新增 `lib/codex`：

- `RuntimeContext.ts`
  - 统一 Codex 常量：`alembic-codex`、`alembic-ai`、`alembic-codex-mcp`、`codex-plugin`
  - 统一 env 名称：`ALEMBIC_MCP_MODE`、`ALEMBIC_CODEX_MCP_MODE`、`ALEMBIC_MCP_TIER`、`ALEMBIC_CODEX_ENABLE_ADMIN`
  - 统一默认 tier：`agent`
  - 统一 channel 解析：优先 `ALEMBIC_CHANNEL_ID`，兼容 `ALEMBIC_CHANNEL`，默认 `codex`
  - 统一 pinned runtime specifier：`alembic-ai@<packageVersion>`
- `PluginRegistry.ts`
  - 读取 channel manifest、marketplace manifest、plugin manifest、MCP 配置、README
  - 收集插件资产和必需 skills
- `Diagnostics.ts`
  - 构建 Codex runtime diagnostics
  - 构建 plugin diagnostics
  - 检查 Node/npm/npx、runtime pin、plugin manifest、assets、skills、admin gate、daemon status
- `KnowledgeState.ts`
  - 读取当前工作区或 Ghost data root 的初始化状态
  - 统计 Recipes 与 Project Skills
  - 输出 `not_initialized`、`initialized_empty`、`knowledge_ready`
- `ToolPolicy.ts`
  - 维护当前唯一 `alembic-codex` 插件的 local tool 定义
  - 维护初始化、冷启动、知识可用、admin opt-in 的工具可见性策略
  - 不做多插件抽象

`bin/codex-mcp.ts` 已经通过 `ensureCodexRuntimeEnvironment()` 设置 Codex MCP 默认环境。`CodexMcpServer` 与 CLI diagnostics/status 已经开始使用 `resolveCodexRuntimeContext()`。

### 3. 插件启动入口

`plugins/alembic-codex/.mcp.json` 当前通过 pinned npm runtime 启动：

```json
["-y", "--prefix", "/tmp", "--package", "alembic-ai@0.1.0", "alembic-codex-mcp"]
```

并注入：

```text
ALEMBIC_CHANNEL_ID=codex
ALEMBIC_CODEX_ENABLE_ADMIN=0
ALEMBIC_CODEX_MCP_MODE=1
ALEMBIC_MCP_MODE=1
ALEMBIC_MCP_TIER=agent
```

`bin/codex-mcp.ts` 会兜底设置：

```text
ALEMBIC_MCP_MODE=1
ALEMBIC_CODEX_MCP_MODE=1
ALEMBIC_CHANNEL_ID=codex
ALEMBIC_MCP_TIER=agent
```

后续功能判断必须继续以稳定 channel id 为准，不从插件名、bin 名、marketplace 名或安装路径推断。

### 4. Codex MCP 工具可见性已下沉到 `lib/codex`

`lib/codex/ToolPolicy.ts` 当前有三层工具开放逻辑：

- 未初始化：`alembic_codex_status`、`alembic_codex_diagnostics`、`alembic_codex_init`
- 已初始化但还没有知识：增加 `alembic_codex_bootstrap`、`alembic_codex_job`
- 已有知识：开放所有 Codex local tools，以及 `lib/external/mcp/tools.ts` 里的 agent/admin core tools，并按 `ALEMBIC_MCP_TIER` 过滤

判断依据是 `lib/codex/KnowledgeState.ts` 的 `inspectCodexKnowledge()`：

```text
configPath exists
databasePath exists
knowledgeDir exists
recipesDir exists
recipeCount > 0 || skillCount > 0
```

这条 gate 能跑通首次使用，并且已经脱离 `CodexMcpServer.ts`。后续还需要继续增强粒度：表达 “bootstrap job 正在跑”“知识存在但过期”“vector 未配置但不阻塞”“只有 wiki 没有 recipes”“某些能力只要求初始化，不要求 recipe 已存在”等细分状态。

### 5. 状态与诊断

诊断已开始集中：

- `lib/codex/Diagnostics.ts` 负责 runtime/plugin diagnostics
- `CodexMcpServer.buildDiagnostics()` 复用 `buildCodexRuntimeDiagnostics()`
- CLI `alembic codex diagnostics` 通过 MCP server 复用同一 diagnostics

状态仍重复：

- MCP `buildStatus()` 返回 channel、workspace facts、knowledge state、daemon summary、diagnostics、onboarding、nextActions
- CLI `buildCodexStatus()` 单独构建 profile、channel、workspace、daemon、mcp 等字段

因此 C2 仍然存在：status 还需要抽成共享服务，避免 CLI 与 MCP 漂移。

### 6. 初始化与 Ghost

`lib/cli/SetupService.ts` 已支持：

- `SetupProfile = 'full-ide' | 'codex-plugin' | 'headless'`
- `codex-plugin` 默认 Ghost
- Codex 初始化跳过 `stepIDE()`，不写 `.cursor/` 或 `.vscode/mcp.json`
- Ghost 数据写入 `~/.asd/workspaces/<projectId>/`

这是 Codex 插件体验的重要基础：插件初始化不污染项目目录。

### 7. daemon 与 job

`DaemonSupervisor` 当前能力：

- `status()` 读取 state/pid，并通过 health 校验 identity
- `start()` 动态端口，写 `daemon.json`、`daemon.pid`、`daemon.log`
- `ensure()` ready 时复用，否则启动
- `stop()` 终止进程并清理 state

`JobStore` 当前能力：

- projectRoot/dataRoot/projectId 绑定
- `create/get/list/markRunning/complete/fail/cancel`
- job 文件存储在 daemon paths 下
- `DaemonJobSource = 'codex' | 'dashboard' | 'http' | 'system'`

`CodexMcpServer` 的 `alembic_codex_bootstrap` / `alembic_codex_rescan` 会 ensure daemon 后调用 daemon HTTP job API，`alembic_codex_job` 优先查 daemon，失败再查本地 `JobStore`。

这条链路是正确方向，但 Codex 的 channel/session/actor/tool 元数据还没有完整贯穿 job record。

### 8. 发布与验证

当前验证入口：

- `npm run verify:codex-channel`
- `npm run verify:codex-plugin`
- `npm run smoke:codex-plugin`
- `npm run release:codex-channel`
- `npm run release:codex-channel:daemon`
- `npm run release:codex-plugin`
- `npm run release:codex-plugin:daemon`

`smoke:codex-plugin` 已覆盖：

- npm pack 内容
- marketplace local install simulation
- MCP stdio 启动
- diagnostics/status/init/job
- daemon smoke 可选
- channel id 输出校验

Codex 专项已有基础单测：`CodexRuntimeContext.test.ts`、`CodexToolPolicy.test.ts`、`CodexStatusService.test.ts`、`CodexMcpServer.test.ts`。后续还可以继续补 channel registry 与 daemon smoke 层面的断言。

## 已落地内容

| 编号 | 内容 | 代码位置 | 状态 |
| --- | --- | --- | --- |
| D1 | Codex runtime context | `lib/codex/RuntimeContext.ts` | 已落地 |
| D2 | Codex plugin registry 读取 | `lib/codex/PluginRegistry.ts` | 已落地 |
| D3 | Codex runtime/plugin diagnostics 集中 | `lib/codex/Diagnostics.ts` | 已落地 |
| D4 | MCP shim 默认环境集中 | `bin/codex-mcp.ts` -> `ensureCodexRuntimeEnvironment()` | 已落地 |
| D5 | MCP diagnostics 使用共享 diagnostics | `CodexMcpServer.buildDiagnostics()` | 已落地 |
| D6 | CLI Codex status 使用共享 runtime context | `bin/cli.ts buildCodexStatus()` | 部分落地 |
| D7 | Codex runtime context 单测 | `test/unit/CodexRuntimeContext.test.ts` | 已落地 |
| D8 | channel/plugin 静态校验脚本 | `scripts/verify-codex-channel.mjs`、`scripts/verify-codex-plugin.mjs` | 已落地 |
| D9 | Codex knowledge state 下沉 | `lib/codex/KnowledgeState.ts` | 已落地 |
| D10 | Codex tool policy 下沉 | `lib/codex/ToolPolicy.ts`、`test/unit/CodexToolPolicy.test.ts` | 已落地 |
| D11 | 插件 MCP 配置显式声明 Codex shim mode | `plugins/alembic-codex/.mcp.json`、`lib/codex/Diagnostics.ts` | 已落地 |
| D12 | Codex status service 统一 | `lib/codex/StatusService.ts`、`test/unit/CodexStatusService.test.ts` | 已落地 |
| D13 | Codex job context 贯穿 | `lib/codex/JobContext.ts`、`lib/daemon/JobStore.ts`、`lib/http/routes/jobs.ts` | 已落地 |
| D14 | Codex knowledge/tool policy 状态增强 | `lib/codex/KnowledgeState.ts`、`lib/codex/ToolPolicy.ts`、`test/unit/CodexKnowledgeState.test.ts`、`test/unit/CodexToolPolicy.test.ts` | 已落地 |
| D15 | Codex 本地插件 cache 同步脚本 | `scripts/sync-codex-plugin-cache.mjs`、`test/unit/CodexPluginCacheSync.test.ts`、`package.json` | 已落地 |
| D16 | 当前单插件/单 runtime 约束校验 | `channels/codex/README.md`、`channels/codex/channel.json`、`scripts/verify-codex-channel.mjs`、`scripts/verify-codex-plugin.mjs` | 已落地 |
| D17 | SourceRef/snapshot 核心事实接入 Codex 状态 | `lib/codex/KnowledgeState.ts`、`test/unit/CodexKnowledgeState.test.ts` | 已落地 |

## 主要缺口

| 编号 | 缺口 | 代码证据 | 风险 | 下一步 |
| --- | --- | --- | --- | --- |
| C1 | channel/plugin 配置校验已围绕当前单插件加固 | `verify-codex-channel.mjs` 要求 exactly one plugin/package，`verify-codex-plugin.mjs` 要求 gxfn marketplace exactly one plugin | 后续扩展插件/包必须先更新计划和校验 | 已收口 |
| C2 | MCP status 和 CLI status 已统一，后续只需继续增强状态粒度 | `lib/codex/StatusService.ts` | 状态新增时要避免绕回 CLI/MCP 两份实现 | P1 |
| C3 | 工具开放 gate 已下沉并具备 job/freshness/vector/SourceRef/snapshot 信号 | `KnowledgeState.ts` 汇总 config/db/recipes/skills/job/vector/freshness/SourceRef/snapshot，`ToolPolicy.ts` 输出策略状态 | 后续可继续接 FileDiff 当前 diff 与 active rescan plan 细节 | 后续 |
| C4 | `CodexMcpServer.ts` 仍承载 daemon tool bridge | `callDaemonTool()` | MCP adapter 仍偏重，后续维护容易耦合 | 后续 |
| C5 | plugin diagnostics 面向当前单插件，这是本阶段正确约束 | `CODEX_PLUGIN_NAME`、`CODEX_REQUIRED_SKILLS` 是单插件常量 | 不能被误改成过早多插件抽象 | P0 |
| C6 | daemon job 已持久化 Codex 上下文，后续需让 Dashboard 更好展示 | `DaemonJobRecord.channelId/sessionId/createdByTool/client` | UI 和审计还可以更直观 | P3 |
| C7 | release 入口保持 plugin 级别是当前阶段正确约束 | `prepublishOnly = release:codex-plugin` | 过早切 channel release 会引入无关复杂度 | P0 |
| C8 | 本机 Codex 插件缓存刷新已有开发态脚本 | `dev:codex-plugin:sync`、`dev:codex-plugin:local-mcp` | 后续需要根据真实 Codex cache 结构持续校验 | 后续 |
| C9 | Codex 单测还不够细 | 只有 runtime context 和 MCP server 大测试 | 策略变更定位慢 | P5 |
| C10 | 文档分布在 channel/plugin/root，多处可能漂移 | README、plugin README、channel README、release playbook | 改版本/安装路径容易漏 | P6 |

## 优化原则

1. 不削减现有 MCP tools、daemon、cold-start、rescan、Guard、Recipes、Dashboard 能力。
2. Codex 专项优化只做入口、上下文、策略、状态、验证和本地开发体验的加固。
3. 所有功能判断使用稳定渠道标识 `codex`，不从路径或插件名推断。
4. channel 是上层入口，但当前只服务 `alembic-codex` 这个插件；不要为了未来多插件扩展引入额外抽象。
5. Codex 默认 agent tier，admin 能力继续显式 opt-in。
6. Ghost mode 仍是 Codex 默认初始化模式。
7. 长任务仍由 daemon/job 承载，MCP stdio 只负责入口和桥接。
8. 任何拆分都必须保持行为等价，再逐步增加状态表达和测试。

## 总体设计

目标链路：

```text
Codex channel
  ├─ channels/codex/channel.json
  ├─ plugins/alembic-codex
  ├─ npm package alembic-ai
  └─ runtime context: ALEMBIC_CHANNEL_ID=codex

Codex plugin runtime
  ├─ bin/codex-mcp.ts
  ├─ lib/codex/RuntimeContext.ts
  ├─ lib/codex/PluginRegistry.ts
  ├─ lib/codex/Diagnostics.ts
  ├─ lib/codex/KnowledgeState.ts
  ├─ lib/codex/ToolPolicy.ts
  ├─ lib/codex/StatusService.ts
  └─ lib/codex/JobContext.ts

Alembic core
  ├─ MCP tools: search / guard / task / bootstrap / rescan / wiki / panorama
  ├─ daemon jobs: bootstrap / rescan
  ├─ Ghost workspace and knowledge store
  └─ Dashboard / API / Realtime
```

`lib/codex` 是 Codex 插件入口层，不承载 Alembic core 能力本身。AgentRuntime、tools、daemon、Guard、Recipes、bootstrap/rescan 仍在各自模块。Codex 模块只负责把这些成熟能力以 Codex 插件需要的方式组织、暴露、诊断和验证。

建议继续在 `lib/codex` 下增加小模块：

```text
lib/codex/
  RuntimeContext.ts        // 已有
  PluginRegistry.ts        // 已有
  Diagnostics.ts           // 已有
  KnowledgeState.ts        // 已有
  ToolPolicy.ts            // 已有
  StatusService.ts         // 已有
  JobContext.ts            // 已有
```

不建议再新建 `lib/external/codex`。`lib/external/mcp` 只保留 MCP protocol server 与 bridge，Codex 专项事实和策略归 `lib/codex`。

## 分阶段实施计划

### P0：稳定渠道契约集中化

状态：已部分完成，作为维护基线。

已完成：

- 新增 `lib/codex/RuntimeContext.ts`
- 新增 `lib/codex/PluginRegistry.ts`
- 新增 `lib/codex/Diagnostics.ts`
- `bin/codex-mcp.ts` 使用 `ensureCodexRuntimeEnvironment()`
- `CodexMcpServer` 与 CLI 使用 `resolveCodexRuntimeContext()`
- 新增 `test/unit/CodexRuntimeContext.test.ts`

剩余补齐：

- `verify:codex-channel` 继续围绕当前唯一插件校验：`runtime.env`、plugin path、runtime bin、runtime package、marketplace entry。
- `PluginRegistry` 保持单插件入口，不做多插件 registry 泛化。

验收：

- `alembic_codex_diagnostics.data.codex.channelId === 'codex'`
- `alembic_codex_status.data.channel.id === 'codex'`
- `npm run verify:codex-channel`
- `npm run verify:codex-plugin`
- `npm run smoke:codex-plugin`

### P1：统一 Codex status

状态：已完成基础统一。目标：保持 CLI 与 MCP status 继续使用同一服务，后续只增强 `StatusService`。

已完成：

- 新增 `lib/codex/StatusService.ts`。
- `CodexMcpServer.buildStatus()` 和 CLI `buildCodexStatus()` 共同调用 `buildCodexStatus()`。
- `buildCodexStatusOnboarding()`、`buildCodexActionLabels()`、`buildCodexRecommendedAction()` 已从 `CodexMcpServer.ts` 移出。
- `summarizeCodexDaemonStatus()` 统一 daemon status 输出，并避免 daemon token 进入 status JSON。

后续增强：

- status 输出继续补明确 state：
  - `not_initialized`
  - `initialized_empty`
  - `bootstrap_running`
  - `knowledge_ready`
  - `knowledge_stale`
  - `daemon_ready`
  - `daemon_stale`
- 保留当前返回字段，新增字段只能向后兼容。

验收：

- CLI JSON 与 MCP status 的核心字段一致。
- `alembic codex status --json` 与 `alembic_codex_status` 的 channel/profile/knowledge/daemon/onboarding 不漂移。
- `npx vitest run test/unit/CodexRuntimeContext.test.ts test/unit/CodexMcpServer.test.ts` 通过。

### P2：继续增强 Codex 工具策略粒度

状态：已完成第一批状态增强。目标是继续保持工具可见性可解释、可测试，并且不把 optional 能力当成硬阻塞。

已完成：

- 保持 `lib/codex/KnowledgeState.ts` 和 `lib/codex/ToolPolicy.ts` 为 Codex 工具策略唯一入口。
- `KnowledgeState.ts` 只读汇总：
  - bootstrap running
  - latest bootstrap/rescan job 与 active job request 摘要
  - knowledge freshness
  - optional vector index readiness / skipped non-blocking
  - `recipe_source_refs` stale/renamed/active 计数
  - latest `bootstrap_snapshots` 增量上下文
- `ToolPolicy.ts` 输出：
  - `needs_init`
  - `needs_bootstrap`
  - `bootstrap_running`
  - `ready`
  - `ready_refreshing`
  - `ready_stale`
  - `daemon_stale`
- `StatusService.ts` 将 policy state/signals 暴露到 CLI/MCP status。
- 行为保持兼容：未初始化、初始化空知识、有知识三类工具可见性不删除；vector 缺失只产生 `CODEX_VECTOR_SKIPPED_NON_BLOCKING` 信号。
- SourceRef stale 会把 usable knowledge 标为 `knowledge_stale`，但不隐藏已有工具；policy 输出 `CODEX_SOURCE_REFS_STALE`。

后续增强：

- 接 FileDiff 当前 diff、active rescan plan 细节等更重事实。
- Dashboard 展示 policy state/signals。

验收：

- 未初始化项目只显示 diagnostics/status/init。
- 初始化但无知识项目显示 bootstrap/job。
- bootstrap running 不重复开放核心工具，但提示 recover job。
- 有知识项目显示 agent tier core tools。
- knowledge stale / daemon stale / vector skipped 不删除已有工具，只输出信号。
- admin tools 仍需 `ALEMBIC_CODEX_ENABLE_ADMIN=1`。
- `test/unit/CodexKnowledgeState.test.ts` 与 `test/unit/CodexToolPolicy.test.ts` 覆盖上述状态。

### P3：Codex job 上下文贯穿

状态：基础贯穿已完成。目标：让 long-running job 明确知道来自 Codex 哪个渠道、哪个 session、哪个工具。

已完成：

- 扩展 `DaemonJobRecord`：
  - `channelId`
  - `actor`
  - `sessionId`
  - `createdByTool`
  - `client`
- 扩展 `CreateDaemonJobInput`、daemon HTTP job API 和 `DaemonJobRunner`。
- `alembic_codex_bootstrap` / `alembic_codex_rescan` enqueue 时传入这些字段。
- `alembic_codex_job` 返回这些字段。

后续增强：

- Dashboard 展示来源字段，但不要求本阶段做前端复杂交互。
- smoke daemon 链路增加 job context 断言。

验收：

- bootstrap/rescan job JSON 中可看到 `source=codex` 与 `channelId=codex`。
- Codex reconnect 后能基于 job id 恢复。
- smoke 覆盖 job context。

### P4：Codex 本地开发刷新链路

状态：已完成基础脚本。目标：减少手工改 Codex cache / `.mcp.json` / 重启后不一致的风险。

已完成：

- 新增 `scripts/sync-codex-plugin-cache.mjs`：
  - 读取 `channels/codex/channel.json`
  - 同步 `plugins/alembic-codex` 到本机 Codex cache
  - 可选把缓存 `.mcp.json` 指向本地 `dist/bin/codex-mcp.js`
  - 保留 release `.mcp.json` 的 pinned npm 配置
- 新增 npm scripts：
  - `dev:codex-plugin:sync`
  - `dev:codex-plugin:local-mcp`
- 文档明确 local cache 是开发态，不进入发布包。
- 默认不清空 cache；只有显式 `--clean` 才删除当前插件版本缓存。
- `--local-mcp-entry` 只用于开发态覆盖缓存内 MCP 入口，便于测试和本地调试；仓库内发布 `.mcp.json` 不被修改。

验收：

- 一条命令刷新本机 Codex 插件缓存。
- 发布校验仍要求 repo 内 `.mcp.json` 使用 pinned npm runtime。
- 本地刷新脚本不修改发布 manifest。
- `test/unit/CodexPluginCacheSync.test.ts` 使用临时 `--codex-home` 覆盖 dry-run、copy 和 local MCP rewrite。

### P5：Codex 单元测试与集成测试补齐

目标：把 smoke 里的关键判断下沉到更快的测试层。

任务：

- 保留并扩展 `test/unit/CodexRuntimeContext.test.ts`。
- 新增 `test/unit/CodexPluginRegistry.test.ts`。
- 新增 `test/unit/CodexDiagnostics.test.ts`。
- 新增 `test/unit/CodexStatusService.test.ts`。
- 新增 `test/unit/CodexToolPolicy.test.ts`。
- 保留 `smoke:codex-plugin` 做打包/stdio/daemon 端到端验证。

验收：

- `npm run test:unit` 覆盖 Codex 策略、channel context、status state、plugin registry。
- `npm run smoke:codex-plugin` 继续覆盖 npm tarball 与 MCP stdio。

### P6：Codex UX 与默认 prompts 优化

目标：Codex 首屏和首次动作更像产品，而不是工具清单。

任务：

- 插件 default prompts 与 `alembic_codex_status` onboarding 对齐。
- skills 里补充 channel 概念：遇到 Codex channel 时先 diagnostics/status，再 init/bootstrap/prime。
- `alembic_codex_status` 的 `nextActions` 返回可直接执行的 tool + arguments。
- 对未配置 AI provider、vector index skipped、daemon starting 等状态给出清晰提示，不把它们误判成失败。

验收：

- 新用户从 default prompt 到 bootstrap 成功路径不需要读 README。
- 错误状态都能给出下一步，而不是只给 raw error。

## 下一批建议落地顺序

1. **继续接入更重核心事实**
   - SourceRef stale、latest snapshot 与 active job request 摘要已接入。下一步可以接 FileDiff 当前 diff，但必须保持 status 只读、轻启动、不创建目录。

2. **补真实 cache sync smoke**
   - 单测已覆盖临时 `--codex-home` 的 dry-run、copy、local `.mcp.json` rewrite；后续可再补 Codex app 实机 cache 刷新 smoke。

## 验证矩阵

| 场景 | 命令/入口 | 必须通过 |
| --- | --- | --- |
| TypeScript 编译 | `npm run build` | 通过 |
| Codex channel 静态校验 | `npm run verify:codex-channel` | 通过 |
| Codex plugin 静态校验 | `npm run verify:codex-plugin` | 通过 |
| Codex runtime 单测 | `npx vitest run test/unit/CodexRuntimeContext.test.ts test/unit/CodexMcpServer.test.ts` | 通过 |
| npm tarball + install | `npm run smoke:codex-plugin -- --no-stdio` | 通过 |
| MCP stdio | `npm run smoke:codex-plugin` | 通过 |
| daemon/job | `npm run release:codex-channel:daemon` | 需要 localhost 权限 |
| CLI diagnostics | `alembic codex diagnostics --json` | 返回 channelId |
| CLI status | `alembic codex status --json` | 返回 channel.id |
| Codex app 手动验证 | 插件刷新后新开对话 | tools 可见性随 workspace 状态变化 |

## 不变约束

- 不删除 mature core tools。
- 不把 Codex 插件变成只展示 metadata 的薄壳。
- 不把冷启动、增量扫描、AgentRuntime、Guard、Recipes、Dashboard 从 Codex 链路里移除。
- 不把“插件形态”解释成“砍掉 daemon 或后台 job”。
- 不把已验证成熟能力替换成占位接口。
- 任何涉及删除、降级、改成占位实现、延期完整能力的动作，都必须另行确认。

## 结论

Codex 专项优化的核心不是继续写更多 README，而是把已经存在的成熟能力通过稳定 channel runtime context 组织起来：

```text
channel id -> runtime context -> status/diagnostics -> tool policy -> daemon job -> core tools
```

当前代码已经具备可运行的插件、runtime、daemon、job、Ghost、验证基础，并且 `lib/codex` 已经承接 runtime context、plugin registry、diagnostics、knowledge state、tool policy、status service 和 job context。下一步不再重复做入口事实层，也不做多插件/多包扩展，而是继续增强 knowledge/tool policy 的状态粒度，或补本地 Codex 插件 cache 刷新脚本。
