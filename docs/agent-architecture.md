# Agent 架构设计

AutoSnippet Agent 层（`lib/agent/`，路径别名 `#agent/*`）是项目的独立智能层，负责所有 AI Agent 的运行时能力。它从 Service 层独立出来，作为与 Service 层平行的顶级架构模块。

---

## 架构定位

```
Entry Points → Bootstrap → DI Container → [HTTP | MCP | CLI | Dashboard]
                                                    ↓
                                            ┌── Agent Layer ──┐
                                            │  ReAct Runtime   │
                                            │  Memory System   │
                                            │  54 Built-in Tools│
                                            └───────┬──────────┘
                                                    ↓
                                            Service Layer (15 子域)
                                                    ↓
                                         Core + Domain Layer
                                                    ↓
                                         Infrastructure Layer
                                                    ↓
                                           External Layer
```

Agent 层位于 DI Container 之下、Service 层之上，是连接外部请求与内部业务逻辑的智能中枢。

---

## 为什么独立

| 维度 | 说明 |
|------|------|
| **规模** | 40+ 个文件，5 个子模块，是原 Service 层最大的子域 |
| **自治性** | 拥有自己的 core/、domain/、memory/、context/、tools/ 内部分层，形成完整子系统 |
| **跨层消费** | 被 HTTP 路由、MCP Handler、CLI、DI 模块等多个层级消费 |
| **独立演进** | Agent 智能能力（记忆、推理、工具扩展）独立于业务服务演进 |
| **路径别名** | 使用 `#agent/*` 独立别名，与 `#service/*` 解耦 |

---

## 目录结构

```
lib/agent/
├── index.ts                    # 统一出口模块
│
├── AgentFactory.ts             # Agent 工厂 — 按 Preset 创建 Runtime
├── AgentRuntime.ts             # ReAct 推理循环核心引擎
├── AgentRuntimeTypes.ts        # 共享类型: AgentResult, RuntimeConfig
├── AgentRouter.ts              # Intent → Preset 路由分发
├── AgentMessage.ts             # 统一消息格式
├── AgentEventBus.ts            # Agent 事件总线
├── AgentState.ts               # Agent 状态管理 (phase 状态机)
├── IntentClassifier.ts         # 意图分类 (关键词 + LLM 混合)
├── LarkTransport.ts            # 飞书 ↔ Agent 桥接层
├── PipelineStrategy.ts         # 管线策略
├── ConversationStore.ts        # 会话存储 (磁盘持久化)
├── capabilities.ts             # Agent 能力声明与注册
├── policies.ts                 # Budget / Safety / QualityGate 策略
├── presets.ts                  # 命名配置组合 (insight/chat/lark/scan)
├── strategies.ts               # 运行策略 (Single/FanOut/Adaptive)
├── forced-summary.ts           # 强制总结机制
│
├── core/                       # ── Agent 核心运行时 ──
│   ├── ChatAgentPrompts.ts     # Prompt 模板库
│   ├── SystemPromptBuilder.ts  # 系统 Prompt 动态构建器
│   ├── ToolExecutionPipeline.ts # 工具执行管线 + 安全策略
│   ├── MessageAdapter.ts       # 消息格式适配
│   ├── LoopContext.ts          # ReAct 循环上下文
│   └── LLMResultType.ts       # LLM 结果类型枚举
│
├── memory/                     # ── 多层记忆系统 ──
│   ├── MemoryCoordinator.ts    # 记忆协调器 (调度所有记忆层)
│   ├── MemoryRetriever.ts      # 记忆检索 (向量 + 关键词)
│   ├── MemoryStore.ts          # 记忆持久化存储
│   ├── MemoryConsolidator.ts   # 记忆整合 (短期 → 长期)
│   ├── ActiveContext.ts        # 活跃上下文窗口
│   ├── PersistentMemory.ts     # 跨会话持久记忆
│   ├── SessionStore.ts         # 会话级记忆存储
│   └── index.ts                # 记忆模块出口
│
├── context/                    # ── 上下文管理 ──
│   ├── ContextWindow.ts        # Token 窗口管理 + 自动截断
│   ├── ExplorationTracker.ts   # 探索进度追踪
│   └── exploration/            # 探索策略子系统
│       ├── ExplorationStrategies.ts  # 探索策略定义
│       ├── NudgeGenerator.ts   # 引导提示生成
│       ├── PlanTracker.ts      # 计划追踪
│       └── SignalDetector.ts   # 完成信号检测
│
├── domain/                     # ── Agent 领域逻辑 ──
│   ├── ChatAgentTasks.ts       # 预定义任务 (dedup/enrich/score/guard)
│   ├── EpisodicConsolidator.ts # 记忆片段整合
│   ├── EvidenceCollector.ts    # 证据收集器
│   ├── insight-analyst.ts      # 洞察分析
│   ├── insight-gate.ts         # 洞察质量门控
│   ├── insight-producer.ts     # 洞察生产 (知识提取)
│   └── scan-prompts.ts         # 扫描任务 Prompt 模板
│
└── tools/                      # ── 54 个内置工具 ──
    ├── ToolRegistry.ts         # 工具注册中心
    ├── _shared.ts              # 工具共享类型与工具函数
    ├── index.ts                # 工具统一注册入口
    ├── ai-analysis.ts          # AI 分析工具
    ├── ast-graph.ts            # AST/代码图谱工具
    ├── composite.ts            # 复合操作工具
    ├── guard.ts                # Guard 规则工具
    ├── infrastructure.ts       # 基础设施工具
    ├── knowledge-graph.ts      # 知识图谱工具
    ├── lifecycle.ts            # 生命周期管理工具
    ├── project-access.ts       # 项目访问工具
    ├── query.ts                # 查询工具
    ├── scan-recipe.ts          # 扫描与 Recipe 工具
    └── system-interaction.ts   # 系统交互工具
```

