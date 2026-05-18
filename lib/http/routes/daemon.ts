import { getPackageVersion } from '@alembic/core/daemon';
import { collectAiEnvOverrides, isAiEnvReady, WorkspaceSettingsStore } from '@alembic/core/shared';
import { resolveProjectRoot, WorkspaceResolver } from '@alembic/core/workspace';
import express, { type Request } from 'express';
import { getServiceContainer } from '../../injection/ServiceContainer.js';

const router = express.Router();
const API_PREFIX = '/api/v1';

router.get('/health', (req, res) => {
  const container = getServiceContainer();
  const projectRoot = resolveProjectRoot(container);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const mode = process.env.ALEMBIC_DAEMON_MODE === '1' ? 'daemon' : 'api';
  const origin = buildRequestOrigin(req);
  const dashboardAvailable =
    mode === 'daemon' && process.env.ALEMBIC_DAEMON_DASHBOARD_MOUNTED === '1';
  const dashboardUrl = dashboardAvailable && origin ? origin : null;
  const schemaMigrationVersion = getSchemaMigrationVersion(container);
  res.json({
    success: true,
    data: {
      mode,
      projectRoot,
      dataRoot: resolver.dataRoot,
      projectId: resolver.projectId,
      version: getPackageVersion(),
      pid: process.pid,
      uptime: process.uptime(),
      databasePath: resolver.databasePath,
      schemaMigrationVersion,
      dashboardUrl,
      enhancement: {
        apiVersion: 'v1',
        packageName: 'alembic-ai',
        route: 'local-alembic',
        version: getPackageVersion(),
      },
      capabilities: buildDaemonCapabilities({
        dashboardAvailable,
        dashboardUrl,
        internalAi: getInternalAiCapability(projectRoot),
        mode,
        origin,
      }),
    },
  });
});

export interface InternalAiCapability {
  available: boolean;
  configSource: 'empty' | 'process-env' | 'workspace-settings';
  model: string | null;
  provider: string | null;
}

export interface DaemonCapabilitiesOptions {
  dashboardAvailable: boolean;
  dashboardUrl: string | null;
  internalAi: InternalAiCapability;
  mode: 'api' | 'daemon';
  origin: string | null;
}

export function buildDaemonCapabilities(options: DaemonCapabilitiesOptions) {
  return {
    api: {
      available: true,
      baseUrl: options.origin,
      healthPath: `${API_PREFIX}/daemon/health`,
    },
    dashboard: {
      available: options.dashboardAvailable,
      url: options.dashboardUrl,
    },
    fileMonitor: {
      acceptedEventSources: ['host-edit', 'git-head', 'git-worktree'],
      available: options.mode === 'daemon' && process.env.ALEMBIC_DAEMON_FILE_CHANGES !== '0',
      compatibilityAliases: { [legacyHostEditSource()]: 'host-edit' },
      endpoint: `${API_PREFIX}/file-changes`,
      mode: 'daemon-git-worktree',
    },
    internalAi: options.internalAi,
    jobs: {
      available: true,
      endpoints: {
        bootstrap: `${API_PREFIX}/jobs/bootstrap`,
        list: `${API_PREFIX}/jobs`,
        rescan: `${API_PREFIX}/jobs/rescan`,
      },
      kinds: ['bootstrap', 'rescan'],
    },
  };
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

function legacyHostEditSource(): string {
  return ['ide', 'edit'].join('-');
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
