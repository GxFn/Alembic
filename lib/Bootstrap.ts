import { existsSync, readFileSync } from 'node:fs';
import { DatabaseConnection } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import { unwrapRawDb } from '@alembic/core/search';
import { WorkspaceSettingsStore } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import Gateway, { type GatewayConfig } from './governance/gateway/Gateway.js';
import AuditLogger from './infrastructure/audit/AuditLogger.js';
import AuditStore from './infrastructure/audit/AuditStore.js';
import ConfigLoader from './infrastructure/config/AppConfigLoader.js';
import { resolveAlembicWorkspace } from './project-scope/ProjectScopeRegistry.js';
import {
  dispatchStrictExternalSetupStartup,
  executeStrictExternalSetupReset,
  prepareStrictExternalSetupFromEnvironment,
  recoverStrictExternalSetup,
  releaseStrictExternalSetupSession,
  type StrictExternalSetupSession,
} from './recipe-pipeline/generate/strict/StrictExternalSetupRecovery.js';
import { SkillHooks } from './service/skills/SkillHooks.js';
import { PACKAGE_ROOT } from './shared/package-assets.js';

/** AppRuntime - 应用程序启动器 */
/** AppRuntime 初始化选项 */
interface AppRuntimeOptions {
  configPath?: string;
  dbPath?: string;
  logLevel?: string;
  [key: string]: unknown;
}

/** AppRuntime 管理的组件集合 */
export type AppRuntimeStartupDisposition =
  | 'initializing'
  | 'runtime-ready'
  | 'startup-action-completed';

export interface AppRuntimeComponents {
  startupDisposition: AppRuntimeStartupDisposition;
  strictExternalStartupAction?: 'recover' | 'complete';
  config?: typeof ConfigLoader;
  logger?: ReturnType<typeof Logger.getInstance>;
  db?: InstanceType<typeof DatabaseConnection>;
  auditStore?: InstanceType<typeof AuditStore>;
  auditLogger?: InstanceType<typeof AuditLogger>;
  gateway?: InstanceType<typeof Gateway>;
  skillHooks?: InstanceType<typeof SkillHooks>;
  workspaceResolver?: WorkspaceResolver;
  strictExternalSetup?: StrictExternalSetupSession;
  [key: string]: unknown;
}

export class AppRuntime {
  components: AppRuntimeComponents;
  options: AppRuntimeOptions;
  #strictDeferredLoggerConfig: Parameters<typeof Logger.getInstance>[0] | null = null;
  constructor(options: AppRuntimeOptions = {}) {
    this.options = options;
    this.components = { startupDisposition: 'initializing' };
  }

