/**
 * Defaults — 项目级默认常量与配置
 * 统一管理路径名、存储适配器、索引策略、分类规则等默认值
 */

// ─── 路径 ────────────────────────────────────────────────────
export const SPEC_FILENAME = 'AutoSnippet.boxspec.json';
export const KNOWLEDGE_BASE_DIR = 'AutoSnippet';
export const RECIPES_DIR = 'AutoSnippet/recipes';
export const CANDIDATES_DIR = 'AutoSnippet/candidates';
export const RECIPES_INDEX = 'AutoSnippet/recipes/index.json';
export const SPMMAP_FILENAME = 'AutoSnippet.spmmap.json';
export const SPMMAP_PATH = `AutoSnippet/${SPMMAP_FILENAME}`;

// ─── Context 存储 ────────────────────────────────────────────
export const DEFAULT_STORAGE_ADAPTER = 'json';
export const STORAGE_ADAPTERS = ['json'];

// ─── Context 索引 ────────────────────────────────────────────
export const SOURCE_TYPES = ['recipe', 'doc', 'target-readme'];
export const SOURCE_TYPE_RECIPE = 'recipe';
export const SOURCE_TYPE_TARGET_README = 'target-readme';
export const DEFAULT_SOURCES = [{ path: RECIPES_DIR, type: 'recipe' }];
export const DEFAULT_CHUNKING = { strategy: 'whole' };
export const CHUNKING_STRATEGIES = ['whole', 'section', 'fixed', 'auto'];
export const DEFAULT_MAX_CHUNK_TOKENS = 800;
export const DEFAULT_OVERLAP_TOKENS = 80;
export const CHARS_PER_TOKEN = 3;

// ─── Target README ───────────────────────────────────────────
export const README_NAMES = ['README.md', 'README_CN.md', 'readme.md'];

// ─── MCP / 连接层 ───────────────────────────────────────────
export const DEFAULT_ASD_UI_URL = 'http://localhost:3000';

// ─── Guard ───────────────────────────────────────────────────
export const GUARD_CONTEXT_EXCERPT_LIMIT = 12000;

// ─── Skills / Category ──────────────────────────────────────
export const CATEGORY_RULES = [
  { pattern: /network|net|请求|api/i, category: 'network' },
  { pattern: /video|播放|player/i, category: 'video' },
  { pattern: /scheme|url|跳转|router/i, category: 'navigation' },
  { pattern: /pyramid|service|服务/i, category: 'foundation' },
  { pattern: /ui|view|cell|table/i, category: 'ui' },
];
export const DEFAULT_CATEGORY = 'general';

/**
 * 从文件路径和内容推断 category
 * 优先读取 frontmatter 的 category 字段，其次匹配路径规则
 */
export function inferCategory(relPath, content) {
  const frontMatch = (content || '').match(/^---[\s\S]*?category:\s*["']?([\w-]+)["']?/m);
  if (frontMatch) return frontMatch[1];
  const lower = (relPath || '').toLowerCase();
  for (const { pattern, category } of CATEGORY_RULES) {
    if (pattern.test(lower)) return category;
  }
  return DEFAULT_CATEGORY;
}

export default {
  SPEC_FILENAME, KNOWLEDGE_BASE_DIR, RECIPES_DIR, CANDIDATES_DIR, RECIPES_INDEX,
  SPMMAP_FILENAME, SPMMAP_PATH,
  DEFAULT_STORAGE_ADAPTER, STORAGE_ADAPTERS,
  SOURCE_TYPES, SOURCE_TYPE_RECIPE, SOURCE_TYPE_TARGET_README,
  DEFAULT_SOURCES, DEFAULT_CHUNKING, CHUNKING_STRATEGIES,
  DEFAULT_MAX_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS, CHARS_PER_TOKEN,
  README_NAMES, DEFAULT_ASD_UI_URL, GUARD_CONTEXT_EXCERPT_LIMIT,
  CATEGORY_RULES, DEFAULT_CATEGORY, inferCategory,
};
