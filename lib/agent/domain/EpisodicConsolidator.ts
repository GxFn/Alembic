/**
 * EpisodicConsolidator — Episodic → Semantic 固化引擎
 *
 * Bootstrap 完成后，将 SessionStore (Tier 2) 中的维度分析结果
 * 提炼为结构化记忆，固化到 PersistentMemory (Tier 3)。
 *
 * 固化策略 (规则化，无需额外 AI 调用):
 *   1. 从每个维度的 findings 提取 fact 记忆
 *   2. 从 Tier Reflections 的 crossDimensionPatterns 提取 insight 记忆
 *   3. 从 analysisText 中提取项目级别事实 (正则匹配)
 *   4. 使用 PersistentMemory.consolidate() 进行去重和合并
 *
 * @module EpisodicConsolidator
 */

import Logger from '#infra/logging/Logger.js';

// ────────────────────────────────────────────────────────────
// 本地类型定义
// ────────────────────────────────────────────────────────────

/** Logger 最小接口 */
interface ConsolidatorLogger {
  info(msg: string): void;
}

/** PersistentMemory 最小接口 */
interface PersistentMemoryLike {
  clearBootstrapMemories(): number;
  compact(): void;
  consolidate(
    candidates: CandidateMemoryEntry[],
    opts?: { bootstrapSession?: string }
  ): ConsolidateResult;
}

/** 固化结果 */
interface ConsolidateResult {
  added: number;
  updated: number;
  merged: number;
  skipped: number;
}

/** 候选记忆条目 */
interface CandidateMemoryEntry {
  type: string;
  content: string;
  source: string;
  importance: number;
  sourceDimension?: string;
  sourceEvidence?: string;
  relatedEntities?: string[];
  tags: string[];
}

/** 维度发现 */
interface FindingLike {
  finding?: string;
  evidence?: string;
  importance?: number;
  dimId?: string;
}

/** 维度报告 */
interface DimensionReportLike {
  analysisText?: string;
  findings?: FindingLike[];
}

/** Tier 反思 */
interface TierReflectionLike {
  tierIndex: number;
  completedDimensions?: string[];
  topFindings?: FindingLike[];
  crossDimensionPatterns?: string[];
  suggestionsForNextTier?: string[];
}

/** SessionStore 最小接口 */
interface SessionStoreLike {
  getCompletedDimensions(): string[];
  getDimensionReport(dimId: string): DimensionReportLike | undefined;
  toJSON(): { tierReflections?: TierReflectionLike[] };
}

// ──────────────────────────────────────────────────────────────
// 正则: 从分析文本中提取陈述性知识
// ──────────────────────────────────────────────────────────────

/**
 * 匹配常见的项目事实陈述模式:
 *   - "项目使用 XX 模式"
 *   - "发现 XX 个 YY"
 *   - "主要语言是 XX"
 *   - "XX 是唯一的 YY"
 *   - "XX 采用了 YY"
 */
const FACT_PATTERNS = [
  // Chinese
  /(?:项目|工程|代码库)(?:使用|采用|基于|遵循)了?\s*([^，。,.\n]{5,60})/g,
  /(?:主要|核心|主|主力)\s*(\S+)\s*(?:是|为|使用)\s*([^，。,.\n]{3,40})/g,
  /(?:发现|找到|扫描到|识别|共有|包含)\s*了?\s*(\d+)\s*个?\s*([^，。,.\n]{2,30})/g,
  /(\S{2,20})\s*是\s*(?:唯一的?|主要的?|核心的?|全局的?)\s*([^，。,.\n]{3,30})/g,
  /(?:使用|采用|遵循)了?\s*(\S{1,10})\s*(?:前缀|后缀|命名|约定|规范)/g,
  // English
  /(?:the\s+)?project\s+(?:uses?|adopts?|relies\s+on|follows?)\s+([^.,\n]{5,60})/gi,
  /(?:found|discovered|identified|detected)\s+(\d+)\s+([^.,\n]{3,40})/gi,
  /(?:the\s+)?(?:primary|main|core)\s+(\S+)\s+(?:is|are)\s+([^.,\n]{3,40})/gi,
  /(?:all|every)\s+([^.,\n]{3,30})\s+(?:use|adopt|follow|implement)\s+([^.,\n]{3,40})/gi,
  /(?:there\s+(?:is|are))\s+(\d+)\s+([^.,\n]{3,40})/gi,
];

