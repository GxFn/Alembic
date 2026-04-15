/**
 * MCP Handlers — Cursor-Native Wiki 生成
 *
 *   - wikiPlan:     数据收集 + 主题发现 → 返回写作规划
 *   - wikiFinalize: Agent 写完所有文章后调用 → meta.json + 去重 + 验证
 *
 * 设计理念:
 *   现有 WikiGenerator 的核心价值在于 **数据收集 + 主题发现**（AST、模块图、知识库）。
 *   文章撰写由外部 Agent 完成（200K+ context），Alembic 只做规划和元数据。
 *   bootstrap Phase 1-4 的分析缓存可被 wikiPlan 复用，避免重复计算。
 *
 * @module handlers/wiki-external
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import { WikiGenerator } from '#service/wiki/WikiGenerator.js';
import { dedup } from '#service/wiki/WikiUtils.js';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '#shared/ProjectMarkers.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { envelope } from '../envelope.js';
import { getActiveSession } from './bootstrap-external.js';
import type { McpContext, McpServiceContainer } from './types.js';

const logger = Logger.getInstance();

// ── 本地类型定义 ─────────────────────────────────────────

/** Wiki 主题描述符 */
interface WikiTopicDef {
  id: string;
  path: string;
  title: string;
  type: string;
  priority: number;
  _moduleData?: Record<string, unknown>;
  _patternData?: { category?: string; recipes?: Record<string, unknown>[]; [key: string]: unknown };
  _folderProfiles?: Record<string, unknown>[];
  _folderProfile?: Record<string, unknown>;
  [key: string]: unknown;
}

/** wikiPlan 参数 */
interface WikiPlanArgs {
  language?: 'zh' | 'en';
  sessionId?: string;
  [key: string]: unknown;
}

/** wikiFinalize 参数 */
interface WikiFinalizeArgs {
  articlesWritten?: string[];
  [key: string]: unknown;
}

/** 文件详情 */
interface WikiFileDetail {
  path: string;
  size: number;
  hash: string;
}

/** 结构化数据集 (wikiPlan 内部数据) */
interface StructuredData {
  projectInfo: Record<string, unknown>;
  astInfo: Record<string, unknown>;
  moduleInfo: Record<string, unknown>;
  knowledgeInfo: { recipes: Record<string, unknown>[]; stats: Record<string, unknown> | null };
}

