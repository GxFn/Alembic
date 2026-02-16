/**
 * CandidateGuardrail.js — Producer 产出的候选验证链
 *
 * 三层验证:
 * 1. 结构验证 — 必填字段、内容长度、knowledgeType 约束
 * 2. 去重验证 — 标题不重复
 * 3. 质量启发式 — 包含代码引用、项目特定内容
 *
 * @module CandidateGuardrail
 */

export class CandidateGuardrail {
  /** @type {Set<string>} 已提交标题 (小写) */
  #globalTitles;

  /** @type {object} 维度配置 */
  #dimensionConfig;

  /**
   * @param {Set<string>} globalTitles — 全局已提交标题集合 (小写)
   * @param {object} dimensionConfig — { allowedKnowledgeTypes, id, outputType }
   */
  constructor(globalTitles, dimensionConfig) {
    this.#globalTitles = globalTitles;
    this.#dimensionConfig = dimensionConfig;
  }

  /**
   * 验证候选结构
   * @param {object} candidate — submit_knowledge 工具参数
   * @returns {{ valid: boolean, error?: string }}
   */
  validateStructure(candidate) {
    // 必填字段检查
    const required = ['title', 'code'];
    for (const field of required) {
      if (!candidate[field] || String(candidate[field]).trim().length === 0) {
        return { valid: false, error: `缺少必填字段: ${field}` };
      }
    }

    // 内容长度检查 — 「项目特写」需要足够的代码和描述
    const content = candidate.code || '';
    if (content.length < 200) {
      return { valid: false, error: `内容过短 (${content.length} 字符, 最少 200)。请包含代码片段和项目上下文描述，而非一句话概括。` };
    }

    // knowledgeType 约束 — 自动修正为允许列表中第一个类型
    const allowed = this.#dimensionConfig.allowedKnowledgeTypes;
    if (allowed?.length > 0 && candidate.knowledgeType) {
      if (!allowed.includes(candidate.knowledgeType)) {
        candidate.knowledgeType = allowed[0];
      }
    }

    return { valid: true };
  }

  /**
   * 验证去重
   * @param {object} candidate
   * @returns {{ valid: boolean, error?: string }}
   */
  validateUniqueness(candidate) {
    const normalizedTitle = (candidate.title || '').toLowerCase().trim();
    if (this.#globalTitles.has(normalizedTitle)) {
      return { valid: false, error: `标题重复: "${candidate.title}"` };
    }
    return { valid: true };
  }

  /**
   * 质量启发式检查
   * @param {object} candidate
   * @returns {{ valid: boolean, error?: string, warning?: string }}
   */
  validateQuality(candidate) {
    const content = candidate.code || '';

    // 检查是否包含代码引用或文件路径
    const hasCodeBlock = /```[\s\S]*?```/.test(content) || /\.(m|h|swift|js|ts)(:\d+)?/.test(content);
    const hasSourceRef = /来源[:：]|[Ss]ource[:：]|\(\w+\.\w+:\d+\)/.test(content) || /[A-Z]\w+\.(m|h|swift|java|kt|js|ts)/.test(content);

    if (!hasCodeBlock && !hasSourceRef) {
      return { valid: false, error: '内容缺少代码片段或文件引用 — 请用 read_project_file 获取代码后再提交，「项目特写」必须包含真实代码' };
    }

    // 检查是否是 Skill 摘要式内容（一行式描述、无代码、无结构）
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    if (lines.length <= 2 && !hasCodeBlock) {
      return { valid: false, error: `内容过于简单 (仅 ${lines.length} 行) — 请包含代码片段、设计意图和项目上下文，不要只写一句话概括` };
    }

    // 检查是否是通用知识而非项目特定
    const genericPatterns = [
      /^(Singleton|Factory|Observer|MVC|MVVM) (pattern|模式)$/i,
    ];
    const title = candidate.title || '';
    if (genericPatterns.some(p => p.test(title.trim()))) {
      return { valid: false, error: `标题过于通用: "${title}" — 请加上项目特定的上下文` };
    }

    return { valid: true };
  }

  /**
   * 完整验证链
   * @param {object} candidate
   * @returns {{ valid: boolean, error?: string, warning?: string }}
   */
  validate(candidate) {
    const structureResult = this.validateStructure(candidate);
    if (!structureResult.valid) return structureResult;

    const uniqueResult = this.validateUniqueness(candidate);
    if (!uniqueResult.valid) return uniqueResult;

    const qualityResult = this.validateQuality(candidate);
    // 质量问题返回 warning 但不阻止提交
    if (!qualityResult.valid) return qualityResult;

    return { valid: true, warning: qualityResult.warning };
  }

  /**
   * 记录已提交标题（提交成功后调用）
   * @param {string} title
   */
  recordTitle(title) {
    this.#globalTitles.add((title || '').toLowerCase().trim());
  }
}

export default CandidateGuardrail;
