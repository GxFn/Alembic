/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - gateway, eventBus, generateTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 */

import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { EventBus } from '@alembic/core/events';
import { ReportStore } from '@alembic/core/infrastructure/report';
import { WriteZone } from '@alembic/core/io';
import { KnowledgeFileWriter, KnowledgeSyncService } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { MemoryRepositoryImpl } from '@alembic/core/memory';
import {
  type AlembicRepositoryBundle,
  type AlembicRepositoryDatabase,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import { JobDisplaySnapshotStore } from '../../daemon/observability/JobDisplaySnapshotStore.js';
import { JobProcessEventRecorder } from '../../daemon/observability/JobProcessEventRecorder.js';
import Gateway from '../../governance/gateway/Gateway.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import { getRealtimeService as _getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { resolveAlembicWorkspace } from '../../project-scope/ProjectScopeRegistry.js';
import { GenerateTaskManager } from '../../recipe-pipeline/generate/runtime/GenerateTaskManager.js';
import { AuditRepositoryImpl } from '../../repository/AuditRepository.js';
import type { ServiceContainer } from '../ServiceContainer.js';

export function getCoreRepositoryBundle(ct: ServiceContainer): AlembicRepositoryBundle {
  const existing = ct.singletons._coreRepositoryBundle as AlembicRepositoryBundle | undefined;
  if (existing) {
    return existing;
  }

  const bundle = createAlembicRepositories(ct.get('database') as AlembicRepositoryDatabase);
  ct.singletons._coreRepositoryBundle = bundle;
  return bundle;
}

export function register(c: ServiceContainer) {
  // ═══ Infrastructure ═══

  c.register('database', () => {
    if (!c.singletons.database) {
      throw new Error(
        'Database not initialized. Ensure Bootstrap.initialize() is called before using ServiceContainer.'
      );
    }
    return c.singletons.database;
  });

  c.register('logger', () => Logger.getInstance());

  c.singleton('auditStore', (ct: ServiceContainer) => {
    const db = ct.get('database') as ConstructorParameters<typeof AuditStore>[0];
    return new AuditStore(db);
  });
  c.singleton(
    'auditLogger',
    (ct: ServiceContainer) =>
      new AuditLogger(
        ct.get('auditStore') as ConstructorParameters<typeof AuditLogger>[0],
        ct.services.eventBus
          ? (ct.get('eventBus') as ConstructorParameters<typeof AuditLogger>[1])
          : null
      )
  );
  c.singleton('gateway', () => new Gateway());
  c.singleton('eventBus', () => new EventBus({ maxListeners: 30 }));

  c.singleton('generateTaskManager', (ct: ServiceContainer) => {
    const eventBus = ct.get('eventBus');
    const getRS = () => {
      try {
        return _getRealtimeService();
      } catch {
        return null;
      }
    };
    return new GenerateTaskManager({
      eventBus,
      getRealtimeService: getRS,
    } as ConstructorParameters<typeof GenerateTaskManager>[0]);
  });

  c.singleton('jobStore', (ct: ServiceContainer) => {
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(ct));
    return new JobStore({ projectRoot: resolver.dataRoot });
  });

  c.singleton('jobDisplaySnapshotStore', (ct: ServiceContainer) => {
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(ct));
    return new JobDisplaySnapshotStore({ dataRoot: resolver.dataRoot });
  });

  c.singleton('jobProcessEventRecorder', () => {
    return new JobProcessEventRecorder({
      broadcast: (payload) => {
        try {
          _getRealtimeService().broadcastJobProcessEvent(payload);
        } catch {
          /* RealtimeService is unavailable in CLI and some tests. */
        }
      },
    });
  });

  // ═══ WriteZone ═══

  c.singleton('writeZone', (ct: ServiceContainer) => {
    const resolver = ct.singletons._workspaceResolver as
      | import('@alembic/core/workspace').WorkspaceResolver
      | undefined;
    if (!resolver) {
      return null;
    }
    return new WriteZone(resolver);
  });

  // ═══ Repositories ═══

  c.singleton(
    'knowledgeRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).knowledgeRepository
  );

  c.singleton(
    'knowledgeEdgeRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).knowledgeEdgeRepository
  );

  c.singleton(
    'generateRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).generateRepository
  );

  c.singleton(
    'guardViolationRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).guardViolationRepository
  );

  c.singleton('auditRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as ConstructorParameters<typeof AuditRepositoryImpl>[0];
    return new AuditRepositoryImpl(db);
  });

  c.singleton('memoryRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new MemoryRepositoryImpl(
      drizzle as ConstructorParameters<typeof MemoryRepositoryImpl>[0]
    );
  });

  c.singleton(
    'sessionRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).sessionRepository
  );

  c.singleton(
    'proposalRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).proposalRepository
  );

  c.singleton(
    'recipeSourceRefRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).recipeSourceRefRepository
  );

  c.singleton(
    'coverageLedgerRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).coverageLedgerRepository
  );

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new KnowledgeFileWriter(dataRoot, wz);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const sourceRefReconciler = ct.singletons.sourceRefReconciler as
      | import('@alembic/core/knowledge').SourceRefReconciler
      | undefined;
    return new KnowledgeSyncService(dataRoot, {
      sourceRefReconciler: sourceRefReconciler || undefined,
    });
  });

  // ═══ ReportStore ═══

  c.singleton('reportStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as WriteZone | null;
    return new ReportStore(path.join(dataRoot, '.asd', 'logs', 'reports'), wz ?? undefined);
  });
}
