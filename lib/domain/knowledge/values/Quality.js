/**
 * Quality — 质量值对象
 *
 * 4 维度评分 + 综合分 + 等级。
 */
export class Quality {
  constructor(props = {}) {
    /** @type {number} 内容完整度 (0-1) */
    this.completeness   = props.completeness   ?? 0;
    /** @type {number} 项目适配度 (0-1) */
    this.adaptation     = props.adaptation     ?? 0;
    /** @type {number} 文档清晰度 (0-1) */
    this.documentation  = props.documentation  ?? 0;
    /** @type {number} 综合分 (0-1) */
    this.overall        = props.overall        ?? 0;
    /** @type {string} 等级 A-F */
    this.grade          = props.grade          || Quality.calcGrade(this.overall);
  }

  /**
   * 从任意输入构造 Quality
   * @param {Quality|Object|null} input
   * @returns {Quality}
   */
  static from(input) {
    if (input instanceof Quality) return input;
    return new Quality(input || {});
  }

  /**
   * 从旧 Recipe quality 字段映射
   * @param {Object} old { codeCompleteness, projectAdaptation, documentationClarity, overall }
   * @returns {Quality}
   */
  static fromLegacyRecipe(old) {
    if (!old) return new Quality();
    return new Quality({
      completeness:  old.codeCompleteness      ?? old.completeness  ?? 0,
      adaptation:    old.projectAdaptation      ?? old.adaptation    ?? 0,
      documentation: old.documentationClarity   ?? old.documentation ?? 0,
      overall:       old.overall                ?? 0,
    });
  }

  /**
   * 从 3 维度计算综合分
   * @returns {Quality}
   */
  recalculate() {
    this.overall = Math.round(
      ((this.completeness + this.adaptation + this.documentation) / 3) * 100
    ) / 100;
    this.grade = Quality.calcGrade(this.overall);
    return this;
  }

  /**
   * 根据分数计算等级
   * @param {number} score 0-1
   * @returns {string}
   */
  static calcGrade(score) {
    if (score >= 0.9) return 'A';
    if (score >= 0.75) return 'B';
    if (score >= 0.6) return 'C';
    if (score >= 0.4) return 'D';
    return 'F';
  }

  /**
   * 转换为 wire format JSON
   */
  toJSON() {
    return {
      completeness:  this.completeness,
      adaptation:    this.adaptation,
      documentation: this.documentation,
      overall:       this.overall,
      grade:         this.grade,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Quality}
   */
  static fromJSON(data) {
    return Quality.from(data);
  }
}

export default Quality;
