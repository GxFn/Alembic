# Alembic

Alembic 是面向 IDE 插件的本地项目记忆内核。后续形态以各 IDE 的插件适配为主，核心仓库不再维护独立 CLI 安装、通用 IDE 配置写入、浏览器打开、截图采集或实时文件监听等独立运行能力。

## 当前定位

- 核心运行时：负责 Recipe、Guard、Bootstrap、Rescan、Dashboard daemon、知识检索和项目结构分析。
- 插件适配：由各 IDE 插件负责安装入口、项目目录传递、宿主权限、UI 交互和用户提示。
- Codex 插件：当前保留并重点维护的适配位于 `plugins/alembic-codex`。
- 项目数据：默认由插件传入准确项目目录；无法确定项目目录时，运行时应向上抛出明确错误，不自行猜测或写入。

## Codex 插件

Codex 插件通过轻量 MCP shim 进入 Alembic。`status` 和 `diagnostics` 不会自动初始化项目；用户主动调用初始化，或调用需要项目数据的工具时，才会在项目目录可信的前提下执行初始化。

推荐开发验证链路：

```bash
npm run build
npm run build:dashboard
npm run prepare:codex-plugin-runtime
npm run verify:codex-channel
npm run verify:codex-plugin
npm run smoke:codex-plugin
```

发布链路：

```bash
npm run release:codex-plugin
npm run release:codex-plugin:daemon
```

完整发布、测试和推广方案见 `plugins/alembic-codex/RELEASE-PLAYBOOK.md`。

## 已清理的独立形态

- 删除独立 `alembic` CLI、独立 API server、独立 MCP server 入口，只保留 `alembic-codex-mcp` 作为 Codex 插件运行入口。
- 删除旧 Cursor/VS Code 投递链路，不再生成 `.cursor`、`.vscode`、规则文件、IDE skills 镜像或 MCP 配置。
- 删除旧 Lark Remote 内置代码，Lark Remote 由独立插件承载。
- 删除浏览器打开、截图采集、macOS 系统工具适配等插件内核不应持有的旁支能力。
- 删除文件系统 watcher 和外部文件变更 HTTP 推送入口，只保留明确触发的 git diff checkpoint 能力。

## 开发约定

- 语言：TypeScript，Node.js 22+，ESM，import 路径保留 `.js` 后缀。
- 构建：`npm run build`。
- Dashboard 构建：`npm run build:dashboard`。
- Lint：`npm run lint`。
- 单元测试：`npm run test:unit`。
- 插件运行时刷新：`npm run prepare:codex-plugin-runtime`。

## 架构边界

Alembic 核心只提供稳定的本地知识能力，不直接承担 IDE 安装、宿主 UI、实时编辑监听或用户环境猜测。每个 IDE 插件应单独适配这些边界，并通过明确的项目目录和受控的插件入口调用核心运行时。
