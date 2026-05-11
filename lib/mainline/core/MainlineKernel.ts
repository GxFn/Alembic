import { type MainlineAstParser, UnavailableAstParser } from "../code/AstPort.js";
import {
  ExtensionLanguageService,
  type MainlineLanguageService,
} from "../code/LanguageServicePort.js";
import { TreeSitterMainlineAstParser } from "../code/TreeSitterAstParser.js";
import { type MainlineDatabasePort, UnavailableMainlineDatabase } from "../data/DatabasePort.js";
import { type ContextIndex, InMemoryContextIndex } from "../data/index.js";
import { InMemoryMainlineJobLedger, type MainlineJobLedgerPort } from "../data/JobLedger.js";
import { MainlineProjectGraphBuilder } from "../graph/index.js";
import { InMemoryMainlineSearchIndex, type MainlineSearchIndex } from "../search/index.js";
import { MainlineAtomicFileStore } from "./AtomicFileStore.js";
import { MainlineCapabilityRegistry } from "./CapabilityRegistry.js";
import { MainlineConcurrencyLimiter } from "./Concurrency.js";
import { type MainlineConfigPort, ObjectMainlineConfig } from "./ConfigPort.js";
import { MainlineDirectoryLock } from "./DirectoryLock.js";
import { MainlineEnvironment } from "./Environment.js";
import { MainlineEventBus } from "./EventBus.js";
import { type MainlineFileSystemPort, NodeMainlineFileSystem } from "./FileSystemPort.js";
import { type MainlineFileWatcherPort, UnavailableMainlineFileWatcher } from "./FileWatch.js";
import { type MainlineGitPort, UnavailableMainlineGit } from "./GitPort.js";
import { type MainlineDisposable, MainlineDisposer } from "./Lifecycle.js";
import { type MainlineLogger, NoopMainlineLogger } from "./LoggerPort.js";
import { type MainlineScheduler, MainlineSchedulerImpl } from "./Scheduler.js";
import { MainlineSingletonRegistry } from "./SingletonRegistry.js";
import { getMainlineTestModeConfig, type MainlineTestModeConfig } from "./TestMode.js";
import { type MainlineWorkerPool, UnavailableWorkerPool } from "./WorkerPool.js";
import { MainlineWorkspacePaths } from "./WorkspacePaths.js";
import { MainlineWriteBoundary } from "./WriteBoundary.js";

export interface MainlineKernelOptions {
  environment?: MainlineEnvironment;
  registry?: MainlineSingletonRegistry;
  contextIndex?: ContextIndex;
  database?: MainlineDatabasePort;
  searchIndex?: MainlineSearchIndex;
  projectGraphBuilder?: MainlineProjectGraphBuilder;
  languageService?: MainlineLanguageService;
  astParser?: MainlineAstParser;
  logger?: MainlineLogger;
  scheduler?: MainlineScheduler;
  concurrency?: MainlineConcurrencyLimiter;
  workerPool?: MainlineWorkerPool;
  capabilities?: MainlineCapabilityRegistry;
  workspacePaths?: MainlineWorkspacePaths;
  eventBus?: MainlineEventBus;
  writeBoundary?: MainlineWriteBoundary;
  fileStore?: MainlineAtomicFileStore;
  fileSystem?: MainlineFileSystemPort;
  fileWatcher?: MainlineFileWatcherPort;
  git?: MainlineGitPort;
  testMode?: MainlineTestModeConfig;
  directoryLock?: MainlineDirectoryLock;
  config?: MainlineConfigPort;
  jobLedger?: MainlineJobLedgerPort;
  disposer?: MainlineDisposer;
}

/**
 * MainlineKernel 是新主线的轻量装配根。
 * 它把环境、单例、日志、定时器、并发、路径、数据端口、语言端口集中到一起，
 * 但不承担旧 ServiceContainer 的模块注册和后台生命周期职责。
 */
