<div align="center">

# AutoSnippet

将代码库中的模式提取为知识库，供 IDE 中的 AI 编码助手查询——让生成的代码真正符合你们团队的规范。

[![npm version](https://img.shields.io/npm/v/autosnippet.svg?style=flat-square)](https://www.npmjs.com/package/autosnippet)
[![License](https://img.shields.io/npm/l/autosnippet.svg?style=flat-square)](https://github.com/GxFn/AutoSnippet/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square)](https://nodejs.org)

[English](README.md)

</div>

---

- [为什么需要它](#为什么需要它) · [开始使用](#开始使用) · [在 IDE 中使用](#在-ide-中使用) · [进化架构](#进化架构) · [工程能力](#工程能力) · [IDE 支持](#ide-支持) · [深入了解](#深入了解)

## 为什么需要它

Copilot 和 Cursor 不知道你们团队怎么写代码。它们生成的东西能跑，但不像你们写的——命名不对、模式不对、抽象层次不对。最后要么你重写 AI 的输出，要么在每次 Code Review 里反复解释同样的规范。

AutoSnippet 建立一层**本地化的项目记忆**。它扫描你的代码库，提取有价值的模式（需要你批准），然后通过 [MCP](https://modelcontextprotocol.io/) 让所有 AI 工具都能查到。这些知识持久化在本地，不会占用 LLM 的上下文窗口，而是在 AI 需要时按需注入——项目知识积累得越多，生成的代码越符合你们的规范。

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
asd setup     # 初始化工作空间 + 数据库 + MCP 配置（自动检测 Cursor / VS Code / Trae / Qoder）
asd ui        # 启动后台服务（MCP Server + Dashboard），IDE 和 MCP 工具依赖此服务运行
```

> **Trae / Qoder 用户：** `asd setup` 后运行 `asd mirror`，将 `.cursor/` 配置同步到 `.trae/` / `.qoder/`。

## 在 IDE 中使用

`asd setup` 配置好了一切。打开 IDE 的 **Agent Mode**（Cursor Composer / VS Code Copilot Chat / Trae），跟 Agent 对话就行。

> **首次使用：** 需在 IDE 的 MCP 设置中手动开启 `autosnippet` 服务。

> **提示：** IDE Agent 使用的模型越强，效果越好。推荐在 Cursor / Copilot 中选择 Claude Opus 4.6 / Sonnet 4.6、GPT-5.4 或 Gemini 3.1 Pro，产出更准确的模式和更少的误报。

### 冷启动：建立项目知识库

> 💬 *"帮我冷启动，生成项目知识库"*

Agent 扫描整个项目，提取出团队的编码模式、架构约定、调用习惯，同时生成项目 Wiki。冷启动只做一次，之后就进入日常使用。

### 日常：说一句话就行

| 你说 | 你得到 |
|------|--------|
| ① *"项目里 API 接口怎么写"* | 直接拿到符合你们项目风格的代码，而不是通用示例 |
| ② *"帮我写一个用户注册接口"* | 生成的代码自动遵循刚才查到的 API 规范 |
| ③ *"检查这个文件符不符合项目规范"* | 提交前过一遍规范检查，减少 Code Review 里的反复沟通 |
| ④ *"把这段错误处理保存为项目规范"* | 一次沉淀，以后所有人的 AI 都会学会这个写法 |

Agent 写完代码后，Guard 合规引擎会自动检查 diff——发现违规即自我修复，不需要你手动介入。

### 越用越好

候选在 Dashboard（`asd ui`）中审核并批准 → 变成 **Recipe** → AI 生成代码时自动参照 → 你发现新的好写法 → 继续沉淀 → AI 越来越像团队的人。这些知识是本地 Markdown 文件，跟 git 走，不会随对话消失，也不占上下文窗口——知识库再大也不会拖慢 AI。

---

## 进化架构

AutoSnippet 不是静态知识工具，而是一个**知识有机体**。Recipe 是它的细胞——IDE Agent 是外部驱动力，每一次交互都会触发有机体内不同器官的协同响应。

```
                IDE Agent (Cursor / Copilot / Trae)
                   │
                   │ 沉淀 · 编写 · 搜索 · 偏移 · 完成 · 边界
                   │
  ═════════════════▼══════════════════════════════════════
  ║              AutoSnippet 知识有机体                    ║
  ║                                                       ║
  ║  ┌─ Panorama (骨骼) ────────── 项目结构全貌 ──────┐   ║
  ║  │                                                │   ║
  ║  │    Signal (神经)  ◄────►  Governance (消化)     │   ║
  ║  │        ↕                        ↕              │   ║
  ║  │              ┌──────────┐                      │   ║
  ║  │              │  Recipe  │                      │   ║
  ║  │              │ 知识生命体│                      │   ║
  ║  │              └──────────┘                      │   ║
  ║  │        ↕                        ↕              │   ║
  ║  │    Guard (免疫)    ◄────►  Tool Forge (造物)    │   ║
  ║  │                                                │   ║
  ║  └────────────────────────────────────────────────┘   ║
  ║                                                       ║
  ═════════════════════════════════════════════════════════
```

### Agent 行为 × 有机体响应

IDE Agent 的每个行为，都会触发有机体内不同器官的协同响应：

| Agent 行为 | 有机体响应 | 参与器官 |
|-----------|---------|---------|
| **沉淀知识** — 提取模式并提交 | 消化系统内部消化：置信度路由 → staging 观察 → 进化或衰退，开发者保留全程干预权 | 消化 → 神经 |
| **编写代码** — 开始写代码 | 神经系统分析意图，自动注入相关 Recipe，附带 sourceRefs 源码证据提升可信度 | 神经 → Recipe |
| **搜索知识** — 主动搜索 | 基于当前意图 + 文件上下文精准检索，多路融合排序，按场景动态调整权重 | 神经 → Recipe |
| **偏移意图** — 改变方向 | 神经系统记录偏移信号，感知问题，免疫系统反向检查 Recipe 是否仍然有效 | 神经 → 免疫 |
| **完成任务** — 写完代码 | 免疫系统触发 Guard Review，挂载相关 Recipe 给 Agent 修复违规 | 免疫 → Recipe |
| **能力边界** — 遇到无法处理的问题 | 造物系统调用 LLM 自建临时工具，vm 沙箱隔离执行，到期自动回收 | 造物 |

### 五大器官

**骨骼 — Panorama**

有机体的结构感知。AST + 调用图推断模块角色与分层（四信号融合，13 种角色类型），Tarjan SCC 计算耦合度，Kahn 拓扑排序推断分层，DimensionAnalyzer 生成 11 维健康雷达，输出覆盖率热力图和能力缺口报告。所有器官共享这份项目全貌。

**消化 — Governance**

新知识进入有机体后的代谢引擎。ContradictionDetector 检测矛盾，RedundancyAnalyzer 分析冗余，DecayDetector 评估衰退（6 策略 + 4 维评分），ConfidenceRouter 数值路由（≥ 0.85 自动发布，< 0.2 拒绝）。ProposalExecutor 到期自动执行进化提案（7 种类型，差异化观察窗口）。六态生命周期：`pending → staging → active → evolving/decaying → deprecated`。

**神经 — Signal + Intent**

感知 Agent 的所有行为。IntentExtractor 提取术语、推断语言和模块、中英文同义词展开，识别 4 种场景。SignalBus 统一 12 种信号类型（guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot），HitRecorder 批量采集使用事件。当 Agent 偏移意图时，神经系统记录漂移信号，协调免疫系统反向检查。

**免疫 — Guard**

双向免疫系统。正向：四层检测（正则 → 代码级多行 → tree-sitter AST → 跨文件），内置 8 语言规则，三态输出（pass / violation / uncertain）。反向：ReverseGuard 验证 Recipe 引用的 API 符号是否仍存在（5 种漂移类型）。Agent 完成任务时自动触发 Review，将违规连同相关 Recipe 一起交给 Agent 修复。RuleLearner 追踪 P/R/F1 自动调优。

**造物 — Tool Forge**

能力边界处的创造力。三种模式渐进——复用（0ms）→ 组合（10ms，原子工具拼装）→ 生成（~5s，LLM 写代码 → vm 沙箱验证：5s 超时 + 18 条安全规则）。临时工具 30min TTL，到期自动回收。LLM 只在锻造时参与，执行过程完全确定性。

### 设计哲学

1. **AI 编译期 + 工程运行期** — LLM 产出确定性执行物，运行期纯工程逻辑
2. **确定性标记 + 概率性消解** — 每层做确定的事，不确定结构化上抛给 AI
3. **正交组合 > 特化子类** — Capability × Strategy × Policy 替代 N 个子类
4. **信号驱动 > 时间驱动** — 信号饱和触发，而非定时扫描
5. **纵深防御** — Constitution → Gateway → Permission → SafetyPolicy → PathGuard → ConfidenceRouter

> 器官实现细节、工程数据、防御链详解见 [技术解构 Book](https://docs.gaoxuefeng.com/visual-tour)

---

## 工程能力

上面是有机体本身。下面是它对外提供的工程集成能力。

### Guard CLI

```bash
asd guard src/             # 检查目录
asd guard:staged           # pre-commit 只查暂存文件
asd guard:ci --min-score 90   # CI 质量门禁
```

### 多语言 AST

11 种语言 tree-sitter：Go · Python · Java · Kotlin · Swift · JS · TS · Rust · ObjC · Dart · C#。5 阶段 CallGraph，增量分析，8 种项目类型自动检测。

### 6 通道 IDE 交付

知识变更自动交付到 IDE 可消费的格式：

| 通道 | 路径 | 内容 |
|------|------|------|
| **A** | `.cursor/rules/autosnippet-project-rules.mdc` | alwaysApply 一行式规则 |
| **B** | `.cursor/rules/autosnippet-patterns-{topic}.mdc` | When/Do/Don't 主题规则 |
| **C · D** | `.cursor/skills/` | Project Skills + 开发文档 |
| **F** | `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` | Agent 指令 |
| **Mirror** | `.qoder/` / `.trae/` | IDE 镜像 |

### 更多

- **Bootstrap 冷启动** — 6 阶段 · 10 维分析，一次性建立知识库
- **知识图谱** — 14 种关联关系，查询影响路径和依赖深度
- **语义搜索** — HNSW 向量索引 + 加权字段匹配混合检索，RRF 融合 + 7 路信号排序
- **sourceRefs** — Recipe 携带源码证据，Agent 无需自行验证
- **飞书远程** — 手机发消息，意图识别分流到 Bot 或 IDE
- **远程仓库** — Recipe 目录转 git 子仓库，多项目共享

> AI 驱动功能需 LLM API Key。支持 Google / OpenAI / Claude / DeepSeek / Ollama，自动 fallback。

---

## 项目结构

`asd setup` 之后，你的项目里会多出这些：

```
your-project/
├── AutoSnippet/           # 知识数据（git 跟踪）
│   ├── recipes/           # 已审核的模式（Markdown）
│   ├── candidates/        # 待审核
│   ├── skills/            # 项目特定的 Agent 指令
│   └── wiki/              # 项目 Wiki
├── .autosnippet/          # 运行时缓存（gitignored）
│   ├── autosnippet.db     # SQLite（WAL 模式）
│   └── context/           # 向量索引（HNSW）
├── .cursor/
│   ├── mcp.json           # Cursor MCP 配置
│   ├── rules/             # Channel A + B 规则
│   └── skills/            # Channel C + D Skills
├── .vscode/mcp.json       # VS Code MCP 配置
├── .github/copilot-instructions.md
├── AGENTS.md
└── CLAUDE.md
```

Recipe 是 Markdown 文件，SQLite 只是读缓存。数据库坏了 `asd sync` 一下就行。

---

## IDE 支持

| IDE | 集成方式 | 接入说明 |
|-----|---------|----------|
| **VS Code** | 扩展 + MCP | Agent Mode 中 `#asd` 引用工具；搜索、指令、CodeLens、Guard 诊断波浪线、灯泡修复 |
| **Cursor** | MCP + Rules | `.cursor/mcp.json` + `.cursor/rules/` + `.cursor/skills/` |
| **Claude Code** | MCP + CLAUDE.md | `CLAUDE.md` + MCP 工具；支持 hooks |
| **Trae / Qoder** | MCP | `asd setup` 自动生成，`asd mirror` 同步配置 |
| **Xcode** | 文件监听 | `asd watch` + 文件指令 + Snippet 同步 |
| **飞书 (Lark)** | Bot + WebSocket | 手机发消息 → 意图识别 → Bot Agent 或 IDE Agent Mode 执行 |

### VS Code 扩展

- **Comment Directives**：`// as:s <query>` 搜索插入、`// as:c` 从选区创建候选、`// as:a` 审计当前文件
- **CodeLens**：指令上方可点击操作
- **Guard 诊断**：违规显示为波浪线 + 灯泡快速修复
- **Status Bar**：实时 API Server 连接状态

所有配置由 `asd setup` 自动生成。更新后运行 `asd upgrade` 刷新。

---

## 深入了解

> **[图解速览 — 5 分钟看懂整个系统](https://docs.gaoxuefeng.com/visual-tour)** · 24 张手绘架构图，从工作流到 Agent 循环一目了然

| 章节 | 内容 |
|------|------|
| [AutoSnippet 介绍](https://docs.gaoxuefeng.com/part1/ch01-introduction) | 问题定义、方案概述、使用速览 |
| [SOUL 原则](https://docs.gaoxuefeng.com/part1/ch02-soul) | 3 条硬约束 + 5 项设计哲学 |
| [架构全景](https://docs.gaoxuefeng.com/part2/ch03-architecture) | 7 层 DDD 分层与模块拓扑 |
| [安全管线](https://docs.gaoxuefeng.com/part2/ch04-security) | 六层纵深防御链路 |
| [代码理解](https://docs.gaoxuefeng.com/part2/ch05-ast) | 10 语言 Tree-sitter AST 分析 |
| [知识领域](https://docs.gaoxuefeng.com/part3/ch06-knowledge-entry) | 统一实体、生命周期、质量评分 |
| [核心服务](https://docs.gaoxuefeng.com/part4/ch09-bootstrap) | 冷启动、Guard、搜索、代谢 |
| [Agent 智能层](https://docs.gaoxuefeng.com/part5/ch13-agent-runtime) | ReAct 循环、正交组合、61+ 工具 |
| [平台与交付](https://docs.gaoxuefeng.com/part6/ch16-infrastructure) | 数据基础设施、MCP、四端接入 |
| [BiliDili 冷启动全记录](https://docs.gaoxuefeng.com/part7/ch19-bilidili-coldstart) | 真实数据：840 万 Token、101 候选 |

---

## 系统要求

- Node.js ≥ 22
- macOS 推荐（Xcode 功能需要；其他功能跨平台可用）
- better-sqlite3（已内置）

## 贡献

1. 提交前跑 `npm test`
2. 遵循现有代码模式（ESM、领域驱动结构）

## License

[MIT](LICENSE) © gaoxuefeng
