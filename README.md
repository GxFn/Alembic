<div align="center">

# AutoSnippet

**Project Knowledge Engine for iOS / Swift Teams**

将团队的代码模式、最佳实践沉淀为 AI 可检索的知识库，<br>
让 Cursor、Trae、Copilot、Qoder 和 Xcode 都按你的项目规范生成代码。

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

</div>

---

## 为什么需要 AutoSnippet？

AI 编码助手生成的代码往往脱离项目上下文——不知道团队约定、不了解架构模式、也不遵守代码规范。AutoSnippet 在你的项目中建立一个**活的知识库**，让所有 AI 工具都能检索并遵循团队沉淀的最佳实践。

```
你的项目代码  ──→  AI 扫描提取  ──→  人工审核  ──→  知识库 (Recipe)
                                                        │
                ┌───────────────────────────────────────┘
                ↓
        Cursor / Trae / Copilot / Qoder / Xcode  ──→  按规范生成代码
```

## 核心概念

| 概念 | 说明 |
|------|------|
| **Recipe** | 知识库的基本单元——一段代码模式 + 使用说明 + 元数据，以 Markdown 文件（`AutoSnippet/recipes/*.md`）为 Source of Truth，SQLite 作为检索缓存 |
| **Candidate** | 待审核的候选知识——来自 AI 扫描、手动提交、剪贴板或 Bootstrap 冷启动，经 Dashboard 人工审核后晋升为 Recipe |
| **Dashboard** | Web 管理后台（`asd ui`），10+ 功能视图：Recipes / Candidates / Knowledge / AI Chat / SPM Explorer / 知识图谱 / 依赖图 / Guard / Skills / Xcode 模拟器 / Help |
| **Guard** | 代码审查引擎——基于知识库中的规则对代码做合规检查，支持文件 / Target / 项目三级范围 |
| **Skills** | 13 个 Agent 技能包——覆盖候选生成、冷启动、Guard 审计、意图路由、生命周期管理等场景，支持 Cursor 和 Qoder |
| **Bootstrap** | 冷启动引擎——自动扫描 SPM Target + AST 分析，9 维度启发式提取代码模式，AI 精炼后生成 Candidate；支持增量模式（IncrementalBootstrap），文件变更检测 + 受影响维度重跑 |
| **Agent Memory** | 四层记忆架构——WorkingMemory（会话级）→ EpisodicMemory（跨维度共享）→ ProjectSemanticMemory（项目级永久语义记忆）→ ToolResultCache（工具结果去重），支撑 Bootstrap 和 ChatAgent 的跨对话知识积累 |
| **ChatAgent** | 多 Agent 协作对话系统（Analyst + Producer），支持项目感知、信心信号、组合工具链和跨对话记忆 |
| **CodeEntityGraph** | 代码实体关系图谱——基于 AST 解析构建 class / protocol / category / module 间的继承、遵循、依赖、数据流等关系，供 Bootstrap 和搜索使用 |

## 快速开始

```bash
# 1. 全局安装
npm install -g autosnippet

# 2. 在你的项目目录初始化
cd /path/to/your-project
asd setup          # 创建 AutoSnippet/ 目录，配置 VSCode / Cursor / Qoder

# 3. 安装 IDE 集成（Skills + MCP + Cursor Rules）
asd install:full

# 4. 启动 Dashboard
asd ui             # 启动 Web 后台 + 文件监听 + 语义索引

# 5. 检查环境状态
asd status         # 自检项目根、AI Provider、索引、Dashboard
```

> **注意**：始终在**你的项目目录**中执行 `asd` 命令，而非 AutoSnippet 源码仓库。

## 工作流

### 端到端使用流程

从零开始到知识库持续运转的完整路径——以 Cursor 为例：

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ ① 初始化     │──→│ ② 冷启动    │──→│ ③ 逐Target  │──→│ ④ 审核发布   │──→│ ⑤ 注入 IDE  │
│  asd setup  │   │  Bootstrap  │   │    扫描      │   │  Dashboard  │   │   Cursor    │
└─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                                               │
       ┌───────────────────────────────────────────────────────────────────────┘
       ↓
