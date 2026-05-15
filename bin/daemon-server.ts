#!/usr/bin/env node

process.env.ALEMBIC_API_SERVER = '1';
process.env.ALEMBIC_DAEMON_MODE = '1';

import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import Bootstrap from '../lib/bootstrap.js';
import { markInterruptedDaemonJobs } from '../lib/daemon/DaemonJobRunner.js';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  getPackageVersion,
  resolveDaemonPaths,
  writeDaemonState,
} from '../lib/daemon/DaemonState.js';
import HttpServer from '../lib/http/HttpServer.js';
import Logger from '../lib/infrastructure/logging/Logger.js';
import { getServiceContainer } from '../lib/injection/ServiceContainer.js';
import { GitDiffCheckpointService } from '../lib/service/evolution/git-diff-checkpoint/index.js';
import { DASHBOARD_DIR } from '../lib/shared/package-root.js';
import { shutdown } from '../lib/shared/shutdown.js';
import { timerRegistry } from '../lib/shared/TimerRegistry.js';

shutdown.install();

type WorkspaceResolver = Awaited<ReturnType<Bootstrap['initialize']>>['workspaceResolver'];

process.on('uncaughtException', (error) => {
  const logger = Logger.getInstance();
  logger.error('Daemon uncaught exception', { message: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const logger = Logger.getInstance();
  logger.error('Daemon unhandled rejection', { reason });
  process.exit(1);
});

async function main() {
  const logger = Logger.getInstance();
  const projectRoot = resolve(process.env.ALEMBIC_PROJECT_DIR || process.cwd());
  const host = process.env.ALEMBIC_DAEMON_HOST || process.env.HOST || '127.0.0.1';
  const requestedPort = Number.parseInt(
    process.env.ALEMBIC_DAEMON_PORT || process.env.PORT || '0',
    10
  );
  const token = process.env.ALEMBIC_DAEMON_TOKEN || randomBytes(32).toString('hex');
  const paths = resolveDaemonPaths(projectRoot);
  const statePath = process.env.ALEMBIC_DAEMON_STATE_PATH || paths.statePath;

  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  process.env.ALEMBIC_DAEMON_TOKEN = token;
  process.env.HOST = host;
  process.env.PORT = String(Number.isFinite(requestedPort) ? requestedPort : 0);

  if (projectRoot !== process.cwd()) {
    process.chdir(projectRoot);
  }

  Bootstrap.configurePathGuard(projectRoot);

  const bootstrap = new Bootstrap({ env: process.env.NODE_ENV || 'development' });
  const components = await bootstrap.initialize();
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

  markInterruptedDaemonJobs({
    code: 'DAEMON_RESTARTED',
    container,
    logger,
    reason: 'Alembic daemon restarted before this job completed. Start a new job to retry.',
  });

  try {
    const eventBus = container.get('eventBus');
    const gateway = container.get('gateway') as { eventBus?: unknown };
    gateway.eventBus = eventBus;
  } catch {
    /* EventBus 不可用不阻塞 daemon */
  }

  const httpServer = await startHttpServer(requestedPort, host);
  registerDaemonGitDiffCheckpoint({
    container,
    logger,
    projectRoot,
  });
  const actualPort = resolveBoundDaemonPort(httpServer, requestedPort);
  const daemonUrl = buildDaemonUrl(host, actualPort);
  const dashboardMounted = mountDashboardIfAvailable(httpServer);
  await verifyHttpServerReady(daemonUrl);

  const resolver = components.workspaceResolver;
  const schemaMigrationVersion = getSchemaMigrationVersion(components.db);
  writeReadyDaemonState({
    statePath,
    projectRoot,
    resolver,
    host,
    actualPort,
    daemonUrl,
    dashboardMounted,
    token,
    schemaMigrationVersion,
  });

  logger.info('Alembic daemon ready', {
    projectRoot,
    dataRoot: resolver?.dataRoot,
    port: actualPort,
    statePath,
  });

  import('../lib/service/bootstrap/UiStartupTasks.js')
    .then(({ runUiStartupTasks }) => runUiStartupTasks({ projectRoot, container }))
    .then((report) => {
      if (report.errors.length > 0) {
        logger.warn(`UiStartupTasks completed with ${report.errors.length} error(s)`);
      }
    })
    .catch((error: unknown) => {
      logger.debug(`UiStartupTasks failed: ${(error as Error).message}`);
    });

  shutdown.register(async () => {
    rmSync(statePath, { force: true });
    rmSync(paths.pidPath, { force: true });
  }, 'daemon-state');
  shutdown.register(async () => {
    await bootstrap.shutdown();
  }, 'bootstrap');
  shutdown.register(async () => {
    await httpServer.stop();
  }, 'http-server');
  shutdown.register(async () => {
    await timerRegistry.dispose();
  }, 'timer-registry');
  shutdown.register(() => {
    markInterruptedDaemonJobs({
      code: 'DAEMON_SHUTDOWN',
      container,
      logger,
      reason: 'Alembic daemon shut down before this job completed. Start a new job to retry.',
    });
  }, 'daemon-jobs');
}

function registerDaemonGitDiffCheckpoint(options: {
  container: ReturnType<typeof getServiceContainer>;
  logger: ReturnType<typeof Logger.getInstance>;
  projectRoot: string;
}): GitDiffCheckpointService {
  const dispatcher = options.container.get(
    'fileChangeDispatcher'
  ) as import('../lib/service/FileChangeDispatcher.js').FileChangeDispatcher;
  const checkpoint = new GitDiffCheckpointService({
    projectRoot: options.projectRoot,
    dispatcher,
    logger: options.logger,
  });
  options.container.singletons.gitDiffCheckpoint = checkpoint;
  return checkpoint;
}

function resolveBoundDaemonPort(httpServer: HttpServer, requestedPort: number): number {
  let actualPort = getListeningPort(httpServer) ?? requestedPort;
  if (!actualPort || actualPort < 0) {
    actualPort = requestedPort;
  }
  if (!actualPort || actualPort <= 0) {
    throw new Error(`Daemon HTTP server did not bind to a valid port: ${actualPort}`);
  }
  return actualPort;
}

function writeReadyDaemonState(options: {
  statePath: string;
  projectRoot: string;
  resolver: WorkspaceResolver;
  host: string;
  actualPort: number;
  daemonUrl: string;
  dashboardMounted: boolean;
  token: string;
  schemaMigrationVersion: string | null;
}): void {
  const now = new Date().toISOString();
  writeDaemonState(options.statePath, {
    schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
    projectRoot: options.projectRoot,
    dataRoot: options.resolver?.dataRoot || options.projectRoot,
    projectId: options.resolver?.projectId || null,
    pid: process.pid,
    host: options.host,
    port: options.actualPort,
    url: options.daemonUrl,
    dashboardUrl: options.dashboardMounted ? options.daemonUrl : `${options.daemonUrl}/api-spec`,
    token: options.token,
    version: getPackageVersion(),
    mode: 'daemon',
    startedAt: now,
    lastReadyAt: now,
    databasePath: options.resolver?.databasePath || '',
    schemaMigrationVersion: options.schemaMigrationVersion,
  });
}

async function startHttpServer(port: number, host: string): Promise<HttpServer> {
  const portToUse = port !== 0 && !(await isPortAvailable(port, host)) ? 0 : port;
  try {
    const httpServer = new HttpServer({ port: portToUse, host });
    await httpServer.initialize();
    await httpServer.start();
    return httpServer;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE' && port !== 0) {
      const httpServer = new HttpServer({ port: 0, host });
      await httpServer.initialize();
      await httpServer.start();
      return httpServer;
    }
    throw error;
  }
}

function mountDashboardIfAvailable(httpServer: HttpServer): boolean {
  const distDir = join(DASHBOARD_DIR, 'dist');
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    Logger.getInstance().warn('Dashboard dist is missing; daemon will serve API routes only', {
      indexPath,
    });
    return false;
  }
  httpServer.mountDashboard(distDir);
  return true;
}

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => {
    server.close(() => resolve(true));
  });
  server.listen(port, host);
  return promise;
}

