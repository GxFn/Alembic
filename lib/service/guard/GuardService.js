import Logger from '../../infrastructure/logging/Logger.js';
import { ValidationError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { unixNow } from '../../shared/utils/common.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * GuardService
 * 管理 Guard 约束规则的生命周期 (V3: 使用 KnowledgeEntry / knowledgeRepository)
 * Guard 规则 = kind='rule' + knowledgeType='boundary-constraint' 的 KnowledgeEntry,
 * 具体 pattern 存在 constraints.guards[] 里
 */
export class GuardService {
  /**
   * @param {import('../../domain/knowledge/KnowledgeRepository.js').KnowledgeRepository} knowledgeRepository
   */
  constructor(knowledgeRepository, auditLogger, gateway) {
    this.knowledgeRepository = knowledgeRepository;
    this.auditLogger = auditLogger;
    this.gateway = gateway;
    this.logger = Logger.getInstance();
  }

  /**
   * 创建新规则 → 创建一个 kind=rule, knowledgeType=boundary-constraint 的 KnowledgeEntry
   */
  async createRule(data, context) {
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
          guards: [{
            ...(data.pattern ? { pattern: data.pattern } : {}),
            severity: data.severity || 'warning',
            message: data.description || '',
            type: data.type || 'regex',
            ...(data.astQuery ? { astQuery: data.astQuery } : {}),
            ...(data.fixSuggestion ? { fixSuggestion: data.fixSuggestion } : {}),
          }],
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
    } catch (error) {
      this.logger.error('Error creating guard rule', { error: error.message, data });
      throw error;
    }
  }

  /**
   * 启用规则（将 lifecycle 设为 active）
   */
  async enableRule(ruleId, context) {
    try {
      const entry = await this.knowledgeRepository.findById(ruleId);
      if (!entry) throw new NotFoundError('Guard rule not found', 'knowledge_entry', ruleId);
      if (entry.lifecycle === 'active') {
        throw new ConflictError('Rule is already enabled', 'Cannot enable an already enabled rule');
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
    } catch (error) {
      this.logger.error('Error enabling guard rule', { ruleId, error: error.message });
      throw error;
    }
  }

  /**
   * 禁用规则（将 lifecycle 设为 deprecated）
   */
  async disableRule(ruleId, reason, context) {
    try {
      const entry = await this.knowledgeRepository.findById(ruleId);
      if (!entry) throw new NotFoundError('Guard rule not found', 'knowledge_entry', ruleId);
      if (entry.lifecycle === 'deprecated') {
        throw new ConflictError('Rule is already disabled', 'Cannot disable an already disabled rule');
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
    } catch (error) {
      this.logger.error('Error disabling guard rule', { ruleId, error: error.message });
      throw error;
    }
  }

  /**
   * 检查代码是否匹配 Guard 规则
   * 查询所有 active 的 rule 实体的 constraints.guards[]
   */
  async checkCode(code, options = {}) {
    try {
      if (!code || code.trim().length === 0) {
        throw new ValidationError('Code is required');
      }

      const { language = null } = options;

      // V3: 使用 findActiveRules() 查询 kind='rule' + lifecycle='active'
      let guardEntries = await this.knowledgeRepository.findActiveRules();

      // 按语言过滤
      if (language) {
        guardEntries = guardEntries.filter(
          e => !e.language || e.language === language
        );
      }

      const matches = [];
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
                matches: codeMatches.map(m => ({
                  match: m[0],
                  index: m.index,
                  line: code.substring(0, m.index).split('\\n').length,
                })),
                matchCount: codeMatches.length,
              });
            }
          } catch (e) {
            this.logger.warn('Error matching guard pattern', { entryId: entry.id, error: e.message });
          }
        }
      }

      return matches;
    } catch (error) {
      this.logger.error('Error checking code against rules', { error: error.message });
      throw error;
    }
  }

  /**
   * 查询规则列表 (kind='rule' + knowledgeType='boundary-constraint')
   */
  async listRules(filters = {}, pagination = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      return this.knowledgeRepository.findWithPagination(
        { kind: 'rule', knowledgeType: 'boundary-constraint' },
        { page, pageSize }
      );
    } catch (error) {
      this.logger.error('Error listing rules', { error: error.message, filters });
      throw error;
    }
  }

  /**
   * 搜索规则
   */
  async searchRules(keyword, pagination = {}) {
    try {
      const { page = 1, pageSize = 20 } = pagination;
      const result = await this.knowledgeRepository.search(keyword, { page, pageSize });
      result.data = (result.data || []).filter(
        r => r.kind === 'rule' && r.knowledgeType === 'boundary-constraint'
      );
      result.total = result.data.length;
      return result;
    } catch (error) {
      this.logger.error('Error searching rules', { keyword, error: error.message });
      throw error;
    }
  }

  /**
   * 获取规则统计
   */
  async getRuleStats() {
    try {
      return this.knowledgeRepository.getStats();
    } catch (error) {
      this.logger.error('Error getting rule stats', { error: error.message });
      throw error;
    }
  }

  /**
   * 验证创建输入
   * type='regex' 时 pattern 必须提供；type='ast' 时 astQuery 必须提供
   */
  _validateCreateInput(data) {
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
