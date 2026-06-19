/**
 * HTTP Server - Alembic 2.0
 * 基于 Express 框架的 REST API 服务器
 * 集成缓存
 */

import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import cors from 'cors';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { registerGatewayActions } from '../governance/gateway/GatewayActionRegistry.js';
import { initCacheAdapter } from '../infrastructure/cache/UnifiedCacheAdapter.js';
import { initRealtimeService } from '../infrastructure/realtime/RealtimeService.js';
import { getServiceContainer } from '../injection/ServiceContainer.js';
import apiSpec from './api-spec.js';
import { errorHandler } from './middleware/errorHandler.js';
import { gatewayMiddleware } from './middleware/gatewayMiddleware.js';
import { requestLogger } from './middleware/requestLogger.js';
import { sourceResolverMiddleware } from './middleware/sourceResolver.js';
import aiRouter from './routes/ai.js';
import auditRouter from './routes/audit.js';
import candidatesRouter from './routes/candidates.js';
import commandsRouter from './routes/commands.js';
import daemonRouter from './routes/daemon.js';
import evolutionRouter from './routes/evolution.js';
import extractRouter from './routes/extract.js';
import fileChangesRouter from './routes/file-changes.js';
import guardRouter from './routes/guard.js';
import guardRuleRouter from './routes/guardRules.js';
import healthRouter from './routes/health.js';
import jobsRouter from './routes/jobs.js';
import knowledgeRouter from './routes/knowledge.js';
import logsRouter from './routes/logs.js';
import modulesRouter from './routes/modules.js';
import panoramaRouter from './routes/panorama.js';
import projectScopeRouter from './routes/project-scope.js';
import projectsRouter from './routes/projects.js';
import recipesRouter from './routes/recipes.js';
import searchRouter from './routes/search.js';
import signalsRouter from './routes/signals.js';
import skillsRouter from './routes/skills.js';
import violationsRouter from './routes/violations.js';
import wikiRouter from './routes/wiki.js';

