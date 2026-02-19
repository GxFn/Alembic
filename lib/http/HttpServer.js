/**
 * HTTP Server - AutoSnippet 2.0
 * 基于 Express 框架的 REST API 服务器
 * 集成监控、缓存和错误追踪
 */

import { join } from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import Logger from '../infrastructure/logging/Logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';
import { gatewayMiddleware } from './middleware/gatewayMiddleware.js';
import { roleResolverMiddleware } from './middleware/roleResolver.js';
import { CapabilityProbe } from '../core/capability/CapabilityProbe.js';
import guardRuleRouter from './routes/guardRules.js';
import searchRouter from './routes/search.js';
import healthRouter from './routes/health.js';
import monitoringRouter from './routes/monitoring.js';
import snippetRouter from './routes/snippets.js';
import aiRouter from './routes/ai.js';
import extractRouter from './routes/extract.js';
import commandsRouter from './routes/commands.js';
import spmRouter from './routes/spm.js';
import violationsRouter from './routes/violations.js';
import authRouter from './routes/auth.js';
import skillsRouter from './routes/skills.js';
import candidatesRouter from './routes/candidates.js';
import knowledgeRouter from './routes/knowledge.js';
import recipesRouter from './routes/recipes.js';
import wikiRouter from './routes/wiki.js';
import apiSpec from './api-spec.js';
import { initCacheAdapter } from '../infrastructure/cache/UnifiedCacheAdapter.js';
import { initPerformanceMonitor } from '../infrastructure/monitoring/PerformanceMonitor.js';
import { initErrorTracker } from '../infrastructure/monitoring/ErrorTracker.js';
import { initRealtimeService } from '../infrastructure/realtime/RealtimeService.js';
import { registerGatewayActions } from '../core/gateway/GatewayActionRegistry.js';
import { getServiceContainer } from '../injection/ServiceContainer.js';

export class HttpServer {
  constructor(config = {}) {
    this.config = {
      port: config.port || 3000,
      host: config.host || 'localhost',
      enableMonitoring: config.enableMonitoring !== false,
      cacheMode: 'memory',
      ...config,
    };
    
    this.logger = Logger.getInstance();
    this.app = express();
    this.server = null;
    this.performanceMonitor = null;
    this.errorTracker = null;
    this.cacheAdapter = null;
    this.realtimeService = null;
  }

  /**
   * 初始化服务器
   */
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

  /**
   * 初始化服务（监控、缓存等）
   */
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

