import Logger from '../../infrastructure/logging/Logger.js';

/**
 * AuditLogger - 审计日志记录器
 */
export class AuditLogger {
  auditStore: any;
  logger: any;
  constructor(auditStore) {
    this.auditStore = auditStore;
    this.logger = Logger.getInstance();
  }

  /**
   * 记录审计日志
   * 兼容两种传入格式:
   *   Gateway 风格: { actor, action, resource, result, data, duration }
   *   Service 风格: { actor, action, resourceType, resourceId, details, timestamp }
   */
  async log(entry) {
    // 兼容 Service 层传入 resourceType + resourceId（而非 resource）
    const resource =
      entry.resource ||
      (entry.resourceType && entry.resourceId
        ? `${entry.resourceType}:${entry.resourceId}`
        : undefined);

    // 兼容 Service 层传入 details（而非 data）
    const data = entry.data || (entry.details ? { details: entry.details } : {});

    const auditEntry = {
      id: entry.requestId || this.generateId(),
      timestamp: Date.now(),
      actor: entry.actor,
      actor_context: JSON.stringify(entry.context || {}),
      action: entry.action,
      resource: this.formatResource(resource),
      operation_data: JSON.stringify(data),
      result: entry.result || 'success',
      error_message: entry.error || null,
      duration: entry.duration || null,
    };

    try {
      await this.auditStore.save(auditEntry);
      this.logger.debug('Audit log recorded', {
        requestId: entry.requestId,
        actor: entry.actor,
        action: entry.action,
      });
    } catch (error: any) {
      // 审计失败不应阻断业务，仅记录错误
      this.logger.error('Failed to save audit log', {
        error: error.message,
        entry: auditEntry,
      });
    }
  }

  /**
   * 生成 ID
   */
  generateId() {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 格式化资源
   */
  formatResource(resource) {
    if (typeof resource === 'string') {
      return resource;
    }

    if (typeof resource === 'object' && resource !== null) {
      return JSON.stringify(resource);
    }

    return String(resource);
  }

  /**
   * 查询审计日志
   */
  async query(filters) {
    return await this.auditStore.query(filters);
  }

  /**
   * 获取特定请求的日志
   */
  async getByRequestId(requestId) {
    return await this.auditStore.findByRequestId(requestId);
  }

  /**
   * 获取特定角色的日志
   */
  async getByActor(actor, limit = 100) {
    return await this.auditStore.findByActor(actor, limit);
  }

  /**
   * 获取特定操作的日志
   */
  async getByAction(action, limit = 100) {
    return await this.auditStore.findByAction(action, limit);
  }

  /**
   * 获取失败的操作日志
   */
  async getFailures(limit = 100) {
    return await this.auditStore.findByResult('failure', limit);
  }

  /**
   * 统计审计数据
   */
  async getStats(timeRange) {
    return await this.auditStore.getStats(timeRange);
  }
}

export default AuditLogger;
