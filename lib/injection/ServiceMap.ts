/**
 * ServiceMap — DI 容器类型安全映射
 *
 * 将服务名（字符串 key）映射到具体类型，实现编译期类型检查。
 * 使用方式：`container.get('searchEngine')` → 自动推导为 `SearchEngine`
 *
 * @module ServiceMap
 */

// ── Domain Types ──
// ── External Types ──
import type { AiProvider, AiProviderManager } from '@alembic/agent/ai';
import type {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '@alembic/agent/service';
import type { UnifiedToolCatalog } from '@alembic/agent/tools';
import type { JobStore } from '@alembic/core/daemon';
import type { DatabaseConnection } from '@alembic/core/database';
import type { DimensionCopy } from '@alembic/core/dimensions';
import type { EventBus, SignalBus } from '@alembic/core/events';
import type {
  ComplianceReporter,
  ExclusionManager,
  GuardCheckEngine,
  GuardFeedbackLoop,
  GuardService,
  RuleLearner,
  ViolationsStore,
} from '@alembic/core/guard';
import type { WriteZone } from '@alembic/core/io';
// ── CLI Types ──
// ── Context Types ──
import type {
  CodeEntityGraph,
  ConfidenceRouter,
  KnowledgeFileWriter,
  KnowledgeGraphService,
  KnowledgeService,
  KnowledgeSyncService,
  RecipeExtractor,
  RecipeProductionGateway,
} from '@alembic/core/knowledge';
import type Logger from '@alembic/core/logging';
import type { MemoryRepositoryImpl } from '@alembic/core/memory';
// ── Core AST / Discovery / Enhancement ──
// ── Shared Types ──
import type {
  CouplingAnalyzer,
  LanguageService,
  LayerInferrer,
  PanoramaAggregator,
  PanoramaService,
  ProjectGraph,
  RoleRefiner,
} from '@alembic/core/project-intelligence';
// ── Repository Types ──
import type {
  BootstrapRepository,
  CodeEntityRepository,
  EvolutionProposalRepository,
  EvolutionWarningRepository,
  GuardViolationRepository,
  KnowledgeEdgeRepository,
  KnowledgeRepository,
  SessionRepository,
  SourceRefRepository,
  TokenUsageStore,
} from '@alembic/core/repositories';
import type { HybridRetriever, SearchEngine } from '@alembic/core/search';
import type { FeedbackCollector, QualityScorer } from '@alembic/core/service/quality';
import type { RecipeCandidateValidator, RecipeParser } from '@alembic/core/service/recipe';
import type { IndexingPipeline, VectorService, VectorStore } from '@alembic/core/vector';
import type { InMemoryTerminalSessionManager } from '#tools/adapters/TerminalSessionManager.js';
import type { JobProcessEventRecorder } from '../daemon/JobProcessEventRecorder.js';
// ── Core Types ──
import type Constitution from '../governance/constitution/Constitution.js';
import type Gateway from '../governance/gateway/Gateway.js';
// ── InfraModule Types ──
import type AuditLogger from '../infrastructure/audit/AuditLogger.js';
import type AuditStore from '../infrastructure/audit/AuditStore.js';
import type { CacheCoordinator } from '../infrastructure/cache/CacheCoordinator.js';
import type { AuditRepositoryImpl } from '../repository/audit/AuditRepository.js';
import type { BootstrapTaskManager } from '../service/bootstrap/BootstrapTaskManager.js';
import type { ModuleService } from '../service/module/ModuleService.js';
import type { HitRecorder } from '../service/signal/HitRecorder.js';
import type { SkillHooks } from '../service/skills/SkillHooks.js';
import type { PrimeSearchPipeline } from '../service/task/PrimeSearchPipeline.js';
// ── Vector Service Types ──
import type { ContextualEnricher } from '../service/vector/ContextualEnricher.js';

/**
 * 类型安全的服务映射表
 *
 * 将 DI 容器的字符串 key 映射到具体的服务类型。
 * `container.get<K extends keyof ServiceMap>(name: K): ServiceMap[K]`
 */
export interface ServiceMap {
  // ═══ InfraModule ═══
  database: DatabaseConnection;
  logger: ReturnType<typeof Logger.getInstance>;
  writeZone: WriteZone | null;
  auditStore: AuditStore;
  auditLogger: AuditLogger;
  gateway: Gateway;
  eventBus: EventBus;
  bootstrapTaskManager: BootstrapTaskManager;
  jobProcessEventRecorder: JobProcessEventRecorder;
  jobStore: JobStore;
  knowledgeRepository: KnowledgeRepository;
  knowledgeEdgeRepository: KnowledgeEdgeRepository;
  codeEntityRepository: CodeEntityRepository;
  bootstrapRepository: BootstrapRepository;
  guardViolationRepository: GuardViolationRepository;
  auditRepository: AuditRepositoryImpl;
  memoryRepository: MemoryRepositoryImpl;
  sessionRepository: SessionRepository;
  proposalRepository: EvolutionProposalRepository;
  warningRepository: EvolutionWarningRepository;
  recipeSourceRefRepository: SourceRefRepository;
  knowledgeFileWriter: KnowledgeFileWriter;
  knowledgeSyncService: KnowledgeSyncService;
  terminalSessionManager: InMemoryTerminalSessionManager;

  // ═══ AppModule ═══
  qualityScorer: QualityScorer;
  recipeParser: RecipeParser;
  recipeCandidateValidator: RecipeCandidateValidator;
  recipeExtractor: RecipeExtractor | null;
  feedbackCollector: FeedbackCollector;
  tokenUsageStore: TokenUsageStore;
  moduleService: ModuleService;
  primeSearchPipeline: PrimeSearchPipeline;

  // ═══ KnowledgeModule ═══
  confidenceRouter: ConfidenceRouter;
  knowledgeService: KnowledgeService;
  recipeProductionGateway: RecipeProductionGateway;
  knowledgeGraphService: KnowledgeGraphService;
  codeEntityGraph: CodeEntityGraph;
  searchEngine: SearchEngine;
  vectorStore: VectorStore;
  indexingPipeline: IndexingPipeline;
  hybridRetriever: HybridRetriever;
  discovererRegistry: unknown; // dynamic registry, type varies
  enhancementRegistry: unknown; // dynamic registry, type varies
  languageService: typeof LanguageService;
  dimensionCopy: typeof DimensionCopy;
  constitution: Constitution | null;
  aiProvider: AiProvider | null;
  aiProviderManager: AiProviderManager;
  projectGraph: ProjectGraph | null;

  // ═══ VectorModule ═══
  vectorService: VectorService;
  contextualEnricher: ContextualEnricher | null;

  // ═══ GuardModule ═══
  guardService: GuardService;
  guardCheckEngine: GuardCheckEngine;
  exclusionManager: ExclusionManager;
  ruleLearner: RuleLearner;
  violationsStore: ViolationsStore;
  complianceReporter: ComplianceReporter;
  guardFeedbackLoop: GuardFeedbackLoop;

  // ═══ AgentModule ═══
  toolRegistry: UnifiedToolCatalog;
  agentProfileRegistry: AgentProfileRegistry;
  agentStageFactoryRegistry: AgentStageFactoryRegistry;
  agentProfileCompiler: AgentProfileCompiler;
  agentRunCoordinator: AgentRunCoordinator;
  systemRunContextFactory: SystemRunContextFactory;
  agentRuntimeBuilder: AgentRuntimeBuilder;
  agentService: AgentService;
  skillHooks: SkillHooks;

  // ═══ SignalModule ═══
  signalBus: SignalBus;
  hitRecorder: HitRecorder;

  // ═══ PanoramaModule ═══
  roleRefiner: RoleRefiner;
  couplingAnalyzer: CouplingAnalyzer;
  layerInferrer: LayerInferrer;
  panoramaAggregator: PanoramaAggregator;
  panoramaService: PanoramaService;

  // ═══ Cross-Process Cache ═══
  cacheCoordinator: CacheCoordinator;

  // ═══ Singleton-injected values (bypassing get() factories) ═══
  _projectRoot: string;
  _config: Record<string, unknown>;
  _lang: string | null;
  _fileCache: unknown[] | null;
  _embedProvider: unknown;
}
