/**
 * CandidateGuardrail.js — Producer 产出的候选验证链
 *
 * 三层验证:
 * 1. 结构验证 — 必填字段、内容长度、交付字段非空
 * 2. 去重验证 — 标题不重复 + 代码模式不重复
 * 3. 质量启发式 — 包含代码引用、项目特定内容
 *
 * @module CandidateGuardrail
 */

/**
 * 生成代码模式指纹 — 去除空白/注释后取前 200 字符的小写形式
 * @param {string} code
 * @returns {string}
 */
function codeFingerprint(code) {
  return (code || '')
    .replace(/\/\/[^\n]*/g, '')       // 移除单行注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    .replace(/[\s]+/g, '')             // 移除所有空白
    .toLowerCase()
    .slice(0, 200);
}

export class CandidateGuardrail {
  /** @type {Set<string>} 已提交标题 (小写) */
  #globalTitles;

  /** @type {Set<string>} 已提交代码模式指纹 */
  #globalPatternFingerprints;

  /** @type {object} 维度配置 */
  #dimensionConfig;

  /**
   * @param {Set<string>} globalTitles — 全局已提交标题集合 (小写)
   * @param {object} dimensionConfig — { allowedKnowledgeTypes, id, outputType }
   * @param {Set<string>} [globalPatternFingerprints] — 全局已提交代码指纹集合
   */
  constructor(globalTitles, dimensionConfig, globalPatternFingerprints) {
    this.#globalTitles = globalTitles;
    this.#dimensionConfig = dimensionConfig;
    this.#globalPatternFingerprints = globalPatternFingerprints || new Set();
  }

