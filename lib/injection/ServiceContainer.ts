import { type Dirent, readdirSync, statSync } from 'node:fs';
import { extname as pathExtname, join as pathJoin, relative as pathRelative } from 'node:path';
// ─── v3.0: AST ProjectGraph ──────────────────────────
import ProjectGraph from '../core/ast/ProjectGraph.js';
// ─── v3.1: Multi-Language Discovery + Enhancement ────────
import { initEnhancementRegistry } from '../core/enhancement/index.js';
import { GraphCache } from '../infrastructure/cache/GraphCache.js';
// ─── P3: Infrastructure ──────────────────────────────
import Logger from '../infrastructure/logging/Logger.js';
import * as AgentModule from './modules/AgentModule.js';
import * as AppModule from './modules/AppModule.js';
import * as GuardModule from './modules/GuardModule.js';
// ─── DI Modules ──────────────────────────────────────
import * as InfraModule from './modules/InfraModule.js';
import * as KnowledgeModule from './modules/KnowledgeModule.js';

/**
 * DependencyInjection 容器
 * 管理所有应用层的仓储、服务和基础设施依赖的创建和注入
 */
export class ServiceContainer {
  logger: ReturnType<typeof Logger.getInstance>;
  _aiDependentSingletons: string[] = [];
  services: Record<string, () => unknown>;
  singletons: Record<string, unknown>;
  constructor() {
    this.services = {};
    this.singletons = {};
    this.logger = Logger.getInstance();
  }

  // ─── 通用注册方法 ──────────────────────────────────

  /**
   * 注册一个惰性单例服务 — 消除 `if (!this.singletons.xxx)` 样板代码
   *
   * @param {string} name 服务名称
   * @param {(container: ServiceContainer) => any} factory 工厂函数（首次 get 时执行）
   * @param {{ aiDependent?: boolean }} [options] 选项
   *   - aiDependent: 标记为 AI Provider 依赖项，热重载时自动清除缓存
   */
  singleton(
    name: string,
    factory: (container: ServiceContainer) => unknown,
    options: { aiDependent?: boolean } = {}
  ) {
    if (options.aiDependent) {
      this._aiDependentSingletons = this._aiDependentSingletons || [];
      if (!this._aiDependentSingletons.includes(name)) {
        this._aiDependentSingletons.push(name);
      }
    }
    this.register(name, () => {
      if (!this.singletons[name]) {
        this.singletons[name] = factory(this);
      }
      return this.singletons[name];
    });
  }

  /**
   * 静态单例获取（路由层使用）
   */
  static getInstance() {
    return getServiceContainer();
  }

