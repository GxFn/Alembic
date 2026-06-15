/**
 * ModuleService — 多语言统一模块扫描服务
 *
 * 通过 ProjectContext repo/map facts 统一提供模块扫描、依赖摘要与 AI 提取输入。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  basename as _pathBasename,
  extname as _pathExtname,
  isAbsolute as _pathIsAbsolute,
  join as _pathJoin,
  relative,
} from 'node:path';
import {
  type AgentService,
  runScanAgentTask,
  type SystemRunContextFactory,
} from '@alembic/agent/service';
import { inferLang } from '@alembic/core/host-agent-workflows';
import Logger from '@alembic/core/logging';
// Type-only bridge: the layer contract forbids service -> injection runtime
// imports (AD4 remediated the former getAiRuntimeStatus reach-through); the
// status now arrives via constructed injection (aiStatus option).
import type { AiRuntimeStatus } from '../../injection/AiRuntimeStatus.js';
import {
  loadProjectContextRepo,
  type ProjectContextTargetEntry,
  projectContextDependencyGraph,
  projectContextFilesForTarget,
  projectContextProjectInfo,
  projectContextTargets,
} from '../../project-context/ProjectContextConsumerFacts.js';

// Mirrors getAiRuntimeStatus(null): constructions without an aiStatus
// provider (guard handler, CLI scan) previously passed no container and got
// this exact not-configured status — preserved verbatim.
const AI_STATUS_NOT_CONFIGURED: AiRuntimeStatus = Object.freeze({
  ready: false,
  reason: 'not-configured',
  providerName: null,
  model: null,
});

/** 全局排除目录 */
const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'Pods',
  'Carthage',
  '.build',
  'DerivedData',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.gradle',
  '.idea',
  'out',
  'coverage',
  '.cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  // DEFAULT_KNOWLEDGE_BASE_DIR — 知识库目录排除（与 ProjectMarkers.ts 同步）
  'Alembic',
]);

/** 源码文件扩展名 */
const SOURCE_CODE_EXTS = new Set([
  '.swift',
  '.m',
  '.mm',
  '.h',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.rb',
  '.vue',
  '.svelte',
  '.c',
  '.cpp',
  '.cs',
]);

export class ModuleService {
  #projectRoot;

  #repoContext: Awaited<ReturnType<typeof loadProjectContextRepo>> | null = null;

  #targets: ProjectContextTargetEntry[] = [];

  #loaded = false;

  #logger;

  // AI pipeline deps
  #agentService;
  #systemRunContextFactory;
  #aiStatus;
  #qualityScorer;
  #recipeExtractor;
  #guardCheckEngine;
  #violationsStore;

  constructor(
    projectRoot: string,
    options: {
      agentService?: AgentService | null;
      systemRunContextFactory?: SystemRunContextFactory | null;
      /** Constructed injection (AD4): AI runtime status provider; absent = not-configured. */
      aiStatus?: (() => AiRuntimeStatus) | null;
      qualityScorer?: Record<string, unknown> | null;
      recipeExtractor?: Record<string, unknown> | null;
      guardCheckEngine?: Record<string, unknown> | null;
      violationsStore?: Record<string, unknown> | null;
    } = {}
  ) {
    this.#projectRoot = projectRoot;
    this.#logger = Logger.getInstance();
    this.#agentService = options.agentService || null;
    this.#systemRunContextFactory = options.systemRunContextFactory || null;
    this.#aiStatus = options.aiStatus || null;
    this.#qualityScorer = options.qualityScorer || null;
    this.#recipeExtractor = options.recipeExtractor || null;
    this.#guardCheckEngine = options.guardCheckEngine || null;
    this.#violationsStore = options.violationsStore || null;
  }

  // ═══════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════

