/**
 * project-access.js — 项目数据访问工具 (5)
 *
 * 1. search_project_code    搜索项目源码
 * 2. read_project_file      读取项目文件
 * 2b. list_project_structure 列出项目目录结构
 * 2c. get_file_summary       文件结构摘要
 * 2d. semantic_search_code   语义知识搜索
 */

import fs from 'node:fs';
import path from 'node:path';
import { LanguageProfiles } from '#shared/LanguageProfiles.js';
import { LanguageService } from '#shared/LanguageService.js';

// ─── 本文件内部接口 ─────────────────────────────────────────

/** 项目文件缓存条目 */
interface ProjectFile {
  relativePath?: string;
  path?: string;
  name?: string;
  content?: string;
}

/** 工具间共享状态（可挂载到 ctx 或 ctx._sharedState） */
interface ToolSharedState {
  _searchCache?: Map<string, SearchCacheEntry>;
  _readCache?: Map<string, ReadCacheEntry>;
  _searchCallCount?: number;
  [key: string]: unknown;
}

/** 工具上下文 */
export interface ToolContext extends ToolSharedState {
  projectRoot?: string;
  fileCache?: ProjectFile[] | null;
  container?: { get(name: string): unknown } | null;
  _sharedState?: ToolSharedState;
  source?: string;
  abortSignal?: AbortSignal | null;
}

/** 搜索缓存条目 */
export interface SearchCacheEntry {
  matches: SearchMatch[];
  total: number;
  _cached?: boolean;
}

/** 搜索匹配项 */
export interface SearchMatch {
  file: string;
  line: number;
  code: string;
  context: string;
  score: number;
}

/** 读取缓存条目 */
export interface ReadCacheEntry {
  content?: string;
  totalLines?: number;
  language?: string;
  error?: string;
  _cached?: boolean;
}

/** 向量搜索结果项 */
interface VectorSearchResult {
  item: { id: string; content?: string; metadata?: Record<string, unknown> };
  score: number;
}

/** 搜索引擎结果项 */
interface SearchEngineItem {
  id: string;
  title?: string;
  content?: string;
  description?: string;
  score?: number;
  knowledgeType?: string;
  kind?: string;
  category?: string;
  language?: string;
}

/** 语言摘要提取器 */
interface SummaryExtractor {
  imports?: RegExp;
  declarations?: RegExp;
  methods?: RegExp;
  properties?: RegExp;
}

/** 文件摘要结果 */
export interface FileSummaryResult {
  filePath: string;
  language: string;
  lineCount: number;
  imports: string[];
  declarations: string[];
  methods: string[];
  properties: string[];
  preview?: string;
}

/** 向量存储（精简接口，仅覆盖本文件使用的方法） */
interface VectorStoreLike {
  hybridSearch(
    queryVector: number[],
    queryText: string,
    options: { topK: number; filter?: Record<string, string> }
  ): Promise<VectorSearchResult[]>;
}

/** AI Provider（精简接口） */
interface AIProviderLike {
  generateEmbedding?(text: string): Promise<number[]>;
}

function isWithinProjectPath(targetPath: string, projectRoot: string) {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(targetPath));
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** SearchEngine（精简接口） */
interface SearchEngineLike {
  search(
    query: string,
    options: { mode: string; limit: number; groupByKind?: boolean }
  ): Promise<{ items: SearchEngineItem[]; mode?: string }>;
}

/** 文件过滤参数 */
interface FileFilterParams {
  fileFilter?: string;
}

/** search_project_code 参数 */
export interface SearchCodeParams extends FileFilterParams {
  pattern?: string;
  patterns?: string[];
  isRegex?: boolean;
  contextLines?: number;
  maxResults?: number;
  query?: string;
  search?: string;
  keyword?: string;
  search_query?: string;
}

/** read_project_file 参数 */
export interface ReadFileParams extends FileFilterParams {
  filePath?: string;
  filePaths?: string[];
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  path?: string;
  file_path?: string;
  filepath?: string;
  file?: string;
  filename?: string;
}

/** list_project_structure 参数 */
export interface ListStructureParams {
  directory?: string;
  depth?: number;
  includeStats?: boolean;
}

/** get_file_summary 参数 */
export interface FileSummaryParams {
  filePath?: string;
  file_path?: string;
  path?: string;
  file?: string;
}

