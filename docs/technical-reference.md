# 技术参考

> 本文档是 AutoSnippet 五大器官的实现细节、工程数据与防御链详解。概述见 [README](../README_CN.md)。
>
> [English](technical-reference.en.md)

---

## 五大器官实现

### 骨骼 — Panorama (2,965 行，9 文件)

有机体的结构感知。基于 AST + 调用图推断模块角色，四信号融合（AST 结构 30% + 调用行为 30% + 数据流 15% + 实体拓扑 10% + 正则基线 15%），识别 13 种角色类型，按 7 种语言族差异化（apple / jvm / dart / python / web / go / rust）。Tarjan SCC 计算模块耦合度（检测循环依赖，fan-in/fan-out 度量），Kahn 最长路径拓扑排序推断分层结构（L0-Ln 自动分层 + 角色投票命名）。DimensionAnalyzer 生成 11 维知识健康雷达图（architecture / coding-standards / error-handling / concurrency / data-management / networking / ui-patterns / testing / security / performance / observability），输出知识覆盖率热力图和能力缺口优先级报告。

### 消化 — Governance (3,658 行，10 文件)

知识代谢的核心引擎。ContradictionDetector 检测矛盾（4 维证据）、RedundancyAnalyzer 分析冗余（4 维权重）、DecayDetector 评估衰退（6 策略：no_recent_usage / high_false_positive / symbol_drift / source_ref_stale / superseded / contradiction + 4 维评分：freshness 30% + usage 30% + quality 20% + authority 20%，5 级健康等级 0~100）、ProposalExecutor 到期自动执行进化提案（7 种提案类型：merge / supersede / enhance / deprecate / reorganize / contradiction / correction，5 种状态 + 差异化观察窗口 24h~7d）。ConfidenceRouter 6 阶段数值路由——置信度 ≥ 0.85 自动发布（≥ 0.90 → 24h Grace，0.85~0.89 → 72h Grace），< 0.2 直接拒绝，可信来源阈值放宽到 0.70。ConsolidationAdvisor 提交前融合顾问，StagingManager 分层 Grace Period 管理，EnhancementSuggester 4 种增强建议。

### 神经 — Signal + Intent (682 行 SignalBus + IntentClassifier)

有机体的感知与意图中枢。12 种信号类型统一到 SignalBus（guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot）。HitRecorder 在 30s buffer 内批量采集使用事件，SignalTraceWriter 持久化到 trace 日志，SignalAggregator 异步聚合。IntentClassifier 分析 Agent 意图并路由到最优 Preset，IntentExtractor 提取术语、推断语言和模块。各器官订阅感兴趣的信号协同决策——不是「每 24 小时扫描」而是「信号饱和时触发」。当 Agent 偏移意图时，神经系统记录漂移信号，协调免疫系统反向检查 Recipe 有效性。

### 免疫 — Guard (5,726 行，14 文件)

双向免疫系统。Guard 正向审计代码合规（四层：正则逐行 → 代码级多行 → tree-sitter AST → 跨文件分析）；ReverseGuard 反向验证 Recipe 引用的 API 符号是否仍存在于代码中（5 种漂移类型 → 三级建议 healthy / investigate / decay）。三态输出（pass / violation / uncertain）——UncertaintyCollector 收集能力边界并诚实上报。三维报告：合规度 + 覆盖率 + 置信度，Quality Gate 三态结论（PASS / WARN / FAIL）。RuleLearner 追踪每条规则的 TP / FP / FN → P/R/F1，FP > 40% 自动触发衰退检查。ExclusionManager 3 级排除（路径 / 规则+文件 / 全局禁用），GuardFeedbackLoop 检测已修复违规并自动确认 Recipe 使用，CoverageAnalyzer 模块级规则覆盖率矩阵。

### 造物 — Tool Forge (1,280 行，5 文件)

能力边界处的创造力。三种模式渐进——复用（0ms）→ 组合（10ms，DynamicComposer 按 sequential / parallel 策略）→ 生成（~5s，LLM 写代码 → SandboxRunner vm 隔离验证：5s 超时 + 18 条安全规则禁止 require/eval → TemporaryToolRegistry 30min TTL，60s 周期自动回收）。ToolRequirementAnalyzer 自动推荐最优锻造策略。

