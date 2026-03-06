/**
 * Presets — 命名的 Agent 配置组合
 *
 * 核心思想: Agent 不分"类型"，只有"配置"。
 * Preset 是 Capability + Strategy + Policy 的命名组合。
 *
 * 这是统一架构的最终体现:
 *
 *   | 使用场景         | Capabilities             | Strategy     | Policies            |
 *   |------------------|--------------------------|--------------|---------------------|
 *   | chat             | Conv + Analysis          | Single       | StandardBudget      |
 *   | insight          | Analysis + Production    | FanOut+Pipe  | DeepBudget+Quality  |
 *   | remote-exec      | Conv + Analysis + System | Single       | ShortBudget+Safety  |
 *
 * 注意:
 *   - "飞书聊天" 用 chat preset，不需要单独的 Agent
 *   - "飞书远程执行" 用 remote-exec preset，Safety 由 Policy 提供
 *   - "冷启动" 和 "扫描" 统一使用 insight preset，仅编排层不同
 *
 * @module presets
 */

import { BudgetPolicy, SafetyPolicy, QualityGatePolicy } from './policies.js';
import { SingleStrategy, FanOutStrategy, AdaptiveStrategy } from './strategies.js';
import { PipelineStrategy } from './PipelineStrategy.js';

// v3.0: 导入 Insight 领域函数 (domain/ 模块)
import {
  buildAnalystPrompt, ANALYST_SYSTEM_PROMPT, ANALYST_BUDGET,
} from './domain/insight-analyst.js';
import {
  insightGateEvaluator, buildRetryPrompt,
} from './domain/insight-gate.js';
import {
  buildProducerPromptV2, PRODUCER_SYSTEM_PROMPT, PRODUCER_BUDGET,
  producerRejectionGateEvaluator,
} from './domain/insight-producer.js';

// ─── Preset 定义 ──────────────────────────────

/**
 * @typedef {Object} PresetConfig
 * @property {string} name 人类可读名称
 * @property {string} description 描述
 * @property {string[]} capabilities - Capability 名称列表
 * @property {Object} strategy - Strategy 配置 { type, ...opts }
 * @property {Array<Object>} policies - Policy 实例或配置
 * @property {Object} [persona] 人格/角色配置
 * @property {Object} [memory] 记忆配置
 */

/**
 * 所有内置 Preset
 */
