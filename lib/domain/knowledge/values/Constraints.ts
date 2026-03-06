/**
 * Constraints — 约束值对象
 *
 * 包含 Guard 规则 (regex + ast)、边界约束、前置条件、副作用。
 * Guard 规则预留 AST 类型，为语义规则做前瞻设计。
 */
export interface Guard {
  id: string | null;
  type: 'regex' | 'ast';
  pattern: string | null;
  ast_query: Record<string, unknown> | null;
  message: string;
  severity: 'error' | 'warning' | 'info';
  fix_suggestion: string | null;
}

interface ConstraintsProps {
  guards?: Array<Record<string, unknown>>;
  boundaries?: string[];
  preconditions?: string[];
  sideEffects?: string[];
}

export class Constraints {
  boundaries: string[];
  guards: Guard[];
  preconditions: string[];
  sideEffects: string[];
  constructor(props: ConstraintsProps = {}) {
    /** @type {Array<Guard>} Guard 规则列表 */
    this.guards = (props.guards || []).map(Constraints._normalizeGuard);
    /** @type {string[]} 边界约束 */
    this.boundaries = props.boundaries || [];
    /** @type {string[]} 前置条件 */
    this.preconditions = props.preconditions || [];
    /** @type {string[]} 副作用 */
    this.sideEffects = props.sideEffects ?? [];
  }

  /**
   * 从任意输入构造 Constraints
   * @param {Constraints|Object|null} input
   * @returns {Constraints}
   */
  static from(input: unknown): Constraints {
    if (input instanceof Constraints) {
      return input;
    }
    if (!input) {
      return new Constraints();
    }
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        return new Constraints();
      }
    }
    return new Constraints(input as ConstraintsProps);
  }

  /**
   * 标准化 Guard 对象
   * @param {Object} g
   * @returns {Guard}
   */
  static _normalizeGuard(g: Record<string, unknown>): Guard {
    return {
      id: (g.id as string) || null,
      type: ((g.type as string) || (g.ast_query ? 'ast' : 'regex')) as Guard['type'],
      pattern: (g.pattern as string) || null,
      ast_query: (g.ast_query as Record<string, unknown>) || null,
      message: (g.message as string) || '',
      severity: ((g.severity as string) || 'warning') as Guard['severity'],
      fix_suggestion: (g.fix_suggestion as string) || null,
    };
  }

  /**
   * 获取 regex 类型的 Guard 规则
   * @returns {Array<Guard>}
   */
  getRegexGuards(): Guard[] {
    return this.guards.filter((g) => g.type === 'regex' && g.pattern);
  }

  /**
   * 获取 ast 类型的 Guard 规则
   * @returns {Array<Guard>}
   */
  getAstGuards(): Guard[] {
    return this.guards.filter((g) => g.type === 'ast' && g.ast_query);
  }

  /**
   * 添加 Guard 规则
   * @param {Object} guard
   * @returns {Constraints}
   */
  addGuard(guard: Record<string, unknown>): Constraints {
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
    return (
      this.guards.length === 0 &&
      this.boundaries.length === 0 &&
      this.preconditions.length === 0 &&
      this.sideEffects.length === 0
    );
  }

  /**
   * 转换为 wire format JSON
   */
  toJSON() {
    return {
      guards: this.guards,
      boundaries: this.boundaries,
      preconditions: this.preconditions,
      sideEffects: this.sideEffects,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Constraints}
   */
  static fromJSON(data: unknown): Constraints {
    return Constraints.from(data);
  }
}

export type { Guard as GuardType };

export default Constraints;
