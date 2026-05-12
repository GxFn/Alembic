# Alembic Codex 插件功能限定与分离方案

日期：2026-05-12

本文基于当前 Alembic 仓库代码、Codex 插件包、既有 Codex 专项设计文档、IDE 安装脚本、MCP server、冷启动/增量扫描与完成交付链路的扫描结果，定义 Alembic Codex 插件版本的功能边界。

结论先行：Codex 插件版本不削减 Alembic Core 能力。限定的对象是“Codex 插件默认入口”和“Codex 默认交付面”，不是把成熟能力降级为空壳。Cursor、VS Code、Copilot、VSCode 扩展、远程 Lark 到 IDE 注入、Cursor Delivery 等能力继续保留在 Alembic 的 full-ide/IDE 集成路径中，但不能成为 Codex 插件默认初始化、默认冷启动或默认增量扫描交付的一部分。

## 扫描范围

本次重点扫描：

- Codex 插件包：`plugins/alembic-codex/.codex-plugin/plugin.json`、`.mcp.json`、README、skills。
- Codex 入口事实层：`lib/codex/RuntimeContext.ts`、`Diagnostics.ts`、`KnowledgeState.ts`、`ToolPolicy.ts`、`StatusService.ts`、`JobContext.ts`。
- Codex MCP shim：`bin/codex-mcp.ts`、`lib/external/mcp/CodexMcpServer.ts`。
- 通用 MCP server：`lib/external/mcp/McpServer.ts`、`lib/external/mcp/tools.ts`。
- setup 与 IDE 部署：`lib/cli/SetupService.ts`、`lib/cli/deploy/FileManifest.ts`、`scripts/setup-mcp-config.ts`、`scripts/install-cursor-skill.ts`、`scripts/install-vscode-copilot.ts`。
- VSCode 扩展：`resources/vscode-ext/package.json`、`resources/vscode-ext/src/extension.ts`、`remoteCommandPoller.ts`。
- 冷启动：`lib/workflows/cold-start/*`。
- 增量扫描：`lib/workflows/knowledge-rescan/*`、`FileDiffPlanner.ts`、`ProjectIntelligenceRunner.ts`。
- 完成交付：`CompletionSteps.ts`、`WorkflowCompletionFinalizer.ts`、`CursorDeliveryPipeline.ts`、`DeliveryVerifier.ts`、`RulesGenerator.ts`、`AgentInstructionsGenerator.ts`。
- 既有设计文档：`docs-dev/skills-plugins/codex-specialized-optimization-plan.md`、`codex-plugin-transition-design.md`、`codex-plugin-local-install-status.md`。

## 功能域归类

| 功能域 | 当前实现 | Codex 插件限定 |
| --- | --- | --- |
| 插件安装与元数据 | `plugins/alembic-codex` | 保留为 Codex 默认入口 |
| Codex MCP 轻入口 | `alembic-codex-mcp`、`CodexMcpServer` | 保留，负责状态、诊断、初始化、job、daemon bridge |
| Alembic Core tools | `lib/external/mcp/tools.ts` | 保留，通过 daemon bridge 暴露，不在插件内重写 |
| Ghost 初始化 | `SetupService(profile=codex-plugin)` | Codex 默认保留，跳过 IDE 部署 |
| Cursor/VS Code MCP 配置 | `.cursor/mcp.json`、`.vscode/mcp.json` | 从 Codex 默认路径分离，full-ide 或显式 opt-in |
| Copilot instructions | `.github/copilot-instructions.md` | 从 Codex 默认路径分离，full-ide 或显式 opt-in |
| VSCode 扩展安装 | `resources/vscode-ext`、`installVSCodeExtension` | 不属于 Codex 插件默认能力 |
| Lark 到 IDE 远程注入 | `RemoteCommandPoller` | IDE 扩展能力，不进入 Codex 插件默认路径 |
| Cursor Delivery 六通道 | `.cursor/rules`、`.cursor/skills`、AGENTS/CLAUDE/Copilot | 从 Codex 默认交付分离 |
| 冷启动与增量扫描核心分析 | ProjectIntelligence、Guard、Panorama、Recipes、Skills | 保留为 Alembic Core 能力 |
| 长任务与 Dashboard | daemon、JobStore、HTTP job API | Codex 保留，按需启动 |
| admin 工具 | MCP tier admin | Codex 默认隐藏，必须显式启用 |

## Codex 插件必须保留的能力

