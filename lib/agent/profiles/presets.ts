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

import { BudgetPolicy, QualityGatePolicy, SafetyPolicy } from '../policies/index.js';
// v3.0: 导入 Insight prompt/strategy templates
import {
  ANALYST_BUDGET,
  ANALYST_SYSTEM_PROMPT,
  buildAnalystPrompt,
} from '../prompts/insight-analyst.js';
import {
  buildEvolverPrompt,
  EVOLVER_BUDGET,
  EVOLVER_SYSTEM_PROMPT,
  type EvolutionContext,
} from '../prompts/insight-evolver.js';
import {
  buildRetryPrompt,
  evolutionGateEvaluator,
  insightGateEvaluator,
} from '../prompts/insight-gate.js';
import {
  buildProducerPromptV2,
  PRODUCER_BUDGET,
  PRODUCER_SYSTEM_PROMPT,
  producerRejectionGateEvaluator,
} from '../prompts/insight-producer.js';
import {
  AdaptiveStrategy,
  FanOutStrategy,
  SingleStrategy,
  type Strategy,
} from '../strategies/index.js';
import { PipelineStrategy } from '../strategies/PipelineStrategy.js';

// ─── Types ─────────────────────────────────────

/** Policy factory configuration */
interface PolicyFactoryConfig {
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
}

/** Tool call record shape used in retry logic */
interface ToolCallRecord {
  tool?: string;
  name?: string;
  args?: unknown;
  result?: string | { status?: string; reason?: string };
}

/** Minimal pipeline stage shape (compatible with PipelineStrategy's PipelineStage) */
interface MinimalStage {
  name: string;
  [key: string]: unknown;
}

/** Strategy-level merge result (structurally matches StrategyResult from strategies.ts) */
interface StrategyMergeResult {
  reply: string;
  toolCalls: Array<Record<string, unknown>>;
  tokenUsage: { input: number; output: number };
  iterations: number;
  [key: string]: unknown;
}

/** Declarative strategy configuration (resolved by resolveStrategy) */
interface StrategyConfig {
  type: string;
  stages?: MinimalStage[];
  maxRetries?: number;
  itemStrategy?: StrategyConfig;
  tiers?: Record<string, { concurrency: number }>;
  merge?: (...args: unknown[]) => StrategyMergeResult;
  single?: StrategyConfig;
  pipeline?: StrategyConfig;
  fanOut?: StrategyConfig;
}

function buildEvolutionRetryPrompt(
  retryCtx: { reason?: string; artifact?: unknown },
  _origPrompt: string,
  prev: Record<string, unknown>
) {
  const artifact = (retryCtx.artifact || {}) as {
    processed?: number;
    totalRecipes?: number;
    pendingIds?: string[];
  };
  const pendingIds = Array.isArray(artifact.pendingIds) ? artifact.pendingIds : [];
  const prevReply = (prev.evolve as { reply?: string } | undefined)?.reply || '';
  const pendingList = pendingIds.length
    ? pendingIds.map((id) => `- ${id}`).join('\n')
    : '- （无法从 gate artifact 解析，按原始 Recipe 清单逐条补齐）';

  return `⚠️ Evolution Gate 未通过: ${retryCtx.reason || '存在未提交决策的 Recipe'}

你上一轮可能已经完成了阅读和分析，但没有为所有 Recipe 调用 \`knowledge.manage\`。现在进入决策补写阶段：

- 当前回复必须只调用 \`knowledge({ action: "manage", params: ... })\`，不要先输出自然语言
- 禁止继续调用 \`knowledge.search\`、\`knowledge.detail\`、\`code\`、\`graph\` 或其他探索工具；待处理 ID 不是搜索词
- 不要输出 Markdown 报告来替代工具调用；输出正文会被视为未完成
- Recipe 标识字段必须是 \`id\`，禁止使用 \`recipeId\`
- 对每个待处理 Recipe 必须调用以下三种之一:
  - \`knowledge({ action: "manage", params: { "operation": "skip_evolution", "id": "...", "reason": "验证有效: ..." } })\`
  - \`knowledge({ action: "manage", params: { "operation": "evolve", "id": "...", "reason": "...", "data": { "description": "...", "evidence": { "currentCode": "..." }, "confidence": 0.85 } } })\`
  - \`knowledge({ action: "manage", params: { "operation": "deprecate", "id": "...", "reason": "...", "data": { "confidence": 0.7 } } })\`
- 如果证据不足，也必须立刻用 \`skip_evolution\` 显式记录“信息不足”，不能留空

待补决策 Recipe ID:
${pendingList}

上一轮分析摘要（仅供你决定，不可当作最终结果）:
${prevReply.slice(0, 3000)}`;
}

// ─── Preset 定义 ──────────────────────────────

