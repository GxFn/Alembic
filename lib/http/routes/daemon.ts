import {
  type AlembicRuntimeCapabilities,
  createAlembicRuntimeCapabilities,
  createAlembicRuntimeHealthData,
  getPackageVersion,
} from '@alembic/core/daemon';
import { collectAiEnvOverrides, isAiEnvReady, WorkspaceSettingsStore } from '@alembic/core/shared';
import { resolveProjectRoot, WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request } from 'express';
import {
  buildAlembicRuntimeBoundary,
  type InternalAiCapability,
} from '../../daemon/RuntimeBoundary.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();
const API_PREFIX = '/api/v1';

router.get('/health', (req, res) => {
  const container = getServiceContainer();
  const projectRoot = resolveProjectRoot(container);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const workspaceFacts = resolver.toFacts();
  const mode = process.env.ALEMBIC_DAEMON_MODE === '1' ? 'daemon' : 'api';
  const origin = buildRequestOrigin(req);
  const dashboardAvailable =
    mode === 'daemon' && process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED === '1';
  const dashboardUrl = dashboardAvailable && origin ? origin : null;
  const schemaMigrationVersion = getSchemaMigrationVersion(container);
  const internalAi = getInternalAiCapability(projectRoot);
  const fileMonitorAvailable = isDaemonFileMonitorAvailable(mode);
  const capabilities = buildDaemonCapabilities({
    dashboardAvailable,
    dashboardUrl,
    fileMonitorAvailable,
    internalAi,
    origin,
  });
  const runtimeBoundary = buildAlembicRuntimeBoundary({
    capabilities,
    dashboardUrl,
    mode,
    origin,
    workspace: {
      databasePath: resolver.databasePath,
      dataRoot: resolver.dataRoot,
      dataRootSource: workspaceFacts.dataRootSource,
      ghost: resolver.ghost,
      projectId: resolver.projectId,
      projectRoot: resolver.projectRoot,
      runtimeDir: resolver.runtimeDir,
    },
  });
  const healthData = createAlembicRuntimeHealthData({
    capabilities,
    dashboardUrl,
    dataRoot: resolver.dataRoot,
    databasePath: resolver.databasePath,
    mode,
    pid: process.pid,
    projectId: resolver.projectId,
    projectRoot: resolver.projectRoot,
    schemaMigrationVersion,
    uptime: process.uptime(),
    version: getPackageVersion(),
  });

  res.json({
    success: true,
    data: {
      ...healthData,
      dataRootSource: workspaceFacts.dataRootSource,
      runtimeDir: resolver.runtimeDir,
      runtimeBoundary,
      capabilities: {
        ...healthData.capabilities,
        runtimeBoundary,
      },
    },
  });
});

export interface DaemonCapabilitiesOptions {
  dashboardAvailable: boolean;
  dashboardUrl: string | null;
  fileMonitorAvailable: boolean;
  internalAi: InternalAiCapability;
  origin: string | null;
}

export function buildDaemonCapabilities(
  options: DaemonCapabilitiesOptions
): AlembicRuntimeCapabilities {
  return createAlembicRuntimeCapabilities({
    apiBaseUrl: options.origin,
    dashboardAvailable: options.dashboardAvailable,
    dashboardUrl: options.dashboardUrl,
    fileMonitorAvailable: options.fileMonitorAvailable,
    fileMonitorEndpoint: `${API_PREFIX}/file-changes`,
    fileMonitorMode: options.fileMonitorAvailable ? 'daemon-git-worktree' : 'disabled',
    internalAi: options.internalAi,
  });
}

function isDaemonFileMonitorAvailable(mode: 'api' | 'daemon'): boolean {
  return mode === 'daemon' && process.env.ALEMBIC_DAEMON_FILE_CHANGES !== '0';
}

function getInternalAiCapability(projectRoot: string): InternalAiCapability {
  try {
    const settingsConfig = WorkspaceSettingsStore.fromProject(projectRoot).readAiConfig();
    const processConfig = collectAiEnvOverrides(settingsConfig.env, process.env);
    const rawVars = {
      ...settingsConfig.env,
      ...processConfig,
    };
    const hasSettings = settingsConfig.hasSettingsFile || settingsConfig.hasSecretsFile;
    const hasProcessConfig = Object.keys(processConfig).length > 0;
    return {
      available: isAiEnvReady(rawVars),
      configSource: hasProcessConfig ? 'process-env' : hasSettings ? 'workspace-settings' : 'empty',
      model: rawVars.ALEMBIC_AI_MODEL || null,
      provider: rawVars.ALEMBIC_AI_PROVIDER || null,
    };
  } catch {
    return { available: false, configSource: 'empty', model: null, provider: null };
  }
}

function buildRequestOrigin(req: Request): string | null {
  const host = req.get('host');
  if (!host) {
    return null;
  }
  return `${req.protocol}://${host}`;
}

function getSchemaMigrationVersion(
  container: ReturnType<typeof getServiceContainer>
): string | null {
  try {
    const db = container.get('database') as {
      getDb?: () => { prepare: (sql: string) => { get: () => unknown } };
    };
    const row = db
      .getDb?.()
      ?.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
      .get() as { version?: string } | undefined;
    return row?.version || null;
  } catch {
    return null;
  }
}

export default router;
