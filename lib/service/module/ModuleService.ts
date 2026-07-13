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
} from '../../project-facts/ProjectContextConsumerFacts.js';

// Mirrors getAiRuntimeStatus(null): constructions without an aiStatus
// provider (guard handler, CLI scan) previously passed no container and got
// this exact not-configured status — preserved verbatim.
const AI_STATUS_NOT_CONFIGURED: AiRuntimeStatus = Object.freeze({
  ready: false,
  reason: 'not-configured',
  providerName: null,
  model: null,
});

const PERSISTED_RECIPE_PROJECTION_AUTHORITY = 'persisted-knowledge-submit-results-only' as const;

export interface ModuleScanRecipe extends Record<string, unknown> {
  id: string;
  candidateId: string;
  status: 'created';
  lifecycle: 'pending' | 'staging';
}

export interface ModuleScanError {
  code:
    | 'MODULE_SCAN_AGENT_ERROR'
    | 'MODULE_SCAN_BATCH_ERROR'
    | 'MODULE_SCAN_BATCH_TIMEOUT'
    | 'MODULE_SCAN_TOTAL_TIMEOUT';
  message: string;
  batch?: string;
  operationMayContinue?: boolean;
}

export interface ModuleScanBatchOutcome {
  batch: string;
  fileCount: number;
  recipeCount: number;
  persistenceOutcome: string;
  diagnostics: Record<string, unknown> | null;
  error: ModuleScanError | null;
}

export interface ModuleScanProjectResult {
  targets: string[];
  recipes: ModuleScanRecipe[];
  guardAudit: Record<string, unknown> | null;
  scannedFiles: Record<string, unknown>[];
  partial: boolean;
  errors: ModuleScanError[];
  outcome: {
    status: 'completed' | 'empty' | 'failed' | 'partial' | 'skipped';
    recipeCount: number;
    projectionAuthority: typeof PERSISTED_RECIPE_PROJECTION_AUTHORITY;
    batches: ModuleScanBatchOutcome[];
    reason?: string;
  };
  message?: string;
}

interface ScanBatchProjection {
  recipes: ModuleScanRecipe[];
  diagnostics: Record<string, unknown> | null;
  rejectedRecipeCount: number;
  error: ModuleScanError | null;
}

interface ProjectScanFile extends Record<string, unknown> {
  name: string;
  path: string;
  relativePath: string;
  content: string;
  targetName?: string;
}

interface ProjectScanExtractionResult {
  recipes: ModuleScanRecipe[];
  batches: ModuleScanBatchOutcome[];
  errors: ModuleScanError[];
  timedOut: boolean;
}

