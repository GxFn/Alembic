import EventEmitter from 'node:events';
import Logger from '@alembic/core/logging';
import { InternalError } from '@alembic/core/shared';
import { v4 as uuidv4 } from 'uuid';

export interface GatewayConfig {
  [key: string]: unknown;
}

export interface GatewayRequest {
  actor: string;
  action: string;
  resource?: string;
  data?: Record<string, unknown>;
  session?: string;
  confirmed?: boolean;
}

export interface GatewayContext {
  requestId: string;
  actor: string;
  action: string;
  resource: string | undefined;
  data: Record<string, unknown>;
  session: string | undefined;
  startTime: number;
}

export interface GatewayResult {
  success: boolean;
  requestId: string;
  data?: unknown;
  error?: { message: string; code: string; statusCode: number };
  duration?: number;
}

interface AuditLogger {
  log(entry: Record<string, unknown>): Promise<void>;
}

interface EventBus {
  emit(event: string, data: Record<string, unknown>): void;
}

export interface GatewayDependencies {
  auditLogger?: AuditLogger | null;
}

/**
 * Gateway - route wrapper and audit envelope.
 *
 * Operation-specific HTTP routes own write safeguards. Gateway no longer acts
 * as a central Constitution/RBAC authority.
 */
export class Gateway extends EventEmitter {
  auditLogger: AuditLogger | null;
  config: GatewayConfig | undefined;
  eventBus: EventBus | null;
  logger;
  routes: Map<string, (ctx: GatewayContext) => Promise<unknown>>;
  constructor(config?: GatewayConfig) {
    super();
    this.config = config;
    this.logger = Logger.getInstance();
    this.routes = new Map();

    this.auditLogger = null;
    this.eventBus = null; // 可选：外部注入 EventBus 实例
  }

  /** 设置依赖 */
  setDependencies({ auditLogger }: GatewayDependencies) {
    this.auditLogger = auditLogger ?? null;
  }

  /** 注册路由处理器 */
  register(action: string, handler: (ctx: GatewayContext) => Promise<unknown>) {
    if (this.routes.has(action)) {
      throw new Error(`Action '${action}' is already registered`);
    }
    this.routes.set(action, handler);
    this.logger.debug(`Route registered: ${action}`);
  }

  /** 获取已注册的 action 列表 */
  getRegisteredActions() {
    return [...this.routes.keys()];
  }

  /** 执行操作（主入口） */
  async execute(request: GatewayRequest): Promise<GatewayResult> {
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

      // 2. guard — reserved for operation-neutral request checks
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errLike = error as { code?: string; statusCode?: number } | undefined;

      await this.auditFailure(context, {
        message: errMsg,
        code: errLike?.code,
        statusCode: errLike?.statusCode,
      });

      const duration = Date.now() - startTime;
      this.logger.error('Gateway: Request failed', {
        requestId,
        error: errMsg,
        duration: `${duration}ms`,
      });

      return {
        success: false,
        requestId,
        error: {
          message: errMsg,
          code: errLike?.code || 'INTERNAL_ERROR',
          statusCode: errLike?.statusCode || 500,
        },
        duration,
      };
    }
  }

  /**
   * 仅检查请求格式并审计（不执行业务逻辑）。
   */
  async checkOnly(request: GatewayRequest) {
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
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errLike = error as { code?: string; statusCode?: number } | undefined;

      await this.auditFailure(context, {
        message: errMsg,
        code: errLike?.code,
        statusCode: errLike?.statusCode,
      });
      return {
        success: false,
        requestId,
        error: {
          message: errMsg,
          code: errLike?.code || 'INTERNAL_ERROR',
          statusCode: errLike?.statusCode || 500,
        },
      };
    }
  }

  // ─── Pipeline Steps ────────────────────────────────────

  /** validate — 验证请求格式 */
  validateRequest(request: GatewayRequest) {
    if (!request.actor) {
      throw new InternalError('Missing required field: actor');
    }
    if (!request.action) {
      throw new InternalError('Missing required field: action');
    }
  }

  /** guard — central role/RBAC checks were removed from mainline. */
  async guard(_context: GatewayContext) {
    return;
  }

  /** route — 路由到处理器 */
  async routeToHandler(context: GatewayContext) {
    const handler = this.routes.get(context.action);

    if (!handler) {
      throw new InternalError(`No handler found for action: ${context.action}`);
    }

    return await handler(context);
  }

  /** audit — 记录成功 */
  async auditSuccess(context: GatewayContext, result: unknown) {
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

    // 向 EventBus 发送 Gateway 操作完成事件
    if (this.eventBus) {
      this.emit('gateway:action:completed', { ...entry, timestamp: Date.now() });
      this.eventBus.emit('gateway:action:completed', { ...entry, timestamp: Date.now() });
    }
  }

  /** audit — 记录失败 */
  async auditFailure(
    context: GatewayContext,
    error: { message: string; code?: string; statusCode?: number }
  ) {
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

  /** 获取所有注册的路由 */
  getRoutes() {
    return Array.from(this.routes.keys());
  }
}

export default Gateway;
