/**
 * Stats — 统计值对象
 *
 * 记录知识条目的使用统计：浏览、采用、应用、Guard 命中、搜索命中、权威分。
 */
type StatsCounter = 'views' | 'adoptions' | 'applications' | 'guardHits' | 'searchHits';

interface StatsProps {
  views?: number;
  adoptions?: number;
  applications?: number;
  guardHits?: number;
  searchHits?: number;
  authority?: number;
}

export class Stats {
  adoptions: number;
  applications: number;
  authority: number;
  guardHits: number;
  searchHits: number;
  views: number;
  constructor(props: StatsProps = {}) {
    /** 浏览次数 */
    this.views = props.views ?? 0;
    /** 采用次数 */
    this.adoptions = props.adoptions ?? 0;
    /** 应用次数 */
    this.applications = props.applications ?? 0;
    /** Guard 命中次数 */
    this.guardHits = props.guardHits ?? 0;
    /** 搜索命中次数 */
    this.searchHits = props.searchHits ?? 0;
    /** 权威分 0-5 */
    this.authority = props.authority ?? 0;
  }

  /** 从任意输入构造 Stats */
  static from(input: unknown): Stats {
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
    return new Stats((input || {}) as StatsProps);
  }

  /** 增加计数 */
  increment(counter: StatsCounter, delta = 1): Stats {
    this[counter] += delta;
    return this;
  }

  /** 转换为 JSON */
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

  /** 从 wire format 创建 */
  static fromJSON(data: unknown): Stats {
    return Stats.from(data);
  }
}

export default Stats;
