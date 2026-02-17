/**
 * RecipeReadinessChecker — 共享 Recipe-Ready 字段完整性检查
 *
 * 同时被 MCP handler 和 ChatAgent 使用，确保检查逻辑一致。
 *
 * @param {object} item - 候选数据（扁平字段或含 metadata 的对象）
 * @returns {{ ready: boolean, missing: string[], suggestions: string[] }}
 */

const STANDARD_CATEGORIES = ['View', 'Service', 'Tool', 'Model', 'Network', 'Storage', 'UI', 'Utility'];

/**
 * Bootstrap 等特殊来源使用的 category 白名单 —— 这些 category
 * 不属于标准值但在特定流程中合法；RecipeReadiness 仅给出建议
 * 而非标记为 missing。
 */
const WHITELISTED_CATEGORIES = ['bootstrap', 'knowledge', 'general'];

/**
 * 检查候选是否具备直接提升为 Recipe 的所有必要字段。
 *
 * @param {object} item  扁平字段对象（title, trigger, description …）
 *                       —— MCP handler 传入 tool params；
 *                       ChatAgent / bootstrap 需先从 metadata 展开。
 * @returns {{ ready: boolean, missing: string[], suggestions: string[] }}
 */
export function checkRecipeReadiness(item) {
  const missing = [];
  const suggestions = [];

  // ── 必填 ──
  if (!item.category) {
    missing.push('category');
    suggestions.push('category 必须为: ' + STANDARD_CATEGORIES.join('/'));
  } else if (!STANDARD_CATEGORIES.includes(item.category) && !WHITELISTED_CATEGORIES.includes(item.category)) {
    suggestions.push(`category "${item.category}" 非标准值，应为: ${STANDARD_CATEGORIES.join('/')}（bootstrap/knowledge 等特殊来源可忽略此建议）`);
  }

  if (!item.trigger) {
    missing.push('trigger');
    suggestions.push('trigger 必须以 @ 开头，如 @video-cover-cell');
  } else if (!item.trigger.startsWith('@')) {
    suggestions.push(`trigger "${item.trigger}" 应以 @ 开头`);
  }

  const description = item.description || item.summary;
  if (!description) {
    missing.push('description');
    suggestions.push('请提供描述（≤100字）');
  }

  if (!Array.isArray(item.headers) || item.headers.length === 0) {
    missing.push('headers');
    suggestions.push('请提供完整 import 语句数组，如 ["#import <Module/Header.h>"]');
  }

  // ── 建议 ──
  if (!item.usageGuide) {
    missing.push('usageGuide');
    suggestions.push('请提供使用指南（Markdown ### 章节格式）');
  }

  if (!item.knowledgeType) {
    missing.push('knowledgeType');
  }

  if (!item.rationale) {
    missing.push('rationale');
  }

  const lang = item.language?.toLowerCase();
  if (lang && lang !== 'swift' && lang !== 'objectivec' && lang !== 'objc' && lang !== 'markdown') {
    suggestions.push(`language "${item.language}" — Recipe 一般为 swift/objectivec/markdown`);
  }

  return { ready: missing.length === 0, missing, suggestions };
}

/**
 * 从 Candidate 的 metadata 对象展开为扁平字段后检查 readiness。
 * 适用于 ChatAgent / bootstrap 等不使用扁平 tool params 的路径。
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
