/**
 * ServiceMap — DI 容器类型安全映射
 *
 * 将服务名（字符串 key）映射到具体类型，实现编译期类型检查。
 * 使用方式：`container.get('searchEngine')` → 自动推导为 `SearchEngine`
 *
 * @module ServiceMap
 */

import type DimensionCopy from '#domain/dimension/DimensionCopy.js';
// ── Service Types ──
import type { InMemoryTerminalSessionManager } from '../agent/adapters/TerminalSessionManager.js';
import type {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentRunCoordinator,
  AgentRuntimeBuilder,
  AgentService,
  AgentStageFactoryRegistry,
  SystemRunContextFactory,
} from '../agent/service/index.js';
import type { ToolRegistry } from '../agent/tools/ToolRegistry.js';
// ── CLI Types ──
import type { KnowledgeSyncService } from '../cli/KnowledgeSyncService.js';
// ── Core AST / Discovery / Enhancement ──
import type ProjectGraph from '../core/ast/ProjectGraph.js';
// ── Core Types ──
import type Constitution from '../core/constitution/Constitution.js';
import type Gateway from '../core/gateway/Gateway.js';
// ── Domain Types ──
// ── External Types ──
import type { AiProvider } from '../external/ai/AiProvider.js';
import type { AiProviderManager } from '../external/ai/AiProviderManager.js';
// ── InfraModule Types ──
import type AuditLogger from '../infrastructure/audit/AuditLogger.js';
import type AuditStore from '../infrastructure/audit/AuditStore.js';
import type { CacheCoordinator } from '../infrastructure/cache/CacheCoordinator.js';
import type DatabaseConnection from '../infrastructure/database/DatabaseConnection.js';
import type { EventBus } from '../infrastructure/event/EventBus.js';
import type { WriteZone } from '../infrastructure/io/WriteZone.js';
import type Logger from '../infrastructure/logging/Logger.js';
import type { SignalBus } from '../infrastructure/signal/SignalBus.js';
import type { IndexingPipeline } from '../infrastructure/vector/IndexingPipeline.js';
import type { VectorStore } from '../infrastructure/vector/VectorStore.js';
import type { AuditRepositoryImpl } from '../repository/audit/AuditRepository.js';
import type { BootstrapRepositoryImpl } from '../repository/bootstrap/BootstrapRepository.js';
import type { CodeEntityRepositoryImpl } from '../repository/code/CodeEntityRepository.js';
import type { ProposalRepository } from '../repository/evolution/ProposalRepository.js';
import type { WarningRepository } from '../repository/evolution/WarningRepository.js';
import type { GuardViolationRepositoryImpl } from '../repository/guard/GuardViolationRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../repository/knowledge/KnowledgeEdgeRepository.js';
// ── Repository Types ──
import type { KnowledgeRepositoryImpl } from '../repository/knowledge/KnowledgeRepository.impl.js';
import type { MemoryRepositoryImpl } from '../repository/memory/MemoryRepository.js';
import type { RemoteCommandRepository } from '../repository/remote/RemoteCommandRepository.js';
import type { SessionRepositoryImpl } from '../repository/session/SessionRepository.js';
import type { RecipeSourceRefRepositoryImpl } from '../repository/sourceref/RecipeSourceRefRepository.js';
import type { TokenUsageStore } from '../repository/token/TokenUsageStore.js';
import type { BootstrapTaskManager } from '../service/bootstrap/BootstrapTaskManager.js';
import type { CursorDeliveryPipeline } from '../service/delivery/CursorDeliveryPipeline.js';
import type { ComplianceReporter } from '../service/guard/ComplianceReporter.js';
import type { ExclusionManager } from '../service/guard/ExclusionManager.js';
import type { GuardCheckEngine } from '../service/guard/GuardCheckEngine.js';
import type { GuardFeedbackLoop } from '../service/guard/GuardFeedbackLoop.js';
import type GuardService from '../service/guard/GuardService.js';
import type { RuleLearner } from '../service/guard/RuleLearner.js';
import type { ViolationsStore } from '../service/guard/ViolationsStore.js';
import type { CodeEntityGraph } from '../service/knowledge/CodeEntityGraph.js';
import type { ConfidenceRouter } from '../service/knowledge/ConfidenceRouter.js';
import type { KnowledgeFileWriter } from '../service/knowledge/KnowledgeFileWriter.js';
import type { KnowledgeGraphService } from '../service/knowledge/KnowledgeGraphService.js';
import type { KnowledgeService } from '../service/knowledge/KnowledgeService.js';
// ── Context Types ──
import type { RecipeExtractor } from '../service/knowledge/RecipeExtractor.js';
import type { ModuleService } from '../service/module/ModuleService.js';
import type { CouplingAnalyzer } from '../service/panorama/CouplingAnalyzer.js';
import type { LayerInferrer } from '../service/panorama/LayerInferrer.js';
import type { PanoramaAggregator } from '../service/panorama/PanoramaAggregator.js';
import type { PanoramaService } from '../service/panorama/PanoramaService.js';
import type { RoleRefiner } from '../service/panorama/RoleRefiner.js';
import type { FeedbackCollector } from '../service/quality/FeedbackCollector.js';
import type { QualityScorer } from '../service/quality/QualityScorer.js';
import type { RecipeCandidateValidator } from '../service/recipe/RecipeCandidateValidator.js';
import type { RecipeParser } from '../service/recipe/RecipeParser.js';
import type { HybridRetriever } from '../service/search/HybridRetriever.js';
import type SearchEngine from '../service/search/SearchEngine.js';
import type { HitRecorder } from '../service/signal/HitRecorder.js';
import type { SkillHooks } from '../service/skills/SkillHooks.js';
import type { PrimeSearchPipeline } from '../service/task/PrimeSearchPipeline.js';
// ── Vector Service Types ──
import type { ContextualEnricher } from '../service/vector/ContextualEnricher.js';
import type { VectorService } from '../service/vector/VectorService.js';
// ── Shared Types ──
import type { LanguageService } from '../shared/LanguageService.js';

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
  knowledgeRepository: KnowledgeRepositoryImpl;
  knowledgeEdgeRepository: KnowledgeEdgeRepositoryImpl;
  codeEntityRepository: CodeEntityRepositoryImpl;
  bootstrapRepository: BootstrapRepositoryImpl;
  guardViolationRepository: GuardViolationRepositoryImpl;
  auditRepository: AuditRepositoryImpl;
  memoryRepository: MemoryRepositoryImpl;
  sessionRepository: SessionRepositoryImpl;
  proposalRepository: ProposalRepository;
  warningRepository: WarningRepository;
  remoteCommandRepository: RemoteCommandRepository;
  recipeSourceRefRepository: RecipeSourceRefRepositoryImpl;
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
  cursorDeliveryPipeline: CursorDeliveryPipeline;
  primeSearchPipeline: PrimeSearchPipeline;

  // ═══ KnowledgeModule ═══
  confidenceRouter: ConfidenceRouter;
  knowledgeService: KnowledgeService;
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
  toolRegistry: ToolRegistry;
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