  /**
   * 初始化所有服务和仓储
   * @param {object} bootstrapComponents - Bootstrap 初始化的组件（db, auditLogger, gateway 等）
   */
  async initialize(bootstrapComponents: Record<string, unknown> = {}) {
    try {
      // 如果提供了 bootstrap 组件，将它们注入到单例缓存中
      if (bootstrapComponents.db) {
        this.singletons.database = bootstrapComponents.db;
      }
      if (bootstrapComponents.auditLogger) {
        this.singletons.auditLogger = bootstrapComponents.auditLogger;
      }
      if (bootstrapComponents.gateway) {
        this.singletons.gateway = bootstrapComponents.gateway;
      }
      if (bootstrapComponents.constitution) {
        this.singletons.constitution = bootstrapComponents.constitution;
      }

      if (bootstrapComponents.projectRoot) {
        this.singletons._projectRoot = bootstrapComponents.projectRoot;
      }

      if (bootstrapComponents.config) {
        this.singletons._config = bootstrapComponents.config;
      }

      if (bootstrapComponents.skillHooks) {
        this.singletons.skillHooks = bootstrapComponents.skillHooks;
      }

      // AiFactory 模块引用（用于 SpmHelper AI 扫描）
      try {
        this.singletons._aiFactory = await import('../external/ai/AiFactory.js');
      } catch {
        this.singletons._aiFactory = null;
      }

      // 自动探测 AI Provider（供 SearchEngine / Agent / IndexingPipeline 等常驻服务使用）
      if (!this.singletons.aiProvider && this.singletons._aiFactory) {
        try {
          const aiFactory = this.singletons._aiFactory as Record<string, unknown>;
          const autoDetectProvider = aiFactory.autoDetectProvider;
          if (typeof autoDetectProvider === 'function') {
            this.singletons.aiProvider = autoDetectProvider();
            const provider = this.singletons.aiProvider as Record<string, unknown> | null;
            this.logger.info('AI provider injected into container', {
              provider: (provider?.constructor as { name?: string } | undefined)?.name || 'unknown',
            });
          }
        } catch {
          // AI 不可用不阻塞启动
          this.singletons.aiProvider = null;
        }
      }

      // 如果主 provider 不支持 embedding（如 Claude），尝试创建备用 embedding provider
      const currentProvider = this.singletons.aiProvider as Record<string, unknown> | null;
      if (
        (currentProvider &&
          typeof (currentProvider as Record<string, (...args: unknown[]) => unknown>)
            .supportsEmbedding !== 'function') ||
        (currentProvider &&
          !(
            currentProvider as Record<string, (...args: unknown[]) => unknown>
          ).supportsEmbedding?.())
      ) {
        try {
          const aiFactory = (this.singletons._aiFactory || {}) as Record<string, unknown>;
          const getAvailableFallbacks = aiFactory.getAvailableFallbacks;
          const createProvider = aiFactory.createProvider as
            | ((opts: Record<string, unknown>) => Record<string, unknown>)
            | undefined;
          const providerName = ((currentProvider?.name as string) || '').replace('-', '');
          const fbCandidates =
            typeof getAvailableFallbacks === 'function'
              ? (getAvailableFallbacks as (name: string) => string[])(providerName)
              : [];
          for (const fb of fbCandidates) {
            try {
              const fbProvider = createProvider!({ provider: fb });
              if (
                typeof fbProvider.supportsEmbedding === 'function' &&
                (fbProvider.supportsEmbedding as () => boolean)()
              ) {
                this.singletons._embedProvider = fbProvider;
                this.logger.info('Embedding fallback provider created', { provider: fb });
                break;
              }
            } catch {
              /* skip */
            }
          }
        } catch {
          /* no embed fallback available */
        }
      }

      // RecipeExtractor 实例（用于工具增强）
      AppModule.initRecipeExtractor(this);

      // 注册所有模块 (替代 _registerInfrastructure / _registerRepositories / _registerServices)
      InfraModule.register(this);

      // ═══ AI Provider 热重载标记 ═══
      // 哪些 singleton key 持有 aiProvider 引用，在 reloadAiProvider() 时需要清除
      // 由各 Module 通过 singleton(name, factory, { aiDependent: true }) 自动注册
      // 预初始化为空数组，确保模块注册前已就绪
      this._aiDependentSingletons = this._aiDependentSingletons || [];

      // ═══ 容器级语言偏好 ═══
      this.singletons._lang = null;

      // 注册模块 (顺序重要: AppModule 先注册 qualityScorer 等基础服务)
      AppModule.register(this);
      KnowledgeModule.register(this);
      GuardModule.register(this);
      AgentModule.register(this);

      // v3.1: 初始化 Enhancement Pack 注册表（异步加载所有框架增强包）
      try {
        await initEnhancementRegistry();
      } catch (e: unknown) {
        this.logger.warn('Enhancement registry init failed (non-blocking)', {
          error: (e as Error).message,
        });
      }

      this.logger.info('Service container initialized successfully');
    } catch (error: unknown) {
      this.logger.error('Error initializing service container', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * 热重载 AI Provider（API Key 变更后调用，无需重启进程）
   *
   * 流程：
   *  1. 替换 singletons.aiProvider
   *  2. 重新创建 _embedProvider（如果主 provider 不支持 embedding）
   *  3. 清除已缓存的依赖 AI 的 singleton（SearchEngine 等），
   *     下次 get() 时会用新 provider 重新创建
   *
   * @param {import('../external/ai/AiProvider.js').AiProvider} newProvider
   */
  reloadAiProvider(newProvider: Record<string, unknown> | null) {
    const old = this.singletons.aiProvider as Record<string, unknown> | null;
    this.singletons.aiProvider = newProvider;

    // 重新创建 embedding fallback provider
    this.singletons._embedProvider = null;
    if (
      newProvider &&
      typeof newProvider.supportsEmbedding === 'function' &&
      !(newProvider.supportsEmbedding as () => boolean)()
    ) {
      try {
        const aiFactory = (this.singletons._aiFactory || {}) as Record<string, unknown>;
        const getAvailableFallbacks = aiFactory.getAvailableFallbacks;
        const createProvider = aiFactory.createProvider as
          | ((opts: Record<string, unknown>) => Record<string, unknown>)
          | undefined;
        if (typeof getAvailableFallbacks === 'function') {
          const providerName = ((newProvider.name as string) || '').replace('-', '');
          const fbCandidates = (getAvailableFallbacks as (name: string) => string[])(providerName);
          for (const fb of fbCandidates) {
            try {
              const fbProvider = createProvider!({ provider: fb });
              if (
                typeof fbProvider.supportsEmbedding === 'function' &&
                (fbProvider.supportsEmbedding as () => boolean)()
              ) {
                this.singletons._embedProvider = fbProvider;
                this.logger.info('Embedding fallback provider re-created', { provider: fb });
                break;
              }
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* no embed fallback available */
      }
    }

    // 清除持有旧 aiProvider 引用的 singleton 缓存
    // 下次调用 container.get() 时会使用新 provider 重建
    const cleared: string[] = [];
    for (const key of this._aiDependentSingletons || []) {
      if (this.singletons[key]) {
        this.singletons[key] = null;
        cleared.push(key);
      }
    }

    this.logger.info('AI provider hot-reloaded', {
      old: (old?.constructor as { name?: string } | undefined)?.name || 'none',
      new: (newProvider?.constructor as { name?: string } | undefined)?.name || 'none',
      clearedSingletons: cleared,
    });
  }

  // ─── 容器级语言偏好 ─────

  /**
   * 获取当前默认 UI 语言偏好
   * @returns {'zh'|'en'|null}
   */
  getLang() {
    return this.singletons._lang || null;
  }

  /**
   * 设置默认 UI 语言偏好（影响 Agent 回复语言）
   * @param {'zh'|'en'|null} lang
   */
  setLang(lang: 'zh' | 'en' | null) {
    this.singletons._lang = lang || null;
  }

  // ─── 工具执行上下文构建器 ─────────────────────

  /**
   * 构建 ToolRegistry.execute() 所需的上下文对象。
   *
   * 工具执行上下文构建
   * 迁移后: 所有直接调用 ToolRegistry 的站点都使用此方法
   *
   * @param {Object} [extras] 合并到上下文的额外字段
   * @returns {Object} 工具执行上下文
   */
  buildToolContext(extras: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      container: this,
      aiProvider: this.singletons.aiProvider || null,
      projectRoot: this.singletons._projectRoot || process.cwd(),
      logger: this.logger,
      source: extras.source || 'system',
      lang: extras.lang || this.singletons._lang || null,
      fileCache: this.singletons._fileCache || null,
      ...extras,
    };
  }

  /**
   * 注册服务或工厂函数
   */
  register(name: string, factory: () => unknown) {
    this.services[name] = factory;
  }

  /**
   * 获取服务（通过工厂函数）
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI container: callers know the service type
  get(name: string): any {
    if (!this.services[name]) {
      throw new Error(`Service '${name}' not found in container`);
    }
    return this.services[name]();
  }

  /**
   * 清除所有单例（用于测试）
   */
  reset() {
    this.singletons = {};
  }

  /**
   * 获取所有已注册的服务名
   */
  getServiceNames() {
    return Object.keys(this.services);
  }

  /**
   * 构建 ProjectGraph (v3.0 AST 结构图)
   * 优先从磁盘缓存加载，支持 per-file hash 增量更新
   * @param {string} projectRoot 项目根目录
   * @param {object} [options] 传递给 ProjectGraph.build() 的选项
   * @returns {Promise<import('../core/ast/ProjectGraph.js').default|null>}
   */
  async buildProjectGraph(projectRoot: string, options: Record<string, unknown> = {}) {
    if (this.singletons.projectGraph) {
      return this.singletons.projectGraph;
    }

    const cache = new GraphCache(projectRoot);
    const startTime = Date.now();

    try {
      // ── 尝试从缓存恢复 + 增量更新 ──
      const cached = cache.load('project-graph');
      if (cached?.data && cached.fileHashes) {
        const graph = ProjectGraph.fromJSON(cached.data);
        const currentFiles = this.#collectSourceFilePaths(projectRoot, options);
        const oldHashes = cached.fileHashes || {};

        // 计算差异：新增 / 变更 / 删除
        const changedPaths: string[] = [];
        const newHashes: Record<string, string> = {};
        for (const fp of currentFiles) {
          const rel = pathRelative(projectRoot, fp);
          const h = cache.computeFileHash(fp);
          newHashes[rel] = h;
          if (!oldHashes[rel] || oldHashes[rel] !== h) {
            changedPaths.push(fp);
          }
        }
        const deletedPaths = Object.keys(oldHashes).filter((rel) => !newHashes[rel]);

        if (changedPaths.length === 0 && deletedPaths.length === 0) {
          // 完全命中
          this.singletons.projectGraph = graph;
          this.logger.info(
            `[ServiceContainer] ProjectGraph ⚡ 缓存命中 (${graph.getOverview()?.totalClasses} classes, ` +
              `${Date.now() - startTime}ms)`
          );
          return graph;
        }

        // 增量更新
        const diff = await graph.incrementalUpdate(changedPaths, deletedPaths, options);
        this.singletons.projectGraph = graph;

        // 写回缓存
        cache.save('project-graph', graph.toJSON(), { fileHashes: newHashes });

        const overview = graph.getOverview()!;
        this.logger.info(
          `[ServiceContainer] ProjectGraph 增量更新: +${diff.added} ~${diff.updated} -${diff.deleted} ` +
            `(${overview.totalClasses} classes, ${Date.now() - startTime}ms)`
        );
        return graph;
      }

      // ── 无缓存，全量构建 ──
      const graph = await ProjectGraph.build(projectRoot, options);
      this.singletons.projectGraph = graph;
      const overview = graph.getOverview()!;

      // 计算文件 hash 并写入缓存
      const currentFiles = this.#collectSourceFilePaths(projectRoot, options);
      const fileHashes = cache.computeFileHashes(currentFiles, projectRoot);
      cache.save('project-graph', graph.toJSON(), { fileHashes });

      this.logger.info(
        `[ServiceContainer] ProjectGraph built: ${overview.totalClasses} classes, ` +
          `${overview.totalProtocols} protocols, ${overview.totalCategories} categories ` +
          `(${overview.buildTimeMs}ms) — 缓存已写入`
      );
      return graph;
    } catch (err: unknown) {
      this.logger.warn(`[ServiceContainer] ProjectGraph build failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 收集项目源码文件路径（用于 hash 计算）
   * @param {string} projectRoot
   * @param {object} options
   * @returns {string[]}
   */
  #collectSourceFilePaths(projectRoot: string, options: Record<string, unknown> = {}) {
    const DEFAULTS_EXT = { '.m': true, '.h': true, '.swift': true };
    const extSet = new Set(
      (options.extensions as string[] | undefined) || Object.keys(DEFAULTS_EXT)
    );
    const excludePatterns = (options.excludePatterns as string[] | undefined) || [
      'Pods/',
      'Carthage/',
      'node_modules/',
      '.build/',
      'build/',
      'DerivedData/',
      'vendor/',
      '.git/',
      '__tests__/',
      'Tests/',
    ];
    const maxFiles = (options.maxFiles as number | undefined) || 500;
    const maxFileSizeBytes = (options.maxFileSizeBytes as number | undefined) || 500_000;
    const results: string[] = [];

    function walk(dir: string) {
      if (results.length >= maxFiles) {
        return;
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxFiles) {
          return;
        }
        const fullPath = pathJoin(dir, entry.name);
        const relativePath = pathRelative(projectRoot, fullPath);
        if (excludePatterns.some((p) => relativePath.includes(p))) {
          continue;
        }
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && extSet.has(pathExtname(entry.name))) {
          try {
            const stat = statSync(fullPath);
            if (stat.size <= maxFileSizeBytes) {
              results.push(fullPath);
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    walk(projectRoot);
    return results;
  }
}

let containerInstance: ServiceContainer | null = null;

/**
 * 获取全局服务容器实例
 */
export function getServiceContainer() {
  if (!containerInstance) {
    containerInstance = new ServiceContainer();
  }
  return containerInstance;
}

/**
 * 重置全局服务容器（主要用于测试）
 */
export function resetServiceContainer() {
  if (containerInstance) {
    containerInstance.reset();
  }
}

export default ServiceContainer;