> **辅助引擎**：内置 Agent Runtime（1,099 行）在 IDE Agent 未介入时提供后台 ReAct 治理——感知 → 工作记忆 → 推理(LLM) → 行动(Tools) → 反思(Policy)。3 级上下文压缩、阶段机(EXPLORE→PRODUCE→SUMMARIZE)、矛盾检测去重。6 层 Memory 系统（Store / Retriever / Coordinator / Consolidator / PersistentMemory / ActiveContext）。16 个 MCP 工具暴露给 IDE Agent，50+ 个内部工具供后台调用。

---

## 纵深防御

六层防御链，每层独立有效：

| 层 | 组件 | 职责 |
|----|------|------|
| 1 | **Constitution** | 宪法级规则：5 种角色权限矩阵（developer / external_agent / chat_agent / contributor / visitor）+ 能力探测（git_write） |
| 2 | **Gateway** | 统一请求管线：validate → guard → route → audit，EventEmitter 异步观察 |
| 3 | **Permission** | 3 元组权限校验：actor + action + resource → allowed/denied，通配符 admin |
| 4 | **SafetyPolicy** | Agent 约束：预算（Budget）/ 质量门（QualityGate）/ 行为策略 |
| 5 | **PathGuard** | 双层路径安全：Layer 1 阻止项目外写入；Layer 2 约束到白名单目录（.autosnippet / .cursor / .vscode / .github） |
| 6 | **ConfidenceRouter** | 数值路由：置信度 + 来源信誉 + 内容长度 + reasoning 有效性 → 6 阶段自动审核 |

---

## 工程数据

| 指标 | 数值 |
|------|------|
| 源码文件 | 475 个 TypeScript 文件（lib 396 + Dashboard 76 + CLI 3） |
| 源码总行数 | 161,220 行（lib 132,374 + Dashboard 27,068 + CLI 1,778） |
| 单元测试 | 1,422 tests / 63 文件 |
| 集成测试 | 1,125 tests / 44 文件 |
| DI 服务模块 | 9 个 Module，67 个 singleton 服务 |
| SQLite 表 | 13 张 |
| MCP 工具 | 16 个（14 Agent + 2 Admin） |
| HTTP API | 22 个路由文件，142 个端点 |
| Dashboard 视图 | 19 个页面 + 4 个 Modal |
| CLI 命令 | 20 个 |
| AST 语言插件 | 11 种语言（11 WASM grammar） |
| 项目 Discoverer | 9 种（SPM / Node / JVM / Go / Python / Rust / Dart / C# / Generic） |
| 信号类型 | 12 种 |
| 知识关系类型 | 14 种 |
| Agent 内部工具 | 50+ 个（14 文件） |

---

## 意图感知搜索

IntentExtractor 提取技术术语、推断语言和模块、进行中英文交叉同义词展开（inject↔注入、architecture↔架构、protocol↔协议……），识别 4 种场景（lint / generate / search / learning）。PrimeSearchPipeline 执行多路并行搜索（原始查询 + 术语查询 + 文件上下文 + 聚焦同义词），经过三层质量过滤（绝对阈值 + 相对最优比 + 分数断层截断）后返回精准结果。

搜索引擎底层支持 4 种模式：keyword 直接匹配、recall 加权字段召回（FieldWeightedScorer：trigger 5.0 > title 3.0 > tags 2.0 > description 1.5 > content 1.0）、semantic 向量相似度、auto 混合检索（RRF 融合稠密与稀疏结果）。MultiSignalRanker 按场景动态调整 7 路信号权重（relevance / authority / recency / popularity / difficulty / contextMatch / vector）。

### 语义搜索

配置 LLM API Key 后，搜索升级为向量 + 加权字段混合检索——基于 HNSW 索引的向量近邻搜索，AST 感知分块，标量量化压缩。RRF（k=60）融合稠密与稀疏检索结果。CrossEncoder 为可选模块（需独立配置 AI Provider），未配置时降级为 Jaccard 相似度。

---

## Bootstrap 冷启动

6 阶段分析流水线：文件收集 + 语言检测 → AST 分析 + CodeEntityGraph + CallGraph + Panorama → 依赖关系图 → Guard 审计 → 维度条件化过滤 → AI 知识提取 + 精炼。10 个分析维度（代码规范 / 设计模式 / 架构模式 / 最佳实践 / 事件与数据流 / 项目特征 / 强制规范 / ObjC·Swift 深度扫描 / Category 方法扫描 / 模块导出扫描），按编程语言族差异化分析指引。

