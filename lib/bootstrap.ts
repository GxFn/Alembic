import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Constitution from './core/constitution/Constitution.js';
import ConstitutionValidator from './core/constitution/ConstitutionValidator.js';
import Gateway from './core/gateway/Gateway.js';
import PermissionManager from './core/permission/PermissionManager.js';
import AuditLogger from './infrastructure/audit/AuditLogger.js';
import AuditStore from './infrastructure/audit/AuditStore.js';
import ConfigLoader from './infrastructure/config/ConfigLoader.js';
import DatabaseConnection from './infrastructure/database/DatabaseConnection.js';
import Logger from './infrastructure/logging/Logger.js';
import { SkillHooks } from './service/skills/SkillHooks.js';
import pathGuard from './shared/PathGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Bootstrap - 应用程序启动器
 */
export class Bootstrap {
  components: any;
  options: any;
  constructor(options: any = {}) {
    this.options = options;
    this.components = {};
  }

  /**
   * 配置 PathGuard 路径安全守卫
   * 必须在任何文件写操作前调用
   * @param {string} projectRoot 用户项目的绝对路径
   * @param {string} [knowledgeBaseDir] 知识库目录名（如 'AutoSnippet'）
   */
  static configurePathGuard(projectRoot, knowledgeBaseDir?) {
    if (!pathGuard.configured && projectRoot) {
      const packageRoot = path.resolve(__dirname, '..');
      pathGuard.configure({ projectRoot, packageRoot, knowledgeBaseDir });
    } else if (knowledgeBaseDir) {
      // 已配置但知识库目录名可能后续才知道
      pathGuard.setKnowledgeBaseDir(knowledgeBaseDir);
    }
  }

  /**
   * 初始化应用程序
   */
  async initialize() {
    const startTime = Date.now();

    try {
      // 0. 加载 .env 环境变量（仅在未加载过时执行）
      await this.loadDotEnv();

      // 1. 加载配置
      await this.loadConfig();

      // 2. 初始化日志系统
      await this.initializeLogger();

      this.components.logger.info('AutoSnippet - Starting initialization...');

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
      this.components.logger.info(`AutoSnippet initialized successfully (${duration}ms)`);

      return this.components;
    } catch (error: any) {
      console.error('Failed to initialize AutoSnippet:', error);
      throw error;
    }
  }

  /**
   * 加载 .env 文件（dotenv），不覆盖已有环境变量
   */
  async loadDotEnv() {
    try {
      // 沿目录树向上查找 .env：cwd → AutoSnippet 包根 → 用户项目根
      const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(__dirname, '..', '.env'), // AutoSnippet 包根
      ];
      for (const envPath of candidates) {
        if (existsSync(envPath)) {
          const dotenv = await import('dotenv');
          dotenv.config({ path: envPath, override: false });
          break;
        }
      }
    } catch {
      // dotenv 可选依赖，加载失败不阻塞启动
    }
  }

  /**
   * 加载配置
   */
  async loadConfig() {
    const env = this.options.env || process.env.NODE_ENV || 'development';
    ConfigLoader.load(env);
    this.components.config = ConfigLoader;
  }

  /**
   * 初始化日志系统
   */
  async initializeLogger() {
    const config = this.components.config.get('logging');
    const logger = Logger.getInstance(config);
    this.components.logger = logger;
  }

  /**
   * 初始化数据库
   */
  async initializeDatabase() {
    const dbConfig = this.components.config.get('database');
    const db = new DatabaseConnection(dbConfig);
    await db.connect();
    await db.runMigrations();
    this.components.db = db;
    this.components.logger.info('Database connected and migrated');
  }

  /**
   * 加载宪法
   */
  async loadConstitution() {
    const constitutionPath = path.join(__dirname, '../config/constitution.yaml');
    const constitution = new Constitution(constitutionPath);
    this.components.constitution = constitution;
    this.components.logger.info('Constitution loaded', constitution.toJSON());
  }

  /**
   * 初始化核心组件
   */
  async initializeCoreComponents() {
    const { constitution, db, logger } = this.components;

    // Constitution Validator
    const constitutionValidator = new ConstitutionValidator(constitution);
    this.components.constitutionValidator = constitutionValidator;
    logger.info('ConstitutionValidator initialized');

    // Permission Manager
    const permissionManager = new PermissionManager(constitution);
    this.components.permissionManager = permissionManager;
    logger.info('PermissionManager initialized');

    // Audit System
    const auditStore = new AuditStore(db);
    const auditLogger = new AuditLogger(auditStore);
    this.components.auditStore = auditStore;
    this.components.auditLogger = auditLogger;
    logger.info('Audit system initialized');

    // Skill Hooks (扫描 skills/*/hooks.js + AutoSnippet/skills/*/hooks.js)
    const skillHooks = new SkillHooks();
    await skillHooks.load();
    this.components.skillHooks = skillHooks;
  }

  /**
   * 初始化网关
   */
  async initializeGateway() {
    const gatewayConfig = this.components.config.has('gateway')
      ? this.components.config.get('gateway')
      : {};
    const gateway = new Gateway(gatewayConfig);

    // 注入依赖
    gateway.setDependencies({
      constitution: this.components.constitution,
      constitutionValidator: this.components.constitutionValidator,
      permissionManager: this.components.permissionManager,
      auditLogger: this.components.auditLogger,
    });

    this.components.gateway = gateway;
    this.components.logger.info('Gateway initialized');
  }

  /**
   * 关闭应用程序
   */
  async shutdown() {
    this.components.logger?.info('AutoSnippet - Shutting down...');

    // 关闭数据库连接
    if (this.components.db) {
      await this.components.db.close();
    }

    this.components.logger?.info('AutoSnippet - Shutdown complete');
  }

  /**
   * 获取组件
   */
  getComponent(name) {
    return this.components[name];
  }

  /**
   * 获取所有组件
   */
  getAllComponents() {
    return this.components;
  }
}

export default Bootstrap;
