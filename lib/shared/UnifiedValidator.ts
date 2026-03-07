/**
 * UnifiedValidator.js — 统一验证链
 *
 * 替代 CandidateGuardrail + RecipeReadinessChecker 的分裂验证，
 * 提供单一入口的三层验证 (字段完整性 + 内容质量 + 去重)。
 *
 * 分级模式:
 *   strict   — 默认：完整 REQUIRED 字段检查（标准知识条目）
 *   document — knowledgeType='dev-document' 时自动切换：跳过 Cursor 交付字段
 *   fallback — source 含 'fallback' 时：REQUIRED 降级为 WARNING
 *
 * @module shared/UnifiedValidator
 */

import {
  FieldLevel,
  STANDARD_CATEGORIES,
  V3_FIELD_SPEC,
  VALID_KINDS,
  WHITELISTED_CATEGORIES,
} from './FieldSpec.js';
import { LanguageService } from './LanguageService.js';

// ── Cursor 交付字段集合（document 模式跳过这些） ────────────

const CURSOR_DELIVERY_FIELDS = new Set([
  'trigger',
  'kind',
  'doClause',
  'dontClause',
  'whenClause',
  'coreCode',
  'topicHint',
]);

// ── 代码指纹工具函数 ───────────────────────────────────────

/**
 * 生成代码模式指纹 — 去除空白/注释后取前 200 字符的小写形式
 * @param {string} code
 * @returns {string}
 */
function codeFingerprint(code: string) {
  return (code || '')
    .replace(/\/\/[^\n]*/g, '') // 移除单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    .replace(/[\s]+/g, '') // 移除所有空白
    .toLowerCase()
    .slice(0, 200);
}

// ── 模式自动检测 ────────────────────────────────────────────

/**
 * 自动检测适合的验证模式
 * @param {object} candidate
 * @returns {'strict'|'document'|'fallback'}
 */
function detectMode(candidate: Record<string, unknown>) {
  if (candidate.knowledgeType === 'dev-document') {
    return 'document';
  }
  if (typeof candidate.source === 'string' && candidate.source.includes('fallback')) {
    return 'fallback';
  }
  return 'strict';
}

// ── UnifiedValidator ────────────────────────────────────────

export class UnifiedValidator {
  /** @type {Set<string>} 已提交标题 (小写) */
  #titles;

  /** @type {Set<string>} 已提交代码指纹 */
  #codeFingerprints;

  /**
   * @param {object} [options]
   * @param {Set<string>} [options.existingTitles]       预填充已有标题
   * @param {Set<string>} [options.existingFingerprints]  预填充已有代码指纹
   */
  constructor(options: { existingTitles?: Set<string>; existingFingerprints?: Set<string> } = {}) {
    this.#titles = options.existingTitles || new Set();
    this.#codeFingerprints = options.existingFingerprints || new Set();
  }

  /**
   * 完整验证链 (3 层)
   *
   * @param {object} candidate 候选数据（扁平字段）
   * @param {object} [options]
   * @param {'strict'|'document'|'fallback'} [options.mode]          验证模式（自动检测或手动指定）
   * @param {string[]}                       [options.systemInjectedFields] 系统注入的字段（跳过 REQUIRED 检查）
   * @param {boolean}                        [options.skipUniqueness=false] 跳过去重检查
   * @returns {{ pass: boolean, errors: string[], warnings: string[] }}
   */
  validate(
    candidate: Record<string, unknown>,
    options: {
      mode?: 'strict' | 'document' | 'fallback';
      systemInjectedFields?: string[];
      skipUniqueness?: boolean;
    } = {}
  ) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const mode = options.mode || detectMode(candidate);
    const systemInjected = new Set(options.systemInjectedFields || []);

    // ── Layer 1: 字段完整性 (基于 V3_FIELD_SPEC) ──
    this.#checkFields(candidate, mode, systemInjected, errors, warnings);

    // ── Layer 2: 内容质量 (来自 CandidateGuardrail.validateQuality) ──
    if (mode !== 'fallback') {
      this.#checkContentQuality(candidate, mode, errors, warnings);
    }

    // ── Layer 3: 唯一性 (来自 CandidateGuardrail.validateUniqueness) ──
    if (!options.skipUniqueness) {
      this.#checkUniqueness(candidate, errors);
    }