┌─────────────┐   ┌─────────────┐
│ ⑥ AI 按      │──→│ ⑦ 新模式    │──→ 回到 ③
│  规范生成     │   │   再沉淀     │
└─────────────┘   └─────────────┘
```

**① 初始化项目**

```bash
cd /path/to/your-project
asd setup                # 创建 AutoSnippet/ 目录、数据库、配置文件
asd install:full         # 安装 Cursor Skills (13个) + MCP 配置 + Cursor Rules
asd ui                   # 启动 Dashboard + API 服务 + 文件监听
```

完成后，你的项目目录下会生成 `.cursor/mcp.json`、`.cursor/skills/`、`.cursor/rules/` 等集成文件，Cursor 已经可以通过 MCP 与 AutoSnippet 通信。

**② 冷启动——全局扫描建立基线**

在 Cursor 中用自然语言触发冷启动：

```
你：「对项目做一次全量冷启动，提取所有代码模式」
```

Bootstrap 引擎自动完成：SPM Target 发现 → 文件收集 → AST 结构分析 → 9 维度启发式扫描（架构 / 命名 / 网络 / 数据流 / 错误处理等） → Analyst Agent 深度分析 → Producer Agent 格式化提交。

冷启动结束后，Dashboard Candidates 页面会出现数十条候选知识条目。

**③ 逐 Target 精细扫描**

冷启动覆盖全局，但每个 Target 的独特模式需要针对性提取：

```
你：「扫描 NetworkModule 这个 Target，把里面的请求封装模式提取出来」
你：「分析 UIComponents Target 的自定义控件实现」
```

Cursor 调用 `get_targets` → `get_target_files` → 逐文件 AI 分析 → `submit_knowledge_batch`，将发现的代码模式作为 Candidate 提交到知识库。你可以逐个 Target 推进，每个 Target 的扫描结果会独立进入审核队列。

**④ 审核发布——人工把关质量**

打开 Dashboard（`asd ui`），进入 **Candidates** 页面：

- 候选按置信度排序，高信心的排在前面
- 点击候选卡片展开详情：查看代码片段、AI 分析理由、来源文件
- **接受** → 候选晋升为 Recipe，进入活跃知识库
- **编辑后接受** → 审核时可修改标题、描述、代码、标签
- **拒绝** → 低质量或重复的候选直接归档

批量操作：一键接受所有高信心候选，或一键拒绝低质量条目。

**⑤ 注入 Cursor——知识即规则**

Recipe 发布后，Cursor 立即可以通过三种通道获取知识：

| 通道 | 机制 | 时效 |
|------|------|------|
| **MCP 工具检索** | Cursor 通过 `autosnippet_search` 等 38 个工具实时查询知识库 | 实时 |
| **Cursor Rules** | `asd upgrade` 将 Recipe 导出为 `.cursor/rules/autosnippet-*.mdc` 文件 | 手动触发 |
| **Agent Skills** | 13 个 Skill 文档引导 Cursor 在正确场景自动调用知识库 | 常驻 |

**⑥ AI 按规范生成代码**

当你在 Cursor 中编写代码时，AI 会自动检索知识库：

```
你：「写一个网络请求方法，获取用户信息」
Cursor → 检索知识库 → 命中 Recipe: "Network Layer Pattern"
     → 按团队封装的 NetworkManager 生成代码，而非裸调 URLSession
```

Guard 规则也在同步工作——如果生成的代码违反了知识库中的规则（如 `kind=rule` 的条目），会实时提醒和纠正。

**⑦ 持续沉淀——知识库越用越好**

日常开发中发现新的代码模式或团队约定？随时沉淀：

- 在 Cursor 中：`「把这段 error handling 模式提取为知识库条目」`
- 在 Xcode 中：代码注释写 `// as:create` 然后 `⌘S`
- 在 Dashboard 中：AI Chat 对话式提交
- 通过剪贴板：复制代码后自动检测并建议入库

知识库形成飞轮：**代码沉淀 → Recipe 增长 → AI 生成质量提升 → 团队效率提高 → 更多代码模式沉淀**。

## Dashboard

`asd ui` 启动后访问 Web 管理后台：

![Dashboard](./resources/ASImage02.png)

**功能视图**：

