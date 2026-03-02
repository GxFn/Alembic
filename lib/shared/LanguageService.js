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
 *   const langs  = LanguageService.detectProjectLanguages('/path/to/project');
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
// 5.5) 语言别名映射 — 将常见缩写/变体归一化为规范 ID
// ═══════════════════════════════════════════════════════════

/** @type {Readonly<Record<string, string>>} */
const LANG_ALIASES = Object.freeze({
  // Objective-C variants
  objc: 'objectivec',
  'objective-c': 'objectivec',
  'obj-c': 'objectivec',
  // TypeScript
  ts: 'typescript',
  tsx: 'typescript',
  // JavaScript
  js: 'javascript',
  jsx: 'javascript',
  // C++
  'c++': 'cpp',
  cxx: 'cpp',
  // C#
  'c#': 'csharp',
  cs: 'csharp',
  // Python
  py: 'python',
  python3: 'python',
  // Kotlin
  kt: 'kotlin',
  // Rust
  rs: 'rust',
  // Go
  golang: 'go',
  // Ruby
  rb: 'ruby',
});

// ═══════════════════════════════════════════════════════════
// 6) 生态系统/Discoverer ID → 对应编程语言 ID 数组
// ═══════════════════════════════════════════════════════════

/** @type {Readonly<Record<string, readonly string[]>>} */
const ECO_TO_LANGS = Object.freeze({
  spm: Object.freeze(['swift', 'objectivec']),
  node: Object.freeze(['javascript', 'typescript']),
  go: Object.freeze(['go']),
  jvm: Object.freeze(['java', 'kotlin']),
  python: Object.freeze(['python']),
  dart: Object.freeze(['dart']),
  rust: Object.freeze(['rust']),
  dotnet: Object.freeze(['csharp']),
  ruby: Object.freeze(['ruby']),
  generic: Object.freeze([]),
});

// ═══════════════════════════════════════════════════════════
// 7) 构建系统标志文件 → 生态系统映射（项目级语言检测的核心数据）
// ═══════════════════════════════════════════════════════════

/**
 * @typedef {{ file: string, eco: string, buildTool: string }} BuildSystemMarker
 * @type {ReadonlyArray<BuildSystemMarker>}
 */
const BUILD_SYSTEM_MARKERS = Object.freeze([
  // Apple / iOS
  { file: 'Package.swift', eco: 'spm', buildTool: 'SPM' },
  { file: 'Podfile', eco: 'spm', buildTool: 'CocoaPods' },
  // JS / TS (lock files before package.json to detect specific tool)
  { file: 'yarn.lock', eco: 'node', buildTool: 'Yarn' },
  { file: 'pnpm-lock.yaml', eco: 'node', buildTool: 'pnpm' },
  { file: 'package.json', eco: 'node', buildTool: 'npm' },
  // Python
  { file: 'Pipfile', eco: 'python', buildTool: 'Pipenv' },
  { file: 'pyproject.toml', eco: 'python', buildTool: 'Poetry' },
  { file: 'setup.py', eco: 'python', buildTool: 'setuptools' },
  { file: 'requirements.txt', eco: 'python', buildTool: 'pip' },
  // Go
  { file: 'go.mod', eco: 'go', buildTool: 'Go Modules' },
  // Rust
  { file: 'Cargo.toml', eco: 'rust', buildTool: 'Cargo' },
  // JVM
  { file: 'pom.xml', eco: 'jvm', buildTool: 'Maven' },
  { file: 'build.gradle', eco: 'jvm', buildTool: 'Gradle' },
  { file: 'build.gradle.kts', eco: 'jvm', buildTool: 'Gradle (Kotlin)' },
  // Dart / Flutter
  { file: 'pubspec.yaml', eco: 'dart', buildTool: 'Flutter' },
  { file: 'melos.yaml', eco: 'dart', buildTool: 'Melos' },
  // C# / .NET
  { file: '*.csproj', eco: 'dotnet', buildTool: '.NET' },
  { file: '*.sln', eco: 'dotnet', buildTool: '.NET' },
  // Ruby
  { file: 'Gemfile', eco: 'ruby', buildTool: 'Bundler' },
]);