  #requireComponent<K extends keyof AppRuntimeComponents>(
    name: K
  ): NonNullable<AppRuntimeComponents[K]> {
    const component = this.components[name];
    if (component == null) {
      throw new Error(`[Bootstrap] Component not initialized: ${String(name)}`);
    }
    return component as NonNullable<AppRuntimeComponents[K]>;
  }

  /**
   * 配置 PathGuard 路径安全守卫
   * 必须在任何文件写操作前调用
   * @param projectRoot 用户项目的绝对路径
   * @param [knowledgeBaseDir] 知识库目录名（如 'Alembic'）
   */
  static configurePathGuard(projectRoot: string, knowledgeBaseDir?: string) {
    if (!pathGuard.configured && projectRoot) {
      pathGuard.configure({
        projectRoot,
        packageRoot: PACKAGE_ROOT,
        knowledgeBaseDir,
        extraProjectWritableFiles: ['.env'],
      });
    } else if (knowledgeBaseDir) {
      // 已配置但知识库目录名可能后续才知道
      pathGuard.setKnowledgeBaseDir(knowledgeBaseDir);
    }
  }

  /** 初始化应用程序 */
  async initialize() {
    const startTime = Date.now();

    try {
      // 0. 加载工作区设置；显式进程环境变量优先
      await this.loadRuntimeSettings();

      // 0.5 确保 PathGuard 已配置（如果调用方未提前配置）
      // MCP 服务器会在 initialize() 之前配置，但 CLI/测试可能跳过
      if (!pathGuard.configured) {
        const isMcpMode = process.env.ALEMBIC_MCP_MODE === '1';
        const projectRoot =
          process.env.ALEMBIC_PROJECT_DIR || (isMcpMode ? undefined : process.cwd());
        if (!projectRoot) {
          throw new Error(
            '[Bootstrap] 缺少 ALEMBIC_PROJECT_DIR 环境变量，且 PathGuard 未提前配置。'
          );
        }
        AppRuntime.configurePathGuard(projectRoot);
      }

      // 0.8 创建 WorkspaceResolver（Ghost 模式感知的路径解析器）
      this.initializeWorkspaceResolver();

      // 0.9 严格生产的外部 setup authority 必须先于任何目标根日志/数据库写入。
      if (!(await this.initializeStrictExternalSetup())) {
        return this.components;
      }

      // 1. 加载配置
      await this.loadConfig();

      // 2. 初始化日志系统
      await this.initializeLogger();

      const logger = this.#requireComponent('logger');
      logger.info('Alembic - Starting initialization...');

      // 3. 连接数据库
      await this.initializeDatabase();

      // 4. 初始化核心组件
      await this.initializeCoreComponents();

      // 5. 初始化网关
      await this.initializeGateway();

      // 6. 注册路由（稍后由各服务注册）
      // await this.registerRoutes();

      const duration = Date.now() - startTime;
      logger.info(`Alembic initialized successfully (${duration}ms)`);

      this.components.startupDisposition = 'runtime-ready';
      return this.components;
    } catch (error: unknown) {
      console.error('Failed to initialize Alembic:', error);
      const recoveryFailure = await this.recoverStrictExternalSetupAfterFailure();
      if (recoveryFailure) {
        throw new AggregateError(
          [error, recoveryFailure],
          'STRICT_SETUP_INITIALIZATION_RECOVERY_FAILED'
        );
      }
      throw error;
    }
  }

  /** 加载工作区设置，不覆盖用户显式传入的进程环境变量 */
  async loadRuntimeSettings() {
    try {
      const projectRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
      WorkspaceSettingsStore.fromProject(projectRoot).applyToProcessEnv({ override: false });
      applyLocalEmbeddingConfigToProcessEnv(projectRoot);
    } catch {
      /* settings unreadable — keep explicit process env only */
    }
  }

  /** 加载配置 */
  async loadConfig() {
    const env = (this.options.env as string) || process.env.NODE_ENV || 'development';
    ConfigLoader.load(env);
    this.components.config = ConfigLoader;
  }

  /** 初始化日志系统 */
  async initializeLogger() {
    const configLoader = this.#requireComponent('config');
    const config = configLoader.get('logging') as Parameters<typeof Logger.getInstance>[0];
    // Ghost 模式：将日志路径重定向到外置工作区
    const resolver = this.components.workspaceResolver;
    if (resolver?.ghost && config?.file) {
      config.file.path = resolver.logsDir;
    }
    const logger = this.components.strictExternalSetup
      ? Logger.getInstance({
          ...config,
          console: false,
          file: config?.file ? { ...config.file, enabled: false } : undefined,
        })
      : Logger.getInstance(config);
    if (this.components.strictExternalSetup) {
      this.#strictDeferredLoggerConfig = config;
    }
    this.components.logger = logger;
  }

  /** 初始化数据库 */
  async initializeDatabase() {
    const configLoader = this.#requireComponent('config');
    const dbConfig = configLoader.get('database') as ConstructorParameters<
      typeof DatabaseConnection
    >[0];
    const db = new DatabaseConnection(dbConfig, this.components.workspaceResolver);
    await db.connect();
    this.components.db = db;
    if (this.components.strictExternalSetup) {
      await executeStrictExternalSetupReset({
        database: db,
        session: this.components.strictExternalSetup,
      });
    }
    await db.runMigrations();
    if (this.#strictDeferredLoggerConfig) {
      this.components.logger = Logger.getInstance(this.#strictDeferredLoggerConfig);
      this.#strictDeferredLoggerConfig = null;
    }
    this.#requireComponent('logger').info('Database connected and migrated');
  }

  /** 初始化核心组件 */
  async initializeCoreComponents() {
    const db = this.#requireComponent('db');
    const logger = this.#requireComponent('logger');

    // Audit System
    const auditStore = new AuditStore(db);
    const auditLogger = new AuditLogger(auditStore);
    this.components.auditStore = auditStore;
    this.components.auditLogger = auditLogger;
    logger.info('Audit system initialized');

    // Skill Hooks (扫描 skills/*/hooks.js + Alembic/skills/*/hooks.js)
    const skillHooks = new SkillHooks();
    await skillHooks.load();
    this.components.skillHooks = skillHooks;
    logger.info('Skill hooks loaded');
  }

  /** 初始化网关 */
  async initializeGateway() {
    const configLoader = this.#requireComponent('config');
    const gatewayConfig = configLoader.has('gateway')
      ? (configLoader.get('gateway') as GatewayConfig)
      : undefined;
    const gateway = new Gateway(gatewayConfig);

    // 注入依赖
    gateway.setDependencies({
      auditLogger: this.components.auditLogger,
    });

    this.components.gateway = gateway;
    this.#requireComponent('logger').info('Gateway initialized');
  }

  /**
   * 初始化 WorkspaceResolver
   * 从 ProjectRegistry 自动检测 Ghost 模式，配置路径解析器
   */
  initializeWorkspaceResolver() {
    const projectRoot = pathGuard.projectRoot;
    if (!projectRoot) {
      return; // PathGuard 未配置时跳过
    }
    const resolver = resolveAlembicWorkspace(projectRoot);
    this.components.workspaceResolver = resolver;

    // Ghost 模式：将外置工作区目录加入 PathGuard 白名单
    if (resolver.ghost) {
      pathGuard.addAllowPath(resolver.dataRoot);
    }
  }

  async initializeStrictExternalSetup() {
    const resolver = this.components.workspaceResolver;
    if (!resolver) {
      return true;
    }
    const session = await prepareStrictExternalSetupFromEnvironment({
      dataRoot: resolver.dataRoot,
      projectRoot: resolver.projectRoot,
    });
    if (!session) {
      return true;
    }
    this.components.strictExternalSetup = session;
    const startup = await dispatchStrictExternalSetupStartup(session);
    this.components.strictExternalBootstrapReceipt = startup.receipt;
    if (!startup.startRuntime) {
      if (session.action === 'execute') {
        throw new Error('STRICT_SETUP_EXECUTE_STARTUP_DISPOSITION_INVALID');
      }
      delete this.components.strictExternalSetup;
      this.components.strictExternalStartupAction = session.action;
      this.components.startupDisposition = 'startup-action-completed';
    }
    return startup.startRuntime;
  }

  async recoverStrictExternalSetupAfterFailure(): Promise<unknown | null> {
    const session = this.components.strictExternalSetup;
    if (!session || session.action !== 'execute') {
      return null;
    }
    try {
      this.components.db?.close();
    } catch {
      // Recovery readback below remains authoritative.
    }
    try {
      await recoverStrictExternalSetup(session);
      await releaseStrictExternalSetupSession();
      return null;
    } catch (error: unknown) {
      return error;
    }
  }

  /** 关闭应用程序 */
  async shutdown(options: { failClosedCheckpoint?: boolean } = {}) {
    if (!options.failClosedCheckpoint) {
      this.components.logger?.info('Alembic - Shutting down...');
    }

    // 关闭数据库连接（WAL checkpoint → close）
    if (this.components.db) {
      let strictCheckpointFailure: unknown = null;
      try {
        // 刷盘 WAL — 确保所有待写入数据持久化后再关闭
        const rawDb = unwrapRawDb(this.components.db as unknown) as InstanceType<
          typeof DatabaseConnection
        > & { pragma: (cmd: string) => unknown };
        const checkpoint = rawDb.pragma('wal_checkpoint(TRUNCATE)');
        if (options.failClosedCheckpoint && !isTerminalWalCheckpoint(checkpoint)) {
          throw new Error('STRICT_QUIESCE_CHECKPOINT_NONTERMINAL');
        }
      } catch (error: unknown) {
        if (options.failClosedCheckpoint) {
          strictCheckpointFailure = error;
        }
        // Ordinary shutdown preserves the existing best-effort checkpoint behavior.
      }
      try {
        this.components.db.close();
      } catch (error: unknown) {
        if (strictCheckpointFailure) {
          throw new AggregateError(
            [strictCheckpointFailure, error],
            'STRICT_QUIESCE_CHECKPOINT_AND_CLOSE_FAILED'
          );
        }
        throw error;
      }
      if (strictCheckpointFailure) {
        throw new Error('STRICT_QUIESCE_CHECKPOINT_FAILED', {
          cause: strictCheckpointFailure,
        });
      }
    }

    await releaseStrictExternalSetupSession();

    if (!options.failClosedCheckpoint) {
      this.components.logger?.info('Alembic - Shutdown complete');
    }
  }

  /** 获取组件 */
  getComponent(name: string) {
    return this.components[name];
  }

  /** 获取所有组件 */
  getAllComponents() {
    return this.components;
  }
}

