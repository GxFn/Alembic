<div align="center">

# AutoSnippet

将代码库中的模式提取为知识库，供 IDE 中的 AI 编码助手查询——让生成的代码真正符合你们团队的规范。

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen?style=flat-square)](https://nodejs.org)

[English](README.md)

</div>

---

## 为什么需要它

Copilot 和 Cursor 不知道你们团队怎么写代码。它们生成的东西能跑，但不像你们写的——命名不对、模式不对、抽象层次不对。最后要么你重写 AI 的输出，要么在每次 Code Review 里反复解释同样的规范。

AutoSnippet 解决这个问题。它扫描你的代码库，提取有价值的模式（需要你批准），然后通过 [MCP](https://modelcontextprotocol.io/) 让所有 AI 工具都能查到。下次 Cursor 生成代码时，它真的会按你的规范来。

```
你的代码  →  AI 提取模式  →  你来审核  →  知识库
                                           ↓
                             Cursor / Copilot / VS Code / Xcode
                                           ↓
                                   AI 按你的模式生成
```

## 开始使用

```bash
npm install -g autosnippet

cd your-project
asd setup        # 初始化工作空间 + 数据库 + IDE 配置 (Cursor, VS Code, Trae, Qoder)
asd coldstart    # 扫描代码，生成候选模式
asd ui           # 打开 Dashboard 审核扫描结果
```

就这样。审核通过的候选会变成 **Recipe** —— 结构化的知识条目，IDE 里的 AI 可以实时查询。

## 工作流

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  ① 初始化   │──→ │ ② 冷启动   │──→ │ ③ 精细扫描  │──→ │ ④ 审核    │──→ │ ⑤ IDE 交付  │
│  asd setup │    │ coldstart  │    │  asd ais   │    │ Dashboard  │    │            │
└────────────┘    └────────────┘    └────────────┘    └────────────┘    └─────┬──────┘
                                                                              │
      ┌───────────────────────────────────────────────────────────────────────┘
      ↓
┌────────────┐    ┌────────────┐
│ ⑥ AI 按    │──→ │ ⑦ 新模式    │──→  回到 ③
│ 规范生成    │    │  再沉淀     │
└────────────┘    └────────────┘
```

整个流程是个循环：

1. **`asd setup`** — 创建工作空间、SQLite 数据库、各 IDE 的 MCP 配置，安装 VS Code 扩展。
2. **`asd coldstart`** — 从多个角度扫描代码库（架构、命名、错误处理等），生成 **Candidate** —— 等你审核的模式草稿。
3. **在 Dashboard 审核** — 通过、编辑、或者拒绝。通过的就变成 Recipe。
4. **IDE 自动获取** — 通过 MCP、Cursor Rules 或 Agent Skills。AI 生成代码前会先查你的 Recipe。
5. **持续迭代** — 写了新代码再扫描一次。知识库随项目一起成长。

也可以用 `asd ais <target>` 扫描特定模块。更推荐的方式是在 Cursor 里直接用自然语言描述你想要提取的模式，AI 会自动调用知识库完成扫描和提交。

## 双管线 — 内部 Agent & 外部 Agent

所有核心能力都通过两条完全独立的管线实现。选适合你的那条，或两条都用：

| 核心能力 | 内部 Agent（内置 AI） | 外部 Agent（IDE 驱动） |
|---|---|---|
| **冷启动** | Analyst/Producer 双 Agent 自动扫描 | IDE Agent 读 Mission Briefing + MCP 工具 |
| **知识提取** | `asd ais` → 内置 AI 管线 | Cursor/Copilot 调用 `submit_with_check` |
| **Project Skill** | 从分析文本自动生成 | IDE Agent 调用 `autosnippet_skill(create)` |
| **Repo Wiki** | 冷启动结束时自动生成 | IDE Agent 调用 Wiki MCP 工具 |
| **Guard** | 内置规则引擎（无需 AI） | 同上 — 共享基础设施 |
| **搜索与检索** | MCP Server 返回结果 | 同上 — 共享基础设施 |
| **需要** | AI Provider API Key | 支持 Agent 能力的 IDE |

如果完全没有 AI，规则化降级仍能从 AST 和 Guard 数据中提取基础知识。

> **LLM 质量直接影响产出效果。** 能力更强的模型（Claude Opus/Sonnet、GPT-4o、Gemini 2.5 Pro）产出更准确的模式、更丰富的架构洞察、更少的误报。

## 都有什么

**模式提取** — AI 读你的代码，识别可复用的模式，结构化为 Recipe（代码 + 说明 + 元数据 + 使用指南）。支持 ObjC、Swift、TypeScript、JavaScript、Python、Java、Kotlin、Go、Ruby，共 9 种语言（Tree-sitter AST）。

**搜索** — BM25 关键词匹配 → 语义重排 → 质量评分 → 多信号排序。中英文都行。

**Guard** — 基于 Recipe 衍生出的正则 + AST 合规规则。可以检查文件、模块、整个项目。`asd guard:ci` 接 CI，`asd guard:staged` 接 pre-commit hook。

**Dashboard** — Web 管理界面（`asd ui`）：Recipe 浏览、Candidate 审核、AI 对话、知识图谱、Guard 报告、模块探查、项目 Wiki 生成、LLM 配置，都在里面。

**IDE 集成** — MCP Server（Cursor、VS Code、Qoder、Trae 通用）、VS Code 扩展（搜索、指令、CodeLens、Guard）、Xcode 支持（文件监听、自动插入、Snippet 同步）。

**AI Provider** — Google Gemini、OpenAI、Claude、DeepSeek、Ollama（本地），Provider 间自动 fallback。不配 AI 也能用——知识库本身不依赖它。

## 持久化约定与上下文

TaskGraph 把团队约定和任务状态存在 `.autosnippet/autosnippet.db` 里——AI 助手不会每次对话都从零开始。

- **`autosnippet_task`** — 统一任务与决策管理：`prime` 加载活跃约定和待办任务到上下文；`record_decision` / `revise_decision` / `unpin_decision` 保存团队共识；`create` / `claim` / `close` / `fail` / `defer` / `progress` / `decompose` 管理任务。
- **自动注入** — 后续每次工具调用自动携带活跃约定。

通过 CLI `asd task`、MCP 工具 `autosnippet_task`、或 VS Code Agent Mode 里的 `#asd` 使用。

## IDE 支持

| IDE | 集成方式 | 接入说明 |
|-----|---------|----------|
| **VS Code** | 扩展 + MCP | Agent Mode 中 `#asd` 引用工具；搜索、指令、CodeLens、Guard |
| **Cursor** | MCP + Rules | `.cursor/mcp.json` + `.cursor/rules/` |
| **Claude Code** | MCP + CLAUDE.md | `CLAUDE.md` + MCP 工具；支持 hooks |
| **Trae / Qoder** | MCP | `asd setup` 自动生成 |
| **Xcode** | 文件监听 | `asd watch` + 文件指令 + Snippet 同步 |
| **飞书 (Lark)** | Bot + WebSocket | 手机发消息 → IDE 通过 Copilot Agent Mode 执行 |

所有配置由 `asd setup` 自动生成。更新后运行 `asd upgrade` 刷新。

## 文件指令

在任意源码文件里写：

```
// as:s network timeout       搜索 Recipe 并插入匹配结果
// as:c                       从周围代码创建候选
// as:a                       对当前文件运行 Guard 审计
```

VS Code 扩展和 `asd watch`（Xcode）会自动识别。

## CLI

| 命令 | 说明 |
|------|------|
| `asd setup` | 初始化工作空间、数据库、IDE 配置 |
| `asd coldstart` | 全量扫描 → 候选 |
| `asd ais [target]` | 扫描特定模块 |
| `asd ui` | Dashboard + API 服务 |
| `asd search <query>` | 搜索知识库 |
| `asd guard <file>` | 合规检查 |
| `asd guard:ci` | CI 模式 + Quality Gate |
| `asd guard:staged` | Pre-commit hook |
| `asd watch` | Xcode 文件监听 |
| `asd sync` | Recipe Markdown → 数据库同步 |
| `asd task` | 任务管理（TaskGraph） |
| `asd upgrade` | 更新 IDE 集成 |
| `asd status` | 环境检查 |

## 项目结构

`asd setup` 之后，你的项目里会多出这些：

```
your-project/
├── AutoSnippet/           # 知识数据（git 跟踪）
│   ├── recipes/           # 已审核的模式（Markdown）
│   ├── candidates/        # 待审核
│   └── skills/            # 项目特定的 Agent 指令
├── .autosnippet/          # 运行时缓存（gitignored）
│   ├── autosnippet.db     # SQLite
│   └── context/           # 向量索引
├── .cursor/mcp.json       # Cursor MCP 配置
└── .vscode/mcp.json       # VS Code MCP 配置
```

Recipe 是 Markdown 文件。SQLite 只是读缓存。数据库坏了 `asd sync` 一下就行。

## 飞书远程编程

用手机写代码。在飞书发消息 → 注入 VS Code Copilot Agent Mode → 结果回传飞书。任务通知会附带 IDE 窗口截图。

```
手机 (飞书)  →  飞书云端 (WSS)  →  本地 API Server  →  VS Code  →  Copilot Agent Mode
    ↑                                                                      |
    └────────────────────────── 结果通知 + 截图 ──────────────────────────┘
```

系统命令：`/help` `/status` `/queue` `/cancel` `/clear` `/ping` `/screen`

详见 [飞书接入指南](docs/lark-integration.md)。

## 配置

在项目根目录放一个 `.env`，或者在 Dashboard → LLM 配置界面里设置：

```env
# 选一个就行（多个 = 自动 fallback）
ASD_GOOGLE_API_KEY=...
ASD_OPENAI_API_KEY=...
ASD_CLAUDE_API_KEY=...
ASD_DEEPSEEK_API_KEY=...

# 或者跑本地模型
ASD_AI_PROVIDER=ollama
ASD_AI_MODEL=llama3
```

## 架构

```
IDE 接入层      Cursor · VS Code · Trae · Qoder · Xcode · Dashboard
                                    │
                            MCP Server + HTTP API
                                    │
服务层          Search · Knowledge · Guard · Chat · Bootstrap · Wiki
                                    │
核心层          AST (9 lang) · KnowledgeGraph · RetrievalFunnel · QualityScorer
                                    │
基础设施        SQLite · VectorStore · EventBus · AuditLog · DI Container (40+)
```

## 系统要求

- Node.js ≥ 20
- macOS 推荐（Xcode 功能需要；其他功能跨平台可用）
- better-sqlite3（已内置）

## 贡献

1. 提交前跑 `npm test`
2. 遵循现有代码模式（ESM、领域驱动结构）

## License

[MIT](LICENSE) © gaoxuefeng
