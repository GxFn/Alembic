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
asd setup → asd coldstart → Dashboard 审核 → IDE AI 消费 Recipe → 写新代码 → asd ais 再扫描 → 循环
```

1. **`asd setup`** — 创建工作空间、SQLite 数据库、各 IDE 的 MCP 配置，安装 VS Code 扩展。
2. **`asd coldstart`** — 多角度扫描代码库，生成 **Candidate**。
3. **Dashboard 审核** — 通过、编辑、拒绝。通过的变成 Recipe。
4. **IDE 自动获取** — 通过 MCP、Cursor Rules、Agent Skills，或由 TaskGraph 随任务注入上下文。
5. **持续迭代** — `asd ais <target>` 扫描特定模块，或在 Cursor 里用自然语言描述。

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

> **LLM 质量直接影响产出效果。** 能力更强的模型（Claude Opus 4 / Sonnet 4、GPT-5、Gemini 3 Pro）产出更准确的模式、更丰富的架构洞察、更少的误报。

## Dashboard

`asd ui` 启动 Dashboard，在一个界面管理所有功能：

<div align="center">
<img src="docs/images/dashboard-help.png" alt="Dashboard 使用说明" width="800" />
</div>

## 功能概览

| 功能 | 说明 |
|------|------|
| **模式提取** | AI 读代码 → 识别可复用模式 → 结构化为 Recipe。9 种语言（Tree-sitter AST） |
| **搜索** | BM25 关键词 → 语义重排 → 质量评分 → 多信号排序。中英文 |
| **Guard** | 正则 + AST 合规规则。`asd guard:ci` 接 CI，`asd guard:staged` 接 pre-commit |
| **调用图** | 8 种语言静态调用图分析。MCP `call_graph` + `call_context` 查询 |
| **TaskGraph** | DAG 任务编排 + tokenBudget 感知 + 团队约定持久化 |
| **AI Provider** | Gemini、OpenAI、Claude、DeepSeek、Ollama，自动 fallback |

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
IDE 接入层       Cursor · VS Code · Trae · Qoder · Xcode · Dashboard · 飞书
                                     │
                            MCP Server（22 工具）+ HTTP API
                                     │
Agent 层         AgentRouter → Preset → AgentRuntime（ReAct 循环）
                 ├── Strategy: Single / Pipeline / FanOut / Adaptive
                 ├── Capability: Conversation · CodeAnalysis · KnowledgeProduction · System
                 ├── Policy: Budget · Safety · QualityGate
                 └── Memory: ActiveContext → SessionStore → PersistentMemory
                                     │
服务层           Search · Knowledge · Guard · Chat · Bootstrap · Wiki · TaskGraph
                                     │
核心层           AST（9 lang）· CallGraph（8 lang）· KnowledgeGraph · RetrievalFunnel · QualityScorer
                                     │
基础设施         SQLite · VectorStore · EventBus · AuditLog · DI Container（40+）· ContextWindow
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
