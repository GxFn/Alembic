/**
 * Relations — 关系图值对象
 *
 * 统一为分桶结构（非扁平数组）。
 * 每个桶存储 [{ target, description }] 格式的关系列表。
 */

/** 所有合法的关系桶名 (snake_case) */
export const RELATION_BUCKETS = [
  'inherits', // 继承
  'implements', // 实现接口/协议
  'calls', // 调用
  'depends_on', // 依赖
  'data_flow', // 数据流向
  'conflicts', // 冲突
  'extends', // 扩展
  'related', // 弱关联
  'alternative', // 替代方案
  'prerequisite', // 前置条件
  'deprecated_by', // 被取代
  'solves', // 解决问题
  'enforces', // 强制约束
  'references', // 引用
];

export interface RelationEntry {
  target: string;
  description: string;
}

type RelationBuckets = Record<string, Array<string | Partial<RelationEntry>>>;

export class Relations {
  _b: Record<string, RelationEntry[]>;
  constructor(buckets: RelationBuckets = {}) {
    /** @type {Object.<string, Array<{target:string, description:string}>>} */
    this._b = {};
    for (const k of RELATION_BUCKETS) {
      const vals = buckets[k] || [];
      this._b[k] = vals
        .map((r: string | Partial<RelationEntry>) => {
          // 兼容字符串数组：AI prompt 可能返回 ["recipeName"] 而非 [{target,description}]
          if (typeof r === 'string') {
            return r.trim() ? { target: r.trim(), description: '' } : null;
          }
          return { target: r.target || '', description: r.description || '' };
        })
        .filter((entry): entry is RelationEntry => entry !== null);
    }
  }

  /** 从任意输入构造 Relations */
  static from(input: unknown): Relations {
    if (input instanceof Relations) {
      return input;
    }
    if (!input) {
      return new Relations();
    }
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        return new Relations();
      }
    }
    if (Array.isArray(input)) {
      // 扁平数组 → 自动分桶
      const buckets: Record<string, RelationEntry[]> = {};
      for (const rel of input) {
        const item = rel as Record<string, string>;
        const bucket = item.type || 'related';
        if (!buckets[bucket]) {
          buckets[bucket] = [];
        }
        buckets[bucket].push({
          target: item.target || '',
          description: item.description || '',
        });
      }
      return new Relations(buckets);
    }
    return new Relations(input as RelationBuckets);
  }

  /**
   * 扁平视图（仅 Dashboard 渲染用）
   * @returns >}
   */
  toFlatArray(): Array<{ type: string; target: string; description: string }> {
    const result: Array<{ type: string; target: string; description: string }> = [];
    for (const [type, list] of Object.entries(this._b)) {
      for (const r of list) {
        result.push({ type, ...r });
      }
    }
    return result;
  }

  /**
   * 获取指定桶
   * @returns >}
   */
  getByType(type: string): RelationEntry[] {
    return this._b[type] || [];
  }

  /** 是否为空 */
  isEmpty(): boolean {
    return Object.values(this._b).every((l) => l.length === 0);
  }

  /**
   * 添加关系
   * @param type 桶名
   * @param target 目标
   */
  add(type: string, target: string, description = ''): Relations {
    if (!this._b[type]) {
      this._b[type] = [];
    }
    if (!this._b[type].some((r) => r.target === target)) {
      this._b[type].push({ target, description });
    }
    return this;
  }

  /**
   * 移除关系
   * @param type 桶名
   * @param target 目标
   */
  remove(type: string, target: string): Relations {
    if (this._b[type]) {
      this._b[type] = this._b[type].filter((r) => r.target !== target);
    }
    return this;
  }

  /** 转换为 wire format JSON (分桶) */
  toJSON() {
    return { ...this._b };
  }

  /** 从 wire format 创建 */
  static fromJSON(data: unknown): Relations {
    return Relations.from(data);
  }
}

export default Relations;
