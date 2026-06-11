# Alembic Agent Instructions

<!-- wakeflow:scope:start -->
## Workspace Access Card

This section is maintained by the Wakeflow runtime installer. It records this window access coordinates and the minimum automation gate. Hard rules come from the parent AGENTS and this file; do not duplicate repository-specific rules here.

### Coordinates

- Wakeflow runtime: `..`
- Window name: `Alembic`
- Parent workspace AGENTS: `../AGENTS.md`
- Active workspace index: `../.workspace-active/workspace/index.md`
- Active workspace status: `../.workspace-active/workspace/current/workspace-current-status.md`
- Current plan directory: `../.workspace-active/workspace/current`
- Window ledger: `../wakeflow-ledger/Alembic`

### When claiming workspace work

1. Read this file first.
2. Then read parent `../AGENTS.md`.
3. Then read `../.workspace-active/workspace/index.md` and `../.workspace-active/workspace/current/workspace-current-status.md`.
4. If there is a current plan, task package, or direct-thread delivery, execute only the content under `../.workspace-active/workspace/current` explicitly assigned to `Alembic`.
5. Goals, scope, forbidden actions, validation commands, and backfill fields come from the current plan, task package, and repository rules. Prompts are only wakeup entrypoints, not the full task specification.

### Direct Thread Dispatch Minimum Gate

- Direct-thread delivery is the normal work transport. It does not change this window responsibility or expand task scope. Specific work comes from the dispatch packet, current plan, and repository rules.
- Delivery prompts carry only a few dynamic variables and a skill pointer. Do not treat the prompt as a full command manual. State-machine routes need only visible `currentWindow` / `taskId` / `stateRoot` / optional `dispatchGroup`. Machine fields such as `controllerWindow`, `returnPolicy`, `humanContextRef`, and `stateRevision` are read from the state root, dispatch group, and delivery envelope. Stop and report if `stateRoot` is missing or variables conflict.
- This window only handles dispatch packets for `Alembic` and returns `TargetResultEnvelope`. Do not claim, accept, or process other window tasks.
- Child windows do not create target-to-target next-hop delivery by default. Evidence repair, redispatch, and next phases are decided by controller review. If delivery has `returnRoute=controller` and `review-results` shows that `DispatchGroup.returnPolicy` allows a callback, create exactly one controller-return envelope with `build-controller-return`, returning by default to the original controller named by `DispatchGroup.controllerWindow`. Then complete the real direct-thread send, readback, and `record-delivery-run`. A controller return is complete only when a `DirectThreadDeliveryRun` exists with `status=sent` and `readback.ok=true`. The full group snapshot stays in the controller-return envelope; the visible prompt shows only non-empty exceptional targets and must not treat one target backfill as whole-group completion.
- Non-Test windows must not create, process, or verify Test delivery unless both the current plan and delivery envelope explicitly authorize it.
- Thread ids may only be written to Wakeflow local runtime. Do not write them to tracked documents, backfill text, or GitHub.

### Document Destinations

- Long-term cross-repository collaboration docs, plans, acceptance records, scans, and boundary records go to `../wakeflow-ledger/Alembic`. This repository `docs/` is only for product, release, or user docs maintained with the source.
<!-- wakeflow:scope:end -->

## 本窗口最高停止卡

本仓库是 Alembic 本地增强底座，不是用户项目环境，也不是临时试验仓库。本节是仓库级执行前停止卡；如果它与当前计划、脚本输出或自动化回填冲突，按更严格的规则执行。

### 先停下

- 如果当前任务没有明确分配给 `Alembic`，或当前目录不是本仓库，停止并回报总控。
- 如果准备把用户目标替换成“干净”“薄”“轻量”“空壳”“先搭框架”等实现路线，停止。
- 如果准备把完整实现改成薄实现、空壳接口、静态 mock、无真实调用方的 glue code，停止。
- 如果计划删减、替换、降级、延期、只做部分、只保留接口、暂不接入或改变完整范围，但没有用户或当前总控计划确认，停止。
- 如果要把 CLI、daemon、HTTP/API、Dashboard server、本地运行时、平台能力、sandbox、native/IDE、注入资源、AI/provider、tool adapter 或 release/install/dev link 迁走、删除或空壳化，停止。
- 如果 Core 已经承接共享内核，但本仓库的外层 adapter、wiring、transport、用户体验或本地增强能力没有替代入口，停止删除。
- 如果要修改 `AlembicCore`、`AlembicPlugin`、`AlembicAgent`、`AlembicDashboard` 或真实测试项目，当前计划没有授权时停止。
- 如果没有提交 hash 或明确 no-commit 理由、验证命令、验证结果、遗留风险和下一步建议，不能回填为完成。
- 如果验证失败，回到同一代码链路继续修；不要扩大到无关重构、补防护或改提示词。

