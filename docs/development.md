# 开发指南

Alembic 开发者指南。涵盖环境搭建、项目结构、编码规范、测试和发版流程。

---

## 环境要求

- **Node.js** ≥ 22
- **macOS** 推荐（Xcode 自动化功能需要；其余功能跨平台）
- **Git**

## 快速开始

```bash
git clone https://github.com/GxFn/Alembic.git
cd Alembic
npm install

# 全局链接开发版本
npm run dev:link

# 验证安装
npm run dev:verify    # → which asd && asd -v
```

---

## 项目结构

```
Alembic/
├── bin/                    # 入口脚本
│   ├── cli.js              # CLI 入口 (asd 命令)
│   ├── mcp-server.js       # MCP stdio 服务器
│   └── api-server.js       # HTTP API 服务器
├── lib/                    # 核心源码（分层架构）
│   ├── bootstrap.js        # 初始化引导
│   ├── injection/          # DI 容器
│   ├── core/               # 核心层（AST/Gateway/Discovery/Enhancement/Constitution）
│   ├── domain/             # 领域层（实体/值对象）
│   ├── repository/         # 仓储层（SQLite 实现）
│   ├── service/            # 服务层（15 个子域）
│   ├── infrastructure/     # 基础设施层（DB/Cache/Event/Log/Vector）
│   ├── external/           # 外部集成（AI Provider/MCP Server）
│   ├── http/               # HTTP API 层（Express/路由/中间件）
│   ├── cli/                # CLI 服务（Setup/Sync/Scan/Upgrade）
│   ├── platform/           # 平台特定（iOS/Xcode/SPM）
│   └── shared/             # 共享工具（常量/错误/工具函数）
├── config/                 # 配置文件
├── dashboard/              # 前端（React + TypeScript + Vite）
├── skills/                 # Agent Skill 包（20 个）
├── templates/              # 初始化模板
├── scripts/                # 开发/部署脚本
├── test/                   # 测试
├── resources/              # 资源文件（WASM grammars/原生 UI/VS Code 扩展）
├── docs/                   # 正式文档（跟随 Git）
├── docs-dev/               # 开发临时文档（不跟随 Git）
├── scratch/                # 临时测试脚本（不跟随 Git）
└── logs/                   # 运行日志（不跟随 Git）
```

### 分层依赖规则

```
Entry Points → Bootstrap → DI Container
                                ↓
              HTTP / MCP / CLI / Dashboard
                                ↓
                          Service Layer
                                ↓
                      Core + Domain Layer
                                ↓
                      Infrastructure Layer
                                ↓
                        External Layer
```

**严格规则：** 上层可依赖下层，反之不可。Service 不能直接依赖 HTTP；Core 不能依赖 Service。

---

## 编码规范

### 模块系统

- **ESM Only** — 全项目使用 ES Modules（`import` / `export`）
- 文件扩展名 `.js`（不是 `.mjs`）
- `package.json` 已设置 `"type": "module"`

### 代码风格

