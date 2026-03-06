import Logger from '../../infrastructure/logging/Logger.js';
import { ConstitutionViolation } from '../../shared/errors/BaseError.js';

/**
 * ConstitutionValidator — 数据守护验证器
 *
 * 精简设计: 4 条纯数据完整性规则，不做伦理/价值观判断。
 * 每条规则对应 constitution.yaml 中的一个 rule.check 值。
 */
export class ConstitutionValidator {
  checkers: any;
  constitution: any;
  logger: any;
  constructor(constitution: any) {
    this.constitution = constitution;
    this.logger = Logger.getInstance();

    /** rule.check → 检查函数 */
    this.checkers = {
      destructive_needs_confirmation: this._checkDestructive.bind(this),
      creation_needs_content: this._checkContent.bind(this),
      ai_cannot_approve_recipe: this._checkAiRecipe.bind(this),
      batch_needs_authorization: this._checkBatch.bind(this),
    };
  }

  /**
   * 验证操作，返回违规列表
   */
  async validate(request: any) {
    const violations: any[] = [];
    const rules = this.constitution.getRules?.() || this.constitution.rules || [];

    for (const rule of rules) {
      const checker = this.checkers[rule.check];
      if (checker) {
        const v = checker(request, rule);
        if (v) {
          violations.push(v);
        }
      }
    }

    // 兼容旧 priorities 格式（如果新 rules 为空但有旧 priorities）
    if (rules.length === 0) {
      const priorities = this.constitution.getPriorities?.() || [];
      for (const p of priorities) {
        const pvs = await this._checkLegacyPriority(p, request);
        violations.push(...pvs);
      }
    }

    if (violations.length > 0) {
      this.logger.warn('Constitution violations', {
        actor: request.actor,
        action: request.action,
        count: violations.length,
      });
    }

    return { compliant: violations.length === 0, violations };
  }

  /**
   * 强制验证（违规时抛异常）
   */
  async enforce(request: any) {
    const result = await this.validate(request);
    if (!result.compliant) {
      throw new ConstitutionViolation(result.violations);
    }
    return result;
  }

  // ─── 规则检查器 ────────────────────────────────────────

  /** 删除操作需要确认 */
  _checkDestructive(req: any, rule: any) {
    const destructive = ['delete', 'remove', 'destroy', 'purge', 'batch_delete'];
    if (!destructive.some((w) => req.action?.toLowerCase().includes(w))) {
      return null;
    }
    if (req.data?.confirmed || req.confirmed) {
      return null;
    }
    return { rule: rule.id, reason: '操作未经确认', suggestion: '添加 confirmed: true' };
  }

  /** 创建候选/Recipe 需要内容 */
  _checkContent(req: any, rule: any) {
    const verb = this._verb(req.action);
    const res = this._resource(req.action, req.resource);
    const isCreation =
      (verb === 'create' && (res.includes('candidate') || res.includes('recipe'))) ||
      req.action === 'create_candidate' ||
      req.action === 'create_recipe';
    if (!isCreation) {
      return null;
    }
    const ok =
      req.data?.code ||
      req.code ||
      req.data?.content ||
      (Array.isArray(req.data?.items) && req.data.items.length > 0) ||
      req.data?.filePaths;
    if (ok) {
      return null;
    }
    return { rule: rule.id, reason: '缺少 code/content', suggestion: '提供代码或内容' };
  }

  /** AI 不能直接创建/批准 Recipe */
  _checkAiRecipe(req: any, rule: any) {
    if (!this._isAI(req.actor)) {
      return null;
    }
    const verb = this._verb(req.action);
    const res = this._resource(req.action, req.resource);
    const isRecipeMod =
      (verb === 'create' && res.includes('recipe')) ||
      verb === 'approve' ||
      verb === 'publish' ||
      req.action === 'approve_candidate' ||
      req.action === 'create_recipe';
    if (!isRecipeMod) {
      return null;
    }
    return {
      rule: rule.id,
      reason: 'AI 不能直接操作 Recipe',
      suggestion: '通过 Dashboard 人工审批',
    };
  }

  /** 批量操作需要授权 */
  _checkBatch(req: any, rule: any) {
    if (!req.action?.includes('batch_')) {
      return null;
    }
    if (req.data?.authorized || req.authorized) {
      return null;
    }
    return { rule: rule.id, reason: '缺少授权标志', suggestion: '添加 authorized: true' };
  }

  // ─── 辅助方法 ──────────────────────────────────────────

  _verb(action: any) {
    if (!action) {
      return '';
    }
    return action.includes(':') ? action.split(':').pop() : action;
  }

  _resource(action: any, resource: any) {
    if (action?.includes(':')) {
      return action.split(':')[0];
    }
    if (typeof resource === 'string' && resource.startsWith('/')) {
      const m = resource.match(/^\/([^/]+)/);
      return m ? m[1] : resource;
    }
    return resource || '';
  }

  _isAI(actor: any) {
    return ['external_agent', 'chat_agent'].some((a) => actor?.toLowerCase().includes(a));
  }

  // ─── 旧格式兼容 ───────────────────────────────────────

  /** 兼容旧 priorities 格式 */
  async _checkLegacyPriority(priority: any, request: any) {
    const violations: { rule: any; reason: string; suggestion: string }[] = [];
    if (priority.id === 1) {
      const v = this._checkDestructive(request, { id: 'destructive_confirm' });
      if (v) {
        violations.push(v);
      }
      const v2 = this._checkContent(request, { id: 'content_required' });
      if (v2) {
        violations.push(v2);
      }
    }
    if (priority.id === 2) {
      const v = this._checkAiRecipe(request, { id: 'ai_no_direct_recipe' });
      if (v) {
        violations.push(v);
      }
      const v2 = this._checkBatch(request, { id: 'batch_authorized' });
      if (v2) {
        violations.push(v2);
      }
    }
    return violations;
  }
}

export default ConstitutionValidator;
