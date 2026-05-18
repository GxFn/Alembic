# Alembic

Alembic 是代码库的本地知识系统。它扫描源码，沉淀结构化 Recipe 知识库，运行 Guard 规则检查，提供本地 Dashboard，并可以通过已配置的 AI Provider 执行冷启动和增量扫描任务。

本仓库是 `alembic-ai` 主包，负责 CLI、daemon、HTTP API、Dashboard server、本地 runtime、发布脚本和 Alembic internal AI 流程。

Codex 宿主 Agent 工作流由 `AlembicPlugin` 仓库负责。Alembic 主包不会安装项目编辑器配置文件，也不维护多宿主 Agent 交付路径。

## 安装

```bash
npm install -g alembic-ai
```

Workspace 本地开发：

```bash
npm install
npm run build
npm run dev:link
```

`npm run dev:link` 会构建本地 Core、Agent、Dashboard 产物和 Alembic 主包，然后更新全局 `alembic` 命令。

## 初始化

在需要 Alembic 管理的项目目录中执行：

```bash
alembic setup --ghost
```

`setup` 只初始化 Alembic 数据和 runtime 状态，不会创建或修改项目编辑器配置。

常用下一步：

```bash
alembic ai status
alembic ai configure --provider openai --model gpt-5.4 --key-stdin
alembic coldstart --dir .
alembic rescan --dir .
alembic ui --dir .
```

## 两条路线

Alembic 当前明确分为两条集成路线：

| 路线 | 归属 | 用途 |
| --- | --- | --- |
| Codex host agent | `AlembicPlugin` | Codex 读取 briefing、分析项目、提交知识并完成维度，不要求先配置 Alembic AI Provider。 |
| Alembic internal AI | `Alembic` + `AlembicAgent` | 已安装的 `alembic` 命令使用配置好的外部 AI Provider 执行冷启动、增量扫描、Guard、Wiki 和知识管理任务。 |

两条路线写入同一套 Alembic workspace 数据模型，但宿主职责保持分离。

## 常用命令

```bash
alembic setup
alembic ai status
alembic ai configure
alembic daemon start
alembic daemon status
alembic coldstart
alembic rescan
alembic ais
alembic search
alembic guard
alembic guard:ci
alembic panorama
alembic server
alembic ui
alembic status
alembic health
alembic embed
alembic sync
```

## 运行时布局

标准模式会在被管理项目中写入 Alembic 数据：

```text
<project>/
├── .asd/
│   ├── config.json
│   ├── alembic.db
│   ├── context/
│   └── logs/
└── Alembic/
    ├── constitution.yaml
    ├── boxspec.json
    ├── recipes/
    ├── candidates/
    ├── skills/
    └── wiki/
```

Ghost 模式会把同样的数据放到用户级 Alembic workspace registry 中，让被管理项目保持无侵入。

## 能力概览

- **Recipe 知识库**：把团队规范、架构模式、最佳实践和代码范式沉淀为 Markdown 知识。
- **Guard**：对文件、目录、暂存区或 CI 流程运行规范检查。
- **Panorama**：分析项目结构、模块关系、覆盖率和知识缺口。
- **Wiki**：根据项目结构、知识库和 AI 组合生成项目文档。
- **Daemon file monitor**：daemon 按项目 git worktree 自主采集文件变化，驱动 reactive evolution。
- **Dashboard**：查看候选知识、任务、Wiki、Guard、AI 配置和 daemon job 状态。

## AI 配置

需要 Alembic internal AI 功能时，先配置 Provider：

```bash
printf %s "$OPENAI_API_KEY" | alembic ai configure --provider openai --model gpt-5.4 --key-stdin
alembic ai status
```

也可以打开 Dashboard 完成配置：

```bash
alembic ui
```

显式进程环境变量可用于一次性运行，并且会覆盖 workspace 配置，但不会被自动持久化。

## 开发检查

```bash
npm run build:check
npm run build
npm run dev:link -- --dry-run --verbose
npm run release:package-guard
npm run lint:agent-extraction-boundary
npm run lint:core-import-boundary
```

`npm run check` 会运行 typecheck、lint 和边界检查。
