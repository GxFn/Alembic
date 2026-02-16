/**
 * tools.js — ChatAgent 全部工具定义
 *
 * 54 个工具覆盖项目全部 AI 能力:
 *
 * ┌─── 项目数据访问 (5) ────────────────────────────────────┐
 * │  1. search_project_code    搜索项目源码               │
 * │  2. read_project_file      读取项目文件               │
 * │  2b. list_project_structure 列出项目目录结构 (v10)     │
 * │  2c. get_file_summary       文件结构摘要 (v10)        │
 * │  2d. semantic_search_code   语义知识搜索 (v10)        │
 * └────────────────────────────────────────────────────────┘
 * ┌─── 查询类 (8) ─────────────────────────────────┐
 * │  3. search_recipes       搜索 Recipe            │
 * │  4. search_candidates    搜索候选项             │
 * │  5. get_recipe_detail    获取 Recipe 详情        │
 * │  6. get_project_stats    获取项目统计            │
 * │  7. search_knowledge     RAG 知识库搜索          │
 * │  8. get_related_recipes  知识图谱关联查询        │
 * │  9. list_guard_rules     列出 Guard 规则         │
 * │ 10. get_recommendations  获取推荐 Recipe          │
 * └─────────────────────────────────────────────────┘
 * ┌─── AI 分析类 (5) ──────────────────────────────────┐
 * │ 11. summarize_code              代码摘要           │
 * │ 12. extract_recipes             从源码提取 Recipe  │
 * │ 13. enrich_candidate            ① 结构补齐         │
 * │ 13b. refine_bootstrap_candidates ② 内容润色        │
 * │ 14. ai_translate                AI 翻译 (中→英)    │
 * └─────────────────────────────────────────────────────┘
 * ┌─── Guard 安全类 (3) ───────────────────────────────┐
 * │ 15. guard_check_code     Guard 规则代码检查       │
 * │ 16. query_violations     查询 Guard 违规记录      │
 * │ 17. generate_guard_rule  AI 生成 Guard 规则       │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 生命周期操作类 (7) ─────────────────────────────┐
 * │ 18. submit_candidate     提交候选                │
 * │ 19. approve_candidate    批准候选                │
 * │ 20. reject_candidate     驳回候选                │
 * │ 21. publish_recipe       发布 Recipe              │
 * │ 22. deprecate_recipe     弃用 Recipe              │
 * │ 23. update_recipe        更新 Recipe 字段         │
 * │ 24. record_usage         记录 Recipe 使用         │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 质量与反馈类 (3) ───────────────────────────────┐
 * │ 25. quality_score        Recipe 质量评分          │
 * │ 26. validate_candidate   候选校验                │
 * │ 27. get_feedback_stats   获取反馈统计            │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 知识图谱类 (3) ─────────────────────────────────┐
 * │ 28. check_duplicate      候选查重                │
 * │ 29. discover_relations   知识图谱关系发现         │
 * │ 30. add_graph_edge       添加知识图谱关系         │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 基础设施类 (3) ─────────────────────────────────┐
 * │ 31. graph_impact_analysis 影响范围分析            │
 * │ 32. rebuild_index         向量索引重建            │
 * │ 33. query_audit_log       审计日志查询            │
 * └─────────────────────────────────────────────────────┘
 * ┌─── Skills & Bootstrap (4) ─────────────────────────┐
 * │ 34. load_skill            加载 Agent Skill 文档   │
 * │ 35. create_skill          创建项目级 Skill        │
 * │ 36. suggest_skills        推荐创建 Skill          │
 * │ 37. bootstrap_knowledge   冷启动知识库初始化      │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 组合工具 (3) ───────────────────────────────────┐
 * │ 38. analyze_code          Guard + Recipe 搜索      │
 * │ 39. knowledge_overview    全局知识库概览           │
 * │ 40. submit_with_check     查重 + 提交              │
 * └─────────────────────────────────────────────────────┘
 * ┌─── 元工具 (3) — Agent 自主能力增强 ───────────────┐
 * │ 41. get_tool_details      工具参数查询             │
 * │ 42. plan_task             任务规划 (结构化计划)    │
 * │ 43. review_my_output      自我质量审查             │
 * └─────────────────────────────────────────────────────┘
 *
 * v10 新增工具 (领域大脑 Agent-Pull):
 *   2b. list_project_structure — 项目目录树 + 文件统计
 *   2c. get_file_summary — 文件导入/声明/方法签名摘要
 *   2d. semantic_search_code — 语义相似度知识搜索
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimilarRecipes } from '../candidate/SimilarityService.js';
import { CandidateGuardrail } from './CandidateGuardrail.js';
import Logger from '../../infrastructure/logging/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
/** skills/ 目录绝对路径 */
const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'skills');
/** 项目级 skills 目录 */
const PROJECT_SKILLS_DIR = path.resolve(PROJECT_ROOT, '.autosnippet', 'skills');

// ════════════════════════════════════════════════════════════
// 项目数据访问 (5) — 搜索/读取用户项目源码 + v10 Agent-Pull
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// 1. search_project_code — 搜索项目源码
// ────────────────────────────────────────────────────────────

/** 三方库路径识别（与 bootstrap/shared/third-party-filter.js 对齐） */
const THIRD_PARTY_RE = /(?:^|\/)(?:Pods|Carthage|\.build\/checkouts|vendor|ThirdParty|External|Submodules|DerivedData|include|node_modules|build)\/|(?:^|\/)(?:Masonry|AFNetworking|SDWebImage|MJRefresh|MJExtension|YYKit|YYModel|Lottie|FLEX|IQKeyboardManager|MBProgressHUD|SVProgressHUD|SnapKit|Kingfisher|Alamofire|Moya|ReactiveObjC|ReactiveCocoa|RxSwift|RxCocoa|FMDB|Realm|Mantle|JSONModel|CocoaLumberjack|CocoaAsyncSocket|SocketRocket|GPUImage|FBSDKCore|FBSDKLogin|FlatBuffers|Protobuf|PromiseKit|Charts|Hero)\//i;

/** 源码文件扩展名 */
const SOURCE_EXT_RE = /\.(m|mm|swift|h|c|cpp|js|ts|jsx|tsx|py|rb|java|kt|go|rs)$/i;

/** 声明行识别 — 用于对匹配行打分（与 bootstrap/shared/scanner.js 对齐） */
const DECL_RE = /^\s*(@property\b|@interface\b|@protocol\b|@class\b|@synthesize\b|@dynamic\b|@end\b|NS_ASSUME_NONNULL|#import\b|#include\b|#define\b)/;
const TYPE_DECL_RE = /^\s*\w[\w<>*\s]+[\s*]+_?\w+\s*;$/;

function _scoreSearchLine(line) {
  const t = line.trim();
  if (DECL_RE.test(t)) return -2;
  if (TYPE_DECL_RE.test(t)) return -1;
  if (/^[-+]\s*\([^)]+\)\s*\w+[^{]*;\s*$/.test(t)) return -1;
  if (/\[.*\w+.*\]/.test(t)) return 2;   // ObjC message send
  if (/\w+\s*\(/.test(t)) return 2;       // function call
  if (/\^\s*[{(]/.test(t)) return 1;      // block literal
  return 0;
}

/**
 * 收集项目文件列表 — 抽取为公用函数，供单次和批量搜索复用。
 * 优先使用内存缓存（bootstrap 场景），否则从磁盘递归读取。
 */
async function _getProjectFiles(params, ctx) {
  const { fileFilter } = params;
  const projectRoot = ctx.projectRoot || process.cwd();

  let extFilter = null;
  if (fileFilter) {
    const exts = fileFilter.split(',').map(e => e.trim().replace(/^\./, ''));
    extFilter = new RegExp(`\\.(${exts.join('|')})$`, 'i');
  }

  const fileCache = ctx.fileCache || null;
  let files;
  let skippedThirdParty = 0;

  if (fileCache && Array.isArray(fileCache)) {
    files = fileCache.filter(f => {
      const p = f.relativePath || f.path || '';
      if (THIRD_PARTY_RE.test(p)) { skippedThirdParty++; return false; }
      if (extFilter && !extFilter.test(p)) return false;
      if (!SOURCE_EXT_RE.test(p)) return false;
      return true;
    });
  } else {
    files = [];
    const MAX_FILE_SIZE = 512 * 1024;
    const walk = (dir, relBase = '') => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          const fullPath = path.join(dir, entry.name);
          const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(fullPath).isDirectory(); } catch { return false; } })());
          const isFile = entry.isFile() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(fullPath).isFile(); } catch { return false; } })());
          if (isDir) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
            if (THIRD_PARTY_RE.test(relPath + '/')) { skippedThirdParty++; continue; }
            walk(fullPath, relPath);
          } else if (isFile) {
            if (THIRD_PARTY_RE.test(relPath)) { skippedThirdParty++; continue; }
            if (!SOURCE_EXT_RE.test(entry.name)) continue;
            if (extFilter && !extFilter.test(entry.name)) continue;
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > MAX_FILE_SIZE) continue;
              const content = fs.readFileSync(fullPath, 'utf-8');
              files.push({ relativePath: relPath, content, name: entry.name });
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* skip inaccessible dirs */ }
    };
    walk(projectRoot);
  }

  return { files, skippedThirdParty };
}

