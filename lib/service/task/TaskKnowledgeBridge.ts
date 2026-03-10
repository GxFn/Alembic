import { type SlimSearchResult, slimSearchResult } from '#service/search/SearchTypes.js';
import { ioLimit } from '#shared/concurrency.js';
import type { Task } from '../../domain/task/Task.js';
import Logger from '../../infrastructure/logging/Logger.js';

// ─── Types ──────────────────────────────────────────────

/** 知识注入的上下文选项（从 prime / ready / claim 透传） */
export interface KnowledgeEnrichOptions {
  /** 用户当前输入（IDE Agent 侧传入） */
  userQuery?: string;
  /** 当前活跃文件路径 */
  activeFile?: string;
  /** 当前编程语言 */
  language?: string;
}

/** 投影后的知识条目（返回给 Agent）— 使用统一投影类型 */
type SlimKnowledgeItem = SlimSearchResult;

/** 单条缓存记录 */
interface CacheEntry {
  context: Record<string, unknown>;
  /** task.title + task.description 的简单 hash，用于检测任务内容变化 */
  contentKey: string;
  /** 缓存写入时间戳 (ms) */
  timestamp: number;
}

// ─── Constants ──────────────────────────────────────────

/**
 * 搜索结果相关性阈值 — 低于此分数的结果不注入
 *
 * 真实分数分布 (BiliDemo, auto 模式 RRF+Ranking):
 *   min=0.434  P10=0.453  P25=0.460  median=0.479  P75=0.495  P90=0.505  max=0.534
 *   所有结果集中在 [0.43, 0.54]，0.15 无法过滤任何噪声。
 *
 * 阈值设定依据:
 *   0.44 — 过滤掉最边缘的低质量尾部结果（约过滤 P5 以下）
 */
const RELEVANCE_THRESHOLD = 0.44;

/** 缓存 TTL (ms) — 5 分钟 */
const CACHE_TTL_MS = 300_000;