export const PRESETS = Object.freeze({

  // ─── chat: 通用对话 ──────────────────────

  chat: {
    name: '对话',
    description: '多轮对话、知识检索、代码问答。适用于 Dashboard 和飞书的常规对话。',
    capabilities: ['conversation', 'code_analysis'],
    strategy: { type: 'single' },
    policies: [
      (config) => new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 8,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.7,
        timeoutMs: config?.timeoutMs ?? 120_000,
      }),
    ],
    persona: {
      role: 'assistant',
      description: 'AutoSnippet 知识管理助手',
    },
    memory: {
      enabled: true,
      mode: 'user',
      tiers: ['working', 'episodic', 'semantic'],
    },
  },

  // ─── insight: 深度代码分析 + 知识产出 ────────
  //
  // v3.0 重设计: PipelineStrategy 增强版
  //   - 每个 stage 有 systemPrompt + promptBuilder (替代通用 Capability prompt)
  //   - Quality Gate 使用自定义 evaluator (三态: pass/retry/degrade)
  //   - Rejection Gate 监控 Producer 拒绝率
  //   - promptBuilder 通过 strategyContext 获取运行时数据 (dimConfig/sessionStore/...)
  //
  // orchestrator 通过 createRuntime('insight', { strategy: {...} }) 按需覆盖
  // onToolCall 由 orchestrator 按维度注入 (闭包引用 ActiveContext)

  insight: {
    name: '洞察',
    description: '深度代码分析 + 知识提取。增强 PipelineStrategy: Analyze→QualityGate→Produce→RejectionGate。',
    capabilities: ['code_analysis', 'knowledge_production'],
    strategy: {
      type: 'pipeline',
      maxRetries: 1,
      stages: [
        // ── Phase 1: Analyst ──
        {
          name: 'analyze',
          capabilities: ['code_analysis'],
          budget: { maxIterations: ANALYST_BUDGET.maxIterations, temperature: 0.4, timeoutMs: 300_000 },
          systemPrompt: ANALYST_SYSTEM_PROMPT,
          promptBuilder: (ctx) => buildAnalystPrompt(
            ctx.dimConfig, ctx.projectInfo,
            ctx.dimContext, ctx.sessionStore, ctx.semanticMemory, ctx.codeEntityGraph,
          ),
          retryPromptBuilder: (retryCtx, _origPrompt, prev) => {
            const prevAnalysis = prev.analyze?.reply || '';
            const retryHint = buildRetryPrompt(retryCtx.reason);
            return `${prevAnalysis}\n\n⚠️ 上述分析未通过质量检查: ${retryCtx.reason}\n\n${retryHint}`;
          },
          // onToolCall: 由 orchestrator 按维度注入
        },

        // ── Phase 2: Quality Gate ──
        {
          name: 'quality_gate',
          gate: {
            evaluator: insightGateEvaluator,
            maxRetries: 1,
          },
        },

        // ── Phase 3: Producer ──
        {
          name: 'produce',
          capabilities: ['knowledge_production'],
          // 透传完整 PRODUCER_BUDGET (searchBudget/maxSubmits/softSubmitLimit/idleRoundsToExit)
          // 供 ExplorationTracker 精确控制 PRODUCE→SUMMARIZE 转换时机
          budget: { ...PRODUCER_BUDGET, temperature: 0.3, timeoutMs: 180_000 },
          systemPrompt: PRODUCER_SYSTEM_PROMPT,
          promptBuilder: (ctx) => buildProducerPromptV2(
            ctx.gateArtifact,  // 来自 quality_gate 的 AnalysisArtifact
            ctx.dimConfig, ctx.projectInfo,
          ),
          // 拒绝率过高时: 缩减预算 + 特定修复 prompt (对齐旧 ProducerAgent 的 rejection retry)
          retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 120_000 },
          retryPromptBuilder: (retryCtx, _origPrompt, prev) => {
            const prevProduce = prev.produce;
            const submitCalls = (prevProduce?.toolCalls || []).filter(tc =>
              ['submit_knowledge', 'submit_with_check'].includes(tc.tool || tc.name));
            const rejected = submitCalls.filter(tc => {
              const res = tc.result;
              if (!res) return false;
              if (typeof res === 'string') return res.includes('rejected') || res.includes('error');
              return res.status === 'rejected' || res.status === 'error' || res.reason === 'validation_failed';
            }).length;
            return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明（为什么这样设计）
4. 包含来源标注 (来源: FileName.m:行号)
5. 标题使用项目真实类名
6. 必填: trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`;
          },
          skipOnDegrade: true,
        },

        // ── Phase 4: Rejection Gate ──
        {
          name: 'rejection_gate',
          gate: {
            evaluator: producerRejectionGateEvaluator,
            maxRetries: 1,
          },
          skipOnDegrade: true,
        },
      ],
    },
    policies: [
      (config) => new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 24,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.3,
        timeoutMs: config?.timeoutMs ?? 600_000,
      }),
      (config) => new QualityGatePolicy({
        minEvidenceLength: config?.minEvidenceLength ?? 500,
        minFileRefs: config?.minFileRefs ?? 3,
        minToolCalls: config?.minToolCalls ?? 3,
      }),
    ],
    persona: {
      role: 'analyst',
      description: '高级软件架构师 + 知识管理专家',
    },
    memory: {
      enabled: false, // 无状态 worker
    },
  },

  // ─── lark: 飞书知识管理对话 ─────────────

  lark: {
    name: '飞书对话',
    description: '通过飞书自然语言进行知识管理、代码分析、项目理解。服务端直接处理，不转发 IDE。',
    capabilities: ['conversation', 'code_analysis'],
    strategy: { type: 'single' },
    policies: [
      (config) => new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 12,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.7,
        timeoutMs: config?.timeoutMs ?? 180_000,
      }),
      () => new SafetyPolicy({
        allowedSenders: process.env.ASD_LARK_ALLOWED_USERS?.split(',').filter(Boolean) || [],
      }),
    ],
    persona: {
      role: 'assistant',
      description: 'AutoSnippet 知识管理助手 (飞书)。用中文回复，简洁专业。',
    },
    memory: {
      enabled: true,
      mode: 'user',
      tiers: ['working', 'episodic', 'semantic'],
    },
  },

  // ─── remote-exec: 远程执行 ──────────────

  'remote-exec': {
    name: '远程执行',
    description: '通过飞书/远程终端执行本地操作。搭配 SafetyPolicy 保障安全。',
    capabilities: ['conversation', 'code_analysis', 'system_interaction'],
    strategy: { type: 'single' },
    policies: [
      (config) => new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 6,
        maxTokens: config?.maxTokens ?? 2048,
        temperature: config?.temperature ?? 0.5,
        timeoutMs: config?.timeoutMs ?? 60_000,
      }),
      () => new SafetyPolicy({
        allowedSenders: process.env.ASD_LARK_ALLOWED_USERS?.split(',').filter(Boolean) || [],
        // @ts-expect-error TS migration: TS2353
        fileScope: process.env.ASD_PROJECT_ROOT || null,
      }),
    ],
    persona: {
      role: 'assistant',
      description: 'AutoSnippet 远程编程助手',
    },
    memory: {
      enabled: true,
      mode: 'user',
      tiers: ['working', 'episodic'],
    },
  },

});

// ─── Preset 解析器 ────────────────────────────

/**
 * 将 Preset 配置中的 strategy 声明式配置转换为实际 Strategy 实例
 *
 * @param {Object} strategyConfig - { type: 'single'|'pipeline'|'fan_out'|'adaptive', ...opts }
 * @returns {import('./strategies.js').Strategy}
 */
export function resolveStrategy(strategyConfig) {
  if (!strategyConfig) return new SingleStrategy();

  switch (strategyConfig.type) {
    case 'single':
      return new SingleStrategy();

    case 'pipeline':
      return new PipelineStrategy({
        stages: strategyConfig.stages || [],
        maxRetries: strategyConfig.maxRetries,
      });

    case 'fan_out': {
      const itemStrategy = strategyConfig.itemStrategy
        ? resolveStrategy(strategyConfig.itemStrategy)
        : new SingleStrategy();
      return new FanOutStrategy({
        itemStrategy,
        tiers: strategyConfig.tiers,
        merge: strategyConfig.merge,
      });
    }

    case 'adaptive':
      return new AdaptiveStrategy({
        single: strategyConfig.single ? resolveStrategy(strategyConfig.single) : undefined,
        pipeline: strategyConfig.pipeline ? resolveStrategy(strategyConfig.pipeline) : undefined,
        fanOut: strategyConfig.fanOut ? resolveStrategy(strategyConfig.fanOut) : undefined,
      });

    default:
      throw new Error(`Unknown strategy type: ${strategyConfig.type}`);
  }
}

/**
 * 获取 Preset 并展开为可用配置
 *
 * @param {string} presetName
 * @param {Object} [overrides] 覆盖 preset 中的特定字段
 * @returns {PresetConfig & { strategyInstance: Strategy }}
 */
export function getPreset(presetName, overrides: any = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown preset: "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}`);

  const merged = {
    ...preset,
    ...overrides,
    capabilities: overrides.capabilities || preset.capabilities,
    policies: overrides.policies || preset.policies,
    persona: { ...preset.persona, ...overrides.persona },
    memory: { ...preset.memory, ...overrides.memory },
  };

  // 解析 strategy
  const strategyConfig = overrides.strategy || preset.strategy;
  merged.strategyInstance = resolveStrategy(strategyConfig);

  return merged;
}

export default { PRESETS, resolveStrategy, getPreset };