- 使用 [Biome](https://biomejs.dev/) 进行格式化和 lint
- 配置文件：`biome.json`
- 运行：`npx biome check .`

### 命名约定

| 类型 | 约定 | 示例 |
|------|------|------|
| 文件名 | PascalCase | `KnowledgeService.js` |
| 类名 | PascalCase | `class KnowledgeService` |
| 方法名 | camelCase | `findByQuery()` |
| 私有方法 | _ 前缀 | `_buildCommentMask()` |
| 常量 | UPPER_SNAKE | `MAX_FILES` |
| 配置键 | camelCase | `qualityGate.maxErrors` |

### DI 模式

所有服务通过 `ServiceContainer` 注册和获取，不直接 `new`：

```javascript
// 注册（在 ServiceContainer.js 中）
this.register('knowledgeService', () => {
  return new KnowledgeService(
    this.get('knowledgeRepository'),
    this.get('auditLogger')
  );
});

// 使用
const service = container.get('knowledgeService');
```

### 错误处理

继承 `BaseError`：

```javascript
import { BaseError } from '../shared/errors/index.js';

class KnowledgeNotFound extends BaseError {
  constructor(id) {
    super(`Knowledge entry not found: ${id}`, 'KNOWLEDGE_NOT_FOUND', 404);
  }
}
```

---

## 测试

### 测试框架

- **Jest** (ESM 模式，`--experimental-vm-modules`)
- 配置文件：`jest.config.js`

### 运行测试

```bash
npm test                    # 全量
npm run test:unit           # 单元测试
npm run test:integration    # 集成测试
npm run test:coverage       # 带覆盖率
```

### 测试结构

```
test/
├── setup.js                # 全局测试配置
├── fixtures/               # 测试固件
│   ├── factory.js          # 测试数据工厂
│   ├── real-project-bench.json
│   └── real-project-stats.json
├── unit/                   # 单元测试（20 个）
│   ├── AgentV8Enhancements.test.js
│   ├── AiProviderExtractJSON.test.js
│   ├── AuditLogger.test.js
│   ├── ConfigLoader.test.js
│   ├── Constitution.test.js
│   ├── ConstitutionValidator.test.js
│   ├── CursorDeliveryPipeline.test.js
│   ├── Errors.test.js
│   ├── Gateway.test.js
│   ├── KnowledgeAPI.test.js
│   ├── KnowledgeEntry.test.js
│   ├── KnowledgeFileWriter.test.js
│   ├── KnowledgeService.test.js
│   ├── PathGuard.test.js
│   ├── PermissionManager.test.js
│   ├── ProjectDataTools.test.js
│   ├── ReasoningLayer.test.js
│   ├── SearchEngine.test.js
│   ├── V10DomainBrain.test.js
│   └── VectorPipeline.test.js
└── integration/            # 集成测试（17 个）
    ├── DirectiveDetector.test.js
    ├── FullFlow.test.js
    ├── GatewayChain.test.js
    ├── GoSupport.test.js
    ├── GuardCheck.test.js
    ├── HttpApi.test.js
    ├── I18nLang.test.js
    ├── KnowledgeCRUD.test.js
    ├── ProbeResolver.test.js
    ├── RealProjectAst.test.js
    ├── RealProjectBootstrap.test.js
    ├── RealProjectDiscovery.test.js
    ├── RealProjectEnhancement.test.js
    ├── RealProjectLanguage.test.js
    ├── SearchPipeline.test.js
    ├── api-endpoints.test.js
    └── http-server.test.js
```

### 编写测试

```javascript
import { jest } from '@jest/globals';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';

describe('KnowledgeEntry', () => {
  test('should create from valid data', () => {
    const entry = KnowledgeEntry.create({ title: 'Test', language: 'javascript' });
    expect(entry.title).toBe('Test');
  });
});
```

### 测试数据工厂

`test/fixtures/factory.js` 提供标准化的测试数据生成：

```javascript
import { createTestKnowledge, createTestCandidate } from '../fixtures/factory.js';

const knowledge = createTestKnowledge({ title: 'Custom Title' });
```

---

## Dashboard 开发

### 技术栈

- React 18 + TypeScript
- Vite 构建
- Tailwind CSS
- Socket.IO（实时通信）
- 支持暗色模式

### 开发

```bash
cd dashboard
npm install
npm run dev           # Vite 开发服务器（HMR）
```

### 构建

```bash
npm run build:dashboard    # 或 cd dashboard && npm run build
```

构建产物输出到 `dashboard/dist/`，由 `asd ui` 的 Express 静态文件服务提供。

### 目录结构

```
dashboard/src/
├── App.tsx                 # 主应用
├── main.tsx
├── api.ts                  # API 客户端
├── types.ts                # TypeScript 类型
├── components/
│   ├── Layout/             # Sidebar + Header
│   ├── Views/              # 17 个页面视图
│   ├── Modals/             # 弹窗组件
│   ├── Shared/             # 共享组件（ChatPanel/CodeBlock/Markdown）
│   └── Charts/             # 图表组件
├── hooks/                  # React Hooks
├── i18n/                   # 多语言
├── lib/                    # Socket.IO 客户端
├── theme/                  # 主题切换
└── styles/
```

---

## 脚本工具

`scripts/` 目录包含开发和运维脚本：

| 脚本 | 用途 |
|------|------|
| `postinstall-safe.js` | npm postinstall 安全初始化 |
| `build-native-ui.js` | macOS 原生 UI 编译（Swift） |
| `setup-mcp-config.js` | 安装 MCP 配置到 IDE |
| `install-cursor-skill.js` | 安装 Cursor Skill |
| `install-vscode-copilot.js` | 注入 VS Code Copilot Instructions |
| `install-full.js` | 全量安装（MCP + Skills + Copilot） |
| `init-db.js` | 初始化数据库 |
| `diagnose-mcp.js` | MCP 连接诊断 |
| `release.js` | 发版脚本（check / patch / minor / major） |
| `recipe-audit.js` | Recipe 质量审计 |
| `bench-real-projects.mjs` | 性能基准测试 |

---

## 发布流程

### 版本检查

```bash
npm run release:check      # 检查发版条件
```

### 发布

```bash
npm run release:patch      # 补丁版本 (x.x.+1)
npm run release:minor      # 次版本 (x.+1.0)
npm run release:major      # 主版本 (+1.0.0)
```

`release.js` 自动执行：
1. 运行测试
2. 更新 `package.json` 版本号
3. 更新 `CHANGELOG.md`
4. Git commit + tag
5. `npm publish`

### Dashboard 构建

发布前需要构建 Dashboard：

```bash
npm run build:dashboard    # 必须在 npm publish 前执行
```

`prepublishOnly` 脚本会自动构建原生 UI（macOS），但 Dashboard 需手动构建。

---

## 文件存放约定

| 目录 | 用途 | Git 追踪 |
|------|------|---------|
| `docs/` | 正式文档 | ✅ |
| `docs-dev/` | 开发中的临时文档 | ❌ |
| `scratch/` | 临时测试脚本 | ❌ |
| `scripts/` | 正式脚本 | ✅ |
| `logs/` | 运行日志 | ❌ |

---

## 关键开发注意事项

1. **不在本项目执行 asd 用户命令**（如 `asd setup`、`asd embed`），本仓库是 Alembic 源码，不是用户项目
2. **测试 asd 命令** 先运行 `npm run dev:link` 部署到全局，然后在独立的测试项目中执行
3. **ESM 兼容** — 所有 import 必须带 `.js` 扩展名
4. **DI 注册** — 新增服务必须在 `ServiceContainer.js` 中注册
5. **Gateway Action** — 新增 API 操作必须在 `GatewayActionRegistry` 中注册路由
6. **测试** — 提交前运行 `npm test`
