import { readdirSync, statSync } from 'node:fs';
import { extname as pathExtname, join as pathJoin, relative as pathRelative } from 'node:path';
import { KnowledgeSyncService } from '../cli/KnowledgeSyncService.js';
// ─── v3.0: AST ProjectGraph ──────────────────────────
import ProjectGraph from '../core/ast/ProjectGraph.js';
// ─── v3.1: Multi-Language Discovery + Enhancement ────────
import { getDiscovererRegistry } from '../core/discovery/index.js';
import { getEnhancementRegistry, initEnhancementRegistry } from '../core/enhancement/index.js';
import Gateway from '../core/gateway/Gateway.js';
import AuditLogger from '../infrastructure/audit/AuditLogger.js';
import AuditStore from '../infrastructure/audit/AuditStore.js';
import { GraphCache } from '../infrastructure/cache/GraphCache.js';
// ─── P3: Infrastructure ──────────────────────────────
import { EventBus } from '../infrastructure/event/EventBus.js';
import Logger from '../infrastructure/logging/Logger.js';
import { getRealtimeService as _getRealtimeService } from '../infrastructure/realtime/RealtimeService.js';
import { IndexingPipeline } from '../infrastructure/vector/IndexingPipeline.js';
// ─── P0: Vector Storage ──────────────────────────────
import { JsonVectorAdapter } from '../infrastructure/vector/JsonVectorAdapter.js';
// ─── P2: SPM ──────────────────────────────────────────
import { SpmService } from '../platform/ios/spm/SpmService.js';
import { KnowledgeRepositoryImpl } from '../repository/knowledge/KnowledgeRepository.impl.js';
// ─── P1: Token Usage Tracking ─────────────────────────
import { TokenUsageStore } from '../repository/token/TokenUsageStore.js';
// ─── P2: Automation ───────────────────────────────────
import { AutomationOrchestrator } from '../service/automation/AutomationOrchestrator.js';
import { BootstrapTaskManager } from '../service/bootstrap/BootstrapTaskManager.js';
import { ChatAgent } from '../service/chat/ChatAgent.js';
// ─── P2: ChatAgent (统一 AI Agent) ────────────────────
import { ToolRegistry } from '../service/chat/ToolRegistry.js';
import { ALL_TOOLS } from '../service/chat/tools.js';
// ─── P2: Content Extraction ─────────────────────────────────────
import { RecipeExtractor } from '../service/context/RecipeExtractor.js';
// ─── P3: Cursor Delivery Pipeline ──────────────────────
import { CursorDeliveryPipeline } from '../service/cursor/CursorDeliveryPipeline.js';
import { ComplianceReporter } from '../service/guard/ComplianceReporter.js';
// ─── P1: Guard Advanced ──────────────────────────────
import { ExclusionManager } from '../service/guard/ExclusionManager.js';
import { GuardCheckEngine } from '../service/guard/GuardCheckEngine.js';
import { GuardFeedbackLoop } from '../service/guard/GuardFeedbackLoop.js';
import { GuardService } from '../service/guard/GuardService.js';
import { RuleLearner } from '../service/guard/RuleLearner.js';
import { ViolationsStore } from '../service/guard/ViolationsStore.js';
import { CodeEntityGraph } from '../service/knowledge/CodeEntityGraph.js';
import { ConfidenceRouter } from '../service/knowledge/ConfidenceRouter.js';
import { KnowledgeFileWriter } from '../service/knowledge/KnowledgeFileWriter.js';
import { KnowledgeGraphService } from '../service/knowledge/KnowledgeGraphService.js';
import { KnowledgeService } from '../service/knowledge/KnowledgeService.js';
// ─── v3.2: ModuleService (统一多语言模块扫描) ──────────
import { ModuleService } from '../service/module/ModuleService.js';
import { FeedbackCollector } from '../service/quality/FeedbackCollector.js';
// ─── P2: Quality ──────────────────────────────────────
import { QualityScorer } from '../service/quality/QualityScorer.js';
import { RecipeCandidateValidator } from '../service/recipe/RecipeCandidateValidator.js';
// ─── P1: Injection / Snippet ─────────────────
import { RecipeParser } from '../service/recipe/RecipeParser.js';
// ─── P0: Advanced Search ──────────────────────────────
import { RetrievalFunnel } from '../service/search/RetrievalFunnel.js';
import { SearchEngine } from '../service/search/SearchEngine.js';
import { SkillHooks } from '../service/skills/SkillHooks.js';
import { VSCodeCodec } from '../service/snippet/codecs/VSCodeCodec.js';
import { XcodeCodec } from '../service/snippet/codecs/XcodeCodec.js';
import { SnippetFactory } from '../service/snippet/SnippetFactory.js';
import { SnippetInstaller } from '../service/snippet/SnippetInstaller.js';
import { DimensionCopy } from '../shared/DimensionCopyRegistry.js';
import { LanguageService } from '../shared/LanguageService.js';
// ─── TaskGraph ────────────────────────────────────────
import { TaskIdGenerator } from '../domain/task/TaskIdGenerator.js';
import { TaskRepositoryImpl } from '../repository/task/TaskRepository.impl.js';
import { TaskReadyEngine } from '../service/task/TaskReadyEngine.js';
import { TaskKnowledgeBridge } from '../service/task/TaskKnowledgeBridge.js';
import { TaskGraphService } from '../service/task/TaskGraphService.js';

