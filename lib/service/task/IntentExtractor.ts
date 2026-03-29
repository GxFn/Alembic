/**
 * IntentExtractor — Intake Layer
 *
 * Pure functions: extract intent signals from user query + active file.
 * Builds multi-query set, infers language/module/scenario for search routing.
 *
 * @module service/task/IntentExtractor
 */

import { tokenize } from '#service/search/tokenizer.js';

// ── Types ───────────────────────────────────────────

export type SearchScenario = 'lint' | 'generate' | 'search' | 'learning';

export interface ExtractedIntent {
  /** Multi-query set: Q1 raw + Q2 tech terms + Q3 file context */
  queries: string[];
  /** Cross-language synonym queries (run in keyword mode to bypass semantic normalization) */
  keywordQueries: string[];
  /** Inferred language from activeFile or args */
  language: string | null;
  /** Inferred module path from activeFile */
  module: string | null;
  /** Search scenario for MultiSignalRanker routing */
  scenario: SearchScenario;
  /** Original inputs */
  raw: { userQuery: string; activeFile?: string; language?: string };
}

export interface TechTermOptions {
  /** Project-specific class prefixes, e.g. ['BD', 'BBA', 'KS'] */
  projectPrefixes?: string[];
  /** Language/platform common prefixes, e.g. ObjC: ['UI', 'NS', 'CA', 'AV'] */
  platformPrefixes?: string[];
}

// ── Universal Patterns (language-agnostic) ──────────