/** semantic_search_code 参数 */
export interface SemanticSearchParams {
  query?: string;
  search?: string;
  keyword?: string;
  topK?: number;
  category?: string;
  language?: string;
}

// ─── 共享常量 ──────────────────────────────────────────────

/** 三方库路径识别 — 从 LanguageProfiles 统一派生 */
export const THIRD_PARTY_RE = LanguageProfiles.thirdPartyPathRegex;

/** 源码文件扩展名 — 从 LanguageService 统一派生 */
export const SOURCE_EXT_RE = LanguageService.sourceExtRegex;

/** 声明行识别 — 用于对匹配行打分（与 bootstrap/shared/scanner.js 对齐） */
const DECL_RE =
  /^\s*(@property\b|@interface\b|@protocol\b|@class\b|@synthesize\b|@dynamic\b|@end\b|NS_ASSUME_NONNULL|#import\b|#include\b|#define\b)/;
const TYPE_DECL_RE = /^\s*\w[\w<>*\s]+[\s*]+_?\w+\s*;$/;

function _scoreSearchLine(line: string) {
  const t = line.trim();
  if (DECL_RE.test(t)) {
    return -2;
  }
  if (TYPE_DECL_RE.test(t)) {
    return -1;
  }
  if (/^[-+]\s*\([^)]+\)\s*\w+[^{]*;\s*$/.test(t)) {
    return -1;
  }
  if (/\[.*\w+.*\]/.test(t)) {
    return 2; // ObjC message send
  }
  if (/\w+\s*\(/.test(t)) {
    return 2; // function call
  }
  if (/\^\s*[{(]/.test(t)) {
    return 1; // block literal
  }
  return 0;
}

function isAbortRequested(ctx: ToolContext) {
  return ctx.abortSignal?.aborted === true;
}

function abortedResult(tool: string) {
  return { error: `${tool} aborted`, aborted: true };
}

/**
 * 收集项目文件列表 — 抽取为公用函数，供单次和批量搜索复用。
 * 优先使用内存缓存（bootstrap 场景），否则从磁盘递归读取。
 */
async function _getProjectFiles(params: FileFilterParams, ctx: ToolContext) {
  const { fileFilter } = params;
  const projectRoot = ctx.projectRoot || process.cwd();

  let extFilter: RegExp | null = null;
  if (fileFilter) {
    const exts = fileFilter.split(',').map((e: string) => e.trim().replace(/^\./, ''));
    extFilter = new RegExp(`\\.(${exts.join('|')})$`, 'i');
  }

  const fileCache = ctx.fileCache || null;
  let files: ProjectFile[];
  let skippedThirdParty = 0;

  if (fileCache && Array.isArray(fileCache)) {
    files = fileCache.filter((f) => {
      if (isAbortRequested(ctx)) {
        return false;
      }
      const p = f.relativePath || f.path || '';
      if (THIRD_PARTY_RE.test(p)) {
        skippedThirdParty++;
        return false;
      }
      if (extFilter && !extFilter.test(p)) {
        return false;
      }
      if (!SOURCE_EXT_RE.test(p)) {
        return false;
      }
      return true;
    });
  } else {
    files = [];
    const MAX_FILE_SIZE = 512 * 1024;
    const walk = (dir: string, relBase = '') => {
      if (isAbortRequested(ctx)) {
        return;
      }
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (isAbortRequested(ctx)) {
            return;
          }
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          const fullPath = path.join(dir, entry.name);
          const isDir =
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              (() => {
                try {
                  return fs.statSync(fullPath).isDirectory();
                } catch {
                  return false;
                }
              })());
          const isFile =
            entry.isFile() ||
            (entry.isSymbolicLink() &&
              (() => {
                try {
                  return fs.statSync(fullPath).isFile();
                } catch {
                  return false;
                }
              })());
          if (isDir) {
            if (
              entry.name.startsWith('.') ||
              entry.name === 'node_modules' ||
              entry.name === 'build'
            ) {
              continue;
            }
            if (THIRD_PARTY_RE.test(`${relPath}/`)) {
              skippedThirdParty++;
              continue;
            }
            walk(fullPath, relPath);
          } else if (isFile) {
            if (THIRD_PARTY_RE.test(relPath)) {
              skippedThirdParty++;
              continue;
            }
            if (!SOURCE_EXT_RE.test(entry.name)) {
              continue;
            }
            if (extFilter && !extFilter.test(entry.name)) {
              continue;
            }
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > MAX_FILE_SIZE) {
                continue;
              }
              const content = fs.readFileSync(fullPath, 'utf-8');
              files.push({ relativePath: relPath, content, name: entry.name });
            } catch {
              /* skip unreadable files */
            }
          }
        }
      } catch {
        /* skip inaccessible dirs */
      }
    };
    walk(projectRoot);
  }

  return { files, skippedThirdParty };
}