| 视图 | 说明 |
|------|------|
| **Recipes** | 浏览、编辑、发布、弃用知识条目；详情抽屉支持 Markdown 编辑与关联关系管理 |
| **Candidates** | 审核 AI / 手动提交的候选，一键入库或批量操作，支持 AI 润色 |
| **Knowledge** | 统一知识条目浏览（V3 格式），双列卡片布局，代码预览 + 详情抽屉 |
| **AI Chat** | ChatAgent 智能对话（Analyst 分析 + Producer 生产），项目感知 + 四层记忆架构 |
| **SPM Explorer** | SPM Target 浏览与扫描，候选 vs Recipe 对比抽屉，头文件编辑 |
| **Dep Graph** | 依赖关系图可视化 |
| **Knowledge Graph** | Recipe 关联关系的知识图谱可视化（依赖 / 扩展 / 冲突等），AI 自动发现关系，按 category 分组 |
| **Guard** | 代码合规审查，查看违规记录与修复建议 |
| **Skills** | 浏览与管理 Agent Skill 文档 |
| **Xcode Simulator** | 在浏览器中模拟 `as:search` / `as:create` / `as:audit` 指令 |
| **Help** | 使用帮助与快捷键参考 |

**辅助功能**：全局搜索面板、LLM 配置弹窗、Bootstrap 进度视图、实时 WebSocket 更新。

## IDE 集成

### Cursor（推荐）

AutoSnippet 为 Cursor 提供完整的 MCP + Skills 集成：

- **38 个 MCP 工具**：搜索（4 种模式）、Guard 检查、候选提交 / 校验 / 查重、知识图谱查询、Bootstrap 冷启动、Skills 管理、知识生命周期等
- **13 个 Agent Skills**：`autosnippet-candidates`、`autosnippet-guard`、`autosnippet-coldstart`、`autosnippet-intent` 等，引导 AI 正确使用工具
- **写操作 Gateway 保护**：11 个写操作经过权限 / 宪法 / 审计三重检查

```bash
asd install:cursor-skill --mcp  # 安装 Skills + MCP 配置
```

### Qoder

AutoSnippet 对 Qoder 的支持通过镜像 Cursor 交付物料到 `.qoder/`：

- **Skills**（`.qoder/skills/`）：与 `.cursor/skills/` 相同的 Agent Skills
- **Rules**（`.qoder/rules/*.md`）：从 `.cursor/rules/*.mdc` 自动转换为标准 Markdown
- **MCP**：不支持项目级 `.qoder/mcp.json`，需通过 Qoder IDE 界面 Your Settings → MCP → "+ Add" 配置。

### Trae

AutoSnippet 对 Trae 的支持通过镜像 Cursor 交付物料到 `.trae/`：

- **Skills**（`.trae/skills/`）：与 `.cursor/skills/` 相同的 Agent Skills
- **Rules**（`.trae/rules/*.md`）：从 `.cursor/rules/*.mdc` 自动转换为标准 Markdown
- **MCP**：不支持项目级 `.trae/mcp.json`，需通过 Trae IDE 界面 设置 → MCP → "+ 添加" 手动配置。

### VSCode Copilot

```bash
asd install:vscode-copilot      # 配置 MCP 和 Copilot 指令
```

### Xcode

通过 Xcode Code Snippet 触发：

| 触发关键词 | 作用 |
|-----------|------|
| `ass` | 搜索知识库并插入代码（最快捷的联想方式） |
| `asc` | 创建候选——打开 Dashboard 或从剪贴板静默提交 |
| `asa` | 按知识库审查当前代码 |

> 执行 `asd setup` 注册 Snippet 后，需**重启 Xcode** 才生效。

## CLI 命令参考

