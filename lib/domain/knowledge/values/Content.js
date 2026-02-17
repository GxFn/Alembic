/**
 * Content — 内容值对象
 *
 * 统一承载代码片段 (pattern) 或 Markdown 全文 (markdown)，
 * 以及设计原理、实施步骤、代码变更、验证方式。
 */
export class Content {
  constructor(props = {}) {
    /** @type {string} 代码片段 */
    this.pattern      = props.pattern      ?? '';
    /** @type {string} Markdown 全文（与 pattern 二选一） */
    this.markdown     = props.markdown     ?? '';
    /** @type {string} 设计原理 */
    this.rationale    = props.rationale    ?? '';
    /** @type {Array<{title?:string, description?:string, code?:string}>} 实施步骤 */
    this.steps        = props.steps        ?? [];
    /** @type {Array<{file:string, before:string, after:string, explanation:string}>} 代码变更 */
    this.codeChanges  = props.codeChanges ?? [];
    /** @type {?{method?:string, expected_result?:string, test_code?:string}} 验证方式 */
    this.verification = props.verification ?? null;
  }

  /**
   * 从任意输入构造 Content
   * @param {Content|Object|null} input
   * @returns {Content}
   */
  static from(input) {
    if (input instanceof Content) return input;
    if (!input) return new Content();
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { return new Content(); }
    }
    return new Content(input);
  }

  /**
   * 是否包含有效内容
   * @returns {boolean}
   */
  hasContent() {
    return !!(this.pattern || this.markdown || this.rationale || this.steps.length > 0);
  }

  /**
   * 转换为 wire format JSON
   */
  toJSON() {
    return {
      pattern:      this.pattern,
      markdown:     this.markdown,
      rationale:    this.rationale,
      steps:        this.steps,
      codeChanges:  this.codeChanges,
      verification: this.verification,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Content}
   */
  static fromJSON(data) {
    return new Content(data);
  }
}

export default Content;
