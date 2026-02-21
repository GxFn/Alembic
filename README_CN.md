<div align="center">

# AutoSnippet

**代码知识引擎 — 将团队的代码模式沉淀为 AI 可检索的知识库**

捕获代码模式、最佳实践和架构决策，构建结构化知识库。  
让 Cursor、Copilot、Trae、Qoder、Xcode 和 VS Code 都按你的项目规范生成代码。

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

[English](README.md)

</div>

---

## 解决什么问题？

AI 编码助手生成的代码脱离项目上下文——不知道团队约定、不了解架构模式、也不遵守代码规范。每个 AI 生成的 PR 都变成 review 负担。

**AutoSnippet** 在你的项目中建立一个活的知识库，让所有 AI 工具都能检索并遵循团队沉淀的最佳实践。

```
你的代码库  ──→  AI 扫描提取  ──→  人工审核  ──→  知识库 (Recipe)
                                                      │
               ┌──────────────────────────────────────┘
               ↓
       Cursor / Copilot / Trae / Qoder / Xcode / VS Code
               ↓
       按你的团队规范生成代码
```

## 核心概念

| 概念 | 说明 |
|------|------|
| **Recipe** | 知识库的基本单元 — 一段代码模式 + 使用说明 + 元数据。以 Markdown 文件 (`AutoSnippet/recipes/`) 为 Source of Truth，SQLite 作为检索缓存 |
| **Candidate** | 待审核的候选知识 — 来自 AI 扫描、手动提交、剪贴板或冷启动。经 Dashboard 人工审核后晋升为 Recipe |
| **Guard** | 代码合规引擎 — 基于知识库中的规则对代码做合规检查，支持文件 / Target / 项目三级范围 |
| **Skill** | Agent 指令集（18 个内置）— 引导 AI Agent 正确调用知识库操作 |
| **Bootstrap** | 冷启动引擎 — 9 维度启发式扫描 + 双 Agent AI 分析，一次生成数十条候选 |

## 快速开始

```bash
# 全局安装
npm install -g autosnippet

# 在你的项目目录初始化
cd /path/to/your-project
asd setup              # 创建工作空间、数据库、IDE 集成，自动安装 VS Code 插件

# 冷启动：扫描代码库提取模式
asd coldstart          # 9 维度 AI 分析 → 生成候选

# 启动 Dashboard 审核和管理知识
asd ui                 # Web 管理面板 + API 服务
```

> **重要**：始终在**你的项目目录**中执行 `asd` 命令，而非 AutoSnippet 源码仓库。

## 工作流程

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  ① 初始化   │──→ │ ② 冷启动    │──→ │ ③ 精细扫描  │──→ │ ④ 审核发布  │──→ │ ⑤ IDE 交付  │
│  asd setup │    │ coldstart  │    │  asd ais   │    │ Dashboard  │    │  多通道     │
└────────────┘    └────────────┘    └────────────┘    └────────────┘    └─────┬──────┘
                                                                              │
      ┌───────────────────────────────────────────────────────────────────────┘
      ↓