Codex 插件版本应保留这些功能，作为默认能力面：

1. 插件安装后可发现 `alembic-codex` 卡片、default prompts、skills、MCP server。
2. `alembic_codex_diagnostics` 不启动 daemon，检查 Node/npm/npx、runtime pin、插件资产、admin gate、离线 fallback 和 next actions。
3. `alembic_codex_status` 不启动 daemon，返回 workspace/Ghost data root、初始化状态、知识状态、daemon 状态、policy state 和下一步。
4. `alembic_codex_init` 默认 Ghost mode，使用 `SetupService(profile=codex-plugin)` 初始化运行时、知识库、DB、vector index，不执行 `stepIDE()`。
5. `alembic_codex_bootstrap` 和 `alembic_codex_rescan` 通过 daemon job 承载长任务，立即返回可恢复 job id。
6. `alembic_codex_job` 可在 Codex 重连、daemon 重启或 Dashboard 刷新后恢复查询 job。
7. `alembic_codex_dashboard` 只在用户需要视觉交接时启动或连接 daemon 并返回 Dashboard URL。
8. 知识可用后，Codex 可以通过 daemon bridge 使用 `alembic_task(prime)`、`alembic_search`、`alembic_knowledge`、`alembic_structure`、`alembic_graph`、`alembic_guard`、`alembic_skill`、`alembic_panorama` 等 core tools。
9. Codex 默认 MCP tier 为 `agent`；admin 能力只有在 `ALEMBIC_MCP_TIER=admin` 且 `ALEMBIC_CODEX_ENABLE_ADMIN=1` 同时成立时可见。
10. 插件卸载不清理项目知识；`alembic_codex_cleanup(confirm=true)` 只清 daemon runtime state、logs、locks、job files，不删除 Recipes、candidates、skills、wiki 或项目数据。

## 必须从 Codex 默认路径分离的能力

以下能力不删除，但不能作为 Codex 插件默认初始化或默认交付的一部分：

| 分离项 | 当前入口 | 分离原因 | Codex 处理方式 |
| --- | --- | --- | --- |
| `.cursor/mcp.json` 写入 | `setup-mcp-config.ts`、`FileManifest` | Cursor 项目级 MCP 配置，不是 Codex 插件配置 | full-ide 或显式 opt-in |
| `.vscode/mcp.json` 写入 | `setup-mcp-config.ts`、`install-vscode-copilot.ts` | VS Code/Copilot MCP 配置，不是 Codex 插件配置 | full-ide 或显式 opt-in |
| `.cursor/rules/*.mdc` | `RulesGenerator`、`CursorDeliveryPipeline` | Cursor 专属规则格式 | 不作为 Codex 默认交付 |
| `.cursor/skills/` 同步 | `SkillsSyncer`、`install-cursor-skill.ts` | Cursor skills 目录，不是 Codex plugin skills | 保留 Project Skills 到 dataRoot |
| `.github/copilot-instructions.md` | `AgentInstructionsGenerator`、`install-vscode-copilot.ts` | GitHub Copilot 项目指令，不是 Codex 插件指令 | full-ide 或显式 opt-in |
| `AGENTS.md` / `CLAUDE.md` 动态注入 | `AgentInstructionsGenerator` | 会修改用户项目根目录 | Codex 默认不写；必要时用户明确要求 |
| VSCode 扩展安装 | `FileDeployer.installVSCodeExtension()` | 编辑器插件安装属于 IDE 平台集成 | 独立安装流程 |
| VSCode Guard 诊断/状态栏/CodeLens | `resources/vscode-ext/src/extension.ts` | 依赖 VSCode API 与 Alembic API server | 不进入 Codex 插件 |
| Lark 远程指令注入 Copilot Chat | `remoteCommandPoller.ts` | 远程 IDE 编程桥接，且会改 auto-approve | 继续留在 VSCode 扩展 |
| Cursor autoApprove 注入 | `autoApproveInjector.ts` | 面向 Cursor MCP 配置，Codex 权限模型不同 | Codex 不复用 |
| `.qoder/.trae` mirror | Delivery 注释中保留 | 其他 IDE 镜像 | 显式命令触发 |

## 冷启动流程限定

### 当前能力

冷启动有两条成熟路径：

