/**
 * @module LanguageService
 * @description 统一语言服务 — 项目中唯一的语言映射与检测来源
 *
 * 所有文件扩展名→语言映射、扩展名→显示名、主语言推断都必须通过此服务。
 * 禁止在业务代码中自建 langMap / _inferLang。
 *
 * ---
 * 使用方式：
 *   import { LanguageService } from '../shared/LanguageService.js';
 *   const lang = LanguageService.inferLang('App.swift');      // 'swift'
 *   const display = LanguageService.displayName('swift');       // 'Swift'
 *   const primary = LanguageService.detectPrimary(langStats);   // 'typescript'
 */

// ═══════════════════════════════════════════════════════════
// 1) 文件扩展名 → 规范化语言 ID
// ═══════════════════════════════════════════════════════════

/** @type {Readonly<Record<string, string>>} */
const EXT_TO_LANG = Object.freeze({
  // Apple
  '.swift': 'swift',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.h': 'objectivec', // C/ObjC 头文件默认归 objectivec

  // C/C++
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',

  // JavaScript/TypeScript
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'javascript',
  '.svelte': 'javascript',

  // Python
  '.py': 'python',

  // JVM
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',

  // Go / Rust / Ruby
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',

  // Dart / C#
  '.dart': 'dart',
  '.cs': 'csharp',

  // Markup / Data (常用)
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.plist': 'plist',
});

// ═══════════════════════════════════════════════════════════
// 2) 裸扩展名（不带 dot）→ 规范化语言 ID
//    用于 langStats（bootstrap 按 extname('.').replace('.','') 做 key）
// ═══════════════════════════════════════════════════════════

/** @type {Readonly<Record<string, string>>} */
const BARE_EXT_TO_LANG = Object.freeze({
  swift: 'swift',
  m: 'objectivec',
  mm: 'objectivec',
  h: 'objectivec',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'javascript',
  svelte: 'javascript',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  dart: 'dart',
  cs: 'csharp',
});

// ═══════════════════════════════════════════════════════════
// 3) 语言 ID → 人类可读显示名
// ═══════════════════════════════════════════════════════════

/** @type {Readonly<Record<string, string>>} */
const LANG_DISPLAY_NAMES = Object.freeze({
  swift: 'Swift',
  objectivec: 'Objective-C',
  c: 'C',
  cpp: 'C++',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  kotlin: 'Kotlin',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  dart: 'Dart',
  csharp: 'C#',
  markdown: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  plist: 'Property List',
  unknown: 'Unknown',
});

// ═══════════════════════════════════════════════════════════
// 4) 已知可分析的编程语言集合
// ═══════════════════════════════════════════════════════════

/** @type {ReadonlySet<string>} */
const KNOWN_PROGRAMMING_LANGS = Object.freeze(
  new Set([
    'swift',
    'objectivec',
    'c',
    'cpp',
    'javascript',
    'typescript',
    'python',
    'java',
    'kotlin',
    'go',
    'rust',
    'ruby',
    'dart',
    'csharp',
  ])
);

// ═══════════════════════════════════════════════════════════
// 5) 源代码扩展名（Guard / 文件收集时使用）
// ═══════════════════════════════════════════════════════════

/** @type {ReadonlySet<string>} */
const SOURCE_CODE_EXTS = Object.freeze(
  new Set([
    '.m',
    '.mm',
    '.h',
    '.swift',
    '.c',
    '.cpp',
    '.cc',
    '.cxx',
    '.hpp',
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.vue',
    '.svelte',
    '.py',
    '.java',
    '.kt',
    '.kts',
    '.go',
    '.rs',
    '.rb',
    '.dart',
    '.cs',
  ])
);

// ═══════════════════════════════════════════════════════════
// LanguageService — 静态单例
// ═══════════════════════════════════════════════════════════

export class LanguageService {
  // ─── 文件名 → 语言 ────────────────────────────

