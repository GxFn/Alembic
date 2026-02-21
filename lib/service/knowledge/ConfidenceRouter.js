import Logger from '../../infrastructure/logging/Logger.js';

/**
 * ConfidenceRouter — 知识条目自动审核路由器
 *
 * 根据 KnowledgeEntry 的 reasoning.confidence、质量评分、
 * 内容完整性等信号判断是否可自动审核通过。
 *
 * 路由结果:
 *   auto_approve — 置信度高、内容完整，自动通过 + fastTrack
 *   pending      — 需要人工审核
 *   reject       — 置信度过低或不满足基本要求
 */

const DEFAULT_CONFIG = {
  /** 自动通过的最低 confidence 阈值 */
  autoApproveThreshold: 0.85,
  /** 自动驳回的 confidence 阈值 */
  rejectThreshold: 0.2,
  /** 需要的最少内容字符数 */
  minContentLength: 20,
  /** 自动通过要求 reasoning.isValid() */
  requireReasoning: true,
  /** 来源白名单（这些来源可以适用更宽松的阈值） */
  trustedSources: ['bootstrap', 'cursor-scan'],
  /** 可信来源的自动通过阈值 */
  trustedAutoApproveThreshold: 0.7,
};

export class ConfidenceRouter {
  /**
   * @param {Object} [config] - 路由配置
   * @param {import('../quality/QualityScorer.js').QualityScorer} [qualityScorer]
   */
  constructor(config = {}, qualityScorer = null) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._qualityScorer = qualityScorer;
    this.logger = Logger.getInstance();
  }

  /**
   * 路由决策
   * @param {import('../../domain/knowledge/KnowledgeEntry.js').KnowledgeEntry} entry
   * @returns {Promise<{ action: 'auto_approve'|'pending'|'reject', reason: string, confidence?: number }>}
   */
  async route(entry) {
    const confidence = entry.reasoning?.confidence ?? 0;
    const source = entry.source || 'manual';
    const isTrusted = this._config.trustedSources.includes(source);

    // ── 阶段 1: 基本过滤 — 内容不完整直接 pending ──
    if (!entry.isValid()) {
      return {
        action: 'pending',
        reason: 'Content incomplete (title or content missing)',
        confidence,
      };
    }

    // ── 阶段 2: 低置信度驳回 ──
    if (confidence < this._config.rejectThreshold && confidence > 0) {
      return {
        action: 'reject',
        reason: `Confidence too low: ${confidence.toFixed(2)} < ${this._config.rejectThreshold}`,
        confidence,
      };
    }

    // ── 阶段 3: 内容最短长度检查 ──
    const contentLength = this._estimateContentLength(entry);
    if (contentLength < this._config.minContentLength) {
      return {
        action: 'pending',
        reason: `Content too short: ${contentLength} chars < ${this._config.minContentLength}`,
        confidence,
      };
    }

    // ── 阶段 4: Reasoning 检查 ──
    if (this._config.requireReasoning && !entry.reasoning?.isValid?.()) {
      // 无 reasoning 不驳回，但进入人工审核
      return {
        action: 'pending',
        reason: 'Reasoning not provided or invalid',
        confidence,
      };
    }

    // ── 阶段 5: 质量评分（可选） ──
    let qualityScore = null;
    if (this._qualityScorer) {
      try {
        const scorerInput = {
          title: entry.title,
          trigger: entry.trigger,
          code: entry.content?.pattern || entry.content?.markdown || '',
          language: entry.language,
          category: entry.category,
          summary: entry.summaryCn || entry.summaryEn || '',
          usageGuide: entry.usageGuideCn || entry.usageGuideEn || '',
          headers: entry.headers || [],
          tags: entry.tags || [],
        };
        const result = this._qualityScorer.score(scorerInput);
        qualityScore = result.score;
      } catch {
        // 评分失败不阻塞路由
      }
    }

    // ── 阶段 6: 自动通过判定 ──
    const threshold = isTrusted
      ? this._config.trustedAutoApproveThreshold
      : this._config.autoApproveThreshold;

    if (confidence >= threshold) {
      // 如果有质量评分且太低，降级到 pending
      if (qualityScore !== null && qualityScore < 0.3) {
        return {
          action: 'pending',
          reason: `Confidence OK (${confidence.toFixed(2)}) but quality low (${qualityScore.toFixed(2)})`,
          confidence,
        };
      }

      return {
        action: 'auto_approve',
        reason: `Confidence ${confidence.toFixed(2)} >= threshold ${threshold} (source: ${source})`,
        confidence,
      };
    }

    // ── 默认: 需要人工审核 ──
    return {
      action: 'pending',
      reason: `Confidence ${confidence.toFixed(2)} < threshold ${threshold}`,
      confidence,
    };
  }

  /**
   * 估算内容长度
   */
  _estimateContentLength(entry) {
    const content = entry.content;
    if (!content) {
      return 0;
    }

    const parts = [
      content.pattern,
      content.rationale,
      content.markdown,
      ...(content.steps || []).map((s) => (typeof s === 'string' ? s : s?.description || '')),
    ].filter(Boolean);

    return parts.reduce((sum, p) => sum + p.length, 0);
  }
}

export default ConfidenceRouter;
