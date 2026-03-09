## AutoSnippet 项目特性

**重要**：本项目是 AutoSnippet 的核心开发仓库，不是用户项目环境。

### 禁止操作
- **不要执行面向用户的 asd 命令**：如 `asd setup`、`asd embed`、`asd search` 等（这些是为用户项目设计的）
- **不要在本项目启动测试性前端服务**：如 Dashboard UI 测试、开发服务器等
- **不要把 AutoSnippet/ 目录当做用户的 Knowledge Base**：它是源代码库，不是某个用户的项目数据
- **不要在项目根目录创建 `.autosnippet/` 或 `AutoSnippet/candidates/`**：这些是用户项目的运行时目录，代码中有 `isOwnDevRepo()` 保护机制会阻止创建

### 需要测试时
- **本地测试 asd 命令**：先运行 `npm run dev:link` 将开发代码部署到全局，然后要求开发者提供测试项目路径执行 asd 命令
- **使用专门的测试脚本**：可执行 `test-*.js` 或 `scripts/` 中的开发工具脚本
- **不要在 AutoSnippet 项目内测试用户命令**：避免混淆开发环境与用户项目环境
- **运行测试**：`npm run test:unit`（单元）、`npm run test:integration`（集成）、`npx vitest run test/path/to/file.test.ts`（单文件）

### 文件存放约定
- **开发中的临时文档**：保存到 `docs/copilot/`（不跟随 git）
- **临时测试脚本**：保存到 `scratch/`（不跟随 git）
- **正式文档**：保存到 `docs/`（跟随 git）
- **正式脚本**：保存到 `scripts/` 或 `bin/`（跟随 git）

### 技术栈与编码约定
- **语言**：TypeScript (ES2024, NodeNext)，Node.js ≥ 22
- **模块系统**：ESM (`"type": "module"`)，import 路径必须带 `.js` 后缀（如 `import foo from './foo.js'`）
- **路径别名**：使用 `#shared/*`、`#infra/*`、`#service/*`、`#agent/*`、`#domain/*`、`#inject/*`、`#core/*`、`#external/*`、`#platform/*`、`#repo/*`、`#types/*`、`#http/*`（定义在 package.json imports 字段）
- **Lint / Format**：Biome 2.0（不使用 Prettier/ESLint），`npm run lint` 检查，`npm run lint:fix` 修复
- **测试框架**：Vitest 4.x，测试文件在 `test/unit/` 和 `test/integration/`
- **构建**：`npm run build`（tsc），Dashboard: `npm run build:dashboard`（Vite）
- **CI**：GitHub Actions — build → lint → dashboard build → unit tests → integration tests

### Biome 关键规则（error 级别，必须遵守）
- `useConst` — 不可变变量必须用 `const`
- `useBlockStatements` — if/else/for/while 必须使用花括号
- `useThrowOnlyError` — throw 只能抛出 Error 实例
- `noVar` — 禁止 `var`
- `noDoubleEquals` — 禁止 `==`、`!=`，使用 `===`、`!==`
- `organizeImports` — import 必须按字母序排列（biome 自动排序）

### 类型安全约定
- **catch 块**：使用 `catch (err: unknown)` + 类型守卫，禁止 `catch (err: any)`
- **Dashboard 错误处理**：使用 `dashboard/src/utils/error.ts` 的工具函数（`getErrorMessage()`、`isAbortError()` 等）
- **VSCode 扩展错误处理**：使用文件内 `toErrorMsg(err: unknown)` 辅助函数
- **避免 `as any`**：优先定义接口或使用泛型，不得已时加注释说明原因
- **API 返回类型**：`dashboard/src/api.ts` 中每个函数都应有明确的返回类型接口

### 架构层次（lib/ 目录）
```
lib/
├── core/         # 核心业务逻辑（Constitution、Gateway、Permission）
├── domain/       # 领域实体（KnowledgeEntry、Lifecycle、FieldSpec、UnifiedValidator、StyleGuide）
├── agent/        # Agent 智能层（AgentRuntime、Memory、Context、Tools）
├── service/      # 服务层（Knowledge、Guard、Search、Skills、Task、Bootstrap、Delivery）
├── repository/   # 数据访问层（KnowledgeRepository）
├── infrastructure/ # 基础设施（Database、Config、Vector、Logging）
├── injection/    # 依赖注入容器（ServiceContainer、Modules）
├── external/     # 外部接口（MCP Server、Lark Transport）
├── platform/     # 平台适配（Xcode、Swift、Language Discoverers、NativeUi）
├── cli/          # CLI 命令实现
├── http/         # HTTP Server / 路由
├── shared/       # 共享工具（PathGuard、package-root、LanguageService、shutdown）
└── types/        # 类型定义
```

### 子项目
- **Dashboard**（`dashboard/`）：React 19 + Vite + Tailwind CSS 前端
- **VSCode Extension**（`resources/vscode-ext/`）：VSCode Copilot 集成扩展

### 开发仓库保护机制
本项目有 `lib/shared/isOwnDevRepo.ts` 检测机制，当 `projectRoot` 指向本源码仓库时：
- `DatabaseConnection` 会将 DB 重定向到 `$TMPDIR/autosnippet-dev/`
- `PathGuard` 会阻止在项目内创建 `.autosnippet/` 和知识库目录
- `SetupService` 会拒绝执行 setup
这是为了防止开发期间的 MCP 服务器和测试在源码仓库中产生运行时垃圾数据。