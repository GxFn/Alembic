# Alembic Agent Instructions

**重要**：本项目是 Alembic 主仓库，不是用户项目环境。

Agent 可以制定目标和计划，但目标和计划必须服务于用户提出的真实任务，不能被 Agent 自己偏好的“干净”“薄”“轻量”“空壳”“先搭框架”等路线替换。

Agent 不得把完整实现改成薄实现，不得把成熟能力改成空壳接口，不得把迁移、整理、重构、优化或插件化解释成削减功能。

当 Agent 的计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围时，必须先向用户确认。

不要在旧工作区或旧克隆路径下工作；当前统一以本 workspace 内的 Alembic 系列仓库为准。

## 文档存储提示

- 新建长期迁移、计划、验收、扫描、边界和跨仓库任务文档时，统一写到 workspace 根目录的 `docs/Alembic/`，不要散落到各子仓库或 workspace `docs/` 根层级。
- AlembicCore 迁移手册、公开 API 边界、阶段验收、外层接入和删除任务统一写到 `docs/AlembicCore/`；本仓库只执行其中分配给 `Alembic` 窗口的任务。
- 仓库内 `docs/` 只放随源码长期维护的产品文档、发布文档或用户文档；不要放跨仓库协作临时文档。
- 长期文档不得写入用户本机绝对路径、API key、token 或其它私密信息。

## 仓库定位

- `Alembic` 是本地完整能力主仓库，负责用户可运行的 Alembic CLI、daemon、Dashboard、HTTP/API、本地运行时、平台能力、sandbox、native/IDE 集成、注入资源、发布和安装体验。
- 共享内核能力通过 `vendor/AlembicCore` 子仓库和 `@alembic/core: file:vendor/AlembicCore` 接入。
- Core 迁移完成不等于本仓库变空；本仓库必须保留外层 adapter、wiring、transport、CLI/Dashboard 用户体验、本地 AI/provider 编排、tool system、internal agent、sandbox、native/IDE 等宿主能力。
- Codex 插件、Codex marketplace/channel 和插件发布链路属于 `AlembicPlugin`，不要在主仓库重新引入插件发布壳。

## Core 接入规则

- `vendor/AlembicCore` 是独立 Git 子仓库，远端应指向 `https://github.com/GxFn/AlembicCore.git`。
- 外层仓库只提交子仓库指针、`package.json` / lockfile 和必要接入代码；Core 内部实现必须在 `AlembicCore` 仓库提交。
- 构建通过 `npm run build:core` 先构建 Core 的 `dist/`，再运行本仓库 TypeScript 构建。
- 不要绕过 `@alembic/core` 包入口直接从 `vendor/AlembicCore/src/**` 引用源码。
- 已迁入 Core 的共享逻辑应通过 `@alembic/core` 子路径导入；未迁入或属于宿主边界的逻辑继续使用本仓库 `lib/**` 真实实现。
- 删除本仓库重复实现前，必须确认所有 import 已切到 Core 或本仓库 adapter，且对应 build/test 通过。

## 本仓库必须保留的边界

- `lib/cli/**`、`bin/**`：CLI 命令和用户交互。
- `lib/daemon/**`、`lib/http/**`：daemon、HTTP server、routes、实时服务。
- `dashboard/**`：Dashboard 前端。
- `lib/agent/**`、`lib/tools/**`：主仓库 internal agent 和 tool system。
- `lib/platform/**`、`lib/sandbox/**`、`lib/injection/**`、`resources/**`：平台、沙盒、注入、native/IDE 资源。
- AI provider、API key 管理、release/install/dev link、本地环境探测等宿主能力。

这些能力不能因为 Core 存在而被移动、空壳化或删除。

## 需要测试时

- `npm run build:check`：包含 Core build 和本仓库 no-emit 检查。
- `npm run build`：构建 Core 和本仓库。
- `npm run test` / `npm run test:unit` / `npm run test:integration` / `npm run test:e2e`：按改动范围选择。
- `npm run lint`：Biome 检查。
- `npm run lint:repo-boundary`：仓库边界扫描。
- Dashboard 改动需要运行 `npm run build:dashboard`。
- 本地 CLI 链接验证使用 `npm run dev:link`，再在真实测试项目中执行命令；不要在 Alembic 仓库内冒充用户项目。

## 文件存放约定

- 正式源码：`lib/`、`bin/`、`config/`。
- 正式脚本：`scripts/`。
- 正式文档：`docs/`。
- 开发临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。
- Dashboard：`dashboard/`。
- 注入资源和原生资源：`injectable-skills/`、`resources/`。
- Core 子仓库：`vendor/AlembicCore`。
- workspace 级长期协作文档按上方 `文档存储提示` 归档。

当前主要源码分层：

```text
lib/
├── agent
├── cli
├── core
├── daemon
├── external
├── http
├── infrastructure
├── injection
├── platform
├── repository
├── sandbox
├── service
├── shared
├── tools
├── types
└── workflows
```

## 技术栈与编码约定

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，包括 `#shared/*`、`#infra/*`、`#service/*`、`#agent/*`、`#inject/*`、`#core/*`、`#external/*`、`#platform/*`、`#types/*`、`#http/*`、`#workflows/*`、`#tools/*`、`#sandbox/*`。
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard：React + Vite。
- 可以使用中文注释解释迁移边界、宿主职责、复杂状态机或兼容原因；不要给自解释代码堆注释。

## 类型安全与代码规则

- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 错误处理优先使用 `dashboard/src/utils/error.ts` 的工具函数。
- 避免 `as any`；不得已时加注释说明原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 长期维护规则

- 改 Core 接入前先确认 Core exports 和外层 adapter 边界。
- 改 CLI/daemon/Dashboard/tool/agent 时，默认这是主仓库职责，不要把宿主行为强行迁入 Core。
- 删除旧实现必须先有扫描、替代入口、测试和可解释的提交。
- 如果需要同步 Core，先在 `AlembicCore` 提交，再更新 `vendor/AlembicCore` 指针并运行本仓库验证。
