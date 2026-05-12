# Alembic Codex 插件

Alembic for Codex 让 Codex 获得本地项目记忆，而不是把每一次对话都变成初始化流程。它先启动轻量 MCP shim，在不初始化数据库的情况下报告诊断和工作区状态，默认以 Ghost mode 初始化；只有在请求项目知识、Guard、Dashboard、bootstrap 或 rescan 时，才启动或连接当前工作区的 daemon。

English version: [README.md](README.md)

适合这些 Codex 工作：

- 编码前用项目 Recipes prime Codex。
- 对当前改动运行 Guard 检查。
- 通过可恢复 daemon job 构建或刷新项目知识。
- 只在需要视觉交接时打开本地 Dashboard。

## 安装

从 GxFn Codex Marketplace 插件目标安装：

```bash
npx codex-marketplace add GxFn/Alembic/plugins/alembic-codex --plugin
```

如果要固定到对应 Git tag，先创建并推送该 tag，然后使用：

```bash
npx codex-marketplace add https://github.com/GxFn/Alembic/tree/v0.1.0/plugins/alembic-codex --plugin
```

如果 Codex 要求填写 GitHub Target 或直接 artifact path，请填写：

```text
https://github.com/GxFn/Alembic/tree/v0.1.0/plugins/alembic-codex
```

如果 Codex 弹窗把来源、Git 引用、稀疏路径拆开填写，请这样填：

```text
来源：
https://github.com/GxFn/Alembic.git

Git 引用：
v0.1.0

稀疏路径：
plugins/alembic-codex
```

安装后在插件列表里启用 `alembic-codex`。

## Runtime

- 需要 Node.js 22 或更新版本。本地开发推荐 Node 22 LTS；MCP shim 和 daemon 应使用同一个 Node 可执行文件。
- Marketplace MCP 配置固定 runtime 包为 `alembic-ai@0.1.0`。
- Marketplace MCP 配置会设置 `ALEMBIC_CHANNEL_ID=codex`；项目功能判断应使用这个稳定渠道标识。
- MCP 启动命令通过 `npx --prefix /tmp` 运行，避免 Alembic 仓库里的本地 `package.json` 影响已发布 runtime binary。
- 默认 MCP tier 是 `agent`；只有同时设置 `ALEMBIC_MCP_TIER=admin` 和 `ALEMBIC_CODEX_ENABLE_ADMIN=1` 时，才会显示 admin tools。

## 首次检查

先使用 `alembic_codex_diagnostics`。它会报告 Node、npm、npx、package version、daemon version、插件元数据检查、离线 fallback 指引、清理策略，以及结构化的 `issues` / `nextActions`。

使用 `alembic_codex_status` 检查工作区初始化和 daemon 状态，不会启动 daemon。返回结果包含 `onboarding` 块：当前状态、推荐的下一步 tool call、该调用是否会启动 daemon，以及后续动作。

在 Codex 外也可以用 CLI 做同样检查：

```bash
alembic codex diagnostics --json
alembic codex status --json
```

正常的第一分钟流程是：

1. `alembic_codex_diagnostics`
2. `alembic_codex_status`
3. 状态为 `needs_init` 时调用 `alembic_codex_init`
4. 用 `alembic_codex_bootstrap` 构建第一轮项目知识，或在编码前调用 `alembic_task` 并设置 `operation=prime`

## 长任务

`alembic_codex_bootstrap` 和 `alembic_codex_rescan` 会立即返回持久 job id。Codex 重连或 Dashboard 刷新后，用 `alembic_codex_job` 携带该 id 继续检查状态。

如果 Alembic daemon 在活跃 job 完成前关闭或重启，下一次 daemon 生命周期会把该 job 标记为 `failed`，并记录中断原因，避免 job 永远停在 `queued` 或 `running`。需要重试时，重新启动 bootstrap 或 rescan job。

## 发布验证

发布前运行：

```bash
npm run release:codex-plugin
```

这会构建 runtime 和 Dashboard，验证本地 Codex marketplace entry、固定 MCP runtime、轻量 `alembic-codex-mcp` binary、默认 agent tier、关闭的 admin gate、声明的 assets、随包 skills、default prompts、README runtime fallback、npm tarball 内容、本地安装模拟，以及真实 MCP stdio 调用。

完整本地 daemon 链路运行：

```bash
npm run release:codex-plugin:daemon
```

这个可选流程还会在临时 localhost 端口启动 daemon，并验证被中断 job 的恢复行为。`prepublishOnly` 会运行 `release:codex-plugin`。

完整发布、测试和推广计划见 [RELEASE-PLAYBOOK.md](./RELEASE-PLAYBOOK.md)。

## 本地 Marketplace

仓库包含 `.agents/plugins/marketplace.json`，让本地 Codex build 可以在 `gxfn` marketplace 下发现 Alembic 插件，和 `codex-lark-remote` 保持一致。该 entry 指向 `./plugins/alembic-codex`，安装策略为 `AVAILABLE`，认证策略为 `ON_INSTALL`。

开发时把这个仓库注册为 local marketplace：

```toml
[marketplaces.gxfn]
source_type = "local"
source = "/absolute/path/to/Alembic"

[plugins."alembic-codex@gxfn"]
enabled = true
```

`npm run smoke:codex-plugin` 会打包 runtime，从 tarball 里解析 marketplace entry，把插件复制到临时安装目录，并验证已安装 manifest、MCP 配置、assets、skills 和 stdio MCP 调用。

## 离线 Fallback

默认插件配置通过固定版本 `npx` 启动。如果首次运行无法访问 npm registry，可以全局安装同一 runtime 版本，然后从 `PATH` 运行 MCP binary：

```bash
npm install -g alembic-ai@0.1.0
alembic-codex-mcp
```

## 清理策略

卸载插件不会自动删除 Alembic 数据。需要显式清理时使用 `alembic_codex_cleanup`。默认调用是 dry run；`confirm=true` 只移除 daemon runtime state、logs、locks 和 job files。Knowledge、Recipes、candidates 和项目数据会保留。
