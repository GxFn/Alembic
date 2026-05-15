import express from 'express';
import { getPackageVersion } from '../../daemon/DaemonState.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import type { GitDiffCheckpointStatus } from '../../service/evolution/git-diff-checkpoint/index.js';
import { resolveProjectRoot } from '../../shared/resolveProjectRoot.js';
import { WorkspaceResolver } from '../../shared/WorkspaceResolver.js';

const router = express.Router();

router.get('/health', (_req, res) => {
  const container = getServiceContainer();
  const projectRoot = resolveProjectRoot(container);
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const gitDiffCheckpoint = readGitDiffCheckpointStatus(container);
  res.json({
    success: true,
    data: {
      gitDiffCheckpoint,
      mode: process.env.ALEMBIC_DAEMON_MODE === '1' ? 'daemon' : 'api',
      projectRoot,
      dataRoot: resolver.dataRoot,
      projectId: resolver.projectId,
      version: getPackageVersion(),
      pid: process.pid,
      uptime: process.uptime(),
      databasePath: resolver.databasePath,
      schemaMigrationVersion: getSchemaMigrationVersion(container),
    },
  });
});

function readGitDiffCheckpointStatus(
  container: ReturnType<typeof getServiceContainer>
): GitDiffCheckpointStatus | null {
  const checkpoint = container.singletons.gitDiffCheckpoint as
    | { getStatus?: () => GitDiffCheckpointStatus }
    | undefined;
  return checkpoint?.getStatus?.() ?? null;
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