/** 技术术语提取正则 */
const TECH_TERM_PATTERNS: RegExp[] = [
  // CamelCase 类名 — 含常见 iOS/Android/Web 后缀
  /\b[A-Z][a-zA-Z]+(?:Controller|ViewController|Service|Manager|Handler|View|Model|Request|Response|Provider|Repository|Factory|Builder|Delegate|Protocol|Router|Coordinator|Cell|Layout|Adapter|Module|Plugin|Monitor|Loader|Store|Cache|Config|Helper|Util|Extension|Category)\b/g,
  // BD / UI / NS 前缀类名 (常见 iOS 项目)
  /\b(?:BD|UI|NS|CG|CA|MK|AV|WK|SK|CL)[A-Z][a-zA-Z]{2,}\b/g,
  // 反引号包裹的代码引用
  /`([^`]+)`/g,
  // 文件名引用 (xxx.swift / xxx.ts / xxx.json 等)
  /\b[\w.-]+\.(?:swift|ts|tsx|js|jsx|py|java|kt|go|rs|rb|cpp|h|m|mm|json|yaml|yml|xml|gradle|plist|xib|storyboard)\b/g,
];

/**
 * TaskKnowledgeBridge — 任务 ↔ 知识桥接服务
 *
 * AutoSnippet 独有能力：返回「带知识上下文的任务」，而非裸任务。
 *
 * 桥接策略（v2 — 用户输入感知 + Multi-Query + 上下文透传 + 缓存）：
 *   1. 任务标题/描述 + 用户输入(userQuery) → Multi-Query 搜索知识库
 *   2. 传递 language / intent 上下文信号 → SearchEngine ContextBoost 生效
 *   3. 关联的 Guard 规则 → 优先嵌入任务上下文
 *   4. 任务级缓存 → 避免重复搜索
 */
export class TaskKnowledgeBridge {
  _search: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } | null;
  logger: ReturnType<typeof Logger.getInstance>;

  /** 任务级知识缓存 (taskId → CacheEntry) */
  private _cache = new Map<string, CacheEntry>();

  constructor(searchEngine: {
    search: (query: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }) {
    this._search = searchEngine;
    this.logger = Logger.getInstance();
  }

  /**
   * 为就绪任务附加知识上下文
   * 并行搜索，不阻塞主流程
   *
   * @param tasks  需要注入知识的任务列表
   * @param options 上下文选项（userQuery / activeFile / language）
   */
  async enrichWithKnowledge(tasks: Task[], options?: KnowledgeEnrichOptions) {
    if (!tasks || tasks.length === 0) {
      return tasks;
    }
    if (!this._search) {
      return tasks;
    }

    const results = await Promise.allSettled(
      tasks.map((task: Task) => ioLimit(() => this._buildContext(task, options)))
    );

    return tasks.map((task: Task, i: number) => {
      if (results[i].status === 'fulfilled' && results[i].value) {
        task.knowledgeContext = results[i].value;
      }
      return task;
    });
  }

  /**
   * 独立搜索 — 仅基于 userQuery 搜索知识（不依赖任何 Task）
   *
   * 场景: prime() 时没有 ready tasks 但有用户输入，直接搜索知识库。
   *
   * @param userQuery 用户输入的原始文本
   * @param options   可选的 language
   */
  async searchForQuery(
    userQuery: string,
    options?: { language?: string }
  ): Promise<Record<string, unknown> | null> {
    if (!this._search || !userQuery?.trim()) {
      return null;
    }

    try {
      const searchResult = await this._search.search(userQuery.trim(), {
        mode: 'auto',
        limit: 8,
        rank: true,
        context: {
          language: options?.language,
          intent: 'user-query-knowledge',
        },
      });

      const allResults = (
        (searchResult?.items || searchResult?.results || []) as Array<Record<string, unknown>>
      ).filter((r) => this._aboveThreshold(r));

      if (allResults.length === 0) {
        return null;
      }

      const knowledge = allResults.filter((r) => r.kind !== 'rule').slice(0, 5);
      const guardRules = allResults.filter((r) => r.kind === 'rule').slice(0, 3);

      return {
        relatedKnowledge: knowledge.map((k) => this._projectItem(k)),
        guardRules: guardRules.map((r) => this._projectItem(r)),
        searchQuery: userQuery.trim(),
      };
    } catch (err: unknown) {
      this.logger.debug('TaskKnowledgeBridge.searchForQuery error', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  // ═══ 私有方法 ═══════════════════════════════════════

  /**
   * 为单个任务构建知识上下文（v2 — multi-query + 上下文 + 缓存）
   */
  private async _buildContext(task: Task, options?: KnowledgeEnrichOptions) {
    const taskQuery = `${task.title} ${task.description}`.trim();
    if (!taskQuery && !options?.userQuery) {
      return null;
    }

    // ── P6: 缓存检查 ──
    const contentKey = this._contentKey(taskQuery, options?.userQuery);
    if (task.id) {
      const cached = this._cache.get(task.id);
      if (
        cached &&
        cached.contentKey === contentKey &&
        Date.now() - cached.timestamp < CACHE_TTL_MS
      ) {
        return cached.context;
      }
    }

    try {
      // ── P2: Multi-Query 策略 ──
      const queries = this._buildSearchQueries(task, options?.userQuery);
      const allResults = await this._multiQuerySearch(queries, {
        language: options?.language,
      });

      // ── P4: 相关性阈值过滤 ──
      const filtered = allResults.filter((r) => this._aboveThreshold(r));

      // ── P4: 分类 & 增强投影 ──
      const knowledge = filtered.filter((r) => r.kind !== 'rule').slice(0, 5);
      const guardRules = filtered.filter((r) => r.kind === 'rule').slice(0, 3);

      const context = {
        relatedKnowledge: knowledge.map((k) => this._projectItem(k)),
        guardRules: guardRules.map((r) => this._projectItem(r)),
        searchQuery: queries.join(' | '),
      };

      // ── P6: 写入缓存 ──
      if (task.id) {
        this._cache.set(task.id, { context, contentKey, timestamp: Date.now() });
        // 限制缓存大小 — 超出 100 条时淘汰最旧的
        if (this._cache.size > 100) {
          const firstKey = this._cache.keys().next().value;
          if (firstKey !== undefined) {
            this._cache.delete(firstKey);
          }
        }
      }

      return context;
    } catch (err: unknown) {
      this.logger.debug('TaskKnowledgeBridge._buildContext error', {
        taskId: task.id,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * P2: 构建多条互补搜索查询
   *
   * 策略:
   *   Q1 (精确): 任务标题 — 通常最精练
   *   Q2 (语义): 用户输入 — 包含更丰富的自然语义
   *   Q3 (关键词): 从描述/用户输入提取技术术语
   *
   */
  private _buildSearchQueries(task: Task, userQuery?: string): string[] {
    const queries: string[] = [];

    // Q1: 任务标题（最精练）
    const title = task.title?.trim();
    if (title) {
      queries.push(title);
    }

    // Q2: 用户原始输入（与标题不同才添加）
    const uq = userQuery?.trim();
    if (uq && uq !== title) {
      queries.push(uq);
    }

    // Q3: 技术术语提取 — 从描述 + 用户输入中提取
    const corpus = [task.description, userQuery].filter(Boolean).join(' ');
    const techTerms = this._extractTechTerms(corpus);
    if (techTerms.length > 0) {
      const termQuery = techTerms.join(' ');
      // 避免与已有查询重复
      if (!queries.includes(termQuery)) {
        queries.push(termQuery);
      }
    }

    // 兜底: 若上述都为空，用 title + description
    if (queries.length === 0) {
      const fallback = `${task.title} ${task.description}`.trim();
      if (fallback) {
        queries.push(fallback);
      }
    }

    return queries;
  }

  /**
   * P2: 从文本中提取技术术语（类名、文件名、API 名等）
   */
  private _extractTechTerms(text: string): string[] {
    if (!text) {
      return [];
    }

    const terms = new Set<string>();
    for (const pattern of TECH_TERM_PATTERNS) {
      // 重置 lastIndex（全局正则复用安全）
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        // 优先取捕获组（反引号中的内容），否则取整个匹配
        const term = (match[1] || match[0]).trim();
        if (term.length >= 2) {
          terms.add(term);
        }
      }
    }
    return [...terms].slice(0, 8); // 最多 8 个术语
  }

  /**
   * P2 + P3: Multi-Query 搜索 + 合并去重
   *
   * 对每个 query 执行搜索（并行），合并结果并按 score 去重保留最高分。
   */
  private async _multiQuerySearch(
    queries: string[],
    options: { language?: string }
  ): Promise<Array<Record<string, unknown>>> {
    if (queries.length === 0) {
      return [];
    }

    // 单 query 直接搜索（优化常见情况）
    if (queries.length === 1) {
      return this._singleSearch(queries[0], options);
    }

    // 多 query 并行搜索
    const searchPromises = queries.map((q) =>
      this._singleSearch(q, options).catch(() => [] as Array<Record<string, unknown>>)
    );
    const resultSets = await Promise.all(searchPromises);

    // 合并去重 — 按 id 保留最高 score
    const merged = new Map<unknown, Record<string, unknown>>();
    for (const results of resultSets) {
      for (const item of results) {
        const existing = merged.get(item.id);
        if (!existing || (item.score as number) > (existing.score as number)) {
          merged.set(item.id, item);
        }
      }
    }

    // 按 score 降序排序
    return [...merged.values()].sort(
      (a, b) => ((b.score as number) || 0) - ((a.score as number) || 0)
    );
  }

  /**
   * 执行单次搜索（含 P3 上下文透传）
   */
  private async _singleSearch(
    query: string,
    options: { language?: string }
  ): Promise<Array<Record<string, unknown>>> {
    const searchResult = await this._search!.search(query, {
      mode: 'auto',
      limit: 8,
      rank: true,
      context: {
        language: options.language,
        intent: 'task-knowledge',
      },
    });
    return (
      (searchResult?.items || searchResult?.results || []) as Array<Record<string, unknown>>
    ).slice(0, 8);
  }

  /**
   * P4: 相关性阈值判断
   */
  private _aboveThreshold(item: Record<string, unknown>): boolean {
    const score = (item.score as number) || 0;
    return score >= RELEVANCE_THRESHOLD;
  }

  /**
   * P4: 增强投影 — 使用统一 slimSearchResult() 投影函数
   */
  private _projectItem(item: Record<string, unknown>): SlimKnowledgeItem {
    return slimSearchResult(item as Parameters<typeof slimSearchResult>[0]);
  }

  /**
   * P6: 缓存键 — 基于 taskQuery + userQuery 的内容指纹
   */
  private _contentKey(taskQuery: string, userQuery?: string): string {
    return `${taskQuery}||${userQuery || ''}`;
  }

  /** 清除全部缓存（测试 / 索引重建后使用） */
  clearCache() {
    this._cache.clear();
  }
}

export default TaskKnowledgeBridge;
