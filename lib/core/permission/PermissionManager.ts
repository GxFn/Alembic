import Logger from '../../infrastructure/logging/Logger.js';
import { PermissionDenied } from '../../shared/errors/BaseError.js';

/**
 * PermissionManager - 权限管理器
 * 基于 3-tuple 模型：(actor, action, resource)
 */
export class PermissionManager {
  constitution: any;
  logger: any;
  constructor(constitution: any) {
    this.constitution = constitution;
    this.logger = Logger.getInstance();
  }

  /**
   * 检查权限（3-tuple: actor, action, resource）
   */
  check(actor: any, action: any, resource: any) {
    // 获取角色定义
    const role = this.constitution.getRole(actor);

    if (!role) {
      return {
        allowed: false,
        reason: `Unknown role: ${actor}`,
      };
    }

    const permissions = role.permissions || [];

    // 1. 检查 wildcard 权限（管理员）
    if (permissions.includes('*')) {
      return {
        allowed: true,
        reason: 'Admin role with wildcard permission',
      };
    }

    // 2. 提取资源类型
    const resourceType = this.getResourceType(resource);

    // 3. 规范化 action 名称：read_recipes -> read:recipes
    // action 可能包含下划线（从 Gateway），权限定义使用冒号
    const normalizedAction = action.includes(':') ? action : this._normalizeAction(action);

    // 4. 检查精确匹配：action:resource
    const requiredPermission = normalizedAction.includes(':')
      ? normalizedAction
      : `${normalizedAction}:${resourceType}`;

    if (permissions.includes(requiredPermission)) {
      return {
        allowed: true,
        reason: `Permission matched: ${requiredPermission}`,
      };
    }

    // 4.5 兼容翻转格式：Gateway 用 resource:verb (candidate:create)
    //     而 Constitution 用 verb:resource (create:candidates)
    const parts = requiredPermission.split(':');
    if (parts.length === 2) {
      // 先用 verb + resourceType: create:candidates
      const flipped = `${parts[1]}:${resourceType}`;
      if (permissions.includes(flipped)) {
        return {
          allowed: true,
          reason: `Flipped format permission matched: ${flipped}`,
        };
      }
      // 也检查 verb:resource_singular: create:candidate (未来兼容)
      const flippedExact = `${parts[1]}:${parts[0]}`;
      if (flippedExact !== flipped && permissions.includes(flippedExact)) {
        return {
          allowed: true,
          reason: `Flipped format permission matched: ${flippedExact}`,
        };
      }
    }

    // 5. 检查 wildcard action：action:*
    const actionPart = normalizedAction.split(':')[0];
    const wildcardAction = `${actionPart}:*`;
    if (permissions.includes(wildcardAction)) {
      return {
        allowed: true,
        reason: `Wildcard action matched: ${wildcardAction}`,
      };
    }

    // 6. 检查 wildcard resource：*:resource
    const wildcardResource = `*:${resourceType}`;
    if (permissions.includes(wildcardResource)) {
      return {
        allowed: true,
        reason: `Wildcard resource matched: ${wildcardResource}`,
      };
    }

    // 7. 检查 read:* 权限（所有读权限）
    if (actionPart === 'read' && permissions.includes('read:*')) {
      return {
        allowed: true,
        reason: 'Read-all permission',
      };
    }

    // 8. 检查特殊权限（如 read:audit_logs:self - 仅读自己的日志）
    if (this.checkSpecialPermissions(actor, actionPart, resource, permissions)) {
      return {
        allowed: true,
        reason: 'Special permission matched',
      };
    }

    // 拒绝访问
    return {
      allowed: false,
      reason: `Missing permission: ${requiredPermission}`,
    };
  }

  /**
   * 规范化 action 名称
   * 处理多种格式：
   * - read_recipes -> read:recipes
   * - read:recipes -> read:recipes（已规范化）
   * - perm_external_agent_read_recipes -> read:recipes（测试使用的格式）
   */
  _normalizeAction(action: any) {
    // 如果已经包含冒号，直接返回
    if (action.includes(':')) {
      return action;
    }

    // 处理测试格式：perm_actor_action_resource -> action:resource
    if (action.startsWith('perm_')) {
      const parts = action.split('_');
      // perm_external_agent_read_recipes -> ['perm', 'cursor', 'agent', 'read', 'recipes']
      // 跳过 'perm' 和 actor 名称部分，从实际的 action 部分开始
      if (parts.length >= 4) {
        // 尝试找到 action 部分（常见的 action 包括 read, create, delete, submit, approve, reject）
        const commonActions = ['read', 'create', 'delete', 'submit', 'approve', 'reject', 'write'];
        const actionIndex = parts.findIndex((p: any, i: any) => i > 1 && commonActions.includes(p));

        if (actionIndex !== -1) {
          // 提取从 action 开始的部分，用冒号连接
          const actionParts = parts.slice(actionIndex);
          return actionParts.join(':');
        }
      }
    }

    // 仅将第一个下划线替换为冒号
    // read_recipes -> read:recipes
    // create_candidate -> create:candidate
    return action.replace('_', ':');
  }

  /**
   * 检查特殊权限
   */
  checkSpecialPermissions(actor: any, action: any, resource: any, permissions: any) {
    // 例如：read:audit_logs:self - 只能读自己的审计日志
    if (action === 'read' && resource.startsWith('/audit_logs')) {
      if (permissions.includes('read:audit_logs:self')) {
        // 可以进一步验证：resource 是否包含 actor 的 ID
        return true;
      }
    }

    return false;
  }

  /**
   * 从资源路径提取资源类型
   * 例如：/recipes/123 → recipes
   *      /candidates/456 → candidates
   *      { type: 'recipes', id: '123' } → recipes
   */
  getResourceType(resource: any) {
    if (typeof resource === 'string') {
      // 处理路径： /recipes/123 → recipes
      const match = resource.match(/^\/([^/]+)/);
      if (match) {
        return match[1];
      }
      // 处理纯字符串资源名：candidates, guard_rules 等
      if (resource && !resource.includes('/')) {
        return resource;
      }
      return 'unknown';
    }

    if (typeof resource === 'object' && resource.type) {
      // 处理对象：{ type: 'recipes', id: '123' }
      return resource.type;
    }

    return 'unknown';
  }

  /**
   * 强制权限检查（失败时抛异常）
   */
  enforce(actor: any, action: any, resource: any) {
    const result = this.check(actor, action, resource);

    if (!result.allowed) {
      this.logger.warn('Permission denied', {
        actor,
        action,
        resource,
        reason: result.reason,
      });

      throw new PermissionDenied(
        `Permission denied: ${actor} cannot ${action} on ${resource}. Reason: ${result.reason}`
      );
    }

    return true;
  }

  /**
   * 批量检查权限
   */
  checkMultiple(checks: any) {
    return checks.map(({ actor, action, resource }: any) => ({
      actor,
      action,
      resource,
      result: this.check(actor, action, resource),
    }));
  }

  /**
   * 获取角色的所有权限
   */
  getRolePermissions(actor: any) {
    const role = this.constitution.getRole(actor);
    return role ? role.permissions : [];
  }

  /**
   * 获取角色的约束条件
   */
  getRoleConstraints(actor: any) {
    const role = this.constitution.getRole(actor);
    return role ? role.constraints : [];
  }
}

export default PermissionManager;
