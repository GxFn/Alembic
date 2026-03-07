/**
 * BaseError - 所有错误的基类
 */
export class BaseError extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code: string, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
  }
}

/**
 * PermissionDenied - 权限拒绝错误
 */
export class PermissionDenied extends BaseError {
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', 403);
  }
}

/**
 * ConstitutionViolation - 宪法违反错误
 */
export class ConstitutionViolation extends BaseError {
  violations: Array<{ rule: string }>;
  constructor(violations: Array<{ rule: string }>) {
    const message = `Constitution violation: ${violations.map((v) => v.rule).join(', ')}`;
    super(message, 'CONSTITUTION_VIOLATION', 400);
    this.violations = violations;
  }
}

/**
 * ValidationError - 验证错误
 */
export class ValidationError extends BaseError {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'VALIDATION_ERROR', 400);
    this.details = details;
  }
}

/**
 * NotFoundError - 资源未找到错误
 */
export class NotFoundError extends BaseError {
  resource: string | undefined;
  resourceId: string | undefined;
  constructor(message: string, resource?: string, resourceId?: string) {
    // 如果没有提供 message，那么第一个参数就是 resource
    let finalMessage = message;
    let finalResource = resource;

    if (!resource) {
      finalMessage = `Resource not found: ${message}`;
      finalResource = message;
    } else if (resourceId) {
      finalMessage = `${message} (${resource}:${resourceId})`;
    }

    super(finalMessage, 'NOT_FOUND', 404);
    this.resource = finalResource;
    this.resourceId = resourceId;
  }
}

/**
 * ConflictError - 资源冲突错误
 */
export class ConflictError extends BaseError {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message, 'CONFLICT', 409);
    this.details = details;
  }
}

/**
 * InternalError - 内部错误
 */
export class InternalError extends BaseError {
  constructor(message: string) {
    super(message, 'INTERNAL_ERROR', 500);
  }
}

/* 默认导出已移除 — 使用命名导入: import { ValidationError } from '...' */
