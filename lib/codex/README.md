# lib/codex

`lib/codex` 集中维护 Alembic 面向 Codex 插件形态的运行约定。

这里管理的是插件入口需要共享的稳定事实和策略：通用插件运行时模式、Codex 插件宿主标识、Codex 渠道标识、插件名、runtime package/bin、MCP 默认 tier、admin gate、channel/marketplace/plugin manifest 路径、插件资产与 Skill 校验、runtime diagnostics、workspace knowledge state、工具可见性策略、MCP status、Codex long-running job 来源上下文。

当前阶段只维护 `alembic-codex` 这一个 Codex 插件和 `alembic-ai` runtime，不在这里做多插件或多个非插件包的提前抽象。

边界：

- 不承载 Alembic core 能力本身；AgentRuntime、tools、daemon、Guard、Recipes、bootstrap/rescan 仍在各自模块。
- 不把插件化解释成削减能力；这里只统一入口和诊断，不替代成熟主链路。
- 不从安装路径推断功能；通用插件判断使用 `ALEMBIC_RUNTIME_MODE=plugin`，Codex 宿主判断使用 `ALEMBIC_PLUGIN_HOST=codex`，渠道判断使用稳定 channel id。
- 不把 `.env` 当基础配置；Codex 入口只使用进程级 runtime overrides 和 workspace settings/secrets。

主要入口：

- `RuntimeContext.ts`：Codex 常量、MCP shim 默认环境、runtime context。
- `PluginRegistry.ts`：读取 channel、marketplace、plugin manifest、MCP 配置和插件 README。
- `Diagnostics.ts`：生成 Codex runtime/plugin diagnostics，供 MCP 与插件验证脚本复用。
- `KnowledgeState.ts`：检查 Codex workspace/Ghost data root 是否初始化、是否已有可用 Recipes 或 Project Skills，并只读汇总 bootstrap/rescan job、SourceRef stale、bootstrap snapshot、knowledge freshness 与 optional vector index 状态。
- `ToolPolicy.ts`：维护当前 `alembic-codex` 插件的 local tools 与工具可见性策略，输出 needs-init、bootstrap-running、ready-stale、daemon-stale 等可解释状态；vector 缺失是 non-blocking 信号，不会隐藏已有知识工具。
- `StatusService.ts`：构建 MCP 使用的 Codex status、onboarding、next actions 和 daemon 状态摘要。
- `JobContext.ts`：构建 bootstrap/rescan job 的 Codex channel、client、session、tool、actor 上下文。