| 命令 | 说明 | 常用选项 |
|------|------|----------|
| `asd setup` | 初始化项目（创建 AutoSnippet/ 目录和配置） | `--force`、`--seed` |
| `asd ui` | 启动 Dashboard + API 服务 | `-p <port>`、`-b`（浏览器）、`--api-only` |
| `asd status` | 环境自检（项目根、AI、索引、Dashboard 状态） | — |
| `asd ais [target]` | AI 扫描 Target → 生成 Candidates | `-m <max-files>`、`--dry-run`、`--json` |
| `asd search <query>` | 搜索知识库 | `-t <type>`、`-m <mode>`（keyword/bm25/semantic）、`-l <limit>` |
| `asd guard <file>` | 对文件运行 Guard 规则检查 | `-s <scope>`（file/target/project）、`--json` |
| `asd watch` | 启动文件监控（`as:c` / `as:s` / `as:a` 指令） | `-e <exts>`、`--guard` |
| `asd server` | 单独启动 API 服务器 | `-p <port>`、`-H <host>` |
| `asd sync` | 增量同步 `recipes/*.md` → DB（Markdown = Source of Truth） | `--dry-run`、`--force` |
| `asd upgrade` | 升级 IDE 集成（MCP / Skills / Cursor Rules） | `--skills-only`、`--mcp-only` |
| `asd install:full` | 全量安装（Skills + MCP + Native UI + Cursor Rules） | — |

## MCP 工具一览

39 个 MCP 工具按功能分组（省略了 **autosnippet_** 前缀）：

| 分类 | 工具 |
|------|------|
| **系统** | `health`、`capabilities` |
| **搜索** | `search`（统合入口）、`context_search`（4 层漏斗）、`keyword_search`、`semantic_search` |
| **Recipe 浏览** | `list_recipes`、`get_recipe`、`list_rules`、`patterns`、`list_facts`、`recipe_insights`、`confirm_usage` |
| **候选管理** | `validate_candidate`、`check_duplicate`、`submit_knowledge`、`submit_knowledge_batch`、`enrich_candidates` |
| **开发文档** | `save_document` |
| **知识图谱** | `graph_query`、`graph_impact`、`graph_path`、`graph_stats` |
| **项目结构** | `get_targets`、`get_target_files`、`get_target_metadata` |
| **Guard** | `guard_check`、`guard_audit_files`、`scan_project` |
| **冷启动** | `bootstrap_knowledge`、`bootstrap_refine` |
| **Skills** | `list_skills`、`load_skill`、`create_skill`、`delete_skill`、`update_skill`、`suggest_skills` |
| **知识管理** | `knowledge_lifecycle`、`compliance_report` |

## 配置

### AI Provider

在项目根目录创建 `.env` 文件（参考 `.env.example`）：

```env
ASD_AI_PROVIDER=gemini          # gemini / openai / anthropic
ASD_GOOGLE_API_KEY=your-key     # Gemini API Key
# ASD_OPENAI_API_KEY=your-key   # OpenAI API Key
# ASD_ANTHROPIC_API_KEY=your-key # Claude API Key
```

支持的 AI Provider：**Gemini**（推荐）、**OpenAI**、**Claude (Anthropic)**。

### 项目目录结构

```
your-project/
├── AutoSnippet/              # 知识库目录（建议整体作为 Git 子仓库）
│   ├── recipes/              # Recipe Markdown 导出（Source of Truth）
│   ├── skills/               # 项目级 Agent Skills
│   └── .autosnippet/         # 数据库、索引、Guard 配置等
├── .trae/
│   ├── rules/                # Trae Rules（从 .cursor/rules/ 镜像）
│   └── skills/               # Trae Skills（从 .cursor/skills/ 镜像）
├── .qoder/
│   ├── rules/                # Qoder Rules（从 .cursor/rules/ 镜像）
│   └── skills/               # Qoder Skills（从 .cursor/skills/ 镜像）
├── .cursor/
│   ├── mcp.json              # MCP 配置（asd setup 自动生成）
│   ├── rules/                # Cursor Rules（asd install 生成）
│   └── skills/               # Agent Skills（asd install 生成）
├── .vscode/
│   └── settings.json         # VSCode MCP 配置
└── .env                      # AI Provider 配置
```

### Git 策略建议

| 路径 | 建议 |
|------|------|
| `AutoSnippet/` | **整体作为 Git 子仓库**——独立权限控制，写权限探针（`git push --dry-run`）在此目录执行，仅知识管理员可 push |
| `AutoSnippet/.autosnippet/context/index/` | 加入 `.gitignore`——体积大、机器相关 |

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│  IDE Layer                                               │
│  Cursor (Skills + MCP) │ Qoder (Skills + Rules) │ Trae (Skills + Rules + MCP) │ VSCode (Copilot) │ Xcode        │
└────────────┬────────────────────┬─────────────────────────┘
             │ MCP (stdio)        │ HTTP API
