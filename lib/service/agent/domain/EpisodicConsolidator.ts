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

import Logger from '../../../infrastructure/logging/Logger.js';

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
  // "项目使用/采用了 XXX"
  /(?:项目|工程|代码库)(?:使用|采用|基于|遵循)了?\s*([^，。,.\n]{5,60})/g,
  // "主要/核心 XXX 是 YYY"
  /(?:主要|核心|主|主力)\s*(\S+)\s*(?:是|为|使用)\s*([^，。,.\n]{3,40})/g,
  // "发现了? N 个 XXX"
  /(?:发现|找到|扫描到|识别|共有|包含)\s*了?\s*(\d+)\s*个?\s*([^，。,.\n]{2,30})/g,
  // "XXX 是唯一的/主要的 YYY"
  /(\S{2,20})\s*是\s*(?:唯一的?|主要的?|核心的?|全局的?)\s*([^，。,.\n]{3,30})/g,
  // "使用了 XXX 前缀/后缀/命名"
  /(?:使用|采用|遵循)了?\s*(\S{1,10})\s*(?:前缀|后缀|命名|约定|规范)/g,
];

/**
 * 匹配洞察性陈述:
 *   - "XXX 暗示/表明/说明 YYY"
 *   - "XXX 与 YYY 耦合/关联"
 *   - "建议/推荐 XXX"
 */
const INSIGHT_PATTERNS = [
  /([^，。,.\n]{5,40})(?:暗示|表明|说明|意味着|揭示)\s*([^，。,.\n]{5,60})/g,
  /([^，。,.\n]{3,20})\s*(?:与|和)\s*([^，。,.\n]{3,20})\s*(?:耦合|关联|存在依赖|有关系)/g,
  /(?:建议|推荐|应该|需要)\s*([^，。,.\n]{5,60})/g,
];

// ──────────────────────────────────────────────────────────────
// EpisodicConsolidator 类
// ──────────────────────────────────────────────────────────────

export class EpisodicConsolidator {
  /** @type {import('../memory/PersistentMemory.js').PersistentMemory} */
  #semanticMemory;

  /** @type {import('winston').Logger} */
  #logger;

  /**
   * @param {import('../memory/PersistentMemory.js').PersistentMemory} semanticMemory
   * @param {object} [opts]
   * @param {object} [opts.logger]
   */
  constructor(semanticMemory, { logger }: any = {}) {
    this.#semanticMemory = semanticMemory;
    this.#logger = logger || Logger.getInstance();
  }

  /**
   * 执行固化: SessionStore → PersistentMemory
   *
   * @param {import('../memory/SessionStore.js').SessionStore} sessionStore
   * @param {object} [opts]
   * @param {string} [opts.bootstrapSession] - Bootstrap session ID
   * @param {boolean} [opts.clearPrevious=false] 是否先清除旧的 bootstrap 记忆
   * @returns {{ findings: object, insights: object, textFacts: object, total: object }}
   */
  consolidate(sessionStore, { bootstrapSession, clearPrevious = false }: any = {}) {
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

    this.#logger.info(
      `[Consolidator] Extracted ${allCandidates.length} candidate memories: ` +
        `${findingMemories.length} findings, ${insightMemories.length} insights, ` +
        `${textFactMemories.length} text facts`
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
    };
  }

  // ─── 提取器 ───────────────────────────────────────────

  /**
   * 从维度 findings 提取 fact 记忆
   *
   * 每个 finding 映射为一条 fact，importance 直接继承。
   */
  #extractFromFindings(sessionStore) {
    const memories: any[] = [];
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
  #extractFromReflections(sessionStore) {
    const memories: any[] = [];
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
          tags: [f.dimId, 'tier-reflection'].filter(Boolean),
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
  #extractFromAnalysisText(sessionStore) {
    const memories: any[] = [];
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
        let match;
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
        let match;
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

  /**
   * 从文本中提取实体名 (类名/文件名/模块名)
   *
   * 简单规则:
   *   - 大驼峰式: BDNetworkManager, UIViewController
   *   - 文件路径: Classes/Network/BDRequest.m
   *   - 冒号分隔的 evidence: "BDRequest.m:42"
   *
   * @param {string} text
   * @param {string} [evidence]
   * @returns {string[]}
   */
  #extractEntities(text, evidence: any = undefined) {
    const entities = new Set();

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
