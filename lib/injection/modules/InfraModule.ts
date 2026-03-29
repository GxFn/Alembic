/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - gateway, eventBus, bootstrapTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 */

import path from 'node:path';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import { KnowledgeSyncService } from '../../cli/KnowledgeSyncService.js';
import Gateway from '../../core/gateway/Gateway.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import { EventBus } from '../../infrastructure/event/EventBus.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getRealtimeService as _getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { ReportStore } from '../../infrastructure/report/ReportStore.js';
import { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
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

  // ═══ Repositories ═══

  c.singleton('knowledgeRepository', (ct: ServiceContainer) => {
    const db = ct.get('database') as ConstructorParameters<typeof KnowledgeRepositoryImpl>[0];
    const drizzle = (db as unknown as { getDrizzle(): unknown }).getDrizzle();
    return new KnowledgeRepositoryImpl(
      db,
      drizzle as ConstructorParameters<typeof KnowledgeRepositoryImpl>[1]
    );
  });

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new KnowledgeFileWriter(projectRoot);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new KnowledgeSyncService(projectRoot);
  });

  // ═══ ReportStore ═══

  c.singleton('reportStore', (ct: ServiceContainer) => {
    const projectRoot = resolveProjectRoot(ct);
    return new ReportStore(path.join(projectRoot, '.autosnippet', 'logs', 'reports'));
  });
}