  /**
   * 验证候选结构
   * @param {object} candidate — submit_knowledge 工具参数
   * @returns {{ valid: boolean, error?: string }}
   */
  validateStructure(candidate) {
    // 必填字段检查
    if (!candidate.title || String(candidate.title).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: title' };
    }
    const markdown = candidate.content?.markdown || '';
    if (!markdown || String(markdown).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: content.markdown' };
    }

    // ── 自动修复: pattern 为空时从 markdown 提取代码块 ──
    if (candidate.kind === 'pattern' && candidate.content) {
      const pattern = (candidate.content.pattern || '').trim();
      if (!pattern) {
        const extracted = CandidateGuardrail.#extractCodeFromMarkdown(markdown);
        if (extracted) {
          candidate.content.pattern = extracted;
        }
      }
    }

    // 内容长度检查 — 「项目特写」需要足够的代码和描述
    if (markdown.length < 200) {
      return {
        valid: false,
        error: `内容过短 (${markdown.length} 字符, 最少 200)。请包含代码片段和项目上下文描述，而非一句话概括。`,
      };
    }

    // content.rationale 必填
    if (!candidate.content?.rationale || String(candidate.content.rationale).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: content.rationale — 需要设计原理说明' };
    }

    // Cursor 交付字段必填检查
    if (!candidate.trigger || String(candidate.trigger).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: trigger — 需要 @kebab-case 唯一标识符' };
    }
    if (!candidate.kind || !['rule', 'pattern', 'fact'].includes(candidate.kind)) {
      return { valid: false, error: '缺少或无效字段: kind — 取值 rule/pattern/fact' };
    }
    if (!candidate.doClause || String(candidate.doClause).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: doClause — 需要英文祈使句正向指令' };
    }

    // description 必填
    if (!candidate.description || String(candidate.description).trim().length === 0) {
      return { valid: false, error: '缺少必填字段: description — 需要中文简述 ≤80 字' };
    }

    // headers 必填（数组，空项目也需传 []）
    if (!Array.isArray(candidate.headers)) {
      return { valid: false, error: '缺少必填字段: headers — 需为 import 语句数组，无 import 时传 []' };
    }

    // knowledgeType 约束 — 自动修正为允许列表中第一个类型
    const allowed = this.#dimensionConfig.allowedKnowledgeTypes;
    if (allowed?.length > 0 && candidate.knowledgeType) {
      if (!allowed.includes(candidate.knowledgeType)) {
        candidate.knowledgeType = allowed[0];
      }
    }

    // reasoning 必填
    if (!candidate.reasoning || typeof candidate.reasoning !== 'object') {
      return { valid: false, error: '缺少必填字段: reasoning — 需包含 whyStandard + sources + confidence' };
    }
    if (!candidate.reasoning.whyStandard?.trim()) {
      return { valid: false, error: '缺少必填字段: reasoning.whyStandard' };
    }
    if (!Array.isArray(candidate.reasoning.sources) || candidate.reasoning.sources.length === 0) {
      return { valid: false, error: '缺少必填字段: reasoning.sources — 至少包含一项来源' };
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

    // 代码模式指纹去重 — 相同核心代码不同维度只保留首次
    const pattern = (candidate.content?.pattern || '').trim();
    if (pattern.length >= 30) {
      const fp = codeFingerprint(pattern);
      if (fp.length >= 20 && this.#globalPatternFingerprints.has(fp)) {
        return {
          valid: false,
          error: `代码模式重复 — 已存在相同核心代码的候选。请提交不同的代码片段，或换一个角度分析。`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * 质量启发式检查
   * @param {object} candidate
   * @returns {{ valid: boolean, error?: string, warning?: string }}
   */
  validateQuality(candidate) {
    const content = candidate.content?.markdown || '';

    // 检查 content.pattern 是否语法完整（不以闭合括号开头）
    const pattern = (candidate.content?.pattern || '').trim();
    if (pattern) {
      const firstChar = pattern[0];
      if (firstChar === '}' || firstChar === ')' || firstChar === ']') {
        return {
          valid: false,
          error: `content.pattern 以 "${firstChar}" 开头，代码片段不完整 — 请包含完整的函数/方法/表达式，确保括号配对`,
        };
      }
    }

    // 检查是否包含代码引用或文件路径
    const hasCodeBlock =
      /```[\s\S]*?```/.test(content) || /\.\w{1,10}(:\d+)?/.test(content);
    const hasSourceRef =
      /来源[:：]|[Ss]ource[:：]|\(\w+\.\w+:\d+\)/.test(content) ||
      /[A-Z]\w+\.(?:m|h|swift|java|kt|js|ts|go|py|rs|rb|cs|cpp|c)/.test(content);

    if (!hasCodeBlock && !hasSourceRef) {
      return {
        valid: false,
        error:
          '内容缺少代码片段或文件引用 — 请用 read_project_file 获取代码后再提交，「项目特写」必须包含真实代码',
      };
    }

    // 检查是否是 Skill 摘要式内容（一行式描述、无代码、无结构）
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= 2 && !hasCodeBlock) {
      return {
        valid: false,
        error: `内容过于简单 (仅 ${lines.length} 行) — 请包含代码片段、设计意图和项目上下文，不要只写一句话概括`,
      };
    }

    // 检查是否是通用知识而非项目特定
    const genericPatterns = [/^(Singleton|Factory|Observer|MVC|MVVM) (pattern|模式)$/i];
    const title = candidate.title || '';
    if (genericPatterns.some((p) => p.test(title.trim()))) {
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
    if (!structureResult.valid) {
      return structureResult;
    }

    const uniqueResult = this.validateUniqueness(candidate);
    if (!uniqueResult.valid) {
      return uniqueResult;
    }

    const qualityResult = this.validateQuality(candidate);
    // 质量问题返回 warning 但不阻止提交
    if (!qualityResult.valid) {
      return qualityResult;
    }

    return { valid: true, warning: qualityResult.warning };
  }

  /**
   * 记录已提交标题和代码指纹（提交成功后调用）
   * @param {string} title
   * @param {string} [pattern] — 代码模式
   */
  recordTitle(title, pattern) {
    this.#globalTitles.add((title || '').toLowerCase().trim());
    if (pattern && pattern.length >= 30) {
      const fp = codeFingerprint(pattern);
      if (fp.length >= 20) {
        this.#globalPatternFingerprints.add(fp);
      }
    }
  }

  /**
   * 从 markdown 中提取最长的 fenced code block 作为 pattern
   * @param {string} markdown
   * @returns {string|null} 提取的代码，或 null
   */
  static #extractCodeFromMarkdown(markdown) {
    const codeBlockRe = /```(?:\w+)?\n([\s\S]*?)```/g;
    let best = null;
    let bestLen = 0;
    let match;
    while ((match = codeBlockRe.exec(markdown)) !== null) {
      const code = match[1].trim();
      if (code.length > bestLen) {
        best = code;
        bestLen = code.length;
      }
    }
    // 只接受有实质内容的代码块 (>=30字符)
    return best && bestLen >= 30 ? best : null;
  }
}

export default CandidateGuardrail;
