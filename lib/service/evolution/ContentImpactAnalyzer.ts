/**
 * ContentImpactAnalyzer — Diff-Based Recipe 影响评估 (v3)
 *
 * 核心思想：影响评估分析「这次改了什么」（diff），而非「文件整体和 Recipe 有多像」。
 *
 * 流程：
 *   1. git diff -U0 获取文件行级变更
 *   2. 从变更行提取代码标识符（diff tokens）
 *   3. 从 Recipe 全字段提取特征标识符（recipe tokens）
 *   4. 计算加权交集：impact = |T_R ∩ T_Δ| / |T_R|
 *
 * 不支持 git 的场景直接跳过，不做降级。
 *
 * @module service/evolution/ContentImpactAnalyzer
 */

import { getFileDiff, parseDiffHunks, tokenizeDiffLines } from '../../shared/diff-parser.js';
import { LanguageService } from '../../shared/LanguageService.js';
import { extractCodeBlocksFromMarkdown } from '../../shared/markdown-utils.js';
import type { ImpactLevel } from '../../types/reactive-evolution.js';

const LANGUAGE_KEYWORDS = LanguageService.languageKeywords;

/* ────────────── Types ────────────── */

/** Recipe 的特征标识符集合 */
export interface RecipeTokens {
  /** 所有去重后的特征标识符 */
  tokens: Set<string>;
  /** 来源映射（用于调试） */
  sources: Map<string, 'coreCode' | 'markdown' | 'pattern' | 'steps'>;
}

/** Diff 影响评估结果 */
export interface DiffImpactResult {
  level: ImpactLevel;
  score: number;
  matchedTokens: string[];
}

/* ────────────── Public API ────────────── */

/**
 * 评估文件 diff 对 Recipe 的影响级别。
 *
 * 完整流程入口：获取 diff → 解析 → 提取 token → 与 Recipe token 交集计算。
 *
 * @param projectRoot 项目根目录绝对路径
 * @param relativePath 相对于项目根的文件路径
 * @param recipeTokens 预提取的 Recipe 特征标识符
 * @returns 影响评估结果，或 null（无法获取 diff 时）
 */
export function assessFileImpact(
  projectRoot: string,
  relativePath: string,
  recipeTokens: RecipeTokens
): DiffImpactResult | null {
  const diffText = getFileDiff(projectRoot, relativePath);
  if (!diffText) {
    return null;
  }

  const hunks = parseDiffHunks(diffText);
  if (hunks.length === 0) {
    return null;
  }

  const diffTokens = tokenizeDiffLines(hunks);
  return assessDiffImpact(diffTokens, recipeTokens);
}

/**
 * 计算 diff tokens 与 Recipe tokens 的加权交集，返回影响级别。
 *
 * 分级：
 *   - score ≥ 0.3 → `pattern`（diff 动到了 30%+ 的 Recipe 关键标识符）
 *   - score > 0   → `reference`（diff 动到了部分 Recipe 标识符）
 *   - score === 0 → `reference`（兜底：至少有 sourceRef 关联）
 *
 * @param diffTokens  diff 变更行中的标识符集合
 * @param recipeTokens Recipe 的特征标识符
 */
export function assessDiffImpact(
  diffTokens: Set<string>,
  recipeTokens: RecipeTokens
): DiffImpactResult {
  const matched: string[] = [];
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const token of recipeTokens.tokens) {
    const w = 1; // Phase 1: 等权。Phase 2 可引入 IDF
    totalWeight += w;
    if (diffTokens.has(token)) {
      matchedWeight += w;
      matched.push(token);
    }
  }

  if (totalWeight === 0) {
    return { level: 'reference', score: 0, matchedTokens: [] };
  }

  const score = matchedWeight / totalWeight;

  const level: ImpactLevel = score >= 0.3 ? 'pattern' : 'reference';

  return { level, score, matchedTokens: matched };
}

/**
 * 从 Recipe 的所有代码字段提取特征标识符。
 *
 * 提取来源（优先级从低到高）：
 *   1. coreCode — 教学模板，含占位符前缀
 *   2. content.markdown 中的代码块 — 真实代码，最高价值
 *   3. content.pattern — 代码片段
 *   4. content.steps[].code — 实施步骤代码
 */
export function extractRecipeTokens(entry: {
  coreCode?: string;
  language?: string;
  content?: {
    markdown?: string;
    pattern?: string;
    steps?: Array<{ code?: string }>;
  };
}): RecipeTokens {
  const tokens = new Set<string>();
  const sources = new Map<string, 'coreCode' | 'markdown' | 'pattern' | 'steps'>();

  // 1. coreCode
  if (entry.coreCode) {
    for (const t of extractApiTokens(entry.coreCode)) {
      tokens.add(t);
      sources.set(t, 'coreCode');
    }
  }

  // 2. content.markdown 中的代码块
  if (entry.content?.markdown) {
    const codeBlocks = extractCodeBlocksFromMarkdown(entry.content.markdown);
    for (const block of codeBlocks) {
      for (const t of extractApiTokens(block.code)) {
        tokens.add(t);
        sources.set(t, 'markdown');
      }
    }
  }

  // 3. content.pattern
  if (entry.content?.pattern) {
    for (const t of extractApiTokens(entry.content.pattern)) {
      tokens.add(t);
      sources.set(t, 'pattern');
    }
  }

  // 4. content.steps[].code
  if (entry.content?.steps) {
    for (const step of entry.content.steps) {
      if (step.code) {
        for (const t of extractApiTokens(step.code)) {
          tokens.add(t);
          sources.set(t, 'steps');
        }
      }
    }
  }

  return { tokens, sources };
}

/**
 * 从代码文本中提取有意义的 API 标识符。
 *
 * 过滤规则：
 *   - 长度 < 4 → 排除（for, let, var 等）
 *   - 占位符前缀（My*, Example*, Sample*...）→ 排除
 *   - 语言关键字 → 排除
 *
 * @param code 任意代码文本
 * @returns 去重后的标识符数组
 */
export function extractApiTokens(code: string): string[] {
  const allIdents = tokenizeIdentifiers(code);

  const filtered = allIdents.filter((id) => {
    if (id.length < 4) {
      return false;
    }
    if (/^(My|Example|Sample|Test|Foo|Bar|Baz|Demo|Dummy)/i.test(id)) {
      return false;
    }
    if (LANGUAGE_KEYWORDS.has(id.toLowerCase())) {
      return false;
    }
    return true;
  });

  return [...new Set(filtered)];
}

/**
 * 从代码文本中提取所有标识符 token。
 *
 * 预处理：移除注释和字符串字面量（避免从文档/字符串中误提取标识符）。
 *
 * @param code 任意代码文本
 * @returns 标识符数组（未去重）
 */
export function tokenizeIdentifiers(code: string): string[] {
  const cleaned = code
    .replace(/\/\/.*$/gm, '') // 行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // 双引号字符串
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // 单引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, '``'); // 模板字符串

  const matches = cleaned.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
  return matches ?? [];
}
