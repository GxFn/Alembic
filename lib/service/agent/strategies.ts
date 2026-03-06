/**
 * Strategies — Agent 执行策略
 *
 * 核心思想: "如何组织工作" 与 "能做什么" 正交。
 *
 * 四种策略:
 *   1. SingleStrategy   — 单次 ReAct 循环 (最简单，用于对话)
 *   2. PipelineStrategy — 顺序多阶段 + 质量门控 (分析→提交)
 *   3. FanOutStrategy   — 并行执行 + 合并 (多维度冷启动)
 *   4. AdaptiveStrategy — 运行时自动选择策略 (智能模式)
 *
 * 这就是为什么 "冷启动" 和 "扫描" 产出一致:
 *   - 冷启动 = FanOut(items=dimensions, itemStrategy=Pipeline(analyze→gate→produce))
 *   - 扫描   = Pipeline(analyze→gate→produce)
 *   - 唯一区别: 作用域 (全项目 vs 单目录) 和并行度
 *
 * 借鉴:
 *   - Anthropic: Prompt Chaining, Parallelization, Orchestrator-Worker
 *   - LangGraph: StateGraph, parallel branches
 *   - AutoGen: Sequential/Parallel teams
 *
 * @module strategies
 */

import { AgentEventBus, AgentEvents } from './AgentEventBus.js';
import { AgentMessage } from './AgentMessage.js';

// ─── Base Strategy ─────────────────────────────

/**
 * Strategy 基类 — 定义 Agent 如何组织工作
 */
export class Strategy {
  /** @type {string} */
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  /**
   * 执行策略
   *
   * @param {Object} _runtime - AgentRuntime 实例
   * @param {import('./AgentMessage.js').AgentMessage} _message 输入消息
   * @param {Object} [_opts] 策略特定选项
   * @returns {Promise<StrategyResult>}
   *
   * @typedef {Object} StrategyResult
   * @property {string} reply 最终文本回复
   * @property {Array} toolCalls 所有工具调用记录
   * @property {Object} tokenUsage - Token 统计
   * @property {number} iterations 总循环次数
   * @property {Object} [phases] 阶段详情 (Pipeline/FanOut)
   */
  async execute(_runtime: any, _message: any, _opts?: any): Promise<any> {
    throw new Error('Subclass must implement execute()');
  }
}

// PipelineStrategy 已提取到独立模块: ./PipelineStrategy.js
// 注意: 不在此处 re-export，因为 PipelineStrategy 需要 import Strategy 形成循环依赖

// ─── SingleStrategy — 直接 ReAct ─────────────

/**
 * 最简单的策略: 直接运行 ReAct 循环。
 *
 * 适合: 用户对话、简单分析、任何单步骤任务。
 *
 * 等价于 Anthropic 的 "Augmented LLM" 模式。
 */
export class SingleStrategy extends Strategy {
  get name() {
    return 'single';
  }

  async execute(runtime: any, message: any, opts: any = {}) {
    return runtime.reactLoop(message.content, {
      history: message.history,
      context: message.metadata.context || {},
      ...opts,
    });
  }
}

// ─── FanOutStrategy — 并行执行 ──────────────

/**
 * 并行执行多个子任务，每个子任务使用 itemStrategy (通常是 Pipeline)。
 * 支持分层并发控制 (Tier)。
 *
 * 适合: 冷启动多维度、批量分析
 *
 * 等价于 Anthropic 的 "Parallelization" + "Orchestrator-Worker" 组合。
 *
 * @example
 * new FanOutStrategy({
 *   itemStrategy: new PipelineStrategy({
 *     stages: [
 *       { name: 'analyze', capabilities: ['code_analysis'], budget: { maxIterations: 24 } },
 *       { name: 'gate', gate: { minEvidenceLength: 500, minFileRefs: 3 } },
 *       { name: 'produce', capabilities: ['knowledge_production'], budget: { maxIterations: 24 },
 *         promptTransform: (_, prev) => `将以下分析转为知识候选:\n${prev.analyze.reply}` },
 *     ],
 *   }),
 *   tiers: { 1: { concurrency: 3 }, 2: { concurrency: 2 }, 3: { concurrency: 1 } },
 * })
 */
