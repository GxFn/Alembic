/**
 * ContentImpactAnalyzer — 基于内容的 Recipe 影响评估
 *
 * 从 coreCode 提取 API 标识符，与文件内容做 token 级比对，
 * 判断文件变更是否实质影响了 Recipe 描述的代码模式。
 *
 * 拆分自 FileChangeHandler，单一职责：纯内容分析，无 I/O 或副作用。
 *
 * @module service/evolution/ContentImpactAnalyzer
 */

import fs from 'node:fs';
import path from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import type { ImpactLevel } from '../../types/reactive-evolution.js';

const LANGUAGE_KEYWORDS = LanguageService.languageKeywords;

/* ────────────── Public API ────────────── */

/**
 * 评估文件修改对 Recipe 的影响级别。
 *
 * 对 modified 事件，此函数**从不**返回 `direct`：
 *   - 没有 before/after diff 无法确定"破坏性变更"
 *   - `direct` 专属于 deleted / renamed 事件
 *
 * @param fileContent 文件当前内容（null = 文件不可读）
 * @param coreCode    Recipe 的 coreCode 字段
 * @returns impactLevel: 'pattern' | 'reference'
 */
export function assessContentImpact(fileContent: string | null, coreCode: string): ImpactLevel {
  // 文件不可读（被删除、权限等）→ reference
  if (fileContent === null) {
    return 'reference';
  }

  // coreCode 为空或太短 → 无法分析
  if (!coreCode || coreCode.trim().length < 15) {
    return 'reference';
  }

  const apiTokens = extractApiTokens(coreCode);
  if (apiTokens.length === 0) {
    return 'reference';
  }

  const presenceRate = tokenPresenceRate(apiTokens, fileContent);

  // 高存在率（≥40%）：文件包含 coreCode 描述的模式，且模式仍完好 → pattern
  // 低存在率（<40%）：coreCode 模式不在该文件中（最常见），或被删除 → reference
  if (presenceRate >= 0.4) {
    return 'pattern';
  }

  return 'reference';
}

/**
 * 计算 apiTokens 在目标代码中的存在率（单向包含率）。
 *
 * 与 shared/similarity.ts 的 jaccardSimilarity 区别：
 *   - Jaccard = |A∩B| / |A∪B|（对称，受 B 集合大小影响）
 *   - presenceRate = |A∩B| / |A|（单向：只关心 A 中有多少在 B 中出现）
 *
 * @param sourceTokens 要查找的 token 列表
 * @param targetCode   目标代码文本
 * @returns 0.0 - 1.0
 */
export function tokenPresenceRate(sourceTokens: string[], targetCode: string): number {
  if (sourceTokens.length === 0) {
    return 0;
  }
  const targetTokenSet = new Set(tokenizeIdentifiers(targetCode));
  let count = 0;
  for (const token of sourceTokens) {
    if (targetTokenSet.has(token)) {
      count++;
    }
  }
  return count / sourceTokens.length;
}

/**
 * 从 coreCode 中提取有意义的 API 标识符。
 *
 * 过滤规则：
 *   - 长度 < 4 → 排除（for, let, var 等）
 *   - 占位符前缀（My*, Example*, Sample*...）→ 排除
 *   - 语言关键字 → 排除
 *
 * @param coreCode Recipe 的 coreCode
 * @returns 去重后的标识符数组
 */
export function extractApiTokens(coreCode: string): string[] {
  const allIdents = tokenizeIdentifiers(coreCode);

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

/* ────────────── 文件读取 ────────────── */

/**
 * 从磁盘读取项目源文件内容。
 *
 * @param projectRoot 项目根目录绝对路径
 * @param relativePath 相对于项目根的文件路径
 * @returns 文件内容，不可读时返回 null
 */
export function readProjectFile(projectRoot: string, relativePath: string): string | null {
  try {
    const fullPath = path.resolve(projectRoot, relativePath);
    return fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}