/** 缓存数据中的 AST 摘要 */
interface CachedAstSummary {
  classes?: { name: string; targetName?: string }[];
  protocols?: { name: string; targetName?: string }[];
  projectMetrics?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 缓存的文件条目 */
interface CachedFileEntry {
  targetName?: string;
  relativePath: string;
  [key: string]: unknown;
}

/** 知识服务最小接口 */
interface KnowledgeServiceLike {
  list(
    filter: Record<string, unknown>
  ): Promise<{ items?: Record<string, unknown>[]; [key: string]: unknown }>;
  getStats?(): Promise<Record<string, unknown> | null>;
}

// ── 辅助：安全获取容器服务 ──────────────────────────────────

function tryGet(container: McpServiceContainer, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  wikiRouter — 统一入口 (asd_wiki)
// ════════════════════════════════════════════════════════════

/**
 * 统一 Wiki 路由入口 (asd_wiki)
 *
 * @param args.operation 'plan' | 'finalize'
 */
export async function wikiRouter(ctx: McpContext, args: Record<string, unknown>) {
  const op = args.operation as string;
  if (op === 'finalize') {
    return wikiFinalize(ctx, args as unknown as WikiFinalizeArgs);
  }
  return wikiPlan(ctx, args as unknown as WikiPlanArgs);
}

// ════════════════════════════════════════════════════════════
//  wikiPlan — 规划 Wiki 主题 + 数据包
// ════════════════════════════════════════════════════════════

/**
 * 规划 Wiki 文档生成 (asd_wiki operation=plan)
 *
 * 复用 WikiGenerator 的数据收集和主题发现逻辑（Phase 1-5），
 * 但不撰写文章，只返回规划清单和每个主题的数据包。
 *
 * @param ctx { container, logger, startedAt }
 * @param args { language?: 'zh'|'en', sessionId?: string }
 */
export async function wikiPlan(ctx: McpContext, args: WikiPlanArgs) {
  const t0 = Date.now();
  const language = args.language || 'zh';
  const container = ctx.container;
  const projectRoot = resolveProjectRoot(container);

  // ── 优先复用 bootstrap 已有的分析缓存 ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getActiveSession accepts ServiceContainer, container is McpServiceContainer
  let projectInfo: Record<string, unknown> | undefined,
    astInfo: Record<string, unknown> | undefined,
    moduleInfo: Record<string, unknown> | undefined,
    knowledgeInfo:
      | { recipes: Record<string, unknown>[]; stats: Record<string, unknown> | null }
      | undefined;
  let cacheHit = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- McpServiceContainer is compatible at runtime
  const session = getActiveSession(container as never, args.sessionId);
  const cachedData = session?.snapshotCache;

  if (cachedData?.astProjectSummary) {
    // Bootstrap phase cache → WikiGenerator-compatible format 转换
    const allFiles = cachedData.allFiles;
    const ast = cachedData.astProjectSummary;

    // projectInfo: 从 bootstrap 文件列表和语言统计构建
    const filesByModule: Record<string, string[]> = {};
    for (const f of allFiles) {
      const mod = f.targetName || '_default';
      if (!filesByModule[mod]) {
        filesByModule[mod] = [];
      }
      filesByModule[mod].push(f.relativePath);
    }
    projectInfo = {
      name: path.basename(projectRoot),
      root: projectRoot,
      sourceFiles: allFiles.map((f) => f.relativePath),
      languages: cachedData.langStats || {},
      primaryLanguage: cachedData.primaryLang || 'unknown',
      sourceFilesByModule: filesByModule,
      buildSystems: [],
    };

    // astInfo: 从 AstAnalyzer 结果构建
    const classesByModule: Record<string, string[]> = {};
    const protocolsByModule: Record<string, string[]> = {};
    for (const cls of ast.classes || []) {
      const mod = cls.targetName || '_default';
      if (!classesByModule[mod]) {
        classesByModule[mod] = [];
      }
      classesByModule[mod].push(cls.name);
    }
    for (const p of ast.protocols || []) {
      const mod = p.targetName || '_default';
      if (!protocolsByModule[mod]) {
        protocolsByModule[mod] = [];
      }
      protocolsByModule[mod].push(p.name);
    }
    astInfo = {
      classes: (ast.classes || []).map((c) => c.name),
      protocols: (ast.protocols || []).map((p) => p.name),
      overview: ast.projectMetrics || null,
      classNamesByModule: classesByModule,
      protocolNamesByModule: protocolsByModule,
    };

    // moduleInfo: 从依赖图和 targets 构建
    moduleInfo = {
      targets: (cachedData.targetsSummary || []).map((t) => ({
        name: t.name,
        type: t.type,
        fileCount: t.fileCount,
      })),
      depGraph: cachedData.depGraphData || null,
    };

    // knowledgeInfo: 始终从 DB 获取最新（bootstrap 期间可能已写入知识）
    try {
      const ks = tryGet(container, 'knowledgeService') as KnowledgeServiceLike | null;
      if (ks) {
        const items = await ks.list({ limit: 200 });
        const stats = typeof ks.getStats === 'function' ? await ks.getStats() : null;
        knowledgeInfo = { recipes: (items?.items || []) as Record<string, unknown>[], stats };
      } else {
        knowledgeInfo = { recipes: [], stats: null };
      }
    } catch {
      knowledgeInfo = { recipes: [], stats: null };
    }

    cacheHit = true;
    logger.info('[wiki-plan] Reusing bootstrap phase cache (converted to WikiGenerator format)');
  } else {
    // 无缓存（独立调用 wiki_plan 或进程已重启）→ 重新扫描
    logger.info('[wiki-plan] No bootstrap cache, running fresh scan...');
    const generator = new WikiGenerator({
      projectRoot,
      moduleService: tryGet(container, 'moduleService') as WikiGenerator['moduleService'],
      knowledgeService: tryGet(container, 'knowledgeService') as WikiGenerator['knowledgeService'],
      projectGraph: tryGet(container, 'projectGraph') as WikiGenerator['projectGraph'],
      codeEntityGraph: tryGet(container, 'codeEntityGraph') as WikiGenerator['codeEntityGraph'],
      aiProvider: null, // 不需要 AI — 只做规划
      options: { language },
    });

    projectInfo = await generator._scanProject();
    astInfo = await generator._analyzeAST();
    moduleInfo = await generator._parseModules();
    knowledgeInfo = await generator._integrateKnowledge();
  }

  // ── 主题发现（复用 WikiGenerator._discoverTopics） ──
  const generator = new WikiGenerator({
    projectRoot,
    moduleService: tryGet(container, 'moduleService') as WikiGenerator['moduleService'],
    knowledgeService: tryGet(container, 'knowledgeService') as WikiGenerator['knowledgeService'],
    projectGraph: tryGet(container, 'projectGraph') as WikiGenerator['projectGraph'],
    codeEntityGraph: tryGet(container, 'codeEntityGraph') as WikiGenerator['codeEntityGraph'],
    aiProvider: null,
    options: { language },
  });

  // projectInfo shape varies between bootstrap/full scan — use Parameters to match _discoverTopics signature
  type DiscoverParams = Parameters<WikiGenerator['_discoverTopics']>;
  const rawTopics = generator._discoverTopics(
    projectInfo as DiscoverParams[0],
    astInfo as DiscoverParams[1],
    moduleInfo as DiscoverParams[2],
    knowledgeInfo as DiscoverParams[3]
  );

  // ── 为每个主题构建 dataBundle ──
  const structuredData: StructuredData = {
    projectInfo: projectInfo || {},
    astInfo: astInfo || {},
    moduleInfo: moduleInfo || {},
    knowledgeInfo: knowledgeInfo || { recipes: [], stats: null },
  };
  const isZh = language === 'zh';

  const topics = rawTopics.map((topic) => {
    const mapped = {
      id: topic.id,
      path: topic.path,
      title: topic.title,
      type: topic.type,
      priority: topic.priority,
      writingGuide: _buildWritingGuide(topic, isZh),
      dataBundle: _buildTopicDataBundle(topic, structuredData),
    };

    // 添加其他主题引用（供导航链接）
    mapped.dataBundle.otherTopicPaths = rawTopics
      .filter((t) => t.id !== topic.id)
      .map((t) => ({ path: t.path, title: t.title }));

    return mapped;
  });

  // ── 确保 Wiki 目录存在 ──
  const wikiDir = path.join(projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR, 'wiki');
  _ensureDir(wikiDir);
  if (topics.some((t) => t.path.startsWith('modules/'))) {
    _ensureDir(path.join(wikiDir, 'modules'));
  }
  if (topics.some((t) => t.path.startsWith('patterns/'))) {
    _ensureDir(path.join(wikiDir, 'patterns'));
  }
  if (topics.some((t) => t.path.startsWith('folders/'))) {
    _ensureDir(path.join(wikiDir, 'folders'));
  }

  return envelope({
    success: true,
    data: {
      wikiDir: path.join(DEFAULT_KNOWLEDGE_BASE_DIR, 'wiki'),
      absoluteWikiDir: wikiDir,
      topicCount: topics.length,
      topics,
      writingGuidelines: _buildWritingGuidelines(isZh),
      cacheHit,
    },
    meta: {
      tool: 'asd_wiki_plan',
      responseTimeMs: Date.now() - t0,
    },
  });
}

// ════════════════════════════════════════════════════════════
//  wikiFinalize — 写入 meta.json + 去重 + 验证
// ════════════════════════════════════════════════════════════

/**
 * 完成 Wiki 生成 (asd_wiki_finalize)
 *
 * Agent 写完所有文章后调用。负责：
 *   1. 验证文件存在性
 *   2. 去重检查（内容相似度）
 *   3. 写入 meta.json
 *   4. 同步 Cursor 端文档（可选）
 *
 * @param ctx { container, logger, startedAt }
 * @param args { articlesWritten: string[] }
 */
export async function wikiFinalize(ctx: McpContext, args: WikiFinalizeArgs) {
  const t0 = Date.now();
  const { articlesWritten } = args;

  if (!Array.isArray(articlesWritten) || articlesWritten.length === 0) {
    return envelope({
      success: false,
      message: 'articlesWritten is required and must be a non-empty array of file paths',
      errorCode: 'VALIDATION_ERROR',
      meta: { tool: 'asd_wiki_finalize' },
    });
  }

  const container = ctx.container;
  const projectRoot = resolveProjectRoot(container);
  const wikiDir = path.join(projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR, 'wiki');

  // ── 1. 验证文件存在性 ──
  const missingFiles: string[] = [];
  const thinFiles: string[] = [];
  const fileDetails: WikiFileDetail[] = [];
  let totalSize = 0;

  for (const relPath of articlesWritten) {
    const fullPath = path.join(wikiDir, relPath);

    // 安全检查 — 防路径遍历
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(wikiDir))) {
      missingFiles.push(relPath);
      continue;
    }

    if (!fs.existsSync(fullPath)) {
      missingFiles.push(relPath);
      continue;
    }

    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    totalSize += stat.size;

    if (content.length < 200) {
      thinFiles.push(relPath);
    }

    fileDetails.push({
      path: relPath,
      size: stat.size,
      hash: createHash('md5').update(content).digest('hex'),
    });
  }

