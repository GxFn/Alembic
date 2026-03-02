/**
 * PersistentMemory — 持久化语义记忆 (Tier 3)
 *
 * 前身: ProjectSemanticMemory.js (继承 + 增强)
 * 合并目标: 统一 Memory.js (JSONL) + ProjectSemanticMemory (SQLite)
 *
 * 新增功能:
 *   1. migrateFromLegacy() — Memory.js JSONL 数据迁移到 SQLite
 *   2. 冲突解决 (Mem0 风格) — consolidate 前置矛盾检测 + 自动替换
 *   3. 向量嵌入占位接口 — setEmbeddingFunction() 预留，未来替换 Jaccard
 *   4. 预算感知 toPromptSection — 支持 tokenBudget 参数 (配合 MemoryCoordinator)
 *
 * 继承自 ProjectSemanticMemory:
 *   - add / update / delete / get                (基本 CRUD)
 *   - consolidate (增强: 冲突预解决 → super)      (Extract-Update pipeline)
 *   - retrieve                                    (3D 检索: recency × importance × relevance)
 *   - search                                      (文本搜索)
 *   - toPromptSection / load / append / size      (Memory.js 兼容层)
 *   - compact / clearBootstrapMemories            (维护 — F15, F16)
 *   - getStats                                    (统计)
 *
 * 算法参数 (F20, 继承自 ProjectSemanticMemory):
 *   - 检索权重: RECENCY=0.2, IMPORTANCE=0.3, RELEVANCE=0.5 (Generative Agents 三维打分)
 *   - 半衰期: RECENCY_HALF_LIFE_DAYS=7
 *   - 固化阈值: SIMILARITY_UPDATE=0.85 (同义→UPDATE), SIMILARITY_MERGE=0.6 (相关→MERGE)
 *   - 遗忘策略: ARCHIVE_DAYS=30 (降级), FORGET_DAYS=90 (删除), MAX_MEMORIES=500
 *
 * @module PersistentMemory
 * @see docs/copilot/memory-system-redesign.md §4.5, §7.6, F15, F16, F20
 */

import fs from 'node:fs';
import path from 'node:path';
import { ProjectSemanticMemory } from '../ProjectSemanticMemory.js';

// ──────────────────────────────────────────────────────────────
// 矛盾检测模式 (Mem0 风格冲突解决)
// ──────────────────────────────────────────────────────────────

/** 中文否定/禁止模式 */
const NEGATION_PATTERNS_ZH =
  /不(再)?使用|不(再)?用|禁止|废弃|移除|取消|停止|不要|不采用|弃用|淘汰/;

