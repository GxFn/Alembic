/**
 * HTTP Server - Alembic 2.0
 * 基于 Express 框架的 REST API 服务器
 * 集成监控、缓存和错误追踪
 */

import type { Server } from 'node:http';
import { join } from 'node:path';
import cors from 'cors';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { CapabilityProbe } from '../core/capability/CapabilityProbe.js';
import { registerGatewayActions } from '../core/gateway/GatewayActionRegistry.js';
import { initCacheAdapter } from '../infrastructure/cache/UnifiedCacheAdapter.js';
import Logger from '../infrastructure/logging/Logger.js';
import { type ErrorTracker, initErrorTracker } from '../infrastructure/monitoring/ErrorTracker.js';
import { initPerformanceMonitor } from '../infrastructure/monitoring/PerformanceMonitor.js';
import { initRealtimeService } from '../infrastructure/realtime/RealtimeService.js';
import { getServiceContainer } from '../injection/ServiceContainer.js';
import { resolveDataRoot } from '../shared/resolveProjectRoot.js';
import apiSpec from './api-spec.js';
import { errorHandler } from './middleware/errorHandler.js';
import { gatewayMiddleware } from './middleware/gatewayMiddleware.js';
import { requestLogger } from './middleware/requestLogger.js';
import { roleResolverMiddleware } from './middleware/roleResolver.js';
import aiRouter from './routes/ai.js';
import auditRouter from './routes/audit.js';
import authRouter from './routes/auth.js';
import candidatesRouter from './routes/candidates.js';
import commandsRouter from './routes/commands.js';
import evolutionRouter from './routes/evolution.js';
import extractRouter from './routes/extract.js';
import fileChangesRouter from './routes/file-changes.js';
import guardRouter from './routes/guard.js';
import guardReportRouter from './routes/guardReport.js';
import guardRuleRouter from './routes/guardRules.js';
import healthRouter from './routes/health.js';
import knowledgeRouter from './routes/knowledge.js';
import logsRouter from './routes/logs.js';
import modulesRouter from './routes/modules.js';
import monitoringRouter from './routes/monitoring.js';
import panoramaRouter from './routes/panorama.js';
import recipesRouter from './routes/recipes.js';
import remoteRouter from './routes/remote.js';
import searchRouter from './routes/search.js';
import signalsRouter from './routes/signals.js';
import skillsRouter from './routes/skills.js';
import taskRouter from './routes/task.js';
import violationsRouter from './routes/violations.js';
import wikiRouter from './routes/wiki.js';

interface HttpServerConfig {
  port: number;
  host: string;
  enableMonitoring: boolean;
  cacheMode: string;
  corsOrigin?: string;
  [key: string]: unknown;
}

/** Express internal router layer shape (private API, used in mountDashboard) */
type RouterLayer = { route?: unknown };

/** Type for the winston Logger instance returned by Logger.getInstance() */
type AppLogger = ReturnType<typeof Logger.getInstance>;

export class HttpServer {
  app: Application;
  cacheAdapter: unknown;
  capabilityProbe: CapabilityProbe | null;
  config: HttpServerConfig;
  errorTracker: ErrorTracker | null;
  logger: AppLogger;
  performanceMonitor: { middleware(): express.RequestHandler; shutdown(): void } | null;
  realtimeService: Record<string, unknown> | null;
  server: Server | null;
  constructor(config: Partial<HttpServerConfig> = {}) {
    this.config = {
      port: config.port || 3000,
      host: config.host || 'localhost',
      enableMonitoring: config.enableMonitoring !== false,
      cacheMode: 'memory',
      ...config,
    } as HttpServerConfig;

    this.logger = Logger.getInstance();
    this.app = express();
    this.server = null;
    this.performanceMonitor = null;
    this.errorTracker = null;
    this.cacheAdapter = null;
    this.realtimeService = null;
    this.capabilityProbe = null;
  }

  /** 初始化服务器 */
  async initialize() {
    // 初始化监控和缓存服务
    await this.initializeServices();

    // 注册 Gateway Actions（将 Service 操作绑定到 Gateway 路由）
    this.registerGatewayActions();

    // 中间件
    this.setupMiddleware();

    // 路由
    this.setupRoutes();

    // 错误处理
    this.setupErrorHandling();

    this.logger.info('HTTP Server initialized', {
      port: this.config.port,
      host: this.config.host,
      cacheMode: this.config.cacheMode,
      monitoringEnabled: this.config.enableMonitoring,
      timestamp: new Date().toISOString(),
    });
  }