/**
 * 匹配洞察性陈述:
 *   - "XXX 暗示/表明/说明 YYY"
 *   - "XXX 与 YYY 耦合/关联"
 *   - "建议/推荐 XXX"
 */
const INSIGHT_PATTERNS = [
  // Chinese
  /([^，。,.\n]{5,40})(?:暗示|表明|说明|意味着|揭示)\s*([^，。,.\n]{5,60})/g,
  /([^，。,.\n]{3,20})\s*(?:与|和)\s*([^，。,.\n]{3,20})\s*(?:耦合|关联|存在依赖|有关系)/g,
  /(?:建议|推荐|应该|需要)\s*([^，。,.\n]{5,60})/g,
  // English
  /([^.,\n]{5,40})\s+(?:suggests?|indicates?|implies?|reveals?)\s+(?:that\s+)?([^.,\n]{5,60})/gi,
  /([^.,\n]{3,20})\s+(?:is|are)\s+(?:tightly\s+)?(?:coupled|linked|related)\s+(?:to|with)\s+([^.,\n]{3,30})/gi,
  /(?:recommend|should|consider|suggest)\s+([^.,\n]{5,60})/gi,
];

// ──────────────────────────────────────────────────────────────
// EpisodicConsolidator 类
// ──────────────────────────────────────────────────────────────

export class EpisodicConsolidator {
  #semanticMemory: PersistentMemoryLike;

  #logger: ConsolidatorLogger;

  constructor(
    semanticMemory: PersistentMemoryLike,
    { logger }: { logger?: ConsolidatorLogger } = {}
  ) {
    this.#semanticMemory = semanticMemory;
    this.#logger = logger || Logger.getInstance();
  }