export class FanOutStrategy extends Strategy {
  /** @type {Strategy} 每个子任务的执行策略 */
  #itemStrategy;
  /** @type {Object} 分层并发配置 */
  #tiers;
  /** @type {Function} 结果合并函数 */
  #merge;

  /**
   * @param {Object} opts
   * @param {Strategy} opts.itemStrategy 每个子任务使用的策略
   * @param {Object} [opts.tiers] - { 1: { concurrency: 3 }, 2: { concurrency: 2 }, ... }
   * @param {Function} [opts.merge] 自定义合并函数 (results[]) => finalResult
   */
  constructor({ itemStrategy, tiers, merge }: any = {}) {
    super();
    this.#itemStrategy = itemStrategy || new SingleStrategy();
    this.#tiers = tiers || { 1: { concurrency: 3 } };
    this.#merge = merge || FanOutStrategy.#defaultMerge;
  }

  get name() {
    return 'fan_out';
  }

  /**
   * @param {Object} runtime
   * @param {import('./AgentMessage.js').AgentMessage} message
   * @param {Object} opts
   * @param {Array<{id: string, label: string, tier?: number, prompt?: string, guide?: string}>} opts.items 子任务列表
   */
  async execute(runtime: any, message: any, opts: any = {}) {
    const { items = [] } = opts;
    const bus = AgentEventBus.getInstance()!;

    if (items.length === 0) {
      return {
        reply: 'No items to process',
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
      };
    }

    // 按 tier 分组
    const tierGroups = this.#groupByTier(items);
    const allResults: any[] = [];

    for (const [tier, tierItems] of Object.entries(tierGroups).sort(
      ([a], [b]) => Number(a) - Number(b)
    )) {
      const tierConfig = this.#tiers[tier] || this.#tiers[1] || { concurrency: 2 };

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_start',
        tier: Number(tier),
        count: (tierItems as any).length,
        concurrency: tierConfig.concurrency,
      });

      // 按并发度分批执行
      const chunks = this.#chunk(tierItems, tierConfig.concurrency);
      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (item: any) => {
          const itemMessage = AgentMessage.internal(
            item.prompt || `${message.content}\n\n## 当前维度: ${item.label}\n${item.guide || ''}`,
            {
              sessionId: message.session.id,
              dimension: item.id,
              parentAgentId: runtime.id,
              history: message.history,
              metadata: { ...message.metadata, dimension: item },
            }
          );

          bus.publish(AgentEvents.PROGRESS, {
            type: 'fan_out_item_start',
            itemId: item.id,
            label: item.label,
          });

          try {
            const result = await this.#itemStrategy.execute(runtime, itemMessage, {
              dimension: item,
            });
            return { id: item.id, label: item.label, status: 'completed', ...result };
          } catch (err: any) {
            return {
              id: item.id,
              label: item.label,
              status: 'failed',
              error: err.message,
              reply: '',
              toolCalls: [],
              tokenUsage: { input: 0, output: 0 },
            };
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        allResults.push(...chunkResults);
      }

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_done',
        tier: Number(tier),
        completed: allResults.filter((r) => r.status === 'completed').length,
        failed: allResults.filter((r) => r.status === 'failed').length,
      });
    }

    return this.#merge(allResults);
  }

  #groupByTier(items: any) {
    const groups: Record<string, any> = {};
    for (const item of items) {
      const tier = item.tier || 1;
      if (!groups[tier]) {
        groups[tier] = [];
      }
      groups[tier].push(item);
    }
    return groups;
  }

  #chunk(arr: any, size: any) {
    const chunks: any[] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  static #defaultMerge(results: any) {
    const successful = results.filter((r: any) => r.status === 'completed');
    const failed = results.filter((r: any) => r.status === 'failed');
    return {
      reply: [
        `## 执行总结\n完成: ${successful.length}, 失败: ${failed.length}\n`,
        ...successful.map((r: any) => `### ${r.label}\n${r.reply || '(无输出)'}`),
        ...failed.map((r: any) => `### ${r.label} ❌\n${r.error}`),
      ].join('\n\n'),
      toolCalls: results.flatMap((r: any) => r.toolCalls || []),
      tokenUsage: {
        input: results.reduce((sum: any, r: any) => sum + (r.tokenUsage?.input || 0), 0),
        output: results.reduce((sum: any, r: any) => sum + (r.tokenUsage?.output || 0), 0),
      },
      iterations: results.reduce((sum: any, r: any) => sum + (r.iterations || 0), 0),
      itemResults: results,
    };
  }
}