### 正确顺序

1. 先确认当前计划、任务包、仓库边界和最小代码链路。
2. 再读取真实入口、调用方、消费方、配置和现有测试。
3. 只在本仓库职责内实现或修复，并保持 Core / Plugin / Dashboard / Agent 边界。
4. 最后运行匹配验证并回填可复核证据。

## 仓库定位

- `Alembic` 是本地完整能力主仓库，负责用户可运行的 Alembic CLI、daemon、Dashboard、HTTP/API、本地运行时、平台能力、sandbox、native/IDE 集成、注入资源、发布和安装体验。
- 日常开发和总控验收优先通过 workspace 本地 `../AlembicCore` 与 `@alembic/core: file:../AlembicCore` 接入共享内核能力；`vendor/AlembicCore` 只作为 workspace 外 fallback、release snapshot 或便携交付校验入口。
- Core 迁移完成不等于本仓库变空；本仓库必须保留外层 adapter、wiring、transport、CLI/Dashboard 用户体验、本地 AI/provider 编排、tool system、internal agent、sandbox、native/IDE 等宿主能力。
- Codex 插件、Codex marketplace/channel 和插件发布链路属于 `AlembicPlugin`，不要在主仓库重新引入插件发布壳。

## 职责边界

- 本仓库保留 CLI、daemon、HTTP/API、Dashboard server、ProjectRegistry、file monitor、JobStore、internal AI jobs、平台能力和本地安装 / dev / release。
- 本仓库可以消费 `AlembicCore` 的共享内核，但不能把本地增强底座削成 Core 的空壳 wrapper。
- 本仓库可以消费 Agent/tool contract，但不要重新承载 `AlembicAgent` 的独立 Agent runtime 边界。
- 本仓库可以服务 Dashboard 构建和后端接口，但前端 UI 源码边界以当前仓库真实结构和 `AlembicDashboard` 迁移计划为准。
- Codex MCP、Codex Skill、channel、marketplace 和 Codex 插件发布链路属于 `AlembicPlugin`。

## Core 接入规则

- 本地开发优先使用 workspace 本地 `../AlembicCore`；只有 workspace 外独立运行、release snapshot 或 vendor 指针验收时才使用 `vendor/AlembicCore` fallback。
- 外层仓库只提交必要接入代码、`package.json` / lockfile 和 release/snapshot 场景下的子仓库指针；Core 内部实现必须在 `AlembicCore` 仓库提交。
- 构建通过 `npm run build:core` 先解析本地 Core 源码并构建 Core 的 `dist/`，再运行本仓库 TypeScript 构建。
- 不要绕过 `@alembic/core` 包入口直接从 `../AlembicCore/src/**` 或 `vendor/AlembicCore/src/**` 引用源码。
- 已迁入 Core 的共享逻辑应通过 `@alembic/core` 子路径导入；未迁入或属于宿主边界的逻辑继续使用本仓库 `lib/**` 真实实现。
- 删除本仓库重复实现前，必须确认所有 import 已切到 Core 或本仓库 adapter，且对应 build/test 通过。

## 本仓库必须保留的边界

- `lib/cli/**`、`bin/**`：CLI 命令和用户交互。
- `lib/daemon/**`、`lib/http/**`：daemon、HTTP server、routes、实时服务。
- `dashboard/**`：Dashboard 构建产物托管与后端服务边界（前端源码在 `AlembicDashboard` 仓库维护）。
- `@alembic/agent` public subpaths、`lib/tools/**`：Agent 公共 contract 消费与主仓库 host-owned tool adapter / platform bridge。
- `lib/platform/**`、`lib/sandbox/**`、`lib/injection/**`、`resources/**`：平台、沙盒、注入、native/IDE 资源。
- AI provider、API key 管理、release/install/dev link、本地环境探测等宿主能力。