  /**
   * 执行固化: SessionStore → PersistentMemory
   *
   * @param [opts.bootstrapSession] Bootstrap session ID
   * @param [opts.clearPrevious=false] 是否先清除旧的 bootstrap 记忆
   * @returns }
   */
  consolidate(
    sessionStore: SessionStoreLike,
    {
      bootstrapSession,
      clearPrevious = false,
    }: { bootstrapSession?: string; clearPrevious?: boolean } = {}
  ) {
    const t0 = Date.now();

    // 可选: 清除旧的 bootstrap 记忆 (全量重跑场景)
    if (clearPrevious) {
      const cleared = this.#semanticMemory.clearBootstrapMemories();
      this.#logger.info(`[Consolidator] Cleared ${cleared} previous bootstrap memories`);
    }

    // 1. 先执行维护 (过期清理)
    this.#semanticMemory.compact();

    // 2. 从 findings 提取 fact 记忆
    const findingMemories = this.#extractFromFindings(sessionStore);

    // 3. 从 Tier Reflections 提取 insight 记忆
    const insightMemories = this.#extractFromReflections(sessionStore);

    // 4. 从 analysisText 提取文本中的事实
    const textFactMemories = this.#extractFromAnalysisText(sessionStore);

    // 5. 合并所有候选, 使用 consolidate 去重
    const allCandidates = [...findingMemories, ...insightMemories, ...textFactMemories];

    // ── 结构化统计日志 ──
    const dimStats = this.#computeDimStats(allCandidates);
    const importanceDist = this.#computeImportanceDistribution(allCandidates);
    const entityCount = allCandidates.reduce((sum, c) => sum + (c.relatedEntities?.length || 0), 0);

    this.#logger.info(
      `[Consolidator] Extracted ${allCandidates.length} candidate memories: ` +
        `${findingMemories.length} findings, ${insightMemories.length} insights, ` +
        `${textFactMemories.length} text facts`
    );
    this.#logger.info(
      `[Consolidator] Per-dimension: ${dimStats.map((d) => `${d.dim}=${d.count}`).join(', ')}`
    );
    this.#logger.info(
      `[Consolidator] Importance distribution: ${importanceDist} | Entities extracted: ${entityCount}`
    );

    const result = this.#semanticMemory.consolidate(allCandidates, { bootstrapSession });

    const durationMs = Date.now() - t0;
    this.#logger.info(
      `[Consolidator] Consolidation complete in ${durationMs}ms: ` +
        `+${result.added} ADD, ~${result.updated} UPDATE, ⊕${result.merged} MERGE, ` +
        `=${result.skipped} SKIP`
    );

    return {
      findings: { extracted: findingMemories.length },
      insights: { extracted: insightMemories.length },
      textFacts: { extracted: textFactMemories.length },
      total: result,
      durationMs,
      perDimension: Object.fromEntries(dimStats.map((d) => [d.dim, d.count])),
      importanceDistribution: this.#importanceHistogram(allCandidates),
      entityCount,
    };
  }

  // ─── 提取器 ───────────────────────────────────────────

  /**
   * 从维度 findings 提取 fact 记忆
   *
   * 每个 finding 映射为一条 fact，importance 直接继承。
   */
  #extractFromFindings(sessionStore: SessionStoreLike) {
    const memories: CandidateMemoryEntry[] = [];
    const completedDims = sessionStore.getCompletedDimensions();

    for (const dimId of completedDims) {
      const report = sessionStore.getDimensionReport(dimId);
      if (!report?.findings) {
        continue;
      }

      for (const f of report.findings) {
        // 跳过低重要性的发现
        if ((f.importance || 5) < 4) {
          continue;
        }

        // 跳过过短的发现
        const content = typeof f === 'string' ? f : f.finding || '';
        if (content.length < 10) {
          continue;
        }

        // 提取关联实体 (从 evidence 中提取文件名/类名)
        const entities = this.#extractEntities(content, f.evidence);

        memories.push({
          type: 'fact',
          content: content.substring(0, 500),
          source: 'bootstrap',
          importance: typeof f === 'string' ? 5 : f.importance || 5,
          sourceDimension: dimId,
          sourceEvidence: typeof f === 'string' ? '' : f.evidence || '',
          relatedEntities: entities,
          tags: [dimId],
        });
      }
    }

    return memories;
  }

  /**
   * 从 Tier Reflections 提取 insight 记忆
   *
   * crossDimensionPatterns → insight (跨维度观察)
   * suggestionsForNextTier → insight (分析建议)
   * topFindings 中重要性 ≥ 7 的 → fact (高优先级重复确认)
   */
  #extractFromReflections(sessionStore: SessionStoreLike) {
    const memories: CandidateMemoryEntry[] = [];
    const json = sessionStore.toJSON();
    const reflections = json.tierReflections || [];

    for (const ref of reflections) {
      // 跨维度模式 → insight
      for (const pattern of ref.crossDimensionPatterns || []) {
        if (pattern.length < 10) {
          continue;
        }
        memories.push({
          type: 'insight',
          content: pattern.substring(0, 500),
          source: 'bootstrap',
          importance: 7, // 跨维度发现通常较重要
          sourceDimension: `tier-${ref.tierIndex + 1}-reflection`,
          relatedEntities: this.#extractEntities(pattern),
          tags: ref.completedDimensions || [],
        });
      }

      // 建议 → insight (较低优先级)
      for (const suggestion of ref.suggestionsForNextTier || []) {
        if (suggestion.length < 10) {
          continue;
        }
        memories.push({
          type: 'insight',
          content: suggestion.substring(0, 500),
          source: 'bootstrap',
          importance: 5,
          sourceDimension: `tier-${ref.tierIndex + 1}-reflection`,
          tags: ['suggestion'],
        });
      }

      // 高重要性 topFindings → fact (≥ 7 分的重要发现)
      for (const f of ref.topFindings || []) {
        if ((f.importance || 5) < 7) {
          continue;
        }
        const content = typeof f === 'string' ? f : f.finding || '';
        if (content.length < 10) {
          continue;
        }

        memories.push({
          type: 'fact',
          content: content.substring(0, 500),
          source: 'bootstrap',
          importance: f.importance || 7,
          sourceDimension: f.dimId || `tier-${ref.tierIndex + 1}`,
          sourceEvidence: f.evidence || '',
          relatedEntities: this.#extractEntities(content),
          tags: [f.dimId, 'tier-reflection'].filter(Boolean) as string[],
        });
      }
    }

    return memories;
  }

  /**
   * 从分析文本中正则提取项目级事实和洞察
   *
   * 仅提取高置信度的简短陈述 (≤100 字), 避免噪音。
   */
  #extractFromAnalysisText(sessionStore: SessionStoreLike) {
    const memories: CandidateMemoryEntry[] = [];
    const seen = new Set(); // 去重
    const completedDims = sessionStore.getCompletedDimensions();

    for (const dimId of completedDims) {
      const report = sessionStore.getDimensionReport(dimId);
      if (!report?.analysisText) {
        continue;
      }

      const text = report.analysisText;

      // 提取事实
      for (const pattern of FACT_PATTERNS) {
        // 重置 lastIndex (全局正则)
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        let matchCount = 0;
        while ((match = pattern.exec(text)) !== null && matchCount < 5) {
          const fullMatch = match[0].trim();
          if (fullMatch.length < 10 || fullMatch.length > 120) {
            continue;
          }
          if (seen.has(fullMatch)) {
            continue;
          }
          seen.add(fullMatch);
          matchCount++;

          memories.push({
            type: 'fact',
            content: fullMatch,
            source: 'bootstrap',
            importance: 4, // 正则提取的置信度偏低
            sourceDimension: dimId,
            relatedEntities: this.#extractEntities(fullMatch),
            tags: [dimId, 'text-extracted'],
          });
        }
      }

      // 提取洞察
      for (const pattern of INSIGHT_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        let matchCount = 0;
        while ((match = pattern.exec(text)) !== null && matchCount < 3) {
          const fullMatch = match[0].trim();
          if (fullMatch.length < 10 || fullMatch.length > 120) {
            continue;
          }
          if (seen.has(fullMatch)) {
            continue;
          }
          seen.add(fullMatch);
          matchCount++;

          memories.push({
            type: 'insight',
            content: fullMatch,
            source: 'bootstrap',
            importance: 4,
            sourceDimension: dimId,
            relatedEntities: this.#extractEntities(fullMatch),
            tags: [dimId, 'text-extracted'],
          });
        }
      }
    }

    return memories;
  }

  // ─── 辅助方法 ─────────────────────────────────────────

  /** 按维度聚合候选数量 */
  #computeDimStats(candidates: CandidateMemoryEntry[]) {
    const counts = new Map<string, number>();
    for (const c of candidates) {
      const dim = c.sourceDimension || 'unknown';
      counts.set(dim, (counts.get(dim) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([dim, count]) => ({ dim, count }))
      .sort((a, b) => b.count - a.count);
  }

  /** 生成重要性分布字符串: "[1-3]=N [4-6]=N [7-10]=N" */
  #computeImportanceDistribution(candidates: CandidateMemoryEntry[]) {
    let low = 0;
    let mid = 0;
    let high = 0;
    for (const c of candidates) {
      const imp = c.importance || 5;
      if (imp <= 3) {
        low++;
      } else if (imp <= 6) {
        mid++;
      } else {
        high++;
      }
    }
    return `[1-3]=${low} [4-6]=${mid} [7-10]=${high}`;
  }

  /** 构建重要性直方图对象 (供返回值使用) */
  #importanceHistogram(candidates: CandidateMemoryEntry[]) {
    const hist: Record<number, number> = {};
    for (const c of candidates) {
      const imp = c.importance || 5;
      hist[imp] = (hist[imp] || 0) + 1;
    }
    return hist;
  }

  /**
   * 从文本中提取实体名 (类名/文件名/模块名)
   *
   * 简单规则:
   *   - 大驼峰式: BDNetworkManager, UIViewController
   *   - 文件路径: Classes/Network/BDRequest.m
   *   - 冒号分隔的 evidence: "BDRequest.m:42"
   */
  #extractEntities(text: string, evidence: string | undefined = undefined) {
    const entities = new Set<string>();

    // 大驼峰类名 (至少 2 个大写字母)
    const classNames = (text || '').match(/\b[A-Z][a-zA-Z]*[A-Z][a-zA-Z]*\b/g) || [];
    for (const name of classNames) {
      if (name.length >= 4 && name.length <= 40) {
        entities.add(name);
      }
    }

    // 从 evidence 提取文件名
    if (evidence) {
      const fileName = evidence.split(':')[0].split('/').pop();
      if (fileName && fileName.length >= 3) {
        entities.add(fileName);
      }
    }

    return [...entities].slice(0, 5); // 最多 5 个实体
  }
}

export default EpisodicConsolidator;