---

## 六态知识生命周期

```
pending → staging → active → evolving → active (增强后回归)
                      ↓                    ↓
                   decaying → deprecated ←─┘ (衰退确认后废弃)
```

三个系统驱动的中间态——staging（置信度 ≥ 0.90 → 24h / 0.85~0.89 → 72h 后自动发布）、evolving（进化提案附着，按类型差异化观察窗口 24h~7d 后自动应用）、decaying（标准 30d + 严重 15d 观察期，3 次确认后废弃）。Agent 只能推入中间态，系统规则完成最终转换，开发者保留全程干预权。

---

## 多语言静态分析

11 种语言的 tree-sitter AST 分析——Go、Python、Java、Kotlin、Swift、JavaScript、TypeScript、Rust、Objective-C、Dart、C#（11 个 WASM grammar）。提取类、方法、属性、协议、继承链、Category、设计模式（Singleton / Delegate / Factory / Observer）。

5 阶段 CallGraph 构建：调用点提取 → 全局符号表 → 导入路径解析 → 调用边解析 → 数据流推断。支持增量分析（≤ 10 变更文件仅重分析受影响范围，减少 50~70% 处理时间）。

8 种项目类型自动检测（SPM / Node / Maven·Gradle / Go / Python / Rust / Dart / 通用），按置信度自动选择最佳 Discoverer。

---

## 6 通道 IDE 交付

知识库变更后自动交付到 IDE 可消费的格式：

| 通道 | 路径 | 内容 |
|------|------|------|
| **A** | `.cursor/rules/autosnippet-project-rules.mdc` | alwaysApply 一行式规则（≤ 80 条，≤ 8K tokens） |
| **B** | `.cursor/rules/autosnippet-patterns-{topic}.mdc` | When/Do/Don't 主题 Smart 规则 + 架构分层规则 |
| **C** | `.cursor/skills/` | Project Skills 同步 |
| **D** | `.cursor/skills/autosnippet-devdocs/` | 开发文档 |
| **F** | `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` | Agent 指令文件 |
| **Mirror** | `.qoder/` / `.trae/` | IDE 工具镜像 |

KnowledgeCompressor 将 Recipe 压缩为规则：Channel A 一行式 `[lang] Do X. Do NOT Y.`；Channel B 结构化 `@trigger + When/Do/Don't/Why + 骨架代码 ≤ 15 行`。总预算控制在 50KB 以内。

---

## 知识图谱

Recipe 之间有 14 种关联关系（inherits / implements / calls / depends_on / data_flow / conflicts / extends / related / alternative / prerequisite / deprecated_by / solves / enforces / references）。查询影响路径、依赖深度、关联 Recipe，帮你看清知识之间的结构。

---

## Recipe 源码证据（sourceRefs）

Recipe 携带创建时分析的项目文件路径作为证据。搜索结果中的 📍 sourceRefs 指向项目中的真实文件，Agent 无需自行验证即可信任并引用。后台自动监控路径有效性，git rename 自动修复。

---

## 信号循环

SignalBus 统一 12 种信号类型（guard / search / usage / lifecycle / quality / exploration / panorama / decay / forge / intent / anomaly / guard_blind_spot）为标准模型。HitRecorder 批量采集使用事件（30s buffer + flush），各器官订阅感兴趣的信号协同决策。AI 从中挖掘规律并推荐 Skill。

---

## 飞书远程编程

手机上在飞书发一句话，意图识别自动分流——Bot Agent 服务端直接处理，或路由到本地 IDE 由 Copilot Agent Mode 执行，结果回传飞书。

---

## Recipe 远程仓库

`asd remote <url>` 将知识库目录转为独立 git 子仓库。多项目共享同一套 Recipe，独立控制读写权限。Constitution 通过 `git push --dry-run` 探测写权限，86400s 缓存 TTL。

---

## AI Provider

语义搜索、信号推荐、飞书远程等 AI 驱动功能需要 LLM API Key。在 Dashboard 的 LLM 配置中设置，或在 `.env` 中填写——支持 Google / OpenAI / Claude / DeepSeek / Ollama，多个自动 fallback。AI Provider 内置熔断器（CLOSED/OPEN/HALF_OPEN）+ 429 速率限制 + 并发槽管理（默认 4 路）。
