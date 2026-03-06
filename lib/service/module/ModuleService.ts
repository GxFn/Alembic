/**
 * ModuleService — 多语言统一模块扫描服务
 *
 * 通过 DiscovererRegistry 自动检测项目类型，
 * 统一 SPM / Node / Go / JVM / Python / Generic 等语言的模块扫描、依赖分析、AI 提取管线。
 * 语言特有操作（如 SPM 依赖管理）由对应的 Discoverer / Service 直接暴露，不经此类代理。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  basename as _pathBasename,
  extname as _pathExtname,
  isAbsolute as _pathIsAbsolute,
  join as _pathJoin,
  relative,
} from 'node:path';
import { getDiscovererRegistry } from '../../core/discovery/index.js';
import { inferLang } from '../../external/mcp/handlers/LanguageExtensions.js';
import Logger from '../../infrastructure/logging/Logger.js';

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
  'AutoSnippet',
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
  /** @type {string} */
  #projectRoot;

  /** @type {import('../../core/discovery/DiscovererRegistry.js').DiscovererRegistry} */
  #registry;

  /** @type {Array<{ discoverer: import('../../core/discovery/ProjectDiscoverer.js').ProjectDiscoverer, confidence: number }>} */
  #activeDiscoverers: any[] = [];

  /** @type {boolean} */
  #loaded = false;

  /** @type {import('winston').Logger} */
  #logger;

  // AI pipeline deps
  #agentFactory;
  #container;
  #qualityScorer;
  #recipeExtractor;
  #guardCheckEngine;
  #violationsStore;

  /**
   * @param {string} projectRoot
   * @param {object} [options]
   * @param {object} [options.agentFactory]
   * @param {object} [options.container]
   * @param {object} [options.qualityScorer]
   * @param {object} [options.recipeExtractor]
   * @param {object} [options.guardCheckEngine]
   * @param {object} [options.violationsStore]
   */
  constructor(projectRoot, options: any = {}) {
    this.#projectRoot = projectRoot;
    this.#registry = getDiscovererRegistry();
    this.#logger = Logger.getInstance();
    this.#agentFactory = options.agentFactory || null;
    this.#container = options.container || null;
    this.#qualityScorer = options.qualityScorer || null;
    this.#recipeExtractor = options.recipeExtractor || null;
    this.#guardCheckEngine = options.guardCheckEngine || null;
    this.#violationsStore = options.violationsStore || null;
  }

  // ═══════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════

  /**
   * 自动检测项目类型并加载所有匹配的 Discoverer
   */
  async load() {
    if (this.#loaded) {
      return;
    }

    const matches = await this.#registry.detectAll(this.#projectRoot);
    this.#activeDiscoverers = [];

    for (const { discoverer, confidence } of matches) {
      try {
        await discoverer.load(this.#projectRoot);
        this.#activeDiscoverers.push({ discoverer, confidence });
        this.#logger.info(
          `[ModuleService] Loaded discoverer: ${discoverer.displayName} (confidence=${confidence.toFixed(2)})`
        );
      } catch (err: any) {
        this.#logger.warn(
          `[ModuleService] Failed to load discoverer ${discoverer.id}: ${err.message}`
        );
      }
    }

    if (this.#activeDiscoverers.length === 0) {
      this.#logger.warn('[ModuleService] No discoverer matched, using empty state');
    }

    this.#loaded = true;
  }

  /**
   * 清除缓存，重新检测
   */
  async reload() {
    this.#loaded = false;
    this.#activeDiscoverers = [];
    await this.load();
  }

  /**
   * 确保已加载
   */
  async #ensureLoaded() {
    if (!this.#loaded) {
      await this.load();
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Query — 委托到 Discoverer
  // ═══════════════════════════════════════════════════════

  /**
   * 列出所有模块/Target（合并所有 Discoverer 的结果）
   * @returns {Promise<import('../../core/discovery/ProjectDiscoverer.js').DiscoveredTarget[]>}
   */
  async listTargets() {
    await this.#ensureLoaded();

    const allTargets = [];
    const seenNames = new Set();
    let hasRealDiscovererTargets = false;

    // 第一遍：加载非 generic 的 Discoverer（真实项目结构识别器）
    for (const { discoverer } of this.#activeDiscoverers) {
      if (discoverer.id === 'generic') {
        continue;
      }
      try {
        const targets = await discoverer.listTargets();
        for (const t of targets) {
          const key = `${discoverer.id}::${t.name}`;
          if (seenNames.has(key)) {
            continue;
          }
          seenNames.add(key);
          allTargets.push(this.#normalizeTarget(t, discoverer));
          hasRealDiscovererTargets = true;
        }
      } catch (err: any) {
        this.#logger.warn(
          `[ModuleService] listTargets failed for ${discoverer.id}: ${err.message}`
        );
      }
    }

    // 第二遍：仅当没有真实 Discoverer 产出 target 时，才加载 GenericDiscoverer 的结果（兜底）
    if (!hasRealDiscovererTargets) {
      for (const { discoverer } of this.#activeDiscoverers) {
        if (discoverer.id !== 'generic') {
          continue;
        }
        try {
          const targets = await discoverer.listTargets();
          for (const t of targets) {
            const key = `${discoverer.id}::${t.name}`;
            if (seenNames.has(key)) {
              continue;
            }
            seenNames.add(key);
            allTargets.push(this.#normalizeTarget(t, discoverer));
          }
        } catch (err: any) {
          this.#logger.warn(
            `[ModuleService] listTargets failed for ${discoverer.id}: ${err.message}`
          );
        }
      }
    }

    return allTargets;
  }

  /**
   * 统一 target 格式 — 兼容前端 ModuleTarget 接口
   * 各 Discoverer 返回 { name, path, type, language, framework, metadata }
   * 前端还需要 { packageName, packagePath, targetDir, info } 等扩展字段
   */
  #normalizeTarget(t, discoverer) {
    return {
      ...t,
      // 兼容字段 — 如果 discoverer 已设置则保留，否则从通用字段推导
      packageName: t.packageName || t.metadata?.modulePath || t.name,
      packagePath: t.packagePath || t.path || '',
      targetDir: t.targetDir || t.path || '',
      info: t.info || t.metadata || {},
      // discoverer 来源
      discovererId: discoverer.id,
      discovererName: discoverer.displayName,
      // 确保语言字段始终存在
      language: t.language || discoverer.id || 'unknown',
    };
  }

  /**
   * 获取 Target 的文件列表
   * @param {import('../../core/discovery/ProjectDiscoverer.js').DiscoveredTarget|string} target
   * @returns {Promise<import('../../core/discovery/ProjectDiscoverer.js').DiscoveredFile[]>}
   */
  async getTargetFiles(target) {
    await this.#ensureLoaded();

    const targetObj = typeof target === 'string' ? { name: target } : target;
    const discovererId = targetObj.discovererId;

    // 虚拟目录扫描 — 直接收集文件（无需 discoverer）
    if (discovererId === 'folder-scan' && targetObj.path && existsSync(targetObj.path)) {
      return this.#collectFolderFiles(targetObj.path);
    }

    // 如果指定了 discovererId，直接找对应的 discoverer
    if (discovererId) {
      const entry = this.#activeDiscoverers.find((e) => e.discoverer.id === discovererId);
      if (entry) {
        return entry.discoverer.getTargetFiles(targetObj);
      }
    }

    // 否则遍历所有 discoverer 找到第一个有该 target 的
    for (const { discoverer } of this.#activeDiscoverers) {
      try {
        const targets = await discoverer.listTargets();
        if (targets.some((t) => t.name === targetObj.name)) {
          return discoverer.getTargetFiles(targetObj);
        }
      } catch {}
    }

    // 兜底：如果 target 有 path 属性且目录存在，直接收集
    if (targetObj.path && existsSync(targetObj.path)) {
      this.#logger.info(
        `[ModuleService] getTargetFiles fallback: collecting from ${targetObj.path}`
      );
      return this.#collectFolderFiles(targetObj.path);
    }

    return [];
  }

  /**
   * 获取依赖关系图
   * @param {{ level?: 'package'|'target' }} [options]
   * @returns {Promise<{ nodes: any[], edges: any[] }>}
   */
  async getDependencyGraph(options: any = {}) {
    await this.#ensureLoaded();

    // 合并所有 Discoverer 的依赖图
    const allNodes = [];
    const allEdges = [];

    // 如果有专业 Discoverer（非 generic），则跳过 GenericDiscoverer 的依赖图
    // 避免 generic fallback 生成的冗余根节点（如项目名本身）干扰图结构
    const hasSpecializedDiscoverer = this.#activeDiscoverers.some(
      ({ discoverer }) => discoverer.id !== 'generic'
    );

    for (const { discoverer } of this.#activeDiscoverers) {
      if (hasSpecializedDiscoverer && discoverer.id === 'generic') {
        continue;
      }
      try {
        const graph = await discoverer.getDependencyGraph();
        for (const n of graph.nodes || []) {
          const id = typeof n === 'string' ? n : n.id || n;
          allNodes.push({
            id: `${discoverer.id}::${id}`,
            label: typeof n === 'string' ? n : n.label || n.id,
            type: (typeof n === 'object' && n.type) || options.level || 'module',
            discovererId: discoverer.id,
            ...(typeof n === 'object' && n.fullPath ? { fullPath: n.fullPath } : {}),
            ...(typeof n === 'object' && n.indirect != null ? { indirect: n.indirect } : {}),
          });
        }
        for (const e of graph.edges || []) {
          allEdges.push({
            from: `${discoverer.id}::${e.from}`,
            to: `${discoverer.id}::${e.to}`,
            type: e.type || 'depends_on',
            source: discoverer.id,
          });
        }
      } catch (err: any) {
        this.#logger.warn(
          `[ModuleService] getDependencyGraph failed for ${discoverer.id}: ${err.message}`
        );
      }
    }

    return {
      nodes: allNodes,
      edges: allEdges,
      projectRoot: this.#projectRoot,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 项目信息摘要
   */
  getProjectInfo() {
    const discoverers = this.#activeDiscoverers.map((e) => ({
      id: e.discoverer.id,
      name: e.discoverer.displayName,
      confidence: e.confidence,
    }));

    const languages = [...new Set(discoverers.map((d) => d.id).filter((id) => id !== 'generic'))];
    const primaryDiscoverer = discoverers[0] || null;

    return {
      projectRoot: this.#projectRoot,
      projectName: _pathBasename(this.#projectRoot) || '',
      primaryLanguage: primaryDiscoverer
        ? this.#discovererToLanguage(primaryDiscoverer.id)
        : 'unknown',
      discoverers,
      languages,
      hasSpm: this.#activeDiscoverers.some((d) => d.discoverer.id === 'spm'),
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Scanning — AI Pipeline
  // ═══════════════════════════════════════════════════════

  /**
   * AI 扫描 Target 发现候选项
   * 完整管线: 读文件 → AI 提取 → Header 解析 → 工具增强
   */
  async scanTarget(target, options: any = {}) {
    await this.#ensureLoaded();

    const targetName = typeof target === 'string' ? target : target?.name;
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

    const scannedFilesMeta = fileList.map((f) => {
      const filePath = typeof f === 'string' ? f : f.path;
      return { name: _pathBasename(filePath), path: f.relativePath || _pathBasename(filePath) };
    });
    onProgress?.({ type: 'scan:files-loaded', files: scannedFilesMeta, count: fileList.length });

    // 2. 读取文件内容
    onProgress?.({ type: 'scan:reading', count: fileList.length });
    const files = fileList
      .map((f) => {
        const filePath = typeof f === 'string' ? f : f.path;
        try {
          return {
            name: _pathBasename(filePath),
            path: filePath,
            relativePath: f.relativePath || _pathBasename(filePath),
            content: readFileSync(filePath, 'utf8'),
          };
        } catch (err: any) {
          this.#logger.warn(`[ModuleService] Failed to read: ${filePath} — ${err.message}`);
          return null;
        }
      })
      .filter(Boolean);

    if (files.length === 0) {
      return { recipes: [], scannedFiles: [], message: 'All source files unreadable' };
    }

    const scannedFiles = files.map((f) => ({ name: f.name, path: f.relativePath }));
    this.#logger.info(`[ModuleService] scanTarget: ${targetName}, ${files.length} files`);

    // 3. AI 提取
    if (!this.#agentFactory) {
      return {
        recipes: [],
        scannedFiles,
        noAi: true,
        message: 'AI 未配置，已跳过智能提取。请在 .env 中设置 API Key 后重试。',
      };
    }

    onProgress?.({ type: 'scan:ai-extracting', fileCount: files.length, targetName });
    let recipes = await this.#aiExtractRecipes(targetName, files);

    if (!Array.isArray(recipes)) {
      recipes = [];
    }

    // 3.5 Header 路径解析 + moduleName 注入
    try {
      const PathFinder = await import('../../infrastructure/paths/PathFinder.js');
      const HeaderResolver = await import('../../infrastructure/paths/HeaderResolver.js');
      const targetRootDir = await PathFinder.findTargetRootDir(files[0].path);
      for (const recipe of recipes) {
        const headerList = recipe.headers || [];
        recipe.headerPaths = await Promise.all(
          headerList.map((h) => HeaderResolver.resolveHeaderRelativePath(h, targetRootDir))
        );
        recipe.moduleName = targetName;
      }
    } catch (err: any) {
      this.#logger.warn(`[ModuleService] Header resolution failed: ${err.message}`);
    }

    // 4. 工具增强
    onProgress?.({ type: 'scan:enriching', recipeCount: recipes.length });
    this.#enrichRecipes(recipes);

    const result: any = { recipes, scannedFiles };
    if (recipes.length === 0) {
      // 检查是否因为 AI Provider mock 导致空结果
      try {
        const aiProvider = this.#container?.singletons?.aiProvider;
        if (!aiProvider || aiProvider.name === 'mock') {
          result.noAi = true;
          result.message = 'AI 未配置，已跳过智能提取。请在 .env 中设置 API Key 后重试。';
        } else {
          result.message = `AI 提取完成，但未发现可复用的代码模式（${targetName}, ${files.length} 个文件）`;
        }
      } catch {
        result.message = `AI 提取完成，但未发现可复用的代码模式（${targetName}, ${files.length} 个文件）`;
      }
    }
    onProgress?.({
      type: 'scan:completed',
      recipeCount: recipes.length,
      fileCount: scannedFiles.length,
    });
    return result;
  }

  /**
   * 全项目扫描 — 遍历所有 Target，AI 提取候选 + Guard 审计
   */
  async scanProject(options: any = {}) {
    await this.#ensureLoaded();
    this.#logger.info('[ModuleService] scanProject: starting full-project scan');

    // 1. 列出所有 target
    const allTargets = await this.listTargets();

    // 2. 收集所有源文件（去重）
    const seenPaths = new Set();
    const allFiles = [];
    const MAX_FILES = options.maxFiles || 200;

    if (allTargets && allTargets.length > 0) {
      for (const t of allTargets) {
        try {
          const fileList = await this.getTargetFiles(t);
          for (const f of fileList) {
            const fp = typeof f === 'string' ? f : f.path;
            if (seenPaths.has(fp)) {
              continue;
            }
            seenPaths.add(fp);
            try {
              const content = readFileSync(fp, 'utf8');
              allFiles.push({
                name: _pathBasename(fp),
                path: fp,
                relativePath: f.relativePath || _pathBasename(fp),
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
        } catch (e: any) {
          this.#logger.warn(`[ModuleService] scanProject: skipping module ${t.name}: ${e.message}`);
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

    // 3. AI 提取 Recipes
    const allRecipes = [];
    const PER_BATCH_TIMEOUT = options.batchTimeout || 90000;
    const startTime = Date.now();
    const TOTAL_TIMEOUT = options.totalTimeout || 540000;
    let timedOut = false;

    if (this.#agentFactory) {
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
        } catch (err: any) {
          this.#logger.warn(
            `[ModuleService] scanProject batch ${batchLabel} failed: ${err.message}`
          );
        }
      }

      this.#enrichRecipes(allRecipes);
    }

    // 4. Guard 审计
    let guardAudit = null;
    if (this.#guardCheckEngine) {
      try {
        const guardFiles = allFiles.map((f) => ({ path: f.path, content: f.content }));
        guardAudit = this.#guardCheckEngine.auditFiles(guardFiles, { scope: 'project' });

        if (this.#violationsStore && guardAudit.files) {
          for (const fileResult of guardAudit.files) {
            if (fileResult.violations.length > 0) {
              this.#violationsStore.appendRun({
                filePath: fileResult.filePath,
                violations: fileResult.violations,
                summary: `Project scan: ${fileResult.summary.errors} errors, ${fileResult.summary.warnings} warnings`,
              });
            }
          }
        }
      } catch (e: any) {
        this.#logger.warn(`[ModuleService] Guard audit failed: ${e.message}`);
      }
    }

    this.#logger.info(
      `[ModuleService] scanProject complete: ${allRecipes.length} recipes, ${guardAudit?.summary?.totalViolations || 0} violations${timedOut ? ' (partial — timed out)' : ''}`
    );

    return {
      targets: allTargets.map((t) => t.name),
      recipes: allRecipes,
      guardAudit,
      scannedFiles,
      partial: timedOut,
    };
  }

  /**
   * 刷新模块映射（替代 updateDependencyMap）
   */
  async updateModuleMap(options: any = {}) {
    // 重新加载 discoverer
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
   * @param {string} [basePath=''] 相对于项目根目录的起始路径
   * @param {number} [maxDepth=2] 最大递归深度
   * @returns {Promise<Array<{ name: string, path: string, depth: number, language: string, sourceFileCount: number, hasSourceFiles: boolean }>>}
   */
  async browseDirectories(basePath = '', maxDepth = 2) {
    const root = basePath ? _pathJoin(this.#projectRoot, basePath) : this.#projectRoot;

    if (!existsSync(root)) {
      return [];
    }

    const dirs = [];
    this.#walkDirsForBrowse(root, dirs, 0, maxDepth);
    return dirs;
  }

  /**
   * 扫描任意文件夹 — 创建虚拟 Target 并走标准 AI 管线
   * 用于 Discoverer 未覆盖的目录（自定义目录名、新语言等）
   * @param {string} folderPath 相对/绝对路径
   * @param {object} [options] - scanTarget options (onProgress 等)
   * @returns {Promise<{ recipes: any[], scannedFiles: any[], message?: string }>}
   */
  async scanFolder(folderPath, options: any = {}) {
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
  static normalizeSemanticFields(recipe) {
    return recipe;
  }

  // ═══════════════════════════════════════════════════════
  //  Private Helpers
  // ═══════════════════════════════════════════════════════

  /**
   * Discoverer ID → 语言映射
   */
  #discovererToLanguage(id) {
    const map = {
      spm: 'swift',
      node: 'javascript',
      go: 'go',
      jvm: 'java',
      python: 'python',
      generic: 'unknown',
    };
    return map[id] || 'unknown';
  }

  /**
   * AI 提取 Recipes — 委托 AgentFactory.scanKnowledge
   *
   * AgentFactory.scanKnowledge 内部创建 insight Agent，
   * Agent(LLM) 直接分析代码 + 使用 AST 工具，输出 Recipe JSON。
   */
  async #aiExtractRecipes(targetName, files) {
    if (!this.#agentFactory) {
      return [];
    }

    try {
      const result = await this.#agentFactory.scanKnowledge({
        label: targetName, files, task: 'extract',
      });
      const recipes = result.recipes || [];

      if (recipes.length === 0) {
        this.#logger.info(
          `[ModuleService] Agent 未产出 recipe (${targetName}, ${files.length} files)`,
        );
      } else {
        this.#logger.info(
          `[ModuleService] Agent 提取 ${recipes.length} recipes (${targetName})`,
        );
      }
      return recipes;
    } catch (err: any) {
      if (err.code === 'API_KEY_MISSING' || /API_KEY_MISSING|API.Key.未配置|unregistered callers/i.test(err.message)) {
        this.#logger.info(`[ModuleService] AI 未启用（未配置 API Key），跳过 AI 提取。`);
      } else {
        this.#logger.warn(`[ModuleService] AI extraction failed: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * 质量评分 enrichment
   */
  #enrichRecipes(recipes) {
    for (const recipe of recipes) {
      if (!recipe.quality && this.#qualityScorer) {
        try {
          const scoreResult = this.#qualityScorer.score(recipe);
          recipe.quality = {
            completeness: 0,
            adaptation: 0,
            documentation: 0,
            overall: scoreResult.score ?? 0,
            grade: scoreResult.grade || '',
          };
        } catch (e: any) {
          this.#logger.debug(`[ModuleService] QualityScorer failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * 目录遍历 — 浏览子目录结构
   */
  #walkDirsForBrowse(dir, dirs, depth, maxDepth) {
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

  /**
   * 递归统计目录下源码文件数（限深度 + 上限 999 防止超大目录卡顿）
   */
  #countSourceFilesDeep(dir, maxDepth, depth = 0) {
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

  /**
   * 从目录收集源码文件列表
   */
  #collectFolderFiles(dirPath, maxDepth = 15) {
    const files = [];
    this.#walkCollectSourceFiles(dirPath, dirPath, files, 0, maxDepth);
    return files;
  }

  /**
   * 递归收集源码文件
   */
  #walkCollectSourceFiles(dir, rootDir, files, depth, maxDepth) {
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

  /**
   * 检测目录主要编程语言
   */
  #detectFolderLanguage(dirPath) {
    const langCount = {};
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
      // @ts-expect-error TS migration: TS2365
      if (count > maxCount) {
        // @ts-expect-error TS migration: TS2322
        maxCount = count;
        maxLang = lang;
      }
    }
    return maxLang;
  }

  /**
   * 目录遍历兜底（收集源码文件）
   */
  #walkProjectForFiles(allFiles, seenPaths, maxFiles) {
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

    const walkDir = (dir, targetName) => {
      if (allFiles.length >= maxFiles) {
        return;
      }
      let entries;
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