const UNIVERSAL_PATTERNS: RegExp[] = [
  /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, // CamelCase
  /`([^`]+)`/g, // backtick code
  /\b[\w-]+\.(?:ts|js|m|h|swift|py|java|go|rs|tsx|kt)\b/g, // file names
  /@[\w-]+/g, // trigger references
];

// ── Language Extension Map ──────────────────────────

const LANG_MAP: Record<string, string> = {
  m: 'objectivec',
  h: 'objectivec',
  mm: 'objectivec',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
};

// ── Cross-Language Synonym Groups ───────────────────
// Each group contains EN morphological variants + CN equivalents.
// Used to expand queries so English terms match Chinese recipe fields (and vice versa).

const SYNONYM_GROUPS: string[][] = [
  // Design patterns & DI
  ['inject', 'injection', '注入'],
  ['construct', 'constructor', '构造器', '构造函数'],
  ['depend', 'dependency', 'dependencies', '依赖'],
  ['protocol', '协议'],
  ['interface', '接口'],
  ['pattern', '模式'],
  ['factory', '工厂'],
  ['singleton', '单例'],
  ['delegate', '代理', '委托'],
  ['observe', 'observer', '观察者'],
  ['subscribe', 'subscription', '订阅'],
  ['repository', 'repo', '仓库'],
  // Architecture
  ['module', '模块'],
  ['architect', 'architecture', '架构'],
  ['route', 'router', 'routing', '路由'],
  ['middleware', '中间件'],
  ['component', '组件'],
  ['lifecycle', '生命周期'],
  ['layer', '分层', '层'],
  // Language features
  ['generic', 'generics', '泛型'],
  ['closure', '闭包'],
  ['callback', '回调'],
  ['extend', 'extension', '扩展'],
  ['inherit', 'inheritance', '继承'],
  ['abstract', 'abstraction', '抽象'],
  ['encapsulate', 'encapsulation', '封装'],
  ['polymorph', 'polymorphism', '多态'],
  ['implement', 'implementation', '实现'],
  // Concurrency
  ['async', 'asynchronous', '异步'],
  ['sync', 'synchronous', '同步'],
  ['thread', 'threading', '线程'],
  ['concur', 'concurrency', '并发'],
  // Common concepts
  ['network', '网络'],
  ['cache', 'caching', '缓存'],
  ['persist', 'persistence', '持久化'],
  ['serialize', 'serialization', '序列化'],
  ['validate', 'validation', '校验', '验证'],
  ['authenticate', 'authentication', '认证'],
  ['authorize', 'authorization', '授权'],
  ['config', 'configuration', '配置'],
  ['navigate', 'navigation', '导航'],
  ['animate', 'animation', '动画'],
  ['layout', '布局'],
  ['render', 'rendering', '渲染'],
  ['responsive', '响应式'],
  ['state', '状态'],
  ['toast', '提示'],
  ['error', '错误'],
  ['handle', 'handler', '处理'],
  ['service', '服务'],
  ['test', 'testing', '测试'],
];

/** Lookup: lowercased term → synonym expansions (excluding the term itself) */
const SYNONYM_LOOKUP = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    SYNONYM_LOOKUP.set(
      term.toLowerCase(),
      group.filter((t) => t !== term)
    );
  }
}

// ── Public API ──────────────────────────────────────

/**
 * Extract intent signals from user query and active file.
 * Pure function — no side effects, no DI.
 */
export function extract(
  userQuery: string,
  activeFile?: string,
  language?: string,
  termOpts?: TechTermOptions
): ExtractedIntent {
  const queries = buildQueries(userQuery, activeFile, termOpts);
  const keywordQueries = buildKeywordQueries(userQuery);
  const inferredLang = language || (activeFile ? inferLanguage(activeFile) : null);
  const module = activeFile ? inferFileContext(activeFile) : null;
  const scenario = classifyScenario(userQuery);

  return {
    queries,
    keywordQueries,
    language: inferredLang,
    module,
    scenario,
    raw: { userQuery, activeFile, language },
  };
}

/**
 * Build multi-query set from user query + active file.
 * Q1: raw query, Q2: extracted tech terms, Q3: file context.
 * Q1 is enriched with cross-language synonyms to bridge EN↔CJK matching.
 */
export function buildQueries(
  userQuery: string,
  activeFile?: string,
  termOpts?: TechTermOptions
): string[] {
  // Enrich raw query with cross-language synonyms
  const synonyms = expandWithSynonyms(userQuery);
  const enrichedQuery = synonyms ? `${userQuery} ${synonyms}` : userQuery;
  const queries: string[] = [enrichedQuery];

  const terms = extractTechTerms(userQuery, termOpts);
  if (terms.length > 0) {
    queries.push(terms.join(' '));
  }

  if (activeFile) {
    const ctx = inferFileContext(activeFile);
    if (ctx) {
      queries.push(ctx);
    }
  }

  return queries;
}

/**
 * Build keyword-mode queries for cross-language synonym matching.
 * Uses keyword mode to preserve raw FWS scores without CoarseRanker semantic normalization.
 */
export function buildKeywordQueries(userQuery: string): string[] {
  const expanded = expandWithSynonyms(userQuery);
  return expanded ? [expanded] : [];
}

/**
 * Extract tech terms from query using universal patterns + dynamic project prefixes.
 */
export function extractTechTerms(query: string, opts: TechTermOptions = {}): string[] {
  const terms = new Set<string>();

  // 1. Universal patterns (always run)
  for (const pattern of UNIVERSAL_PATTERNS) {
    for (const match of query.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const term = match[1] || match[0];
      if (term.length >= 3 && term.length <= 50) {
        terms.add(term);
      }
    }
  }

  // 2. Project prefix patterns (dynamic)
  const allPrefixes = [...(opts.projectPrefixes ?? []), ...(opts.platformPrefixes ?? [])];
  const prefixPattern = buildPrefixPattern(allPrefixes);
  if (prefixPattern) {
    for (const match of query.matchAll(prefixPattern)) {
      if (match[0].length >= 3 && match[0].length <= 50) {
        terms.add(match[0]);
      }
    }
  }

  return [...terms].slice(0, 8);
}

/**
 * Infer file context string from file path for search augmentation.
 * Returns module path + class name, e.g. "Services/Network BDNetworkManager"
 */
export function inferFileContext(filePath: string): string | null {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const fileName = parts[parts.length - 1] || '';

  // Extract class name (remove extension)
  const className = fileName.replace(/\.\w+$/, '');

  // Extract meaningful module path (skip root dir and file name)
  const meaningful = parts
    .slice(1, -1)
    .filter((p) => !['src', 'lib', 'Sources', 'BiliDili', 'BiliDemo'].includes(p));
  const module = meaningful.slice(0, 2).join('/');

  const segments = [module, className].filter(Boolean);
  return segments.length > 0 ? segments.join(' ') : null;
}

/**
 * Infer language from file extension.
 */
export function inferLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? (LANG_MAP[ext] ?? null) : null;
}

/**
 * Classify search scenario from user query (lightweight rule-based).
 */
export function classifyScenario(userQuery: string): SearchScenario {
  const q = userQuery.toLowerCase();

  if (/帮我[加写做实现创建]|implement|add|create|新[增加建]/.test(q)) {
    return 'generate';
  }
  if (/检查|review|lint|合规|违规|guard|规[则范]/.test(q)) {
    return 'lint';
  }
  if (/什么是|怎么[用做]|原理|explain|学习|理解|为什么/.test(q)) {
    return 'learning';
  }
  return 'search';
}

// ── Internal Helpers ────────────────────────────────

/**
 * Expand query tokens with cross-language synonyms.
 * Tokenizes query, looks up each token in the synonym table,
 * returns a query string of synonym expansions for cross-language matching.
 *
 * Strategy: return only cross-script synonyms (EN→CJK or CJK→EN).
 * This keeps the expansion focused — the original script tokens are already in Q1.
 */
function expandWithSynonyms(query: string): string | null {
  const tokens = tokenize(query);
  const crossScriptTerms = new Set<string>();

  // Detect query script: does it contain CJK?
  const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(query);

  for (const token of tokens) {
    const synonyms = SYNONYM_LOOKUP.get(token.toLowerCase());
    if (!synonyms) {
      continue;
    }
    for (const syn of synonyms) {
      const synIsCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(syn);
      // Cross-script: EN query → add CJK synonyms; CJK query → add EN synonyms
      if (hasCJK !== synIsCJK) {
        crossScriptTerms.add(syn);
      }
    }
  }

  if (crossScriptTerms.size === 0) {
    return null;
  }
  return [...crossScriptTerms].slice(0, 12).join(' ');
}

function buildPrefixPattern(prefixes: string[]): RegExp | null {
  if (prefixes.length === 0) {
    return null;
  }
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\w{2,}\\b`, 'g');
}