┌────────────┐    ┌────────────┐
│ ⑥ AI 按    │──→ │ ⑦ 新模式    │──→  回到 ③
│ 规范生成    │    │  再沉淀     │
└────────────┘    └────────────┘
```

1. **初始化** — `asd setup` 创建工作空间、SQLite 数据库、配置 Cursor/VS Code/Qoder/Trae 的 MCP，安装 VS Code 插件
2. **冷启动** — Bootstrap 引擎从 9 个维度扫描代码库（架构、命名、网络、数据流、错误处理等），使用双 Agent 系统（Analyst → Producer）
3. **精细扫描** — `asd ais <target>` 对特定模块做针对性提取
4. **审核** — Dashboard 提供卡片式审核界面，支持 AI 置信度评分、批量操作和内联编辑
5. **IDE 交付** — Recipe 通过 MCP 工具（实时）、Cursor Rules (`.cursor/rules/`)、Agent Skills 三通道交付
6. **AI 生成** — IDE 中的 AI 助手自动检索知识库，按照团队模式生成代码
7. **持续捕获** — 文件监听器检测新模式，形成反馈闭环

## 功能特性

### 🔍 多策略搜索引擎

4 层检索漏斗，5 种搜索模式：

| 层级 | 策略 | 作用 |
|------|------|------|
| L1 | 倒排索引 + BM25 | 关键词快速召回（支持中英文混合分词） |
| L2 | Cross-Encoder 重排 | AI 语义重排 |
| L2.5 | E-E-A-T 粗排 | 5 维度质量评分 |
| L3 | 多信号排序 | 6 信号加权（相关性、权威性、新鲜度、热度、难度、季节性） |

### 🤖 AI 集成（6 个 Provider）

| Provider | 说明 |
|----------|------|
| Google Gemini | 原生函数调用 + 结构化输出 |
| OpenAI | GPT-4o、GPT-4 等 |
| Claude (Anthropic) | 原生函数调用 |
| DeepSeek | OpenAI 兼容 |
| Ollama | 本地模型，无需 API Key |
| Mock | 无 AI 配置时自动降级 |

自动探测、优先级回退、上下文窗口动态适配。

### 🛡️ Guard — 代码合规

- **正则 + AST 语义规则**（mustCallThrough、mustNotUseInContext、mustConformToProtocol）
- **3 级范围**：文件 / Target / 项目
- **CI/CD 就绪**：`asd guard:ci` 带 Quality Gate，`asd guard:staged` 用于 pre-commit hook
- **规则学习**：从违规模式自动推荐规则（14 天效果跟踪）
- **反馈闭环**：Guard 违规 → Recipe 使用确认

### 📊 Dashboard（18 个视图）

通过 `asd ui` 启动的全功能 Web 管理面板：

- **知识管理** — Recipe 浏览、候选审核、批量操作
- **AI 对话** — ReAct 循环对话，54 个内部工具
- **知识图谱** — 可视化关系探查
- **Guard 面板** — 规则管理、违规追踪、合规报告
- **SPM / 模块探查** — 跨语言生态依赖分析
- **Wiki 生成** — 自动生成项目文档（含 Mermaid 图表）
- **冷启动进度** — 9 维度实时进度与时间预估
- **Skills 管理** — 浏览、创建和管理 Agent 技能
- **LLM 配置** — 可视化 AI Provider/Model/Key 配置

### 🔌 IDE 集成

#### MCP Server（16 个工具）

兼容所有 MCP 协议的 IDE（Cursor、VS Code Copilot、Qoder、Trae）：

```bash
# asd setup 自动配置
# 也可手动：asd setup:mcp
```

12 个 Agent 工具（搜索、知识、结构、图谱、Guard、提交、Skills、冷启动等）+ 4 个管理工具。

#### VS Code 插件

`asd setup` 自动安装。功能：

- **搜索并插入** — `Cmd+Shift+F5` 打开 QuickPick，代码预览，插入到光标位置
- **指令检测** — 保存时自动检测 `// as:s`、`// as:c`、`// as:a` 指令
- **CodeLens** — 指令行上方的内联操作按钮
- **Guard 审计** — 对文件或整个项目运行合规检查
- **创建候选** — 将选中的代码提交为知识候选
- **状态栏** — 实时 API 服务连接状态

#### Xcode 集成

- **文件监听** — `asd watch` 监控 `// as:` 指令
- **自动插入** — osascript 驱动的代码插入，保留 Undo 历史
- **头文件管理** — 自动 `#import`/`@import` 去重，感知 SPM 依赖关系
- **Snippet 同步** — 导出 Recipe 为原生 Xcode `.codesnippet` 文件

### 📝 文件指令

在源码注释中编写指令：

```objc
// as:s network request timeout    → 搜索并插入匹配的 Recipe
// as:c                            → 从周围代码创建候选
// as:c -c                         → 从剪贴板创建候选
// as:a                            → 对当前文件运行 Guard 审计
// as:include "MyHeader.h"         → ObjC 头文件导入
// as:import UIKit                 → 模块导入
```

### 🧬 AST 分析（9 种语言）

Tree-sitter 驱动的代码智能分析：

| 语言 | 分析能力 |
|------|---------|
| Objective-C、Swift | 完整：类、协议、分类、扩展、设计模式检测 |
| TypeScript、JavaScript、TSX | 类、函数、React 组件、导入 |
| Python | 类、函数、装饰器、导入 |
| Java、Kotlin | 类、接口、注解 |
| Go | 结构体、接口、函数 |

另有 11 个框架增强包（React、Vue、Spring、Django、FastAPI、gRPC、Android 等）。

### 🏛️ Constitution 权限治理

三层权限模型：

1. **能力层** — `git push --dry-run` 探测写权限（物理信号）
2. **角色层** — 3 种角色（developer / external_agent / chat_agent）及权限矩阵
3. **治理层** — 4 条不可违反的规则，由 Constitution 引擎执行

每个写操作都经过 Gateway：角色验证 → 宪法规则检查 → 审计日志。

### 🧠 Agent 记忆（4 层架构）