class ModuleScanBatchTimeoutError extends Error {}

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
    const extraction = await this.#aiExtractRecipes(targetName, files as Record<string, unknown>[]);
    const recipes = extraction.recipes.map((recipe) => ({ ...recipe }));

    // 3.5 moduleName 注入
    for (const recipe of recipes) {
      recipe.moduleName = targetName;
    }

    const result: Record<string, unknown> = {
      recipes,
      scannedFiles,
      diagnostics: extraction.diagnostics,
      error: extraction.error,
    };
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
  ): Promise<ModuleScanProjectResult> {
    await this.#ensureLoaded();
    this.#logger.info('[ModuleService] scanProject: starting full-project scan');

    const allTargets = await this.listTargets();
    const allFiles = await this.#collectProjectScanFiles(allTargets, options.maxFiles || 200);

    this.#logger.info(
      `[ModuleService] scanProject: ${allFiles.length} unique files from ${allTargets.length} modules`
    );

    if (allFiles.length === 0) {
      return {
        targets: (allTargets || []).map((t) => t.name),
        recipes: [],
        guardAudit: null,
        scannedFiles: [],
        partial: false,
        errors: [],
        outcome: {
          status: 'empty',
          recipeCount: 0,
          projectionAuthority: PERSISTED_RECIPE_PROJECTION_AUTHORITY,
          batches: [],
          reason: 'no-readable-source-files',
        },
        message: 'No readable source files',
      };
    }

    const scannedFiles = allFiles.map((f) => ({
      name: f.name,
      path: f.relativePath,
      targetName: f.targetName,
    }));

    const scanAiStatus = this.#aiStatus?.() ?? AI_STATUS_NOT_CONFIGURED;
    const extraction = await this.#extractProjectScanRecipes(allFiles, scanAiStatus, options);
    const guardAudit = this.#auditProjectScanFiles(allFiles);
    const partial =
      extraction.timedOut || (extraction.errors.length > 0 && extraction.recipes.length > 0);
    const outcomeStatus = moduleScanOutcomeStatus(
      extraction,
      Boolean(this.#agentService && this.#systemRunContextFactory && scanAiStatus.ready)
    );
    this.#logger.info('[ModuleService] scanProject complete', {
      recipes: extraction.recipes.length,
      violations:
        (guardAudit?.summary as Record<string, unknown> | undefined)?.totalViolations || 0,
      outcome: outcomeStatus,
      partial,
      errorCount: extraction.errors.length,
      projectionAuthority: PERSISTED_RECIPE_PROJECTION_AUTHORITY,
    });

    return {
      targets: allTargets.map((t) => t.name),
      recipes: extraction.recipes,
      guardAudit,
      scannedFiles,
      partial,
      errors: extraction.errors,
      outcome: {
        status: outcomeStatus,
        recipeCount: extraction.recipes.length,
        projectionAuthority: PERSISTED_RECIPE_PROJECTION_AUTHORITY,
        batches: extraction.batches,
        ...(outcomeStatus === 'skipped' ? { reason: 'ai-unavailable' } : {}),
      },
    };
  }

  async #collectProjectScanFiles(
    targets: ProjectContextTargetEntry[],
    maxFiles: number
  ): Promise<ProjectScanFile[]> {
    const seenPaths = new Set<string>();
    const files: ProjectScanFile[] = [];
    for (const target of targets) {
      try {
        const targetFiles = await this.getTargetFiles(target);
        for (const file of targetFiles) {
          const path = (typeof file === 'string' ? file : file.path) as string;
          if (seenPaths.has(path)) {
            continue;
          }
          seenPaths.add(path);
          try {
            files.push({
              name: _pathBasename(path),
              path,
              relativePath:
                (file as Record<string, unknown>).relativePath?.toString() || _pathBasename(path),
              content: readFileSync(path, 'utf8'),
              targetName: target.name,
            });
          } catch {
            /* unreadable */
          }
          if (files.length >= maxFiles) {
            return files;
          }
        }
      } catch (error: unknown) {
        this.#logger.warn(
          `[ModuleService] scanProject: skipping module ${target.name}: ${(error as Error).message}`
        );
      }
    }
    if (files.length === 0) {
      this.#logger.info(
        '[ModuleService] scanProject: No module targets, falling back to directory scan'
      );
      this.#walkProjectForFiles(files, seenPaths, maxFiles);
    }
    return files;
  }

  async #extractProjectScanRecipes(
    files: ProjectScanFile[],
    aiStatus: AiRuntimeStatus,
    options: { batchSize?: number; batchTimeout?: number; totalTimeout?: number }
  ): Promise<ProjectScanExtractionResult> {
    const result: ProjectScanExtractionResult = {
      recipes: [],
      batches: [],
      errors: [],
      timedOut: false,
    };
    if (!this.#agentService || !this.#systemRunContextFactory || !aiStatus.ready) {
      return result;
    }
    const batchSize = options.batchSize || 20;
    const batchTimeout = options.batchTimeout || 90000;
    const totalTimeout = options.totalTimeout || 540000;
    const startTime = Date.now();
    for (let index = 0; index < files.length; index += batchSize) {
      if (Date.now() - startTime > totalTimeout) {
        const message = `total timeout reached after ${Math.floor((Date.now() - startTime) / 1000)}s`;
        this.#logger.warn(`[ModuleService] scanProject: ${message}`);
        result.errors.push({ code: 'MODULE_SCAN_TOTAL_TIMEOUT', message });
        result.timedOut = true;
        break;
      }
      await this.#extractProjectScanBatch(
        files.slice(index, index + batchSize),
        `project-batch-${Math.floor(index / batchSize) + 1}`,
        batchTimeout,
        result
      );
    }
    return result;
  }

  async #extractProjectScanBatch(
    batch: ProjectScanFile[],
    batchLabel: string,
    timeout: number,
    result: ProjectScanExtractionResult
  ): Promise<void> {
    try {
      const projection = await withModuleScanTimeout(
        this.#aiExtractRecipes(batchLabel, batch),
        timeout,
        batchLabel
      );
      result.recipes.push(...projection.recipes);
      const projectionError = projection.error ? { ...projection.error, batch: batchLabel } : null;
      if (projectionError) {
        result.errors.push(projectionError);
      }
      result.batches.push({
        batch: batchLabel,
        fileCount: batch.length,
        recipeCount: projection.recipes.length,
        persistenceOutcome: persistenceOutcomeFor(projection),
        diagnostics: projection.diagnostics,
        error: projectionError,
      });
    } catch (error: unknown) {
      const scanError = moduleScanBatchError(error, batchLabel);
      result.errors.push(scanError);
      result.batches.push({
        batch: batchLabel,
        fileCount: batch.length,
        recipeCount: 0,
        persistenceOutcome:
          scanError.code === 'MODULE_SCAN_BATCH_TIMEOUT' ? 'batch-timeout' : 'batch-error',
        diagnostics: null,
        error: scanError,
      });
      this.#logger.warn(
        `[ModuleService] scanProject batch ${batchLabel} failed: ${scanError.message}`,
        { code: scanError.code, batch: batchLabel, fileCount: batch.length }
      );
      result.timedOut = result.timedOut || scanError.code === 'MODULE_SCAN_BATCH_TIMEOUT';
    }
  }

  #auditProjectScanFiles(files: ProjectScanFile[]): Record<string, unknown> | null {
    if (!this.#guardCheckEngine) {
      return null;
    }
    try {
      const engine = this.#guardCheckEngine as {
        auditFiles(
          files: { path: string; content: string }[],
          opts: Record<string, unknown>
        ): Record<string, unknown>;
      };
      const audit = engine.auditFiles(
        files.map((file) => ({ path: file.path, content: file.content })),
        { scope: 'project' }
      );
      this.#storeProjectScanViolations(audit);
      return audit;
    } catch (error: unknown) {
      this.#logger.warn(`[ModuleService] Guard audit failed: ${(error as Error).message}`);
      return null;
    }
  }

  #storeProjectScanViolations(audit: Record<string, unknown>): void {
    if (!this.#violationsStore || !audit.files) {
      return;
    }
    const store = this.#violationsStore as { appendRun(data: Record<string, unknown>): void };
    const fileResults = audit.files as Array<{
      filePath: string;
      violations: unknown[];
      summary: { errors: number; warnings: number };
    }>;
    for (const fileResult of fileResults) {
      if (fileResult.violations.length > 0) {
        store.appendRun({
          filePath: fileResult.filePath,
          violations: fileResult.violations,
          summary: `Project scan: ${fileResult.summary.errors} errors, ${fileResult.summary.warnings} warnings`,
        });
      }
    }
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
  async #aiExtractRecipes(
    targetName: string,
    files: Record<string, unknown>[]
  ): Promise<ScanBatchProjection> {
    if (!this.#agentService || !this.#systemRunContextFactory) {
      return {
        recipes: [],
        diagnostics: null,
        rejectedRecipeCount: 0,
        error: null,
      };
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
      const rawRecipes = Array.isArray(result.recipes) ? result.recipes : [];
      // 上游 Agent 的 ScanRunProjection 是唯一 Recipe 身份权威；这里仅做 fail-closed
      // 边界校验，不从 provider 文本补 ID、candidateId 或 lifecycle。
      const recipes = rawRecipes.filter(isPersistedModuleScanRecipe);
      const rejectedRecipeCount = rawRecipes.length - recipes.length;
      const diagnostics = isRecord(result.diagnostics) ? result.diagnostics : null;

      if (recipes.length === 0) {
        this.#logger.info(`[ModuleService] Agent 未产出 persisted recipe`, {
          targetName,
          fileCount: files.length,
          persistenceOutcome: diagnostics?.persistenceOutcome || 'unknown',
          rejectedRecipeCount,
        });
      } else {
        this.#logger.info('[ModuleService] Agent persisted Recipe projection accepted', {
          targetName,
          fileCount: files.length,
          recipeCount: recipes.length,
          rejectedRecipeCount,
        });
      }
      if (rejectedRecipeCount > 0) {
        this.#logger.warn('[ModuleService] rejected malformed Agent Recipe projection', {
          targetName,
          rejectedRecipeCount,
          requiredStatus: 'created',
          allowedLifecycle: ['pending', 'staging'],
        });
      }
      return { recipes, diagnostics, rejectedRecipeCount, error: null };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        (isRecord(err) && err.code === 'API_KEY_MISSING') ||
        /API_KEY_MISSING|API.Key.未配置|unregistered callers/i.test(message)
      ) {
        this.#logger.info('[ModuleService] AI 未启用（未配置 API Key），跳过 AI 提取。', {
          targetName,
          error: message,
        });
      } else {
        this.#logger.warn('[ModuleService] AI extraction failed', {
          targetName,
          error: message,
        });
      }
      return {
        recipes: [],
        diagnostics: null,
        rejectedRecipeCount: 0,
        error: { code: 'MODULE_SCAN_AGENT_ERROR', message },
      };
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

