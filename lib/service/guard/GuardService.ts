import { v4 as uuidv4 } from 'uuid';
import Logger from '../../infrastructure/logging/Logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { unixNow } from '../../shared/utils/common.js';

interface KnowledgeRepositoryLike {
  create(entry: unknown): Promise<{ id: string; title?: string }>;
  findById(id: string): Promise<{
    id: string;
    title?: string;
    lifecycle?: string;
    constraints?: { guards?: { pattern?: string; severity?: string; message?: string }[] };
  } | null>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
  findActiveRules(): Promise<
    {
      id: string;
      title: string;
      language?: string;
      constraints?: { guards?: { pattern: string; severity?: string; message?: string }[] };
    }[]
  >;
  findWithPagination(
    filter: Record<string, string>,
    opts: { page: number; pageSize: number }
  ): Promise<unknown>;
  search(
    keyword: string,
    opts: { page: number; pageSize: number }
  ): Promise<{ data: { kind: string; knowledgeType: string }[]; total: number }>;
  getStats(): Promise<unknown>;
}

interface AuditLoggerLike {
  log(entry: Record<string, unknown>): Promise<void>;
}

interface GuardCheckEngineLike {
  checkCode(
    code: string,
    language: string,
    options?: Record<string, unknown>
  ): {
    ruleId: string;
    severity?: string;
    message?: string;
    line?: number;
    snippet?: string;
    fixSuggestion?: string;
    reasoning?: Record<string, unknown>;
  }[];
}

interface CreateRuleData {
  name: string;
  description: string;
  pattern?: string;
  languages?: string[];
  category?: string;
  severity?: string;
  note?: string;
  sourceReason?: string;
  type?: string;
  astQuery?: { queryType: string };
  fixSuggestion?: string;
}

interface ActionContext {
  userId: string;
}

/**
 * GuardService
 * 管理 Guard 约束规则的生命周期 (V3: 使用 KnowledgeEntry / knowledgeRepository)
 * Guard 规则 = kind='rule' + knowledgeType='boundary-constraint' 的 KnowledgeEntry,
 * 具体 pattern 存在 constraints.guards[] 里
 */
export class GuardService {
  _engine: GuardCheckEngineLike | null;
  auditLogger: AuditLoggerLike;
  gateway: unknown;
  knowledgeRepository: KnowledgeRepositoryLike;
  logger: ReturnType<typeof Logger.getInstance>;
  /**
   * @param [deps] 可选依赖注入
   * @param [deps.guardCheckEngine] 核心引擎实例
   */
  constructor(
    knowledgeRepository: KnowledgeRepositoryLike,
    auditLogger: AuditLoggerLike,
    gateway: unknown,
    deps: { guardCheckEngine?: GuardCheckEngineLike } = {}
  ) {
    this.knowledgeRepository = knowledgeRepository;
    this.auditLogger = auditLogger;
    this.gateway = gateway;
    this.logger = Logger.getInstance();
    this._engine = deps.guardCheckEngine || null;
  }

  /** 创建新规则 → 创建一个 kind=rule, knowledgeType=boundary-constraint 的 KnowledgeEntry */
  async createRule(data: CreateRuleData, context: ActionContext) {
    try {
      this._validateCreateInput(data);

      const { KnowledgeEntry } = await import('../../domain/knowledge/KnowledgeEntry.js');
      const entry = KnowledgeEntry.fromJSON({
        id: uuidv4(),
        title: data.name,
        description: data.description,
        language: (data.languages || [])[0] || '',
        category: data.category || 'guard',
        kind: 'rule',
        knowledgeType: 'boundary-constraint',
        content: {
          pattern: data.pattern || '',
          rationale: data.note || data.sourceReason || '',
        },
        constraints: {
          boundaries: [],
          preconditions: [],
          sideEffects: [],
          guards: [
            {
              ...(data.pattern ? { pattern: data.pattern } : {}),
              severity: data.severity || 'warning',
              message: data.description || '',
              type: data.type || 'regex',
              ...(data.astQuery ? { astQuery: data.astQuery } : {}),
              ...(data.fixSuggestion ? { fixSuggestion: data.fixSuggestion } : {}),
            },
          ],
        },
        tags: data.languages || [],
        lifecycle: 'active',
        createdBy: context.userId,
      });

      const created = await this.knowledgeRepository.create(entry);

      await this.auditLogger.log({
        action: 'create_guard_rule',
        resourceType: 'knowledge_entry',
        resourceId: created.id,
        actor: context.userId,
        details: `Created guard rule: ${data.name}`,
        timestamp: unixNow(),
      });

      return created;
    } catch (error: unknown) {
      this.logger.error('Error creating guard rule', { error: (error as Error).message, data });
      throw error;
    }
  }