/** 所有内置 Preset */
export const PRESETS = Object.freeze({
  // ─── chat: 通用对话 ──────────────────────

  chat: {
    name: '对话',
    description: '多轮对话、知识检索、代码问答。适用于 Dashboard 和飞书的常规对话。',
    capabilities: ['conversation', 'code_analysis'],
    strategy: { type: 'single' },
    policies: [
      (config?: PolicyFactoryConfig) =>
        new BudgetPolicy({
          maxIterations: config?.maxIterations ?? 8,
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.7,
          timeoutMs: config?.timeoutMs ?? 120_000,
        }),
    ],
    persona: {
      role: 'assistant',
      description: 'Alembic 知识管理助手',
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
  // bootstrap-dimension profile 通过 AgentStageFactoryRegistry 按需覆盖
  // onToolCall 由 orchestrator 按维度注入 (闭包引用 ActiveContext)

  insight: {
    name: '洞察',
    description:
      '深度代码分析 + 知识提取。增强 PipelineStrategy: Analyze→QualityGate→Produce→RejectionGate。',
    capabilities: ['code_analysis', 'knowledge_production'],
    strategy: {
      type: 'pipeline',
      maxRetries: 1,
      stages: [
        // ── Phase 1: Analyst ──
        {
          name: 'analyze',
          capabilities: ['code_analysis'],
          budget: {
            maxIterations: ANALYST_BUDGET.maxIterations,
            temperature: 0.4,
            timeoutMs: 480_000,
            maxSessionTokens: ANALYST_BUDGET.maxSessionTokens,
            maxSessionInputTokens: ANALYST_BUDGET.maxSessionInputTokens,
          },
          systemPrompt: ANALYST_SYSTEM_PROMPT,
          promptBuilder: (ctx: Record<string, unknown>) =>
            buildAnalystPrompt(
              ctx.dimConfig as Parameters<typeof buildAnalystPrompt>[0],
              ctx.projectInfo as Parameters<typeof buildAnalystPrompt>[1],
              ctx.dimContext as Parameters<typeof buildAnalystPrompt>[2],
              ctx.sessionStore as Parameters<typeof buildAnalystPrompt>[3],
              ctx.semanticMemory as Parameters<typeof buildAnalystPrompt>[4],
              ctx.codeEntityGraph as Parameters<typeof buildAnalystPrompt>[5],
              ctx.rescanContext as Parameters<typeof buildAnalystPrompt>[6],
              ctx.panorama as Parameters<typeof buildAnalystPrompt>[7],
              ctx.evidenceStarters as Parameters<typeof buildAnalystPrompt>[8],
              ctx.gateArtifact as Parameters<typeof buildAnalystPrompt>[9],
              ctx.toolPolicyHints as Parameters<typeof buildAnalystPrompt>[10]
            ),
          retryPromptBuilder: (
            retryCtx: { reason?: string },
            _origPrompt: string,
            prev: Record<string, unknown>
          ) => {
            const prevAnalysis = (prev.analyze as { reply?: string } | undefined)?.reply || '';
            const retryHint = buildRetryPrompt(retryCtx.reason ?? '');
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
          budget: { ...PRODUCER_BUDGET, temperature: 0.3, timeoutMs: 360_000 },
          systemPrompt: PRODUCER_SYSTEM_PROMPT,
          promptBuilder: (ctx: Record<string, unknown>) =>
            buildProducerPromptV2(
              ctx.gateArtifact as Parameters<typeof buildProducerPromptV2>[0], // 来自 quality_gate 的 AnalysisArtifact
              ctx.dimConfig as Parameters<typeof buildProducerPromptV2>[1],
              ctx.projectInfo as Parameters<typeof buildProducerPromptV2>[2],
              ctx.rescanContext as Parameters<typeof buildProducerPromptV2>[3],
              ctx.panorama as Parameters<typeof buildProducerPromptV2>[4],
              ctx.toolPolicyHints as Parameters<typeof buildProducerPromptV2>[5]
            ),
          // 拒绝率过高时: 缩减预算 + 特定修复 prompt (对齐旧 ProducerAgent 的 rejection retry)
          retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 120_000 },
          retryPromptBuilder: (
            retryCtx: { reason?: string },
            _origPrompt: string,
            prev: Record<string, unknown>
          ) => {
            const prevProduce = prev.produce as { toolCalls?: ToolCallRecord[] } | undefined;
            const submitCalls = (prevProduce?.toolCalls || []).filter(
              (tc) => (tc.tool || tc.name) === 'knowledge'
            );
            const rejected = submitCalls.filter((tc) => {
              const res = tc.result;
              if (!res) {
                return false;
              }
              if (typeof res === 'string') {
                return res.includes('rejected') || res.includes('error');
              }
              return (
                res.status === 'rejected' ||
                res.status === 'error' ||
                res.reason === 'validation_failed'
              );
            }).length;
            return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明（为什么这样设计）
4. 包含来源标注 (来源: FileName.m:行号)
5. 标题使用项目真实类名，不以项目名开头
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
      (config?: PolicyFactoryConfig) =>
        new BudgetPolicy({
          maxIterations: config?.maxIterations ?? 24,
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.3,
          timeoutMs: config?.timeoutMs ?? 3_600_000,
          // Session token 限制由 BudgetController 统一管理
          // (基于 computeAnalystBudget 动态计算，与 contextWindowBudget 对齐)
        }),
      (config?: PolicyFactoryConfig) =>
        new QualityGatePolicy({
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

  // ─── evolution: 衰退 Recipe 进化决策 ─────────

  evolution: {
    name: '进化',
    description: '审查衰退 Recipe，决定进化（supersede）、废弃或跳过。Evolve→EvolutionGate。',
    capabilities: ['evolution_analysis'],
    strategy: {
      type: 'pipeline',
      maxRetries: 1,
      stages: [
        // ── Phase 1: Evolver ──
        {
          name: 'evolve',
          capabilities: ['evolution_analysis'],
          budget: {
            ...EVOLVER_BUDGET,
            temperature: 0.3,
            timeoutMs: 180_000,
          },
          systemPrompt: EVOLVER_SYSTEM_PROMPT,
          promptBuilder: (ctx: Record<string, unknown>) =>
            buildEvolverPrompt(null, null, ctx as unknown as EvolutionContext),
          retryPromptBuilder: buildEvolutionRetryPrompt,
          decisionOnlyOnRetry: true,
        },
        // ── Phase 2: Evolution Gate ──
        {
          name: 'evolution_gate',
          gate: {
            evaluator: evolutionGateEvaluator,
            useCumulativeToolCalls: true,
            maxRetries: 8,
          },
        },
      ],
    },
    policies: [
      (config?: PolicyFactoryConfig) =>
        new BudgetPolicy({
          maxIterations: config?.maxIterations ?? 16,
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.3,
          timeoutMs: config?.timeoutMs ?? 180_000,
        }),
    ],
    persona: {
      role: 'analyst',
      description: '知识进化专家',
    },
    memory: {
      enabled: false,
    },
  },

  // ─── lark: 飞书知识管理对话 ─────────────

  lark: {
    name: '飞书对话',
    description: '通过飞书自然语言进行知识管理、代码分析、项目理解。服务端直接处理，不转发 IDE。',
    capabilities: ['conversation', 'code_analysis'],
    strategy: { type: 'single' },
    policies: [
      (config?: PolicyFactoryConfig) =>
        new BudgetPolicy({
          maxIterations: config?.maxIterations ?? 12,
          maxTokens: config?.maxTokens ?? 4096,
          temperature: config?.temperature ?? 0.7,
          timeoutMs: config?.timeoutMs ?? 180_000,
        }),
      () =>
        new SafetyPolicy({
          allowedSenders: process.env.ALEMBIC_LARK_ALLOWED_USERS?.split(',').filter(Boolean) || [],
        }),
    ],
    persona: {
      role: 'assistant',
      description: 'Alembic 知识管理助手 (飞书)。用中文回复，简洁专业。',
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
      (config?: PolicyFactoryConfig) =>
        new BudgetPolicy({
          maxIterations: config?.maxIterations ?? 6,
          maxTokens: config?.maxTokens ?? 2048,
          temperature: config?.temperature ?? 0.5,
          timeoutMs: config?.timeoutMs ?? 60_000,
        }),
      () =>
        new SafetyPolicy({
          allowedSenders: process.env.ALEMBIC_LARK_ALLOWED_USERS?.split(',').filter(Boolean) || [],
          fileScope: process.env.ALEMBIC_PROJECT_ROOT,
        }),
    ],
    persona: {
      role: 'assistant',
      description: 'Alembic 远程编程助手',
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
 * @param strategyConfig { type: 'single'|'pipeline'|'fan_out'|'adaptive', ...opts }
 */
export function resolveStrategy(strategyConfig: StrategyConfig | null | undefined): Strategy {
  if (!strategyConfig) {
    return new SingleStrategy();
  }

  switch (strategyConfig.type) {
    case 'single':
      return new SingleStrategy();

    case 'pipeline':
      return new PipelineStrategy({
        stages: strategyConfig.stages || [],
        maxRetries: strategyConfig.maxRetries,
      });

    case 'fan_out': {
      const itemStrategy: Strategy = strategyConfig.itemStrategy
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
 * @param [overrides] 覆盖 preset 中的特定字段
 * @returns }
 */
export function getPreset(presetName: string, overrides: Record<string, unknown> = {}) {
  const preset = (PRESETS as Record<string, Record<string, unknown>>)[presetName];
  if (!preset) {
    throw new Error(
      `Unknown preset: "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}`
    );
  }

  const merged: Record<string, unknown> = {
    ...preset,
    ...overrides,
    capabilities: overrides.capabilities || preset.capabilities,
    policies: overrides.policies || preset.policies,
    persona: {
      ...(preset.persona as Record<string, unknown>),
      ...(overrides.persona as Record<string, unknown>),
    },
    memory: {
      ...(preset.memory as Record<string, unknown>),
      ...(overrides.memory as Record<string, unknown>),
    },
  };

  // 解析 strategy
  const strategyConfig = (overrides.strategy || preset.strategy) as StrategyConfig | undefined;
  merged.strategyInstance = resolveStrategy(strategyConfig);

  return merged;
}

export default { PRESETS, resolveStrategy, getPreset };