const searchProjectCode = {
  name: 'search_project_code',
  description: '在用户项目源码中搜索指定模式。返回匹配的代码片段及上下文。' +
    '自动过滤三方库代码（Pods/Carthage/node_modules），优先返回实际使用行而非声明行。' +
    '适用场景：验证代码模式存在性、查找更多项目示例、理解项目中某个 API 的用法。' +
    '批量搜索：传入 patterns 数组可一次搜索多个关键词（每个关键词独立返回结果），减少工具调用次数。',
  parameters: {
    type: 'object',
    properties: {
      pattern:      { type: 'string', description: '搜索词或正则表达式（单个搜索时使用）' },
      patterns:     { type: 'array', items: { type: 'string' }, description: '批量搜索：多个搜索词数组，如 ["methodA", "methodB", "classC"]。与 pattern 互斥，优先使用 patterns。' },
      isRegex:      { type: 'boolean', description: '是否为正则表达式，默认 false' },
      fileFilter:   { type: 'string', description: '文件扩展名过滤，如 ".m,.swift"' },
      contextLines: { type: 'number', description: '匹配行前后的上下文行数，默认 3' },
      maxResults:   { type: 'number', description: '每个 pattern 的最大返回结果数，默认 5' },
    },
    required: [],
  },
  handler: async (params, ctx) => {
    // ── 去重缓存初始化 ──
    const state = ctx._sharedState || ctx;
    if (!state._searchCache) state._searchCache = new Map();

    // ── 批量模式：patterns 数组 ──
    if (Array.isArray(params.patterns) && params.patterns.length > 0) {
      const batchPatterns = params.patterns.slice(0, 10); // 最多 10 个
      const batchResults = {};
      let dedupCount = 0;
      for (const p of batchPatterns) {
        // 去重：已搜索过的 pattern 直接返回缓存
        const cacheKey = `${p}|${params.isRegex || false}|${params.fileFilter || ''}`;
        if (state._searchCache.has(cacheKey)) {
          batchResults[p] = { ...state._searchCache.get(cacheKey), _cached: true };
          dedupCount++;
          continue;
        }
        const sub = await searchProjectCode.handler(
          { ...params, pattern: p, patterns: undefined },
          ctx,
        );
        const entry = { matches: sub.matches || [], total: sub.total || 0 };
        state._searchCache.set(cacheKey, entry);
        batchResults[p] = entry;
      }
      return {
        batchResults,
        patternsSearched: batchPatterns.length,
        searchedFiles: (await _getProjectFiles(params, ctx)).files.length,
        ...(dedupCount > 0 ? { _deduped: dedupCount, hint: `${dedupCount} 个 pattern 命中缓存，请避免重复搜索相同关键词。` } : {}),
      };
    }

    // 兼容 AI 传 "query" / "search" / "keyword" 替代 "pattern"
    const pattern = params.pattern || params.query || params.search || params.keyword || params.search_query;
    const { isRegex = false, fileFilter, contextLines = 3, maxResults = 5 } = params;
    const projectRoot = ctx.projectRoot || process.cwd();

    if (!pattern || typeof pattern !== 'string') {
      return { error: '参数错误: 请提供 pattern（搜索关键词或正则表达式）或 patterns 数组', matches: [], total: 0 };
    }

    // ── 单 pattern 去重检查 ──
    const cacheKey = `${pattern}|${params.isRegex || false}|${params.fileFilter || ''}`;
    if (state._searchCache.has(cacheKey)) {
      const cached = state._searchCache.get(cacheKey);
      return { ...cached, _cached: true, hint: `⚠ 已搜索过 "${pattern}"，返回缓存结果。请搜索不同的关键词以获取新信息。` };
    }

    // 构建搜索正则
    let searchRe;
    try {
      searchRe = isRegex ? new RegExp(pattern, 'gi') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (err) {
      return { error: `Invalid pattern: ${err.message}`, matches: [], total: 0 };
    }

    const { files, skippedThirdParty } = await _getProjectFiles(params, ctx);

    // 搜索匹配
    const matches = [];
    let total = 0;

    for (const f of files) {
      if (!f.content) continue;
      // 快速预过滤
      searchRe.lastIndex = 0;
      if (!searchRe.test(f.content)) continue;

      const lines = f.content.split('\n');
      searchRe.lastIndex = 0;

      for (let i = 0; i < lines.length; i++) {
        searchRe.lastIndex = 0;
        if (!searchRe.test(lines[i])) continue;
        total++;

        if (matches.length < maxResults) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          const contextArr = [];
          for (let j = start; j <= end; j++) {
            contextArr.push(lines[j]);
          }

          matches.push({
            file: f.relativePath || f.path || f.name,
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
      ...((() => {
        // P2.2: 搜索超限提示 — 引导使用 AST 工具
        state._searchCallCount = (state._searchCallCount || 0) + 1;
        if (state._searchCallCount > 12 && ctx.source === 'system') {
          return { hint: `💡 你已搜索 ${state._searchCallCount} 次。考虑使用 get_class_info / get_class_hierarchy / get_project_overview 获取结构化信息，效率更高。` };
        }
        return {};
      })()),
    };

    // 缓存搜索结果
    state._searchCache.set(cacheKey, { matches: result.matches, total: result.total });

    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 2. read_project_file — 读取项目文件
// ────────────────────────────────────────────────────────────
const readProjectFile = {
  name: 'read_project_file',
  description: '读取项目中指定文件的内容（部分或全部）。' +
    '通常在 search_project_code 找到匹配后使用，获取更完整的上下文。' +
    '批量读取：传入 filePaths 数组可一次读取多个文件，减少工具调用次数。',
  parameters: {
    type: 'object',
    properties: {
      filePath:   { type: 'string', description: '相对于项目根目录的文件路径（单个文件时使用）' },
      filePaths:  { type: 'array', items: { type: 'string' }, description: '批量读取：多个文件路径数组。与 filePath 互斥，优先使用 filePaths。' },
      startLine:  { type: 'number', description: '起始行号（1-based），默认 1' },
      endLine:    { type: 'number', description: '结束行号（1-based），默认文件末尾' },
      maxLines:   { type: 'number', description: '最大返回行数，默认 200（批量模式下每个文件最多 100 行）' },
    },
    required: [],
  },
  handler: async (params, ctx) => {
    // ── 去重缓存初始化 ──
    const state = ctx._sharedState || ctx;
    if (!state._readCache) state._readCache = new Map();

    // ── 批量模式：filePaths 数组 ──
    if (Array.isArray(params.filePaths) && params.filePaths.length > 0) {
      const batchPaths = params.filePaths.slice(0, 8); // 最多 8 个文件
      const batchResults = {};
      let dedupCount = 0;
      for (const fp of batchPaths) {
        const cacheKey = `${fp}|${params.startLine || 1}|${params.endLine || ''}|${params.maxLines || 100}`;
        if (state._readCache.has(cacheKey)) {
          batchResults[fp] = { ...state._readCache.get(cacheKey), _cached: true };
          dedupCount++;
          continue;
        }
        const sub = await readProjectFile.handler(
          { ...params, filePath: fp, filePaths: undefined, maxLines: Math.min(params.maxLines || 100, 100) },
          ctx,
        );
        const entry = sub.error ? { error: sub.error } : { content: sub.content, totalLines: sub.totalLines, language: sub.language };
        state._readCache.set(cacheKey, entry);
        batchResults[fp] = entry;
      }
      return {
        batchResults,
        filesRead: batchPaths.length,
        ...(dedupCount > 0 ? { _deduped: dedupCount, hint: `${dedupCount} 个文件命中缓存，请避免重复读取相同文件。` } : {}),
      };
    }

    // 兼容各种参数名变体 (ToolRegistry 层已做 snake→camel 归一化,
    // 这里兜底处理漏网之鱼)
    const filePath = params.filePath || params.path || params.file_path || params.filepath || params.file || params.filename;
    const { startLine = 1, maxLines = 200 } = params;
    const projectRoot = ctx.projectRoot || process.cwd();

    if (!filePath || typeof filePath !== 'string') {
      return { error: '参数错误: 请提供 filePath（相对于项目根目录的文件路径）或 filePaths 数组' };
    }

    // ── 单文件去重检查 ──
    const readCacheKey = `${filePath}|${startLine}|${params.endLine || ''}|${maxLines}`;
    if (state._readCache.has(readCacheKey)) {
      return { ...state._readCache.get(readCacheKey), _cached: true, hint: `⚠ 已读取过该文件相同行范围，返回缓存结果。如需其他行范围请指定不同的 startLine/endLine。` };
    }

    // 安全检查: 禁止路径遍历
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed. Use relative paths within the project.' };
    }

    // 优先从内存缓存读取（bootstrap 场景）
    const fileCache = ctx.fileCache || null;
    let content = null;

    if (fileCache && Array.isArray(fileCache)) {
      const cached = fileCache.find(f =>
        (f.relativePath || f.path || '') === filePath ||
        (f.relativePath || f.path || '') === normalized
      );
      if (cached) content = cached.content;
    }

    // 降级: 从磁盘读取
    if (content === null) {
      const fullPath = path.resolve(projectRoot, normalized);
      // 二次安全检查: 确保解析后仍在 projectRoot 内
      if (!fullPath.startsWith(projectRoot)) {
        return { error: 'Path traversal not allowed.' };
      }
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (err) {
        return { error: `File not found or unreadable: ${err.message}` };
      }
    }

    const allLines = content.split('\n');
    const totalLines = allLines.length;
    const start = Math.max(1, startLine);
    let end = params.endLine || totalLines;
    end = Math.min(end, totalLines);

    // 限制返回行数
    if (end - start + 1 > maxLines) {
      end = start + maxLines - 1;
    }

    const selectedLines = allLines.slice(start - 1, end);

    // 推断语言
    const ext = path.extname(filePath).toLowerCase();
    const langMap = { '.m': 'objectivec', '.mm': 'objectivec', '.h': 'objectivec', '.swift': 'swift', '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.go': 'go', '.rs': 'rust', '.rb': 'ruby' };
    const language = langMap[ext] || 'unknown';

    const readResult = {
      filePath,
      totalLines,
      startLine: start,
      endLine: end,
      content: selectedLines.join('\n'),
      language,
    };

    // 缓存读取结果
    state._readCache.set(readCacheKey, { content: readResult.content, totalLines, language });

    return readResult;
  },
};

// ────────────────────────────────────────────────────────────
// 2b. list_project_structure — 项目目录结构 (v10 Agent-Pull)
// ────────────────────────────────────────────────────────────
const listProjectStructure = {
  name: 'list_project_structure',
  description: '列出项目目录结构和文件统计信息。不读取文件内容，只返回目录树和元数据。' +
    '适用场景：了解项目整体布局、识别关键目录、规划探索路径。',
  parameters: {
    type: 'object',
    properties: {
      directory:    { type: 'string', description: '相对于项目根目录的子目录路径，默认根目录' },
      depth:        { type: 'number', description: '目录展开深度，默认 3' },
      includeStats: { type: 'boolean', description: '是否包含文件统计（语言分布、行数），默认 true' },
    },
  },
  handler: async (params, ctx) => {
    const directory = params.directory || '';
    const depth = Math.min(params.depth ?? 3, 5); // 最深 5 层
    const includeStats = params.includeStats !== false;
    const projectRoot = ctx.projectRoot || process.cwd();

    // 安全检查
    const normalized = path.normalize(directory);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed. Use relative paths within the project.' };
    }
    const targetDir = directory ? path.resolve(projectRoot, normalized) : projectRoot;
    if (!targetDir.startsWith(projectRoot)) {
      return { error: 'Path traversal not allowed.' };
    }

    const treeLines = [];
    const stats = { totalFiles: 0, totalDirs: 0, byLanguage: {}, totalLines: 0 };

    const LANG_MAP = {
      '.m': 'Objective-C', '.mm': 'Objective-C++', '.h': 'Header',
      '.swift': 'Swift', '.js': 'JavaScript', '.ts': 'TypeScript',
      '.jsx': 'JSX', '.tsx': 'TSX', '.py': 'Python', '.java': 'Java',
      '.kt': 'Kotlin', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby',
      '.c': 'C', '.cpp': 'C++',
    };

    const walk = (dir, relBase, currentDepth, prefix) => {
      if (currentDepth > depth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }

      // 排序: 目录在前，文件在后
      entries.sort((a, b) => {
        const aIsDir = a.isDirectory();
        const bIsDir = b.isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // 过滤隐藏和三方
      entries = entries.filter(e => {
        if (e.name.startsWith('.')) return false;
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (THIRD_PARTY_RE.test(rel + '/')) return false;
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
          // 计算子文件数
          let childCount = 0;
          try { childCount = fs.readdirSync(fullPath).length; } catch { /* skip */ }
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
            } catch { /* skip */ }
          }
          const lang = LANG_MAP[ext];
          if (lang) {
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

// ────────────────────────────────────────────────────────────
// 2c. get_file_summary — 文件摘要 (v10 Agent-Pull)
// ────────────────────────────────────────────────────────────

/** 语言相关的声明提取正则 */
const SUMMARY_EXTRACTORS = {
  objectivec: {
    imports:      /^\s*(#import\s+.+|#include\s+.+|@import\s+\w+;)/gm,
    declarations: /^\s*(@interface\s+\w+[\s:(].*|@protocol\s+\w+[\s<(].*|@implementation\s+\w+|typedef\s+(?:NS_ENUM|NS_OPTIONS)\s*\([^)]+\)\s*\{?)/gm,
    methods:      /^\s*[-+]\s*\([^)]+\)\s*[^;{]+/gm,
    properties:   /^\s*@property\s*\([^)]*\)\s*[^;]+;/gm,
  },
  swift: {
    imports:      /^\s*import\s+\w+/gm,
    declarations: /^\s*(?:open|public|internal|fileprivate|private|final)?\s*(?:class|struct|enum|protocol|actor|extension)\s+\w+[^{]*/gm,
    methods:      /^\s*(?:open|public|internal|fileprivate|private|override|static|class)?\s*func\s+\w+[^{]*/gm,
    properties:   /^\s*(?:open|public|internal|fileprivate|private|static|class|lazy)?\s*(?:var|let)\s+\w+\s*:\s*[^={\n]+/gm,
  },
  javascript: {
    imports:      /^\s*(?:import\s+.+from\s+['"].+['"]|const\s+\{?\s*\w+.*\}?\s*=\s*require\s*\(.+\))/gm,
    declarations: /^\s*(?:export\s+)?(?:default\s+)?(?:class|function|const|let|var)\s+\w+/gm,
    methods:      /^\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#?\w+)\s*\([^)]*\)\s*\{/gm,
  },
  typescript: {
    imports:      /^\s*import\s+.+from\s+['"].+['"]/gm,
    declarations: /^\s*(?:export\s+)?(?:default\s+)?(?:class|interface|type|enum|function|const|let|var|abstract\s+class)\s+\w+/gm,
    methods:      /^\s*(?:async\s+)?(?:static\s+)?(?:public|private|protected)?\s*(?:get\s+|set\s+)?(?:#?\w+)\s*\([^)]*\)\s*[:{]/gm,
  },
  python: {
    imports:      /^\s*(?:import\s+\w+|from\s+\w+\s+import\s+.+)/gm,
    declarations: /^\s*class\s+\w+[^:]*:/gm,
    methods:      /^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)/gm,
  },
};
// Alias variants
SUMMARY_EXTRACTORS['objectivec++'] = SUMMARY_EXTRACTORS.objectivec;
SUMMARY_EXTRACTORS.jsx = SUMMARY_EXTRACTORS.javascript;
SUMMARY_EXTRACTORS.tsx = SUMMARY_EXTRACTORS.typescript;

const getFileSummary = {
  name: 'get_file_summary',
  description: '获取文件的结构摘要（导入、声明、方法签名），不包含实现代码。' +
    '比 read_project_file 更轻量，适合快速了解文件角色和 API。',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '相对于项目根目录的文件路径' },
    },
    required: ['filePath'],
  },
  handler: async (params, ctx) => {
    const filePath = params.filePath || params.file_path || params.path || params.file;
    const projectRoot = ctx.projectRoot || process.cwd();

    if (!filePath || typeof filePath !== 'string') {
      return { error: '参数错误: 请提供 filePath' };
    }

    // 安全检查
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { error: 'Path traversal not allowed.' };
    }

    // 优先从内存缓存读取
    const fileCache = ctx.fileCache || null;
    let content = null;

    if (fileCache && Array.isArray(fileCache)) {
      const cached = fileCache.find(f =>
        (f.relativePath || f.path || '') === filePath ||
        (f.relativePath || f.path || '') === normalized
      );
      if (cached) content = cached.content;
    }

    if (content === null) {
      const fullPath = path.resolve(projectRoot, normalized);
      if (!fullPath.startsWith(projectRoot)) {
        return { error: 'Path traversal not allowed.' };
      }
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (err) {
        return { error: `File not found or unreadable: ${err.message}` };
      }
    }

    // 推断语言
    const ext = path.extname(filePath).toLowerCase();
    const langMap = { '.m': 'objectivec', '.mm': 'objectivec++', '.h': 'objectivec', '.swift': 'swift', '.js': 'javascript', '.ts': 'typescript', '.jsx': 'jsx', '.tsx': 'tsx', '.py': 'python', '.java': 'unknown', '.kt': 'unknown', '.go': 'unknown', '.rs': 'unknown', '.rb': 'unknown' };
    const language = langMap[ext] || 'unknown';
    const extractor = SUMMARY_EXTRACTORS[language];

    const result = {
      filePath,
      language,
      lineCount: content.split('\n').length,
      imports: [],
      declarations: [],
      methods: [],
      properties: [],
    };

    if (!extractor) {
      // 未知语言: 返回前 30 行作为概览
      result.preview = content.split('\n').slice(0, 30).join('\n');
      return result;
    }

    // 提取各类声明
    const extract = (regex) => {
      const matches = [];
      let m;
      regex.lastIndex = 0;
      while ((m = regex.exec(content)) !== null) {
        matches.push(m[0].trim());
      }
      return matches;
    };

    if (extractor.imports)      result.imports      = extract(extractor.imports);
    if (extractor.declarations) result.declarations = extract(extractor.declarations);
    if (extractor.methods)      result.methods      = extract(extractor.methods).slice(0, 50); // 限制数量
    if (extractor.properties)   result.properties   = extract(extractor.properties).slice(0, 30);

    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 2d. semantic_search_code — 语义搜索 (v10 Agent-Pull)
// ────────────────────────────────────────────────────────────
const semanticSearchCode = {
  name: 'semantic_search_code',
  description: '在知识库中进行语义搜索。使用自然语言描述你要查找的代码模式或概念，' +
    '返回语义最相关的知识条目。比关键词搜索更适合模糊/概念性查询。' +
    '示例: "网络请求的错误处理策略"、"线程安全的单例实现"',
  parameters: {
    type: 'object',
    properties: {
      query:    { type: 'string', description: '自然语言搜索查询' },
      topK:     { type: 'number', description: '返回结果数量，默认 5' },
      category: { type: 'string', description: '按分类过滤 (View/Service/Network/Model 等)' },
      language: { type: 'string', description: '按语言过滤 (swift/objectivec 等)' },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    const query = params.query || params.search || params.keyword;
    const topK = Math.min(params.topK ?? 5, 20);
    const { category, language } = params;

    if (!query || typeof query !== 'string') {
      return { error: '参数错误: 请提供 query (自然语言搜索查询)' };
    }

    // 尝试获取 SearchEngine
    let searchEngine = null;
    try {
      searchEngine = ctx.container?.get('searchEngine');
    } catch { /* not available */ }

    if (!searchEngine) {
      // 尝试获取 VectorStore 直接搜索
      let vectorStore = null;
      try {
        vectorStore = ctx.container?.get('vectorStore');
      } catch { /* not available */ }

      if (!vectorStore) {
        return {
          error: '语义搜索不可用: SearchEngine 和 VectorStore 均未初始化。可使用 search_project_code 进行关键词搜索替代。',
          fallbackTool: 'search_project_code',
        };
      }

      // 直接使用 VectorStore — 需要 embedding
      let aiProvider = null;
      try {
        aiProvider = ctx.container?.get('aiProvider');
      } catch { /* not available */ }

      if (!aiProvider || typeof aiProvider.generateEmbedding !== 'function') {
        // 向量搜索需要 embedding，降级到关键词匹配
        const filter = {};
        if (category) filter.category = category;
        if (language) filter.language = language;

        const results = await vectorStore.hybridSearch([], query, { topK, filter });
        return {
          mode: 'keyword-fallback',
          query,
          message: 'AI Provider 不支持 embedding，已降级到关键词匹配',
          results: results.map(r => ({
            id: r.item.id,
            content: (r.item.content || '').slice(0, 500),
            score: Math.round(r.score * 100) / 100,
            metadata: r.item.metadata || {},
          })),
        };
      }

      // 生成 embedding → 向量搜索
      try {
        const embedding = await aiProvider.generateEmbedding(query);
        const filter = {};
        if (category) filter.category = category;
        if (language) filter.language = language;

        const results = await vectorStore.hybridSearch(embedding, query, { topK, filter });
        return {
          mode: 'vector',
          query,
          results: results.map(r => ({
            id: r.item.id,
            content: (r.item.content || '').slice(0, 500),
            score: Math.round(r.score * 100) / 100,
            metadata: r.item.metadata || {},
          })),
        };
      } catch (err) {
        return { error: `向量搜索失败: ${err.message}`, fallbackTool: 'search_project_code' };
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

      // 应用过滤
      if (category) items = items.filter(i => (i.category || '').toLowerCase() === category.toLowerCase());
      if (language) items = items.filter(i => (i.language || '').toLowerCase() === language.toLowerCase());
      items = items.slice(0, topK);

      return {
        mode: actualMode,
        query,
        degraded: actualMode !== 'semantic',
        totalResults: items.length,
        results: items.map(item => ({
          id: item.id,
          title: item.title || '',
          content: (item.content || item.description || '').slice(0, 500),
          score: Math.round((item.score || 0) * 100) / 100,
          knowledgeType: item.knowledgeType || item.kind || '',
          category: item.category || '',
          language: item.language || '',
        })),
      };
    } catch (err) {
      return { error: `搜索失败: ${err.message}`, fallbackTool: 'search_project_code' };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 3. search_recipes
// ────────────────────────────────────────────────────────────
const searchRecipes = {
  name: 'search_recipes',
  description: '搜索知识库中的 Recipe（代码片段/最佳实践/架构模式）。支持关键词搜索和按分类/语言/类型筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword:       { type: 'string', description: '搜索关键词' },
      category:      { type: 'string', description: '分类过滤 (View/Service/Tool/Model/Network/Storage/UI/Utility)' },
      language:      { type: 'string', description: '编程语言过滤 (swift/objectivec/typescript 等)' },
      knowledgeType: { type: 'string', description: '知识类型过滤 (code-standard/code-pattern/architecture/best-practice 等)' },
      limit:         { type: 'number', description: '返回数量上限，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    const { keyword, category, language, knowledgeType, limit = 10 } = params;

    if (keyword) {
      return recipeService.searchRecipes(keyword, { page: 1, pageSize: limit });
    }

    const filters = {};
    if (category)      filters.category = category;
    if (language)      filters.language = language;
    if (knowledgeType) filters.knowledgeType = knowledgeType;

    return recipeService.listRecipes(filters, { page: 1, pageSize: limit });
  },
};

// ────────────────────────────────────────────────────────────
// 2. search_candidates
// ────────────────────────────────────────────────────────────
const searchCandidates = {
  name: 'search_candidates',
  description: '搜索或列出候选项（待审核的代码片段）。支持关键词搜索和按状态/语言/分类筛选。',
  parameters: {
    type: 'object',
    properties: {
      keyword:  { type: 'string', description: '搜索关键词' },
      status:   { type: 'string', description: '状态过滤 (pending/approved/rejected/applied)' },
      language: { type: 'string', description: '编程语言过滤' },
      category: { type: 'string', description: '分类过滤' },
      limit:    { type: 'number', description: '返回数量上限，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const candidateService = ctx.container.get('candidateService');
    const { keyword, status, language, category, limit = 10 } = params;

    if (keyword) {
      return candidateService.searchCandidates(keyword, { page: 1, pageSize: limit });
    }

    const filters = {};
    if (status)   filters.status = status;
    if (language) filters.language = language;
    if (category) filters.category = category;

    return candidateService.listCandidates(filters, { page: 1, pageSize: limit });
  },
};

// ────────────────────────────────────────────────────────────
// 3. get_recipe_detail
// ────────────────────────────────────────────────────────────
const getRecipeDetail = {
  name: 'get_recipe_detail',
  description: '获取单个 Recipe 的完整详情（代码、摘要、使用指南、关系等）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const recipeRepo = ctx.container.get('recipeRepository');
    const recipe = await recipeRepo.findById(params.recipeId);
    if (!recipe) return { error: `Recipe '${params.recipeId}' not found` };
    return recipe;
  },
};

// ────────────────────────────────────────────────────────────
// 4. get_project_stats
// ────────────────────────────────────────────────────────────
const getProjectStats = {
  name: 'get_project_stats',
  description: '获取项目知识库的整体统计：Recipe 数量/分类分布、候选项数量/状态分布、知识图谱节点/边数。',
  parameters: { type: 'object', properties: {} },
  handler: async (_params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    const candidateService = ctx.container.get('candidateService');

    const [recipeStats, candidateStats] = await Promise.all([
      recipeService.getRecipeStats(),
      candidateService.getCandidateStats(),
    ]);

    // 尝试获取知识图谱统计
    let graphStats = null;
    try {
      const kgService = ctx.container.get('knowledgeGraphService');
      graphStats = kgService.getStats();
    } catch { /* KG not available */ }

    return {
      recipes: recipeStats,
      candidates: candidateStats,
      knowledgeGraph: graphStats,
    };
  },
};

// ────────────────────────────────────────────────────────────
// 5. search_knowledge
// ────────────────────────────────────────────────────────────
const searchKnowledge = {
  name: 'search_knowledge',
  description: 'RAG 知识库语义搜索 — 结合向量检索和关键词检索，返回与查询最相关的知识片段。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索查询' },
      topK:  { type: 'number', description: '返回结果数，默认 5' },
    },
    required: ['query'],
  },
  handler: async (params, ctx) => {
    const { query, topK = 5 } = params;

    // 优先使用 SearchEngine（有 BM25 + 向量搜索）
    try {
      const searchEngine = ctx.container.get('searchEngine');
      const results = await searchEngine.search(query, { limit: topK });
      if (results && results.length > 0) {
        const enriched = results.slice(0, topK).map((r, i) => ({
          ...r,
          reasoning: {
            whyRelevant: r.score != null
              ? `匹配分 ${(r.score * 100).toFixed(0)}%` + (r.matchType ? ` (${r.matchType})` : '')
              : '语义相关',
            rank: i + 1,
          },
        }));
        const topScore = enriched[0]?.score ?? 0;
        return {
          source: 'searchEngine',
          results: enriched,
          _meta: {
            confidence: topScore > 0.7 ? 'high' : topScore > 0.3 ? 'medium' : 'low',
            hint: topScore < 0.3 ? '匹配度较低，结果可能不够相关。建议尝试更具体的查询词。' : null,
          },
        };
      }
    } catch { /* SearchEngine not available */ }

    // 降级: RetrievalFunnel + 全量候选
    try {
      const funnel = ctx.container.get('retrievalFunnel');
      const recipeRepo = ctx.container.get('recipeRepository');
      const allRecipes = await recipeRepo.findAll?.() || [];

      // 规范化为 funnel 输入格式
      const candidates = allRecipes.map(r => ({
        id: r.id,
        title: r.title,
        content: r.content || r.code || '',
        description: r.description || r.summary_cn || '',
        language: r.language,
        category: r.category,
        trigger: r.trigger || '',
      }));

      if (candidates.length > 0) {
        const results = await funnel.execute(query, candidates, {});
        return { source: 'retrievalFunnel', results: results.slice(0, topK) };
      }
    } catch { /* RetrievalFunnel not available */ }

    return { source: 'none', results: [], message: 'No search engine available', _meta: { confidence: 'none', hint: '搜索引擎不可用。请确认向量索引已构建（rebuild_index）。' } };
  },
};

// ────────────────────────────────────────────────────────────
// 6. get_related_recipes
// ────────────────────────────────────────────────────────────
const getRelatedRecipes = {
  name: 'get_related_recipes',
  description: '通过知识图谱查询某个 Recipe 的关联 Recipe（requires/extends/enforces 等关系）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      relation: { type: 'string', description: '关系类型过滤 (requires/extends/enforces/depends_on/inherits/implements/calls/prerequisite)，不传则返回全部关系' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    const { recipeId, relation } = params;

    if (relation) {
      const edges = kgService.getRelated(recipeId, 'recipe', relation);
      return { recipeId, relation, edges };
    }

    const edges = kgService.getEdges(recipeId, 'recipe', 'both');
    return { recipeId, ...edges };
  },
};

// ────────────────────────────────────────────────────────────
// 7. summarize_code
// ────────────────────────────────────────────────────────────
const summarizeCode = {
  name: 'summarize_code',
  description: 'AI 代码摘要 — 分析代码片段并生成结构化摘要（包含功能描述、关键 API、使用建议）。',
  parameters: {
    type: 'object',
    properties: {
      code:     { type: 'string', description: '代码内容' },
      language: { type: 'string', description: '编程语言' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    return ctx.aiProvider.summarize(params.code, params.language);
  },
};

// ────────────────────────────────────────────────────────────
// 8. extract_recipes
// ────────────────────────────────────────────────────────────
const extractRecipes = {
  name: 'extract_recipes',
  description: '从源码文件中批量提取可复用的 Recipe 结构（代码标准、设计模式、最佳实践）。支持自动 provider fallback。',
  parameters: {
    type: 'object',
    properties: {
      targetName: { type: 'string', description: 'SPM Target / 模块名称' },
      files:      { type: 'array',  description: '文件数组 [{name, content}]' },
    },
    required: ['targetName', 'files'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    const { targetName, files } = params;

    // 加载语言参考 Skill（如有），注入到 AI 提取 prompt
    let skillReference = null;
    try {
      const { loadBootstrapSkills } = await import('../../external/mcp/handlers/bootstrap.js');
      const langProfile = ctx.aiProvider._detectLanguageProfile?.(files);
      const primaryLang = langProfile?.primaryLanguage;
      if (primaryLang) {
        const skillCtx = loadBootstrapSkills(primaryLang);
        skillReference = skillCtx.languageSkill
          ? skillCtx.languageSkill.substring(0, 2000)
          : null;
      }
    } catch { /* Skills not available, proceed without */ }

    // AST 代码结构分析（如可用），注入到 AI 提取 prompt
    let astContext = null;
    try {
      const { analyzeProject, generateContextForAgent, isAvailable } = await import('../../../core/AstAnalyzer.js');
      if (isAvailable()) {
        const sourceFiles = files
          .filter(f => /\.(m|mm|h|swift|js|ts|jsx|tsx)$/.test(f.name || ''))
          .map(f => ({ path: f.name, source: f.content }));
        if (sourceFiles.length > 0) {
          const langProfile2 = ctx.aiProvider._detectLanguageProfile?.(files);
          const lang = langProfile2?.primaryLanguage === 'swift' ? 'swift' : 'objc';
          const summary = analyzeProject(sourceFiles, lang);
          astContext = generateContextForAgent(summary);
        }
      }
    } catch { /* AST not available, proceed without */ }

    const extractOpts = {};
    if (skillReference) extractOpts.skillReference = skillReference;
    if (astContext) extractOpts.astContext = astContext;

    // 首选：使用当前 aiProvider
    try {
      const recipes = await ctx.aiProvider.extractRecipes(targetName, files, extractOpts);
      const count = Array.isArray(recipes) ? recipes.length : 0;
      if (count === 0) {
        ctx.logger?.warn?.(`[extract_recipes] AI returned 0 recipes for ${targetName} (${files.length} files)`);
      }
      return { targetName, extracted: count, recipes: Array.isArray(recipes) ? recipes : [] };
    } catch (primaryErr) {
      // 尝试 fallback（如果 AiFactory 可用）
      try {
        const aiFactory = ctx.container?.singletons?._aiFactory;
        if (aiFactory?.isGeoOrProviderError?.(primaryErr)) {
          const currentProvider = (process.env.ASD_AI_PROVIDER || 'google').toLowerCase();
          const fallbacks = aiFactory.getAvailableFallbacks(currentProvider);
          for (const fbName of fallbacks) {
            try {
              const fbProvider = aiFactory.createProvider({ provider: fbName });
              const recipes = await fbProvider.extractRecipes(targetName, files, extractOpts);
              return { targetName, extracted: Array.isArray(recipes) ? recipes.length : 0, recipes: Array.isArray(recipes) ? recipes : [], fallbackUsed: fbName };
            } catch { /* next fallback */ }
          }
        }
      } catch { /* AiFactory not available, rethrow original */ }
      throw primaryErr;
    }
  },
};

// ────────────────────────────────────────────────────────────
// 9. enrich_candidate
// ────────────────────────────────────────────────────────────
const enrichCandidate = {
  name: 'enrich_candidate',
  description: '① 结构补齐 — 自动填充缺失的结构性语义字段（rationale/knowledgeType/complexity/scope/steps/constraints）。批量处理，只填空不覆盖。建议在 refine_bootstrap_candidates 之前执行。',
  parameters: {
    type: 'object',
    properties: {
      candidateIds: { type: 'array', description: '候选 ID 列表 (最多 20 个)' },
    },
    required: ['candidateIds'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    const candidateService = ctx.container.get('candidateService');
    return candidateService.enrichCandidates(
      params.candidateIds,
      ctx.aiProvider,
      { userId: 'agent' },
    );
  },
};

// ────────────────────────────────────────────────────────────
// 9b. refine_bootstrap_candidates (Phase 6)
// ────────────────────────────────────────────────────────────
const refineBootstrapCandidates = {
  name: 'refine_bootstrap_candidates',
  description: '② 内容润色 — 逐条精炼 Bootstrap 候选的内容质量：改善 summary、补充架构 insight、推断 relations 关联、调整 confidence、丰富 tags。建议在 enrich_candidate 之后执行。',
  parameters: {
    type: 'object',
    properties: {
      candidateIds: { type: 'array', description: '指定候选 ID 列表（可选，默认全部 bootstrap 候选）' },
      userPrompt: { type: 'string', description: '用户自定义润色提示词，指导 AI 润色方向（如“侧重描述线程安全注意事项”）' },
      dryRun: { type: 'boolean', description: '仅预览 AI 润色结果，不写入数据库' },
    },
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    const candidateService = ctx.container.get('candidateService');

    // 接入 BootstrapTaskManager 双通道推送 refine:* 事件到前端
    let onProgress = null;
    try {
      const taskManager = ctx.container.get('bootstrapTaskManager');
      onProgress = (eventName, data) => taskManager.emitProgress(eventName, data);
    } catch { /* optional: no realtime push */ }

    return candidateService.refineBootstrapCandidates(
      ctx.aiProvider,
      { candidateIds: params.candidateIds, userPrompt: params.userPrompt, dryRun: params.dryRun, onProgress },
      { userId: 'agent' },
    );
  },
};

// ────────────────────────────────────────────────────────────
// 10. check_duplicate
// ────────────────────────────────────────────────────────────
const checkDuplicate = {
  name: 'check_duplicate',
  description: '候选查重 — 检测候选代码是否与已有 Recipe 重复（基于标题/摘要/代码的 Jaccard 相似度）。',
  parameters: {
    type: 'object',
    properties: {
      candidate:   { type: 'object', description: '候选对象 { title, summary, code, usageGuide }' },
      candidateId: { type: 'string', description: '或提供候选 ID，从数据库读取' },
      projectRoot: { type: 'string', description: '项目根目录（可选，默认当前项目）' },
      threshold:   { type: 'number', description: '相似度阈值，默认 0.5' },
    },
  },
  handler: async (params, ctx) => {
    let cand = params.candidate;
    const projectRoot = params.projectRoot || ctx.projectRoot;
    const threshold = params.threshold ?? 0.5;

    // 如果提供 candidateId，从数据库读取候选信息
    if (!cand && params.candidateId) {
      try {
        const candidateRepo = ctx.container.get('candidateRepository');
        const found = await candidateRepo.findById(params.candidateId);
        if (found) {
          const meta = found.metadata || {};
          cand = {
            title: meta.title || '',
            summary: meta.summary_cn || meta.summary || '',
            code: found.code || '',
            usageGuide: meta.usageGuide_cn || meta.usageGuide || '',
          };
        }
      } catch { /* ignore */ }
    }

    if (!cand) return { similar: [], message: 'No candidate provided' };

    const similar = findSimilarRecipes(projectRoot, cand, {
      threshold,
      topK: 10,
    });

    return {
      similar,
      hasDuplicate: similar.some(s => s.similarity >= 0.7),
      highestSimilarity: similar.length > 0 ? similar[0].similarity : 0,
      _meta: {
        confidence: similar.length === 0 ? 'none'
          : similar[0].similarity >= 0.7 ? 'high' : 'low',
        hint: similar.length === 0 ? '未发现相似 Recipe，可放心提交。'
          : similar[0].similarity >= 0.7 ? '发现高度相似 Recipe，建议人工审核是否重复。'
          : '有低相似度匹配，大概率不是重复。',
      },
    };
  },
};

// ────────────────────────────────────────────────────────────
// 11. discover_relations
// ────────────────────────────────────────────────────────────
const discoverRelations = {
  name: 'discover_relations',
  description: 'AI 知识图谱关系发现 — 分析 Recipe 对之间的潜在关系（requires/extends/enforces/calls 等），并自动写入知识图谱。',
  parameters: {
    type: 'object',
    properties: {
      recipePairs: {
        type: 'array',
        description: 'Recipe 对数组 [{ a: {id, title, category, code}, b: {id, title, category, code} }]',
      },
      dryRun: { type: 'boolean', description: '仅分析不写入，默认 false' },
    },
    required: ['recipePairs'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };

    const { recipePairs, dryRun = false } = params;
    if (!recipePairs || recipePairs.length === 0) return { relations: [] };

    // 构建 LLM prompt
    const pairsText = recipePairs.map((p, i) => `
--- Pair #${i + 1} ---
Recipe A [${p.a.id}]: ${p.a.title} (${p.a.category}/${p.a.language || ''})
${p.a.code ? `Code: ${p.a.code.substring(0, 300)}` : ''}

Recipe B [${p.b.id}]: ${p.b.title} (${p.b.category}/${p.b.language || ''})
${p.b.code ? `Code: ${p.b.code.substring(0, 300)}` : ''}`).join('\n');

    const prompt = `# Role
You are a Software Architect analyzing relationships between code recipes (knowledge units).

# Goal
For each Recipe pair below, determine if there is a meaningful relationship.

# Relationship Types
- requires: A needs B to function
- extends: A builds upon / enriches B
- enforces: A enforces rules defined in B
- depends_on: A depends on B
- inherits: A inherits from B (class/protocol)
- implements: A implements interface/protocol defined in B
- calls: A calls API defined in B
- prerequisite: B must be learned/applied before A
- none: No meaningful relationship

# Output
Return a JSON array. For each pair with a relationship (skip "none"):
{ "index": 0, "from_id": "...", "to_id": "...", "relation": "requires", "confidence": 0.85, "reason": "A uses the network client defined in B" }

Return ONLY a JSON array. No markdown, no extra text. Return [] if no relationships found.

# Recipe Pairs
${pairsText}`;

    const response = await ctx.aiProvider.chat(prompt, { temperature: 0.2 });
    const parsed = ctx.aiProvider.extractJSON(response, '[', ']');
    const relations = Array.isArray(parsed) ? parsed : [];

    // 写入知识图谱（除非 dryRun）
    if (!dryRun && relations.length > 0) {
      try {
        const kgService = ctx.container.get('knowledgeGraphService');
        for (const rel of relations) {
          if (rel.from_id && rel.to_id && rel.relation && rel.relation !== 'none') {
            kgService.addEdge(
              rel.from_id, 'recipe',
              rel.to_id, 'recipe',
              rel.relation,
              { confidence: rel.confidence || 0.5, reason: rel.reason || '', source: 'ai-discovery' },
            );
          }
        }
      } catch { /* KG not available */ }
    }

    return {
      analyzed: recipePairs.length,
      relations: relations.filter(r => r.relation !== 'none'),
      written: dryRun ? 0 : relations.filter(r => r.relation !== 'none').length,
    };
  },
};

// ────────────────────────────────────────────────────────────
// 12. add_graph_edge
// ────────────────────────────────────────────────────────────
const addGraphEdge = {
  name: 'add_graph_edge',
  description: '手动添加知识图谱关系边（从 A 到 B 的关系）。',
  parameters: {
    type: 'object',
    properties: {
      fromId:   { type: 'string', description: '源节点 ID' },
      fromType: { type: 'string', description: '源节点类型 (recipe/candidate)' },
      toId:     { type: 'string', description: '目标节点 ID' },
      toType:   { type: 'string', description: '目标节点类型 (recipe/candidate)' },
      relation: { type: 'string', description: '关系类型 (requires/extends/enforces/depends_on/inherits/implements/calls/prerequisite)' },
      weight:   { type: 'number', description: '权重 0-1，默认 1.0' },
    },
    required: ['fromId', 'fromType', 'toId', 'toType', 'relation'],
  },
  handler: async (params, ctx) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    return kgService.addEdge(
      params.fromId, params.fromType,
      params.toId, params.toType,
      params.relation,
      { weight: params.weight || 1.0, source: 'manual' },
    );
  },
};

// ════════════════════════════════════════════════════════════
//  NEW TOOLS (13-31)
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
// 7b. list_guard_rules
// ────────────────────────────────────────────────────────────
const listGuardRules = {
  name: 'list_guard_rules',
  description: '列出所有 Guard 规则（boundary-constraint 类型的 Recipe）。支持按语言/状态过滤。',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', description: '按语言过滤 (swift/objc 等)' },
      includeBuiltIn: { type: 'boolean', description: '是否包含内置规则，默认 true' },
      limit: { type: 'number', description: '返回数量上限，默认 50' },
    },
  },
  handler: async (params, ctx) => {
    const { language, includeBuiltIn = true, limit = 50 } = params;
    const results = [];

    // 数据库自定义规则
    try {
      const guardService = ctx.container.get('guardService');
      const dbRules = await guardService.listRules({}, { page: 1, pageSize: limit });
      results.push(...(dbRules.data || dbRules.items || []));
    } catch { /* not available */ }

    // 内置规则
    if (includeBuiltIn) {
      try {
        const guardCheckEngine = ctx.container.get('guardCheckEngine');
        const builtIn = guardCheckEngine.getRules(language || null)
          .filter(r => r.source === 'built-in');
        results.push(...builtIn);
      } catch { /* not available */ }
    }

    return { total: results.length, rules: results.slice(0, limit) };
  },
};

// ────────────────────────────────────────────────────────────
// 8b. get_recommendations
// ────────────────────────────────────────────────────────────
const getRecommendations = {
  name: 'get_recommendations',
  description: '获取推荐的 Recipe 列表（基于使用频率和质量排序）。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '返回数量，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    return recipeService.getRecommendations(params.limit || 10);
  },
};

// ────────────────────────────────────────────────────────────
// 12. ai_translate
// ────────────────────────────────────────────────────────────
const aiTranslate = {
  name: 'ai_translate',
  description: 'AI 翻译 — 将中文 summary/usageGuide 翻译为英文。',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '中文摘要' },
      usageGuide: { type: 'string', description: '中文使用指南' },
    },
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    const { summary, usageGuide } = params;
    if (!summary && !usageGuide) return { summary_en: '', usageGuide_en: '' };

    const systemPrompt = 'You are a technical translator. Translate from Chinese to English. Keep technical terms unchanged. Return ONLY valid JSON: { "summary_en": "...", "usageGuide_en": "..." }.';
    const parts = [];
    if (summary) parts.push(`summary: ${summary}`);
    if (usageGuide) parts.push(`usageGuide: ${usageGuide}`);

    const raw = await ctx.aiProvider.chat(parts.join('\n'), { systemPrompt, temperature: 0.2 });
    const parsed = ctx.aiProvider.extractJSON(raw, '{', '}');
    return parsed || { summary_en: summary || '', usageGuide_en: usageGuide || '' };
  },
};

// ────────────────────────────────────────────────────────────
// 13. guard_check_code
// ────────────────────────────────────────────────────────────
const guardCheckCode = {
  name: 'guard_check_code',
  description: '对代码运行 Guard 规则检查，返回违规列表（支持内置规则 + 数据库自定义规则）。',
  parameters: {
    type: 'object',
    properties: {
      code:     { type: 'string', description: '待检查的源代码' },
      language: { type: 'string', description: '编程语言 (swift/objc/javascript 等)' },
      scope:    { type: 'string', description: '检查范围 (file/target/project)，默认 file' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    const { code, language, scope = 'file' } = params;

    // 优先用 GuardCheckEngine（内置 + DB 规则）
    try {
      const engine = ctx.container.get('guardCheckEngine');
      const violations = engine.checkCode(code, language || 'unknown', { scope });
      // reasoning 已由 GuardCheckEngine.checkCode() 内置附加
      return { violationCount: violations.length, violations };
    } catch { /* not available */ }

    // 降级到 GuardService.checkCode（仅 DB 规则）
    try {
      const guardService = ctx.container.get('guardService');
      const matches = await guardService.checkCode(code, { language });
      return { violationCount: matches.length, violations: matches };
    } catch (err) {
      return { error: err.message };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 14. query_violations
// ────────────────────────────────────────────────────────────
const queryViolations = {
  name: 'query_violations',
  description: '查询 Guard 违规历史记录和统计。',
  parameters: {
    type: 'object',
    properties: {
      file:  { type: 'string', description: '按文件路径过滤' },
      limit: { type: 'number', description: '返回数量，默认 20' },
      statsOnly: { type: 'boolean', description: '仅返回统计数据，默认 false' },
    },
  },
  handler: async (params, ctx) => {
    const { file, limit = 20, statsOnly = false } = params;
    const store = ctx.container.get('violationsStore');

    if (statsOnly) {
      return store.getStats();
    }

    if (file) {
      return { runs: store.getRunsByFile(file) };
    }

    return store.list({}, { page: 1, limit });
  },
};

// ────────────────────────────────────────────────────────────
// 15. generate_guard_rule
// ────────────────────────────────────────────────────────────
const generateGuardRule = {
  name: 'generate_guard_rule',
  description: 'AI 生成 Guard 规则 — 描述你想阻止的代码模式，AI 自动生成正则表达式和规则定义。',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '规则描述（例如 "禁止在主线程使用同步网络请求"）' },
      language:    { type: 'string', description: '目标语言 (swift/objc 等)' },
      severity:    { type: 'string', description: '严重程度 (error/warning/info)，默认 warning' },
      autoCreate:  { type: 'boolean', description: '是否自动创建到数据库，默认 false' },
    },
    required: ['description'],
  },
  handler: async (params, ctx) => {
    if (!ctx.aiProvider) return { error: 'AI provider not available' };
    const { description, language = 'swift', severity = 'warning', autoCreate = false } = params;

    const prompt = `Generate a Guard rule for this requirement:
Description: ${description}
Language: ${language}
Severity: ${severity}

Return ONLY valid JSON:
{
  "name": "rule-name-kebab-case",
  "description": "One-line description in English",
  "description_cn": "一行中文描述",
  "pattern": "regex pattern for matching the problematic code",
  "languages": ["${language}"],
  "severity": "${severity}",
  "testCases": {
    "shouldMatch": ["code example that should trigger"],
    "shouldNotMatch": ["code example that should NOT trigger"]
  }
}`;

    const raw = await ctx.aiProvider.chat(prompt, { temperature: 0.2 });
    const rule = ctx.aiProvider.extractJSON(raw, '{', '}');
    if (!rule) return { error: 'Failed to parse AI response' };

    // 验证正则表达式
    try {
      new RegExp(rule.pattern);
    } catch (e) {
      return { error: `Invalid regex pattern: ${e.message}`, rule };
    }

    // 自动创建
    if (autoCreate && rule.name && rule.pattern) {
      try {
        const guardService = ctx.container.get('guardService');
        const created = await guardService.createRule({
          name: rule.name,
          description: rule.description || description,
          pattern: rule.pattern,
          languages: rule.languages || [language],
          severity: rule.severity || severity,
        }, { userId: 'agent' });
        return { rule, created: true, recipeId: created.id };
      } catch (err) {
        return { rule, created: false, error: err.message };
      }
    }

    return { rule, created: false };
  },
};

// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// Bootstrap 维度展示分组 — 将 9 个细粒度维度合并为 4 个展示组
// ────────────────────────────────────────────────────────────

const DIMENSION_DISPLAY_GROUP = {
  'architecture':        'architecture',        // → 架构与设计
  'code-pattern':        'architecture',        // → 架构与设计
  'project-profile':     'architecture',        // → 架构与设计
  'best-practice':       'best-practice',       // → 规范与实践
  'code-standard':       'best-practice',       // → 规范与实践
  'event-and-data-flow': 'event-and-data-flow', // → 事件与数据流
  'objc-deep-scan':      'objc-deep-scan',      // → 深度扫描
  'category-scan':       'objc-deep-scan',      // → 深度扫描
  'agent-guidelines':    'agent-guidelines',    // skill-only
};

// ────────────────────────────────────────────────────────────
// Bootstrap 维度类型校验 — submit_candidate / submit_with_check 共用
// 基于 dimensionMeta 类型标注系统，而非关键词模糊匹配
// ────────────────────────────────────────────────────────────

/**
 * 基于维度元数据 (dimensionMeta) 检查提交是否合法
 * @param {{ id: string, outputType: 'candidate'|'skill'|'dual', allowedKnowledgeTypes: string[] }} dimensionMeta
 * @param {object} params - submit_candidate 的参数
 * @param {object} [logger]
 * @returns {{ status: string, reason: string } | null} 不合法返回 rejected，合法返回 null
 */
function _checkDimensionType(dimensionMeta, params, logger) {
  // 1. Skill-only 维度不允许提交 Candidate
  if (dimensionMeta.outputType === 'skill') {
    logger?.info(`[submit_candidate] ✗ rejected — dimension "${dimensionMeta.id}" is skill-only, cannot submit candidates`);
    return {
      status: 'rejected',
      reason: `当前维度 "${dimensionMeta.id}" 的输出类型为 skill-only，不允许调用 submit_candidate。请只在最终回复中提供 dimensionDigest JSON。`,
    };
  }

  // 2. knowledgeType 校验 — 不在允许列表时自动修正为第一个允许类型
  const allowed = dimensionMeta.allowedKnowledgeTypes || [];
  if (allowed.length > 0 && params.knowledgeType) {
    if (!allowed.includes(params.knowledgeType)) {
      const corrected = allowed[0];
      logger?.warn(`[submit_candidate] knowledgeType "${params.knowledgeType}" → "${corrected}" (auto-corrected for dimension "${dimensionMeta.id}")`);
      params.knowledgeType = corrected;
    }
  }

  return null;
}

// 16. submit_candidate
// ────────────────────────────────────────────────────────────
const submitCandidate = {
  name: 'submit_candidate',
  description: '提交新的代码候选项到知识库审核队列。',
  parameters: {
    type: 'object',
    properties: {
      code:          { type: 'string', description: '代码内容（项目特写风格 Markdown: 描述和代码交织）' },
      language:      { type: 'string', description: '编程语言 (objectivec/swift/java/kotlin 等)' },
      category:      { type: 'string', description: '分类 (View/Service/Tool/Model/Network/Storage/UI/Utility/Core)' },
      title:         { type: 'string', description: '候选标题，如 "[Bootstrap] best-practice/单例模式"' },
      summary:       { type: 'string', description: '≤80字精准摘要，引用真实类名和数字' },
      tags:          { type: 'array', items: { type: 'string' }, description: '标签列表，如 ["bootstrap", "singleton"]' },
      knowledgeType: { type: 'string', description: '知识类型: best-practice / code-pattern / architecture / convention' },
      source:        { type: 'string', description: '来源 (bootstrap/agent/mcp)，默认 agent' },
      reasoning:     { type: 'object', description: '推理依据 { whyStandard: string, sources: string[], confidence: number }' },
      metadata:      { type: 'object', description: '其他元数据 (不常用，优先使用上面的顶层字段)' },
    },
    required: ['code', 'language', 'category', 'title'],
  },
  handler: async (params, ctx) => {
    const candidateService = ctx.container.get('candidateService');

    // ── Bootstrap 维度类型校验 (基于 dimensionMeta 类型标注) ──
    const dimMeta = ctx._dimensionMeta;
    if (dimMeta && ctx.source === 'system') {
      const rejected = _checkDimensionType(dimMeta, params, ctx.logger);
      if (rejected) return rejected;

      // 自动注入维度标签（确保可溯源）
      if (!params.tags) params.tags = [];
      if (!params.tags.includes(dimMeta.id)) params.tags.push(dimMeta.id);
      if (!params.tags.includes('bootstrap')) params.tags.push('bootstrap');

      // 自动补充 knowledgeType（AI 未填时用维度默认值）
      if (!params.knowledgeType && dimMeta.allowedKnowledgeTypes?.length > 0) {
        params.knowledgeType = dimMeta.allowedKnowledgeTypes[0];
      }

      // Bootstrap 模式: 将 category 覆盖为展示分组 ID，确保前端按合并后的分组展示
      // AI 可能填 "UI"/"Core" 等功能分类，但前端通过 BOOTSTRAP_DIM_LABELS 按展示分组分组
      params.category = DIMENSION_DISPLAY_GROUP[dimMeta.id] || dimMeta.id;

      // ── CandidateGuardrail 质量验证 (Bootstrap 模式) ──
      const guardrail = new CandidateGuardrail(
        ctx._submittedTitles || new Set(),
        dimMeta,
      );
      const guardResult = guardrail.validate(params);
      if (!guardResult.valid) {
        ctx.logger?.info(`[submit_candidate] ✗ guardrail rejected: ${guardResult.error}`);
        return {
          status: 'rejected',
          error: guardResult.error,
          hint: '请根据错误信息调整内容后重新提交。候选的 code 字段必须是「项目特写」风格，包含代码片段和项目上下文。',
        };
      }
    }

    // 将所有顶层字段展开到 item — LLM 可能把 title/summary/tags 等
    // 放在顶层而非 metadata 中（production prompt 指引）
    const { code, language, category, source, reasoning, metadata, ...rest } = params;

    // 防御性修复: AI 可能提交 reasoning.sources = [] 空数组，自动从 filePaths 补充
    const finalReasoning = reasoning || { whyStandard: 'Submitted via ChatAgent', sources: ['agent'], confidence: 0.7 };
    if (Array.isArray(finalReasoning.sources) && finalReasoning.sources.length === 0) {
      const fallbackSources = params.filePaths || rest.filePaths;
      if (Array.isArray(fallbackSources) && fallbackSources.length > 0) {
        finalReasoning.sources = fallbackSources;
      } else {
        finalReasoning.sources = ['agent'];
      }
    }

    const item = {
      code,
      language,
      category,
      ...rest,                     // 顶层扩展字段 (title, summary, knowledgeType, tags 等)
      ...metadata,                 // metadata 对象 (如有)
      reasoning: finalReasoning,
    };
    // Bootstrap 模式额外注入 targetName — 前端优先按 meta.targetName 分组
    const displayGroup = dimMeta ? (DIMENSION_DISPLAY_GROUP[dimMeta.id] || dimMeta.id) : null;
    const extraMeta = (dimMeta && ctx.source === 'system') ? { targetName: displayGroup } : {};
    return candidateService.createFromToolParams(item, source || 'agent', extraMeta, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 17. approve_candidate
// ────────────────────────────────────────────────────────────
const approveCandidate = {
  name: 'approve_candidate',
  description: '批准候选项（PENDING → APPROVED）。',
  parameters: {
    type: 'object',
    properties: {
      candidateId: { type: 'string', description: '候选 ID' },
    },
    required: ['candidateId'],
  },
  handler: async (params, ctx) => {
    const candidateService = ctx.container.get('candidateService');
    return candidateService.approveCandidate(params.candidateId, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 18. reject_candidate
// ────────────────────────────────────────────────────────────
const rejectCandidate = {
  name: 'reject_candidate',
  description: '驳回候选项并填写驳回理由。',
  parameters: {
    type: 'object',
    properties: {
      candidateId: { type: 'string', description: '候选 ID' },
      reason:      { type: 'string', description: '驳回理由' },
    },
    required: ['candidateId', 'reason'],
  },
  handler: async (params, ctx) => {
    const candidateService = ctx.container.get('candidateService');
    return candidateService.rejectCandidate(params.candidateId, params.reason, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 19. publish_recipe
// ────────────────────────────────────────────────────────────
const publishRecipe = {
  name: 'publish_recipe',
  description: '发布 Recipe（DRAFT → ACTIVE）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    return recipeService.publishRecipe(params.recipeId, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 20. deprecate_recipe
// ────────────────────────────────────────────────────────────
const deprecateRecipe = {
  name: 'deprecate_recipe',
  description: '弃用 Recipe 并填写弃用原因。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      reason:   { type: 'string', description: '弃用原因' },
    },
    required: ['recipeId', 'reason'],
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    return recipeService.deprecateRecipe(params.recipeId, params.reason, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 21. update_recipe
// ────────────────────────────────────────────────────────────
const updateRecipe = {
  name: 'update_recipe',
  description: '更新 Recipe 的指定字段（title/description/content/category/tags 等）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      updates:  { type: 'object', description: '要更新的字段和值' },
    },
    required: ['recipeId', 'updates'],
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    return recipeService.updateRecipe(params.recipeId, params.updates, { userId: 'agent' });
  },
};

// ────────────────────────────────────────────────────────────
// 22. record_usage
// ────────────────────────────────────────────────────────────
const recordUsage = {
  name: 'record_usage',
  description: '记录 Recipe 的使用（adoption 被采纳 / application 被应用）。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      type:     { type: 'string', description: 'adoption 或 application，默认 adoption' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const recipeService = ctx.container.get('recipeService');
    const type = params.type || 'adoption';
    await recipeService.incrementUsage(params.recipeId, type);
    return { success: true, recipeId: params.recipeId, type };
  },
};

// ────────────────────────────────────────────────────────────
// 23. quality_score
// ────────────────────────────────────────────────────────────
const qualityScore = {
  name: 'quality_score',
  description: 'Recipe 质量评分 — 5 维度综合评估（完整性/格式/代码质量/元数据/互动），返回分数和等级(A-F)。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID（从数据库读取后评分）' },
      recipe:   { type: 'object', description: '或直接提供 Recipe 对象 { title, trigger, code, language, ... }' },
    },
  },
  handler: async (params, ctx) => {
    const qualityScorer = ctx.container.get('qualityScorer');
    let recipe = params.recipe;

    if (!recipe && params.recipeId) {
      const recipeRepo = ctx.container.get('recipeRepository');
      recipe = await recipeRepo.findById(params.recipeId);
      if (!recipe) return { error: `Recipe '${params.recipeId}' not found` };
    }
    if (!recipe) return { error: 'Provide recipeId or recipe object' };

    return qualityScorer.score(recipe);
  },
};

// ────────────────────────────────────────────────────────────
// 24. validate_candidate
// ────────────────────────────────────────────────────────────
const validateCandidate = {
  name: 'validate_candidate',
  description: '候选校验 — 检查候选是否满足提交要求（必填字段/格式/质量），返回 errors 和 warnings。',
  parameters: {
    type: 'object',
    properties: {
      candidate: { type: 'object', description: '候选对象 { title, trigger, category, language, code, reasoning, ... }' },
    },
    required: ['candidate'],
  },
  handler: async (params, ctx) => {
    const validator = ctx.container.get('recipeCandidateValidator');
    return validator.validate(params.candidate);
  },
};

// ────────────────────────────────────────────────────────────
// 25. get_feedback_stats
// ────────────────────────────────────────────────────────────
const getFeedbackStats = {
  name: 'get_feedback_stats',
  description: '获取用户反馈统计 — 全局交互事件统计 + 热门 Recipe + 指定 Recipe 的详细反馈。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: '查询指定 Recipe 的反馈（可选）' },
      topN:     { type: 'number', description: '热门 Recipe 数量，默认 10' },
    },
  },
  handler: async (params, ctx) => {
    const feedbackCollector = ctx.container.get('feedbackCollector');
    const result = {};

    result.global = feedbackCollector.getGlobalStats();
    result.topRecipes = feedbackCollector.getTopRecipes(params.topN || 10);

    if (params.recipeId) {
      result.recipeStats = feedbackCollector.getRecipeStats(params.recipeId);
    }

    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 29. graph_impact_analysis
// ────────────────────────────────────────────────────────────
const graphImpactAnalysis = {
  name: 'graph_impact_analysis',
  description: '知识图谱影响范围分析 — 查找修改某个 Recipe 后可能受影响的所有下游依赖。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      maxDepth: { type: 'number', description: '最大深度，默认 3' },
    },
    required: ['recipeId'],
  },
  handler: async (params, ctx) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    const impacted = kgService.getImpactAnalysis(params.recipeId, 'recipe', params.maxDepth || 3);
    return { recipeId: params.recipeId, impactedCount: impacted.length, impacted };
  },
};

// ────────────────────────────────────────────────────────────
// 30. rebuild_index
// ────────────────────────────────────────────────────────────
const rebuildIndex = {
  name: 'rebuild_index',
  description: '向量索引重建 — 重新扫描 Recipe 文件并更新向量索引（用于索引过期或新增大量 Recipe 后）。',
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: '强制重建（跳过增量检测），默认 false' },
      dryRun: { type: 'boolean', description: '仅预览不实际写入，默认 false' },
    },
  },
  handler: async (params, ctx) => {
    const pipeline = ctx.container.get('indexingPipeline');
    return pipeline.run({ force: params.force || false, dryRun: params.dryRun || false });
  },
};

// ────────────────────────────────────────────────────────────
// 31. query_audit_log
// ────────────────────────────────────────────────────────────
const queryAuditLog = {
  name: 'query_audit_log',
  description: '审计日志查询 — 查看系统操作历史（谁在什么时间做了什么操作）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: '按操作类型过滤 (create_candidate/approve_candidate/create_guard_rule 等)' },
      actor:  { type: 'string', description: '按操作者过滤' },
      limit:  { type: 'number', description: '返回数量，默认 20' },
    },
  },
  handler: async (params, ctx) => {
    const auditLogger = ctx.container.get('auditLogger');
    const { action, actor, limit = 20 } = params;

    if (actor) return auditLogger.getByActor(actor, limit);
    if (action) return auditLogger.getByAction(action, limit);
    return auditLogger.getStats();
  },
};

// ────────────────────────────────────────────────────────────
// 32. load_skill — 按需加载 Agent Skill 文档
// ────────────────────────────────────────────────────────────
const loadSkill = {
  name: 'load_skill',
  description: '加载指定的 Agent Skill 文档，获取领域操作指南和最佳实践参考。可用于冷启动指南 (autosnippet-coldstart)、语言参考 (autosnippet-reference-swift/objc/jsts) 等。',
  parameters: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Skill 目录名（如 autosnippet-coldstart, autosnippet-reference-swift 等）' },
    },
    required: ['skillName'],
  },
  handler: async (params) => {
    // 项目级 Skills 优先（覆盖同名内置 Skill）
    const projectSkillPath = path.join(PROJECT_SKILLS_DIR, params.skillName, 'SKILL.md');
    const builtinSkillPath = path.join(SKILLS_DIR, params.skillName, 'SKILL.md');
    const skillPath = fs.existsSync(projectSkillPath) ? projectSkillPath : builtinSkillPath;
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const source = skillPath === projectSkillPath ? 'project' : 'builtin';
      return { skillName: params.skillName, source, content };
    } catch {
      const available = new Set();
      try { fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => available.add(d.name)); } catch {}
      try { fs.readdirSync(PROJECT_SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).forEach(d => available.add(d.name)); } catch {}
      return { error: `Skill "${params.skillName}" not found`, availableSkills: [...available] };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 33. create_skill — 创建项目级 Skill
// ────────────────────────────────────────────────────────────
const createSkillTool = {
  name: 'create_skill',
  description: '创建项目级 Skill 文档，写入 AutoSnippet/skills/<name>/SKILL.md。Skill 是 Agent 的领域知识增强文档。创建后自动更新编辑器索引。',
  parameters: {
    type: 'object',
    properties: {
      name:        { type: 'string', description: 'Skill 名称（kebab-case，如 my-auth-guide），3-64 字符' },
      description: { type: 'string', description: 'Skill 一句话描述（写入 frontmatter）' },
      content:     { type: 'string', description: 'Skill 正文内容（Markdown 格式，不含 frontmatter）' },
      overwrite:   { type: 'boolean', description: '如果同名 Skill 已存在，是否覆盖（默认 false）' },
    },
    required: ['name', 'description', 'content'],
  },
  handler: async (params, ctx) => {
    const { createSkill } = await import('../../external/mcp/handlers/skill.js');
    // 根据 ChatAgent 的 source 推断 createdBy
    const createdBy = ctx?.source === 'system' ? 'system-ai' : 'user-ai';
    const raw = createSkill(null, { ...params, createdBy });
    try { return JSON.parse(raw); } catch { return { success: false, error: raw }; }
  },
};

// ────────────────────────────────────────────────────────────
// 34. suggest_skills — 基于使用模式推荐 Skill 创建
// ────────────────────────────────────────────────────────────
const suggestSkills = {
  name: 'suggest_skills',
  description: '基于项目使用模式分析，推荐创建 Skill。分析 Guard 违规频率、Memory 偏好积累、Recipe 分布缺口、候选积压率。返回推荐列表（含 name/description/rationale/priority），可据此直接调用 create_skill 创建。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_params, ctx) => {
    const { SkillAdvisor } = await import('../../service/skills/SkillAdvisor.js');
    const database = ctx?.container?.get?.('database') || null;
    const projectRoot = ctx?.projectRoot || process.cwd();
    const advisor = new SkillAdvisor(projectRoot, { database });
    return advisor.suggest();
  },
};

// ────────────────────────────────────────────────────────────
// 34. bootstrap_knowledge — 冷启动知识库初始化
// ────────────────────────────────────────────────────────────
const bootstrapKnowledgeTool = {
  name: 'bootstrap_knowledge',
  description: '冷启动知识库初始化（纯启发式，不使用 AI）: SPM Target 扫描 → 依赖图谱 → Guard 审计 → 9 维度 Candidate 自动创建。支持 Skill 增强维度定义。产出为初稿候选，后续由 DAG pipeline 自动编排 AI 增强（enrich → refine）。',
  parameters: {
    type: 'object',
    properties: {
      maxFiles: { type: 'number', description: '最大扫描文件数，默认 500' },
      skipGuard: { type: 'boolean', description: '是否跳过 Guard 审计，默认 false' },
      contentMaxLines: { type: 'number', description: '每文件读取最大行数，默认 120' },
      loadSkills: { type: 'boolean', description: '是否加载 Skills 增强维度定义（推荐开启），默认 true' },
    },
  },
  handler: async (params, ctx) => {
    const { bootstrapKnowledge } = await import('../../external/mcp/handlers/bootstrap.js');
    const logger = Logger.getInstance();
    const result = await bootstrapKnowledge(
      { container: ctx.container, logger },
      {
        maxFiles: params.maxFiles || 500,
        skipGuard: params.skipGuard || false,
        contentMaxLines: params.contentMaxLines || 120,
        loadSkills: params.loadSkills ?? true,
      },
    );
    // bootstrapKnowledge 返回 envelope JSON string，解析提取 data
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return parsed?.data || parsed;
  },
};

// ────────────────────────────────────────────────────────────
// 导出全部工具
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// 34. analyze_code — 组合工具 (Guard + Recipe 搜索)
// ────────────────────────────────────────────────────────────
const analyzeCode = {
  name: 'analyze_code',
  description: '综合分析一段代码：Guard 规范检查 + 相关 Recipe 搜索。一次调用完成完整分析，减少多轮工具调用。',
  parameters: {
    type: 'object',
    properties: {
      code:     { type: 'string', description: '待分析的源码' },
      language: { type: 'string', description: '编程语言 (swift/objc/javascript 等)' },
      filePath: { type: 'string', description: '文件路径（可选，用于上下文）' },
    },
    required: ['code'],
  },
  handler: async (params, ctx) => {
    const { code, language, filePath } = params;
    const results = {};

    // 并行执行 Guard 检查 + Recipe 搜索
    const [guardResult, searchResult] = await Promise.all([
      (async () => {
        try {
          const engine = ctx.container.get('guardCheckEngine');
          const violations = engine.checkCode(code, language || 'unknown', { scope: 'file' });
          return { violationCount: violations.length, violations };
        } catch {
          try {
            const guardService = ctx.container.get('guardService');
            const matches = await guardService.checkCode(code, { language });
            return { violationCount: matches.length, violations: matches };
          } catch { return { violationCount: 0, violations: [] }; }
        }
      })(),
      (async () => {
        try {
          const searchEngine = ctx.container.get('searchEngine');
          // 取代码首段作为搜索词
          const query = code.substring(0, 200).replace(/\n/g, ' ');
          const rawResults = await searchEngine.search(query, { limit: 5 });
          return { results: rawResults || [], total: rawResults?.length || 0 };
        } catch { return { results: [], total: 0 }; }
      })(),
    ]);

    results.guard = guardResult;
    results.relatedRecipes = searchResult;
    results.filePath = filePath || '(inline)';

    const hasFindings = guardResult.violationCount > 0 || searchResult.total > 0;
    results._meta = {
      confidence: hasFindings ? 'high' : 'low',
      hint: hasFindings
        ? `已完成 Guard 检查（${guardResult.violationCount} 个违规）+ Recipe 搜索（${searchResult.total} 条匹配）。`
        : '未发现 Guard 违规，也未找到相关 Recipe。可能需要先冷启动知识库。',
    };

    return results;
  },
};

// ────────────────────────────────────────────────────────────
// 35. knowledge_overview — 组合工具 (一次获取全部类型的 Recipe 统计)
// ────────────────────────────────────────────────────────────
const knowledgeOverview = {
  name: 'knowledge_overview',
  description: '一次性获取知识库全貌：各类型 Recipe 分布 + 候选状态 + 知识图谱概况 + 质量概览。比分别调用 get_project_stats + search_recipes 更高效。',
  parameters: {
    type: 'object',
    properties: {
      includeTopRecipes: { type: 'boolean', description: '是否包含热门 Recipe 列表，默认 true' },
      limit: { type: 'number', description: '每类返回数量，默认 5' },
    },
  },
  handler: async (params, ctx) => {
    const { includeTopRecipes = true, limit = 5 } = params;
    const result = {};

    // 并行获取统计 + 可选的热门列表
    const [statsResult, feedbackResult] = await Promise.all([
      (async () => {
        try {
          const recipeService = ctx.container.get('recipeService');
          const candidateService = ctx.container.get('candidateService');
          const [rs, cs] = await Promise.all([
            recipeService.getRecipeStats(),
            candidateService.getCandidateStats(),
          ]);
          return { recipes: rs, candidates: cs };
        } catch { return null; }
      })(),
      (async () => {
        if (!includeTopRecipes) return null;
        try {
          const feedbackCollector = ctx.container.get('feedbackCollector');
          return feedbackCollector.getTopRecipes(limit);
        } catch { return null; }
      })(),
    ]);

    if (statsResult) {
      result.recipes = statsResult.recipes;
      result.candidates = statsResult.candidates;
    }

    // 知识图谱统计
    try {
      const kgService = ctx.container.get('knowledgeGraphService');
      result.knowledgeGraph = kgService.getStats();
    } catch { /* KG not available */ }

    if (feedbackResult) result.topRecipes = feedbackResult;

    const recipeCount = result.recipes?.total || result.recipes?.count || 0;
    result._meta = {
      confidence: recipeCount > 0 ? 'high' : 'none',
      hint: recipeCount === 0 ? '知识库为空，建议先执行冷启动（bootstrap_knowledge）。' : null,
    };

    return result;
  },
};

// ────────────────────────────────────────────────────────────
// 36. submit_with_check — 组合工具 (查重 + 提交)
// ────────────────────────────────────────────────────────────
const submitWithCheck = {
  name: 'submit_with_check',
  description: '安全提交候选：先执行查重检测，无重复则自动提交。如果发现高度相似 Recipe 则阻止并返回相似列表。一次调用完成 check_duplicate + submit_candidate。',
  parameters: {
    type: 'object',
    properties: {
      code:     { type: 'string', description: '代码内容' },
      language: { type: 'string', description: '编程语言' },
      category: { type: 'string', description: '分类 (View/Service/Tool/Model 等)' },
      title:    { type: 'string', description: '候选标题' },
      summary:  { type: 'string', description: '摘要' },
      threshold: { type: 'number', description: '相似度阈值，默认 0.7' },
    },
    required: ['code', 'language', 'category'],
  },
  handler: async (params, ctx) => {
    const { code, language, category, title, summary, threshold = 0.7 } = params;
    const projectRoot = ctx.projectRoot;

    // ── Bootstrap 维度类型校验 (与 submit_candidate 共用逻辑) ──
    const dimMeta = ctx._dimensionMeta;
    if (dimMeta && ctx.source === 'system') {
      const rejected = _checkDimensionType(dimMeta, params, ctx.logger);
      if (rejected) return rejected;

      // 自动注入维度标签
      if (!params.tags) params.tags = [];
      if (!params.tags.includes(dimMeta.id)) params.tags.push(dimMeta.id);
      if (!params.tags.includes('bootstrap')) params.tags.push('bootstrap');

      // 自动补充 knowledgeType（AI 未填时用维度默认值）
      if (!params.knowledgeType && dimMeta.allowedKnowledgeTypes?.length > 0) {
        params.knowledgeType = dimMeta.allowedKnowledgeTypes[0];
      }

      // 覆盖 category 为展示分组
      params.category = DIMENSION_DISPLAY_GROUP[dimMeta.id] || dimMeta.id;
    }

    // Step 1: 查重
    const cand = { title: title || '', summary: summary || '', code };
    const similar = findSimilarRecipes(projectRoot, cand, { threshold: 0.5, topK: 5 });
    const hasDuplicate = similar.some(s => s.similarity >= threshold);

    if (hasDuplicate) {
      return {
        submitted: false,
        reason: 'duplicate_blocked',
        similar,
        highestSimilarity: similar[0]?.similarity || 0,
        _meta: {
          confidence: 'high',
          hint: `发现高度相似 Recipe（相似度 ${(similar[0]?.similarity * 100).toFixed(0)}%），已阻止提交。请人工审核。`,
        },
      };
    }

    // Step 2: 提交
    try {
      const candidateService = ctx.container.get('candidateService');
      const { code: _c, language: _l, category: _cat, title: _t, summary: _s, threshold: _th, source: paramSource, reasoning: userReasoning, metadata, ...rest } = params;
      const item = {
        code,
        language,
        category,
        ...rest,                     // 顶层扩展字段 (title, summary, knowledgeType, tags 等)
        ...metadata,                 // metadata 对象 (如有)
        title: title || '',
        summary: summary || '',
        reasoning: userReasoning || { whyStandard: 'Submitted via submit_with_check', sources: ['agent'], confidence: 0.7 },
      };
      // Bootstrap 模式注入展示分组 targetName
      const swcDisplayGroup = dimMeta ? (DIMENSION_DISPLAY_GROUP[dimMeta.id] || dimMeta.id) : null;
      const swcExtraMeta = (dimMeta && ctx.source === 'system') ? { targetName: swcDisplayGroup } : {};
      const created = await candidateService.createFromToolParams(item, paramSource || 'agent', swcExtraMeta, { userId: 'agent' });

      return {
        submitted: true,
        candidate: created,
        similar: similar.length > 0 ? similar : [],
        _meta: {
          confidence: 'high',
          hint: similar.length > 0
            ? `已提交，但有 ${similar.length} 个低相似度匹配，大概率不是重复。`
            : '已提交，无重复风险。',
        },
      };
    } catch (err) {
      return { submitted: false, reason: 'submit_error', error: err.message };
    }
  },
};

// ═══════════════════════════════════════════════════════
//  元工具: Lazy Tool Schema 按需加载
// ═══════════════════════════════════════════════════════

/**
 * get_tool_details — 查询工具的完整参数 schema
 *
 * 与 Cline .clinerules 按需加载类似:
 * System Prompt 只包含工具名+一行描述，LLM 需要调用某个工具前
 * 先通过此元工具获取完整参数定义，避免 prompt 过长浪费 token。
 */
const getToolDetails = {
  name: 'get_tool_details',
  description: '查询指定工具的完整参数 Schema。在调用不熟悉的工具之前，先用此工具获取参数详情。',
  parameters: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: '要查询的工具名称（snake_case）',
      },
    },
    required: ['toolName'],
  },
  handler: async ({ toolName }, context) => {
    const registry = context.container?.get('toolRegistry');
    if (!registry) return { error: 'ToolRegistry not available' };

    const schemas = registry.getToolSchemas();
    const found = schemas.find(t => t.name === toolName);
    if (!found) {
      const allNames = schemas.map(t => t.name);
      return {
        error: `Tool "${toolName}" not found`,
        availableTools: allNames,
      };
    }

    return {
      name: found.name,
      description: found.description,
      parameters: found.parameters,
    };
  },
};

// ─── 元工具: 任务规划 ───────────────────────────────────
const planTask = {
  name: 'plan_task',
  description: '分析当前任务并制定结构化执行计划。在开始复杂任务前调用此工具可提高执行效率和决策质量。输出将记录到日志供审计,但不会改变实际执行流程。',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: '执行步骤列表',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '步骤序号' },
            action: { type: 'string', description: '具体动作描述' },
            tool: { type: 'string', description: '计划使用的工具名' },
            depends_on: { type: 'array', items: { type: 'number' }, description: '依赖的步骤 ID' },
          },
          required: ['id', 'action'],
        },
      },
      strategy: {
        type: 'string',
        description: '执行策略说明(如: 先搜索补充示例再批量提交)',
      },
      estimated_iterations: {
        type: 'number',
        description: '预估需要的迭代轮数',
      },
    },
    required: ['steps', 'strategy'],
  },
  handler: async (params, context) => {
    const plan = {
      steps: params.steps || [],
      strategy: params.strategy || '',
      estimatedIterations: params.estimated_iterations || params.steps?.length || 1,
    };
    context.logger?.info('[plan_task] execution plan', plan);
    return {
      status: 'plan_recorded',
      stepCount: plan.steps.length,
      strategy: plan.strategy,
      message: `执行计划已记录 (${plan.steps.length} 步, 预估 ${plan.estimatedIterations} 轮迭代)。开始按计划执行。`,
    };
  },
};

// ─── 元工具: 自我质量审查 ───────────────────────────────
const reviewMyOutput = {
  name: 'review_my_output',
  description: '回查本次会话中已提交的候选,检查质量红线是否满足。包括: 项目特写风格、summary 泛化措辞、代码示例来源标注等。返回通过/问题列表。建议在提交完所有候选后调用一次进行自检。',
  parameters: {
    type: 'object',
    properties: {
      check_rules: {
        type: 'array',
        description: '要检查的质量规则(可选, 默认检查全部)',
        items: { type: 'string' },
      },
    },
  },
  handler: async (params, context) => {
    const submitted = (context._sessionToolCalls || []).filter(
      tc => tc.tool === 'submit_candidate' || tc.tool === 'submit_with_check',
    );

    if (submitted.length === 0) {
      return { status: 'no_candidates', message: '本次会话尚未提交任何候选。' };
    }

    const issues = [];
    const checked = [];

    for (const tc of submitted) {
      const p = tc.params || {};
      const code = p.code || '';
      const title = p.title || '';
      const summary = p.summary || '';
      const candidateIssues = [];

      // 检查 1: 项目特写后缀
      if (!title.includes('— 项目特写') && !code.includes('— 项目特写')) {
        candidateIssues.push('缺少 "— 项目特写" 后缀');
      }

      // 检查 2: 项目特写融合叙事质量 — 必须同时包含代码和描述性文字
      const hasCodeBlock = /```[\s\S]*?```/.test(code);
      if (!hasCodeBlock) {
        candidateIssues.push('特写缺少代码示例，应包含基本用法代码');
      }
      // 去掉代码块后，剩余描述性文字应足够
      const proseLength = code.replace(/```[\s\S]*?```/g, '').replace(/[#>\-*`\n]/g, '').trim().length;
      if (proseLength < 50) {
        candidateIssues.push('特写缺少项目特点描述，应融合基本用法和项目特点');
      }

      // 检查 3: summary 泛化措辞
      if (/本模块|该文件|这个类|该项目/.test(summary)) {
        candidateIssues.push('summary 使用了泛化措辞,应引用具体类名和数字');
      }

      // 检查 4: summary 过短
      if (summary.length < 15) {
        candidateIssues.push(`summary 过短 (${summary.length} 字), 应≥15字并包含具体类名和数字`);
      }

      // 检查 5: code 过短（可能是空壳）
      if (code.length < 200) {
        candidateIssues.push(`code 文档过短 (${code.length} 字), 可能缺少实质内容`);
      }

      // 检查 6: 代码示例来源
      const hasSourceAnnotation = /\([^)]*\.\w+[^)]*:\d+\)|\([^)]*\.\w+[^)]*\)/.test(code);
      if (hasCodeBlock && !hasSourceAnnotation) {
        candidateIssues.push('代码示例可能缺少来源文件标注 (建议标注 "来源: FileName.m:行号")');
      }

      if (candidateIssues.length > 0) {
        issues.push({ title, issues: candidateIssues });
      }
      checked.push({ title, passed: candidateIssues.length === 0, issueCount: candidateIssues.length });
    }

    if (issues.length === 0) {
      return {
        status: 'all_passed',
        checkedCount: submitted.length,
        message: `✅ ${submitted.length} 条候选全部通过质量检查。`,
      };
    }

    const issueLines = issues.flatMap(({ title, issues: iss }) =>
      iss.map(i => `• "${title}": ${i}`),
    );

    return {
      status: 'issues_found',
      checkedCount: submitted.length,
      passedCount: submitted.length - issues.length,
      failedCount: issues.length,
      details: checked,
      message: `⚠️ ${issues.length}/${submitted.length} 条候选存在质量问题:\n${issueLines.join('\n')}\n\n请修正后重新提交。`,
    };
  },
};

// ════════════════════════════════════════════════════════════
// AST 结构化分析 (7) — v3.0 AI-First Bootstrap AST 工具
// ════════════════════════════════════════════════════════════

/**
 * 辅助: 安全获取 ProjectGraph 实例
 * @param {object} ctx
 * @returns {import('../../core/ast/ProjectGraph.js').default|null}
 */
function _getProjectGraph(ctx) {
  try {
    return ctx.container?.get('projectGraph') || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 44. get_project_overview — 项目 AST 概览
// ────────────────────────────────────────────────────────────
const getProjectOverview = {
  name: 'get_project_overview',
  description: '获取项目的整体结构概览：文件统计、模块列表、入口点、类/协议/Category 数量。' +
    '适用场景：了解项目规模和架构布局，规划探索路径。',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。请检查 tree-sitter 是否已安装。';

    const o = graph.getOverview();
    const lines = [
      `📊 项目 AST 概览 (构建耗时 ${o.buildTimeMs}ms)`,
      ``,
      `文件: ${o.totalFiles} | 类: ${o.totalClasses} | 协议: ${o.totalProtocols} | Category: ${o.totalCategories} | 方法: ${o.totalMethods}`,
      ``,
      `── 模块 ──`,
    ];
    for (const mod of o.topLevelModules) {
      const count = o.classesPerModule[mod] || 0;
      lines.push(`  ${mod}/ — ${count} 个类`);
    }
    if (o.entryPoints.length > 0) {
      lines.push(``, `── 入口点 ──`);
      for (const ep of o.entryPoints) {
        lines.push(`  ${ep}`);
      }
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 45. get_class_hierarchy — 类继承层级
// ────────────────────────────────────────────────────────────
const getClassHierarchy = {
  name: 'get_class_hierarchy',
  description: '查看指定类的继承链（向上到根类）和直接子类列表。' +
    '传入 className 查看指定类，不传则返回项目中所有根类及其子树。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '类名 (可选, 不填则返回完整层级)' },
    },
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。';

    const className = params.className || params.class_name;
    if (className) {
      const chain = graph.getInheritanceChain(className);
      const subs = graph.getSubclasses(className);
      if (chain.length === 0) return `未找到类 ${className}`;

      const lines = [
        `🔗 ${className} 继承链:`,
        `  ${chain.join(' → ')}`,
      ];
      if (subs.length > 0) {
        lines.push(``, `直接子类 (${subs.length}):`);
        for (const s of subs) lines.push(`  ├── ${s}`);
      }
      return lines.join('\n');
    }

    // 全量: 找出所有根类 (没有父类或父类不在项目中的类)
    const allClasses = graph.getAllClassNames();
    const roots = allClasses.filter(c => {
      const chain = graph.getInheritanceChain(c);
      return chain.length <= 1 || !allClasses.includes(chain[1]);
    });

    const lines = [`🌳 项目类层级 (${allClasses.length} 个类, ${roots.length} 棵树)`];
    for (const root of roots.slice(0, 30)) {
      const descendants = graph.getAllDescendants(root);
      lines.push(`  ${root} (${descendants.length} 个后代)`);
      for (const d of descendants.slice(0, 5)) {
        lines.push(`    └── ${d}`);
      }
      if (descendants.length > 5) lines.push(`    ... 还有 ${descendants.length - 5} 个`);
    }
    if (roots.length > 30) lines.push(`... 还有 ${roots.length - 30} 棵树`);
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 46. get_class_info — 类详细信息
// ────────────────────────────────────────────────────────────
const getClassInfo = {
  name: 'get_class_info',
  description: '获取指定类的详细信息: 属性、方法签名、导入、继承关系、Category 扩展。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '类名 (必填)' },
    },
    required: ['className'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。';

    const className = params.className || params.class_name;
    const info = graph.getClassInfo(className);
    if (!info) return `未找到类 "${className}"。可以使用 get_project_overview 查看项目中的所有类。`;

    const chain = graph.getInheritanceChain(className);
    const cats = graph.getCategoryExtensions(className);
    const subs = graph.getSubclasses(className);

    const lines = [
      `📦 ${info.name}`,
      `文件: ${info.filePath}:${info.line}`,
      `继承: ${chain.join(' → ')}`,
    ];

    if (info.protocols.length > 0) {
      lines.push(`遵循: <${info.protocols.join(', ')}>`);
    }

    if (info.properties.length > 0) {
      lines.push(``, `── 属性 (${info.properties.length}) ──`);
      for (const p of info.properties) {
        const attrs = p.attributes.length > 0 ? ` (${p.attributes.join(', ')})` : '';
        lines.push(`  ${p.name}: ${p.type}${attrs}`);
      }
    }

    if (info.methods.length > 0) {
      lines.push(``, `── 方法 (${info.methods.length}) ──`);
      const classMethods = info.methods.filter(m => m.isClassMethod);
      const instanceMethods = info.methods.filter(m => !m.isClassMethod);
      for (const m of classMethods) {
        const cx = m.complexity > 3 ? ` [复杂度:${m.complexity}]` : '';
        lines.push(`  + ${m.selector} → ${m.returnType}${cx}`);
      }
      for (const m of instanceMethods) {
        const cx = m.complexity > 3 ? ` [复杂度:${m.complexity}]` : '';
        lines.push(`  - ${m.selector} → ${m.returnType}${cx}`);
      }
    }

    if (cats.length > 0) {
      lines.push(``, `── Category 扩展 (${cats.length}) ──`);
      for (const cat of cats) {
        const methodNames = cat.methods.map(m => m.selector).join(', ');
        lines.push(`  ${info.name}(${cat.categoryName}) — ${cat.filePath} — [${methodNames}]`);
      }
    }

    if (subs.length > 0) {
      lines.push(``, `── 直接子类 (${subs.length}) ──`);
      for (const s of subs) lines.push(`  ${s}`);
    }

    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 47. get_protocol_info — 协议详细信息
// ────────────────────────────────────────────────────────────
const getProtocolInfo = {
  name: 'get_protocol_info',
  description: '获取指定协议的定义（必选/可选方法）及所有遵循该协议的类。',
  parameters: {
    type: 'object',
    properties: {
      protocolName: { type: 'string', description: '协议名 (必填)' },
    },
    required: ['protocolName'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。';

    const protocolName = params.protocolName || params.protocol_name;
    const info = graph.getProtocolInfo(protocolName);
    if (!info) return `未找到协议 "${protocolName}"。可以使用 get_project_overview 查看项目中的所有协议。`;

    const lines = [
      `📋 @protocol ${info.name}`,
      `文件: ${info.filePath}:${info.line}`,
    ];

    if (info.inherits.length > 0) {
      lines.push(`继承: <${info.inherits.join(', ')}>`);
    }

    if (info.requiredMethods.length > 0) {
      lines.push(``, `── @required (${info.requiredMethods.length}) ──`);
      for (const m of info.requiredMethods) {
        lines.push(`  ${m.isClassMethod ? '+' : '-'} ${m.selector} → ${m.returnType}`);
      }
    }

    if (info.optionalMethods.length > 0) {
      lines.push(``, `── @optional (${info.optionalMethods.length}) ──`);
      for (const m of info.optionalMethods) {
        lines.push(`  ${m.isClassMethod ? '+' : '-'} ${m.selector} → ${m.returnType}`);
      }
    }

    if (info.conformers.length > 0) {
      lines.push(``, `── 遵循者 (${info.conformers.length}) ──`);
      for (const c of info.conformers) lines.push(`  ${c}`);
    } else {
      lines.push(``, `⚠️ 暂未发现遵循此协议的类`);
    }

    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 48. get_method_overrides — 方法覆写查询
// ────────────────────────────────────────────────────────────
const getMethodOverrides = {
  name: 'get_method_overrides',
  description: '查找覆写了指定方法的所有子类。适用于理解方法在继承树中的多态行为。',
  parameters: {
    type: 'object',
    properties: {
      className:  { type: 'string', description: '定义该方法的基类名 (必填)' },
      methodName: { type: 'string', description: '方法名或 selector (必填)' },
    },
    required: ['className', 'methodName'],
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。';

    const className = params.className || params.class_name;
    const methodName = params.methodName || params.method_name;
    const overrides = graph.getMethodOverrides(className, methodName);

    if (overrides.length === 0) {
      return `"${className}.${methodName}" 没有在任何子类中被覆写。`;
    }

    const lines = [
      `🔀 ${className}.${methodName} 的覆写 (${overrides.length} 处):`,
    ];
    for (const o of overrides) {
      const cx = o.method.complexity > 3 ? ` [复杂度:${o.method.complexity}]` : '';
      lines.push(`  ${o.className} — ${o.filePath}:${o.method.line}${cx}`);
    }
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 49. get_category_map — Category 扩展映射
// ────────────────────────────────────────────────────────────
const getCategoryMap = {
  name: 'get_category_map',
  description: '获取指定类或整个项目的 ObjC Category 扩展映射。Category 是 ObjC 的核心模式，了解它有助于发现功能划分。',
  parameters: {
    type: 'object',
    properties: {
      className: { type: 'string', description: '类名 — 可选, 不填则返回整个项目中有 Category 的类列表' },
    },
  },
  handler: async (params, ctx) => {
    const graph = _getProjectGraph(ctx);
    if (!graph) return 'AST 分析不可用 — ProjectGraph 未构建。';

    const className = params.className || params.class_name;
    if (className) {
      const cats = graph.getCategoryExtensions(className);
      if (cats.length === 0) return `"${className}" 没有 Category 扩展。`;

      const lines = [`📂 ${className} 的 Category 扩展 (${cats.length}):`];
      for (const cat of cats) {
        lines.push(`  ${className}(${cat.categoryName}) — ${cat.filePath}:${cat.line}`);
        for (const m of cat.methods) {
          lines.push(`    ${m.isClassMethod ? '+' : '-'} ${m.selector}`);
        }
        if (cat.protocols.length > 0) {
          lines.push(`    遵循: <${cat.protocols.join(', ')}>`);
        }
      }
      return lines.join('\n');
    }

    // 全量概览
    const allClasses = graph.getAllClassNames();
    const withCats = allClasses
      .map(c => ({ name: c, cats: graph.getCategoryExtensions(c) }))
      .filter(x => x.cats.length > 0)
      .sort((a, b) => b.cats.length - a.cats.length);

    if (withCats.length === 0) return '项目中没有发现 Category 扩展。';

    const lines = [`📂 项目 Category 概览 (${withCats.length} 个类有 Category):`];
    for (const { name, cats } of withCats.slice(0, 30)) {
      const catNames = cats.map(c => c.categoryName).join(', ');
      lines.push(`  ${name} — ${cats.length} 个: (${catNames})`);
    }
    if (withCats.length > 30) lines.push(`... 还有 ${withCats.length - 30} 个类`);
    return lines.join('\n');
  },
};

// ────────────────────────────────────────────────────────────
// 50. get_previous_analysis — 前序维度分析结果 (可选)
// ────────────────────────────────────────────────────────────
const getPreviousAnalysis = {
  name: 'get_previous_analysis',
  description: '获取前序维度的分析摘要。在 bootstrap 中，每个维度可能有前面维度的分析结果可用。' +
    '调用此工具可以获取之前维度产出的候选标题、设计决策等上下文，避免重复分析。' +
    '注意: 只有在你认为前序上下文对当前任务有帮助时才调用。',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, ctx) => {
    // 从 ctx._dimensionMeta 读取前序分析
    const meta = ctx._dimensionMeta;
    if (!meta || !meta.previousAnalysis) {
      return '没有前序维度的分析结果可用。';
    }

    const prev = meta.previousAnalysis;
    if (typeof prev === 'string') return prev;

    // 格式化前序分析
    const lines = ['📋 前序维度分析摘要:'];
    if (Array.isArray(prev)) {
      for (const item of prev) {
        if (typeof item === 'string') {
          lines.push(`  ${item}`);
        } else if (item.dimension && item.summary) {
          lines.push(``, `── ${item.dimension} ──`);
          lines.push(`  ${item.summary}`);
          if (item.candidateTitles?.length > 0) {
            lines.push(`  已提交候选: ${item.candidateTitles.join(', ')}`);
          }
        }
      }
    } else if (typeof prev === 'object') {
      for (const [key, value] of Object.entries(prev)) {
        lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }
    return lines.join('\n');
  },
};

export const ALL_TOOLS = [
  // 项目数据访问 (5) — 含 v10 Agent-Pull 工具
  searchProjectCode,
  readProjectFile,
  listProjectStructure,
  getFileSummary,
  semanticSearchCode,
  // 查询类 (8)
  searchRecipes,
  searchCandidates,
  getRecipeDetail,
  getProjectStats,
  searchKnowledge,
  getRelatedRecipes,
  listGuardRules,
  getRecommendations,
  // AI 分析类 (5)
  summarizeCode,
  extractRecipes,
  enrichCandidate,
  refineBootstrapCandidates,
  aiTranslate,
  // Guard 安全类 (3)
  guardCheckCode,
  queryViolations,
  generateGuardRule,
  // 生命周期操作类 (7)
  submitCandidate,
  approveCandidate,
  rejectCandidate,
  publishRecipe,
  deprecateRecipe,
  updateRecipe,
  recordUsage,
  // 质量与反馈类 (3)
  qualityScore,
  validateCandidate,
  getFeedbackStats,
  // 知识图谱类 (3)
  checkDuplicate,
  discoverRelations,
  addGraphEdge,
  // 基础设施类 (3)
  graphImpactAnalysis,
  rebuildIndex,
  queryAuditLog,
  // Skills & Bootstrap (4)
  loadSkill,
  createSkillTool,
  suggestSkills,
  bootstrapKnowledgeTool,
  // 组合工具 (3) — 减少 ReAct 轮次
  analyzeCode,
  knowledgeOverview,
  submitWithCheck,
  // 元工具 (3) — Agent 自主能力增强
  getToolDetails,
  planTask,
  reviewMyOutput,
  // AST 结构化分析 (7) — v3.0 AI-First Bootstrap
  getProjectOverview,
  getClassHierarchy,
  getClassInfo,
  getProtocolInfo,
  getMethodOverrides,
  getCategoryMap,
  getPreviousAnalysis,
];

export default ALL_TOOLS;
