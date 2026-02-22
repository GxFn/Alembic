/**
 * GuardPatternUtils - Guard 模式匹配与掩码工具函数
 *
 * 从 GuardCheckEngine 拆分，包含:
 * - compilePattern: 正则编译（带缓存）
 * - clearPatternCache: 清除正则缓存
 * - buildTestBlockMask: 测试块掩码（Rust #[cfg(test)]）
 * - buildCommentMask: 注释行掩码
 * - detectLanguage: 文件扩展名推断语言
 */

import { LanguageService } from '../../shared/LanguageService.js';

/** @type {Map<string, RegExp>} 已编译的正则缓存 (pattern string → RegExp) */
const _regexCache = new Map();

/**
 * 编译正则模式（支持 RegExp 对象和 string，带缓存）
 * @param {RegExp|string} pattern
 * @returns {RegExp}
 */
export function compilePattern(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  const key = String(pattern);
  let cached = _regexCache.get(key);
  if (!cached) {
    cached = new RegExp(key);
    _regexCache.set(key, cached);
  }
  return cached;
}

/**
 * 清除正则缓存
 */
export function clearPatternCache() {
  _regexCache.clear();
}

/**
 * 构建内联测试块掩码
 * 目前支持 Rust #[cfg(test)] mod xxx { ... } 块
 * @param {string[]} lines
 * @param {string} language
 * @returns {boolean[]} 每行是否在测试块内
 */
export function buildTestBlockMask(lines, language) {
  const mask = new Array(lines.length).fill(false);

  // 目前仅 Rust 需要 — #[cfg(test)] 内联测试模块
  if (language !== 'rust') return mask;

  let inTestBlock = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    if (!inTestBlock) {
      // 检测 #[cfg(test)] 属性行
      if (/^#\[cfg\(test\)\]/.test(trimmed)) {
        // 向后找 mod xxx { — 标记为测试块起始
        // 可能在同一行: #[cfg(test)] mod tests {
        // 也可能在下一行: mod tests {
        const restOfLine = trimmed.slice('#[cfg(test)]'.length).trim();
        if (/^mod\s+\w+/.test(restOfLine)) {
          // 同一行有 mod 声明
          inTestBlock = true;
          braceDepth = 0;
          // 计算本行的花括号
          for (const ch of lines[i]) {
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
          }
          mask[i] = true;
          if (braceDepth <= 0) inTestBlock = false; // 单行 mod 声明 (mod tests;)
          continue;
        }
        // 检查下一行是否是 mod xxx {
        if (i + 1 < lines.length && /^\s*mod\s+\w+/.test(lines[i + 1])) {
          mask[i] = true; // #[cfg(test)] 行本身也标记
          inTestBlock = true;
          braceDepth = 0;
          // 下一行会在循环中处理
          continue;
        }
        // 单行 #[cfg(test)] 但后面不是 mod — 不处理
      }
    } else {
      // 正在测试块内 — 追踪花括号深度
      mask[i] = true;
      for (const ch of lines[i]) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0) {
        inTestBlock = false; // 测试块结束
      }
    }
  }

  return mask;
}

/**
 * 构建注释行掩码 — 识别行注释和块注释内部行
 *
 * 支持的注释形式:
 *   // 行注释,  /// 文档注释,  //! 内部文档注释  (C/Java/JS/TS/Go/Rust/Swift/Kotlin/Dart)
 *   # 行注释  (Python)
 *   /* ... * / 块注释  (C/Java/JS/TS/Go/Rust/Swift/Kotlin)
 *   \"\"\" ... \"\"\"  (Python doc-string — 简化: 整行以 \"\"\" 开头的行)
 *
 * @param {string[]} lines
 * @param {string} language
 * @returns {boolean[]} 每行是否为注释行
 */
export function buildCommentMask(lines, language) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false; // 是否在 /* ... */ 块内

  const usesHash = language === 'python'; // Python 用 # 注释
  const usesSlash = !usesHash;            // 其他语言用 //

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // 块注释延续
    if (inBlock) {
      mask[i] = true;
      if (trimmed.includes('*/')) {
        inBlock = false;
      }
      continue;
    }

    // 块注释开始（同行不闭合）
    if (usesSlash && /^\s*\/\*/.test(lines[i])) {
      mask[i] = true;
      if (!trimmed.includes('*/')) {
        inBlock = true;
      }
      continue;
    }

    // 行注释: // 或 /// 或 //!
    if (usesSlash && /^\s*\/\//.test(lines[i])) {
      mask[i] = true;
      continue;
    }

    // Python 行注释: #
    if (usesHash && /^\s*#/.test(lines[i])) {
      mask[i] = true;
      continue;
    }

    // Python docstring 行 (简化: 整行以 """ 或 ''' 开头)
    if (usesHash && /^\s*("""|''')/.test(lines[i])) {
      mask[i] = true;
      continue;
    }
  }

  return mask;
}

/**
 * 从文件扩展名推断语言
 */
export function detectLanguage(filePath) {
  if (!filePath) {
    return 'unknown';
  }
  const lang = LanguageService.inferLang(filePath);
  // 向后兼容: Guard 内置规则使用 'objc' 而非 'objectivec'
  return LanguageService.toGuardLangId(lang);
}