// ─── 1. search_project_code ────────────────────────────────

export const searchProjectCode = {
  name: 'search_project_code',
  description:
    '在用户项目源码中搜索指定模式。返回匹配的代码片段及上下文。' +
    '自动过滤三方库代码（Pods/Carthage/node_modules），优先返回实际使用行而非声明行。' +
    '适用场景：验证代码模式存在性、查找更多项目示例、理解项目中某个 API 的用法。' +
    '批量搜索：传入 patterns 数组可一次搜索多个关键词（每个关键词独立返回结果），减少工具调用次数。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索词或正则表达式（单个搜索时使用）' },
      patterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          '批量搜索：多个搜索词数组，如 ["methodA", "methodB", "classC"]。与 pattern 互斥，优先使用 patterns。',
      },
      isRegex: { type: 'boolean', description: '是否为正则表达式，默认 false' },
      fileFilter: { type: 'string', description: '文件扩展名过滤，如 ".m,.swift"' },
      contextLines: { type: 'number', description: '匹配行前后的上下文行数，默认 3' },
      maxResults: { type: 'number', description: '每个 pattern 的最大返回结果数，默认 5' },
    },
    required: [],
  },
  handler: async (params: SearchCodeParams, ctx: ToolContext) => {
    if (isAbortRequested(ctx)) {
      return abortedResult('search_project_code');
    }

    // ── 去重缓存初始化 ──
    const state = ctx._sharedState || ctx;
    if (!state._searchCache) {
      state._searchCache = new Map();
    }

    // ── 批量模式：patterns 数组 ──
    if (Array.isArray(params.patterns) && params.patterns.length > 0) {
      const batchPatterns = params.patterns.slice(0, 10);
      const batchResults: Record<string, SearchCacheEntry> = {};
      let dedupCount = 0;
      for (const p of batchPatterns) {
        if (isAbortRequested(ctx)) {
          return { ...abortedResult('search_project_code'), batchResults };
        }
        const cacheKey = `${p}|${params.isRegex || false}|${params.fileFilter || ''}`;
        const cached = state._searchCache.get(cacheKey);
        if (cached) {
          batchResults[p] = { ...cached, _cached: true };
          dedupCount++;
          continue;
        }
        const sub = (await searchProjectCode.handler(
          { ...params, pattern: p, patterns: undefined },
          ctx
        )) as { matches?: SearchMatch[]; total?: number };
        const entry: SearchCacheEntry = { matches: sub.matches ?? [], total: sub.total ?? 0 };
        state._searchCache.set(cacheKey, entry);
        batchResults[p] = entry;
      }
      return {
        batchResults,
        patternsSearched: batchPatterns.length,
        searchedFiles: (await _getProjectFiles(params, ctx)).files.length,
        ...(dedupCount > 0
          ? {
              _deduped: dedupCount,
              hint: `${dedupCount} 个 pattern 命中缓存，请避免重复搜索相同关键词。`,
            }
          : {}),
      };
    }

    // 兼容 AI 传 "query" / "search" / "keyword" 替代 "pattern"
    const pattern =
      params.pattern || params.query || params.search || params.keyword || params.search_query;
    const { isRegex = false, contextLines = 3, maxResults = 5 } = params;

    if (!pattern || typeof pattern !== 'string') {
      return {
        error: '参数错误: 请提供 pattern（搜索关键词或正则表达式）或 patterns 数组',
        matches: [],
        total: 0,
      };
    }

    // ── 单 pattern 去重检查 ──
    const cacheKey = `${pattern}|${params.isRegex || false}|${params.fileFilter || ''}`;
    if (state._searchCache.has(cacheKey)) {
      const cached = state._searchCache.get(cacheKey);
      return {
        ...cached,
        _cached: true,
        hint: `⚠ 已搜索过 "${pattern}"，返回缓存结果。请搜索不同的关键词以获取新信息。`,
      };
    }

    // 构建搜索正则
    let searchRe: RegExp;
    try {
      searchRe = isRegex
        ? new RegExp(pattern, 'gi')
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (err: unknown) {
      return { error: `Invalid pattern: ${(err as Error).message}`, matches: [], total: 0 };
    }

    const { files, skippedThirdParty } = await _getProjectFiles(params, ctx);
    if (isAbortRequested(ctx)) {
      return abortedResult('search_project_code');
    }

    // 搜索匹配
    const matches: SearchMatch[] = [];
    let total = 0;

    for (const f of files) {
      if (isAbortRequested(ctx)) {
        return { ...abortedResult('search_project_code'), matches, total };
      }
      if (!f.content) {
        continue;
      }
      searchRe.lastIndex = 0;
      if (!searchRe.test(f.content)) {
        continue;
      }

      const lines = f.content.split('\n');
      searchRe.lastIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        if (isAbortRequested(ctx)) {
          return { ...abortedResult('search_project_code'), matches, total };
        }
        searchRe.lastIndex = 0;
        if (!searchRe.test(lines[i])) {
          continue;
        }
        total++;

        if (matches.length < maxResults) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          const contextArr: string[] = [];
          for (let j = start; j <= end; j++) {
            contextArr.push(lines[j]);
          }

          matches.push({
            file: f.relativePath || f.path || f.name || '',
            line: i + 1,
            code: lines[i],
            context: contextArr.join('\n'),
            score: _scoreSearchLine(lines[i]),
          });
        }
      }
    }

    // 按 score 降序排列（实际使用行优先）
    matches.sort((a, b) => b.score - a.score);

    const result = {
      matches,
      total,
      searchedFiles: files.length,
      skippedThirdParty,
      ...(() => {
        state._searchCallCount = (state._searchCallCount || 0) + 1;
        if (state._searchCallCount > 12 && ctx.source === 'system') {
          return {
            hint: `💡 你已搜索 ${state._searchCallCount} 次。考虑使用 get_class_info / get_class_hierarchy / get_project_overview 获取结构化信息，效率更高。`,
          };
        }
        return {};
      })(),
    };

    state._searchCache.set(cacheKey, { matches: result.matches, total: result.total });

    return result;
  },
};