    return {
      pass: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ── Layer 1: 基于 FieldSpec 检查 ─────────────────────────

  /**
   * @param {object} candidate
   * @param {'strict'|'document'|'fallback'} mode
   * @param {Set<string>} systemInjected
   * @param {string[]} errors
   * @param {string[]} warnings
   */
  #checkFields(
    candidate: Record<string, unknown>,
    mode: string,
    systemInjected: Set<string>,
    errors: string[],
    warnings: string[]
  ) {
    for (const field of V3_FIELD_SPEC) {
      const { name, level, rule } = field;

      // document 模式：跳过 Cursor 交付字段
      if (mode === 'document' && CURSOR_DELIVERY_FIELDS.has(name.split('.')[0])) {
        continue;
      }

      // 系统注入字段：跳过
      if (systemInjected.has(name)) {
        continue;
      }

      const value = this.#getNestedValue(candidate, name);
      const missing = this.#isMissing(value, field);

      if (!missing) {
        continue;
      }

      if (level === FieldLevel.REQUIRED) {
        if (mode === 'fallback') {
          // fallback 模式：REQUIRED 降级为 warning
          warnings.push(`${name}: ${rule}`);
        } else {
          errors.push(`缺少必填字段: ${name} — ${rule}`);
        }
      } else if (level === FieldLevel.EXPECTED) {
        warnings.push(`建议填写: ${name} — ${rule}`);
      }
      // OPTIONAL: 不报任何问题
    }

    // ── 额外的格式/值校验 ──

    // content 必须是对象
    if (candidate.content && typeof candidate.content !== 'object') {
      errors.push(
        '⚠️ content 必须是 JSON 对象（不是字符串！）。正确格式: { "markdown": "...", "rationale": "..." }'
      );
    }

    // reasoning 必须是对象
    if (candidate.reasoning && typeof candidate.reasoning !== 'object') {
      errors.push(
        '⚠️ reasoning 必须是 JSON 对象（不是字符串！）。正确格式: { "whyStandard": "...", "sources": [...], "confidence": 0.85 }'
      );
    }

    // kind 值校验
    if (candidate.kind && !VALID_KINDS.includes(candidate.kind as string)) {
      errors.push(`kind 值无效: "${candidate.kind}" — 取值 rule/pattern/fact`);
    }

    // trigger 格式校验
    if (candidate.trigger && !(candidate.trigger as string).startsWith('@')) {
      warnings.push(`trigger "${candidate.trigger}" 应以 @ 开头`);
    }

    // category 值校验
    if (
      candidate.category &&
      !STANDARD_CATEGORIES.includes(candidate.category as string) &&
      !WHITELISTED_CATEGORIES.includes(candidate.category as string)
    ) {
      warnings.push(
        `category "${candidate.category}" 非标准值，应为: ${STANDARD_CATEGORIES.join('/')}（bootstrap/knowledge 等特殊来源可忽略此建议）`
      );
    }

    // language 校验
    const lang = (candidate.language as string | undefined)?.toLowerCase();
    if (lang && !LanguageService.isKnownLang(lang) && lang !== 'objc' && lang !== 'markdown') {
      warnings.push(
        `language "${candidate.language}" — 请使用标准语言标识 (swift/typescript/python/java/kotlin 等)`
      );
    }
  }

  // ── Layer 2: 内容质量启发式 ──────────────────────────────

