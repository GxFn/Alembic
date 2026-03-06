/**
 * GuardFeedbackLoop — Guard ↔ Recipe 闭环联动
 *
 * 功能:
 *   1. 对比当前和历史 violations，检测已修复的违规
 *   2. 已修复违规如有 fixSuggestion → 自动 confirmUsage（记录 Recipe 使用）
 *   3. 集成到 guardAuditFiles MCP handler 和 GuardHandler (FileWatcher)
 */

import Logger from '../../infrastructure/logging/Logger.js';

export class GuardFeedbackLoop {
  feedbackCollector: any;
  guardCheckEngine: any;
  logger: any;
  violationsStore: any;
  /**
   * @param {import('./ViolationsStore.js').ViolationsStore} violationsStore
   * @param {import('../quality/FeedbackCollector.js').FeedbackCollector} feedbackCollector
   * @param {object} [options]
   * @param {import('./GuardCheckEngine.js').GuardCheckEngine} [options.guardCheckEngine] 用于查找规则
   */
  constructor(violationsStore, feedbackCollector, options: any = {}) {
    this.violationsStore = violationsStore;
    this.feedbackCollector = feedbackCollector;
    this.guardCheckEngine = options.guardCheckEngine || null;
    this.logger = Logger.getInstance();
  }

  /**
   * 对比当前和历史 violations，检测已修复的违规
   * @param {{ violations: Array<{ruleId: string}> }} currentResult 本次检查结果
   * @param {string} filePath 文件路径
   * @returns {Array<{ ruleId: string, filePath: string, fixRecipeId: string }>} 已修复且有 Recipe 关联的列表
   */
  detectFixedViolations(currentResult, filePath) {
    if (!this.violationsStore) {
      return [];
    }

    try {
      const previousRuns = this.violationsStore.getRunsByFile(filePath);
      if (previousRuns.length === 0) {
        return [];
      }

      // 取最近一次运行结果
      const lastRun = previousRuns[previousRuns.length - 1];
      const lastRuleIds = new Set((lastRun.violations || []).map((v) => v.ruleId));
      const currentRuleIds = new Set((currentResult.violations || []).map((v) => v.ruleId));

      const fixed = [];
      for (const ruleId of lastRuleIds) {
        if (!currentRuleIds.has(ruleId)) {
          // 该规则的违规已消失 → 修复了
          const fixRecipeId = this._findFixRecipe(ruleId, lastRun.violations);
          if (fixRecipeId) {
            fixed.push({ ruleId, filePath, fixRecipeId });
          }
        }
      }

      return fixed;
    } catch (err: any) {
      this.logger.debug(`[GuardFeedbackLoop] detectFixedViolations error: ${err.message}`);
      return [];
    }
  }

  /**
   * 对已修复的违规自动确认使用
   * @param {Array<{ ruleId: string, filePath: string, fixRecipeId: string }>} fixedList
   */
  autoConfirmUsage(fixedList) {
    if (!this.feedbackCollector || !fixedList?.length) {
      return;
    }

    for (const { ruleId, fixRecipeId, filePath } of fixedList) {
      try {
        this.feedbackCollector.record('insert', fixRecipeId, {
          source: 'guard_fix_detection',
          automatic: true,
          ruleId,
          filePath,
        });
        this.logger.info(
          `[GuardFeedbackLoop] Auto-confirmed usage: recipe=${fixRecipeId} from fixing rule=${ruleId}`
        );
      } catch (err: any) {
        this.logger.debug(`[GuardFeedbackLoop] autoConfirmUsage error: ${err.message}`);
      }
    }
  }

  /**
   * 一站式处理：检测修复 + 自动确认
   * 供 MCP handler、GuardHandler、HTTP guard/file 端点集成调用
   * @param {{ violations: Array }} currentResult
   * @param {string} filePath
   */
  processFixDetection(currentResult, filePath) {
    const fixed = this.detectFixedViolations(currentResult, filePath);
    if (fixed.length > 0) {
      this.autoConfirmUsage(fixed);
      this.logger.info(
        `[GuardFeedbackLoop] Detected ${fixed.length} fixed violations in ${filePath}`
      );
    }
    return fixed;
  }

  /**
   * 获取闭环统计数据
   * @returns {{ totalFixDetected: number, totalConfirmed: number }}
   */
  getStats() {
    return {
      hasViolationsStore: !!this.violationsStore,
      hasFeedbackCollector: !!this.feedbackCollector,
      hasGuardCheckEngine: !!this.guardCheckEngine,
    };
  }

  /**
   * 从 violation 或 GuardCheckEngine 查找 fixRecipeId
   * 增强：当无显式 fixSuggestion 时，以 ruleId 本身作为 fallback recipeId
   * 这允许 Knowledge Base 中以 ruleId 命名的条目自动关联
   */
  _findFixRecipe(ruleId, violations) {
    // 先从 violation 本身的 fixSuggestion 查找
    for (const v of violations || []) {
      if (v.ruleId === ruleId && v.fixSuggestion) {
        return v.fixSuggestion.replace(/^recipe:/, '');
      }
    }

    // 再从 GuardCheckEngine 的规则定义中查找
    if (this.guardCheckEngine) {
      try {
        const rules = this.guardCheckEngine.getRules();
        const rule = rules.find((r) => r.id === ruleId);
        if (rule?.fixSuggestion) {
          return rule.fixSuggestion.replace(/^recipe:/, '');
        }
      } catch {
        /* ignore */
      }
    }

    // fallback: 用 ruleId 本身作为 recipeId — 允许知识库按规则 ID 索引
    return ruleId || null;
  }
}

export default GuardFeedbackLoop;
