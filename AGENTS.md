# Alembic Agent Instructions

**重要**：本项目是 Alembic 主仓库，不是用户项目环境。

Agent 不够聪明。

Agent 可以制定目标和计划，但目标和计划必须服务于用户提出的真实任务，不能被 Agent 自己偏好的“干净”“薄”“轻量”“空壳”“先搭框架”等路线替换。

Agent 不得把完整实现改成薄实现，不得把成熟能力改成空壳接口，不得把迁移、整理、重构、优化或插件化解释成削减功能。

当 Agent 的计划涉及删减、替换、降级、延期、只做部分、只搭框架、只保留接口、暂不接入或改变完整范围时，必须先向用户确认。

## 仓库定位

- `Alembic` 是本地完整能力主仓库，包含 CLI、daemon、Dashboard、本地运行时、知识系统、Guard、search、workflow、tool system、sandbox、平台能力和外部集成。
- `@alembic/core` 通过 `vendor/AlembicCore` 子仓库和 `file:vendor/AlembicCore` 依赖接入；只有已经在 Core 中完整保真的共享能力才可以切换过去。
- 不要把迁移到 Core 理解成删除本仓库能力。外层 adapter、CLI/Dashboard 体验、本地 AI/provider 编排、发布脚本和用户交互仍属于主仓库。
- 不要在 `/Users/gaoxuefeng/Documents/github` 下的旧项目工作；当前统一使用 `/Users/gaoxuefeng/Documents/AlembicWorkspace`。

## Core 接入规则

- `vendor/AlembicCore` 是独立 Git 子仓库，远端应指向 `https://github.com/GxFn/AlembicCore.git`。
- 外层仓库只提交子仓库指针、`package.json` / lockfile 和必要接入代码；Core 内部实现必须在 `AlembicCore` 仓库提交。
- 外层构建通过 `npm run build:core` 先构建 Core 的 `dist/`，再运行本仓库 TypeScript 构建。
- 不要绕过 `@alembic/core` 包入口直接从 `vendor/AlembicCore/src` 引用源码。
- Core 迁移未完成的模块继续使用本仓库 `lib/**` 真实实现，不要用薄 wrapper 替代。

## 需要测试时

- 本地测试 `asd` 命令：先运行 `npm run dev:link` 将开发代码部署到全局，然后要求开发者提供测试项目路径执行 `asd` 命令。
- 使用专门的测试脚本：可执行 `test-*.js` 或 `scripts/` 中的开发工具脚本。
- 不要在 Alembic 项目内测试用户命令，避免混淆开发环境与用户项目环境。
- 常用验证：
  - `npm run build`
  - `npm run build:check`
  - `npm run lint`
  - `npm run test:unit`
  - `npm run test:integration`
  - `npx vitest run test/path/to/file.test.ts`

## 文件存放约定

- 开发中的临时文档：`docs-dev/`（不跟随 git）。
- 临时测试脚本：`scratch/`（不跟随 git）。
- 正式文档：`docs/`（跟随 git）。
- 正式脚本：`scripts/` 或 `bin/`（跟随 git）。
- workspace 级迁移文档保存在 `/Users/gaoxuefeng/Documents/AlembicWorkspace/docs/`。

## 技术栈与编码约定

- 语言：TypeScript (ES2024, NodeNext)，Node.js >= 22。
- 模块系统：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀。
- 路径别名定义在 `package.json` imports 字段，当前包括：
  - `#shared/*`
  - `#infra/*`
  - `#service/*`
  - `#agent/*`
  - `#domain/*`
  - `#inject/*`
  - `#core/*`
  - `#external/*`
  - `#platform/*`
  - `#repo/*`
  - `#types/*`
  - `#http/*`
  - `#workflows/*`
  - `#tools/*`
  - `#sandbox/*`
- Lint / Format：Biome 2.x，不使用 Prettier/ESLint。
- 测试框架：Vitest。
- Dashboard：React + Vite，构建命令 `npm run build:dashboard`。

## Biome 关键规则

- `useConst`：不可变变量必须用 `const`。
- `useBlockStatements`：if/else/for/while 必须使用花括号。
- `useThrowOnlyError`：throw 只能抛出 Error 实例。
- `noVar`：禁止 `var`。
- `noDoubleEquals`：禁止 `==`、`!=`，使用 `===`、`!==`。
- `organizeImports`：import 必须按规则组织。

## 类型安全约定

- catch 块使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`。
- Dashboard 错误处理优先使用 `dashboard/src/utils/error.ts` 的工具函数。
- 避免 `as any`；不得已时加注释说明原因。
- API 返回类型应有明确接口。

## 架构层次

```text
lib/
├── agent
├── cli
├── core
├── daemon
├── domain
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

## 子项目与资源

- `dashboard/`：Dashboard 前端。
- `injectable-skills/`：可注入 skill 资源。
- `resources/`：原生辅助资源、grammar、IDE 扩展资源等。
- `vendor/AlembicCore`：Core 子仓库依赖。