  /** 初始化服务（监控、缓存等） */
  async initializeServices() {
    try {
      // 初始化缓存适配器（纯内存模式）
      this.cacheAdapter = await initCacheAdapter({
        mode: 'memory',
      });
      this.logger.info('Cache adapter initialized');

      // 初始化性能监控
      if (this.config.enableMonitoring) {
        this.performanceMonitor = initPerformanceMonitor();
        this.logger.info('Performance monitor initialized');

        // 初始化错误追踪（Ghost-aware）
        const container = getServiceContainer();
        const dataRoot = resolveDataRoot(container);
        const wz = container.get(
          'writeZone'
        ) as import('../infrastructure/io/WriteZone.js').WriteZone;
        this.errorTracker = initErrorTracker({
          logDirectory: join(dataRoot, '.asd', 'logs', 'errors'),
          writeZone: wz,
        });
        this.logger.info('Error tracker initialized');
      }
    } catch (error: unknown) {
      this.logger.error('Failed to initialize services', {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      throw error;
    }
  }

  /** 设置中间件 */
  setupMiddleware() {
    // 性能监控中间件（优先级最高）
    if (this.performanceMonitor) {
      this.app.use(this.performanceMonitor.middleware());
    }

    // 安全头（放宽 CSP 以兼容 Vite 构建的 Dashboard SPA：script/style 需要内联和 crossorigin）
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            fontSrc: ["'self'", 'https:', 'data:'],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
          },
        },
      })
    );

    // 请求日志
    this.app.use(requestLogger(this.logger));

    // 解析 JSON 请求体
    this.app.use(express.json({ limit: '10mb' }));

    // 解析 URL 编码的请求体
    this.app.use(express.urlencoded({ limit: '10mb', extended: true }));

    // 跨域处理 (CORS)
    this.app.use(
      cors({
        origin: this.config.corsOrigin || '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
          'Origin',
          'X-Requested-With',
          'Content-Type',
          'Accept',
          'Authorization',
          'X-User-Id',
        ],
        credentials: true,
      })
    );

    // 角色解析中间件（双路径：token / 探针）
    try {
      const constitution = getServiceContainer().get('constitution');
      const caps = (constitution?.config?.capabilities?.git_write || {}) as Record<string, unknown>;
      this.capabilityProbe = new CapabilityProbe({
        cacheTTL: (caps.cache_ttl as number) || 86400,
        noRemote: ((caps.no_remote as string) || 'allow') as 'allow' | 'deny',
      });
    } catch {
      this.capabilityProbe = new CapabilityProbe();
    }
    this.app.use(roleResolverMiddleware({ capabilityProbe: this.capabilityProbe }));

    // Gateway 中间件 (注入 req.gw)
    this.app.use(gatewayMiddleware());

    // 请求超时设置（AI 扫描类路由需要更长时间，SSE 流式路由需要更长时间）
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const isLongRunning =
        req.path.includes('/spm/scan') ||
        req.path.includes('/spm/bootstrap') ||
        req.path.includes('/modules/scan') ||
        req.path.includes('/modules/bootstrap') ||
        req.path.includes('/extract/');
      const isStreaming = req.path.includes('/stream') || req.path.includes('/events/');
      req.setTimeout(isLongRunning ? 600000 : isStreaming ? 300000 : 60000); // AI 扫描 10分钟, SSE/EventSource 5分钟, 其他 60秒
      next();
    });
  }

  /** 注册 Gateway Actions */
  registerGatewayActions() {
    try {
      const container = getServiceContainer();
      const gateway = container.get('gateway');
      registerGatewayActions(gateway, container);
      this.logger.info('Gateway actions registered');
    } catch (error: unknown) {
      this.logger.warn('Gateway action registration skipped', {
        error: (error as Error).message,
      });
    }
  }

  /** 设置路由 */
  setupRoutes() {
    // API 版本前缀
    const apiPrefix = '/api/v1';

    // OpenAPI 规范
    this.app.get('/api-spec', (_req: Request, res: Response) => {
      res.json(apiSpec);
    });

    // 健康检查
    this.app.use(`${apiPrefix}/health`, healthRouter);

    // 认证路由
    this.app.use(`${apiPrefix}/auth`, authRouter);

    // 权限探针端点
    this.app.get(`${apiPrefix}/auth/probe`, (req: Request, res: Response) => {
      const role = req.resolvedRole || 'visitor';
      const user = req.resolvedUser || 'anonymous';
      const mode =
        process.env.VITE_AUTH_ENABLED === 'true' || process.env.ALEMBIC_AUTH_ENABLED === 'true'
          ? 'token'
          : 'probe';
      const probeCache = this.capabilityProbe ? this.capabilityProbe.getCacheStatus() : null;
      res.json({
        success: true,
        data: { role, user, mode, probeCache },
      });
    });

    // 监控端点
    if (this.config.enableMonitoring) {
      this.app.use(`${apiPrefix}/monitoring`, monitoringRouter);
    }

    // Guard 实时检查路由（Extension DiagnosticCollection 调用）
    this.app.use(`${apiPrefix}/guard`, guardRouter);

    // Guard 合规报告路由
    this.app.use(`${apiPrefix}/guard/report`, guardReportRouter);

    // 守护规则路由
    this.app.use(`${apiPrefix}/rules`, guardRuleRouter);

    // TaskGraph 路由（Extension taskTool.ts 转发调用）
    this.app.use(`${apiPrefix}/task`, taskRouter);

    // 搜索路由
    this.app.use(`${apiPrefix}/search`, searchRouter);

    // AI 路由
    this.app.use(`${apiPrefix}/ai`, aiRouter);

    // 提取路由
    this.app.use(`${apiPrefix}/extract`, extractRouter);

    // 命令路由
    this.app.use(`${apiPrefix}/commands`, commandsRouter);

    // Skills 路由
    this.app.use(`${apiPrefix}/skills`, skillsRouter);

    // Candidates 路由（AI 补齐/润色）
    this.app.use(`${apiPrefix}/candidates`, candidatesRouter);

    // Modules 路由（v3.2 统一多语言模块扫描）
    this.app.use(`${apiPrefix}/modules`, modulesRouter);

    // 违规记录路由
    this.app.use(`${apiPrefix}/violations`, violationsRouter);

    // 知识条目路由 (V3)
    this.app.use(`${apiPrefix}/knowledge`, knowledgeRouter);

    // Recipe 操作路由（关系发现等）
    this.app.use(`${apiPrefix}/recipes`, recipesRouter);

    // Wiki 路由
    this.app.use(`${apiPrefix}/wiki`, wikiRouter);

    // Remote 路由（飞书 Bot → IDE 远程指令桥接）
    this.app.use(`${apiPrefix}/remote`, remoteRouter);

    // Panorama 全景路由（项目结构 + 覆盖率 + 健康度）
    this.app.use(`${apiPrefix}/panorama`, panoramaRouter);

    // 进化路由（文件变更驱动 Recipe 修复/弃用）
    this.app.use(`${apiPrefix}/evolution`, evolutionRouter);

    // 文件变更事件接收（领域无关，由 FileChangeDispatcher 分发）
    this.app.use(`${apiPrefix}/file-changes`, fileChangesRouter);

    // 信号留痕 & 报告路由
    this.app.use(`${apiPrefix}/signals`, signalsRouter);

    // 审计日志路由
    this.app.use(`${apiPrefix}/audit`, auditRouter);

    // 日志文件路由
    this.app.use(`${apiPrefix}/logs`, logsRouter);

    // 根路径 — 返回 API 元信息（避免外部探测产生无意义 404）
    this.app.all('/', (_req: Request, res: Response) => {
      res.json({
        name: 'Alembic API',
        version: '2.0',
        docs: '/api-spec',
        health: `${apiPrefix}/health`,
      });
    });

    // 404 处理（使用 app.all 确保 layer.route 存在，mountDashboard 依赖此属性定位并重排路由栈）
    this.app.all('{*path}', (req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route not found: ${req.method} ${req.originalUrl}`,
        },
      });
    });
  }

  /** 设置错误处理 */
  setupErrorHandling() {
    // 使用错误追踪器的错误处理中间件（如果启用）
    if (this.errorTracker) {
      this.app.use(this.errorTracker.errorHandler() as express.ErrorRequestHandler);
    } else {
      // 全局错误处理中间件（备用）
      this.app.use(errorHandler(this.logger));
    }
  }

  /** 启动服务器 */
  async start() {
    const { promise, resolve, reject } = Promise.withResolvers();
    try {
      this.server = this.app.listen(this.config.port, this.config.host, () => {
        this.logger.info('HTTP Server started', {
          host: this.config.host,
          port: this.config.port,
          url: `http://${this.config.host}:${this.config.port}`,
          timestamp: new Date().toISOString(),
        });

        // 初始化 WebSocket 服务（使用 HTTP 服务器实例）
        try {
          this.realtimeService = initRealtimeService(this.server!) as unknown as Record<
            string,
            unknown
          >;
          this.logger.info('Realtime service initialized');

          // 桥接 EventBus / SignalBus → RealtimeService
          try {
            const container = getServiceContainer();
            const rs = this.realtimeService as {
              broadcastEvent?: (name: string, data: unknown) => void;
            };
            if (typeof rs?.broadcastEvent !== 'function') {
              throw new Error('broadcastEvent not available');
            }

            // EventBus → lifecycle:transition
            const eventBus = container.services.eventBus ? container.get('eventBus') : null;
            if (eventBus) {
              eventBus.on('lifecycle:transition', (data: unknown) => {
                rs.broadcastEvent!('lifecycle:transition', data);
              });
            }

            // SignalBridge 已将信号转发到 EventBus，HttpServer 只听 EventBus
            if (eventBus) {
              eventBus.on('signal:event', (signal: unknown) => {
                rs.broadcastEvent!('signal:event', signal);
              });
              eventBus.on('guard:updated', (signal: unknown) => {
                rs.broadcastEvent!('guard:updated', signal);
              });
            }

            // 确保 SignalBridge 已初始化（触发 lazy singleton）
            try {
              container.get('signalBridge');
            } catch {
              // SignalBridge 未注册时静默跳过
            }

            // EventBus → audit:entry
            if (eventBus) {
              eventBus.on('audit:entry', (data: unknown) => {
                rs.broadcastEvent!('audit:entry', data);
              });
            }
          } catch {
            // EventBus/SignalBus 不可用时静默跳过
          }
        } catch (error: unknown) {
          this.logger.warn('Failed to initialize realtime service', {
            error: (error as Error).message,
          });
        }

        resolve(this.server);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        this.logger.error('HTTP Server error', {
          error: error.message,
          code: error.code,
          timestamp: new Date().toISOString(),
        });
        reject(error);
      });
    } catch (error: unknown) {
      this.logger.error('Failed to start HTTP Server', {
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
      reject(error);
    }
    return promise;
  }

  /** 停止服务器 */
  async stop() {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    if (!this.server) {
      return resolve(undefined);
    }

    // 停止性能监控
    if (this.performanceMonitor) {
      this.performanceMonitor.shutdown();
    }

    // 停止错误追踪
    if (this.errorTracker) {
      this.errorTracker.shutdown();
    }

    // 关闭 WebSocket 连接
    if (this.realtimeService && typeof this.realtimeService.shutdown === 'function') {
      try {
        this.realtimeService.shutdown();
      } catch (err: unknown) {
        this.logger.warn('Error shutting down realtime service', {
          error: (err as Error).message,
        });
      }
    }

    this.server.close((error) => {
      if (error) {
        this.logger.error('Error stopping HTTP Server', {
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return reject(error);
      }

      this.logger.info('HTTP Server stopped', {
        timestamp: new Date().toISOString(),
      });
      resolve(undefined);
    });
    return promise;
  }

  /** 获取 Express 应用实例 */
  getApp() {
    return this.app;
  }

  /**
   * 挂载 Dashboard 静态资源（生产模式：直接托管预构建产物）
   * 必须在 initialize() + start() 之后调用
   * @param distDir dashboard/dist 目录的绝对路径
   */
  mountDashboard(distDir: string) {
    // 从路由栈中移除最后的 404 catch-all 和根路径 handler
    // Express 5 使用 app.router（Express 4 为 app._router）
    const router =
      (
        this.app as unknown as {
          router?: { stack: RouterLayer[] };
          _router?: { stack: RouterLayer[] };
        }
      ).router ?? (this.app as unknown as { _router?: { stack: RouterLayer[] } })._router;
    if (!router) {
      this.logger.warn(
        'mountDashboard: Express router not available, mounting without route reordering'
      );
      this.app.use(express.static(distDir));
      this.app.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
          return next();
        }
        res.sendFile(join(distDir, 'index.html'));
      });
      this.logger.info('Dashboard mounted (production mode, fallback)', { distDir });
      return;
    }
    const layers: RouterLayer[] = router.stack;
    // 倒序弹出最后 2 层（404 + root handler）
    const removedLayers: RouterLayer[] = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.route) {
        removedLayers.unshift(layers.splice(i, 1)[0]);
        if (removedLayers.length >= 2) {
          break;
        }
      }
    }

    // 注入 express.static 托管 dist 目录
    this.app.use(express.static(distDir));

    // SPA fallback: 非 API / 非 socket.io 请求返回 index.html
    this.app.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
        return next();
      }
      res.sendFile(join(distDir, 'index.html'));
    });

    // 放回 404 handler（SPA fallback 之后，作为兜底）
    for (const layer of removedLayers) {
      layers.push(layer);
    }

    this.logger.info('Dashboard mounted (production mode)', { distDir });
  }

  /** 获取服务器实例 */
  getServer() {
    return this.server;
  }
}

export default HttpServer;
