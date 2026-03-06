/**
 * AutoSnippet Agent 模块 — 统一出口
 *
 * @module service/agent
 *
 * 统一架构: ONE Runtime, 多种配置
 *
 *   ┌──────── Transport ────────┐
 *   │  HTTP│Lark│CLI│MCP│...    │  ← 渠道适配 (AgentMessage)
 *   └──────────┬────────────────┘
 *              │
 *   ┌──────────▼────────────────┐
 *   │       AgentRouter         │  ← 意图 → Preset
 *   └──────────┬────────────────┘
 *              │
 *   ┌──────────▼────────────────┐
 *   │       AgentFactory        │  ← Preset + DI → Runtime
 *   └──────────┬────────────────┘
 *              │
 *   ┌──────────▼────────────────────────────────────────┐
 *   │              AgentRuntime                          │
 *   │                                                    │
 *   │  ┌──────────┐  ┌───────────┐  ┌────────────────┐ │
 *   │  │Capability│  │ Strategy  │  │    Policy       │ │
 *   │  │ 技能模块 │  │ 执行策略  │  │    约束引擎    │ │
 *   │  ├──────────┤  ├───────────┤  ├────────────────┤ │
 *   │  │• 对话    │  │• Single   │  │• Budget 预算   │ │
 *   │  │• 代码分析│  │• Pipeline │  │• Safety 安全   │ │
 *   │  │• 知识生产│  │• FanOut   │  │• Quality 质量  │ │
 *   │  │• 系统交互│  │• Adaptive │  │                │ │
 *   │  └──────────┘  └───────────┘  └────────────────┘ │
 *   │                                                    │
 *   │  ┌─────────────────────────────────────────┐      │
 *   │  │  ReAct Loop  (Thought→Action→Observe)   │      │
 *   │  └─────────────────────────────────────────┘      │
 *   └───────────────────────────────────────────────────┘
 *              │
 *   ┌──────────▼────────────────┐
 *   │   AgentState + EventBus   │  ← 状态机 + 事件通信
 *   └──────────────────────────-┘
 *
 * Preset 配置表:
 *   | Preset       | Capabilities         | Strategy    | Policies         |
 *   |--------------|----------------------|-------------|------------------|
 *   | chat         | Conv + Analysis      | Single      | Budget(8轮)      |
 *   | bootstrap    | Analysis + Knowledge | FanOut+Pipe | Budget+Quality   |
 *   | scan         | Analysis + Knowledge | Pipeline    | Budget+Quality   |
 *   | remote-exec  | Conv+Analysis+System | Single      | Budget+Safety    |
 */

// ── Infrastructure ──
export { AgentState, AgentPhase } from './AgentState.js';
export { AgentEventBus, AgentEvents } from './AgentEventBus.js';
export { AgentMessage, Channel } from './AgentMessage.js';

// ── Core ──
export { AgentRuntime } from './AgentRuntime.js';
export { AgentRouter, PresetName } from './AgentRouter.js';
export { AgentFactory } from './AgentFactory.js';

// ── Capabilities ──
export {
  Capability,
  Conversation,
  CodeAnalysis,
  KnowledgeProduction,
  SystemInteraction,
  CapabilityRegistry,
} from './capabilities.js';

// ── Strategies ──
export {
  Strategy,
  SingleStrategy,
  FanOutStrategy,
  AdaptiveStrategy,
  StrategyRegistry,
} from './strategies.js';
export { PipelineStrategy } from './PipelineStrategy.js';

// ── Policies ──
export {
  Policy,
  BudgetPolicy,
  SafetyPolicy,
  QualityGatePolicy,
  PolicyEngine,
} from './policies.js';

// ── Presets ──
export { PRESETS, getPreset, resolveStrategy } from './presets.js';
