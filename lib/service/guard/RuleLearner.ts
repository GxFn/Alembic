/**
 * RuleLearner — Guard 规则学习系统
 * 追踪规则触发与用户反馈，计算 P/R/F1，识别高误报规则并给出优化建议
 * 持久化到 AutoSnippet/guard-learner.json（Git 友好）
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import { RULE_LEARNER } from '../../shared/constants.js';
import pathGuard from '../../shared/PathGuard.js';

const PROBLEMATIC_THRESHOLD = {
  falsePositiveRate: RULE_LEARNER.PROBLEMATIC_FALSE_POSITIVE_RATE,
  minTriggers: RULE_LEARNER.PROBLEMATIC_MIN_TRIGGERS,
};

export class RuleLearner {
  #learnerPath;
  #data; // { ruleStats: { [ruleId]: { triggers, correct, falsePositive, falseNegative } } }

  constructor(projectRoot: any, options: any = {}) {
    const kbDir = options.knowledgeBaseDir || 'AutoSnippet';
    this.#learnerPath = join(projectRoot, kbDir, 'guard-learner.json');
    pathGuard.assertProjectWriteSafe(this.#learnerPath);
    this.#migrateOldPath(projectRoot, options.internalDir || '.autosnippet');
    this.#data = this.#load();
  }

  /**
   * 记录规则触发
   * @param {string} ruleId
   * @param {{ filePath?: string, message?: string }} context
   */
  recordTrigger(ruleId: any, context: any = {}) {
    const stat = this.#ensureStat(ruleId);
    stat.triggers++;
    const now = new Date().toISOString();
    stat.lastTriggered = now;
    if (!stat.firstTriggered) {
      stat.firstTriggered = now;
    }
    this.#save();
  }

  /**
   * 记录用户反馈
   * @param {string} ruleId
   * @param {'correct'|'falsePositive'|'falseNegative'} feedbackType
   */
  recordFeedback(ruleId: any, feedbackType: any) {
    const stat = this.#ensureStat(ruleId);
    if (feedbackType === 'correct') {
      stat.correct++;
    } else if (feedbackType === 'falsePositive') {
      stat.falsePositive++;
    } else if (feedbackType === 'falseNegative') {
      stat.falseNegative++;
    }
    stat.lastFeedback = new Date().toISOString();
    this.#save();
  }

  /**
   * 获取规则精准度指标
   * @param {string} ruleId
   * @returns {{ precision: number, recall: number, f1: number, triggers: number, falsePositiveRate: number }}
   */
  getMetrics(ruleId: any) {
    const stat = this.#data.ruleStats[ruleId];
    if (!stat || stat.triggers === 0) {
      return { precision: 1, recall: 1, f1: 1, triggers: 0, falsePositiveRate: 0 };
    }

    const tp = stat.correct;
    const fp = stat.falsePositive;
    const fn = stat.falseNegative;

    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const falsePositiveRate = stat.triggers > 0 ? fp / stat.triggers : 0;

    return { precision, recall, f1, triggers: stat.triggers, falsePositiveRate };
  }

  /**
   * 识别问题规则（高误报）
   * @returns {Array<{ ruleId: string, metrics: object, recommendation: string }>}
   */
  getProblematicRules() {
    const results: any[] = [];
    for (const [ruleId, stat] of Object.entries(this.#data.ruleStats) as [string, any][]) {
      if (stat.triggers < PROBLEMATIC_THRESHOLD.minTriggers) {
        continue;
      }

      const metrics = this.getMetrics(ruleId);
      if (metrics.falsePositiveRate >= PROBLEMATIC_THRESHOLD.falsePositiveRate) {
        let recommendation;
        if (metrics.falsePositiveRate > 0.7) {
          recommendation = 'disable';
        } else if (metrics.precision < 0.5) {
          recommendation = 'tune';
        } else {
          recommendation = 'review';
        }
        results.push({ ruleId, metrics, recommendation });
      }
    }
    return results.sort((a, b) => b.metrics.falsePositiveRate - a.metrics.falsePositiveRate);
  }

  /**
   * 获取所有规则统计
   */
  getAllStats() {
    const result: Record<string, any> = {};
    for (const [ruleId] of Object.entries(this.#data.ruleStats)) {
      result[ruleId] = {
        ...this.#data.ruleStats[ruleId],
        metrics: this.getMetrics(ruleId),
      };
    }
    return result;
  }

  /**
   * 重置指定规则或全部统计
   */
  resetStats(ruleId = null) {
    if (ruleId) {
      delete this.#data.ruleStats[ruleId];
    } else {
      this.#data.ruleStats = {};
    }
    this.#save();
  }

  /**
   * 基于历史数据提出规则优化建议
   * 策略 1: 高误报规则 → 建议调整
   * 策略 2: 高触发且高精度 → 建议创建项目特化版本
   * @returns {Array<{ type: string, ruleId: string, message: string, confidence: number, evidence: object }>}
   */
  suggestRules() {
    const suggestions: any[] = [];

    // 策略 1: 从高误报规则推导改进建议
    const problematic = this.getProblematicRules();
    for (const p of problematic) {
      if (p.recommendation === 'tune') {
        suggestions.push({
          type: 'tune_existing',
          ruleId: p.ruleId,
          message: `规则 ${p.ruleId} 误报率 ${(p.metrics.falsePositiveRate * 100).toFixed(0)}%，建议调整正则或收窄语言范围`,
          confidence: RULE_LEARNER.CONFIDENCE_TUNE,
          evidence: p.metrics,
        });
      } else if (p.recommendation === 'disable') {
        suggestions.push({
          type: 'disable',
          ruleId: p.ruleId,
          message: `规则 ${p.ruleId} 误报率 ${(p.metrics.falsePositiveRate * 100).toFixed(0)}%，建议禁用`,
          confidence: RULE_LEARNER.CONFIDENCE_DISABLE,
          evidence: p.metrics,
        });
      }
    }

    // 策略 2: 高触发 + 高精度内置规则 → 建议创建项目定制版
    const allStats = this.getAllStats();
    for (const [ruleId, stat] of Object.entries(allStats) as [string, any][]) {
      if (
        stat.triggers > RULE_LEARNER.HIGH_TRIGGER_COUNT &&
        (stat.metrics?.precision ?? 1) > RULE_LEARNER.HIGH_PRECISION
      ) {
        suggestions.push({
          type: 'specialize',
          ruleId,
          message: `规则 ${ruleId} 触发 ${stat.triggers} 次且精准度高 (${((stat.metrics?.precision ?? 1) * 100).toFixed(0)}%)，建议创建项目定制版本`,
          confidence: RULE_LEARNER.CONFIDENCE_SPECIALIZE,
          evidence: stat.metrics,
        });
      }
    }

    // 策略 3: 长期无触发的规则 → 可能不适用
    for (const [ruleId, stat] of Object.entries(allStats) as [string, any][]) {
      if (stat.triggers === 0 && stat.lastTriggered) {
        const daysSinceLastTrigger =
          (Date.now() - new Date(stat.lastTriggered).getTime()) / 86400000;
        if (daysSinceLastTrigger > RULE_LEARNER.UNUSED_DAYS_THRESHOLD) {
          suggestions.push({
            type: 'review_unused',
            ruleId,
            message: `规则 ${ruleId} 超过 ${RULE_LEARNER.UNUSED_DAYS_THRESHOLD} 天未触发，建议审查是否仍需保留`,
            confidence: RULE_LEARNER.CONFIDENCE_REVIEW,
            evidence: {
              daysSinceLastTrigger: Math.round(daysSinceLastTrigger),
              triggers: stat.triggers,
            },
          });
        }
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 追踪规则创建后的效果
   * 对比首次触发后的表现，判断规则是否有效
   * @param {string} ruleId
   * @returns {{ status: string, triggers: number, precision: number, recommendation: string, daysSinceFirstTrigger?: number }}
   */
  trackRuleEffectiveness(ruleId: any) {
    const stat = this.#data.ruleStats[ruleId];
    if (!stat) {
      return { status: 'no_data', triggers: 0, precision: 1, recommendation: 'monitor' };
    }

    const firstTriggered = stat.firstTriggered || stat.lastTriggered;
    if (!firstTriggered) {
      return { status: 'no_triggers', triggers: 0, precision: 1, recommendation: 'monitor' };
    }

    const daysSinceFirstTrigger = (Date.now() - new Date(firstTriggered).getTime()) / 86400000;

    // 不足 14 天 → 观察期
    if (daysSinceFirstTrigger < 14) {
      return {
        status: 'monitoring',
        triggers: stat.triggers,
        precision: this.getMetrics(ruleId).precision,
        recommendation: 'wait',
        daysSinceFirstTrigger: Math.round(daysSinceFirstTrigger),
      };
    }

    const metrics = this.getMetrics(ruleId);

    // 14 天后判定
    if (
      metrics.precision < RULE_LEARNER.LOW_PRECISION &&
      stat.triggers >= PROBLEMATIC_THRESHOLD.minTriggers
    ) {
      return {
        status: 'ineffective',
        triggers: stat.triggers,
        precision: metrics.precision,
        recommendation: 'review_or_disable',
        daysSinceFirstTrigger: Math.round(daysSinceFirstTrigger),
      };
    }

    return {
      status: 'effective',
      triggers: stat.triggers,
      precision: metrics.precision,
      recommendation: 'keep',
      daysSinceFirstTrigger: Math.round(daysSinceFirstTrigger),
    };
  }

  // ─── 私有 ─────────────────────────────────────────────

  #ensureStat(ruleId: any) {
    if (!this.#data.ruleStats[ruleId]) {
      this.#data.ruleStats[ruleId] = {
        triggers: 0,
        correct: 0,
        falsePositive: 0,
        falseNegative: 0,
        firstTriggered: null,
        lastTriggered: null,
        lastFeedback: null,
      };
    }
    return this.#data.ruleStats[ruleId];
  }

  #load() {
    try {
      if (existsSync(this.#learnerPath)) {
        return JSON.parse(readFileSync(this.#learnerPath, 'utf-8'));
      }
    } catch {
      /* silent */
    }
    return { ruleStats: {} };
  }

  #save() {
    try {
      const dir = dirname(this.#learnerPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.#learnerPath, JSON.stringify(this.#data, null, 2));
    } catch (err: any) {
      Logger.getInstance().warn('RuleLearner: failed to persist learner data', {
        error: err.message,
      });
    }
  }

  #migrateOldPath(projectRoot: any, internalDir: any) {
    try {
      const oldPath = join(projectRoot, internalDir, 'guard-learner.json');
      if (existsSync(oldPath) && !existsSync(this.#learnerPath)) {
        const content = readFileSync(oldPath, 'utf-8');
        const dir = dirname(this.#learnerPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.#learnerPath, content);
        unlinkSync(oldPath);
      }
    } catch {
      /* 迁移失败不阻断启动 */
    }
  }
}
