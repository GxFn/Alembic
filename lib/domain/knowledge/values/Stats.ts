/**
 * Stats — 统计值对象
 *
 * 记录知识条目的使用统计：浏览、采用、应用、Guard 命中、搜索命中、权威分。
 */
export class Stats {
  adoptions: any;
  applications: any;
  authority: any;
  guardHits: any;
  searchHits: any;
  views: any;
  constructor(props: any = {}) {
    /** @type {number} 浏览次数 */
    this.views = props.views ?? 0;
    /** @type {number} 采用次数 */
    this.adoptions = props.adoptions ?? 0;
    /** @type {number} 应用次数 */
    this.applications = props.applications ?? 0;
    /** @type {number} Guard 命中次数 */
    this.guardHits = props.guardHits ?? 0;
    /** @type {number} 搜索命中次数 */
    this.searchHits = props.searchHits ?? 0;
    /** @type {number} 权威分 0-5 */
    this.authority = props.authority ?? 0;
  }

  /**
   * 从任意输入构造 Stats
   * @param {Stats|Object|null} input
   * @returns {Stats}
   */
  static from(input) {
    if (input instanceof Stats) {
      return input;
    }
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        return new Stats();
      }
    }
    return new Stats(input || {});
  }

  /**
   * 增加计数
   * @param {'views'|'adoptions'|'applications'|'guardHits'|'searchHits'} counter
   * @param {number} delta
   * @returns {Stats}
   */
  increment(counter, delta = 1) {
    if (counter in this && typeof this[counter] === 'number') {
      this[counter] += delta;
    }
    return this;
  }

  /**
   * 转换为 JSON
   */
  toJSON() {
    return {
      views: this.views,
      adoptions: this.adoptions,
      applications: this.applications,
      guardHits: this.guardHits,
      searchHits: this.searchHits,
      authority: this.authority,
    };
  }

  /**
   * 从 wire format 创建
   * @param {Object} data
   * @returns {Stats}
   */
  static fromJSON(data) {
    return Stats.from(data);
  }
}

export default Stats;
