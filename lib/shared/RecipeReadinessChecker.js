/**
 * RecipeReadinessChecker — 共享 Recipe-Ready 字段完整性检查
 *
 * 同时被 MCP handler 和 ChatAgent 使用，确保检查逻辑一致。
 *
 * @param {object} item - 候选数据（扁平字段或含 metadata 的对象）
 * @returns {{ ready: boolean, missing: string[], suggestions: string[] }}
 */

import { LanguageService } from './LanguageService.js';

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

  // ── 核心必填 ──
  if (!item.title || !String(item.title).trim()) {
    missing.push('title');
    suggestions.push('title 必须非空（中文简短标题 ≤20 字）');
  }

  // content 有效性（pattern/markdown/rationale 至少有实质内容）
  const hasCode = !!(item.code || item.content?.pattern || item.content?.markdown);
  if (!hasCode) {
    missing.push('content');
    suggestions.push('content 需包含 pattern 或 markdown（代码片段或正文）');
  }

  if (!item.content?.rationale && !item.rationale) {
    missing.push('rationale');
    suggestions.push('content.rationale 必须提供设计原理说明');
  }

  if (!item.language) {
    missing.push('language');
    suggestions.push('language 必须指定（如 swift/typescript/python/java/go 等）');
  }

  if (!item.kind) {
    missing.push('kind');
    suggestions.push('kind 必须为 rule/pattern/fact');
  }

  if (!item.doClause) {
    missing.push('doClause');
    suggestions.push('doClause 需为英文祈使句正向指令（≤60 tokens）');
  }

  if (!item.dontClause) {
    missing.push('dontClause');
    suggestions.push('dontClause 需为英文反向约束（描述禁止的做法）');
  }

  if (!item.whenClause) {
    missing.push('whenClause');
    suggestions.push('whenClause 需为英文触发场景（描述何时适用此规则）');
  }

  if (!item.coreCode || !String(item.coreCode).trim()) {
    missing.push('coreCode');
    suggestions.push('coreCode 需为 3-8 行纯代码骨架（语法完整、可直接复制）');
  }

  if (!item.category) {
    missing.push('category');
    suggestions.push(`category 必须为: ${STANDARD_CATEGORIES.join('/')}`);
  } else if (
    !STANDARD_CATEGORIES.includes(item.category) &&
    !WHITELISTED_CATEGORIES.includes(item.category)
  ) {
    suggestions.push(
      `category "${item.category}" 非标准值，应为: ${STANDARD_CATEGORIES.join('/')}（bootstrap/knowledge 等特殊来源可忽略此建议）`
    );
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

  if (!Array.isArray(item.headers)) {
    missing.push('headers');
    suggestions.push('请提供完整 import 语句数组，无 import 时传 []');
  }

  if (!item.usageGuide) {
    missing.push('usageGuide');
    suggestions.push('请提供使用指南（Markdown ### 章节格式）');
  }

  if (!item.knowledgeType) {
    missing.push('knowledgeType');
    suggestions.push('knowledgeType 必须指定（如 code-pattern/architecture/best-practice）');
  }

  // reasoning 检查
  if (!item.reasoning || typeof item.reasoning !== 'object') {
    missing.push('reasoning');
    suggestions.push('reasoning 必须包含 whyStandard + sources + confidence');
  } else {
    if (!item.reasoning.whyStandard?.trim()) {
      missing.push('reasoning.whyStandard');
    }
    if (!Array.isArray(item.reasoning.sources) || item.reasoning.sources.length === 0) {
      missing.push('reasoning.sources');
    }
  }

  const lang = item.language?.toLowerCase();
  // 使用 LanguageService 统一语言集，额外接受 'objc' 别名和 'markdown'
  if (lang && !LanguageService.isKnownLang(lang) && lang !== 'objc' && lang !== 'markdown') {
    suggestions.push(
      `language "${item.language}" — 请使用标准语言标识 (swift/typescript/python/java/kotlin 等)`
    );
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