// ─── 2. read_project_file ──────────────────────────────────

export const readProjectFile = {
  name: 'read_project_file',
  description:
    '读取项目中指定文件的内容（部分或全部）。' +
    '通常在 search_project_code 找到匹配后使用，获取更完整的上下文。' +
    '批量读取：传入 filePaths 数组可一次读取多个文件，减少工具调用次数。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '相对于项目根目录的文件路径（单个文件时使用）' },
      filePaths: {
        type: 'array',
        items: { type: 'string' },
        description: '批量读取：多个文件路径数组。与 filePath 互斥，优先使用 filePaths。',
      },
      startLine: { type: 'number', description: '起始行号（1-based），默认 1' },
      endLine: { type: 'number', description: '结束行号（1-based），默认文件末尾' },
      maxLines: {
        type: 'number',
        description: '最大返回行数，默认 200（批量模式下每个文件最多 100 行）',
      },
    },
    required: [],
  },
  handler: async (params: ReadFileParams, ctx: ToolContext) => {
    // ── 去重缓存初始化 ──
    const state = ctx._sharedState || ctx;
    if (!state._readCache) {
      state._readCache = new Map();
    }

    // ── 批量模式：filePaths 数组 ──
    if (Array.isArray(params.filePaths) && params.filePaths.length > 0) {
      const batchPaths = params.filePaths.slice(0, 8);
      const batchResults: Record<string, ReadCacheEntry> = {};
      let dedupCount = 0;
      for (const fp of batchPaths) {
        const cacheKey = `${fp}|${params.startLine || 1}|${params.endLine || ''}|${params.maxLines || 100}`;
        if (state._readCache.has(cacheKey)) {
          batchResults[fp] = { ...state._readCache.get(cacheKey), _cached: true };
          dedupCount++;
          continue;
        }
        const sub = (await readProjectFile.handler(
          {
            ...params,
            filePath: fp,
            filePaths: undefined,
            maxLines: Math.min(params.maxLines || 100, 100),
          },
          ctx
        )) as ReadCacheEntry;
        const entry: ReadCacheEntry = sub.error
          ? { error: sub.error }
          : { content: sub.content, totalLines: sub.totalLines, language: sub.language };
        state._readCache.set(cacheKey, entry);
        batchResults[fp] = entry;
      }
      return {
        batchResults,
        filesRead: batchPaths.length,
        ...(dedupCount > 0
          ? { _deduped: dedupCount, hint: `${dedupCount} 个文件命中缓存，请避免重复读取相同文件。` }
          : {}),
      };
    }

    const filePath =
      params.filePath ||
      params.path ||
      params.file_path ||
      params.filepath ||
      params.file ||
      params.filename;
    const { startLine = 1, maxLines = 200 } = params;
    const projectRoot = ctx.projectRoot || process.cwd();

    if (!filePath || typeof filePath !== 'string') {
      return { error: '参数错误: 请提供 filePath（相对于项目根目录的文件路径）或 filePaths 数组' };
    }

    // ── 单文件去重检查 ──
    const readCacheKey = `${filePath}|${startLine}|${params.endLine || ''}|${maxLines}`;
    if (state._readCache.has(readCacheKey)) {
      return {
        ...state._readCache.get(readCacheKey),
        _cached: true,
        hint: `⚠ 已读取过该文件相同行范围，返回缓存结果。如需其他行范围请指定不同的 startLine/endLine。`,
      };
    }

    // 安全检查: 禁止路径遍历
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed. Use relative paths within the project.' };
    }

    // 优先从内存缓存读取（bootstrap 场景）
    const fileCache = ctx.fileCache || null;
    let content: string | null = null;

    if (fileCache && Array.isArray(fileCache)) {
      const cached = fileCache.find(
        (f) =>
          (f.relativePath || f.path || '') === filePath ||
          (f.relativePath || f.path || '') === normalized
      );
      if (cached) {
        content = cached.content ?? null;
      }
    }

    // 降级: 从磁盘读取
    if (content === null) {
      const fullPath = path.resolve(projectRoot, normalized);
      if (!isWithinProjectPath(fullPath, projectRoot)) {
        return { error: 'Path traversal not allowed.' };
      }
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (err: unknown) {
        return { error: `File not found or unreadable: ${(err as Error).message}` };
      }
    }

    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const start = Math.max(1, startLine);
    let end = params.endLine || totalLines;
    end = Math.min(end, totalLines);

    if (end - start + 1 > maxLines) {
      end = start + maxLines - 1;
    }

    const selectedLines = allLines.slice(start - 1, end);

    const ext = path.extname(filePath).toLowerCase();
    const language = LanguageService.langFromExt(ext);

    const readResult = {
      filePath,
      totalLines,
      startLine: start,
      endLine: end,
      content: selectedLines.join('\n'),
      language,
    };

    state._readCache.set(readCacheKey, { content: readResult.content, totalLines, language });

    return readResult;
  },
};

