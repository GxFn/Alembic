import { createLimit } from '#shared/concurrency.js';
import { AgentEventBus, AgentEvents } from '../runtime/AgentEventBus.js';
import { AgentMessage } from '../runtime/AgentMessage.js';
import { SingleStrategy } from './SingleStrategy.js';
import {
  type FanOutItem,
  type ItemResult,
  Strategy,
  type StrategyResult,
  type StrategyRuntime,
} from './Strategy.js';

interface FanOutOpts {
  itemStrategy?: Strategy;
  tiers?: Record<string, { concurrency: number }>;
  merge?: (results: ItemResult[]) => StrategyResult;
}

interface FanOutExecuteOpts {
  items?: FanOutItem[];
  dimension?: FanOutItem;
  [key: string]: unknown;
}

export class FanOutStrategy extends Strategy {
  #itemStrategy!: Strategy;
  #tiers!: Record<string, { concurrency: number }>;
  #merge!: (results: ItemResult[]) => StrategyResult;

  constructor({ itemStrategy, tiers, merge }: FanOutOpts = {}) {
    super();
    this.#itemStrategy = itemStrategy || new SingleStrategy();
    this.#tiers = tiers || { 1: { concurrency: 3 } };
    this.#merge = merge || FanOutStrategy.#defaultMerge;
  }

  get name() {
    return 'fan_out';
  }

  async execute(runtime: StrategyRuntime, message: AgentMessage, opts: FanOutExecuteOpts = {}) {
    const { items = [] } = opts;
    const bus = AgentEventBus.getInstance();

    if (items.length === 0) {
      return {
        reply: 'No items to process',
        toolCalls: [],
        tokenUsage: { input: 0, output: 0 },
        iterations: 0,
      };
    }

    const tierGroups = this.#groupByTier(items);
    const allResults: ItemResult[] = [];

    for (const [tier, tierItems] of Object.entries(tierGroups).sort(
      ([a], [b]) => Number(a) - Number(b)
    )) {
      const tierConfig = this.#tiers[tier] || this.#tiers[1] || { concurrency: 2 };

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_start',
        tier: Number(tier),
        count: (tierItems as FanOutItem[]).length,
        concurrency: tierConfig.concurrency,
      });

      const limit = createLimit(tierConfig.concurrency);
      const tierResults = await Promise.all(
        (tierItems as FanOutItem[]).map((item: FanOutItem) =>
          limit(async () => {
            const itemMessage = AgentMessage.internal(
              item.prompt ||
                `${message.content}\n\n## 当前维度: ${item.label}\n${item.guide || ''}`,
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
                abortSignal: opts.abortSignal,
              });
              return { id: item.id, label: item.label, status: 'completed' as const, ...result };
            } catch (err: unknown) {
              return {
                id: item.id,
                label: item.label,
                status: 'failed' as const,
                error: err instanceof Error ? err.message : String(err),
                reply: '',
                toolCalls: [],
                tokenUsage: { input: 0, output: 0 },
              };
            }
          })
        )
      );
      allResults.push(...tierResults);

      bus.publish(AgentEvents.PROGRESS, {
        type: 'fan_out_tier_done',
        tier: Number(tier),
        completed: allResults.filter((r) => r.status === 'completed').length,
        failed: allResults.filter((r) => r.status === 'failed').length,
      });
    }

    return this.#merge(allResults);
  }

  #groupByTier(items: FanOutItem[]) {
    const groups: Record<string, FanOutItem[]> = {};
    for (const item of items) {
      const tier = item.tier || 1;
      if (!groups[tier]) {
        groups[tier] = [];
      }
      groups[tier].push(item);
    }
    return groups;
  }

  static #defaultMerge(results: ItemResult[]): StrategyResult {
    const successful = results.filter((r: ItemResult) => r.status === 'completed');
    const failed = results.filter((r: ItemResult) => r.status === 'failed');
    return {
      reply: [
        `## 执行总结\n完成: ${successful.length}, 失败: ${failed.length}\n`,
        ...successful.map((r: ItemResult) => `### ${r.label}\n${r.reply || '(无输出)'}`),
        ...failed.map((r: ItemResult) => `### ${r.label} ❌\n${r.error}`),
      ].join('\n\n'),
      toolCalls: results.flatMap((r: ItemResult) => r.toolCalls || []),
      tokenUsage: {
        input: results.reduce((sum: number, r: ItemResult) => sum + (r.tokenUsage?.input || 0), 0),
        output: results.reduce(
          (sum: number, r: ItemResult) => sum + (r.tokenUsage?.output || 0),
          0
        ),
      },
      iterations: results.reduce((sum: number, r: ItemResult) => sum + (r.iterations || 0), 0),
      itemResults: results,
    };
  }
}