function isTerminalWalCheckpoint(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) {
    return false;
  }
  const row = value[0];
  return (
    typeof row === 'object' &&
    row !== null &&
    Number((row as { busy?: unknown }).busy) === 0 &&
    Number((row as { log?: unknown }).log) === 0 &&
    Number((row as { checkpointed?: unknown }).checkpointed) === 0
  );
}

function applyLocalEmbeddingConfigToProcessEnv(projectRoot: string): void {
  if (process.env.ALEMBIC_EMBED_PROVIDER !== undefined) {
    return;
  }
  const env = readLocalEmbeddingConfigEnv(projectRoot);
  if (!env.ALEMBIC_EMBED_PROVIDER) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readLocalEmbeddingConfigEnv(projectRoot: string): Record<string, string> {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  if (!existsSync(resolver.configPath)) {
    return {};
  }
  const config = asRecord(JSON.parse(readFileSync(resolver.configPath, 'utf8')));
  const localEmbedding = asRecord(asRecord(config.vector).localEmbedding);
  if (localEmbedding.enabled !== true) {
    return {};
  }

  const env: Record<string, string> = {
    ALEMBIC_EMBED_PROVIDER: 'ollama',
  };
  const model = stringValue(localEmbedding.model);
  const endpoint = stringValue(localEmbedding.endpoint);
  if (model) {
    env.ALEMBIC_EMBED_MODEL = model;
  }
  if (endpoint) {
    env.ALEMBIC_EMBED_BASE_URL = endpoint;
  }
  return env;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export { AppRuntime as Bootstrap };
export default AppRuntime;
