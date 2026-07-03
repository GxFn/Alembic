/**
 * ServiceMap — DI 容器类型安全映射
 *
 * 将服务名（字符串 key）映射到具体类型，实现编译期类型检查。
 * 使用方式：`container.get('searchEngine')` → 自动推导为 `SearchEngine`
 *
 * @module ServiceMap
 */

import type { UnifiedToolCatalog } from '@alembic/agent';
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
import type { JobStore } from '@alembic/core/daemon';
import type { DatabaseConnection } from '@alembic/core/database';
import type { DimensionCopy } from '@alembic/core/dimensions';
import type { EventBus, SignalBus } from '@alembic/core/events';
import type {
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
// ── Repository Types ──
import type {
  CoverageLedgerRepository,
  GenerateRepository,
  GuardViolationRepository,
  KnowledgeEdgeRepository,
  KnowledgeRepository,
  ProposalRepository,
  SessionRepository,
  SourceRefRepository,
  TokenUsageStore,
  WarningRepository,
} from '@alembic/core/repositories';
import type { HybridRetriever, SearchEngine } from '@alembic/core/search';
// ── Shared Types ──
import type { FeedbackCollector, QualityScorer } from '@alembic/core/service/quality';
import type { RecipeCandidateValidator, RecipeParser } from '@alembic/core/service/recipe';
import type { LanguageService } from '@alembic/core/shared';
import type { IndexingPipeline, VectorService, VectorStore } from '@alembic/core/vector';
import type { JobDisplaySnapshotStore } from '../daemon/observability/JobDisplaySnapshotStore.js';
import type { JobProcessEventRecorder } from '../daemon/observability/JobProcessEventRecorder.js';
// ── Core Types ──
import type Gateway from '../governance/gateway/Gateway.js';
// ── InfraModule Types ──
import type AuditLogger from '../infrastructure/audit/AuditLogger.js';
import type AuditStore from '../infrastructure/audit/AuditStore.js';
import type { CacheCoordinator } from '../infrastructure/cache/CacheCoordinator.js';
import type { GenerateTaskManager } from '../recipe-pipeline/generate/runtime/GenerateTaskManager.js';
import type { AuditRepositoryImpl } from '../repository/AuditRepository.js';
import type { ModuleService } from '../service/module/ModuleService.js';
import type { SkillHooks } from '../service/skills/SkillHooks.js';
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
  generateTaskManager: GenerateTaskManager;
  jobDisplaySnapshotStore: JobDisplaySnapshotStore;
  jobProcessEventRecorder: JobProcessEventRecorder;
  jobStore: JobStore;
  knowledgeRepository: KnowledgeRepository;
  knowledgeEdgeRepository: KnowledgeEdgeRepository;
  generateRepository: GenerateRepository;
  guardViolationRepository: GuardViolationRepository;
  auditRepository: AuditRepositoryImpl;
  memoryRepository: MemoryRepositoryImpl;
  sessionRepository: SessionRepository;
  proposalRepository: ProposalRepository;
  warningRepository: WarningRepository;
  coverageLedgerRepository: CoverageLedgerRepository;
  recipeSourceRefRepository: SourceRefRepository;
  knowledgeFileWriter: KnowledgeFileWriter;
  knowledgeSyncService: KnowledgeSyncService;

  // ═══ AppModule ═══
  qualityScorer: QualityScorer;
  recipeParser: RecipeParser;
  recipeCandidateValidator: RecipeCandidateValidator;
  recipeExtractor: RecipeExtractor | null;
  feedbackCollector: FeedbackCollector;
  tokenUsageStore: TokenUsageStore;
  moduleService: ModuleService;

  // ═══ KnowledgeModule ═══
  confidenceRouter: ConfidenceRouter;
  knowledgeService: KnowledgeService;
  recipeProductionGateway: RecipeProductionGateway;
  knowledgeGraphService: KnowledgeGraphService;
  searchEngine: SearchEngine;
  vectorStore: VectorStore;
  indexingPipeline: IndexingPipeline;
  hybridRetriever: HybridRetriever;
  enhancementRegistry: unknown; // dynamic registry, type varies
  languageService: typeof LanguageService;
  dimensionCopy: typeof DimensionCopy;
  aiProvider: AiProvider | null;
  aiProviderManager: AiProviderManager | null;

  // ═══ VectorModule ═══
  vectorService: VectorService;
  contextualEnricher: ContextualEnricher | null;

  // ═══ GuardModule ═══
  guardService: GuardService;
  guardCheckEngine: GuardCheckEngine;
  exclusionManager: ExclusionManager;
  ruleLearner: RuleLearner;
  violationsStore: ViolationsStore;
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

  // ═══ Cross-Process Cache ═══
  cacheCoordinator: CacheCoordinator;

  // ═══ Singleton-injected values (bypassing get() factories) ═══
  _projectRoot: string;
  _config: Record<string, unknown>;
  _lang: string | null;
  _fileCache: unknown[] | null;
  _embedProvider: unknown;
}
