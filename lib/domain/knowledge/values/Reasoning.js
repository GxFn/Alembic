/**
 * Reasoning — 推理值对象（V3 统一版）
 *
 * 与旧 Candidate.Reasoning 逻辑一致，但 wire format 统一为 snake_case。
 */
export class Reasoning {
  constructor(props = {}) {
    /** @type {string} 为什么遵循标准 */
    this.whyStandard    = props.why_standard    ?? props.whyStandard ?? '';
    /** @type {string[]} 来源列表 */
    this.sources        = props.sources         || [];
    /** @type {number} 置信度 0-1 */
    this.confidence     = props.confidence      ?? 0.7;
    /** @type {Object.<string, number>} 质量信号 */
    this.qualitySignals = props.quality_signals  ?? props.qualitySignals ?? {};
    /** @type {string[]} 备选方案 */
    this.alternatives   = props.alternatives    || [];
  }

  /**
   * 从任意输入构造 Reasoning
   * @param {Reasoning|Object|null} input
   * @returns {Reasoning}
   */
  static from(input) {
    if (input instanceof Reasoning) return input;
    if (!input) return new Reasoning();
    return new Reasoning(input);
  }

  /**
   * 验证推理信息的完整性
   * @returns {boolean}
   */
  isValid() {
    return !!(
      this.whyStandard?.trim() &&
      Array.isArray(this.sources) &&
      this.sources.length > 0 &&
      typeof this.confidence === 'number' &&
      this.confidence >= 0 &&
      this.confidence <= 1
    );
  }

  /**
   * 转换为 wire format JSON (snake_case)
   */
  toJSON() {
    return {
      why_standard:    this.whyStandard,
      sources:         this.sources,
      confidence:      this.confidence,
      quality_signals: this.qualitySignals,
      alternatives:    this.alternatives,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Reasoning}
   */
  static fromJSON(data) {
    return new Reasoning(data);
  }
}

export default Reasoning;
