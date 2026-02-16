/**
 * Constraints — 约束值对象
 *
 * 包含 Guard 规则 (regex + ast)、边界约束、前置条件、副作用。
 * Guard 规则预留 AST 类型，为语义规则做前瞻设计。
 */
export class Constraints {
  constructor(props = {}) {
    /** @type {Array<Guard>} Guard 规则列表 */
    this.guards        = (props.guards || []).map(Constraints._normalizeGuard);
    /** @type {string[]} 边界约束 */
    this.boundaries    = props.boundaries    || [];
    /** @type {string[]} 前置条件 */
    this.preconditions = props.preconditions || [];
    /** @type {string[]} 副作用 */
    this.sideEffects   = props.side_effects  ?? props.sideEffects ?? [];
  }

  /**
   * 从任意输入构造 Constraints
   * @param {Constraints|Object|null} input
   * @returns {Constraints}
   */
  static from(input) {
    if (input instanceof Constraints) return input;
    if (!input) return new Constraints();
    return new Constraints(input);
  }

  /**
   * 标准化 Guard 对象
   * @param {Object} g
   * @returns {Guard}
   */
  static _normalizeGuard(g) {
    return {
      id:             g.id             || null,
      type:           g.type           || (g.ast_query ? 'ast' : 'regex'),
      pattern:        g.pattern        || null,
      ast_query:      g.ast_query      || null,
      message:        g.message        || '',
      severity:       g.severity       || 'warning',
      fix_suggestion: g.fix_suggestion || null,
    };
  }

  /**
   * 获取 regex 类型的 Guard 规则
   * @returns {Array<Guard>}
   */
  getRegexGuards() {
    return this.guards.filter(g => g.type === 'regex' && g.pattern);
  }

  /**
   * 获取 ast 类型的 Guard 规则
   * @returns {Array<Guard>}
   */
  getAstGuards() {
    return this.guards.filter(g => g.type === 'ast' && g.ast_query);
  }

  /**
   * 添加 Guard 规则
   * @param {Object} guard
   * @returns {Constraints}
   */
  addGuard(guard) {
    this.guards.push(Constraints._normalizeGuard(guard));
    return this;
  }

  /**
   * 是否有 Guard 规则
   * @returns {boolean}
   */
  hasGuards() {
    return this.guards.length > 0;
  }

  /**
   * 是否为空
   * @returns {boolean}
   */
  isEmpty() {
    return this.guards.length === 0 &&
           this.boundaries.length === 0 &&
           this.preconditions.length === 0 &&
           this.sideEffects.length === 0;
  }

  /**
   * 转换为 wire format JSON
   */
  toJSON() {
    return {
      guards:        this.guards,
      boundaries:    this.boundaries,
      preconditions: this.preconditions,
      side_effects:  this.sideEffects,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Constraints}
   */
  static fromJSON(data) {
    return Constraints.from(data);
  }
}

/**
 * @typedef {Object} Guard
 * @property {?string} id          - Guard 唯一标识
 * @property {'regex'|'ast'} type  - 类型
 * @property {?string} pattern     - regex pattern (type=regex 时)
 * @property {?Object} ast_query   - AST 查询 (type=ast 时)
 * @property {string}  message     - 错误/警告消息
 * @property {'error'|'warning'|'info'} severity - 严重级别
 * @property {?string} fix_suggestion - 关联修复 Recipe 的 trigger
 */

export default Constraints;