/** 英文否定/禁止模式 */
const NEGATION_PATTERNS_EN =
  /\b(don'?t|do\s+not|never|no\s+longer|removed?|deprecated?|stop|avoid|disable|abandon|drop)\b/i;

/** 共享词语最少匹配数 — 用于判断两条记忆是否讨论同一主题 */
const MIN_TOPIC_OVERLAP_WORDS = 2;

/** 共享词语比例阈值 — 低于此值视为不同主题 */
const MIN_TOPIC_OVERLAP_RATIO = 0.3;

// ──────────────────────────────────────────────────────────────
// PersistentMemory
// ──────────────────────────────────────────────────────────────

export class PersistentMemory extends ProjectSemanticMemory {
  /**
   * 向量嵌入函数 (预留接口)
   *
   * 签名: (queryText: string, contentText: string) => number (0.0-1.0)
   * 当前: null → 使用继承的 Jaccard + 子串匹配
   * 未来: ADR-3 — 当嵌入模型可用时，通过 setEmbeddingFunction() 注入
   *
   * @type {Function|null}
   */
  #embeddingFn;

  /** @type {object|null} */
  #logger;

  /**
   * @param {import('better-sqlite3').Database} db — better-sqlite3 实例
   * @param {object} [opts]
   * @param {object}   [opts.logger]       — Logger 实例
   * @param {Function} [opts.embeddingFn]  — 向量嵌入函数 (预留)
   */
  constructor(db, opts = {}) {
    super(db, { logger: opts.logger });
    this.#embeddingFn = typeof opts.embeddingFn === 'function' ? opts.embeddingFn : null;
    this.#logger = opts.logger || null;
  }

  // ──────────────────────────────────────────────────────────
  // 新增 1: Legacy Migration (Memory.js JSONL → SQLite)
  // ──────────────────────────────────────────────────────────

  /**
   * 从旧版 Memory.js JSONL 文件迁移数据到 SQLite
   *
   * 流程:
   *   1. 读取 .autosnippet/memory.jsonl (逐行 JSON)
   *   2. 映射 type: preference→preference, decision→fact, 其他→fact
   *   3. 通过 consolidate() 智能去重合并
   *   4. 成功后将旧文件重命名为 .migrated
   *
   * @param {string} projectRoot — 用户项目根目录
   * @returns {Promise<{ migrated: number, skipped: number, error?: string }>}
   */
  async migrateFromLegacy(projectRoot) {
    const legacyPath = path.join(projectRoot, '.autosnippet', 'memory.jsonl');

    if (!fs.existsSync(legacyPath)) {
      return { migrated: 0, skipped: 0 };
    }

    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8').trim();
      if (!raw) {
        return { migrated: 0, skipped: 0 };
      }

      const lines = raw.split('\n').filter(Boolean);
      const candidates = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .map((m) => ({
          type: this.#mapLegacyType(m.type),
          content: (m.content || '').trim(),
          source: m.source || 'user',
          importance: m.type === 'decision' ? 7 : 5,
        }))
        .filter((m) => m.content.length >= 5); // 过滤过短记忆

      if (candidates.length === 0) {
        return { migrated: 0, skipped: lines.length };
      }

      const result = this.consolidate(candidates, {
        bootstrapSession: 'legacy-migration',
      });

      // 迁移成功 → 重命名旧文件 (保留备份)
      try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      } catch {
        // 重命名失败不影响迁移结果
      }

      const migrated = result.added + result.merged;
      this.#log(
        `Legacy migration: ${migrated} migrated (${result.added} added, ${result.merged} merged), ${result.skipped} skipped from ${legacyPath}`
      );

      return { migrated, skipped: result.skipped };
    } catch (err) {
      this.#log(`Legacy migration failed: ${err.message}`);
      return { migrated: 0, skipped: 0, error: err.message };
    }
  }

  // ──────────────────────────────────────────────────────────
  // 新增 2: Enhanced Consolidate (冲突预解决)
  // ──────────────────────────────────────────────────────────

  /**
   * 增强版 consolidate: 在正常 ADD/UPDATE/MERGE 流程之前执行冲突检测
   *
   * 冲突解决逻辑 (Mem0 风格):
   *   1. 对每条候选记忆，在现有库中搜索相似记忆
   *   2. 如果发现同类型 + 矛盾内容 → 直接 REPLACE (新信息更可信)
   *   3. 已解决的冲突条目不再进入 super.consolidate() 的正常流程
   *   4. 未冲突的候选正常走 ADD/UPDATE/MERGE
   *
   * @param {Array<object>} candidateMemories — 候选记忆列表
   * @param {object} [opts]
   * @param {string} [opts.bootstrapSession] — Bootstrap session ID
   * @returns {{ added: number, updated: number, merged: number, skipped: number, replaced?: number }}
   */
  consolidate(candidateMemories, opts = {}) {
    const { processed, replaced } = this.#preResolveConflicts(candidateMemories);
    const result = super.consolidate(processed, opts);
    if (replaced > 0) {
      result.replaced = replaced;
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────
  // 新增 3: Budget-aware toPromptSection
  // ──────────────────────────────────────────────────────────

  /**
   * 预算感知的 prompt section 生成
   *
   * 在继承的 toPromptSection 基础上增加 tokenBudget 参数:
   *   - 根据预算估算可容纳的记忆条数
   *   - 确保不超过 MemoryCoordinator 分配的预算
   *
   * @param {object} [opts]
   * @param {string} [opts.source] — 过滤 source (user/system/bootstrap)
   * @param {string} [opts.query]  — 查询上下文 (用于 relevance 打分)
   * @param {number} [opts.limit=15] — 最大条数
   * @param {number} [opts.tokenBudget] — token 预算 (由 MemoryCoordinator 分配)
   * @returns {string} Markdown 格式的记忆摘要
   */
  toPromptSection({ source, query, limit = 15, tokenBudget } = {}) {
    if (tokenBudget && tokenBudget > 0) {
      // 估算: 每条记忆约 30 tokens (badge + type + content)
      const EST_TOKENS_PER_MEMORY = 30;
      const HEADER_TOKENS = 15; // "## 项目记忆 (N 条最相关)" header
      const maxByBudget = Math.max(3, Math.floor((tokenBudget - HEADER_TOKENS) / EST_TOKENS_PER_MEMORY));
      limit = Math.min(limit, maxByBudget);
    }
    return super.toPromptSection({ source, query, limit });
  }

  // ──────────────────────────────────────────────────────────
  // 新增 4: 向量嵌入接口 (ADR-3 预留)
  // ──────────────────────────────────────────────────────────

  /**
   * 设置向量嵌入函数
   *
   * 当前架构中，语义检索使用 Jaccard + 子串匹配 (精度有限，§1.2-C2)。
   * 预留此接口，未来可注入 embedding 函数提升语义匹配精度。
   *
   * 注意: 当前嵌入函数仅影响 PersistentMemory 自身的 retrieve() 调用
   * 链路 (computeEmbeddingRelevance)。父类 ProjectSemanticMemory 的
   * #computeRelevance 使用固有 Jaccard，要完全替换需重构 PSM。
   * 这是有意保留的渐进式迁移策略 (ADR-3)。
   *
   * @param {Function|null} fn — (query: string, content: string) => number (0.0-1.0)
   */
  setEmbeddingFunction(fn) {
    this.#embeddingFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * 获取当前嵌入函数 (用于检测是否已配置)
   * @returns {Function|null}
   */
  getEmbeddingFunction() {
    return this.#embeddingFn;
  }

  /**
   * 使用嵌入函数计算语义相关性 (如已设置)
   *
   * 供外部模块 (如 MemoryCoordinator.buildDynamicMemoryPrompt) 在
   * 需要更精确语义匹配时调用。如果未设置嵌入函数，返回 null。
   *
   * @param {string} query
   * @param {string} content
   * @returns {number|null} — 0.0-1.0 或 null (无嵌入函数)
   */
  computeEmbeddingRelevance(query, content) {
    if (!this.#embeddingFn) return null;
    try {
      return this.#embeddingFn(query, content);
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Private: 冲突预解决 (Mem0 风格)
  // ──────────────────────────────────────────────────────────

  /**
   * 在 consolidate 主流程前检测并解决矛盾
   *
   * 对每条候选记忆:
   *   1. 使用 search() 查找相似现有记忆
   *   2. 如果同类型且检测到矛盾 → 直接 update() 替换旧内容
   *   3. 已替换的候选从列表中移除 (不再走 super.consolidate)
   *
   * @param {Array<object>} candidates
   * @returns {{ processed: Array<object>, replaced: number }}
   */
  #preResolveConflicts(candidates) {
    if (!candidates || candidates.length === 0) {
      return { processed: [], replaced: 0 };
    }

    const processed = [];
    let replaced = 0;

    for (const candidate of candidates) {
      const content = (candidate.content || '').trim();
      if (!content || content.length < 5) {
        processed.push(candidate);
        continue;
      }

      try {
        // 使用继承的 search() 公开方法查找相似记忆
        const similar = this.search(content, { limit: 3 });
        let conflictResolved = false;

        for (const existing of similar) {
          // 仅对同类型记忆检测矛盾
          if (existing.type === (candidate.type || 'fact')) {
            const isContradiction = PersistentMemory.#detectContradiction(
              existing.content,
              content
            );

            if (isContradiction) {
              // REPLACE: 新信息覆盖旧信息 (Mem0 原则: 更recent更可信)
              this.update(existing.id, {
                content: content.substring(0, 500),
                importance: Math.max(existing.importance || 5, candidate.importance || 5),
              });
              conflictResolved = true;
              replaced++;
              this.#log(
                `Conflict resolved: replaced "${existing.content.substring(0, 50)}..." with "${content.substring(0, 50)}..."`
              );
              break;
            }
          }
        }

        if (!conflictResolved) {
          processed.push(candidate);
        }
      } catch {
        // search/update 失败 → 保留候选，走正常 consolidate
        processed.push(candidate);
      }
    }

    return { processed, replaced };
  }

  /**
   * 检测两段记忆内容是否矛盾
   *
   * 启发式规则:
   *   1. 检查两段内容的否定模式 (中/英文)
   *   2. 如果一段有否定另一段没有 (或反之)
   *   3. 且两段内容有足够的主题词重叠
   *   → 判定为矛盾
   *
   * 示例:
   *   "我们使用 singleton 模式" vs "不要使用 singleton 模式" → 矛盾
   *   "使用 React" vs "不使用 Vue" → 非矛盾 (不同主题)
   *
   * @param {string} contentA — 现有记忆内容
   * @param {string} contentB — 候选记忆内容
   * @returns {boolean}
   */
  static #detectContradiction(contentA, contentB) {
    if (!contentA || !contentB) return false;

    // 检测否定模式
    const aNeg =
      NEGATION_PATTERNS_ZH.test(contentA) || NEGATION_PATTERNS_EN.test(contentA);
    const bNeg =
      NEGATION_PATTERNS_ZH.test(contentB) || NEGATION_PATTERNS_EN.test(contentB);

    // 同向 (都有否定或都没有) → 非矛盾
    if (aNeg === bNeg) return false;

    // 异向 → 检查主题重叠度
    const wordsA = PersistentMemory.#extractTopicWords(contentA);
    const wordsB = PersistentMemory.#extractTopicWords(contentB);

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }

    const minSize = Math.min(wordsA.size, wordsB.size);
    if (minSize === 0) return false;

    // 主题重叠达到阈值 → 矛盾
    return overlap >= MIN_TOPIC_OVERLAP_WORDS || overlap / minSize >= MIN_TOPIC_OVERLAP_RATIO;
  }

  /**
   * 提取主题词 (去停用词 + 短词)
   * @param {string} text
   * @returns {Set<string>}
   */
  static #extractTopicWords(text) {
    if (!text) return new Set();

    // 分词: 空格/标点/CJK边界
    const tokens = text
      .toLowerCase()
      .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>·、]+/)
      .filter((t) => t.length >= 2);

    // 过滤常见停用词
    const stopWords = new Set([
      // 中文
      '我们', '使用', '项目', '需要', '可以', '应该', '建议', '目前',
      '已经', '这个', '那个', '一个', '进行', '通过', '对于',
      // 英文
      'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'shall', 'can', 'this',
      'that', 'these', 'those', 'with', 'from', 'for', 'and',
      'but', 'not', 'all', 'any', 'each', 'every', 'some',
    ]);

    return new Set(tokens.filter((t) => !stopWords.has(t)));
  }

  // ──────────────────────────────────────────────────────────
  // Private: Helpers
  // ──────────────────────────────────────────────────────────

  /**
   * 从 Memory.js 的 type 映射到 PSM 的 type
   *
   * Memory.js types: preference, decision, context
   * PSM types:       fact, insight, preference
   *
   * @param {string} legacyType
   * @returns {string}
   */
  #mapLegacyType(legacyType) {
    switch (legacyType) {
      case 'preference':
        return 'preference';
      case 'decision':
        return 'fact';
      case 'context':
        return 'fact';
      default:
        return 'fact';
    }
  }

  /**
   * 日志输出
   * @param {string} msg
   */
  #log(msg) {
    const formatted = `[PersistentMemory] ${msg}`;
    if (this.#logger?.info) {
      this.#logger.info(formatted);
    }
  }
}

// ── 向后兼容: 从新模块路径导入时可用旧名称 ──
export { PersistentMemory as ProjectSemanticMemory };

export default PersistentMemory;