- 外部 Agent 路径：`alembic_bootstrap` 返回 Mission Briefing，外部 Agent 按维度分析、`submit_knowledge`、`dimension_complete`，最后触发完成器。
- 内部 Agent 路径：`bootstrapKnowledge` 先跑 ProjectIntelligence Phase 1-4，再 dispatch 内部维度填充，生成 Candidates、Recipes、Project Skills、checkpoint、report 等。

Codex 插件默认应走内部 daemon job 路径：

```text
alembic_codex_bootstrap
  -> ensure daemon
  -> /api/v1/jobs/bootstrap
  -> DaemonJobRunner
  -> bootstrapKnowledge
  -> ProjectIntelligence Phase 1-4
  -> internal dimension fill
  -> JobStore completed/running/fail recovery
```

### Codex 冷启动交付内容

Codex 默认冷启动应交付到 Ghost data root 或 Alembic dataRoot：

- Recipes 与 candidates。
- Project Skills。
- bootstrap checkpoint。
- bootstrap report 与历史 report。
- source refs 与 file diff snapshot。
- ProjectIntelligence 产物：AST 摘要、依赖图、module entities、code entity graph、call graph、Panorama、Guard summary。
- semantic memory 与可选 vector index。
- job record、session id、quality/gap/coverage 信息。
- Dashboard URL 作为显式视觉交接。

Codex 默认冷启动不应写入：

- `.cursor/rules/*`
- `.cursor/skills/*`
- `.vscode/mcp.json`
- `.cursor/mcp.json`
- `.github/copilot-instructions.md`
- `AGENTS.md`
- `CLAUDE.md`
- VSCode 扩展安装产物
- Cursor/Copilot auto-approve 配置

### 需要拆分的实现点

当前 `WorkflowCompletionFinalizer` 默认会执行 `runCursorDelivery()` 与 `verifyDelivery()`；`DeliveryVerifier` 也默认验证 Channel A/B/C/F 这些 Cursor/Agent 文件。这对 full-ide 路径合理，但对 Codex 插件默认路径应拆分。

建议引入 delivery profile：

```text
deliveryProfile = "codex" | "full-ide"
```

Codex profile 行为：

- bootstrap 完成后跳过 Cursor Delivery。
- 保留 Panorama refresh、semantic memory consolidation、workflow report。
- Wiki 生成可以保留，但输出必须走 dataRoot，不写 IDE 指令文件。
- 使用 Codex 专用 verifier，只验证 dataRoot 内的 Recipes、Project Skills、wiki、snapshot、job、report、semantic memory、Guard/Panorama，而不要求 `.cursor` 或 Agent instruction files。

full-ide profile 行为：

- 继续执行 Cursor Delivery 六通道。
- 继续验证 Channel A/B/C/F。
- 继续支持 Cursor、VS Code、Copilot、AGENTS/CLAUDE 交付。

## 增量扫描流程限定

### 当前能力

增量扫描当前会：

- 保留已有 Recipes。
- 清理派生 cache。
- 用 FileDiff snapshot 计算变更、受影响维度和可跳过维度。
- 同步/修复 source refs。
- 运行 ProjectIntelligence Phase 1-4。
- 做 evolution audit、relevance audit、gap plan。
- 内部路径异步填充 execution dimensions。
- 外部路径返回 Mission Briefing，要求外部 Agent per-dimension evolve、submit、dimension_complete。

### Codex 增量扫描交付内容

Codex 默认 rescan 应交付：

- 更新后的 Recipes/candidates/source refs。
- relevance audit 与 decay/deprecation 建议。
- evolution audit 与 gap plan。
- affected dimensions、skipped dimensions、execution decisions。
- 新 snapshot 与历史 report。
- Guard、Panorama、call graph、dependency graph 更新。
- job 状态和 Dashboard 进度。

Codex 默认 rescan 不应触发 Cursor Delivery 六通道，也不应写 `.cursor`、`.vscode`、Copilot/AGENTS/CLAUDE。当前内部 rescan 已在 `InternalDimensionFillFinalizer` 中明确跳过 delivery/wiki/memory，这是正确方向；Codex bootstrap 也应采用同样的 profile 隔离，而不是依赖偶然没有 pipeline 或 Ghost 路径。

## Prime 交互限定

Codex 日常使用的 prime 交互应围绕 `alembic_task(operation=prime)`：

1. 当 `alembic_codex_status` 返回 knowledge ready，Codex 在非简单编码任务前调用 prime。
2. prime 返回项目决策、未完成任务、相关 Recipes、约束和建议下一步。
3. Codex 必须尊重 prime 返回的 pinned decisions 和 active tasks。
4. 用户确认新规则、取舍、例外或项目事实时，Codex 使用 `alembic_task(record_decision)` 或知识提交工具沉淀。
5. 编码后使用 `alembic_guard` 检查当前 diff 或指定文件。