| 层级 | 范围 | 持久化 | 用途 |
|------|------|--------|------|
| Working Memory | 会话级 | 否 | Scratchpad + 上下文压缩 |
| Episodic Memory | 跨维度 | 否 | Bootstrap 维度间的发现共享 |
| Project Semantic Memory | 项目级 | SQLite | 永久语义记忆（事实/洞察/偏好，含重要性评分 + TTL） |
| Tool Result Cache | 跨维度 | 否 | 工具调用结果去重 |

## CLI 命令参考

| 命令 | 说明 |
|------|------|
| `asd setup` | 初始化工作空间、数据库、IDE 配置，安装 VS Code 插件 |
| `asd coldstart` | 冷启动知识库（9 维度 AI 扫描） |
| `asd ais [target]` | AI 扫描源码 → 提取并发布 Recipe |
| `asd ui` | 启动 Dashboard + API 服务 |
| `asd watch` | 启动 Xcode 文件监听 |
| `asd search <query>` | 搜索知识库 |
| `asd guard <file>` | 运行 Guard 合规检查 |
| `asd guard:ci` | CI/CD 全项目 Guard + Quality Gate |
| `asd guard:staged` | 检查 git staged 文件（pre-commit hook） |
| `asd sync` | 同步 `recipes/*.md` → SQLite 数据库 |
| `asd upgrade` | 更新 IDE 集成（MCP、Skills、Rules） |
| `asd cursor-rules` | 生成 Cursor 4 通道交付物料 |
| `asd server` | 单独启动 API 服务 |
| `asd status` | 检查环境状态 |

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      IDE 接入层                          │
│  Cursor │ VS Code │ Trae │ Qoder │ Xcode │ Dashboard   │
└────────────────────────┬────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │   MCP Server (16)   │──── HTTP API (REST + WebSocket)
              └──────────┬──────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                      服务层                              │
│  SearchEngine │ KnowledgeService │ GuardEngine │ Chat   │
│  Bootstrap    │ WikiGenerator    │ Skills      │ SPM    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                      核心层                              │
│  AstAnalyzer (9 lang) │ KnowledgeGraph │ CodeEntityGraph│
│  RetrievalFunnel      │ QualityScorer  │ ConfidenceRouter│
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                    基础设施层                             │
│  SQLite │ VectorStore │ EventBus │ AuditLog │ Gateway   │
│  DI Container (40+ services) │ Constitution │ PathGuard │
└─────────────────────────────────────────────────────────┘
```

## 配置

### AI Provider 设置

在项目根目录创建 `.env`（或通过 Dashboard → LLM 配置界面设置）：

```env
# 选择一个或多个（支持回退）
ASD_GOOGLE_API_KEY=your-gemini-key
ASD_OPENAI_API_KEY=your-openai-key
ASD_CLAUDE_API_KEY=your-claude-key
ASD_DEEPSEEK_API_KEY=your-deepseek-key

# 使用本地 Ollama（无需 Key）
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3
```

### Setup 后的项目结构

```
your-project/
├── AutoSnippet/           # 核心数据（git 子仓库 = Source of Truth）
│   ├── constitution.yaml  # 权限规则
│   ├── recipes/           # 知识条目（Markdown）
│   ├── candidates/        # 待审核条目
│   └── skills/            # 项目特定 Skills
├── .autosnippet/          # 运行时缓存（gitignored）
│   ├── config.json        # 项目配置
│   ├── autosnippet.db     # SQLite 缓存
│   └── context/           # 向量索引缓存
├── .cursor/               # Cursor IDE 集成
│   ├── mcp.json
│   ├── rules/
│   └── skills/
└── .vscode/               # VS Code 集成
    ├── mcp.json           # MCP 服务配置
    └── extensions.json    # 推荐扩展
```

## 安全

- **PathGuard**：两层边界防护 — 阻止项目根目录外的写操作 + 白名单路径限制
- **Constitution**：4 条不可违反的规则在每次写操作时强制执行
- **审计追踪**：完整审计日志，90 天 TTL 自动清理
- **postinstall 无外部调用**：构建脚本纯本地执行（macOS Swift 编译）
- **Gateway**：每次数据变更都经过角色验证 → 宪法检查 → 审计日志

## 系统要求

- **Node.js** ≥ 20.0.0
- **macOS**（推荐，Xcode 集成必需；其他平台可使用除 Xcode 外的所有功能）
- **SQLite** 通过 better-sqlite3（已内置）

## 贡献

欢迎贡献。请确保：

1. 提交前运行 `npm test`
2. 遵循现有代码模式（ESM、领域驱动结构）
3. Guard 规则和知识条目需经过标准审核流程

## 许可证

[MIT](LICENSE) © gaoxuefeng