interface HttpServerConfig {
  port: number;
  host: string;
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
  config: HttpServerConfig;
  activeRequestCount: number;
  activeStreamingResponses: Set<Response>;
  logger: AppLogger;
  realtimeService: Record<string, unknown> | null;
  server: Server | null;
  stopping: boolean;
  constructor(config: Partial<HttpServerConfig> = {}) {
    this.config = {
      port: config.port ?? 3000,
      host: config.host || 'localhost',
      cacheMode: 'memory',
      ...config,
    } as HttpServerConfig;

    this.logger = Logger.getInstance();
    this.app = express();
    this.server = null;
    this.activeRequestCount = 0;
    this.activeStreamingResponses = new Set();
    this.cacheAdapter = null;
    this.realtimeService = null;
    this.stopping = false;
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
      timestamp: new Date().toISOString(),
    });
  }

  /** 初始化服务（缓存等） */
  async initializeServices() {
    try {
      // 初始化缓存适配器（纯内存模式）
      this.cacheAdapter = await initCacheAdapter({
        mode: 'memory',
      });
      this.logger.info('Cache adapter initialized');
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

    // 跟踪普通请求与 SSE/EventSource 响应，用于停服时协调关闭。
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.trackRequestLifecycle(req, res, next);
    });

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
          'X-Alembic-Daemon-Token',
        ],
        credentials: true,
      })
    );

    // 请求来源解析；不使用 git/probe/login 推导运行时权限。
    this.app.use(sourceResolverMiddleware());

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

  trackRequestLifecycle(req: Request, res: Response, next: NextFunction): void {
    if (this.stopping) {
      res.setHeader('Connection', 'close');
    }
    this.activeRequestCount += 1;
    const isStreaming = req.path.includes('/stream') || req.path.includes('/events/');
    if (isStreaming) {
      this.activeStreamingResponses.add(res);
    }

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
      this.activeStreamingResponses.delete(res);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
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

    // daemon 自检端点（供 DaemonSupervisor 校验 project/data/schema identity）
    this.app.use(`${apiPrefix}/daemon`, daemonRouter);

    // daemon job 状态与投递
    this.app.use(`${apiPrefix}/jobs`, jobsRouter);

    // 多项目 runtime control foundation（只读 summary / selected state）
    this.app.use(`${apiPrefix}/projects`, projectsRouter);

    // ProjectScope producer：抽象 Project 与多个实体源码 folder 的绑定关系
    this.app.use(`${apiPrefix}/project-scope`, projectScopeRouter);

    // 请求来源探针端点
    this.app.get(`${apiPrefix}/auth/probe`, (req: Request, res: Response) => {
      const source = req.resolvedSource || 'http-request';
      const sourceActor = req.resolvedSourceActor || 'anonymous';
      res.json({
        success: true,
        data: { source, sourceActor, mode: 'source' },
      });
    });

    // Guard 实时检查路由（Dashboard、CLI 或外部宿主调用）
    this.app.use(`${apiPrefix}/guard`, guardRouter);

    // 守护规则路由
    this.app.use(`${apiPrefix}/rules`, guardRuleRouter);

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
    // 全局错误处理中间件
    this.app.use(errorHandler(this.logger));
  }

  /** 启动服务器 */
  async start() {
    const { promise, resolve, reject } = Promise.withResolvers<Server>();
    try {
      this.server = createServer(this.app);
      let settled = false;

      const onError = (error: NodeJS.ErrnoException) => {
        if (settled) {
          this.logger.error('HTTP Server error', {
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        settled = true;
        this.logger.error('HTTP Server error', {
          error: error.message,
          code: error.code,
          timestamp: new Date().toISOString(),
        });
        this.server = null;
        reject(error);
      };

      const onListening = () => {
        const server = this.server;
        if (!server) {
          onError(new Error('HTTP Server instance is not initialized') as NodeJS.ErrnoException);
          return;
        }
        const address = server.address();
        if (!address || typeof address !== 'object' || address.port <= 0) {
          const error = new Error(
            `HTTP Server did not bind to a valid port: ${JSON.stringify(address)}`
          );
          onError(error as NodeJS.ErrnoException);
          return;
        }
        this.config.port = address.port;

        this.logger.info('HTTP Server started', {
          host: this.config.host,
          port: this.config.port,
          url: `http://${this.config.host}:${this.config.port}`,
          timestamp: new Date().toISOString(),
        });

        // 初始化 WebSocket 服务（使用 HTTP 服务器实例）
        try {
          this.realtimeService = initRealtimeService(server) as unknown as Record<string, unknown>;
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
            const broadcastEvent = (name: string, data: unknown) => {
              try {
                rs.broadcastEvent?.(name, data);
              } catch (error: unknown) {
                this.logger.warn('Realtime broadcast failed', {
                  eventName: name,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            };

            // EventBus → lifecycle:transition
            const eventBus = container.services?.eventBus ? container.get('eventBus') : null;
            if (eventBus) {
              eventBus.on('lifecycle:transition', (data: unknown) => {
                broadcastEvent('lifecycle:transition', data);
              });
            }

            // SignalBridge 已将信号转发到 EventBus，HttpServer 只听 EventBus
            if (eventBus) {
              eventBus.on('signal:event', (signal: unknown) => {
                broadcastEvent('signal:event', signal);
              });
              eventBus.on('guard:updated', (signal: unknown) => {
                broadcastEvent('guard:updated', signal);
              });
            }

            // 确保 SignalBridge 已初始化（触发 lazy singleton）
            try {
              container.get('signalBridge');
            } catch (error: unknown) {
              this.logger.warn('SignalBridge unavailable for realtime bridge', {
                error: error instanceof Error ? error.message : String(error),
              });
            }

            // EventBus → audit:entry
            if (eventBus) {
              eventBus.on('audit:entry', (data: unknown) => {
                broadcastEvent('audit:entry', data);
              });
            }
          } catch (error: unknown) {
            this.logger.warn('Realtime event bridge unavailable', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } catch (error: unknown) {
          this.logger.warn('Failed to initialize realtime service', {
            error: (error as Error).message,
          });
        }

        settled = true;
        resolve(server);
      };

      this.server.on('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.config.port, this.config.host);
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
    this.stopping = true;
    this.closeActiveStreamingResponses();
    this.logger.info('HTTP Server stopping', {
      activeRequests: this.activeRequestCount,
      activeStreams: this.activeStreamingResponses.size,
      timestamp: new Date().toISOString(),
    });

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

  closeActiveStreamingResponses(): void {
    for (const res of [...this.activeStreamingResponses]) {
      try {
        if (!res.headersSent) {
          res.status(503);
          res.setHeader('Content-Type', 'text/event-stream');
        }
        res.write('event: shutdown\ndata: {"reason":"server_shutdown"}\n\n');
        res.end();
      } catch (error: unknown) {
        this.logger.warn('Error closing active streaming response', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