Codex prime 不应依赖项目根目录的 `AGENTS.md` 动态注入，也不应要求 `.cursor/rules` 已存在。AGENTS/Cursor/Copilot 指令是 full-ide delivery 的消费物，Codex 插件版的权威入口是 MCP prime/search/guard 和插件 skills。

## MCP 入口分工

Codex 插件使用 `alembic-codex-mcp`：

- 不要求项目里存在 `.vscode/mcp.json` 或 `.cursor/mcp.json`。
- 不要求 `ALEMBIC_PROJECT_DIR`；可从 `CODEX_WORKSPACE_DIR`、`INIT_CWD`、`PWD`、cwd 推断。
- 启动时只注册 Codex local tools 和按 knowledge gate 可见的 core tools。
- daemon 按需启动，长期任务交给 JobStore。

传统 IDE 使用 `alembic-mcp`：

- 依赖项目级 MCP 配置。
- 需要 `ALEMBIC_PROJECT_DIR` 明确绑定工作区。
- 可直接暴露外部 Agent Mission Briefing、dimension_complete、wiki 等完整工具流。
- 适合 Cursor/VS Code/Copilot 这类项目配置型 Agent。

这两个入口应共享 tools schema 与 core handler，但启动策略、项目绑定、默认交付和权限提示必须分开。

## Codex 插件发布检查口径

发布验证应确认：

- `.mcp.json` 使用 pinned `alembic-ai@<version>` 和 `npx --prefix /tmp`。
- 默认 env 包含 `ALEMBIC_CHANNEL_ID=codex`、`ALEMBIC_CODEX_MCP_MODE=1`、`ALEMBIC_MCP_MODE=1`、`ALEMBIC_MCP_TIER=agent`、`ALEMBIC_CODEX_ENABLE_ADMIN=0`。
- `verify:codex-plugin`、`smoke:codex-plugin` 覆盖 plugin metadata、assets、skills、stdio MCP、status、diagnostics、init、job。
- daemon smoke 覆盖 bootstrap/rescan job enqueue、recover、interrupted job handling、Dashboard URL。
- Codex init 后不创建 `.cursor`、`.vscode/mcp.json`、Copilot instructions、AGENTS/CLAUDE 动态交付文件。
- Codex bootstrap/rescan 完成后，Codex verifier 不以 Cursor Channel A/B/C/F 为通过条件。

## 后续实现任务

1. 为 completion finalizer 增加 delivery profile，Codex job 默认使用 `deliveryProfile="codex"`。
2. 新增 Codex delivery verifier，验证 dataRoot 内知识、skills、wiki/report/snapshot/job/Guard/Panorama，不检查 `.cursor` 与 Agent instruction files。
3. 在 `DaemonJobRunner` 的 Codex bootstrap job 参数中传入 `skipTargetDelivery` 或新的 delivery profile，避免 bootstrap 完成器默认跑 Cursor Delivery。
4. 更新 `alembic_codex_status` 的 onboarding 文案，明确 Codex 默认不会写 IDE 配置。
5. 更新发布验证，断言 bootstrap/rescan 后项目根目录不出现 Codex 默认不应写入的 IDE 文件。
6. 将 full-ide delivery 的触发入口命名清楚，例如 `alembic cursor-rules`、`alembic setup --profile full-ide`、显式 IDE delivery opt-in。

## 最终边界

Codex 插件版本是 Alembic 的 Codex 渠道入口：

- 保留 Alembic Core 的扫描、知识、Guard、Recipes、Skills、Panorama、Wiki、Dashboard、daemon job。
- 保留内部 Agent 与外部 Agent 双路径，但 Codex 默认使用 daemon job 的内部路径。
- 默认 Ghost mode，默认不污染项目。
- 默认不安装 VSCode 扩展，不写 Cursor/VS Code/Copilot/AGENTS/CLAUDE 文件。
- 默认通过 MCP prime/search/guard/task 交互，不通过 IDE 指令文件交互。
- IDE 交付继续存在，但归属 full-ide profile 和显式 opt-in。

这个限定能让 Codex 插件保持轻入口、可恢复、低项目侵入，同时不牺牲 Alembic 原有的完整能力。
