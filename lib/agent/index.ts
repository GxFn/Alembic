/**
 * Alembic Agent 模块 — 统一出口
 *
 * @module agent
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

export { AgentEventBus, AgentEvents } from './AgentEventBus.js';
export { AgentFactory } from './AgentFactory.js';
export { AgentMessage, Channel } from './AgentMessage.js';
export { AgentRouter, PresetName } from './AgentRouter.js';
// ── Core ──
export { AgentRuntime } from './AgentRuntime.js';
// ── Infrastructure ──
export { AgentPhase, AgentState } from './AgentState.js';

// ── Capabilities ──
export {
  Capability,
  CapabilityRegistry,
  CodeAnalysis,
  Conversation,
  KnowledgeProduction,
  SystemInteraction,
} from './capabilities.js';
export { PipelineStrategy } from './PipelineStrategy.js';
// ── Policies ──
export {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from './policies.js';
// ── Presets ──
export { getPreset, PRESETS, resolveStrategy } from './presets.js';
// ── Strategies ──
export {
  AdaptiveStrategy,
  FanOutStrategy,
  SingleStrategy,
  Strategy,
  StrategyRegistry,
} from './strategies.js';