export class MainlineKernel implements MainlineDisposable {
  readonly environment: MainlineEnvironment;
  readonly registry: MainlineSingletonRegistry;
  readonly contextIndex: ContextIndex;
  readonly database: MainlineDatabasePort;
  readonly searchIndex: MainlineSearchIndex;
  readonly projectGraphBuilder: MainlineProjectGraphBuilder;
  readonly languageService: MainlineLanguageService;
  readonly astParser: MainlineAstParser;
  readonly logger: MainlineLogger;
  readonly scheduler: MainlineScheduler;
  readonly concurrency: MainlineConcurrencyLimiter;
  readonly workerPool: MainlineWorkerPool;
  readonly capabilities: MainlineCapabilityRegistry;
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly eventBus: MainlineEventBus;
  readonly writeBoundary: MainlineWriteBoundary;
  readonly fileStore: MainlineAtomicFileStore;
  readonly fileSystem: MainlineFileSystemPort;
  readonly fileWatcher: MainlineFileWatcherPort;
  readonly git: MainlineGitPort;
  readonly testMode: MainlineTestModeConfig;
  readonly directoryLock: MainlineDirectoryLock;
  readonly config: MainlineConfigPort;
  readonly jobLedger: MainlineJobLedgerPort;
  readonly disposer: MainlineDisposer;

  constructor(options: MainlineKernelOptions = {}) {
    this.environment = options.environment ?? new MainlineEnvironment();
    this.registry = options.registry ?? new MainlineSingletonRegistry();
    this.contextIndex = options.contextIndex ?? new InMemoryContextIndex();
    this.database = options.database ?? new UnavailableMainlineDatabase();
    this.searchIndex = options.searchIndex ?? new InMemoryMainlineSearchIndex();
    this.projectGraphBuilder = options.projectGraphBuilder ?? new MainlineProjectGraphBuilder();
    this.languageService = options.languageService ?? new ExtensionLanguageService();
    this.astParser = options.astParser ?? new TreeSitterMainlineAstParser();
    this.logger = options.logger ?? new NoopMainlineLogger();
    this.scheduler = options.scheduler ?? new MainlineSchedulerImpl();
    this.concurrency = options.concurrency ?? new MainlineConcurrencyLimiter(4);
    this.workerPool = options.workerPool ?? new UnavailableWorkerPool();
    this.capabilities = options.capabilities ?? new MainlineCapabilityRegistry();
    this.workspacePaths =
      options.workspacePaths ??
      new MainlineWorkspacePaths({
        projectRoot: this.environment.get("ALEMBIC_PROJECT_DIR") ?? ".",
      });
    this.eventBus = options.eventBus ?? new MainlineEventBus();
    this.writeBoundary =
      options.writeBoundary ?? new MainlineWriteBoundary({ workspacePaths: this.workspacePaths });
    this.fileStore = options.fileStore ?? new MainlineAtomicFileStore();
    this.fileSystem = options.fileSystem ?? new NodeMainlineFileSystem();
    this.fileWatcher = options.fileWatcher ?? new UnavailableMainlineFileWatcher();
    this.git = options.git ?? new UnavailableMainlineGit();
    this.testMode = options.testMode ?? getMainlineTestModeConfig(this.environment);
    this.directoryLock = options.directoryLock ?? new MainlineDirectoryLock();
    this.config = options.config ?? new ObjectMainlineConfig({}, "mainline-default");
    this.jobLedger = options.jobLedger ?? new InMemoryMainlineJobLedger();
    this.disposer = options.disposer ?? new MainlineDisposer();

    this.#registerDefaults();
    this.#registerCapabilities();
  }

  async dispose(): Promise<void> {
    this.scheduler.dispose();
    this.workerPool.dispose();
    await this.disposer.dispose();
  }

