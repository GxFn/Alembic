import EventEmitter from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import Logger from '../../infrastructure/logging/Logger.js';
import { InternalError } from '../../shared/errors/BaseError.js';

/**
 * Gateway - 统一网关
 * 所有操作的唯一入口。
 *
 * Pipeline (4 步):
 *   validate → guard → route → audit
 */
export class Gateway extends EventEmitter {
  auditLogger: any;
  config: any;
  constitution: any;
  constitutionValidator: any;
  eventBus: any;
  logger: any;
  permissionManager: any;
  routes: any;
  constructor(config) {
    super();
    this.config = config;
    this.logger = Logger.getInstance();
    this.routes = new Map();

    // 依赖注入（稍后设置）
    this.constitution = null;
    this.constitutionValidator = null;
    this.permissionManager = null;
    this.auditLogger = null;
    this.eventBus = null; // 可选：外部注入 EventBus 实例
  }

  /**
   * 设置依赖
   */
  setDependencies({ constitution, constitutionValidator, permissionManager, auditLogger }) {
    this.constitution = constitution;
    this.constitutionValidator = constitutionValidator;
    this.permissionManager = permissionManager;
    this.auditLogger = auditLogger;
  }

  /**
   * 注册路由处理器
   */
  register(action, handler) {
    if (this.routes.has(action)) {
      throw new Error(`Action '${action}' is already registered`);
    }
    this.routes.set(action, handler);
    this.logger.debug(`Route registered: ${action}`);
  }

  /**
   * 获取已注册的 action 列表
   */
  getRegisteredActions() {
    return [...this.routes.keys()];
  }

  /**
   * 执行操作（主入口）
   */
  async execute(request) {
    const requestId = uuidv4();
    const startTime = Date.now();

    const context = {
      requestId,
      actor: request.actor,
      action: request.action,
      resource: request.resource,
      data: request.data || {},
      session: request.session,
      startTime,
    };

    this.logger.info('Gateway: Request received', {
      requestId,
      actor: context.actor,
      action: context.action,
    });

    try {
      // 1. validate — 请求格式
      this.validateRequest(request);

      // 2. guard — 权限 + 宪法规则
      await this.guard(context);

      // 3. route — 路由到处理器
      const result = await this.routeToHandler(context);

      // 4. audit — 记录成功
      await this.auditSuccess(context, result);

      const duration = Date.now() - startTime;
      this.logger.info('Gateway: Request completed', {
        requestId,
        duration: `${duration}ms`,
      });

      return {
        success: true,
        requestId,
        data: result,
        duration,
      };
    } catch (error: any) {
      await this.auditFailure(context, error);

      const duration = Date.now() - startTime;
      this.logger.error('Gateway: Request failed', {
        requestId,
        error: error.message,
        duration: `${duration}ms`,
      });

      return {
        success: false,
        requestId,
        error: {
          message: error.message,
          code: error.code || 'INTERNAL_ERROR',
          statusCode: error.statusCode || 500,
        },
        duration,
      };
    }
  }

  /**
   * 仅检查权限与宪法（不执行业务逻辑）
   * 用于 MCP Gateway gating
   */
  async checkOnly(request) {
    const requestId = uuidv4();
    const startTime = Date.now();

    const context = {
      requestId,
      actor: request.actor,
      action: request.action,
      resource: request.resource,
      data: request.data || {},
      session: request.session,
      startTime,
    };

    try {
      this.validateRequest(request);
      await this.guard(context);

      await this.auditSuccess(context, { checkOnly: true });
      return { success: true, requestId };
    } catch (error: any) {
      await this.auditFailure(context, error);
      return {
        success: false,
        requestId,
        error: {
          message: error.message,
          code: error.code || 'INTERNAL_ERROR',
          statusCode: error.statusCode || 500,
        },
      };
    }
  }

  // ─── Pipeline Steps ────────────────────────────────────

  /**
   * validate — 验证请求格式
   */
  validateRequest(request) {
    if (!request.actor) {
      throw new InternalError('Missing required field: actor');
    }
    if (!request.action) {
      throw new InternalError('Missing required field: action');
    }
  }

  /**
   * guard — 权限检查 + 宪法验证
   */
  async guard(context) {
    // 权限检查
    if (this.permissionManager) {
      this.permissionManager.enforce(context.actor, context.action, context.resource);
    }

    // 宪法数据完整性规则
    if (this.constitutionValidator) {
      await this.constitutionValidator.enforce({
        actor: context.actor,
        action: context.action,
        resource: context.resource,
        data: context.data,
      });
    }
  }

  /**
   * route — 路由到处理器
   */
  async routeToHandler(context) {
    const handler = this.routes.get(context.action);

    if (!handler) {
      throw new InternalError(`No handler found for action: ${context.action}`);
    }

    return await handler(context);
  }

  /**
   * audit — 记录成功
   */
  async auditSuccess(context, result) {
    if (!this.auditLogger) {
      return;
    }

    const entry = {
      requestId: context.requestId,
      actor: context.actor,
      action: context.action,
      resource: context.resource,
      result: 'success',
      duration: Date.now() - context.startTime,
      context: { session: context.session },
    };
    await this.auditLogger.log(entry);

    // 向 EventBus 发送 Gateway 操作完成事件（供 SignalCollector 等监听）
    if (this.eventBus) {
      this.emit('gateway:action:completed', { ...entry, timestamp: Date.now() });
      this.eventBus.emit('gateway:action:completed', { ...entry, timestamp: Date.now() });
    }
  }

  /**
   * audit — 记录失败
   */
  async auditFailure(context, error) {
    if (!this.auditLogger) {
      return;
    }

    const entry = {
      requestId: context.requestId,
      actor: context.actor,
      action: context.action,
      resource: context.resource,
      result: 'failure',
      error: error.message,
      duration: Date.now() - context.startTime,
      context: { session: context.session },
    };
    await this.auditLogger.log(entry);

    // 向 EventBus 发送 Gateway 操作失败事件
    if (this.eventBus) {
      this.emit('gateway:action:failed', { ...entry, timestamp: Date.now() });
      this.eventBus.emit('gateway:action:failed', { ...entry, timestamp: Date.now() });
    }
  }

  /**
   * 获取所有注册的路由
   */
  getRoutes() {
    return Array.from(this.routes.keys());
  }
}

export default Gateway;
