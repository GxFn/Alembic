<div align="center">

# Alembic

把你的代码库蒸馏成知识库，供 AI 编码智能体在工作时随手查询——让生成的代码真正符合你们团队的规范。

[![npm version](https://img.shields.io/npm/v/alembic-ai.svg?style=flat-square)](https://www.npmjs.com/package/alembic-ai)
[![License](https://img.shields.io/npm/l/alembic-ai.svg?style=flat-square)](https://github.com/GxFn/Alembic/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square)](https://nodejs.org)

[English](README.md)

</div>

---

- [为什么需要它](#为什么需要它) · [安装](#安装) · [使用](#使用) · [Recipe 是什么](#recipe-是什么) · [知识生命体](#知识生命体) · [一个产品，五个仓库](#一个产品五个仓库) · [工程能力](#工程能力) · [Dashboard](#dashboard) · [项目结构](#项目结构) · [环境要求](#环境要求) · [深入了解](#深入了解)

## 为什么需要它

Codex 和 Claude Code 不知道你们团队怎么写代码。它们生成的东西能跑，但不像你们写的——命名不对、模式不对、抽象层次不对。最后要么你重写 AI 的输出，要么在每次 Code Review 里反复解释同样的规范。

Alembic 建立一层**本地化的项目记忆**。它把你的代码库蒸馏成经过审核、锚定源码的 **Recipe**，在编码智能体需要时通过 [MCP](https://modelcontextprotocol.io/) 按需回喂。知识以 Markdown 持久化在本地，不占用 LLM 上下文窗口；每条 Recipe 都带 `sourceRefs`——锚定真实文件的证据——智能体可以直接信任、无需自证。知识积累得越多，生成的代码越符合你们的规范。

```
你的代码  →  AI 挖掘模式  →  你来审核  →  Recipe 知识库
                                              ↓
                              Codex / Claude Code 按需查询
                                              ↓
                                      AI 按你的模式生成
```

**插件是入口，本身就是完整体验**：在 Codex / Claude Code 里初始化、查结构、生成并使用 Recipe——不需要 API Key。**完整版 Alembic 是可选增强**：配置 DeepSeek 等 provider，由专门的挖掘智能体把知识库生成得更深更好——再配一个 Dashboard 审核。两者共享同一套确定性知识契约——两个宿主，一个单源。

## 安装

### 插件——Codex / Claude Code（入口）

```bash
# Codex
codex plugin marketplace add GxFn/AlembicCodex --ref main

# Claude Code
claude plugin marketplace add GxFn/AlembicClaudeCode
claude plugin install alembic@gxfn
```

插件本身就是一份完整体验：结构问答开箱即用（`alembic_graph`——不需要知识库，也不需要 AI），冷启动、日常检索与规范体检全部在对话里完成。默认 Ghost 模式，仓库零文件，不需要 API Key。

### 完整版 Alembic——可选，为了更好的知识库

```bash
npm install -g alembic-ai

cd your-project
alembic setup --ghost
alembic start
```

完整版解锁专门的挖掘智能体 **AlembicAgent**：配置任意一家 provider——DeepSeek / OpenAI / Claude / Gemini / Ollama——它就在 daemon 任务里自主挖掘：冷启动、增量 rescan、深挖轮次、AI 扫描、演化检查。不占用你的编码智能体，挖得更深。另有 Dashboard 审核界面与 Guard pre-commit / CI 门。

## 使用

装好后，对智能体说一句：

> 💬 *「冷启动——构建项目知识库」*

插件会从真实项目事实起草挖掘计划，引导你的智能体逐维度蒸馏。装了完整版，也可以把同一件事交给专门的挖掘智能体，从 Dashboard 启动。

日常使用是对话，不是命令：

| 你说 | 你得到 |
|------|--------|
| ① *「这个项目的 API 端点怎么写？」* | 项目的真实规范，附源码证据 |
| ② *「写一个用户注册端点」* | 遵循刚检索到的规范生成——写前先预热 |
| ③ *「检查这个文件是否符合规范」* | 一次规范体检：违规、诚实的不确定项、修复建议 |
| ④ *「把这个错误处理模式存为项目规范」* | 一条接地的候选，全团队的 AI 都会学到 |

这些对话背后是四个动词——写前**预热**、随时**搜索**、收尾**体检**、值得的**沉淀**。结构问题（「谁依赖这个模块？」）也在同一场对话里，答案来自项目地图而不是猜测。维护不需要调度器：知识代谢搭在日常调用上自动进行——没有 cron，没有后台 daemon。

### 越用越好

在 Dashboard（`alembic start`）里审核候选 → 它们成为 **Recipe** → 智能体生成时引用 → 你发现新的好模式 → 继续沉淀。知识是本地 Markdown，随 git 走，不会随会话消失，也不占上下文窗口——知识库再大也不会拖慢 AI。

---

## Recipe 是什么

Recipe 是 Alembic 的知识单元——项目基础信息、设计模式、架构约定与团队 SOP 的**整合抽象**。每条 Recipe 把三层东西装订在一起：

| 层 | 里面是什么 |
|----|-----------|
| **模式与约定文本** | 语言描述的规范——什么时候适用、该怎么做、别怎么做。人和 AI 都读得懂 |
| **代码范式与真实指向** | 范式代码片段，加 `sourceRefs` 指向仓库里的真实文件——证据可回查，逐字探针保证片段与源码一致 |
| **运维数据** | 生命周期状态、置信与权威度、使用与新鲜度记录——随代码演化而更新、衰亡、弃用 |

所以 Recipe 不是文档摘抄，不是代码注释，也不是静态的百科条目。它是一个**活的知识单元**——可检索、可注入、可被规范体检引用、随时间新陈代谢——以 Markdown 存放，随 git 走。

---

## 知识生命体

Alembic 不是一个静态知识工具，而是一个**知识生命体**。Recipe 是它的细胞；编码智能体是外部驱动力；每次交互都会触发体内器官的协同响应。

```
        AI 编码智能体 (Codex / Claude Code)             Dashboard（你）
                  │                                        │
                  │  捕获 · 写码 · 搜索 ·                  │  审核 · 批准
                  │  收尾 · 演化                           │  演化 · 弃用
                  │                                        │
  ════════════════▼════════════════════════════════════════▼══════════
  ║                     Alembic 知识生命体                           ║
  ║                                                                  ║
  ║  ┌─ Panorama（骨骼）──── ProjectContext ──────────────────────┐  ║
  ║  │                                                            │  ║
  ║  │     Signal（神经）   ◄────►   Governance（消化）           │  ║
  ║  │         ↕                          ↕                       │  ║
  ║  │              ┌────────────────────────┐                    │  ║
  ║  │              │      Recipe 细胞       │                    │  ║
  ║  │              │  由 sourceRefs 接地    │                    │  ║
  ║  │              └────────────────────────┘                    │  ║
  ║  │         ↕                          ↕                       │  ║
  ║  │     Guard（免疫）    ◄────►   Agent Runtime（双手）        │  ║
  ║  │                                                            │  ║
  ║  └────────────────────────────────────────────────────────────┘  ║
  ══════════════════════════════════════════════════════════════════
```

### 智能体动作 × 生命体响应

| 智能体动作 | 生命体响应 | 涉及器官 |
|-----------|-----------|----------|
| **捕获知识**——提交一个模式 | 提交门禁校验结构与证据 → 置信路由 → staging 观察 → 演化或衰亡。你保留完全干预权 | 消化 |
| **写代码**——编码前预热 | 注入带源码证据的信任标注 Recipe，智能体在已验证的地基上构建 | 神经 → Recipe |
| **搜索知识**——提出问题 | 混合检索、融合排序、按场景加权 | 神经 → Recipe |
| **完成任务**——规范体检 | 免疫系统用已发布 Recipe 检查 diff；违规连同修复所需的 Recipe 一起返回 | 免疫 → Recipe |
| **决策演化**——发现漂移 | 按 Recipe 批量决策：提议演化、确认弃用、或刷新验证 | 消化 → 免疫 |
| **自主挖掘**——进程内任务 | 内嵌智能体在预算与安全策略约束下、在沙箱里执行选定维度 | 双手 |

### 五个器官

**骨骼——Panorama（ProjectContext）**

生命体的结构感知。11 个内置 tree-sitter 语法的多语言 AST、五段调用图流水线、Tarjan SCC 耦合检测、依赖深度分层、架构风格推断——以 空间 → 仓库 → 模块 → 文件 的查询阶梯暴露，带新鲜度标注。所有器官、两种宿主，共享这一张地图。

**消化——Governance（生命周期）**

新知识的代谢引擎。每次提交先过提交门禁，然后 ConfidenceRouter 数值路由——高置信自动进入快车道 staging 并带观察窗，低置信直接拒绝。六态生命周期——`pending → staging → active → evolving/decaying → deprecated`——由唯一的状态机守护；DecayDetector 从新鲜度、使用、质量、权威四个维度给衰亡打分；RedundancyAnalyzer 标记冗余；提案最终收敛为*更新*或*弃用*两种。代谢是**访问即扫描**：有上限的清扫搭在日常调用里，不需要任何调度器。

**神经——Signal**

感知层。统一的 SignalBus 承载十二个信号族——guard、search、usage、lifecycle、quality、exploration、panorama、decay 等——喂给生命周期与排序决策。检索用七个信号排序（相关度、权威、新近度、热度、难度、上下文匹配、向量），并按场景动态加权：改错、生成、搜索、学习。

**免疫——Guard**

规范免疫系统。四层检测——正则 → 代码级 → tree-sitter AST → 跨文件——内置十种语言的规则，同时报告违规*和*诚实的不确定项。学习器跟踪查准查全用于调优；排除管理器吸收误报。新鲜度免疫走反方向：源引用校对会验证 Recipe 引用的代码是否仍然存在，失效引用直接喂给衰亡。

**双手——Agent Runtime**

运动系统：一个 ReAct（思考 → 行动 → 观察）内核，配 profile 预设、编排策略，以及预算、安全、质量三类硬性策略。工具覆盖代码、终端、知识、图谱与记忆；终端执行位于只读白名单 + macOS Seatbelt 沙箱之后、降级必留审计，写文件有先读后写的新鲜度门。三层记忆与分级上下文压缩保证长任务的忠实。

### 设计哲学

1. **AI 编译期 + 工程运行时**——LLM 只在生成时思考，运行的是确定性工件
2. **确定性标记 + 概率性消解**——每一层做确定的事，把不确定结构化地上抛给 AI
3. **概率内核 + 确定外壳**——智能体自由思考，护栏由工程铸就；失败从不裸抛，降级为结构化结果
4. **接地或拒绝**——每条知识都锚定真实源码；证据之外，皆是传闻
5. **四个入口，四个时机**——写前预热、途中搜索、按处映射、收尾体检；知识只在对的时刻到场，从不塞满上下文
6. **文件即真源**——Markdown 是唯一的真相，数据库只是它的影子
7. **访问即代谢**——不靠时钟，不靠后台；每一次使用都是一次新陈代谢
8. **纵深防御**——从提交到常驻要过五道门；信任是挣来的，而且随时可以收回

---

## 一个产品，五个仓库

Alembic 以五个仓库开发，依赖脊柱单向——底部是确定性内核，边缘是宿主体验。

```
                       ┌─────────────────────────────┐
                       │       @alembic/core         │  确定性内核
                       │ lifecycle · guard · search  │
                       │ AST/graph · plan · coverage │
                       └─────────────▲───────────────┘
             ┌───────────────────────┼───────────────────────┐
  ┌──────────┴──────────┐  ┌─────────┴─────────┐  ┌──────────┴──────────┐
  │   @alembic/agent    │  │    alembic-ai     │  │    AlembicPlugin    │
  │  ReAct 运行时       │◄─┤    （主仓库）     │  │  Codex + Claude     │
  │  provider 栈        │  │ CLI · daemon      │  │  Code 插件          │
  │  工具系统           │  │ HTTP · Dashboard  │  │  同一套 MCP 工具面  │
  │  记忆 · 策略        │  │ sandbox · DI      │  │  无 daemon          │
  └─────────────────────┘  └─────────▲─────────┘  └─────────────────────┘
                                     │ 托管 dashboard/dist
                           ┌─────────┴─────────┐
                           │ alembic-dashboard │  React SPA
                           │  审核 · 实时      │
                           └───────────────────┘
```

| 仓库 | 包名 | 职责 |
|------|------|------|
| **Alembic**（主仓库） | `alembic-ai` | 用户可运行的宿主：CLI、带挖掘任务与文件监控的 per-project daemon、带实时交付的 HTTP API、Dashboard 托管、依赖注入、macOS Seatbelt 沙箱、工作空间与 Ghost 管理 |
| **AlembicCore** | `@alembic/core` | 共享确定性内核：知识生命周期、Guard 引擎、混合搜索与向量、项目智能、plan facts、覆盖账本、文件优先持久化。不含智能体、UI、provider——由边界测试强制 |
| **AlembicAgent** | `@alembic/agent` | 内嵌智能：一个 ReAct 执行引擎、覆盖五家厂商的 AI provider 栈（含可靠性控制）、契约先行的工具系统、分层记忆 |
| **AlembicDashboard** | `alembic-dashboard` | 审核界面：React SPA，九个视图，命令面板，中英双语，实时进度——构建后随 `alembic-ai` 一起发布 |
| **AlembicPlugin** | `@gxfn/alembic-runtime` | 面向智能体的交付：Codex 与 Claude Code 的点击安装插件壳，双宿主完全一致的 MCP 工具面，内置技能，Ghost 优先，无 daemon |

知识存储是**文件优先**的：Markdown Recipe 是唯一真源，SQLite 是可重建的读缓存（`alembic sync`），两者分歧会以带修复路径的类型化错误暴露。

---

## 工程能力

### Guard CLI

```bash
alembic guard src/file.ts        # 用已发布 Recipe 检查文件
alembic guard:staged             # pre-commit：仅检查暂存文件
alembic guard:ci --min-score 90  # CI 质量门
```

### 多语言项目智能

十一个内置 tree-sitter 语法：TypeScript · TSX · JavaScript · Swift · Objective-C · Kotlin · Java · Dart · Python · Go · Rust。五段增量调用图分析、耦合检测、依赖分层、架构风格推断——智能体可直接查询，不消耗一条 Recipe。

### 计划驱动的挖掘与覆盖

二十五个挖掘维度——十三个通用（架构、编码规范、设计模式、错误韧性、并发、数据流、网络、UI、测试、安全、性能、可观测性、智能体守则），加上语言与框架专属维度。规划只收集有界的项目事实，由智能体确认选择——无状态、从不持久化。每模块 × 每维度的**覆盖账本**记录已挖内容；收敛顾问建议是否值得再挖一轮——仅供参考，绝不作门禁。

### 混合搜索

向量索引 + 字段加权关键词，融合后按场景加权信号排序。语义层可选：没有 embedding 模型时，搜索优雅降级到关键词基线。

### 接地的知识

Recipe 携带 `sourceRefs`——智能体无需自证即可信任的锚定证据。单源的提交规范同时驱动校验与智能体看到的指引：要求多个不同文件的证据门、逐字 snippet 探针、可执行性动词白名单，以及进入生产前的确定性深度与接地裁判。

### 项目 Skill

完成一个维度会合成**项目 Skill**——智能体按需加载的指令文件。插件把它们投影进智能体的技能目录；Dashboard 可管理它们，包括从一句提示词 AI 生成。

### 沙箱执行

智能体终端工具位于只读命令白名单之后；macOS 上再套一层 Seatbelt profile，带网络代理与违规解析。降级绝不静默——未沙箱的执行会被标注并审计。

### AI Provider

进程内挖掘支持 **Google Gemini / OpenAI / Claude / DeepSeek / Ollama**，自动降级、配置热更新、参数守护。插件路径完全不需要这些——你的编码智能体自己的模型就是算力。

```bash
alembic start                    # 在 Dashboard 里配置，或：
printf %s "$OPENAI_API_KEY" | alembic ai configure --provider openai --model gpt-5.5 --key-stdin
alembic ai status                # 查看生效配置
```

显式环境变量对一次性运行仍然有效，且覆盖工作空间设置而不落盘。把 API key 交给智能体时只给裸 key——不加标签、不加包裹。

---

## Dashboard

`alembic start` 启动审核界面——覆盖运行时的九个视图：

| 视图 | 你在这里做什么 |
|------|----------------|
| **Recipes** | 按权威度浏览、编辑、逐条审阅演化提案 |
| **Candidates** | 审核并晋升提交；启动冷启动或 rescan；实时观看维度进度与三轮 AI 评审 |
| **Knowledge** | 跨六态生命周期批量管理知识条目 |
| **Module Explorer** | 发现的目标与自定义文件夹；对目标、文件夹或整个项目做 AI 扫描 |
| **Project Pyramid** | 逐层查看模块依赖图 |
| **Guard** | 规则、违规与写操作审计轨迹 |
| **Skills** | 查看、编辑、创建——或从提示词 AI 生成 |
| **Jobs** | daemon 队列：实时过程事件与完整 LLM 输入输出快照 |
| **Help** | 快速上手、工具参考、token 用量 |

另有 ⌘K 命令面板、中英界面、明暗主题、可选登录门。

## 项目结构

`alembic setup`（标准模式）之后，你的项目会获得：

```
your-project/
├── Alembic/                # 知识数据（git 跟踪；`alembic remote <url>` 可拆为共享仓库）
│   ├── constitution.yaml   # 入口安全策略
│   ├── recipes/            # 已审核模式（Markdown——唯一真源）
│   ├── candidates/         # 待审核
│   └── skills/             # 项目 Skill
└── .asd/                   # 运行时缓存（gitignore）
    ├── alembic.db          # SQLite——读缓存；`alembic sync` 可重建
    └── context/            # 向量索引
```

使用 `--ghost`（或插件，Ghost 是其默认值）时，**以上全部**改放在 `~/.asd/workspaces/<projectId>/`——你的仓库里零 Alembic 文件。

## 环境要求

- Node.js ≥ 22
- 推荐 macOS（智能体终端工具的 Seatbelt 沙箱仅 macOS；其余能力跨平台）
- better-sqlite3（内置）

### 推荐：本地 Embedding 解锁语义搜索

混合搜索开箱即用（加权关键词）。本地 embedding 模型可解锁语义层——概念级匹配，即使关键词不精确也能找到相关 Recipe：

```bash
brew install ollama && ollama serve
ollama pull qwen3-embedding:0.6b

alembic ai configure --embed-provider ollama --embed-model qwen3-embedding:0.6b
alembic embed
```

本地推理，无 API 调用，数据不出机器。

## 深入了解

> **[Visual Tour——5 分钟看懂整个系统](https://docs.gaoxuefeng.com/visual-tour)** · 从工作流到智能体循环的手绘架构图

每个仓库都有自己的架构 README：`AlembicCore`（内核分层、API 边界、质量门禁）、`AlembicAgent`（ReAct 运行时、provider 栈、工具安全）、`AlembicPlugin` 插件壳（[Codex](https://github.com/GxFn/AlembicCodex)、[Claude Code](https://github.com/GxFn/AlembicClaudeCode)）以及 `AlembicDashboard`。

## 参与贡献

1. 提交前运行 `npm test`
2. 遵循现有代码模式（ESM、领域驱动结构）；`npm run check` 运行完整门禁链

## 许可证

[MIT](LICENSE) © gaoxuefeng