// ─── AdaptiveStrategy — 智能自适应 ──────────

/**
 * 根据输入复杂度自动选择合适的策略。
 *
 * 判断逻辑:
 *   - 简单问答 → SingleStrategy
 *   - 单模块深度分析 → PipelineStrategy
 *   - 多维度/全项目 → FanOutStrategy
 *
 * 等价于 LangGraph 的 Router 节点 + 条件边。
 *
 * @example
 * new AdaptiveStrategy({
 *   single: new SingleStrategy(),
 *   pipeline: new PipelineStrategy({ stages: [...] }),
 *   fanOut: new FanOutStrategy({ itemStrategy: ..., tiers: ... }),
 * })
 */
export class AdaptiveStrategy extends Strategy {
  #strategies;

  /**
   * @param {Object} [strategies]
   * @param {Strategy} [strategies.single]
   * @param {Strategy} [strategies.pipeline]
   * @param {Strategy} [strategies.fanOut]
   */
  constructor(strategies: any = {}) {
    super();
    this.#strategies = {
      single: strategies.single || new SingleStrategy(),
      pipeline: strategies.pipeline || null,
      fanOut: strategies.fanOut || null,
    };
  }

  get name() {
    return 'adaptive';
  }

  async execute(runtime: any, message: any, opts: any = {}) {
    const complexity = this.#assessComplexity(message, opts);
    const bus = AgentEventBus.getInstance()!;

    bus.publish(AgentEvents.PROGRESS, {
      type: 'adaptive_classification',
      complexity,
      selectedStrategy: complexity,
    });

    // fan_out → pipeline → single 降级链
    if (complexity === 'fan_out' && this.#strategies.fanOut) {
      return this.#strategies.fanOut.execute(runtime, message, opts);
    }
    if ((complexity === 'fan_out' || complexity === 'pipeline') && this.#strategies.pipeline) {
      return this.#strategies.pipeline.execute(runtime, message, opts);
    }
    return this.#strategies.single.execute(runtime, message, opts);
  }

  /**
   * 复杂度评估
   */
  #assessComplexity(message: any, opts: any) {
    const text = message.content.toLowerCase();

    // 有显式 items → fan_out
    if (opts.items?.length > 1) {
      return 'fan_out';
    }

    // 关键词启发
    if (/冷启动|cold[\s-]?start|bootstrap|全项目|所有.*维度|all.*dimensions/i.test(text)) {
      return 'fan_out';
    }

    if (/深度.*分析|扫描|审计|scan|deep.*analy|audit|知识提取|extract/i.test(text)) {
      return 'pipeline';
    }

    return 'single';
  }
}

// ─── Strategy 注册表 ─────────────────────────

export const StrategyRegistry = {
  _registry: new Map([
    ['single', SingleStrategy],
    // 'pipeline' 由 PipelineStrategy.js 自注册 (避免循环依赖)
    ['fan_out', FanOutStrategy],
    ['adaptive', AdaptiveStrategy],
  ]),

  create(name: any, opts: any = {}) {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    return new (Cls as any)(opts);
  },

  register(name: any, cls: any) {
    this._registry.set(name, cls);
  },
};

export default { Strategy, SingleStrategy, FanOutStrategy, AdaptiveStrategy, StrategyRegistry };