  // ── 2. 去重检查 ──
  let dedupResult: { removed: string[]; kept: number } = { removed: [], kept: 0 };
  try {
    const files = fileDetails.map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.size,
    }));
    dedupResult = dedup(files, wikiDir, () => {});
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[wiki-finalize] Dedup check failed: ${msg}`);
  }

  // ── 3. 写入 meta.json ──
  // 计算 sourceHash — 与 WikiGenerator._computeSourceHash() 保持一致
  // 使得 getStatus()._detectChanges() 对比时能正确判定"无变更"
  let sourceHash: string | undefined;
  try {
    const generator = new WikiGenerator({
      projectRoot,
      options: { language: 'zh' },
    });
    sourceHash = generator._computeSourceHash();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[wiki-finalize] Failed to compute sourceHash: ${msg}`);
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    version: '3.0-cursor-native',
    source: 'external-agent',
    filesCount: fileDetails.length,
    totalSize,
    files: fileDetails,
    ...(sourceHash ? { sourceHash } : {}),
  };

  try {
    _ensureDir(wikiDir);
    fs.writeFileSync(path.join(wikiDir, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return envelope({
      success: false,
      message: `Failed to write meta.json: ${msg}`,
      errorCode: 'IO_ERROR',
      meta: { tool: 'asd_wiki_finalize' },
    });
  }

  // ── 4. 同步 Cursor 端文档（仅检测，不修改 Agent 写的内容）──
  let syncedDocs = 0;
  try {
    const devdocsDir = path.join(projectRoot, '.cursor', 'skills', 'alembic-devdocs', 'references');
    if (fs.existsSync(devdocsDir)) {
      const docsDir = path.join(wikiDir, 'documents');
      _ensureDir(docsDir);
      const mdFiles = fs.readdirSync(devdocsDir).filter((f) => f.endsWith('.md'));
      for (const file of mdFiles) {
        const src = path.join(devdocsDir, file);
        const dest = path.join(docsDir, file);
        if (!fs.existsSync(dest)) {
          // 只同步 Agent 没写的文档
          const content = fs.readFileSync(src, 'utf-8');
          const header = `<!-- synced from .cursor/skills/alembic-devdocs/references/${file} -->\n\n`;
          fs.writeFileSync(dest, header + content);
          syncedDocs++;
        }
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.debug(`[wiki-finalize] Cursor docs sync skipped: ${msg}`);
  }

  return envelope({
    success: true,
    data: {
      fileCount: fileDetails.length,
      totalSize: `${(totalSize / 1024).toFixed(1)} KB`,
      dedup: dedupResult,
      validation: {
        missingFiles,
        thinFiles,
        passed: missingFiles.length === 0,
      },
      syncedDocs,
      meta,
    },
    meta: {
      tool: 'asd_wiki_finalize',
      responseTimeMs: Date.now() - t0,
    },
  });
}

// ════════════════════════════════════════════════════════════
//  内部辅助函数
// ════════════════════════════════════════════════════════════

function _ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 为主题生成写作指南 */
function _buildWritingGuide(topic: WikiTopicDef, isZh: boolean): string {
  const guides = {
    overview: isZh
      ? '撰写完整的项目概述文档。包含: 项目简介(解释项目做什么)、模块总览(表格形式)、技术栈分析、核心数据指标。底部包含导航索引，链接到其他 wiki 文档。'
      : 'Write a comprehensive project overview. Include: project introduction (what it does), module overview (table format), tech stack analysis, key metrics. Add navigation index at bottom linking to other wiki docs.',
    architecture: isZh
      ? '撰写项目架构文档。包含: 整体架构图(描述层次关系)、模块职责划分、模块间依赖关系(文字描述或 Mermaid 图)、核心设计决策、扩展点说明。'
      : 'Write architecture documentation. Include: overall architecture diagram (layer relationships), module responsibilities, inter-module dependencies (Mermaid diagrams), core design decisions, extension points.',
    'getting-started': isZh
      ? '撰写快速上手文档。包含: 环境要求、安装步骤、构建命令、运行方式、项目结构简介。面向项目新成员。'
      : 'Write getting started guide. Include: prerequisites, installation steps, build commands, how to run, project structure intro. Target new team members.',
    module: isZh
      ? '撰写模块深度文档。包含: 模块定位与职责、核心类及其关系、公共 API 概览(主要方法列表)、依赖关系、设计模式、使用示例。'
      : 'Write module deep-dive documentation. Include: module purpose, core classes and relationships, public API overview, dependencies, design patterns, usage examples.',
    patterns: isZh
      ? '基于知识库中的 Recipe 整理代码模式文档。按分类组织，每个模式包含: 名称、触发场景、规则内容、代码示例。'
      : 'Organize code patterns from knowledge base recipes. Group by category, each pattern includes: name, trigger scenario, rule content, code examples.',
    'pattern-category': isZh
      ? '撰写该分类下的代码模式文档。每个模式包含: 模式名称、应用场景、具体规则、代码示例。'
      : 'Write code patterns for this category. Each pattern: name, applicable scenario, specific rules, code examples.',
    reference: isZh
      ? '撰写协议/接口参考文档。按功能分组，每个协议包含: 名称、职责描述、方法签名列表、实现类。'
      : 'Write protocol/interface reference. Group by function, each includes: name, responsibility, method signatures, implementations.',
    'folder-overview': isZh
      ? '撰写项目结构分析文档。概述各个重要目录的功能定位、文件组织方式、命名规范。'
      : 'Write project structure analysis. Overview important directory purposes, file organization, naming conventions.',
    'folder-profile': isZh
      ? '撰写该目录的详细分析文档。包含: 目录职责、文件列表与说明、入口点、命名模式、与其他目录的关系。'
      : 'Write detailed directory analysis. Include: purpose, file list with descriptions, entry points, naming patterns, relationships with other directories.',
  };

  return (
    (guides as Record<string, string>)[topic.type] ||
    (isZh
      ? '撰写详细的技术文档，结构清晰，内容准确。'
      : 'Write detailed technical documentation with clear structure and accurate content.')
  );
}

/** 为主题构建数据包 */
function _buildTopicDataBundle(
  topic: WikiTopicDef,
  structuredData: StructuredData
): Record<string, unknown> {
  const { projectInfo, astInfo, moduleInfo, knowledgeInfo } = structuredData;
  const bundle: Record<string, unknown> = {};

  // Helper: safely access array-like from Record<string, unknown>
  const arr = (obj: Record<string, unknown>, key: string): unknown[] =>
    (Array.isArray(obj[key]) ? obj[key] : []) as unknown[];
  const rec = (obj: Record<string, unknown>, key: string): Record<string, unknown> =>
    (obj[key] && typeof obj[key] === 'object' ? obj[key] : {}) as Record<string, unknown>;

  switch (topic.type) {
    case 'overview':
      bundle.projectName = projectInfo.name;
      bundle.sourceFileCount = arr(projectInfo, 'sourceFiles').length;
      bundle.primaryLanguage = projectInfo.primaryLanguage;
      bundle.langProfile = projectInfo.langProfile;
      bundle.buildSystems = projectInfo.buildSystems;
      bundle.languages = projectInfo.languages;
      bundle.moduleCount = arr(moduleInfo, 'targets').length;
      bundle.moduleList = (arr(moduleInfo, 'targets') as Record<string, unknown>[]).map((t) => ({
        name: t.name,
        type: t.type || rec(t, 'info').type || 'unknown',
        fileCount: t.sourceFileCount || rec(t, 'info').sourceFileCount || 0,
        dependencies: (arr(t, 'dependencies').length > 0
          ? arr(t, 'dependencies')
          : arr(rec(t, 'info'), 'dependencies')
        ).slice(0, 10),
      }));
      bundle.astOverview = astInfo.overview || {};
      bundle.recipeCount = knowledgeInfo.recipes?.length || 0;
      break;

    case 'architecture':
      bundle.modules = (arr(moduleInfo, 'targets') as Record<string, unknown>[]).map((t) => ({
        name: t.name,
        type: t.type || rec(t, 'info').type || 'unknown',
        path: t.path || rec(t, 'info').path || '',
        dependencies: t.dependencies || rec(t, 'info').dependencies || [],
      }));
      bundle.depGraph = moduleInfo.depGraph
        ? {
            nodes: arr(rec(moduleInfo, 'depGraph'), 'nodes').length,
            edges: arr(rec(moduleInfo, 'depGraph'), 'edges').length,
          }
        : null;
      // 热实体信息（高入度类/协议）
      bundle.classCount = arr(astInfo, 'classes').length;
      bundle.protocolCount = arr(astInfo, 'protocols').length;
      bundle.hotClasses = arr(astInfo, 'classes').slice(0, 15);
      bundle.hotProtocols = arr(astInfo, 'protocols').slice(0, 10);
      break;

    case 'getting-started':
      bundle.projectName = projectInfo.name;
      bundle.buildSystems = projectInfo.buildSystems;
      bundle.primaryLanguage = projectInfo.primaryLanguage;
      bundle.hasPackageSwift = projectInfo.hasPackageSwift;
      bundle.hasPodfile = projectInfo.hasPodfile;
      bundle.hasXcodeproj = projectInfo.hasXcodeproj;
      bundle.entryPoints = arr(rec(astInfo, 'overview'), 'entryPoints');
      break;

    case 'module': {
      const md = (topic._moduleData || {}) as Record<string, unknown>;
      const mdTarget = rec(md, 'target');
      bundle.targetInfo = md.target
        ? { name: mdTarget.name, type: mdTarget.type || 'unknown', path: mdTarget.path || '' }
        : { name: topic.title };
      bundle.classNames = arr(rec(astInfo, 'classNamesByModule'), topic.title).slice(0, 30);
      bundle.protocolNames = arr(rec(astInfo, 'protocolNamesByModule'), topic.title).slice(0, 15);
      bundle.sourceFiles = arr(md, 'moduleFiles').slice(0, 30);
      bundle.classCount = md.classCount || 0;
      bundle.protoCount = md.protoCount || 0;
      bundle.dependencies = mdTarget.dependencies || rec(mdTarget, 'info').dependencies || [];
      break;
    }

    case 'patterns': {
      const groups: Record<string, Record<string, unknown>[]> = {};
      for (const r of knowledgeInfo.recipes || []) {
        const json: Record<string, unknown> =
          typeof (r as Record<string, unknown>).toJSON === 'function'
            ? ((r as Record<string, unknown>).toJSON as () => Record<string, unknown>)()
            : r;
        const cat = (json.category as string) || 'Other';
        if (!groups[cat]) {
          groups[cat] = [];
        }
        groups[cat].push({
          title: json.title || json.name,
          trigger: json.trigger || json.name,
          kind: json.kind || 'pattern',
          summary: json.summary || json.description || '',
        });
      }
      bundle.recipesByCategory = groups;
      bundle.totalRecipes = knowledgeInfo.recipes?.length || 0;
      break;
    }

    case 'pattern-category': {
      const pd = (topic._patternData || {}) as {
        category?: string;
        recipes?: Record<string, unknown>[];
      };
      bundle.category = pd.category;
      bundle.recipes = (pd.recipes || []).map((r: Record<string, unknown>) => ({
        title: r.title || r.name,
        trigger: r.trigger || r.name,
        kind: r.kind || 'pattern',
        summary: r.summary || r.description || '',
        content: typeof r.content === 'string' ? r.content.substring(0, 500) : '', // 截断长内容
      }));
      break;
    }

    case 'reference':
      bundle.protocols = arr(astInfo, 'protocols').slice(0, 40);
      bundle.protocolsByModule = astInfo.protocolNamesByModule || {};
      break;

    case 'folder-overview':
      bundle.folderProfiles = (topic._folderProfiles || []).map((fp: Record<string, unknown>) => ({
        relPath: fp.relPath,
        fileCount: fp.fileCount,
        languages: fp.languages,
        entryPoints: arr(fp, 'entryPoints').slice(0, 5),
        namingPatterns: arr(fp, 'namingPatterns').slice(0, 5),
        hasReadme: !!fp.readme,
      }));
      break;

    case 'folder-profile': {
      const fp = (topic._folderProfile || {}) as Record<string, unknown>;
      bundle.relPath = fp.relPath;
      bundle.fileCount = fp.fileCount;
      bundle.languages = fp.languages;
      bundle.files = arr(fp, 'files').slice(0, 30);
      bundle.entryPoints = fp.entryPoints || [];
      bundle.namingPatterns = fp.namingPatterns || [];
      bundle.imports = arr(fp, 'imports').slice(0, 20);
      bundle.headerComments = arr(fp, 'headerComments').slice(0, 10);
      bundle.readme = typeof fp.readme === 'string' ? fp.readme.substring(0, 500) : null;
      break;
    }
  }

  return bundle;
}

/** 构建写作指导手册 */
function _buildWritingGuidelines(isZh: boolean) {
  return {
    language: isZh ? 'zh' : 'en',
    style: isZh
      ? '技术文档风格，面向项目新成员。清晰、结构化、有深度。'
      : 'Technical documentation style targeting new team members. Clear, structured, in-depth.',
    minChars: 500,
    format: isZh
      ? [
          'Markdown 格式，使用 # 标题、## 分节',
          '适当使用代码块、表格、Mermaid 图',
          '引用具体文件路径（相对于项目根目录）',
          '每篇文章底部包含相关文档链接',
        ]
      : [
          'Markdown format with # titles and ## sections',
          'Use code blocks, tables, and Mermaid diagrams where appropriate',
          'Reference specific file paths (relative to project root)',
          'Include related document links at the bottom of each article',
        ],
    navigation: isZh
      ? '每篇文章末尾添加 "## 相关文档" 节，链接到其他 wiki 页面'
      : 'Add a "## Related Documents" section at the end, linking to other wiki pages',
  };
}