---

## 核心概念

### ONE Runtime 架构

Agent 系统采用 **"一个运行时，多种配置"** 的架构：

```
                    ┌─── insight (深度分析)
                    ├─── chat    (对话交互)
AgentFactory ───→ Preset ──→ AgentRuntime
                    ├─── lark    (飞书集成)
                    └─── scan    (批量扫描)
```

- **AgentFactory** 接收 Preset 名称，构造包含不同 Strategy、Policy、Tool 集合的 Runtime
- **AgentRuntime** 是统一的 ReAct 循环引擎，根据配置表现出不同行为
- **Preset** 定义了一组 (Strategy, Policy, Capabilities, Tools) 的命名组合

### ReAct 推理循环

```
用户输入 → SystemPrompt → LLM 推理 → 工具调用 → 结果注入 → LLM 推理 → ...
                ↑                         ↓
         ContextWindow              ToolExecutionPipeline
         (Token 管理)              (Safety + 执行 + 结果)
```

每轮循环经过：
1. **SystemPromptBuilder** — 构建系统提示词（含能力声明、工具列表、上下文）
2. **LLM 调用** — 通过 AiProvider 发送 chat 请求
3. **ToolExecutionPipeline** — 解析工具调用、安全检查、执行、结果收集
4. **ContextWindow** — Token 预算管理，自动截断过长上下文

### 多层记忆系统

```
┌─────────────────────────────────────┐
│          MemoryCoordinator          │  ← 统一调度
├──────────┬──────────┬───────────────┤
│ Session  │ Active   │  Persistent   │
│ Store    │ Context  │  Memory       │
│ (会话级) │ (工作区) │  (跨会话)     │
├──────────┴──────────┴───────────────┤
│       MemoryConsolidator            │  ← 短期→长期整合
│       EpisodicConsolidator          │  ← 片段→结构化
└─────────────────────────────────────┘
```

### 工具系统

54 个内置工具分为 8 个功能组：

| 工具组 | 文件 | 工具数 | 职责 |
|--------|------|--------|------|
| AI 分析 | `ai-analysis.ts` | ~5 | AI 驱动的代码分析 |
| AST 图谱 | `ast-graph.ts` | ~8 | 代码结构分析、调用图 |
| 复合操作 | `composite.ts` | ~6 | 多步骤组合操作 |
| Guard | `guard.ts` | ~4 | 规则检查与合规 |
| 基础设施 | `infrastructure.ts` | ~8 | 文件操作、配置、技能管理 |
| 知识图谱 | `knowledge-graph.ts` | ~6 | 知识查询、关系分析 |
| 生命周期 | `lifecycle.ts` | ~5 | Entry 创建、更新、状态管理 |
| 项目访问 | `project-access.ts` | ~5 | 文件读取、目录遍历 |
| 查询 | `query.ts` | ~4 | 搜索、检索 |
| 系统交互 | `system-interaction.ts` | ~3 | 命令执行、剪贴板 |

---

## 依赖关系

### Agent 层对外依赖

```
Agent Layer
   ├──→ #infra/logging/Logger.js       (日志)
   ├──→ #external/ai/AiProvider.js     (LLM 调用)
   ├──→ #shared/similarity.js          (相似度计算)
   ├──→ #shared/token-utils.js         (Token 估算)
   ├──→ #shared/FieldSpec.js           (字段规格)
   ├──→ #shared/UnifiedValidator.js    (校验器)
   ├──→ #service/candidate/*           (相似度服务)
   ├──→ #service/knowledge/*           (知识图谱)
   ├──→ #service/skills/*              (技能管理)
   └──→ #external/mcp/handlers/*       (MCP 工具处理器)
```

### 外部对 Agent 层的消费

| 消费方 | 消费内容 |
|--------|---------|
| `lib/injection/modules/AgentModule.ts` | `AgentFactory`, `ToolRegistry` |
| `lib/injection/ServiceMap.ts` | `AgentFactory` (type), `ToolRegistry` (type) |
| `lib/http/routes/ai.ts` | `AgentMessage`, `ConversationStore`, `PRESETS` |
| `lib/http/routes/remote.ts` | `LarkTransport` |
| `lib/external/mcp/handlers/bootstrap/pipeline/` | `Memory*`, `ExplorationTracker`, `PRESETS` |
| `lib/service/skills/SignalCollector.ts` | `AgentMessage` (dynamic) |

---

## 配置与 DI

Agent 层通过 DI 容器注册两个核心服务：

```typescript
// lib/injection/modules/AgentModule.ts
c.singleton('toolRegistry', () => {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_TOOLS);
  return registry;
});

c.singleton('agentFactory', (ct) =>
  new AgentFactory({
    container: ct,
    toolRegistry: ct.get('toolRegistry'),
    aiProvider: ct.singletons.aiProvider || null,
    projectRoot: resolveProjectRoot(ct),
  }),
  { aiDependent: true }  // AI Provider 热重载时自动重建
);
```

---

## 路径别名

```json
// package.json
"#agent/*": {
  "asd-dev": "./lib/agent/*",
  "default": "./dist/lib/agent/*"
}
```

使用方式：
```typescript
import { AgentFactory } from '#agent/AgentFactory.js';
import { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import { ToolRegistry } from '#agent/tools/ToolRegistry.js';
```