/** 扫描目录时跳过的标准目录（性能优化） */
const SCAN_SKIP_DIRS = Object.freeze(
  new Set([
    '.git',
    'node_modules',
    '.build',
    'build',
    'dist',
    'target',
    'out',
    'vendor',
    '.cache',
    'Pods',
    'DerivedData',
    '__pycache__',
    '.venv',
    'venv',
    '.gradle',
    'Carthage',
    '.fvm',
    '.dart_tool',
    '.cargo',
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
    if (!filename || typeof filename !== 'string') {
      return 'unknown';
    }
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
    if (!ext || typeof ext !== 'string') {
      return 'unknown';
    }
    return EXT_TO_LANG[ext.toLowerCase()] || 'unknown';
  }

  // ─── 别名归一化 ───────────────────────────────

  /**
   * 将语言 ID 别名/缩写归一化为规范 ID
   *
   * 示例:
   *   normalize('objc')     → 'objectivec'
   *   normalize('ts')       → 'typescript'
   *   normalize('golang')   → 'go'
   *   normalize('swift')    → 'swift' (已是规范 ID)
   *   normalize('unknown')  → 'unknown'
   *
   * @param {string} langId - 语言 ID（可能是别名）
   * @returns {string} 规范化语言 ID
   */
  static normalize(langId) {
    if (!langId || typeof langId !== 'string') {
      return 'unknown';
    }
    const lower = langId.toLowerCase().trim();
    if (KNOWN_PROGRAMMING_LANGS.has(lower)) {
      return lower;
    }
    return LANG_ALIASES[lower] || lower;
  }

  /**
   * 将规范语言 ID 转为 Guard 兼容 ID
   *
   * Guard 内置规则使用 'objc' 而非 'objectivec'。
   * 其他语言 ID 不变。
   *
   * @param {string} langId
   * @returns {string}
   */
  static toGuardLangId(langId) {
    const id = (langId || '').toLowerCase().replace(/[_-]/g, '');
    return id === 'objectivec' ? 'objc' : langId;
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
    if (!langId) {
      return null;
    }
    const lower = langId.toLowerCase();
    for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
      if (lang === lower) {
        return ext;
      }
    }
    return null;
  }

  // ─── 生态系统 / 项目级语言检测 ────────────────

  /**
   * 获取语言别名映射表（不可变）
   * @returns {Readonly<Record<string, string>>}
   */
  static get langAliases() {
    return LANG_ALIASES;
  }

  /**
   * 获取 ECO_TO_LANGS 映射（不可变）
   * @returns {Readonly<Record<string, readonly string[]>>}
   */
  static get ecoToLangs() {
    return ECO_TO_LANGS;
  }

  /**
   * 获取 BUILD_SYSTEM_MARKERS（不可变）
   * @returns {ReadonlyArray<BuildSystemMarker>}
   */
  static get buildSystemMarkers() {
    return BUILD_SYSTEM_MARKERS;
  }

  /**
   * 获取 SCAN_SKIP_DIRS（不可变）
   * @returns {ReadonlySet<string>}
   */
  static get scanSkipDirs() {
    return SCAN_SKIP_DIRS;
  }

  /**
   * 根据生态系统/Discoverer ID 获取对应的语言 ID 数组
   * @param {string} ecoId - 如 'spm', 'node', 'rust', 'dart'
   * @returns {readonly string[]}
   */
  static langsForEco(ecoId) {
    return ECO_TO_LANGS[ecoId] || [];
  }

  /**
   * 检测构建系统标志文件 — 纯数据匹配，不访问文件系统
   *
   * @param {string[]} entryNames - 目录内文件/目录名列表
   * @returns {Array<{ eco: string, buildTool: string }>}
   */
  static matchBuildMarkers(entryNames) {
    if (!Array.isArray(entryNames) || entryNames.length === 0) {
      return [];
    }
    const nameSet = new Set(entryNames);
    const results = [];
    const seenEco = new Set();

    for (const marker of BUILD_SYSTEM_MARKERS) {
      if (seenEco.has(marker.eco)) {
        continue;
      }
      const isGlob = marker.file.startsWith('*');
      const matched = isGlob
        ? entryNames.some((n) => n.endsWith(marker.file.slice(1)))
        : nameSet.has(marker.file);
      if (matched) {
        results.push({ eco: marker.eco, buildTool: marker.buildTool });
        seenEco.add(marker.eco);
      }
    }
    return results;
  }

  /**
   * 检测项目使用的编程语言 — 统一入口
   *
   * 策略（按优先级）：
   *   1. 若传入 discovererIds（来自 ModuleService），直接映射为语言
   *   2. 否则扫描项目目录的构建系统标记文件（支持 monorepo 多层扫描）
   *
   * @param {string} projectRoot - 项目根目录绝对路径
   * @param {object} [opts]
   * @param {string[]} [opts.discovererIds] - ModuleService 检测到的生态 ID
   * @param {number}   [opts.maxDepth=2]    - 最大扫描深度：0=仅根目录，1=+子目录，2=+孙目录
   * @returns {string[]} 规范化语言 ID 数组（如 ['rust', 'dart']）
   */
  static detectProjectLanguages(projectRoot, opts = {}) {
    if (!projectRoot || typeof projectRoot !== 'string') {
      return [];
    }
    const { discovererIds, maxDepth = 2 } = opts;

    // ── Path 1: 从 Discoverer ID 映射 ──
    if (discovererIds && discovererIds.length > 0) {
      const nonGeneric = discovererIds.filter((id) => id !== 'generic');
      if (nonGeneric.length > 0) {
        const langSet = new Set();
        for (const did of nonGeneric) {
          for (const lang of ECO_TO_LANGS[did] || []) {
            langSet.add(lang);
          }
        }
        if (langSet.size > 0) {
          return [...langSet];
        }
      }
    }

    // ── Path 2: 扫描构建系统标记文件 ──
    const seenEco = new Set();

    const scanDir = (dir) => {
      try {
        for (const marker of BUILD_SYSTEM_MARKERS) {
          if (seenEco.has(marker.eco)) {
            continue;
          }
          const isGlob = marker.file.startsWith('*');
          let matched = false;
          if (isGlob) {
            try {
              const suffix = marker.file.slice(1);
              matched = readdirSync(dir).some((n) => n.endsWith(suffix));
            } catch {
              /* skip */
            }
          } else {
            matched = existsSync(join(dir, marker.file));
          }
          if (matched) {
            seenEco.add(marker.eco);
          }
        }
      } catch {
        /* skip unreadable dir */
      }
    };

    // Level 0: 项目根目录
    scanDir(projectRoot);

    // Level 1..maxDepth: 子目录（支持 monorepo）
    if (seenEco.size === 0 && maxDepth >= 1) {
      /** @type {Array<[string, number]>} */
      const queue = [[projectRoot, 0]];
      while (queue.length > 0) {
        const [dir, depth] = queue.shift();
        if (depth >= maxDepth) {
          continue;
        }
        try {
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith('.') || SCAN_SKIP_DIRS.has(ent.name)) {
              continue;
            }
            const sub = join(dir, ent.name);
            scanDir(sub);
            if (depth + 1 < maxDepth) {
              queue.push([sub, depth + 1]);
            }
          }
        } catch {
          /* skip */
        }
      }
    }

    // ── 将生态 ID 转为语言 ID ──
    const langSet = new Set();
    for (const eco of seenEco) {
      for (const lang of ECO_TO_LANGS[eco] || []) {
        langSet.add(lang);
      }
    }

    // ── 启发式: node 与其他生态共存时，JS/TS 通常只是构建工具，去掉 ──
    if (seenEco.size > 1 && seenEco.has('node')) {
      const hasOther = [...seenEco].some((e) => e !== 'node');
      if (hasOther) {
        langSet.delete('javascript');
        langSet.delete('typescript');
      }
    }

    return [...langSet];
  }
}

export default LanguageService;