  /**
   * 从文件名（或路径）推断规范化语言 ID
   * @param {string} filename
   * @returns {string} 语言 ID，如 'swift', 'typescript', 'python', 'unknown'
   */
  static inferLang(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot === -1) {
      return 'unknown';
    }
    const ext = filename.slice(dot).toLowerCase();
    return EXT_TO_LANG[ext] || 'unknown';
  }

  /**
   * 从文件扩展名（带 dot）推断语言
   * @param {string} ext - 如 '.ts', '.py'
   * @returns {string}
   */
  static langFromExt(ext) {
    return EXT_TO_LANG[ext.toLowerCase()] || 'unknown';
  }

  // ─── 显示名 ────────────────────────────────────

  /**
   * 语言 ID → 人类可读名称
   * @param {string} langId
   * @returns {string}
   */
  static displayName(langId) {
    return LANG_DISPLAY_NAMES[langId] || langId;
  }

  /**
   * 文件扩展名（带 dot）→ 人类可读语言名
   * @param {string} ext - 如 '.swift', '.ts'
   * @returns {string}
   */
  static displayNameFromExt(ext) {
    const lang = EXT_TO_LANG[ext.toLowerCase()];
    return lang ? LANG_DISPLAY_NAMES[lang] || lang : ext;
  }

  // ─── 主语言检测 ────────────────────────────────

  /**
   * 从文件扩展名统计推断主语言
   * @param {Record<string, number>} langStats - key = 裸扩展名 (如 'ts', 'm', 'py')，value = 文件数
   * @returns {string} 主语言 ID
   */
  static detectPrimary(langStats) {
    if (!langStats || typeof langStats !== 'object') {
      return 'unknown';
    }
    // 按规范化语言聚合计数（避免 ObjC 的 .h/.m/.mm 分散）
    const aggregated = {};
    for (const [ext, count] of Object.entries(langStats)) {
      const lang = BARE_EXT_TO_LANG[ext] || ext;
      aggregated[lang] = (aggregated[lang] || 0) + count;
    }
    let best = 'unknown',
      bestCount = 0;
    for (const [lang, count] of Object.entries(aggregated)) {
      if (count > bestCount && KNOWN_PROGRAMMING_LANGS.has(lang)) {
        best = lang;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * 从文件扩展名统计返回所有检测到的编程语言（按文件数降序）
   * @param {Record<string, number>} langStats
   * @returns {Array<{ lang: string, count: number }>}
   */
  static detectAll(langStats) {
    if (!langStats || typeof langStats !== 'object') {
      return [];
    }
    const aggregated = {};
    for (const [ext, count] of Object.entries(langStats)) {
      const lang = BARE_EXT_TO_LANG[ext] || ext;
      aggregated[lang] = (aggregated[lang] || 0) + count;
    }
    return Object.entries(aggregated)
      .filter(([lang]) => KNOWN_PROGRAMMING_LANGS.has(lang))
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => ({ lang, count }));
  }

  /**
   * 多语言项目画像 — 返回主语言 + 次要语言 + 完整排序列表
   *
   * 与 detectPrimary 的区别:
   *   - detectPrimary 只给出一个语言，适用于需要单值场景
   *   - detectProfile 给出完整画像，适用于维度文案、AI prompt 等需要
   *     感知多语言的场景
   *
   * @param {Record<string, number>} langStats - key=裸扩展名, value=文件数
   * @param {object} [opts]
   * @param {number} [opts.secondaryThreshold=0.1] 次要语言文件占比阈值（≥此比例才算次要语言）
   * @returns {{ primary: string, secondary: string[], all: Array<{lang:string, count:number, ratio:number}>, totalFiles: number, isMultiLang: boolean }}
   */
  static detectProfile(langStats, opts = {}) {
    const threshold = opts.secondaryThreshold ?? 0.1;
    const all = LanguageService.detectAll(langStats);
    if (all.length === 0) {
      return { primary: 'unknown', secondary: [], all: [], totalFiles: 0, isMultiLang: false };
    }

    const totalFiles = all.reduce((s, e) => s + e.count, 0);
    const enriched = all.map((e) => ({ ...e, ratio: e.count / totalFiles }));
    const primary = enriched[0].lang;
    const secondary = enriched
      .slice(1)
      .filter((e) => e.ratio >= threshold)
      .map((e) => e.lang);

    return {
      primary,
      secondary,
      all: enriched,
      totalFiles,
      isMultiLang: secondary.length > 0,
    };
  }

  // ─── 查询方法 ─────────────────────────────────

  /**
   * 该语言 ID 是否是已知编程语言
   * @param {string} langId
   * @returns {boolean}
   */
  static isKnownLang(langId) {
    return KNOWN_PROGRAMMING_LANGS.has(langId);
  }

  /**
   * 该扩展名是否为源代码文件
   * @param {string} ext - 带 dot，如 '.ts'
   * @returns {boolean}
   */
  static isSourceExt(ext) {
    return SOURCE_CODE_EXTS.has(ext.toLowerCase());
  }

  /**
   * 获取所有源代码扩展名（不可变）
   * @returns {ReadonlySet<string>}
   */
  static get sourceExts() {
    return SOURCE_CODE_EXTS;
  }

  /**
   * 获取所有已知编程语言 ID（不可变）
   * @returns {ReadonlySet<string>}
   */
  static get knownLangs() {
    return KNOWN_PROGRAMMING_LANGS;
  }

  /**
   * 获取完整的 ext→lang 映射（不可变）
   * @returns {Readonly<Record<string, string>>}
   */
  static get extToLangMap() {
    return EXT_TO_LANG;
  }

  /**
   * 获取完整的 bareExt→lang 映射（不可变）
   * @returns {Readonly<Record<string, string>>}
   */
  static get bareExtToLangMap() {
    return BARE_EXT_TO_LANG;
  }

  /**
   * 根据语言 ID 返回主扩展名（带 dot）
   * @param {string} langId - 如 'go', 'swift', 'python'
   * @returns {string|null} - 如 '.go', '.swift', '.py'；未知返回 null
   */
  static extForLang(langId) {
    if (!langId) return null;
    const lower = langId.toLowerCase();
    for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
      if (lang === lower) return ext;
    }
    return null;
  }
}

export default LanguageService;
