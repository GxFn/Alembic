/**
 * FeedbackStore — 推荐反馈持久化与用户偏好推导
 *
 * 存储位置: {projectRoot}/.asd/feedback.jsonl
 * 格式: 每行一个 JSON 对象 (append-only log)
 *
 * 职责:
 *   - 记录用户对推荐的反馈 (adopted / dismissed / expired / viewed / modified)
 *   - 计算采纳率、查看率、按来源分组的采纳率
 *   - 推导用户偏好向量 (喜欢/回避的类别和来源)
 *   - 检测被频繁忽略的推荐类别
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WriteZone } from '#infra/io/WriteZone.js';
import { RUNTIME_DIR } from '#shared/ProjectMarkers.js';
import Logger from '../../infrastructure/logging/Logger.js';
import type {
  FeedbackAction,
  RecommendationFeedback,
  RecommendationMetricsSnapshot,
  UserPreference,
} from './types.js';

const FEEDBACK_FILE = 'feedback.jsonl';

/** 频繁忽略阈值: 该类别至少 5 次且忽略率 >= 70% */
const DISMISS_MIN_COUNT = 5;
const DISMISS_THRESHOLD = 0.7;

/** 内存缓存条数上限 (JSONL 可无限追加，但内存只保留最近 N 条) */
const MAX_MEMORY_ENTRIES = 2000;

interface FeedbackEntry extends RecommendationFeedback {
  /** 服务端写入时间 (ISO) */
  _ts: string;
}

export class FeedbackStore {
  readonly #filePath: string;
  readonly #logger: ReturnType<typeof Logger.getInstance>;
  readonly #wz: WriteZone | null;
  #entries: FeedbackEntry[] = [];
  #loaded = false;

  constructor(projectRoot: string, wz?: WriteZone) {
    this.#filePath = path.join(projectRoot, RUNTIME_DIR, FEEDBACK_FILE);
    this.#logger = Logger.getInstance();
    this.#wz = wz ?? null;
  }

  // ─── 公共 API ──────────────────────────────────────────