  /**
   * @param {object} candidate
   * @param {'strict'|'document'|'fallback'} mode
   * @param {string[]} errors
   * @param {string[]} warnings
   */
  #checkContentQuality(
    candidate: Record<string, unknown>,
    mode: string,
    errors: string[],
    warnings: string[]
  ) {
    const markdown =
      ((candidate.content as Record<string, unknown> | undefined)?.markdown as string) || '';

    // markdown ≥ 200 字符
    if (markdown && markdown.length > 0 && markdown.length < 200) {
      errors.push(
        `content.markdown 过短 (${markdown.length} 字符, 最少 200)。请包含代码片段和项目上下文描述。`
      );
    }

    // 代码块存在性
    if (
      markdown &&
      markdown.length >= 200 &&
      !/```[\s\S]*?```/.test(markdown) &&
      !/\.\w{1,10}(:\d+)?/.test(markdown)
    ) {
      errors.push('content.markdown 中必须包含至少一个代码块或文件引用');
    }

    // 来源引用（建议）
    if (markdown && markdown.length >= 200) {
      const hasSourceRef =
        /来源[:：]|[Ss]ource[:：]|\(\w+\.\w+:\d+\)/.test(markdown) ||
        /[A-Z]\w+\.(?:m|h|swift|java|kt|js|ts|go|py|rs|rb|cs|cpp|c)/.test(markdown);
      if (!hasSourceRef) {
        warnings.push('建议在内容中标注代码来源 (来源: FileName.ext:行号)');
      }
    }

    // coreCode 语法完整性
    if (mode !== 'document') {
      const coreCode = ((candidate.coreCode as string) || '').trim();
      if (coreCode) {
        const firstChar = coreCode[0];
        if (firstChar === '}' || firstChar === ')' || firstChar === ']') {
          errors.push(
            `coreCode 以 "${firstChar}" 开头 — 代码片段不完整，请包含完整的函数/方法/表达式`
          );
        }
      }
    }

    // 通用知识检测
    const genericPatterns = [/^(Singleton|Factory|Observer|MVC|MVVM) (pattern|模式)$/i];
    const title = (candidate.title as string) || '';
    if (genericPatterns.some((p) => p.test(title.trim()))) {
      errors.push(`标题过于通用: "${title}" — 请加上项目特定的上下文`);
    }

    // 内容过于简单
    if (markdown && markdown.length > 0 && markdown.length >= 200) {
      const lines = markdown.split('\n').filter((l: string) => l.trim().length > 0);
      if (lines.length <= 2 && !/```[\s\S]*?```/.test(markdown)) {
        warnings.push(`内容仅 ${lines.length} 行 — 建议包含更多代码片段和设计意图描述`);
      }
    }
  }

  // ── Layer 3: 去重 ────────────────────────────────────────

  /**
   * @param {object} candidate
   * @param {string[]} errors
   */
  #checkUniqueness(candidate: Record<string, unknown>, errors: string[]) {
    const title = ((candidate.title as string) || '').toLowerCase().trim();
    if (title && this.#titles.has(title)) {
      errors.push(`标题重复: "${candidate.title}"`);
    }

    const pattern = (
      ((candidate.content as Record<string, unknown> | undefined)?.pattern as string) || ''
    ).trim();
    if (pattern.length >= 30) {
      const fp = codeFingerprint(pattern);
      if (fp.length >= 20 && this.#codeFingerprints.has(fp)) {
        errors.push('代码模式重复 — 已存在相同核心代码的候选。请提交不同的代码片段。');
      }
    }
  }

  // ── 提交记录 ─────────────────────────────────────────────

  /**
   * 记录已提交的标题和代码指纹（提交成功后调用）
   * @param {string} title
   * @param {string} [pattern] 代码模式
   */
  recordSubmission(title: string, pattern: string) {
    if (title) {
      this.#titles.add(title.toLowerCase().trim());
    }
    if (pattern && pattern.length >= 30) {
      const fp = codeFingerprint(pattern);
      if (fp.length >= 20) {
        this.#codeFingerprints.add(fp);
      }
    }
  }

  // ── 工具函数 ─────────────────────────────────────────────

  /**
   * 获取嵌套字段值
   * @param {object} obj
   * @param {string} path 如 'content.markdown' 或 'reasoning.sources'
   * @returns {*}
   */
  #getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * 检查值是否为"缺失"
   * @param {*} value
   * @param {FieldDef} field
   * @returns {boolean}
   */
  #isMissing(value: unknown, field: { name: string; type?: string }) {
    if (value === undefined || value === null) {
      return true;
    }

    if (field.type === 'string') {
      return typeof value !== 'string' || !value.trim();
    }
    if (field.type === 'array') {
      if (!Array.isArray(value)) {
        return true;
      }
      // reasoning.sources 必须非空
      if (field.name === 'reasoning.sources') {
        return value.length === 0;
      }
      // headers 允许空数组
      if (field.name === 'headers') {
        return false;
      }
      return false;
    }
    if (field.type === 'object') {
      return typeof value !== 'object';
    }

    return !value;
  }
}

// ── 便捷工厂函数 ────────────────────────────────────────────

/**
 * 创建一个无状态验证器实例（不含去重缓存），适用于一次性校验
 * @returns {UnifiedValidator}
 */
export function createStatelessValidator() {
  return new UnifiedValidator();
}

export default UnifiedValidator;
