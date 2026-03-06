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
import { KnowledgeFileWriter } from '../../service/knowledge/KnowledgeFileWriter.js';
import { BootstrapTaskManager } from '../../service/bootstrap/BootstrapTaskManager.js';
import { TaskRepositoryImpl } from '../../repository/task/TaskRepository.impl.js';

export function register(c) {
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

  c.singleton('auditStore', (ct) => new AuditStore(ct.get('database')));
  c.singleton('auditLogger', (ct) => new AuditLogger(ct.get('auditStore')));
  c.singleton('gateway', () => new Gateway());
  c.singleton('eventBus', () => new EventBus({ maxListeners: 30 }));

  c.singleton('bootstrapTaskManager', (ct) => {
    const eventBus = ct.get('eventBus');
    const getRS = () => {
      try {
        return _getRealtimeService();
      } catch {
        return null;
      }
    };
    return new BootstrapTaskManager({ eventBus, getRealtimeService: getRS });
  });

  // ═══ Repositories ═══

  c.singleton('knowledgeRepository', (ct) => new KnowledgeRepositoryImpl(ct.get('database')));

  c.singleton('knowledgeFileWriter', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new KnowledgeFileWriter(projectRoot);
  });

  c.singleton('knowledgeSyncService', (ct) => {
    const projectRoot = ct.singletons._projectRoot || process.cwd();
    return new KnowledgeSyncService(projectRoot);
  });

  c.singleton('taskRepository', (ct) => new TaskRepositoryImpl(ct.get('database')));
}
