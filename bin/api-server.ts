#!/usr/bin/env node

/**
 * HTTP API 服务器启动脚本
 * 用于开发和测试 REST API
 */

process.env.ALEMBIC_API_SERVER = '1';

import Bootstrap from '../lib/bootstrap.js';
import HttpServer from '../lib/http/HttpServer.js';
import Logger from '../lib/infrastructure/logging/Logger.js';
import { getServiceContainer } from '../lib/injection/ServiceContainer.js';
import { shutdown } from '../lib/shared/shutdown.js';
import { timerRegistry } from '../lib/shared/TimerRegistry.js';

// ─── Graceful Shutdown 协调器 ──────────────────────────
shutdown.install();

// ─── 进程级错误兜底 ────────────────────────────────────
process.on('uncaughtException', (error) => {
  const logger = Logger.getInstance();
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
  const logger = Logger.getInstance();
  logger.error('Unhandled Rejection', { reason });
  process.exit(1);
});

async function main() {
  const logger = Logger.getInstance();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || 'localhost';

  try {
    logger.info('Initializing Alembic HTTP API Server...', {
      port,
      host,
      timestamp: new Date().toISOString(),
    });

    // 配置路径安全守卫 — 阻止写操作逃逸到项目外
    const projectRoot = process.env.ALEMBIC_PROJECT_DIR || process.cwd();

    // 切换工作目录到项目根 — 确保 DB 等相对路径正确解析
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }

    Bootstrap.configurePathGuard(projectRoot);

    // 初始化应用程序引导
    const bootstrap = new Bootstrap({ env: process.env.NODE_ENV || 'development' });
    const components = await bootstrap.initialize();
    logger.info('Bootstrap initialized successfully');

    // 初始化 DI 容器，注入 Bootstrap 组件
    const container = getServiceContainer();
    await container.initialize({
      db: components.db,
      auditLogger: components.auditLogger,
      gateway: components.gateway,
      constitution: components.constitution,
      config: components.config,
      skillHooks: components.skillHooks,
      projectRoot,
      workspaceResolver: components.workspaceResolver,
    });
    logger.info('Service container initialized successfully');

    // 创建和启动 HTTP 服务器
    const httpServer = new HttpServer({ port, host });
    await httpServer.initialize();
    await httpServer.start();

    logger.info('HTTP API Server is running', {
      url: `http://${host}:${port}`,
      documentation: `http://${host}:${port}/api-spec`,
      health: `http://${host}:${port}/api/v1/health`,
    });

    // 注册 shutdown hooks（LIFO 顺序：先注册的后执行）
    // 1. bootstrap.shutdown() — 关闭 DB（含 WAL checkpoint）
    shutdown.register(async () => {
      await bootstrap.shutdown();
    }, 'bootstrap');
    // 2. HTTP server — 停止接受新连接并等待进行中请求完成
    shutdown.register(async () => {
      await httpServer.stop();
    }, 'http-server');
    // 3. 定时器注册中心 — 清理所有定时器 + Disposable
    shutdown.register(async () => {
      await timerRegistry.dispose();
    }, 'timer-registry');
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error('Failed to start HTTP API Server', { message: msg, stack });
    process.exit(1);
  }
}

main();
