/**
 * ToolContextFactory — 为每次 V2 工具调用组装 ToolContext。
 *
 * 长生命周期资源 (DeltaCache/SearchCache/Compressor/SessionStore)
 * 在 Factory 构造时创建一次，跨调用复用。
 * 重量级 DI 服务 (projectGraph/searchEngine 等) 按需从容器获取。
 */

import type { ToolCallRequest } from '#tools/core/ToolContracts.js';
import { DeltaCache } from '../cache/DeltaCache.js';
import { SearchCache } from '../cache/SearchCache.js';
import { OutputCompressor } from '../compressor/OutputCompressor.js';
import type { ToolContext } from '../types.js';

interface ServiceContainer {
  get(name: string): unknown;
}

interface SimpleEntry {
  key: string;
  content: string;
  meta?: Record<string, unknown>;
  timestamp: number;
}

class SimpleSessionStore {
  #entries: SimpleEntry[] = [];

  save(key: string, content: string, meta?: Record<string, unknown>) {
    this.#entries.push({ key, content, meta, timestamp: Date.now() });
  }

  recall(query?: string, opts?: { tags?: string[]; limit?: number }) {
    let results = [...this.#entries];
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (e) => e.key.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)
      );
    }
    if (opts?.tags?.length) {
      results = results.filter((e) =>
        opts.tags?.some((t) => (e.meta?.tags as string[] | undefined)?.includes(t))
      );
    }
    const limit = opts?.limit ?? 20;
    return results.slice(-limit).map(({ key, content, meta }) => ({ key, content, meta }));
  }
}

export interface ToolContextFactoryDeps {
  container: ServiceContainer;
  projectRoot: string;
  defaultTokenBudget?: number;
}

export class ToolContextFactory {
  readonly #deps: ToolContextFactoryDeps;
  readonly #deltaCache: DeltaCache;
  readonly #searchCache: SearchCache;
  readonly #compressor: OutputCompressor;
  readonly #sessionStore: SimpleSessionStore;

  constructor(deps: ToolContextFactoryDeps) {
    this.#deps = deps;
    this.#deltaCache = new DeltaCache(200);
    this.#searchCache = new SearchCache(100);
    this.#compressor = new OutputCompressor();
    this.#sessionStore = new SimpleSessionStore();
  }

  create(request: ToolCallRequest): ToolContext {
    const c = this.#deps.container;

    return {
      projectRoot: this.#deps.projectRoot,

      projectGraph: tryGet(c, 'projectGraph'),
      codeEntityGraph: tryGet(c, 'codeEntityGraph'),
      searchEngine: tryGet(c, 'searchEngine'),
      recipeGateway: tryGet(c, 'recipeProductionGateway'),
      knowledgeRepo: tryGet(c, 'knowledgeRepository'),
      astAnalyzer: tryGet(c, 'astAnalyzer'),
      safetyPolicy: request.runtime?.safetyPolicy ?? undefined,

      deltaCache: this.#deltaCache,
      searchCache: this.#searchCache,
      compressor: this.#compressor,
      sessionStore: this.#sessionStore,

      tokenBudget: this.#deps.defaultTokenBudget ?? 8000,
      abortSignal: request.abortSignal ?? undefined,
    };
  }
}

function tryGet(container: ServiceContainer, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return undefined;
  }
}