  /** 启用规则（将 lifecycle 设为 active） */
  async enableRule(ruleId: string, context: ActionContext) {
    try {
      const entry = await this.knowledgeRepository.findById(ruleId);
      if (!entry) {
        throw new NotFoundError('Guard rule not found', 'knowledge_entry', ruleId);
      }
      if (entry.lifecycle === 'active') {
        throw new ConflictError('Rule is already enabled', {
          reason: 'Cannot enable an already enabled rule',
        });
      }

      await this.knowledgeRepository.update(ruleId, { lifecycle: 'active' });

      await this.auditLogger.log({
        action: 'enable_guard_rule',
        resourceType: 'knowledge_entry',
        resourceId: ruleId,
        actor: context.userId,
        details: `Enabled guard rule: ${entry.title}`,
        timestamp: unixNow(),
      });

      return this.knowledgeRepository.findById(ruleId);
    } catch (error: unknown) {
      this.logger.error('Error enabling guard rule', { ruleId, error: (error as Error).message });
      throw error;
    }
  }

  /** 禁用规则（将 lifecycle 设为 deprecated） */
  async disableRule(ruleId: string, reason: string, context: ActionContext) {
    try {
      const entry = await this.knowledgeRepository.findById(ruleId);
      if (!entry) {
        throw new NotFoundError('Guard rule not found', 'knowledge_entry', ruleId);
      }
      if (entry.lifecycle === 'deprecated') {
        throw new ConflictError('Rule is already disabled', {
          reason: 'Cannot disable an already disabled rule',
        });
      }

      if (!reason || reason.trim().length === 0) {
        throw new ValidationError('Disable reason is required');
      }

      await this.knowledgeRepository.update(ruleId, {
        lifecycle: 'deprecated',
        rejectionReason: reason,
      });

      await this.auditLogger.log({
        action: 'disable_guard_rule',
        resourceType: 'knowledge_entry',
        resourceId: ruleId,
        actor: context.userId,
        details: `Disabled guard rule: ${reason}`,
        timestamp: unixNow(),
      });

      return this.knowledgeRepository.findById(ruleId);
    } catch (error: unknown) {
      this.logger.error('Error disabling guard rule', { ruleId, error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 检查代码是否匹配 Guard 规则
   * 优先代理到 GuardCheckEngine（完整管线: 内置 + DB + EP + Code-Level + AST），
   * 若引擎不可用则降级为仅 DB 规则的简化检查
   */
  async checkCode(code: string, options: { language?: string | null } = {}) {
    try {
      if (!code || code.trim().length === 0) {
        throw new ValidationError('Code is required');
      }

      const { language = null } = options;

      // ── 优先路径: 代理到 GuardCheckEngine（完整管线）──
      if (this._engine) {
        try {
          const violations = this._engine.checkCode(code, language || 'unknown', {
            scope: 'file',
          });
          return violations.map((v) => ({
            ruleId: v.ruleId,
            ruleName: v.ruleId,
            severity: v.severity || 'warning',
            message: v.message || '',
            line: v.line,
            snippet: v.snippet,
            matchCount: 1,
            ...(v.fixSuggestion ? { fixSuggestion: v.fixSuggestion } : {}),
            ...(v.reasoning ? { reasoning: v.reasoning } : {}),
          }));
        } catch (engineErr: unknown) {
          this.logger.debug('GuardCheckEngine.checkCode failed, falling back to DB-only check', {
            error: (engineErr as Error).message,
          });
        }
      }

      // ── 降级路径: 仅 DB 规则简化检查 ──
      return this._checkCodeDbOnly(code, { language });
    } catch (error: unknown) {
      this.logger.error('Error checking code against rules', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 仅 DB 规则的简化检查（降级路径）
   */
  private async _checkCodeDbOnly(code: string, options: { language?: string | null } = {}) {
    const { language = null } = options;

    // V3: 使用 findActiveRules() 查询 kind='rule' + lifecycle='active'
    let guardEntries = await this.knowledgeRepository.findActiveRules();

    // 按语言过滤
    if (language) {
      guardEntries = guardEntries.filter((e) => !e.language || e.language === language);
    }

    const matches: {
      ruleId: string;
      ruleName: string;
      severity: string;
      message: string;
      matches: { match: string; index: number | undefined; line: number }[];
      matchCount: number;
    }[] = [];
    for (const entry of guardEntries) {
      const guards = entry.constraints?.guards || [];
      for (const guard of guards) {
        try {
          const regex = new RegExp(guard.pattern, 'gm');
          const codeMatches = [...code.matchAll(regex)];
          if (codeMatches.length > 0) {
            matches.push({
              ruleId: entry.id,
              ruleName: entry.title,
              severity: guard.severity || 'warning',
              message: guard.message || '',
              matches: codeMatches.map((m) => ({
                match: m[0],
                index: m.index,
                line: code.substring(0, m.index).split('\\n').length,
              })),
              matchCount: codeMatches.length,
            });
          }
        } catch (e: unknown) {
          this.logger.warn('Error matching guard pattern', {
            entryId: entry.id,
            error: (e as Error).message,
          });
        }
      }
    }

    return matches;
  }

  /** 查询规则列表 (kind='rule' + knowledgeType='boundary-constraint') */
  async listRules(
    filters: Record<string, unknown> = {},
    pagination: { page?: number; pageSize?: number } = {}
  ) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.knowledgeRepository.findWithPagination(
        { kind: 'rule', knowledgeType: 'boundary-constraint' },
        { page, pageSize }
      );
    } catch (error: unknown) {
      this.logger.error('Error listing rules', { error: (error as Error).message, filters });
      throw error;
    }
  }

  /** 搜索规则 */
  async searchRules(keyword: string, pagination: { page?: number; pageSize?: number } = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      const result = await this.knowledgeRepository.search(keyword, { page, pageSize });
      result.data = (result.data || []).filter(
        (r) => r.kind === 'rule' && r.knowledgeType === 'boundary-constraint'
      );
      result.total = result.data.length;
      return result;
    } catch (error: unknown) {
      this.logger.error('Error searching rules', { keyword, error: (error as Error).message });
      throw error;
    }
  }

  /** 获取规则统计 */
  async getRuleStats() {
    try {
      return this.knowledgeRepository.getStats();
    } catch (error: unknown) {
      this.logger.error('Error getting rule stats', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * 验证创建输入
   * type='regex' 时 pattern 必须提供；type='ast' 时 astQuery 必须提供
   */
  _validateCreateInput(data: CreateRuleData) {
    if (!data.name || data.name.trim().length === 0) {
      throw new ValidationError('Rule name is required');
    }
    if (!data.description || data.description.trim().length === 0) {
      throw new ValidationError('Rule description is required');
    }

    const ruleType = data.type || 'regex';
    if (ruleType === 'ast') {
      if (!data.astQuery || !data.astQuery.queryType) {
        throw new ValidationError('AST query with queryType is required for type=ast rules');
      }
    } else {
      if (!data.pattern || data.pattern.trim().length === 0) {
        throw new ValidationError('Pattern is required for regex rules');
      }
    }
  }
}

export default GuardService;
