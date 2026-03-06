#!/usr/bin/env node

/**
 * HTTP API 服务器启动脚本
 * 用于开发和测试 REST API
 */

import Bootstrap from '../lib/bootstrap.js';
import HttpServer from '../lib/http/HttpServer.js';
import Logger from '../lib/infrastructure/logging/Logger.js';
import { getServiceContainer } from '../lib/injection/ServiceContainer.js';

async function main() {
  const logger = Logger.getInstance();
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || 'localhost';

  try {
    logger.info('Initializing AutoSnippet HTTP API Server...', {
      port,
      host,
      timestamp: new Date().toISOString(),
    });

    // 配置路径安全守卫 — 阻止写操作逃逸到项目外
    const projectRoot = process.env.ASD_PROJECT_DIR || process.cwd();

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
    });
    logger.info('Service container initialized successfully');

    // 创建和启动 HTTP 服务器
    const httpServer = new HttpServer({ port, host });
    await httpServer.initialize(); // 改为 async 调用
    await httpServer.start();

    logger.info('HTTP API Server is running', {
      url: `http://${host}:${port}`,
      documentation: `http://${host}:${port}/api-spec`,
      health: `http://${host}:${port}/api/v1/health`,
    });

    // 优雅关闭
    const handleShutdown = async (signal) => {
      logger.info(`Received ${signal}, shutting down gracefully...`, {
        timestamp: new Date().toISOString(),
      });

      await httpServer.stop();
      await bootstrap.shutdown();

      logger.info('HTTP API Server shut down successfully', {
        timestamp: new Date().toISOString(),
      });

      process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));

    // 处理未捕获的异常
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception', {
        message: error.message,
        stack: error.stack,
      });
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection', {
        reason,
        promise,
      });
      process.exit(1);
    });
  } catch (error: any) {
    logger.error('Failed to start HTTP API Server', {
      message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main();
