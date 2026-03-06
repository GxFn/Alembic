/**
 * RecipeReadinessChecker — 共享 Recipe-Ready 字段完整性检查
 *
 * ⚠️ 已重构为 UnifiedValidator 的薄封装。
 * 保留此模块以兼容旧调用方签名，新代码请直接使用 UnifiedValidator。
 *
 * @param {object} item 候选数据（扁平字段或含 metadata 的对象）
 * @returns {{ ready: boolean, missing: string[], suggestions: string[] }}
 */

import { UnifiedValidator } from './UnifiedValidator.js';

const STANDARD_CATEGORIES = [
  'View',
  'Service',
  'Tool',
  'Model',
  'Network',
  'Storage',
  'UI',
  'Utility',
];

/**
 * Bootstrap 等特殊来源使用的 category 白名单
 */
const WHITELISTED_CATEGORIES = ['bootstrap', 'knowledge', 'general'];

/**
 * 检查候选是否具备直接提升为 Recipe 的所有必要字段。
 *
 * 薄封装: 内部调用 UnifiedValidator，将结果转换为旧格式 { ready, missing, suggestions }。
 *
 * @param {object} item  扁平字段对象（title, trigger, description …）
 * @returns {{ ready: boolean, missing: string[], suggestions: string[] }}
 */
export function checkRecipeReadiness(item) {
  const validator = new UnifiedValidator();
  const result = validator.validate(item, {
    skipUniqueness: true, // readiness 检查不做去重
  });

  // 转换为旧格式: errors → missing 字段名, warnings → suggestions
  const missing = [];
  const suggestions = [];

  for (const error of result.errors) {
    // 从错误消息中提取字段名: "缺少必填字段: fieldName — rule"
    const match = error.match(/缺少必填字段:\s*(\S+)/);
    if (match) {
      missing.push(match[1]);
    }
    suggestions.push(error);
  }

  for (const warning of result.warnings) {
    suggestions.push(warning);
  }

  return { ready: missing.length === 0, missing, suggestions };
}

/**
 * 从 Candidate 的 metadata 对象展开为扁平字段后检查 readiness。
 */
export function checkReadinessFromCandidate(candidate) {
  const meta = candidate.metadata || {};
  const flat = {
    ...meta,
    code: candidate.code,
    language: candidate.language,
    category: candidate.category,
  };
  return checkRecipeReadiness(flat);
}

export { STANDARD_CATEGORIES, WHITELISTED_CATEGORIES };
