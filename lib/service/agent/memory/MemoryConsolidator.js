/**
 * MemoryConsolidator — 记忆固化与冲突解决
 *
 * 从 PersistentMemory.js 提取的智能固化逻辑。
 * 负责:
 *   - Extract-Update Consolidation (ADD / UPDATE / MERGE / NOOP)
 *   - Mem0 风格冲突解决 (矛盾检测 + 自动替换)
 *   - Legacy JSONL 迁移
 *
 * @module MemoryConsolidator
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from './MemoryStore.js';

// ─── 常量 ──────────────────────────────────────────────

/** 相似度阈值 */
const SIMILARITY_UPDATE = 0.85; // ≥85% 同义 → UPDATE
const SIMILARITY_MERGE = 0.6; // ≥60% 相关 → MERGE

// ─── 矛盾检测模式 (Mem0 风格冲突解决) ─────────────────

/** 中文否定/禁止模式 */
const NEGATION_PATTERNS_ZH =
  /不(再)?使用|不(再)?用|禁止|废弃|移除|取消|停止|不要|不采用|弃用|淘汰/;

/** 英文否定/禁止模式 */
const NEGATION_PATTERNS_EN =
  /\b(don'?t|do\s+not|never|no\s+longer|removed?|deprecated?|stop|avoid|disable|abandon|drop)\b/i;

/** 共享词语最少匹配数 */
const MIN_TOPIC_OVERLAP_WORDS = 2;

/** 共享词语比例阈值 */
const MIN_TOPIC_OVERLAP_RATIO = 0.3;

export class MemoryConsolidator {
  /** @type {MemoryStore} */
  #store;

  /** @type {object|null} */
  #logger;

  /**
   * @param {MemoryStore} store
   * @param {object} [opts]
   * @param {object} [opts.logger]
   */
  constructor(store, opts = {}) {
    this.#store = store;
    this.#logger = opts.logger || null;
  }

  // ═══════════════════════════════════════════════════════════
  // 智能固化
  // ═══════════════════════════════════════════════════════════

  /**
   * 智能固化: 先执行冲突检测 (Mem0 风格)，再执行 ADD / UPDATE / MERGE / NOOP
   *
   * @param {Array<object>} candidateMemories
   * @param {object} [opts]
   * @param {string} [opts.bootstrapSession]
   * @returns {{ added: number, updated: number, merged: number, skipped: number, replaced?: number }}
   */
  consolidate(candidateMemories, { bootstrapSession } = {}) {
    // Phase 1: 冲突预解决
    const { processed, replaced } = this.#preResolveConflicts(candidateMemories);

    // Phase 2: 正常 consolidate 流程
    const stats = { added: 0, updated: 0, merged: 0, skipped: 0 };

    const runConsolidate = this.#store.transaction(() => {
      for (const candidate of processed) {
        const content = (candidate.content || '').trim();
        if (!content || content.length < 5) {
          stats.skipped++;
          continue;
        }

        // 搜索相似记忆 (同 type 优先)
        const similar = this.#store.findSimilar(content, candidate.type, 3);

        if (similar.length === 0) {
          this.#store.add({ ...candidate, bootstrapSession });
          stats.added++;
          continue;
        }

        const topMatch = similar[0];

        if (topMatch.similarity >= SIMILARITY_UPDATE) {
          // UPDATE: 几乎同义 → 更新重要性和时间戳
          this.#store.update(topMatch.id, {
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            accessCount: topMatch.access_count + 1,
          });
          stats.updated++;
        } else if (topMatch.similarity >= SIMILARITY_MERGE) {
          // MERGE: 相关但不同 → 合并信息
          const mergedContent = `${topMatch.content}; ${content}`.substring(0, 500);
          const existingRelated = MemoryStore.safeParseJSON(topMatch.related_memories_raw, []);
          this.#store.update(topMatch.id, {
            content: mergedContent,
            importance: Math.max(topMatch.importance, candidate.importance || 5),
            relatedMemories: [...existingRelated, `merged:${Date.now()}`],
          });
          stats.merged++;
        } else {
          this.#store.add({ ...candidate, bootstrapSession });
          stats.added++;
        }
      }
    });

    runConsolidate();

    this.#log(
      `Consolidation: +${stats.added} ADD, ~${stats.updated} UPDATE, ⊕${stats.merged} MERGE, =${stats.skipped} SKIP`
    );

    // 容量控制
    this.#store.enforceCapacity();

    if (replaced > 0) {
      stats.replaced = replaced;
    }

    return stats;
  }

  // ═══════════════════════════════════════════════════════════
  // Legacy Migration
  // ═══════════════════════════════════════════════════════════

  /**
   * 从旧版 Memory.js JSONL 文件迁移数据到 SQLite
   *
   * @param {string} projectRoot
   * @returns {Promise<{ migrated: number, skipped: number, error?: string }>}
   */
  async migrateFromLegacy(projectRoot) {
    const legacyPath = path.join(projectRoot, '.autosnippet', 'memory.jsonl');

    if (!fs.existsSync(legacyPath)) {
      return { migrated: 0, skipped: 0 };
    }

    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8').trim();
      if (!raw) return { migrated: 0, skipped: 0 };

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
          type: MemoryConsolidator.#mapLegacyType(m.type),
          content: (m.content || '').trim(),
          source: m.source || 'user',
          importance: m.type === 'decision' ? 7 : 5,
        }))
        .filter((m) => m.content.length >= 5);

      if (candidates.length === 0) {
        return { migrated: 0, skipped: lines.length };
      }

      const result = this.consolidate(candidates, {
        bootstrapSession: 'legacy-migration',
      });

      // 迁移成功 → 重命名旧文件
      try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      } catch {
        /* rename failure non-critical */
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

  // ═══════════════════════════════════════════════════════════
  // Private: 冲突预解决 (Mem0 风格)
  // ═══════════════════════════════════════════════════════════

  /**
   * 在 consolidate 主流程前检测并解决矛盾
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
        const similar = this.#store.findSimilar(content, null, 3);
        const deserialized = similar.map((r) => MemoryStore.deserialize(r));
        let conflictResolved = false;

        for (const existing of deserialized) {
          if (existing.type === (candidate.type || 'fact')) {
            const isContradiction = MemoryConsolidator.#detectContradiction(
              existing.content,
              content
            );

            if (isContradiction) {
              this.#store.update(existing.id, {
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
        processed.push(candidate);
      }
    }

    return { processed, replaced };
  }

  /**
   * 检测两段记忆内容是否矛盾
   * @param {string} contentA
   * @param {string} contentB
   * @returns {boolean}
   */
  static #detectContradiction(contentA, contentB) {
    if (!contentA || !contentB) return false;

    const aNeg = NEGATION_PATTERNS_ZH.test(contentA) || NEGATION_PATTERNS_EN.test(contentA);
    const bNeg = NEGATION_PATTERNS_ZH.test(contentB) || NEGATION_PATTERNS_EN.test(contentB);

    if (aNeg === bNeg) return false;

    const wordsA = MemoryConsolidator.#extractTopicWords(contentA);
    const wordsB = MemoryConsolidator.#extractTopicWords(contentB);

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }

    const minSize = Math.min(wordsA.size, wordsB.size);
    if (minSize === 0) return false;

    return overlap >= MIN_TOPIC_OVERLAP_WORDS || overlap / minSize >= MIN_TOPIC_OVERLAP_RATIO;
  }

  /**
   * 提取主题词 (去停用词 + 短词)
   * @param {string} text
   * @returns {Set<string>}
   */
  static #extractTopicWords(text) {
    if (!text) return new Set();

    const tokens = text
      .toLowerCase()
      .split(/[\s,;:!?。，；：！？\-_/\\|()[\]{}'"<>·、]+/)
      .filter((t) => t.length >= 2);

    const stopWords = new Set([
      '我们', '使用', '项目', '需要', '可以', '应该', '建议', '目前',
      '已经', '这个', '那个', '一个', '进行', '通过', '对于',
      'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'shall', 'can', 'this',
      'that', 'these', 'those', 'with', 'from', 'for', 'and',
      'but', 'not', 'all', 'any', 'each', 'every', 'some',
    ]);

    return new Set(tokens.filter((t) => !stopWords.has(t)));
  }

  /**
   * Legacy type 映射
   * @param {string} legacyType
   * @returns {string}
   */
  static #mapLegacyType(legacyType) {
    switch (legacyType) {
      case 'preference':
        return 'preference';
      case 'decision':
      case 'context':
      default:
        return 'fact';
    }
  }

  #log(msg) {
    const formatted = `[MemoryConsolidator] ${msg}`;
    if (this.#logger?.info) {
      this.#logger.info(formatted);
    }
  }
}
