/**
 * @module EnhancementPack
 * @description 语言/框架特有增强能力包 — 接口定义
 *
 * 每个增强包负责:
 * - 额外的 Bootstrap 维度
 * - 额外的 Guard 规则
 * - 额外的设计模式检测
 * - SFC 预处理（.vue → 提取 <script>）
 * - Reference Skill 路径
 */

export class EnhancementPack {
  /** 增强包 ID @returns {string} */
  get id() {
    throw new Error('Not implemented');
  }

  /** 适用条件 @returns {{ languages: string[], frameworks?: string[] }} */
  get conditions() {
    throw new Error('Not implemented');
  }

  /** 人类可读名称 @returns {string} */
  get displayName() {
    return this.id;
  }

  /**
   * 额外的 Bootstrap 维度定义
   * @returns {Array<object>}
   */
  getExtraDimensions() {
    return [];
  }

  /**
   * 额外的 Guard 规则
   * @returns {Array<object>}
   */
  getGuardRules() {
    return [];
  }

  /**
   * 额外的设计模式检测
   * @param {object} astSummary — analyzeFile/analyzeProject 的返回值
   * @returns {Array<{ type: string, className?: string, line?: number, confidence: number }>}
   */
  detectPatterns(astSummary) {
    return [];
  }

  /**
   * SFC 预处理器 — 将非标准文件转换为可解析的脚本内容
   * @param {string} content — 原始文件内容
   * @param {string} ext — 文件扩展名 (含 .)
   * @returns {{ content: string, lang: string } | null}
   */
  preprocessFile(content, ext) {
    return null;
  }

  /**
   * Reference Skill 路径（Bootstrap 时自动加载，相对于 skills/ 目录）
   * @returns {string|null}
   */
  getReferenceSkillPath() {
    return null;
  }
}