async function verifyHttpServerReady(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/daemon/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`health returned ${response.status}`);
    }
    const payload = (await response.json()) as { success?: unknown };
    if (payload.success !== true) {
      throw new Error('health response did not report success');
    }
  } catch (error: unknown) {
    throw new Error(
      `Daemon HTTP server failed readiness verification at ${baseUrl}: ${(error as Error).message}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildDaemonUrl(host: string, port: number): string {
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const formattedHost =
    urlHost.includes(':') && !urlHost.startsWith('[') ? `[${urlHost}]` : urlHost;
  return `http://${formattedHost}:${port}`;
}

function getListeningPort(httpServer: HttpServer): number | null {
  const address = httpServer.getServer()?.address();
  if (address && typeof address === 'object') {
    return (address as AddressInfo).port;
  }
  return null;
}

function getSchemaMigrationVersion(db: unknown): string | null {
  try {
    const rawDb = (
      db as { getDb?: () => { prepare: (sql: string) => { get: () => unknown } } }
    )?.getDb?.();
    const row = rawDb
      ?.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
      .get() as { version?: string } | undefined;
    return row?.version || null;
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  const logger = Logger.getInstance();
  logger.error('Failed to start Alembic daemon', {
    message: (error as Error).message,
    stack: (error as Error).stack,
  });
  process.exit(1);
});
