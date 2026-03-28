/**
 * HitRecorder — 批量使用信号采集器
 *
 * Phase 0 核心服务。将高频使用事件（Guard 命中、搜索命中、采用等）
 * 先写入内存 buffer，定时批量持久化到 Stats JSON，同时发射 SignalBus 信号。
 *
 * 设计要点：
 *   - 即时 emit Signal（信号不延迟）
 *   - buffer → 30s flush → 批量 UPDATE（减少 SQLite 写）
 *   - shutdown hook 保证进程退出前数据落盘
 *
 * @module service/signal/HitRecorder
 */

import type { SignalBus, SignalType } from '#infra/signal/SignalBus.js';

/** better-sqlite3 兼容类型（与 GuardCheckEngine 相同模式） */
interface DatabaseLike {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

// ── Types ───────────────────────────────────────────

/** 支持的命中事件类型 */
export type HitEventType = 'guardHit' | 'searchHit' | 'view' | 'adoption' | 'application';

/** 缓冲条目 */
interface BufferEntry {
  recipeId: string;
  eventType: HitEventType;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** HitRecorder 配置 */
export interface HitRecorderConfig {
  /** flush 间隔（ms），默认 30000 */
  flushIntervalMs?: number;
  /** 立即 flush 的最大缓冲条目数，默认 100 */
  maxBufferSize?: number;
}

/** 事件类型 → Stats JSON 字段 映射 */
const EVENT_TO_STATS_FIELD: Record<HitEventType, string> = {
  guardHit: 'guardHits',
  searchHit: 'searchHits',
  view: 'views',
  adoption: 'adoptions',
  application: 'applications',
};

/** 事件类型 → SignalBus 信号类型 映射 */
const EVENT_TO_SIGNAL_TYPE: Record<HitEventType, SignalType> = {
  guardHit: 'guard',
  searchHit: 'search',
  view: 'usage',
  adoption: 'usage',
  application: 'usage',
};

// ── HitRecorder ─────────────────────────────────────

export class HitRecorder {
  readonly #bus: SignalBus;
  readonly #db: DatabaseLike;
  readonly #buffer = new Map<string, BufferEntry>();
  readonly #flushIntervalMs: number;
  readonly #maxBufferSize: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #totalRecorded = 0;
  #totalFlushed = 0;

  constructor(
    bus: SignalBus,
    db: DatabaseLike | { getDb(): DatabaseLike },
    config: HitRecorderConfig = {}
  ) {
    this.#bus = bus;
    this.#db =
      'getDb' in db && typeof db.getDb === 'function'
        ? (db as { getDb(): DatabaseLike }).getDb()
        : (db as DatabaseLike);
    this.#flushIntervalMs = config.flushIntervalMs ?? 30_000;
    this.#maxBufferSize = config.maxBufferSize ?? 100;
  }

  /**
   * 启动定时 flush。通常在服务初始化时调用。
   */
  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    this.#timer.unref(); // 不阻止进程退出
  }

  /**
   * 停止定时 flush 并执行最后一次 flush。
   * 供 shutdown hook 调用。
   */
  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  /**
   * 记录一次命中事件。
   *
   * 1. 立即通过 SignalBus 发射信号（信号不延迟）
   * 2. 事件写入内存 buffer，等待 flush 批量持久化
   *
   * @param recipeId  关联的知识条目 ID
   * @param eventType 事件类型
   * @param value     信号强度 0-1（默认 1）
   * @param metadata  附加元数据
   */
  record(
    recipeId: string,
    eventType: HitEventType,
    value = 1,
    metadata: Record<string, unknown> = {}
  ): void {
    this.#totalRecorded++;

    // 1. 即时发射信号
    this.#bus.send(EVENT_TO_SIGNAL_TYPE[eventType], `HitRecorder.${eventType}`, value, {
      target: recipeId,
      metadata: { ...metadata, eventType },
    });

    // 2. 聚合进 buffer
    const key = `${recipeId}:${eventType}`;
    const now = Date.now();
    const existing = this.#buffer.get(key);

    if (existing) {
      existing.count++;
      existing.lastAt = now;
    } else {
      this.#buffer.set(key, {
        recipeId,
        eventType,
        count: 1,
        firstAt: now,
        lastAt: now,
      });
    }

    // 3. buffer 满时立即 flush
    if (this.#buffer.size >= this.#maxBufferSize) {
      void this.flush();
    }
  }

  /**
   * 批量持久化 buffer 到数据库。
   * 使用 json_set 原子更新 Stats JSON 中对应字段。
   */
  async flush(): Promise<number> {
    if (this.#buffer.size === 0) {
      return 0;
    }

    // 取出当前 buffer 并清空（后续 record 写入新 buffer）
    const entries = [...this.#buffer.values()];
    this.#buffer.clear();

    let flushed = 0;
    const now = Math.floor(Date.now() / 1000);

    try {
      const stmt = this.#db.prepare(
        `UPDATE knowledge_entries
         SET stats = json_set(
               COALESCE(stats, '{}'),
               '$.' || ?,
               COALESCE(json_extract(stats, '$.' || ?), 0) + ?
             ),
             updatedAt = ?
         WHERE id = ?`
      );

      for (const entry of entries) {
        const field = EVENT_TO_STATS_FIELD[entry.eventType];
        try {
          stmt.run(field, field, entry.count, now, entry.recipeId);
          flushed += entry.count;
        } catch {
          // Recipe 可能已被删除，静默忽略
        }
      }
    } catch {
      // DB statement prepare 失败（表可能不存在），回填 buffer
      for (const entry of entries) {
        const key = `${entry.recipeId}:${entry.eventType}`;
        const existing = this.#buffer.get(key);
        if (existing) {
          existing.count += entry.count;
        } else {
          this.#buffer.set(key, entry);
        }
      }
    }

    this.#totalFlushed += flushed;
    return flushed;
  }

  /** 当前 buffer 中的条目数（诊断用） */
  get bufferSize(): number {
    return this.#buffer.size;
  }

  /** 累计记录次数 */
  get totalRecorded(): number {
    return this.#totalRecorded;
  }

  /** 累计已持久化次数 */
  get totalFlushed(): number {
    return this.#totalFlushed;
  }
}