// ─── 2b. list_project_structure ────────────────────────────

export const listProjectStructure = {
  name: 'list_project_structure',
  description:
    '列出项目目录结构和文件统计信息。不读取文件内容，只返回目录树和元数据。' +
    '适用场景：了解项目整体布局、识别关键目录、规划探索路径。',
  parameters: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: '相对于项目根目录的子目录路径，默认根目录' },
      depth: { type: 'number', description: '目录展开深度，默认 3' },
      includeStats: {
        type: 'boolean',
        description: '是否包含文件统计（语言分布、行数），默认 true',
      },
    },
  },
  handler: async (params: ListStructureParams, ctx: ToolContext) => {
    const directory = params.directory || '';
    const depth = Math.min(params.depth ?? 3, 5);
    const includeStats = params.includeStats !== false;
    const projectRoot = ctx.projectRoot || process.cwd();

    const normalized = path.normalize(directory);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed. Use relative paths within the project.' };
    }
    const targetDir = directory ? path.resolve(projectRoot, normalized) : projectRoot;
    if (!isWithinProjectPath(targetDir, projectRoot)) {
      return { error: 'Path traversal not allowed.' };
    }

    const treeLines: string[] = [];
    const stats = {
      totalFiles: 0,
      totalDirs: 0,
      byLanguage: {} as Record<string, number>,
      totalLines: 0,
    };

    const walk = (dir: string, relBase: string, currentDepth: number, prefix: string) => {
      if (currentDepth > depth) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((a, b) => {
        const aIsDir = a.isDirectory();
        const bIsDir = b.isDirectory();
        if (aIsDir !== bIsDir) {
          return aIsDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      entries = entries.filter((e) => {
        if (e.name.startsWith('.')) {
          return false;
        }
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (THIRD_PARTY_RE.test(`${rel}/`)) {
          return false;
        }
        return true;
      });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          let childCount = 0;
          try {
            childCount = fs.readdirSync(fullPath).length;
          } catch {
            /* skip */
          }
          treeLines.push(`${prefix}${connector}${entry.name}/ (${childCount})`);
          stats.totalDirs++;
          walk(fullPath, rel, currentDepth + 1, childPrefix);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          let lineCount = 0;
          let size = 0;
          if (includeStats) {
            try {
              const st = fs.statSync(fullPath);
              size = st.size;
              if (SOURCE_EXT_RE.test(entry.name) && size < 512 * 1024) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                lineCount = content.split('\n').length;
                stats.totalLines += lineCount;
              }
            } catch {
              /* skip */
            }
          }
          const lang = LanguageService.displayNameFromExt(ext);
          if (lang !== ext) {
            stats.byLanguage[lang] = (stats.byLanguage[lang] || 0) + 1;
          }
          const sizeLabel = size > 1024 ? `${(size / 1024).toFixed(0)}KB` : `${size}B`;
          const lineLabel = lineCount > 0 ? `, ${lineCount}L` : '';
          treeLines.push(`${prefix}${connector}${entry.name} (${sizeLabel}${lineLabel})`);
          stats.totalFiles++;
        }
      }
    };

    walk(targetDir, directory, 1, '');

    return {
      directory: directory || '.',
      tree: treeLines.join('\n'),
      stats: includeStats ? stats : undefined,
    };
  },
};