function isPersistedModuleScanRecipe(value: unknown): value is ModuleScanRecipe {
  if (!isRecord(value)) {
    return false;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const candidateId = typeof value.candidateId === 'string' ? value.candidateId.trim() : '';
  return (
    value.status === 'created' &&
    (value.lifecycle === 'pending' || value.lifecycle === 'staging') &&
    id.length > 0 &&
    candidateId.length > 0 &&
    id === candidateId &&
    value.id === id &&
    value.candidateId === candidateId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function persistenceOutcomeFor(projection: ScanBatchProjection): string {
  if (projection.error) {
    return 'agent-error';
  }
  if (projection.rejectedRecipeCount > 0 && projection.recipes.length === 0) {
    return 'invalid-persisted-projection';
  }
  const outcome = projection.diagnostics?.persistenceOutcome;
  if (typeof outcome === 'string' && outcome.trim()) {
    return outcome;
  }
  return projection.recipes.length > 0 ? 'created' : 'unknown';
}

function moduleScanBatchError(error: unknown, batch: string): ModuleScanError {
  const isTimeout = error instanceof ModuleScanBatchTimeoutError;
  return {
    code: isTimeout ? 'MODULE_SCAN_BATCH_TIMEOUT' : 'MODULE_SCAN_BATCH_ERROR',
    message: error instanceof Error ? error.message : String(error),
    batch,
    ...(isTimeout ? { operationMayContinue: true } : {}),
  };
}

function moduleScanOutcomeStatus(
  extraction: ProjectScanExtractionResult,
  aiAvailable: boolean
): ModuleScanProjectResult['outcome']['status'] {
  if (extraction.timedOut || (extraction.errors.length > 0 && extraction.recipes.length > 0)) {
    return 'partial';
  }
  if (extraction.errors.length > 0) {
    return 'failed';
  }
  if (extraction.recipes.length > 0) {
    return 'completed';
  }
  return aiAvailable ? 'empty' : 'skipped';
}

async function withModuleScanTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  batch: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ModuleScanBatchTimeoutError(`${batch} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