/**
 * DependencyInjection 容器
 * 管理所有应用层的仓储、服务和基础设施依赖的创建和注入
 */
export class ServiceContainer {
  constructor() {
    this.services = {};
    this.singletons = {};
    this.logger = Logger.getInstance();
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
  async initialize(bootstrapComponents = {}) {
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

      // AiFactory 模块引用（用于 SpmService AI 扫描）
      try {
        this.singletons._aiFactory = await import('../external/ai/AiFactory.js');
      } catch {
        this.singletons._aiFactory = null;
      }

      // 自动探测 AI Provider（供 SearchEngine / Agent / IndexingPipeline 等常驻服务使用）
      if (!this.singletons.aiProvider && this.singletons._aiFactory) {
        try {
          const { autoDetectProvider } = this.singletons._aiFactory;
          if (typeof autoDetectProvider === 'function') {
            this.singletons.aiProvider = autoDetectProvider();
            this.logger.info('AI provider injected into container', {
              provider: this.singletons.aiProvider?.constructor?.name || 'unknown',
            });
          }
        } catch {
          // AI 不可用不阻塞启动
          this.singletons.aiProvider = null;
        }
      }

      // 如果主 provider 不支持 embedding（如 Claude），尝试创建备用 embedding provider
      if (this.singletons.aiProvider && !this.singletons.aiProvider.supportsEmbedding?.()) {
        try {
          const { getAvailableFallbacks, createProvider } = this.singletons._aiFactory;
          const providerName = this.singletons.aiProvider.name?.replace('-', '') || '';
          const fbCandidates =
            typeof getAvailableFallbacks === 'function' ? getAvailableFallbacks(providerName) : [];
          for (const fb of fbCandidates) {
            try {
              const fbProvider = createProvider({ provider: fb });
              if (fbProvider.supportsEmbedding?.()) {
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
      this.singletons._recipeExtractor = new RecipeExtractor();

      // 注册基础设施依赖
      this._registerInfrastructure();

      // ═══ AI Provider 热重载标记 ═══
      // 记录哪些 singleton key 持有 aiProvider 引用，在 reloadAiProvider() 时需要清除
      this._aiDependentSingletons = [
        'chatAgent',
        'searchEngine',
        'retrievalFunnel',
        'indexingPipeline',
      ];

      // 注册仓储
      this._registerRepositories();

      // 注册服务
      this._registerServices();

      // v3.1: 初始化 Enhancement Pack 注册表（异步加载所有框架增强包）
      try {
        await initEnhancementRegistry();
      } catch (e) {
        this.logger.warn('Enhancement registry init failed (non-blocking)', { error: e.message });
      }

      this.logger.info('Service container initialized successfully');
    } catch (error) {
      this.logger.error('Error initializing service container', {
        error: error.message,
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
   *  3. 清除已缓存的依赖 AI 的 singleton（ChatAgent / SearchEngine 等），
   *     下次 get() 时会用新 provider 重新创建
   *
   * @param {import('../external/ai/AiProvider.js').AiProvider} newProvider
   */
  reloadAiProvider(newProvider) {
    const old = this.singletons.aiProvider;
    this.singletons.aiProvider = newProvider;

    // 重新创建 embedding fallback provider
    this.singletons._embedProvider = null;
    if (newProvider && !newProvider.supportsEmbedding?.()) {
      try {
        const { getAvailableFallbacks, createProvider } = this.singletons._aiFactory || {};
        if (typeof getAvailableFallbacks === 'function') {
          const providerName = newProvider.name?.replace('-', '') || '';
          const fbCandidates = getAvailableFallbacks(providerName);
          for (const fb of fbCandidates) {
            try {
              const fbProvider = createProvider({ provider: fb });
              if (fbProvider.supportsEmbedding?.()) {
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
    const cleared = [];
    for (const key of this._aiDependentSingletons || []) {
      if (this.singletons[key]) {
        this.singletons[key] = null;
        cleared.push(key);
      }
    }

    this.logger.info('AI provider hot-reloaded', {
      old: old?.constructor?.name || 'none',
      new: newProvider?.constructor?.name || 'none',
      clearedSingletons: cleared,
    });
  }

  /**
   * 注册基础设施依赖
   */
  _registerInfrastructure() {
    // Database（使用 Bootstrap 注入的实例，或延迟报错）
    this.register('database', () => {
      if (!this.singletons.database) {
        throw new Error(
          'Database not initialized. Ensure Bootstrap.initialize() is called before using ServiceContainer.'
        );
      }
      return this.singletons.database;
    });

    // Logger
    this.register('logger', () => Logger.getInstance());

    // AuditStore
    this.register('auditStore', () => {
      if (!this.singletons.auditStore) {
        const database = this.get('database');
        this.singletons.auditStore = new AuditStore(database);
      }
      return this.singletons.auditStore;
    });

    // AuditLogger
    this.register('auditLogger', () => {
      if (!this.singletons.auditLogger) {
        const auditStore = this.get('auditStore');
        this.singletons.auditLogger = new AuditLogger(auditStore);
      }
      return this.singletons.auditLogger;
    });

    // Gateway
    this.register('gateway', () => {
      if (!this.singletons.gateway) {
        this.singletons.gateway = new Gateway();
      }
      return this.singletons.gateway;
    });

    // EventBus（全局事件总线）
    this.register('eventBus', () => {
      if (!this.singletons.eventBus) {
        this.singletons.eventBus = new EventBus({ maxListeners: 30 });
      }
      return this.singletons.eventBus;
    });

    // BootstrapTaskManager（冷启动异步任务管理器 — 单例）
    this.register('bootstrapTaskManager', () => {
      if (!this.singletons.bootstrapTaskManager) {
        const eventBus = this.get('eventBus');
        // 延迟 getter: RealtimeService 在 HTTP server 启动后才可用，CLI 模式下不可用
        const getRS = () => {
          try {
            return _getRealtimeService();
          } catch {
            return null;
          }
        };
        this.singletons.bootstrapTaskManager = new BootstrapTaskManager({
          eventBus,
          getRealtimeService: getRS,
        });
      }
      return this.singletons.bootstrapTaskManager;
    });
  }

  /**
   * 注册仓储
   */
  _registerRepositories() {
    // KnowledgeRepository (统一知识实体)
    this.register('knowledgeRepository', () => {
      if (!this.singletons.knowledgeRepository) {
        const database = this.get('database');
        this.singletons.knowledgeRepository = new KnowledgeRepositoryImpl(database);
      }
      return this.singletons.knowledgeRepository;
    });

    // KnowledgeFileWriter (统一 .md 序列化/落盘)
    this.register('knowledgeFileWriter', () => {
      if (!this.singletons.knowledgeFileWriter) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.knowledgeFileWriter = new KnowledgeFileWriter(projectRoot);
      }
      return this.singletons.knowledgeFileWriter;
    });

    // KnowledgeSyncService (统一 .md ↔ DB 同步)
    this.register('knowledgeSyncService', () => {
      if (!this.singletons.knowledgeSyncService) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.knowledgeSyncService = new KnowledgeSyncService(projectRoot);
      }
      return this.singletons.knowledgeSyncService;
    });

    // TaskRepository (TaskGraph 持久化)
    this.register('taskRepository', () => {
      if (!this.singletons.taskRepository) {
        const database = this.get('database');
        this.singletons.taskRepository = new TaskRepositoryImpl(database);
      }
      return this.singletons.taskRepository;
    });
  }

  /**
   * 注册服务
   */
  _registerServices() {
    // ConfidenceRouter (V3: 知识条目自动审核路由)
    this.register('confidenceRouter', () => {
      if (!this.singletons.confidenceRouter) {
        const qualityScorer = this.get('qualityScorer');
        this.singletons.confidenceRouter = new ConfidenceRouter({}, qualityScorer);
      }
      return this.singletons.confidenceRouter;
    });

    // KnowledgeService (V3: 统一知识服务)
    this.register('knowledgeService', () => {
      if (!this.singletons.knowledgeService) {
        const knowledgeRepository = this.get('knowledgeRepository');
        const auditLogger = this.get('auditLogger');
        const gateway = this.get('gateway');
        const knowledgeGraphService = this.get('knowledgeGraphService');
        const fileWriter = this.get('knowledgeFileWriter');
        const skillHooks = this.get('skillHooks');
        const confidenceRouter = this.get('confidenceRouter');
        const qualityScorer = this.get('qualityScorer');
        this.singletons.knowledgeService = new KnowledgeService(
          knowledgeRepository,
          auditLogger,
          gateway,
          knowledgeGraphService,
          { fileWriter, skillHooks, confidenceRouter, qualityScorer }
        );
      }
      return this.singletons.knowledgeService;
    });

    // GuardService (V3: uses knowledgeRepository, delegates to GuardCheckEngine)
    this.register('guardService', () => {
      if (!this.singletons.guardService) {
        const knowledgeRepository = this.get('knowledgeRepository');
        const auditLogger = this.get('auditLogger');
        const gateway = this.get('gateway');
        let guardCheckEngine = null;
        try {
          guardCheckEngine = this.get('guardCheckEngine');
        } catch {
          /* engine not yet available */
        }
        this.singletons.guardService = new GuardService(knowledgeRepository, auditLogger, gateway, {
          guardCheckEngine,
        });
      }
      return this.singletons.guardService;
    });

    // KnowledgeGraphService
    this.register('knowledgeGraphService', () => {
      if (!this.singletons.knowledgeGraphService) {
        const database = this.get('database');
        this.singletons.knowledgeGraphService = new KnowledgeGraphService(database);
      }
      return this.singletons.knowledgeGraphService;
    });

    // CodeEntityGraph (Phase E: 代码实体关系图谱)
    this.register('codeEntityGraph', () => {
      if (!this.singletons.codeEntityGraph) {
        const database = this.get('database');
        const projectRoot =
          this.singletons._projectRoot || process.env.ASD_PROJECT_DIR || process.cwd();
        this.singletons.codeEntityGraph = new CodeEntityGraph(database, { projectRoot });
      }
      return this.singletons.codeEntityGraph;
    });

    // SearchEngine
    this.register('searchEngine', () => {
      if (!this.singletons.searchEngine) {
        const database = this.get('database');
        const aiProvider = this.singletons.aiProvider || null;
        const embedProvider = this.singletons._embedProvider || aiProvider;
        const vectorStore = this.get('vectorStore');
        this.singletons.searchEngine = new SearchEngine(database, {
          aiProvider: embedProvider,
          vectorStore,
        });
      }
      return this.singletons.searchEngine;
    });

    // GuardCheckEngine
    this.register('guardCheckEngine', () => {
      if (!this.singletons.guardCheckEngine) {
        const database = this.get('database');
        const config = this.singletons._config || {};
        this.singletons.guardCheckEngine = new GuardCheckEngine(database, {
          guardConfig: config.guard || {},
        });
      }
      return this.singletons.guardCheckEngine;
    });

    // ─── Constitution ────────────────────────────────────
    this.register('constitution', () => this.singletons.constitution || null);

    // ─── 新迁移的服务 ────────────────────────────────────

    // EventBus / PluginManager — 已移除注册（源文件保留，未来可恢复）

    // RetrievalFunnel (Advanced Search)
    this.register('retrievalFunnel', () => {
      if (!this.singletons.retrievalFunnel) {
        const vectorStore = this.get('vectorStore');
        const aiProvider = this.singletons.aiProvider || null;
        const embedProvider = this.singletons._embedProvider || aiProvider;
        this.singletons.retrievalFunnel = new RetrievalFunnel({
          vectorStore,
          aiProvider: embedProvider,
        });
      }
      return this.singletons.retrievalFunnel;
    });

    // JsonVectorAdapter（同步构造 + 同步 init — 从磁盘 JSON 加载历史向量数据）
    this.register('vectorStore', () => {
      if (!this.singletons.vectorStore) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        const store = new JsonVectorAdapter(projectRoot);
        store.initSync(); // 从磁盘加载已有 vector_index.json
        this.singletons.vectorStore = store;
      }
      return this.singletons.vectorStore;
    });

    // IndexingPipeline
    this.register('indexingPipeline', () => {
      if (!this.singletons.indexingPipeline) {
        const vectorStore = this.get('vectorStore');
        const aiProvider = this.singletons.aiProvider || null;
        const embedProvider = this.singletons._embedProvider || aiProvider;
        this.singletons.indexingPipeline = new IndexingPipeline({
          vectorStore,
          aiProvider: embedProvider,
        });
      }
      return this.singletons.indexingPipeline;
    });

    // RecipeParser
    this.register('recipeParser', () => {
      if (!this.singletons.recipeParser) {
        this.singletons.recipeParser = new RecipeParser();
      }
      return this.singletons.recipeParser;
    });

    // RecipeCandidateValidator
    this.register('recipeCandidateValidator', () => {
      if (!this.singletons.recipeCandidateValidator) {
        this.singletons.recipeCandidateValidator = new RecipeCandidateValidator();
      }
      return this.singletons.recipeCandidateValidator;
    });

    // SnippetFactory (V4: codec-driven, IDE-agnostic)
    this.register('snippetFactory', () => {
      if (!this.singletons.snippetFactory) {
        const knowledgeRepo = this.get('knowledgeRepository');
        const factory = new SnippetFactory(knowledgeRepo);
        // 注册 IDE codecs
        factory.registerCodec(new XcodeCodec());
        factory.registerCodec(new VSCodeCodec());
        this.singletons.snippetFactory = factory;
      }
      return this.singletons.snippetFactory;
    });

    // SnippetInstaller (Xcode — 默认 codec)
    this.register('snippetInstaller', () => {
      if (!this.singletons.snippetInstaller) {
        const factory = this.get('snippetFactory');
        const codec = factory.getCodec('xcode');
        this.singletons.snippetInstaller = new SnippetInstaller({ codec, snippetFactory: factory });
      }
      return this.singletons.snippetInstaller;
    });

    // SnippetInstaller (VSCode)
    this.register('vscodeSnippetInstaller', () => {
      if (!this.singletons.vscodeSnippetInstaller) {
        const factory = this.get('snippetFactory');
        const codec = factory.getCodec('vscode');
        this.singletons.vscodeSnippetInstaller = new SnippetInstaller({
          codec,
          snippetFactory: factory,
        });
      }
      return this.singletons.vscodeSnippetInstaller;
    });

    // Guard: ExclusionManager
    this.register('exclusionManager', () => {
      if (!this.singletons.exclusionManager) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.exclusionManager = new ExclusionManager(projectRoot);
      }
      return this.singletons.exclusionManager;
    });

    // Guard: RuleLearner
    this.register('ruleLearner', () => {
      if (!this.singletons.ruleLearner) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.ruleLearner = new RuleLearner(projectRoot);
      }
      return this.singletons.ruleLearner;
    });

    // Guard: ViolationsStore (DB版)
    this.register('violationsStore', () => {
      if (!this.singletons.violationsStore) {
        const db = this.get('database').getDb();
        this.singletons.violationsStore = new ViolationsStore(db);
      }
      return this.singletons.violationsStore;
    });

    // Guard: ComplianceReporter
    this.register('complianceReporter', () => {
      if (!this.singletons.complianceReporter) {
        const config = this.singletons._config || {};
        this.singletons.complianceReporter = new ComplianceReporter(
          this.get('guardCheckEngine'),
          this.get('violationsStore'),
          this.get('ruleLearner'),
          this.get('exclusionManager'),
          config.qualityGate || {}
        );
      }
      return this.singletons.complianceReporter;
    });

    // Guard: GuardFeedbackLoop
    this.register('guardFeedbackLoop', () => {
      if (!this.singletons.guardFeedbackLoop) {
        this.singletons.guardFeedbackLoop = new GuardFeedbackLoop(
          this.get('violationsStore'),
          this.get('feedbackCollector'),
          { guardCheckEngine: this.get('guardCheckEngine') }
        );
      }
      return this.singletons.guardFeedbackLoop;
    });

    // Token Usage: 持久化 AI token 消耗
    this.register('tokenUsageStore', () => {
      if (!this.singletons.tokenUsageStore) {
        const db = this.get('database').getDb();
        this.singletons.tokenUsageStore = new TokenUsageStore(db);
      }
      return this.singletons.tokenUsageStore;
    });

    // QualityScorer
    this.register('qualityScorer', () => {
      if (!this.singletons.qualityScorer) {
        this.singletons.qualityScorer = new QualityScorer();
      }
      return this.singletons.qualityScorer;
    });

    // RecipeExtractor（语义标签提取）
    this.register('recipeExtractor', () => this.singletons._recipeExtractor || null);

    // FeedbackCollector
    this.register('feedbackCollector', () => {
      if (!this.singletons.feedbackCollector) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.feedbackCollector = new FeedbackCollector(projectRoot);
      }
      return this.singletons.feedbackCollector;
    });

    // SpmService (with AI + tool injection)
    this.register('spmService', () => {
      if (!this.singletons.spmService) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.spmService = new SpmService(projectRoot, {
          aiFactory: this.singletons._aiFactory || null,
          chatAgent: this.singletons.chatAgent || null,
          qualityScorer: this.get('qualityScorer'),
          recipeExtractor: this.singletons._recipeExtractor || null,
          guardCheckEngine: this.get('guardCheckEngine'),
          violationsStore: this.get('violationsStore'),
        });
      }
      return this.singletons.spmService;
    });

    // AutomationOrchestrator
    this.register('automationOrchestrator', () => {
      if (!this.singletons.automationOrchestrator) {
        this.singletons.automationOrchestrator = new AutomationOrchestrator();
      }
      return this.singletons.automationOrchestrator;
    });

    // ModuleService (统一多语言模块扫描，语言无关)
    this.register('moduleService', () => {
      if (!this.singletons.moduleService) {
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.moduleService = new ModuleService(projectRoot, {
          aiFactory: this.singletons._aiFactory || null,
          chatAgent: this.singletons.chatAgent || null,
          qualityScorer: this.get('qualityScorer'),
          recipeExtractor: this.singletons._recipeExtractor || null,
          guardCheckEngine: this.get('guardCheckEngine'),
          violationsStore: this.get('violationsStore'),
        });
      }
      return this.singletons.moduleService;
    });

    // DiscovererRegistry (v3.1 多语言项目发现)
    this.register('discovererRegistry', () => {
      return getDiscovererRegistry();
    });

    // LanguageService (v3.1 统一语言映射服务 — 静态类，直接返回)
    this.register('languageService', () => LanguageService);

    // DimensionCopy (v3.1 维度文案注册表 — 静态类，直接返回)
    this.register('dimensionCopy', () => DimensionCopy);

    // EnhancementRegistry (v3.1 框架增强包)
    this.register('enhancementRegistry', () => {
      return getEnhancementRegistry();
    });

    // ToolRegistry (ChatAgent 的工具注册表)
    this.register('toolRegistry', () => {
      if (!this.singletons.toolRegistry) {
        const registry = new ToolRegistry();
        registry.registerAll(ALL_TOOLS);
        this.singletons.toolRegistry = registry;
      }
      return this.singletons.toolRegistry;
    });

    // ProjectGraph (v3.0 AST 结构图 — 懒初始化，首次 get 时构建)
    this.register('projectGraph', () => {
      // 返回已构建的实例；需要外部先调用 buildProjectGraph() 构建
      return this.singletons.projectGraph || null;
    });

    // AI Provider（供 MCP handler / ChatAgent / 任意服务层使用）
    this.register('aiProvider', () => this.singletons.aiProvider || null);

    // ChatAgent (统一 AI Agent — 单 Agent + ToolRegistry 覆盖全部 AI 能力)
    this.register('chatAgent', () => {
      if (!this.singletons.chatAgent) {
        const toolRegistry = this.get('toolRegistry');
        const aiProvider = this.singletons.aiProvider || null;
        this.singletons.chatAgent = new ChatAgent({
          toolRegistry,
          aiProvider,
          container: this,
        });
      }
      return this.singletons.chatAgent;
    });

    // SkillHooks (Skill 生命周期钩子 — 加载 skills/*/hooks.js)
    // 注意: 优先使用 bootstrap 注入的已加载实例，避免创建未 .load() 的空实例
    this.register('skillHooks', () => {
      if (!this.singletons.skillHooks) {
        const hooks = new SkillHooks();
        // 同步返回空实例；异步 load 在后台执行
        hooks.load().catch(() => {
          /* skill hooks load is best-effort */
        });
        this.singletons.skillHooks = hooks;
      }
      return this.singletons.skillHooks;
    });

    // CursorDeliveryPipeline (4 通道交付：知识库 → Cursor Rules/Skills)
    this.register('cursorDeliveryPipeline', () => {
      if (!this.singletons.cursorDeliveryPipeline) {
        const knowledgeService = this.get('knowledgeService');
        const projectRoot = this.singletons._projectRoot || process.cwd();
        this.singletons.cursorDeliveryPipeline = new CursorDeliveryPipeline({
          knowledgeService,
          projectRoot,
          logger: this.logger,
        });
      }
      return this.singletons.cursorDeliveryPipeline;
    });

    // ─── TaskGraph Services ───────────────────────────
    // TaskIdGenerator (短 Hash ID 生成器)
    this.register('taskIdGenerator', () => {
      if (!this.singletons.taskIdGenerator) {
        const database = this.get('database');
        this.singletons.taskIdGenerator = new TaskIdGenerator(database.getDb());
      }
      return this.singletons.taskIdGenerator;
    });

    // TaskReadyEngine (递归 CTE 就绪检测)
    this.register('taskReadyEngine', () => {
      if (!this.singletons.taskReadyEngine) {
        const database = this.get('database');
        this.singletons.taskReadyEngine = new TaskReadyEngine(database.getDb());
      }
      return this.singletons.taskReadyEngine;
    });

    // TaskKnowledgeBridge (任务 ↔ 知识桥接)
    this.register('taskKnowledgeBridge', () => {
      if (!this.singletons.taskKnowledgeBridge) {
        const searchEngine = this.get('searchEngine');
        this.singletons.taskKnowledgeBridge = new TaskKnowledgeBridge(searchEngine);
      }
      return this.singletons.taskKnowledgeBridge;
    });

    // TaskGraphService (任务图核心服务)
    this.register('taskGraphService', () => {
      if (!this.singletons.taskGraphService) {
        const repository = this.get('taskRepository');
        const readyEngine = this.get('taskReadyEngine');
        const knowledgeBridge = this.get('taskKnowledgeBridge');
        const auditLogger = this.get('auditLogger');
        const idGenerator = this.get('taskIdGenerator');
        this.singletons.taskGraphService = new TaskGraphService(
          repository, readyEngine, knowledgeBridge, auditLogger, idGenerator
        );
      }
      return this.singletons.taskGraphService;
    });
  }

  /**
   * 注册服务或工厂函数
   */
  register(name, factory) {
    this.services[name] = factory;
  }

  /**
   * 获取服务（通过工厂函数）
   */
  get(name) {
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
  async buildProjectGraph(projectRoot, options = {}) {
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
        const changedPaths = [];
        const newHashes = {};
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
            `[ServiceContainer] ProjectGraph ⚡ 缓存命中 (${graph.getOverview().totalClasses} classes, ` +
              `${Date.now() - startTime}ms)`
          );
          return graph;
        }

        // 增量更新
        const diff = await graph.incrementalUpdate(changedPaths, deletedPaths, options);
        this.singletons.projectGraph = graph;

        // 写回缓存
        cache.save('project-graph', graph.toJSON(), { fileHashes: newHashes });

        const overview = graph.getOverview();
        this.logger.info(
          `[ServiceContainer] ProjectGraph 增量更新: +${diff.added} ~${diff.updated} -${diff.deleted} ` +
            `(${overview.totalClasses} classes, ${Date.now() - startTime}ms)`
        );
        return graph;
      }

      // ── 无缓存，全量构建 ──
      const graph = await ProjectGraph.build(projectRoot, options);
      this.singletons.projectGraph = graph;
      const overview = graph.getOverview();

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
    } catch (err) {
      this.logger.warn(`[ServiceContainer] ProjectGraph build failed: ${err.message}`);
      return null;
    }
  }

  /**
   * 收集项目源码文件路径（用于 hash 计算）
   * @param {string} projectRoot
   * @param {object} options
   * @returns {string[]}
   */
  #collectSourceFilePaths(projectRoot, options = {}) {
    const DEFAULTS_EXT = { '.m': true, '.h': true, '.swift': true };
    const extSet = new Set(options.extensions || Object.keys(DEFAULTS_EXT));
    const excludePatterns = options.excludePatterns || [
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
    const maxFiles = options.maxFiles || 500;
    const maxFileSizeBytes = options.maxFileSizeBytes || 500_000;
    const results = [];

    function walk(dir) {
      if (results.length >= maxFiles) {
        return;
      }
      let entries;
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

let containerInstance = null;

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
