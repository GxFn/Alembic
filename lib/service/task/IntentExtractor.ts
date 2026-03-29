/**
 * IntentExtractor — Intake Layer
 *
 * Pure functions: extract intent signals from user query + active file.
 * Builds multi-query set, infers language/module/scenario for search routing.
 *
 * @module service/task/IntentExtractor
 */

// ── Types ───────────────────────────────────────────

export type SearchScenario = 'lint' | 'generate' | 'search' | 'learning';

export interface ExtractedIntent {
  /** Multi-query set: Q1 raw + Q2 tech terms + Q3 file context */
  queries: string[];
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
  const inferredLang = language || (activeFile ? inferLanguage(activeFile) : null);
  const module = activeFile ? inferFileContext(activeFile) : null;
  const scenario = classifyScenario(userQuery);

  return {
    queries,
    language: inferredLang,
    module,
    scenario,
    raw: { userQuery, activeFile, language },
  };
}

/**
 * Build multi-query set from user query + active file.
 * Q1: raw query, Q2: extracted tech terms, Q3: file context.
 */
export function buildQueries(
  userQuery: string,
  activeFile?: string,
  termOpts?: TechTermOptions
): string[] {
  const queries: string[] = [userQuery];

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

function buildPrefixPattern(prefixes: string[]): RegExp | null {
  if (prefixes.length === 0) {
    return null;
  }
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\w{2,}\\b`, 'g');
}
