/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - gateway, eventBus, bootstrapTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 */

import path from 'node:path';
import { JobStore } from '@alembic/core/daemon';
import { EventBus } from '@alembic/core/events';
import { ReportStore } from '@alembic/core/infrastructure/report/ReportStore';
import { WriteZone } from '@alembic/core/io';
import Logger from '@alembic/core/logging';
import {
  type AlembicRepositoryBundle,
  type AlembicRepositoryDatabase,
  createAlembicRepositories,
} from '@alembic/core/repositories';
import { MemoryRepositoryImpl } from '@alembic/core/repository/memory/MemoryRepository';
import { unwrapRawDb } from '@alembic/core/search';
import { KnowledgeFileWriter } from '@alembic/core/service/knowledge/KnowledgeFileWriter';
import { KnowledgeSyncService } from '@alembic/core/service/knowledge/KnowledgeSyncService';
import { resolveDataRoot, resolveProjectRoot } from '@alembic/core/workspace';
import Gateway from '../../core/gateway/Gateway.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import { getRealtimeService as _getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { AuditRepositoryImpl } from '../../repository/audit/AuditRepository.js';
import { RemoteCommandRepository } from '../../repository/remote/RemoteCommandRepository.js';
import { BootstrapTaskManager } from '../../service/bootstrap/BootstrapTaskManager.js';
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
    const drizzle = (db as unknown as { getDrizzle(): unknown }).getDrizzle();
    return new AuditStore(db, drizzle as ConstructorParameters<typeof AuditStore>[1]);
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

  c.singleton('bootstrapTaskManager', (ct: ServiceContainer) => {
    const eventBus = ct.get('eventBus');
    const getRS = () => {
      try {
        return _getRealtimeService();
      } catch {
        return null;
      }
    };
    return new BootstrapTaskManager({
      eventBus,
      getRealtimeService: getRS,
    } as ConstructorParameters<typeof BootstrapTaskManager>[0]);
  });

  c.singleton('jobStore', (ct: ServiceContainer) => {
    return new JobStore({ projectRoot: resolveProjectRoot(ct) });
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
    'codeEntityRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).codeEntityRepository
  );

  c.singleton(
    'bootstrapRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).bootstrapRepository
  );

  c.singleton(
    'guardViolationRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).guardViolationRepository
  );

  c.singleton('auditRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new AuditRepositoryImpl(drizzle as ConstructorParameters<typeof AuditRepositoryImpl>[0]);
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

  c.singleton('remoteCommandRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    return new RemoteCommandRepository(
      unwrapRawDb(db as unknown) as ConstructorParameters<typeof RemoteCommandRepository>[0],
      db.getDrizzle() as ConstructorParameters<typeof RemoteCommandRepository>[1]
    );
  });

  c.singleton(
    'recipeSourceRefRepository',
    (ct: ServiceContainer) => getCoreRepositoryBundle(ct).recipeSourceRefRepository
  );

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as import('@alembic/core/io').WriteZone | undefined;
    return new KnowledgeFileWriter(dataRoot, wz);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const sourceRefReconciler = ct.singletons.sourceRefReconciler as
      | import('@alembic/core/service/knowledge/SourceRefReconciler').SourceRefReconciler
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
