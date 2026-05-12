# lib/codex

`lib/codex` 集中维护 Alembic 面向 Codex 插件形态的运行约定。

这里管理的是插件入口需要共享的稳定事实：Codex 渠道标识、插件名、runtime package/bin、MCP 默认 tier、admin gate、channel/marketplace/plugin manifest 路径、插件资产与 Skill 校验、runtime diagnostics。

边界：

- 不承载 Alembic core 能力本身；AgentRuntime、tools、daemon、Guard、Recipes、bootstrap/rescan 仍在各自模块。
- 不把插件化解释成削减能力；这里只统一入口和诊断，不替代成熟主链路。
- 不从安装路径推断功能；功能判断使用稳定 channel id。
- 不把 `.env` 当基础配置；Codex 入口只使用进程级 runtime overrides 和 workspace settings/secrets。

主要入口：

- `RuntimeContext.ts`：Codex 常量、MCP shim 默认环境、runtime context。
- `PluginRegistry.ts`：读取 channel、marketplace、plugin manifest、MCP 配置和插件 README。
- `Diagnostics.ts`：生成 Codex runtime/plugin diagnostics，供 MCP 与 CLI 复用。
