/**
 * Stats — 统计值对象
 *
 * 记录知识条目的使用统计：浏览、采用、应用、Guard 命中、搜索命中、权威分。
 *
 * Phase 0 扩展：新增时间戳、滑窗统计、版本号、FP 率字段。
 * 新字段均有默认值，与旧 JSON 100% 向后兼容。
 */
type StatsCounter = 'views' | 'adoptions' | 'applications' | 'guardHits' | 'searchHits';

interface StatsProps {
  views?: number;
  adoptions?: number;
  applications?: number;
  guardHits?: number;
  searchHits?: number;
  authority?: number;
  // Phase 0: 时间戳
  lastHitAt?: number | null;
  lastSearchedAt?: number | null;
  lastGuardHitAt?: number | null;
  // Phase 0: 滑窗统计
  hitsLast30d?: number;
  hitsLast90d?: number;
  searchHitsLast30d?: number;
  // Phase 0: 版本
  version?: number;
  // Phase 0: 精度 (仅 kind=rule)
  ruleFalsePositiveRate?: number | null;
}

export class Stats {
  adoptions: number;
  applications: number;
  authority: number;
  guardHits: number;
  searchHits: number;
  views: number;

  // Phase 0: 时间戳 —— "最后一次被使用是什么时候"
  lastHitAt: number | null;
  lastSearchedAt: number | null;
  lastGuardHitAt: number | null;

  // Phase 0: 滑窗统计 —— "最近趋势如何"
  hitsLast30d: number;
  hitsLast90d: number;
  searchHitsLast30d: number;

  // Phase 0: 版本 —— "这条知识更新了几次"
  version: number;

  // Phase 0: 精度 (仅 kind=rule)
  ruleFalsePositiveRate: number | null;

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

    // Phase 0 扩展字段（旧 JSON 无这些字段时取默认值）
    this.lastHitAt = props.lastHitAt ?? null;
    this.lastSearchedAt = props.lastSearchedAt ?? null;
    this.lastGuardHitAt = props.lastGuardHitAt ?? null;
    this.hitsLast30d = props.hitsLast30d ?? 0;
    this.hitsLast90d = props.hitsLast90d ?? 0;
    this.searchHitsLast30d = props.searchHitsLast30d ?? 0;
    this.version = props.version ?? 1;
    this.ruleFalsePositiveRate = props.ruleFalsePositiveRate ?? null;
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

  /** 记录一次命中，同时更新时间戳（Unix 秒） */
  recordHit(counter: StatsCounter, timestamp = Math.floor(Date.now() / 1000)): Stats {
    this[counter] += 1;
    this.lastHitAt = timestamp;
    if (counter === 'searchHits') {
      this.lastSearchedAt = timestamp;
    }
    if (counter === 'guardHits') {
      this.lastGuardHitAt = timestamp;
    }
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
      lastHitAt: this.lastHitAt,
      lastSearchedAt: this.lastSearchedAt,
      lastGuardHitAt: this.lastGuardHitAt,
      hitsLast30d: this.hitsLast30d,
      hitsLast90d: this.hitsLast90d,
      searchHitsLast30d: this.searchHitsLast30d,
      version: this.version,
      ruleFalsePositiveRate: this.ruleFalsePositiveRate,
    };
  }

  /** 从 wire format 创建 */
  static fromJSON(data: unknown): Stats {
    return Stats.from(data);
  }
}

export default Stats;