这些能力不能因为 Core 存在而被移动、空壳化或删除。

## 验证与回填

- `npm run build:check`：包含 Core build 和本仓库 no-emit 检查。
- `npm run build`：构建 Core 和本仓库。
- `npm run test` / `npm run test:unit` / `npm run test:integration` / `npm run test:e2e`：按改动范围选择。
- `npm run lint`：Biome 检查。
- `npm run lint:repo-boundary`：仓库边界扫描。
- Dashboard 改动需要运行 `npm run build:dashboard`。
- 本地 CLI 链接验证使用 `npm run dev:link`，再在真实测试项目中执行命令；不要在 Alembic 仓库内冒充用户项目。
- 回填必须写清完成范围、提交 hash、验证命令、验证结果、遗留风险和下一步建议。
- 只改文档时也要说明为什么不需要产品构建，并至少运行 `git diff --check`。

## 文件地图

- 正式源码：`lib/`、`bin/`、`config/`。
- 正式脚本：`scripts/`。
- 正式文档：`docs/`。
- 开发临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。
- Dashboard 构建产物：`dashboard/`（仅存放构建输出 `dashboard/dist`，由 `npm run build:dashboard` 从 `AlembicDashboard` 仓库构建并复制而来；前端源码唯一权威仓库是 `AlembicDashboard`，不要在本仓库新增 Dashboard 前端源码）。
- 注入资源和原生资源：`injectable-skills/`、`resources/`。
- 内部技能挂载点：`skills/`（配置的运行时挂载目录：`config/default.json` 将 package `internalSkills` 与 project `skills` 映射到该目录，`lib/bootstrap.ts` 启动时扫描 `skills/*/hooks.js` 加载技能钩子；仓库内保持空目录是正常预留状态，不要删除）。
- Core 本地源码：`../AlembicCore`；Core vendor fallback / release snapshot：`vendor/AlembicCore`。
- workspace 级长期协作文档按 Workspace 接入卡中的 `Window ledger` 归档。

当前主要源码分层（与 `ls lib/` 实际目录一致，2026-06-11 校准；`lib/agent/` 与 `lib/external/` 已随迁移移除）：

```text
lib/
├── bootstrap.ts
├── cli
├── daemon
├── governance
├── http
├── infrastructure
├── injection
├── platform
├── project-scope
├── repository
├── resident
├── sandbox
├── service
├── shared
├── tools
├── types
└── workflows
```

## 技术与代码规则

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，包括 `#shared/*`、`#infra/*`、`#service/*`、`#inject/*`、`#governance/*`、`#platform/*`、`#types/*`、`#http/*`、`#workflows/*`、`#tools/*`、`#sandbox/*`。
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard：React + Vite。
- 必须尽量多地在代码旁补充简体中文说明，优先解释迁移边界、宿主职责、复杂状态机、分叉原因、降级原因、兼容路径、持久化影响和后续校验方式。
- 任何运行时分叉、fallback、降级、兼容转译、跳过、短路、重试、取消或错误归类，都必须打印足够明确的日志或诊断事件，日志要能看出触发条件、选择路径、关键输入、结果状态和后续校验依据。
- `catch` 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 错误处理优先使用 `dashboard/src/utils/error.ts` 的工具函数。
- 避免 `as any`；不得已时在附近说明原因。
- `throw` 只能抛出 `Error` 实例。
- if/else/for/while 必须使用花括号。
- 不要回退其他窗口或用户已有改动；如果工作区已有无关变更，只处理当前任务需要的文件。

## 长期维护规则

- 改 Core 接入前先确认 Core exports 和外层 adapter 边界。
- 改 CLI/daemon/Dashboard/tool/agent 时，默认这是主仓库职责，不要把宿主行为强行迁入 Core。
- 删除旧实现必须先有扫描、替代入口、测试和可解释的提交。
- 日常开发需要 Core 变更时，先在 `AlembicCore` 提交并通过 `file:../AlembicCore` 验证；只有 release、snapshot、workspace 外独立运行或总控明确要求时，再更新 `vendor/AlembicCore` 指针并运行本仓库验证。