┌────────────┴────────────────────┴─────────────────────────┐
│  AutoSnippet Core                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Gateway  │ │ ChatAgent│ │ Bootstrap│ │  Dashboard  │  │
│  │ (权限/   │ │ (Dual    │ │ (Incremen│ │  (React 19 +│  │
│  │  宪法/   │ │  Agent + │ │  tal +   │ │   Vite 6 +  │  │
│  │  审计)   │ │  Memory) │ │  AST+AI) │ │   Tailwind) │  │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Agent Memory (4-Tier):                            │   │
│  │  WorkingMemory → EpisodicMemory →                  │   │
│  │  ProjectSemanticMemory → ToolResultCache           │   │
│  └────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────┐   │
│  │  14 Services: Recipe │ Candidate │ Guard │ Search  │   │
│  │  Knowledge Graph │ SPM │ Bootstrap │ Chat │ Skills  │   │
│  │  Quality │ Context │ Automation │ Snippet │ Cursor  │   │
│  └────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Core: Gateway │ Constitution │ Permission │ AST   │   │
│  │  Session │ Capability │ CodeEntityGraph             │   │
│  └────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Storage: SQLite (better-sqlite3) + 向量索引       │   │
│  │  Search: InvertedIndex → CoarseRanker →            │   │
│  │          MultiSignalRanker → RetrievalFunnel       │   │
│  └────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **Runtime** | Node.js ≥ 20，ESM |
| **后端** | Express + better-sqlite3 + MCP SDK + Socket.IO |
| **前端** | React 19 + TypeScript 5 + Vite 6 + Tailwind CSS 4 |
| **AI** | Gemini / OpenAI / Claude（通过 AiProvider 抽象层） |
| **AST** | Tree-sitter（Swift / ObjC） |
| **搜索** | 5 层检索管线：InvertedIndex → Semantic Rerank → CoarseRanker (E-E-A-T) → MultiSignalRanker → RetrievalFunnel |
| **实时通信** | WebSocket（Socket.IO），Dashboard 实时更新 |
| **动画** | Framer Motion |
| **代码高亮** | Prism.js + react-syntax-highlighter |

## Xcode 深度集成

AutoSnippet 不依赖 Xcode 插件，通过 **AppleScript + FileWatcher + 原生 macOS UI** 实现深度集成。

| 能力 | 说明 |
|------|------|
| **保存即触发** | FileWatcher 监听源码目录；在代码中写入 `// as:search`、`// as:create`、`// as:audit` 后按 `⌘S`，自动执行对应操作 |
| **AppleScript 自动化** | 通过 `osascript` 驱动 Xcode——行号跳转、行选中、剪切/粘贴替换、前台检测；搜索结果直接替换触发行 |
| **原生 macOS UI** | Swift 原生弹窗展示搜索结果列表（降级为 AppleScript `choose from list`）；系统通知反馈操作结果 |
| **智能 import 注入** | 插入代码时自动分析所需 `import`，检查 SPM 模块可达性，确认后通过 AppleScript 注入头文件 |
| **三层防误触** | Self-write 冷却 + 内容哈希去重 + Xcode 焦点检测，区分手动保存与自动保存 |
| **Code Snippet** | `ass`（搜索插入）、`asc`（创建候选）、`asa`（代码审查），`asd setup` 注册后重启 Xcode 生效 |

## 开发

```bash
# 克隆仓库
git clone https://github.com/GxFn/AutoSnippet.git
cd AutoSnippet
npm install

# 链接开发版到全局
npm run dev:link

# 运行测试
npm test                    # 全部测试
npm run test:unit           # 单元测试
npm run test:integration    # 集成测试
npm run test:e2e            # 端到端测试
npm run test:coverage       # 覆盖率报告

# 构建 Dashboard
npm run build:dashboard

# 发布
npm run release:check       # 发布前检查
npm run release:patch       # 补丁版本
```

## 贡献

欢迎 [Issue](https://github.com/GxFn/AutoSnippet/issues) 与 [PR](https://github.com/GxFn/AutoSnippet/pulls)。

## License

[MIT](LICENSE)
