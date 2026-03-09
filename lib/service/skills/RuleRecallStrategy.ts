/**
 * RuleRecallStrategy — 将 SkillAdvisor 包装为 RecallStrategy 接口
 *
 * 零 AI 依赖、零延迟，作为离线 fallback 和基础召回来源。
 * 复用 SkillAdvisor 的 4 维分析（Guard 违规、Memory 偏好、Recipe 分布、候选积压），
 * 将 SkillSuggestion 转换为标准 RecommendationCandidate。
 */

import { SkillAdvisor } from './SkillAdvisor.js';
import type { RecallStrategy, RecommendationCandidate, RecommendationContext } from './types.js';

export class RuleRecallStrategy implements RecallStrategy {
  readonly name = 'rule';
  readonly type = 'rule' as const;

  async recall(context: RecommendationContext): Promise<RecommendationCandidate[]> {
    const db = context.database as Parameters<
      (typeof SkillAdvisor.prototype)['suggest']
    > extends never[]
      ? never
      : {
          prepare(sql: string): {
            all(...args: unknown[]): Record<string, unknown>[];
            get(...args: unknown[]): Record<string, unknown> | undefined;
          };
        } | null;

    const advisor = new SkillAdvisor(context.projectRoot, {
      database: db as SkillAdvisorDatabase,
    });

    const result = advisor.suggest();

    // 过滤已有 Skill
    const existingSet = context.existingSkills ?? new Set<string>();

    return result.suggestions
      .filter((s) => !existingSet.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description,
        rationale: s.rationale,
        source: `rule:${s.source}`,
        priority: s.priority,
        signals: s.signals,
      }));
  }

  isAvailable(_context: RecommendationContext): boolean {
    // 规则召回始终可用
    return true;
  }
}

/** SkillAdvisor 期望的 database 接口 */
type SkillAdvisorDatabase = {
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
  };
} | null;

export default RuleRecallStrategy;
