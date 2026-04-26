/**
 * Alembic Agent 模块 — 统一出口
 *
 * @module agent
 *
 * 统一架构: Surface -> AgentService -> Runtime -> Action Layer
 *
 *   ┌──────── Surface Layer ─────────┐
 *   │  HTTP│Lark│CLI│MCP│Workflow    │  ← 只构造 AgentRunInput
 *   └──────────────┬─────────────────┘
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │          AgentService          │  ← 统一服务入口 + profile 编译
 *   └──────────────┬─────────────────┘
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │      AgentRuntimeBuilder       │  ← Profile + DI → Runtime
 *   └──────────────┬─────────────────┘
 *              │
 *   ┌──────────▼────────────────────────────────────────┐
 *   │              AgentRuntime                          │
 *   │                                                    │
 *   │  ┌────────────┐ ┌───────────┐ ┌────────────────┐ │
 *   │  │Agent Skill │ │ Strategy  │ │    Policy       │ │
 *   │  │ 运行时技能 │ │ 工程编排  │ │    约束引擎    │ │
 *   │  └────────────┘ └───────────┘ └────────────────┘ │
 *   │                                                    │
 *   │  ┌─────────────────────────────────────────┐      │
 *   │  │  ReAct Loop  (Thought→Action→Observe)   │      │
 *   │  └─────────────────────────────────────────┘      │
 *   └───────────────────────────────────────────────────┘
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │ Action Layer: ToolRouter        │  ← 执行动作，不选择 Agent profile
 *   └────────────────────────────────┘
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
export * from './service/index.js';
// ── Strategies ──
export {
  AdaptiveStrategy,
  FanOutStrategy,
  SingleStrategy,
  Strategy,
  StrategyRegistry,
} from './strategies.js';
