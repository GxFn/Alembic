/**
 * InfraModule — 基础设施 + 仓储注册
 *
 * 负责注册:
 *   - database, logger, auditStore, auditLogger
 *   - gateway, eventBus, bootstrapTaskManager
 *   - knowledgeRepository, knowledgeFileWriter, knowledgeSyncService
 *   - taskRepository
 *
 * @param {import('../ServiceContainer.js').ServiceContainer} c
 */

import { KnowledgeSyncService } from '../../cli/KnowledgeSyncService.js';
import Gateway from '../../core/gateway/Gateway.js';
import AuditLogger from '../../infrastructure/audit/AuditLogger.js';
import AuditStore from '../../infrastructure/audit/AuditStore.js';
import { EventBus } from '../../infrastructure/event/EventBus.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getRealtimeService as _getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { KnowledgeRepositoryImpl } from '../../repository/knowledge/KnowledgeRepository.impl.js';
import { TaskRepositoryImpl } from '../../repository/task/TaskRepository.impl.js';
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

  c.singleton(
    'auditStore',
    (ct: ServiceContainer) =>
      new AuditStore(ct.get('database') as ConstructorParameters<typeof AuditStore>[0])
  );
  c.singleton(
    'auditLogger',
    (ct: ServiceContainer) =>
      new AuditLogger(ct.get('auditStore') as ConstructorParameters<typeof AuditLogger>[0])
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

  c.singleton(
    'knowledgeRepository',
    (ct: ServiceContainer) =>
      new KnowledgeRepositoryImpl(
        ct.get('database') as ConstructorParameters<typeof KnowledgeRepositoryImpl>[0]
      )
  );

  c.singleton('knowledgeFileWriter', (ct: ServiceContainer) => {
    const projectRoot = (ct.singletons._projectRoot as string | undefined) || process.cwd();
    return new KnowledgeFileWriter(projectRoot);
  });

  c.singleton('knowledgeSyncService', (ct: ServiceContainer) => {
    const projectRoot = (ct.singletons._projectRoot as string | undefined) || process.cwd();
    return new KnowledgeSyncService(projectRoot);
  });

  c.singleton(
    'taskRepository',
    (ct: ServiceContainer) =>
      new TaskRepositoryImpl(
        ct.get('database') as ConstructorParameters<typeof TaskRepositoryImpl>[0]
      )
  );
}
