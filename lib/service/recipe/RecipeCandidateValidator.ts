/**
 * RecipeCandidateValidator — Recipe 候选校验器 (V3)
 *
 * 验证候选是否满足 V3 结构化字段要求。
 * 核心变更：用 content 对象替代旧版 code 字符串。
 */

import { getRequiredFieldNames } from '../../shared/FieldSpec.js';
import { LanguageService } from '../../shared/LanguageService.js';

/* ── V3 必填字段（从 FieldSpec 获取顶层字段，排除嵌套和容器字段） ── */
const REQUIRED_FIELDS = getRequiredFieldNames().filter(
  (f) => !['content', 'headers', 'reasoning', 'knowledgeType', 'usageGuide'].includes(f)
);

/* ── 需要 content 子对象有内容 ── */
// NOTE: reserved for future content sub-field validation
// const REQUIRED_CONTENT_FIELDS = ['pattern', 'markdown', 'rationale'];

const VALID_CATEGORIES = new Set([
  'view',
  'service',
  'tool',
  'model',
  'network',
  'storage',
  'ui',
  'utility',
]);

const VALID_KINDS = new Set(['rule', 'pattern', 'fact']);

export class RecipeCandidateValidator {
  /**
   * 验证单个候选（V3 结构）
   * @param {object} candidate
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate(candidate) {
    const errors: any[] = [];
    const warnings: any[] = [];

    if (!candidate || typeof candidate !== 'object') {
      return { valid: false, errors: ['候选为空或类型错误'], warnings: [] };
    }

    // ── V3 必填字段 ──
    for (const field of REQUIRED_FIELDS) {
      const val = candidate[field];
      if (!val || (typeof val === 'string' && !val.trim())) {
        errors.push(`缺少必填字段: ${field}`);
      }
    }

    // ── content 对象必须包含有效内容 ──
    const content = candidate.content;
    if (!content || typeof content !== 'object') {
      errors.push('缺少必填字段: content（需为 { pattern, markdown, rationale } 对象）');
    } else {
      const hasPattern = !!(content.pattern && String(content.pattern).trim());
      const hasMarkdown = !!(content.markdown && String(content.markdown).trim());
      if (!hasPattern && !hasMarkdown) {
        errors.push('content.pattern 或 content.markdown 至少需要一个非空');
      }
      if (!content.rationale || !String(content.rationale).trim()) {
        errors.push('缺少必填字段: content.rationale（设计原理）');
      }
    }

    // ── trigger 格式 ──
    if (candidate.trigger && typeof candidate.trigger === 'string') {
      if (candidate.trigger.length < 2) {
        errors.push('trigger 过短');
      }
      if (candidate.trigger.length > 64) {
        errors.push('trigger 过长 (>64)');
      }
      if (!candidate.trigger.startsWith('@')) {
        warnings.push('trigger 应以 @ 开头');
      }
      if (!/^@?[a-zA-Z0-9_\-:.]+$/.test(candidate.trigger)) {
        warnings.push('trigger 含特殊字符，建议仅使用字母/数字/下划线/连字符');
      }
    }

    // ── kind 合法性 ──
    if (candidate.kind && !VALID_KINDS.has(candidate.kind)) {
      errors.push(`kind "${candidate.kind}" 无效 — 必须为 rule/pattern/fact`);
    }

    // ── category 合法性 ──
    if (candidate.category && !VALID_CATEGORIES.has(candidate.category.toLowerCase())) {
      warnings.push(
        `category "${candidate.category}" 不在标准列表（View/Service/Tool/Model/Network/Storage/UI/Utility）`
      );
    }

    // ── language 合法性 ──
    if (candidate.language) {
      const lang = candidate.language.toLowerCase();
      if (!LanguageService.isKnownLang(lang) && lang !== 'objc' && lang !== 'markdown') {
        warnings.push(`language "${candidate.language}" 不在已知语言列表`);
      }
    }

    // ── headers 必填 ──
    if (!Array.isArray(candidate.headers)) {
      errors.push('缺少必填字段: headers（需为 import 语句数组，无 import 时传 []）');
    }

    // ── knowledgeType 必填 ──
    if (!candidate.knowledgeType || !String(candidate.knowledgeType).trim()) {
      errors.push('缺少必填字段: knowledgeType');
    }

    // ── usageGuide 必填 ──
    if (!candidate.usageGuide || !String(candidate.usageGuide).trim()) {
      errors.push('缺少必填字段: usageGuide（使用指南，### 章节格式）');
    }

    // ── 推理依据 (reasoning) 必填 ──
    if (!candidate.reasoning) {
      errors.push('缺少必填字段: reasoning（需包含 whyStandard + sources + confidence）');
    } else {
      if (!candidate.reasoning.whyStandard?.trim()) {
        errors.push('reasoning.whyStandard 不能为空');
      }
      if (!Array.isArray(candidate.reasoning.sources) || candidate.reasoning.sources.length === 0) {
        errors.push('reasoning.sources 至少包含一项来源');
      }
      if (
        typeof candidate.reasoning.confidence !== 'number' ||
        candidate.reasoning.confidence < 0 ||
        candidate.reasoning.confidence > 1
      ) {
        warnings.push('reasoning.confidence 应为 0-1 的数字');
      }
    }

    // ── 标签 ──
    if (candidate.tags && !Array.isArray(candidate.tags)) {
      warnings.push('tags 应为数组');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 批量验证
   * @param {object[]} candidates
   * @returns {{ valid: object[], invalid: object[], summary: { total: number, validCount: number, invalidCount: number } }}
   */
  validateBatch(candidates) {
    const valid: any[] = [];
    const invalid: any[] = [];

    for (const candidate of candidates) {
      const result = this.validate(candidate);
      if (result.valid) {
        valid.push({ candidate, ...result });
      } else {
        invalid.push({ candidate, ...result });
      }
    }

    return {
      valid,
      invalid,
      summary: {
        total: candidates.length,
        validCount: valid.length,
        invalidCount: invalid.length,
      },
    };
  }

  /**
   * 获取有效类别列表
   */
  getValidCategories() {
    return [...VALID_CATEGORIES];
  }

  /**
   * 获取有效 kind 列表
   */
  getValidKinds() {
    return [...VALID_KINDS];
  }

  /**
   * 获取所有必填字段名列表
   */
  getRequiredFields() {
    return [
      ...REQUIRED_FIELDS,
      'content',
      'content.rationale',
      'headers',
      'knowledgeType',
      'usageGuide',
      'reasoning',
      'reasoning.whyStandard',
      'reasoning.sources',
    ];
  }
}
