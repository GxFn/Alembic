import { estimateMainlineTokens } from "../core/TextAnalysis.js";

export interface RuntimeTokenBudgetItem {
  readonly id: string;
  readonly text: string;
  readonly tokens?: number | undefined;
}

export interface RuntimeTokenBudgetOptions {
  readonly maxTokens: number;
}

export interface RuntimeTokenBudgetResult<T extends RuntimeTokenBudgetItem> {
  readonly kept: T[];
  readonly dropped: T[];
  readonly tokensUsed: number;
}

/**
 * RuntimeTokenBudget 是运行期注入边界。
 * 中文注释：这里只估算已经构造好的文本，不读取文件、不触发编译期重扫。
 */
export class RuntimeTokenBudget {
  readonly #maxTokens: number;

  constructor(options: RuntimeTokenBudgetOptions) {
    this.#maxTokens = Math.max(0, Math.floor(options.maxTokens));
  }

  apply<T extends RuntimeTokenBudgetItem>(items: readonly T[]): RuntimeTokenBudgetResult<T> {
    const kept: T[] = [];
    const dropped: T[] = [];
    let tokensUsed = 0;

    for (const item of items) {
      const itemTokens = item.tokens ?? estimateMainlineTokens(item.text);
      if (tokensUsed + itemTokens <= this.#maxTokens) {
        kept.push(item);
        tokensUsed += itemTokens;
      } else {
        dropped.push(item);
      }
    }

    return { kept, dropped, tokensUsed };
  }
}