  /** 加载 ProjectContext repo facts 并缓存目标列表 */
  async load() {
    if (this.#loaded) {
      return;
    }

    try {
      this.#repoContext = await loadProjectContextRepo(this.#projectRoot);
      this.#targets = projectContextTargets(this.#repoContext, this.#projectRoot);
      this.#logger.info('[ModuleService] ProjectContext repo facts loaded', {
        projectInformationSource: 'project-context',
        targets: this.#targets.length,
      });
    } catch (err: unknown) {
      this.#repoContext = null;
      this.#targets = [];
      this.#logger.warn(
        `[ModuleService] ProjectContext repo facts unavailable: ${(err as Error).message}`
      );
    }

    this.#loaded = true;
  }

  /** 清除缓存，重新检测 */
  async reload() {
    this.#loaded = false;
    this.#repoContext = null;
    this.#targets = [];
    await this.load();
  }

  /** 确保已加载 */
  async #ensureLoaded() {
    if (!this.#loaded) {
      await this.load();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Query — ProjectContext facts
  // ═══════════════════════════════════════════════════════

  /** 列出所有模块/Target（ProjectContext repo targets） */
  async listTargets() {
    await this.#ensureLoaded();
    return [...this.#targets];
  }

  /** 获取 Target 的文件列表 */
  async getTargetFiles(target: string | Record<string, unknown>) {
    await this.#ensureLoaded();

    const targetObj = typeof target === 'string' ? { name: target } : target;
    const discovererId = targetObj.discovererId;

    // 虚拟目录扫描 — 直接收集文件（无需 discoverer）
    if (discovererId === 'folder-scan' && targetObj.path && existsSync(targetObj.path as string)) {
      return this.#collectFolderFiles(targetObj.path as string);
    }

    const contextTarget =
      discovererId === 'project-context'
        ? (targetObj as unknown as ProjectContextTargetEntry)
        : this.#targets.find((candidate) => candidate.name === targetObj.name);
    if (contextTarget) {
      return projectContextFilesForTarget(contextTarget, this.#projectRoot);
    }

    // 兜底：如果 target 有 path 属性且目录存在，直接收集
    if (targetObj.path && existsSync(targetObj.path as string)) {
      this.#logger.info(
        `[ModuleService] getTargetFiles fallback: collecting from ${targetObj.path}`
      );
      return this.#collectFolderFiles(targetObj.path as string);
    }

    return [];
  }

  /**
   * 获取依赖关系图
   * @param [options]
   * @returns [] }>}
   */
  async getDependencyGraph(options: { level?: 'package' | 'target' } = {}) {
    await this.#ensureLoaded();
    const graph = await projectContextDependencyGraph(
      this.#projectRoot,
      this.#repoContext ?? undefined
    );
    return {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        type: node.type || options.level || 'module',
      })),
    };
  }

  /** 项目信息摘要 */
  getProjectInfo() {
    return this.#repoContext
      ? projectContextProjectInfo(this.#repoContext, this.#projectRoot)
      : {
          projectRoot: this.#projectRoot,
          projectName: _pathBasename(this.#projectRoot) || '',
          primaryLanguage: 'unknown',
          discoverers: [],
          languages: [],
          hasSpm: false,
          projectInformationSource: 'project-context',
        };
  }

  // ═══════════════════════════════════════════════════════
  //  Scanning — AI Pipeline
  // ═══════════════════════════════════════════════════════

  /**
   * AI 扫描 Target 发现候选项
   * 完整管线: 读文件 → AI 提取 → Header 解析 → 工具增强
   */
  async scanTarget(
    target: string | Record<string, unknown>,
    options: { onProgress?: (event: Record<string, unknown>) => void } = {}
  ) {
    await this.#ensureLoaded();

    const targetName = typeof target === 'string' ? target : String(target?.name ?? '');
    const onProgress = options.onProgress;

    // 1. 获取源文件列表
    onProgress?.({ type: 'scan:started', targetName });
    const fileList = await this.getTargetFiles(target);
    if (!fileList || fileList.length === 0) {
      return {
        recipes: [],
        scannedFiles: [],
        message: `No source files found for module: ${targetName}`,
      };
    }

    const scannedFilesMeta = fileList.map((f: Record<string, unknown>) => {
      const filePath = typeof f === 'string' ? f : (f.path as string);
      return { name: _pathBasename(filePath), path: f.relativePath || _pathBasename(filePath) };
    });
    onProgress?.({ type: 'scan:files-loaded', files: scannedFilesMeta, count: fileList.length });

    // 2. 读取文件内容
    onProgress?.({ type: 'scan:reading', count: fileList.length });
    const files = fileList
      .map((f: Record<string, unknown>) => {
        const filePath = typeof f === 'string' ? f : (f.path as string);
        try {
          return {
            name: _pathBasename(filePath),
            path: filePath,
            relativePath:
              ((f as Record<string, unknown>).relativePath as string) || _pathBasename(filePath),
            content: readFileSync(filePath, 'utf8'),
          };
        } catch (err: unknown) {
          this.#logger.warn(
            `[ModuleService] Failed to read: ${filePath} — ${(err as Error).message}`
          );
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    if (files.length === 0) {
      return { recipes: [], scannedFiles: [], message: 'All source files unreadable' };
    }

    const scannedFiles = files.map((f) => ({ name: f.name, path: f.relativePath }));
    this.#logger.info(`[ModuleService] scanTarget: ${targetName}, ${files.length} files`);

    // 3. AI 提取 — 无真实 Provider 或无 AgentService 时直接跳过
    const aiStatus = this.#aiStatus?.() ?? AI_STATUS_NOT_CONFIGURED;
    if (!this.#agentService || !this.#systemRunContextFactory || !aiStatus.ready) {
      return {
        recipes: [],
        scannedFiles,
        noAi: true,
        message:
          'AI 未配置，已跳过智能提取。请在 Alembic Dashboard 的 AI Settings 中设置 API Key 后重试。',
      };
    }

    onProgress?.({ type: 'scan:ai-extracting', fileCount: files.length, targetName });
    let recipes = await this.#aiExtractRecipes(targetName, files as Record<string, unknown>[]);

    if (!Array.isArray(recipes)) {
      recipes = [];
    }

    // 3.5 moduleName 注入
    for (const recipe of recipes) {
      recipe.moduleName = targetName;
    }

    // 4. 工具增强
    onProgress?.({ type: 'scan:enriching', recipeCount: recipes.length });
    this.#enrichRecipes(recipes);

    const result: Record<string, unknown> = { recipes, scannedFiles };
    if (recipes.length === 0) {
      result.message = `AI 提取完成，但未发现可复用的代码模式（${targetName}, ${files.length} 个文件）`;
    }
    onProgress?.({
      type: 'scan:completed',
      recipeCount: recipes.length,
      fileCount: scannedFiles.length,
    });
    return result;
  }

  /** 全项目扫描 — 遍历所有 Target，AI 提取候选 + Guard 审计 */
  async scanProject(
    options: {
      maxFiles?: number;
      batchSize?: number;
      batchTimeout?: number;
      totalTimeout?: number;
    } = {}
  ) {
    await this.#ensureLoaded();
    this.#logger.info('[ModuleService] scanProject: starting full-project scan');

    // 1. 列出所有 target
    const allTargets = await this.listTargets();

    // 2. 收集所有源文件（去重）
    const seenPaths = new Set<string>();
    const allFiles: Record<string, unknown>[] = [];
    const MAX_FILES = options.maxFiles || 200;

    if (allTargets && allTargets.length > 0) {
      for (const t of allTargets) {
        try {
          const fileList = await this.getTargetFiles(t);
          for (const f of fileList) {
            const fp = (typeof f === 'string' ? f : f.path) as string;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            try {
              const content = readFileSync(fp, 'utf8');
              allFiles.push({
                name: _pathBasename(fp),
                path: fp,
                relativePath: (f as Record<string, unknown>).relativePath || _pathBasename(fp),
                content,
                targetName: t.name,
              });
            } catch {
              /* unreadable */
            }
            if (allFiles.length >= MAX_FILES) {
              break;
            }
          }
        } catch (e: unknown) {
          this.#logger.warn(
            `[ModuleService] scanProject: skipping module ${t.name}: ${(e as Error).message}`
          );
        }
        if (allFiles.length >= MAX_FILES) {
          break;
        }
      }
    }

    // 如果没有 target 收集到文件，回退到目录扫描
    if (allFiles.length === 0) {
      this.#logger.info(
        '[ModuleService] scanProject: No module targets, falling back to directory scan'
      );
      this.#walkProjectForFiles(allFiles, seenPaths, MAX_FILES);
    }

    this.#logger.info(
      `[ModuleService] scanProject: ${allFiles.length} unique files from ${allTargets?.length || 0} modules`
    );

    if (allFiles.length === 0) {
      return {
        targets: (allTargets || []).map((t) => t.name),
        recipes: [],
        guardAudit: null,
        scannedFiles: [],
        message: 'No readable source files',
      };
    }

    const scannedFiles = allFiles.map((f) => ({
      name: f.name,
      path: f.relativePath,
      targetName: f.targetName,
    }));

    // 3. AI 提取 Recipes — 无真实 Provider 时跳过
    const allRecipes: Record<string, unknown>[] = [];
    const PER_BATCH_TIMEOUT = options.batchTimeout || 90000;
    const startTime = Date.now();
    const TOTAL_TIMEOUT = options.totalTimeout || 540000;
    let timedOut = false;
    const scanAiStatus = this.#aiStatus?.() ?? AI_STATUS_NOT_CONFIGURED;

    if (this.#agentService && this.#systemRunContextFactory && scanAiStatus.ready) {
      const BATCH_SIZE = options.batchSize || 20;

      for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
        if (Date.now() - startTime > TOTAL_TIMEOUT) {
          this.#logger.warn(
            `[ModuleService] scanProject: total timeout reached after ${Math.floor((Date.now() - startTime) / 1000)}s`
          );
          timedOut = true;
          break;
        }
        const batch = allFiles.slice(i, i + BATCH_SIZE);
        const batchLabel = `project-batch-${Math.floor(i / BATCH_SIZE) + 1}`;
        try {
          const recipes = await Promise.race([
            this.#aiExtractRecipes(batchLabel, batch),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('batch timeout')), PER_BATCH_TIMEOUT)
            ),
          ]);
          if (Array.isArray(recipes)) {
            allRecipes.push(...recipes);
          }
        } catch (err: unknown) {
          this.#logger.warn(
            `[ModuleService] scanProject batch ${batchLabel} failed: ${(err as Error).message}`
          );
        }
      }

      this.#enrichRecipes(allRecipes);
    }

    // 4. Guard 审计
    let guardAudit: Record<string, unknown> | null = null;
    if (this.#guardCheckEngine) {
      try {
        const guardFiles = allFiles.map((f) => ({
          path: f.path as string,
          content: f.content as string,
        }));
        const engine = this.#guardCheckEngine as {
          auditFiles(
            files: { path: string; content: string }[],
            opts: Record<string, unknown>
          ): Record<string, unknown>;
        };
        guardAudit = engine.auditFiles(guardFiles, { scope: 'project' });

        if (this.#violationsStore && guardAudit && guardAudit.files) {
          const auditFileResults = guardAudit.files as Array<{
            filePath: string;
            violations: unknown[];
            summary: { errors: number; warnings: number };
          }>;
          const store = this.#violationsStore as { appendRun(data: Record<string, unknown>): void };
          for (const fileResult of auditFileResults) {
            if (fileResult.violations.length > 0) {
              store.appendRun({
                filePath: fileResult.filePath,
                violations: fileResult.violations,
                summary: `Project scan: ${fileResult.summary.errors} errors, ${fileResult.summary.warnings} warnings`,
              });
            }
          }
        }
      } catch (e: unknown) {
        this.#logger.warn(`[ModuleService] Guard audit failed: ${(e as Error).message}`);
      }
    }

    this.#logger.info(
      `[ModuleService] scanProject complete: ${allRecipes.length} recipes, ${(guardAudit?.summary as Record<string, unknown> | undefined)?.totalViolations || 0} violations${timedOut ? ' (partial — timed out)' : ''}`
    );

    return {
      targets: allTargets.map((t) => t.name),
      recipes: allRecipes,
      guardAudit,
      scannedFiles,
      partial: timedOut,
    };
  }

  /** 刷新模块映射（替代 updateDependencyMap） */
  async updateModuleMap(options: Record<string, unknown> = {}) {
    // 重新加载 ProjectContext facts
    await this.reload();
    const targets = await this.listTargets();
    const graph = await this.getDependencyGraph();

    return {
      success: true,
      message: `Module map updated (${targets.length} modules)`,
      targets: targets.length,
      edges: (graph.edges || []).length,
      projectRoot: this.#projectRoot,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Folder Scanning — 目录浏览与手动扫描
  // ═══════════════════════════════════════════════════════

  /**
   * 浏览项目目录结构 — 供前端目录选择器使用
   * @param [basePath=''] 相对于项目根目录的起始路径
   * @param [maxDepth=2] 最大递归深度
   * @returns >>}
   */
  async browseDirectories(basePath = '', maxDepth = 2) {
    const root = basePath ? _pathJoin(this.#projectRoot, basePath) : this.#projectRoot;

    if (!existsSync(root)) {
      return [];
    }

    const dirs: {
      name: string;
      path: string;
      depth: number;
      language: string;
      sourceFileCount: number;
      hasSourceFiles: boolean;
    }[] = [];
    this.#walkDirsForBrowse(root, dirs, 0, maxDepth);
    return dirs;
  }

  /**
   * 扫描任意文件夹 — 创建虚拟 Target 并走标准 AI 管线
   * 用于 Discoverer 未覆盖的目录（自定义目录名、新语言等）
   * @param folderPath 相对/绝对路径
   * @param [options] scanTarget options (onProgress 等)
   * @returns >}
   */
  async scanFolder(
    folderPath: string,
    options: { onProgress?: (event: Record<string, unknown>) => void } = {}
  ) {
    await this.#ensureLoaded();

    const absPath = _pathIsAbsolute(folderPath)
      ? folderPath
      : _pathJoin(this.#projectRoot, folderPath);

    if (!existsSync(absPath)) {
      throw new Error(`目录不存在: ${folderPath}`);
    }

    const lang = this.#detectFolderLanguage(absPath);
    const folderName = _pathBasename(absPath);

    // 构建虚拟 Target — 兼容 ModuleTarget 接口
    const virtualTarget = {
      name: folderName,
      path: absPath,
      packageName: folderName,
      packagePath: absPath,
      targetDir: absPath,
      type: 'directory',
      language: lang,
      discovererId: 'folder-scan',
      discovererName: '目录扫描',
      info: { source: 'manual-folder-scan', originalPath: folderPath },
      isVirtual: true,
    };

    this.#logger.info(`[ModuleService] scanFolder: ${folderPath} (lang=${lang})`);
    return this.scanTarget(virtualTarget, options);
  }

  /** 静态语义标准化 */
  static normalizeSemanticFields(recipe: Record<string, unknown>) {
    return recipe;
  }

  // ═══════════════════════════════════════════════════════
  //  Private Helpers
  // ═══════════════════════════════════════════════════════

  /**
   * AI 提取 Recipes — 委托 AgentService.run(scan-extract)
   *
   * Agent(LLM) 直接分析代码 + 使用 AST 工具，输出 Recipe JSON。
   */
  async #aiExtractRecipes(targetName: string, files: Record<string, unknown>[]) {
    if (!this.#agentService || !this.#systemRunContextFactory) {
      return [];
    }

    try {
      const result = await runScanAgentTask({
        agentService: this.#agentService,
        systemRunContextFactory: this.#systemRunContextFactory,
        label: targetName,
        files: files.map((file) => ({
          name: (file.name || file.relativePath || file.path) as string | undefined,
          relativePath: (file.relativePath || file.path || file.name) as string | undefined,
          content: (file.content || '') as string,
        })),
        task: 'extract',
      });
      const recipes = (result.recipes || []) as Record<string, unknown>[];

      if (recipes.length === 0) {
        this.#logger.info(
          `[ModuleService] Agent 未产出 recipe (${targetName}, ${files.length} files)`
        );
      } else {
        this.#logger.info(`[ModuleService] Agent 提取 ${recipes.length} recipes (${targetName})`);
      }
      return recipes;
    } catch (err: unknown) {
      if (
        (err as Record<string, unknown>).code === 'API_KEY_MISSING' ||
        /API_KEY_MISSING|API.Key.未配置|unregistered callers/i.test((err as Error).message)
      ) {
        this.#logger.info(`[ModuleService] AI 未启用（未配置 API Key），跳过 AI 提取。`);
      } else {
        this.#logger.warn(`[ModuleService] AI extraction failed: ${(err as Error).message}`);
      }
      return [];
    }
  }

  /** 质量评分 enrichment */
  #enrichRecipes(recipes: Record<string, unknown>[]) {
    for (const recipe of recipes) {
      if (!recipe.quality && this.#qualityScorer) {
        try {
          const scorer = this.#qualityScorer as {
            score(r: Record<string, unknown>): Record<string, unknown>;
          };
          const scoreResult = scorer.score(recipe);
          recipe.quality = {
            completeness: 0,
            adaptation: 0,
            documentation: 0,
            overall: scoreResult.score ?? 0,
            grade: scoreResult.grade || '',
          };
        } catch (e: unknown) {
          this.#logger.debug(`[ModuleService] QualityScorer failed: ${(e as Error).message}`);
        }
      }
    }
  }

  /** 目录遍历 — 浏览子目录结构 */
  #walkDirsForBrowse(
    dir: string,
    dirs: {
      name: string;
      path: string;
      depth: number;
      language: string;
      sourceFileCount: number;
      hasSourceFiles: boolean;
    }[],
    depth: number,
    maxDepth: number
  ) {
    if (depth >= maxDepth) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (SCAN_EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = _pathJoin(dir, entry.name);
        const relativePath = relative(this.#projectRoot, fullPath);

        // 递归统计源码文件数（覆盖 Java/Go 等深层包目录结构）
        const sourceFileCount = this.#countSourceFilesDeep(fullPath, 8);

        // 快速检测主要语言
        const lang = sourceFileCount > 0 ? this.#detectFolderLanguage(fullPath) : 'unknown';

        dirs.push({
          name: entry.name,
          path: relativePath,
          depth,
          language: lang,
          sourceFileCount,
          hasSourceFiles: sourceFileCount > 0,
        });

        this.#walkDirsForBrowse(fullPath, dirs, depth + 1, maxDepth);
      }
    } catch {
      /* skip */
    }
  }

  /** 递归统计目录下源码文件数（限深度 + 上限 999 防止超大目录卡顿） */
  #countSourceFilesDeep(dir: string, maxDepth: number, depth = 0) {
    if (depth >= maxDepth) {
      return 0;
    }
    let count = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && SOURCE_CODE_EXTS.has(_pathExtname(e.name).toLowerCase())) {
          count++;
        } else if (e.isDirectory() && !e.name.startsWith('.') && !SCAN_EXCLUDE_DIRS.has(e.name)) {
          count += this.#countSourceFilesDeep(_pathJoin(dir, e.name), maxDepth, depth + 1);
        }
        if (count >= 999) {
          return count;
        }
      }
    } catch {
      /* skip */
    }
    return count;
  }

  /** 从目录收集源码文件列表 */
  #collectFolderFiles(dirPath: string, maxDepth = 15) {
    const files: { name: string; path: string; relativePath: string; language: string }[] = [];
    this.#walkCollectSourceFiles(dirPath, dirPath, files, 0, maxDepth);
    return files;
  }

  /** 递归收集源码文件 */
  #walkCollectSourceFiles(
    dir: string,
    rootDir: string,
    files: { name: string; path: string; relativePath: string; language: string }[],
    depth: number,
    maxDepth: number
  ) {
    if (depth > maxDepth || files.length > 500) {
      return;
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        if (SCAN_EXCLUDE_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = _pathJoin(dir, entry.name);
        if (entry.isDirectory()) {
          this.#walkCollectSourceFiles(fullPath, rootDir, files, depth + 1, maxDepth);
        } else if (entry.isFile()) {
          const ext = _pathExtname(entry.name).toLowerCase();
          if (SOURCE_CODE_EXTS.has(ext)) {
            files.push({
              name: entry.name,
              path: fullPath,
              relativePath: relative(rootDir, fullPath),
              language: inferLang(entry.name) || 'unknown',
            });
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  /** 检测目录主要编程语言 */
  #detectFolderLanguage(dirPath: string) {
    const langCount: Record<string, number> = {};
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const ext = _pathExtname(entry.name).toLowerCase();
        if (!SOURCE_CODE_EXTS.has(ext)) {
          continue;
        }
        const lang = inferLang(entry.name);
        if (lang) {
          langCount[lang] = (langCount[lang] || 0) + 1;
        }
      }
    } catch {
      /* skip */
    }

    let maxLang = 'unknown';
    let maxCount = 0;
    for (const [lang, count] of Object.entries(langCount)) {
      if ((count as number) > maxCount) {
        maxCount = count as number;
        maxLang = lang;
      }
    }
    return maxLang;
  }

  /** 目录遍历兜底（收集源码文件） */
  #walkProjectForFiles(
    allFiles: Record<string, unknown>[],
    seenPaths: Set<string>,
    maxFiles: number
  ) {
    const srcDirs = [
      'Sources',
      'src',
      'lib',
      'app',
      'pages',
      'components',
      'modules',
      'packages',
      'cmd',
      'internal',
      'pkg',
    ];

    const walkDir = (dir: string, targetName: string) => {
      if (allFiles.length >= maxFiles) {
        return;
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (allFiles.length >= maxFiles) {
          break;
        }
        if (ent.name.startsWith('.')) {
          continue;
        }
        const fp = _pathJoin(dir, ent.name);
        if (ent.isDirectory()) {
          if (SCAN_EXCLUDE_DIRS.has(ent.name)) {
            continue;
          }
          walkDir(fp, targetName);
        } else if (ent.isFile() && SOURCE_CODE_EXTS.has(_pathExtname(ent.name).toLowerCase())) {
          if (seenPaths.has(fp)) {
            continue;
          }
          seenPaths.add(fp);
          try {
            const st = statSync(fp);
            if (st.size > 512 * 1024) {
              continue;
            }
            const content = readFileSync(fp, 'utf8');
            if (content.split('\n').length < 5) {
              continue;
            }
            allFiles.push({
              name: ent.name,
              path: fp,
              relativePath: relative(this.#projectRoot, fp),
              content,
              targetName,
            });
          } catch {
            /* unreadable */
          }
        }
      }
    };

    for (const dir of srcDirs) {
      const dirPath = _pathJoin(this.#projectRoot, dir);
      if (existsSync(dirPath)) {
        walkDir(dirPath, dir);
      }
    }

    if (allFiles.length === 0) {
      walkDir(this.#projectRoot, 'root');
    }
  }
}