        // 初始化错误追踪
        this.errorTracker = initErrorTracker();
        this.logger.info('Error tracker initialized');
      }
    } catch (error) {
      this.logger.error('Failed to initialize services', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  /**
   * 设置中间件
   */
  setupMiddleware() {
    // 性能监控中间件（优先级最高）
    if (this.performanceMonitor) {
      this.app.use(this.performanceMonitor.middleware());
    }

    // 安全头
    this.app.use(helmet());

    // 请求日志
    this.app.use(requestLogger(this.logger));

    // 解析 JSON 请求体
    this.app.use(express.json({ limit: '10mb' }));
    
    // 解析 URL 编码的请求体
    this.app.use(express.urlencoded({ limit: '10mb', extended: true }));

    // 跨域处理 (CORS)
    this.app.use(cors({
      origin: this.config.corsOrigin || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'X-User-Id'],
      credentials: true,
    }));

    // 角色解析中间件（双路径：token / 探针）
    try {
      const constitution = getServiceContainer().get('constitution');
      const caps = constitution?.config?.capabilities?.git_write || {};
      this.capabilityProbe = new CapabilityProbe({
        cacheTTL: caps.cache_ttl || 86400,
        noRemote: caps.no_remote || 'allow',
      });
    } catch {
      this.capabilityProbe = new CapabilityProbe();
    }
    this.app.use(roleResolverMiddleware({ capabilityProbe: this.capabilityProbe }));

    // Gateway 中间件 (注入 req.gw)
    this.app.use(gatewayMiddleware());

    // 请求超时设置（AI 扫描类路由需要更长时间，SSE 流式路由需要更长时间）
    this.app.use((req, res, next) => {
      const isLongRunning = req.path.includes('/spm/scan') || req.path.includes('/spm/bootstrap') || req.path.includes('/extract/');
      const isStreaming = req.path.includes('/stream') || req.path.includes('/events/');
      req.setTimeout(isLongRunning ? 600000 : isStreaming ? 300000 : 60000); // AI 扫描 10分钟, SSE/EventSource 5分钟, 其他 60秒
      next();
    });
  }

  /**
   * 注册 Gateway Actions
   */
  registerGatewayActions() {
    try {
      const container = getServiceContainer();
      const gateway = container.get('gateway');
      registerGatewayActions(gateway, container);
      this.logger.info('Gateway actions registered');
    } catch (error) {
      this.logger.warn('Gateway action registration skipped', {
        error: error.message,
      });
    }
  }

  /**
   * 设置路由
   */
  setupRoutes() {
    // API 版本前缀
    const apiPrefix = '/api/v1';

    // OpenAPI 规范
    this.app.get('/api-spec', (req, res) => {
      res.json(apiSpec);
    });

    // 健康检查
    this.app.use(`${apiPrefix}/health`, healthRouter);

    // 认证路由
    this.app.use(`${apiPrefix}/auth`, authRouter);

    // 权限探针端点
    this.app.get(`${apiPrefix}/auth/probe`, (req, res) => {
      const role = req.resolvedRole || 'visitor';
      const user = req.resolvedUser || 'anonymous';
      const mode = (process.env.VITE_AUTH_ENABLED === 'true' || process.env.ASD_AUTH_ENABLED === 'true') ? 'token' : 'probe';
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

    // 守护规则路由
    this.app.use(`${apiPrefix}/rules`, guardRuleRouter);

    // 搜索路由
    this.app.use(`${apiPrefix}/search`, searchRouter);

    // Snippet 路由
    this.app.use(`${apiPrefix}/snippets`, snippetRouter);

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

    // SPM 路由
    this.app.use(`${apiPrefix}/spm`, spmRouter);

    // 违规记录路由
    this.app.use(`${apiPrefix}/violations`, violationsRouter);

    // 知识条目路由 (V3)
    this.app.use(`${apiPrefix}/knowledge`, knowledgeRouter);

    // Recipe 操作路由（关系发现等）
    this.app.use(`${apiPrefix}/recipes`, recipesRouter);

    // Wiki 路由
    this.app.use(`${apiPrefix}/wiki`, wikiRouter);

    // 根路径 — 返回 API 元信息（避免外部探测产生无意义 404）
    this.app.all('/', (req, res) => {
      res.json({
        name: 'AutoSnippet API',
        version: '2.0',
        docs: '/api-spec',
        health: `${apiPrefix}/health`,
      });
    });

    // 404 处理（使用 app.all 确保 layer.route 存在，mountDashboard 依赖此属性定位并重排路由栈）
    this.app.all('*', (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route not found: ${req.method} ${req.originalUrl}`,
        },
      });
    });
  }

  /**
   * 设置错误处理
   */
  setupErrorHandling() {
    // 使用错误追踪器的错误处理中间件（如果启用）
    if (this.errorTracker) {
      this.app.use(this.errorTracker.errorHandler());
    } else {
      // 全局错误处理中间件（备用）
      this.app.use(errorHandler(this.logger));
    }
  }

  /**
   * 启动服务器
   */
  async start() {
    return new Promise((resolve, reject) => {
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
            this.realtimeService = initRealtimeService(this.server);
            this.logger.info('Realtime service initialized');
          } catch (error) {
            this.logger.warn('Failed to initialize realtime service', {
              error: error.message,
            });
          }

          resolve(this.server);
        });

        this.server.on('error', (error) => {
          this.logger.error('HTTP Server error', {
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString(),
          });
          reject(error);
        });
      } catch (error) {
        this.logger.error('Failed to start HTTP Server', {
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        reject(error);
      }
    });
  }

  /**
   * 停止服务器
   */
  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
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
        } catch (err) {
          this.logger.warn('Error shutting down realtime service', { error: err.message });
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
        resolve();
      });
    });
  }

  /**
   * 获取 Express 应用实例
   */
  getApp() {
    return this.app;
  }

  /**
   * 挂载 Dashboard 静态资源（生产模式：直接托管预构建产物）
   * 必须在 initialize() + start() 之后调用
   * @param {string} distDir - dashboard/dist 目录的绝对路径
   */
  mountDashboard(distDir) {
    // 从路由栈中移除最后的 404 catch-all 和根路径 handler
    const layers = this.app._router.stack;
    // 倒序弹出最后 2 层（404 + root handler）
    const removedLayers = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.route) {
        removedLayers.unshift(layers.splice(i, 1)[0]);
        if (removedLayers.length >= 2) break;
      }
    }

    // 注入 express.static 托管 dist 目录
    this.app.use(express.static(distDir));

    // SPA fallback: 非 API / 非 socket.io 请求返回 index.html
    this.app.get('*', (req, res, next) => {
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

  /**
   * 获取服务器实例
   */
  getServer() {
    return this.server;
  }
}

export default HttpServer;