  /** 记录一条反馈 */
  async record(feedback: RecommendationFeedback): Promise<void> {
    this.#ensureLoaded();

    const entry: FeedbackEntry = {
      ...feedback,
      timestamp: feedback.timestamp || new Date().toISOString(),
      _ts: new Date().toISOString(),
    };

    this.#entries.push(entry);

    // 内存溢出保护
    if (this.#entries.length > MAX_MEMORY_ENTRIES) {
      this.#entries = this.#entries.slice(-MAX_MEMORY_ENTRIES);
    }

    // 追加写入 JSONL
    try {
      if (this.#wz) {
        this.#wz.appendFile(this.#wz.runtime(FEEDBACK_FILE), `${JSON.stringify(entry)}\n`);
      } else {
        const dir = path.dirname(this.#filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(this.#filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
      }
    } catch (err: unknown) {
      this.#logger.warn('FeedbackStore: failed to persist feedback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 获取采纳率
   * @param source 可选 — 按推荐来源过滤
   */
  getAdoptionRate(source?: string): number {
    this.#ensureLoaded();
    const filtered = source ? this.#entries.filter((e) => e.source === source) : this.#entries;

    const adopted = filtered.filter(
      (e) => e.action === 'adopted' || e.action === 'modified'
    ).length;
    const dismissed = filtered.filter((e) => e.action === 'dismissed').length;
    const total = adopted + dismissed;
    if (total === 0) {
      return 0;
    }
    return adopted / total;
  }

  /** 获取用户偏好向量 (基于历史反馈推导) */
  getUserPreference(): UserPreference {
    this.#ensureLoaded();

    const categoryStats = new Map<string, { adopted: number; dismissed: number }>();
    const sourceStats = new Map<string, { adopted: number; dismissed: number }>();

    for (const entry of this.#entries) {
      const cat = entry.category ?? 'unknown';
      const src = entry.source ?? 'unknown';

      // 按类别
      if (!categoryStats.has(cat)) {
        categoryStats.set(cat, { adopted: 0, dismissed: 0 });
      }
      const cs = categoryStats.get(cat)!;
      if (entry.action === 'adopted' || entry.action === 'modified') {
        cs.adopted++;
      }
      if (entry.action === 'dismissed') {
        cs.dismissed++;
      }

      // 按来源
      if (!sourceStats.has(src)) {
        sourceStats.set(src, { adopted: 0, dismissed: 0 });
      }
      const ss = sourceStats.get(src)!;
      if (entry.action === 'adopted' || entry.action === 'modified') {
        ss.adopted++;
      }
      if (entry.action === 'dismissed') {
        ss.dismissed++;
      }
    }

    const preferredCategories: string[] = [];
    const avoidedCategories: string[] = [];
    for (const [cat, stats] of categoryStats) {
      const total = stats.adopted + stats.dismissed;
      if (total < 3) {
        continue;
      }
      const rate = stats.adopted / total;
      if (rate >= 0.6) {
        preferredCategories.push(cat);
      }
      if (rate <= 0.3) {
        avoidedCategories.push(cat);
      }
    }

    const preferredSources: string[] = [];
    for (const [src, stats] of sourceStats) {
      const total = stats.adopted + stats.dismissed;
      if (total >= 3 && stats.adopted / total >= 0.5) {
        preferredSources.push(src);
      }
    }

    return {
      preferredCategories,
      avoidedCategories,
      preferredSources,
      adoptionRate: this.getAdoptionRate(),
    };
  }

  /** 特定类别的推荐是否被用户频繁忽略 */
  isFrequentlyDismissed(category: string): boolean {
    this.#ensureLoaded();
    const entries = this.#entries.filter((e) => e.category === category);
    const dismissed = entries.filter((e) => e.action === 'dismissed').length;
    const adopted = entries.filter((e) => e.action === 'adopted' || e.action === 'modified').length;
    const total = dismissed + adopted;
    if (total < DISMISS_MIN_COUNT) {
      return false;
    }
    return dismissed / total >= DISMISS_THRESHOLD;
  }

  /** 获取推荐效果指标快照 */
  getMetricsSnapshot(since?: Date): RecommendationMetricsSnapshot {
    this.#ensureLoaded();
    const sinceTs = since?.toISOString() ?? '1970-01-01T00:00:00.000Z';
    const filtered = this.#entries.filter((e) => e.timestamp >= sinceTs);

    const totalRecommendations = filtered.length;
    const totalViewed = filtered.filter((e) => e.action === 'viewed').length;
    const totalAdopted = filtered.filter(
      (e) => e.action === 'adopted' || e.action === 'modified'
    ).length;
    const totalDismissed = filtered.filter((e) => e.action === 'dismissed').length;
    const totalExpired = filtered.filter((e) => e.action === 'expired').length;

    // 按来源分组采纳率
    const sourceMap = new Map<string, { adopted: number; total: number }>();
    for (const entry of filtered) {
      const src = entry.source ?? 'unknown';
      if (!sourceMap.has(src)) {
        sourceMap.set(src, { adopted: 0, total: 0 });
      }
      const s = sourceMap.get(src)!;
      if (
        entry.action === 'adopted' ||
        entry.action === 'modified' ||
        entry.action === 'dismissed'
      ) {
        s.total++;
      }
      if (entry.action === 'adopted' || entry.action === 'modified') {
        s.adopted++;
      }
    }
    const adoptionRateBySource: Record<string, number> = {};
    for (const [src, stats] of sourceMap) {
      adoptionRateBySource[src] = stats.total > 0 ? stats.adopted / stats.total : 0;
    }

    const decisionTotal = totalAdopted + totalDismissed;

    return {
      totalRecommendations,
      totalViewed,
      totalAdopted,
      totalDismissed,
      totalExpired,
      adoptionRate: decisionTotal > 0 ? totalAdopted / decisionTotal : 0,
      viewRate: totalRecommendations > 0 ? totalViewed / totalRecommendations : 0,
      adoptionRateBySource,
      since: sinceTs,
    };
  }

  /** 获取指定推荐 ID 的反馈历史 */
  getFeedbackFor(recommendationId: string): RecommendationFeedback[] {
    this.#ensureLoaded();
    return this.#entries.filter((e) => e.recommendationId === recommendationId);
  }

  /** 全部反馈条数 */
  get size(): number {
    this.#ensureLoaded();
    return this.#entries.length;
  }

  // ─── 内部方法 ──────────────────────────────────────────

  /** 惰性加载: 首次访问时从 JSONL 文件读取历史 */
  #ensureLoaded(): void {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    this.#loadFromDisk();
  }

  #loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.#filePath)) {
        return;
      }
      const content = fs.readFileSync(this.#filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries: FeedbackEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as FeedbackEntry);
        } catch {
          // 跳过损坏行
        }
      }
      // 只保留最近 N 条
      this.#entries =
        entries.length > MAX_MEMORY_ENTRIES ? entries.slice(-MAX_MEMORY_ENTRIES) : entries;
      if (this.#entries.length > 0) {
        this.#logger.debug(`FeedbackStore: loaded ${this.#entries.length} entries from disk`);
      }
    } catch (err: unknown) {
      this.#logger.warn('FeedbackStore: failed to load from disk', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export default FeedbackStore;