  #registerDefaults(): void {
    this.registry.set("environment", this.environment);
    this.registry.set("logger", this.logger);
    this.registry.set("scheduler", this.scheduler);
    this.registry.set("concurrency", this.concurrency);
    this.registry.set("workerPool", this.workerPool);
    this.registry.set("capabilities", this.capabilities);
    this.registry.set("workspacePaths", this.workspacePaths);
    this.registry.set("eventBus", this.eventBus);
    this.registry.set("writeBoundary", this.writeBoundary);
    this.registry.set("fileStore", this.fileStore);
    this.registry.set("fileSystem", this.fileSystem);
    this.registry.set("fileWatcher", this.fileWatcher);
    this.registry.set("git", this.git);
    this.registry.set("testMode", this.testMode);
    this.registry.set("directoryLock", this.directoryLock);
    this.registry.set("config", this.config);
    this.registry.set("jobLedger", this.jobLedger);
    this.registry.set("disposer", this.disposer);
    this.registry.set("contextIndex", this.contextIndex);
    this.registry.set("database", this.database);
    this.registry.set("searchIndex", this.searchIndex);
    this.registry.set("projectGraphBuilder", this.projectGraphBuilder);
    this.registry.set("languageService", this.languageService);
    this.registry.set("astParser", this.astParser);
  }

  #registerCapabilities(): void {
    const databaseHealth = this.database.health();

    this.capabilities.set({
      id: "logger",
      layer: "core",
      status: "available",
      reason: "Mainline logger port is configured.",
    });
    this.capabilities.set({
      id: "scheduler",
      layer: "core",
      status: "available",
      reason: "Mainline scheduler is configured.",
      metadata: { ...this.scheduler.snapshot() },
    });
    this.capabilities.set({
      id: "concurrency",
      layer: "core",
      status: "available",
      reason: "Mainline concurrency limiter is configured.",
      metadata: { ...this.concurrency.snapshot() },
    });
    this.capabilities.set({
      id: "lifecycle",
      layer: "core",
      status: "available",
      reason: "Mainline disposer is configured.",
      metadata: { ...this.disposer.snapshot() },
    });
    this.capabilities.set({
      id: "event-bus",
      layer: "core",
      status: "available",
      reason: "Mainline event bus is configured.",
      metadata: { ...this.eventBus.snapshot() },
    });
    this.capabilities.set({
      id: "write-boundary",
      layer: "core",
      status: "available",
      reason: "Mainline write boundary is configured.",
    });
    this.capabilities.set({
      id: "file-store",
      layer: "core",
      status: "available",
      reason: "Mainline atomic file store is configured.",
    });
    this.capabilities.set({
      id: "file-system",
      layer: "core",
      status: "available",
      reason: "Mainline file system port is configured.",
    });
    this.capabilities.set({
      id: "file-watcher",
      layer: "core",
      status:
        this.fileWatcher instanceof UnavailableMainlineFileWatcher ? "unavailable" : "available",
      reason:
        this.fileWatcher instanceof UnavailableMainlineFileWatcher
          ? "Mainline file watcher adapter is not configured."
          : "Mainline file watcher adapter is configured.",
      metadata: { ...this.fileWatcher.snapshot() },
    });
    this.capabilities.set({
      id: "git",
      layer: "core",
      status: this.git instanceof UnavailableMainlineGit ? "unavailable" : "available",
      reason:
        this.git instanceof UnavailableMainlineGit
          ? "Mainline git adapter is not configured."
          : "Mainline git adapter is configured.",
    });
    this.capabilities.set({
      id: "markdown",
      layer: "core",
      status: "available",
      reason: "Mainline markdown parsing helpers are available.",
    });
    this.capabilities.set({
      id: "text-analysis",
      layer: "core",
      status: "available",
      reason: "Mainline text token and similarity helpers are available.",
    });
    this.capabilities.set({
      id: "project-markers",
      layer: "core",
      status: "available",
      reason: "Mainline project marker inspection is available.",
    });
    this.capabilities.set({
      id: "test-mode",
      layer: "core",
      status: "available",
      reason: "Mainline test-mode configuration is normalized.",
      metadata: { ...this.testMode },
    });
    this.capabilities.set({
      id: "directory-lock",
      layer: "core",
      status: "available",
      reason: "Mainline directory lock is configured.",
    });
    this.capabilities.set({
      id: "config",
      layer: "core",
      status: "available",
      reason: "Mainline config port is configured.",
      metadata: { source: this.config.source() },
    });
    this.capabilities.set({
      id: "operation-scope",
      layer: "core",
      status: "available",
      reason: "Mainline operation scope can create per-task cancellation boundaries.",
    });
    this.capabilities.set({
      id: "domain-models",
      layer: "knowledge",
      status: "available",
      reason: "Core business objects are available.",
      metadata: {
        models: [
          "SourceRef",
          "Recipe",
          "RecipeEdge",
          "EvidencePackage",
          "ContextBundle",
          "GuardFinding",
          "DimensionLens",
        ],
      },
    });
    this.capabilities.set({
      id: "context-index",
      layer: "data",
      status: "available",
      reason: "Mainline ContextIndex port is configured.",
    });
    this.capabilities.set({
      id: "job-ledger",
      layer: "data",
      status: "available",
      reason: "Mainline job ledger port is configured.",
    });
    this.capabilities.set({
      id: "file-fingerprint-snapshots",
      layer: "data",
      status: "available",
      reason: "Mainline file fingerprint snapshot store contract is available.",
    });
    this.capabilities.set({
      id: "database",
      layer: "data",
      status: databaseHealth.available ? "available" : "unavailable",
      reason: databaseHealth.reason ?? "Mainline database adapter is configured.",
      metadata: {
        driver: databaseHealth.driver,
        ...(databaseHealth.path === undefined ? {} : { path: databaseHealth.path }),
      },
    });
    this.capabilities.set({
      id: "search-index",
      layer: "search",
      status: "available",
      reason: "Mainline deterministic search index is configured.",
    });
    this.capabilities.set({
      id: "project-graph",
      layer: "graph",
      status: "available",
      reason: "Mainline project graph builder is configured.",
    });
    this.capabilities.set({
      id: "language-service",
      layer: "code",
      status: "available",
      reason: "Extension-based language detection is configured.",
    });
    this.capabilities.set({
      id: "ast-parser",
      layer: "code",
      status: this.astParser instanceof UnavailableAstParser ? "unavailable" : "available",
      reason:
        this.astParser instanceof UnavailableAstParser
          ? "Mainline AST parser adapter is not configured."
          : "Mainline AST parser adapter is configured.",
    });
    this.capabilities.set({
      id: "diff-parser",
      layer: "compile",
      status: "available",
      reason: "Mainline unified diff parser is available.",
    });
    this.capabilities.set({
      id: "incremental-evidence-compiler",
      layer: "compile",
      status: "available",
      reason: "Mainline incremental evidence compiler is available.",
    });
    this.capabilities.set({
      id: "content-mining-runner",
      layer: "compile",
      status: "available",
      reason: "Mainline content mining runner is available.",
    });
    this.capabilities.set({
      id: "worker-pool",
      layer: "core",
      status: this.workerPool instanceof UnavailableWorkerPool ? "unavailable" : "available",
      reason:
        this.workerPool instanceof UnavailableWorkerPool
          ? "Mainline worker pool adapter is not configured."
          : "Mainline worker pool adapter is configured.",
    });
    this.capabilities.set({
      id: "workspace-paths",
      layer: "core",
      status: "available",
      metadata: { ...this.workspacePaths.snapshot() },
    });
    this.capabilities.set({
      id: "path-identity",
      layer: "core",
      status: "available",
      reason: "Mainline path identity uses project-relative POSIX paths.",
    });
    this.capabilities.set({
      id: "active-work-context-builder",
      layer: "runtime",
      status: "available",
      reason: "Mainline active work context builder is available.",
    });
    this.capabilities.set({
      id: "knowledge-injection-runner",
      layer: "agent",
      status: "available",
      reason: "Mainline knowledge injection runner is available.",
    });
    this.capabilities.set({
      id: "ide-surface",
      layer: "surface",
      status: "available",
      reason: "Mainline IDE artifact manifests are available.",
    });
    this.capabilities.set({
      id: "plugin-surface",
      layer: "surface",
      status: "available",
      reason: "Mainline plugin, MCP, and Skill manifest helpers are available.",
    });
  }
}
