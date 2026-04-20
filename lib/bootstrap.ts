import { existsSync } from 'node:fs';
import path from 'node:path';
import Constitution from './core/constitution/Constitution.js';
import ConstitutionValidator from './core/constitution/ConstitutionValidator.js';
import Gateway, { type GatewayConfig } from './core/gateway/Gateway.js';
import PermissionManager from './core/permission/PermissionManager.js';
import AuditLogger from './infrastructure/audit/AuditLogger.js';
import AuditStore from './infrastructure/audit/AuditStore.js';
import ConfigLoader from './infrastructure/config/ConfigLoader.js';
import DatabaseConnection from './infrastructure/database/DatabaseConnection.js';
import Logger from './infrastructure/logging/Logger.js';
import { unwrapRawDb } from './repository/search/SearchRepoAdapter.js';
import { SkillHooks } from './service/skills/SkillHooks.js';
import pathGuard from './shared/PathGuard.js';
import { getGhostWorkspaceDir, ProjectRegistry } from './shared/ProjectRegistry.js';
import { CONFIG_DIR, PACKAGE_ROOT } from './shared/package-root.js';
import { WorkspaceResolver } from './shared/WorkspaceResolver.js';

/** Bootstrap - 应用程序启动器 */
/** Bootstrap 初始化选项 */
interface BootstrapOptions {
  configPath?: string;
  dbPath?: string;
  logLevel?: string;
  [key: string]: unknown;
}

/** Bootstrap 管理的组件集合 */
interface BootstrapComponents {
  config?: typeof ConfigLoader;
  logger?: ReturnType<typeof Logger.getInstance>;
  db?: InstanceType<typeof DatabaseConnection>;
  constitution?: InstanceType<typeof Constitution>;
  constitutionValidator?: InstanceType<typeof ConstitutionValidator>;
  permissionManager?: InstanceType<typeof PermissionManager>;
  auditStore?: InstanceType<typeof AuditStore>;
  auditLogger?: InstanceType<typeof AuditLogger>;
  gateway?: InstanceType<typeof Gateway>;
  skillHooks?: InstanceType<typeof SkillHooks>;
  workspaceResolver?: WorkspaceResolver;
  [key: string]: unknown;
}

export class Bootstrap {
  components: BootstrapComponents;
  options: BootstrapOptions;
  constructor(options: BootstrapOptions = {}) {
    this.options = options;
    this.components = {};
  }

  /**
   * 配置 PathGuard 路径安全守卫
   * 必须在任何文件写操作前调用
   * @param projectRoot 用户项目的绝对路径
   * @param [knowledgeBaseDir] 知识库目录名（如 'Alembic'）
   */
  static configurePathGuard(projectRoot: string, knowledgeBaseDir?: string) {
    if (!pathGuard.configured && projectRoot) {
      pathGuard.configure({ projectRoot, packageRoot: PACKAGE_ROOT, knowledgeBaseDir });
    } else if (knowledgeBaseDir) {
      // 已配置但知识库目录名可能后续才知道
      pathGuard.setKnowledgeBaseDir(knowledgeBaseDir);
    }
  }

  /** 初始化应用程序 */
  async initialize() {
    const startTime = Date.now();

    try {
      // 0. 加载 .env 环境变量（仅在未加载过时执行）
      await this.loadDotEnv();

      // 0.5 确保 PathGuard 已配置（如果调用方未提前配置）
      // MCP 服务器会在 initialize() 之前配置，但 CLI/测试可能跳过
      if (!pathGuard.configured) {
        const isMcpMode = process.env.ALEMBIC_MCP_MODE === '1';
        const projectRoot =
          process.env.ALEMBIC_PROJECT_DIR || (isMcpMode ? undefined : process.cwd());
        if (!projectRoot) {
          throw new Error(
            '[Bootstrap] MCP 模式下缺少 ALEMBIC_PROJECT_DIR 环境变量，' +
              '且 PathGuard 未提前配置。请在 .vscode/mcp.json 中设置 ALEMBIC_PROJECT_DIR。'
          );
        }
        Bootstrap.configurePathGuard(projectRoot);
      }

      // 0.8 创建 WorkspaceResolver（Ghost 模式感知的路径解析器）
      this.initializeWorkspaceResolver();

      // 1. 加载配置
      await this.loadConfig();

      // 2. 初始化日志系统
      await this.initializeLogger();

      this.components.logger!.info('Alembic - Starting initialization...');

      // 3. 连接数据库
      await this.initializeDatabase();

      // 4. 加载宪法
      await this.loadConstitution();

      // 5. 初始化核心组件
      await this.initializeCoreComponents();

      // 6. 初始化网关
      await this.initializeGateway();

      // 7. 注册路由（稍后由各服务注册）
      // await this.registerRoutes();

      const duration = Date.now() - startTime;
      this.components.logger!.info(`Alembic initialized successfully (${duration}ms)`);

      return this.components;
    } catch (error: unknown) {
      console.error('Failed to initialize Alembic:', error);
      throw error;
    }
  }

