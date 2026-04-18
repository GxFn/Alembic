/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - gateway, eventBus, bootstrapTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 */

import path from 'node:path';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { KnowledgeSyncService } from '../../cli/KnowledgeSyncService.js';
import Gateway from '../../core/gateway/Gateway.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import { EventBus } from '../../infrastructure/event/EventBus.js';
import { WriteZone } from '../../infrastructure/io/WriteZone.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getRealtimeService as _getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { ReportStore } from '../../infrastructure/report/ReportStore.js';
import { AuditRepositoryImpl } from '../../repository/audit/AuditRepository.js';
import { BootstrapRepositoryImpl } from '../../repository/bootstrap/BootstrapRepository.js';
import { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import { GuardViolationRepositoryImpl } from '../../repository/guard/GuardViolationRepository.js';
import { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';
import { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import { MemoryRepositoryImpl } from '../../repository/memory/MemoryRepository.js';
import { RemoteCommandRepository } from '../../repository/remote/RemoteCommandRepository.js';
import { unwrapRawDb } from '../../repository/search/SearchRepoAdapter.js';
import { SessionRepositoryImpl } from '../../repository/session/SessionRepository.js';
import { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import { BootstrapTaskManager } from '../../service/bootstrap/BootstrapTaskManager.js';
import { KnowledgeFileWriter } from '../../service/knowledge/KnowledgeFileWriter.js';
import type { ServiceContainer } from '../ServiceContainer.js';

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

  // ═══ WriteZone ═══

  c.singleton('writeZone', (ct: ServiceContainer) => {
    const resolver = ct.singletons._workspaceResolver as
      | import('../../shared/WorkspaceResolver.js').WorkspaceResolver
      | undefined;
    if (!resolver) {
      throw new Error('[WriteZone] WorkspaceResolver not initialized');
    }
    return new WriteZone(resolver);
  });

  // ═══ Repositories ═══

  c.singleton('knowledgeRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as ConstructorParameters<typeof KnowledgeRepositoryImpl>[0];
    const drizzle = (db as unknown as { getDrizzle(): unknown }).getDrizzle();
    return new KnowledgeRepositoryImpl(
      db,
      drizzle as ConstructorParameters<typeof KnowledgeRepositoryImpl>[1]
    );
  });

  c.singleton('knowledgeEdgeRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new KnowledgeEdgeRepositoryImpl(
      drizzle as ConstructorParameters<typeof KnowledgeEdgeRepositoryImpl>[0]
    );
  });

  c.singleton('codeEntityRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new CodeEntityRepositoryImpl(
      drizzle as ConstructorParameters<typeof CodeEntityRepositoryImpl>[0]
    );
  });

  c.singleton('bootstrapRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new BootstrapRepositoryImpl(
      drizzle as ConstructorParameters<typeof BootstrapRepositoryImpl>[0]
    );
  });

  c.singleton('guardViolationRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new GuardViolationRepositoryImpl(
      drizzle as ConstructorParameters<typeof GuardViolationRepositoryImpl>[0]
    );
  });

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

  c.singleton('sessionRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new SessionRepositoryImpl(
      drizzle as ConstructorParameters<typeof SessionRepositoryImpl>[0]
    );
  });

  c.singleton('proposalRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new ProposalRepository(drizzle as ConstructorParameters<typeof ProposalRepository>[0]);
  });

  c.singleton('remoteCommandRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    return new RemoteCommandRepository(
      unwrapRawDb(db as unknown) as ConstructorParameters<typeof RemoteCommandRepository>[0],
      db.getDrizzle() as ConstructorParameters<typeof RemoteCommandRepository>[1]
    );
  });

  c.singleton('recipeSourceRefRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as unknown as { getDrizzle(): unknown };
    const drizzle = db.getDrizzle();
    return new RecipeSourceRefRepositoryImpl(
      drizzle as ConstructorParameters<typeof RecipeSourceRefRepositoryImpl>[0]
    );
  });

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.singletons.writeZone as
      | import('../../infrastructure/io/WriteZone.js').WriteZone
      | undefined;
    return new KnowledgeFileWriter(dataRoot, wz);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const sourceRefReconciler = ct.singletons.sourceRefReconciler as
      | import('../../service/knowledge/SourceRefReconciler.js').SourceRefReconciler
      | undefined;
    return new KnowledgeSyncService(dataRoot, {
      sourceRefReconciler: sourceRefReconciler || undefined,
    });
  });

  // ═══ ReportStore ═══

  c.singleton('reportStore', (ct: ServiceContainer) => {
    const dataRoot = resolveDataRoot(ct);
    const wz = ct.get('writeZone') as WriteZone;
    return new ReportStore(path.join(dataRoot, '.asd', 'logs', 'reports'), wz);
  });
}