// ─── 2c. get_file_summary ──────────────────────────────────

/** 语言相关的声明提取正则 */
const SUMMARY_EXTRACTORS: Record<string, SummaryExtractor> = {
  objectivec: {
    imports: /^\s*(#import\s+.+|#include\s+.+|@import\s+\w+;)/gm,
    declarations:
      /^\s*(@interface\s+\w+[\s:(].*|@protocol\s+\w+[\s<(].*|@implementation\s+\w+|typedef\s+(?:NS_ENUM|NS_OPTIONS)\s*\([^)]+\)\s*\{?)/gm,
    methods: /^\s*[-+]\s*\([^)]+\)\s*[^;{]+/gm,
    properties: /^\s*@property\s*\([^)]*\)\s*[^;]+;/gm,
  },
  swift: {
    imports: /^\s*import\s+\w+/gm,
    declarations:
      /^\s*(?:open|public|internal|fileprivate|private|final)?\s*(?:class|struct|enum|protocol|actor|extension)\s+\w+[^{]*/gm,
    methods:
      /^\s*(?:open|public|internal|fileprivate|private|override|static|class)?\s*func\s+\w+[^{]*/gm,
    properties:
      /^\s*(?:open|public|internal|fileprivate|private|static|class|lazy)?\s*(?:var|let)\s+\w+\s*:\s*[^={\n]+/gm,
  },
  javascript: {
    imports: /^\s*(?:import\s+.+from\s+['"].+['"]|const\s+\{?\s*\w+.*\}?\s*=\s*require\s*\(.+\))/gm,
    declarations: /^\s*(?:export\s+)?(?:default\s+)?(?:class|function|const|let|var)\s+\w+/gm,
    methods: /^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#?\w+)\s*\([^)]*\)\s*\{/gm,
  },
  typescript: {
    imports: /^\s*import\s+.+from\s+['"].+['"]/gm,
    declarations:
      /^\s*(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum|function|const|let|var|abstract\s+class)\s+\w+/gm,
    methods:
      /^\s*(?:async\s+)?(?:static\s+)?(?:public|private|protected)?\s*(?:get\s+|set\s+)?(?:#?\w+)\s*\([^)]*\)\s*[:{]/gm,
  },
  python: {
    imports: /^\s*(?:import\s+\w+|from\s+\w+\s+import\s+.+)/gm,
    declarations: /^\s*class\s+\w+[^:]*:/gm,
    methods: /^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)/gm,
  },
  go: {
    imports: /^\s*(?:import\s+"[^"]+"|import\s+\w+\s+"[^"]+")/gm,
    declarations: /^\s*(?:type\s+\w+\s+(?:struct|interface|func)\b.*)/gm,
    methods: /^\s*func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?\w+\s*\([^)]*\)[^{]*/gm,
  },
  java: {
    imports: /^\s*import\s+(?:static\s+)?[\w.]+\*?;/gm,
    declarations:
      /^\s*(?:public|private|protected)?\s*(?:abstract|final|static)?\s*(?:class|interface|enum|record|@interface)\s+\w+/gm,
    methods:
      /^\s*(?:public|private|protected)?\s*(?:abstract|static|final|synchronized|default)?\s*(?:<[^>]+>\s+)?\w[\w<>[\],\s]*\s+\w+\s*\([^)]*\)/gm,
  },
  kotlin: {
    imports: /^\s*import\s+[\w.]+/gm,
    declarations:
      /^\s*(?:open|abstract|data|sealed|inner|value|inline)?\s*(?:class|interface|object|enum\s+class|fun\s+interface)\s+\w+/gm,
    methods: /^\s*(?:override\s+)?(?:suspend\s+)?(?:fun|val|var)\s+(?:<[^>]+>\s+)?\w+/gm,
  },
  dart: {
    imports: /^\s*import\s+['"][^'"]+['"];?/gm,
    declarations:
      /^\s*(?:abstract\s+|sealed\s+)?(?:class|mixin|extension|enum|typedef)\s+\w+[^{]*/gm,
    methods:
      /^\s*(?:@override\s+)?(?:static\s+)?(?:Future|Stream|void|\w[\w<>?]*)?\s+\w+\s*\([^)]*\)/gm,
    properties: /^\s*(?:static\s+)?(?:final\s+|late\s+|const\s+)?(?:\w[\w<>?]*)\s+\w+\s*[;=]/gm,
  },
};
SUMMARY_EXTRACTORS['objectivec++'] = SUMMARY_EXTRACTORS.objectivec;
SUMMARY_EXTRACTORS.jsx = SUMMARY_EXTRACTORS.javascript;
SUMMARY_EXTRACTORS.tsx = SUMMARY_EXTRACTORS.typescript;

export const getFileSummary = {
  name: 'get_file_summary',
  description:
    '获取文件的结构摘要（导入、声明、方法签名），不包含实现代码。' +
    '比 read_project_file 更轻量，适合快速了解文件角色和 API。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '相对于项目根目录的文件路径' },
    },
    required: ['filePath'],
  },
  handler: async (params: FileSummaryParams, ctx: ToolContext) => {
    const filePath = params.filePath || params.file_path || params.path || params.file;
    const projectRoot = ctx.projectRoot || process.cwd();

    if (!filePath || typeof filePath !== 'string') {
      return { error: '参数错误: 请提供 filePath' };
    }

    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed.' };
    }

    const fileCache = ctx.fileCache || null;
    let content: string | null = null;

    if (fileCache && Array.isArray(fileCache)) {
      const cached = fileCache.find(
        (f: ProjectFile) =>
          (f.relativePath || f.path || '') === filePath ||
          (f.relativePath || f.path || '') === normalized
      );
      if (cached) {
        content = cached.content ?? null;
      }
    }

    if (content === null) {
      const fullPath = path.resolve(projectRoot, normalized);
      if (!isWithinProjectPath(fullPath, projectRoot)) {
        return { error: 'Path traversal not allowed.' };
      }
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (err: unknown) {
        return { error: `File not found or unreadable: ${(err as Error).message}` };
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const language = LanguageService.langFromExt(ext);
    const extractor = SUMMARY_EXTRACTORS[language];

    const result: FileSummaryResult = {
      filePath,
      language,
      lineCount: content.split('\n').length,
      imports: [],
      declarations: [],
      methods: [],
      properties: [],
    };

    if (!extractor) {
      result.preview = content.split('\n').slice(0, 30).join('\n');
      return result;
    }

    const extract = (regex: RegExp) => {
      const matches: string[] = [];
      let m: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((m = regex.exec(content)) !== null) {
        matches.push(m[0].trim());
      }
      return matches;
    };

    if (extractor.imports) {
      result.imports = extract(extractor.imports);
    }
    if (extractor.declarations) {
      result.declarations = extract(extractor.declarations);
    }
    if (extractor.methods) {
      result.methods = extract(extractor.methods).slice(0, 50);
    }
    if (extractor.properties) {
      result.properties = extract(extractor.properties).slice(0, 30);
    }

    return result;
  },
};

// ─── 2d. semantic_search_code ──────────────────────────────

export const semanticSearchCode = {
  name: 'semantic_search_code',
  description:
    '在知识库中进行语义搜索。使用自然语言描述你要查找的代码模式或概念，' +
    '返回语义最相关的知识条目。比关键词搜索更适合模糊/概念性查询。' +
    '示例: "网络请求的错误处理策略"、"线程安全的单例实现"',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自然语言搜索查询' },
      topK: { type: 'number', description: '返回结果数量，默认 5' },
      category: { type: 'string', description: '按分类过滤 (View/Service/Network/Model 等)' },
      language: { type: 'string', description: '按语言过滤 (swift/objectivec 等)' },
    },
    required: ['query'],
  },
  handler: async (params: SemanticSearchParams, ctx: ToolContext) => {
    const query = params.query || params.search || params.keyword;
    const topK = Math.min(params.topK ?? 5, 20);
    const { category, language } = params;

    if (!query || typeof query !== 'string') {
      return { error: '参数错误: 请提供 query (自然语言搜索查询)' };
    }

    let searchEngine: SearchEngineLike | null = null;
    try {
      searchEngine = (ctx.container?.get('searchEngine') as SearchEngineLike) ?? null;
    } catch {
      /* not available */
    }

    if (!searchEngine) {
      let vectorStore: VectorStoreLike | null = null;
      try {
        vectorStore = (ctx.container?.get('vectorStore') as VectorStoreLike) ?? null;
      } catch {
        /* not available */
      }

      if (!vectorStore) {
        return {
          error:
            '语义搜索不可用: SearchEngine 和 VectorStore 均未初始化。可使用 search_project_code 进行关键词搜索替代。',
          fallbackTool: 'search_project_code',
        };
      }

      let aiProvider: AIProviderLike | null = null;
      try {
        aiProvider = (ctx.container?.get('aiProvider') as AIProviderLike) ?? null;
      } catch {
        /* not available */
      }

      if (!aiProvider || typeof aiProvider.generateEmbedding !== 'function') {
        const filter: Record<string, string> = {};
        if (category) {
          filter.category = category;
        }
        if (language) {
          filter.language = language;
        }

        const results = await vectorStore.hybridSearch([], query, { topK, filter });
        return {
          mode: 'keyword-fallback',
          query,
          message: 'AI Provider 不支持 embedding，已降级到关键词匹配',
          results: results.map((r: VectorSearchResult) => ({
            id: r.item.id,
            content: (r.item.content || '').slice(0, 500),
            score: Math.round(r.score * 100) / 100,
            metadata: r.item.metadata || {},
          })),
        };
      }

      try {
        const embedding = await aiProvider.generateEmbedding(query);
        const filter: Record<string, string> = {};
        if (category) {
          filter.category = category;
        }
        if (language) {
          filter.language = language;
        }

        const results = await vectorStore.hybridSearch(embedding, query, { topK, filter });
        return {
          mode: 'vector',
          query,
          results: results.map((r: VectorSearchResult) => ({
            id: r.item.id,
            content: (r.item.content || '').slice(0, 500),
            score: Math.round(r.score * 100) / 100,
            metadata: r.item.metadata || {},
          })),
        };
      } catch (err: unknown) {
        return {
          error: `向量搜索失败: ${(err as Error).message}`,
          fallbackTool: 'search_project_code',
        };
      }
    }

    // 使用 SearchEngine (BM25 + 可选向量)
    try {
      const result = await searchEngine.search(query, {
        mode: 'semantic',
        limit: topK * 2,
        groupByKind: true,
      });

      let items = result?.items || [];
      const actualMode = result?.mode || 'bm25';

      if (category) {
        items = items.filter(
          (i: SearchEngineItem) => (i.category || '').toLowerCase() === category.toLowerCase()
        );
      }
      if (language) {
        items = items.filter(
          (i: SearchEngineItem) => (i.language || '').toLowerCase() === language.toLowerCase()
        );
      }
      items = items.slice(0, topK);

      return {
        mode: actualMode,
        query,
        degraded: actualMode !== 'semantic',
        totalResults: items.length,
        results: items.map((item: SearchEngineItem) => ({
          id: item.id,
          title: item.title || '',
          content: (item.content || item.description || '').slice(0, 500),
          score: Math.round((item.score || 0) * 100) / 100,
          knowledgeType: item.knowledgeType || item.kind || '',
          category: item.category || '',
          language: item.language || '',
        })),
      };
    } catch (err: unknown) {
      return { error: `搜索失败: ${(err as Error).message}`, fallbackTool: 'search_project_code' };
    }
  },
};