  /** 加载 .env 文件（dotenv），不覆盖已有环境变量 */
  async loadDotEnv() {
    try {
      const projectRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();
      const candidates = [path.resolve(projectRoot, '.env'), path.resolve(PACKAGE_ROOT, '.env')];

      // Ghost 模式：.env 在 ~/.asd/workspaces/<id>/.env
      try {
        const entry = ProjectRegistry.get(projectRoot);
        if (entry?.ghost) {
          candidates.unshift(path.join(getGhostWorkspaceDir(entry.id), '.env'));
        }
      } catch {
        /* registry unreadable — continue with standard candidates */
      }

      for (const envPath of candidates) {
        if (existsSync(envPath)) {
          const dotenv = await import('dotenv');
          dotenv.config({ path: envPath, override: false, quiet: true });
          break;
        }
      }
    } catch {
      // dotenv 可选依赖，加载失败不阻塞启动
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
    const config = this.components.config!.get('logging') as Parameters<
      typeof Logger.getInstance
    >[0];
    // Ghost 模式：将日志路径重定向到外置工作区
    const resolver = this.components.workspaceResolver;
    if (resolver?.ghost && config?.file) {
      config.file.path = resolver.logsDir;
    }
    const logger = Logger.getInstance(config);
    this.components.logger = logger;
  }

  /** 初始化数据库 */
  async initializeDatabase() {
    const dbConfig = this.components.config!.get('database') as ConstructorParameters<
      typeof DatabaseConnection
    >[0];
    const db = new DatabaseConnection(dbConfig, this.components.workspaceResolver);
    await db.connect();
    await db.runMigrations();
    this.components.db = db;
    this.components.logger!.info('Database connected and migrated');
  }

  /** 加载宪法 */
  async loadConstitution() {
    const constitutionPath = path.join(CONFIG_DIR, 'constitution.yaml');
    const constitution = new Constitution(constitutionPath);
    this.components.constitution = constitution;
    this.components.logger!.info('Constitution loaded', constitution.toJSON());
  }

  /** 初始化核心组件 */
  async initializeCoreComponents() {
    const { constitution, db, logger } = this.components;

    // Constitution Validator
    const constitutionValidator = new ConstitutionValidator(constitution!);
    this.components.constitutionValidator = constitutionValidator;
    logger!.info('ConstitutionValidator initialized');

    // Permission Manager
    const permissionManager = new PermissionManager(constitution!);
    this.components.permissionManager = permissionManager;
    logger!.info('PermissionManager initialized');

    // Audit System
    const auditStore = new AuditStore(db!);
    const auditLogger = new AuditLogger(auditStore);
    this.components.auditStore = auditStore;
    this.components.auditLogger = auditLogger;
    logger!.info('Audit system initialized');

    // Skill Hooks (扫描 skills/*/hooks.js + Alembic/skills/*/hooks.js)
    const skillHooks = new SkillHooks();
    await skillHooks.load();
    this.components.skillHooks = skillHooks;
    logger!.info('Skill hooks loaded');
  }

  /** 初始化网关 */
  async initializeGateway() {
    const gatewayConfig = this.components.config!.has('gateway')
      ? (this.components.config!.get('gateway') as GatewayConfig)
      : undefined;
    const gateway = new Gateway(gatewayConfig);

    // 注入依赖
    gateway.setDependencies({
      constitution: this.components.constitution,
      constitutionValidator: this.components.constitutionValidator,
      permissionManager: this.components.permissionManager,
      auditLogger: this.components.auditLogger,
    });

    this.components.gateway = gateway;
    this.components.logger!.info('Gateway initialized');
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
    const resolver = WorkspaceResolver.fromProject(projectRoot);
    this.components.workspaceResolver = resolver;

    // Ghost 模式：将外置工作区目录加入 PathGuard 白名单
    if (resolver.ghost) {
      pathGuard.addAllowPath(resolver.dataRoot);
    }
  }

  /** 关闭应用程序 */
  async shutdown() {
    this.components.logger?.info('Alembic - Shutting down...');

    // 关闭数据库连接（WAL checkpoint → close）
    if (this.components.db) {
      try {
        // 刷盘 WAL — 确保所有待写入数据持久化后再关闭
        const rawDb = unwrapRawDb(this.components.db as unknown) as InstanceType<
          typeof DatabaseConnection
        > & { pragma: (cmd: string) => void };
        rawDb.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // WAL checkpoint 失败不阻断 shutdown
      }
      this.components.db.close();
    }

    this.components.logger?.info('Alembic - Shutdown complete');
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

export default Bootstrap;
