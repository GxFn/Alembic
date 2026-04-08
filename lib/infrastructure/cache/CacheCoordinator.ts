/**
 * CacheCoordinator — 跨进程缓存失效协调器
 *
 * 利用 SQLite 内置的 `PRAGMA data_version` 检测其他进程的 DB 写入。
 * 当检测到 data_version 变化时，通知所有注册的订阅者清除内存缓存。
 *
 * 原理：
 *   - SQLite 的 data_version 是一个连接级别的计数器
 *   - 当 *其他* 连接（包括其他进程）提交写事务后，当前连接的下次读操作
 *     会看到递增的 data_version
 *   - 通过定期轮询（默认 2s），实现近实时的跨进程缓存失效
 *   - 开销极低：一次 pragma 读取 < 0.01ms
 *
 * 典型场景：
 *   - MCP Server 冷启动写入 33 条 Recipe → HTTP Server 的 data_version 变化
 *   - 用户 CLI 执行 `asd embed` → Dashboard API 的缓存自动失效
 *
 * @module infrastructure/cache/CacheCoordinator
 */

import type { SqliteDatabase } from '../database/DatabaseConnection.js';
import Logger from '../logging/Logger.js';

export type InvalidateHandler = () => void;

export class CacheCoordinator {
  readonly #db: SqliteDatabase;
  #lastVersion: number;
  #interval: ReturnType<typeof setInterval> | null = null;
  readonly #subscribers = new Map<string, InvalidateHandler>();
  #pollMs: number;

  constructor(db: SqliteDatabase, pollIntervalMs = 2000) {
    this.#db = db;
    this.#pollMs = pollIntervalMs;
    this.#lastVersion = this.#readVersion();
  }

  /** 启动轮询（仅长驻进程需要：HTTP server / MCP server） */
  start(): void {
    if (this.#interval) {
      return;
    }
    this.#interval = setInterval(() => this.#check(), this.#pollMs);
    // unref 避免阻止进程正常退出
    if (this.#interval.unref) {
      this.#interval.unref();
    }
    Logger.info('[CacheCoordinator] Started', {
      pollMs: this.#pollMs,
      subscribers: this.#subscribers.size,
    });
  }

  /** 停止轮询 */
  stop(): void {
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }

  /**
   * 注册缓存失效回调
   *
   * @param name  标识名（用于日志，如 'panoramaService'）
   * @param handler 失效时调用的清除函数
   * @returns 取消注册函数
   */
  subscribe(name: string, handler: InvalidateHandler): () => void {
    this.#subscribers.set(name, handler);
    return () => {
      this.#subscribers.delete(name);
    };
  }

  /** 当前订阅者数量（诊断用） */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** 手动触发一次检查（测试用） */
  check(): boolean {
    return this.#check();
  }

  // ── 内部方法 ──────────────────────────────────────

  #readVersion(): number {
    return this.#db.pragma('data_version', { simple: true }) as number;
  }

  /** @returns true 如果版本变化并触发了失效 */
  #check(): boolean {
    const current = this.#readVersion();
    if (current === this.#lastVersion) {
      return false;
    }

    const prev = this.#lastVersion;
    this.#lastVersion = current;

    const names = [...this.#subscribers.keys()];
    Logger.info('[CacheCoordinator] DB changed by another process, invalidating caches', {
      prevVersion: prev,
      newVersion: current,
      targets: names,
    });

    for (const [name, handler] of this.#subscribers) {
      try {
        handler();
      } catch (err: unknown) {
        Logger.warn(`[CacheCoordinator] Invalidation handler "${name}" threw`, {
          error: (err as Error).message,
        });
      }
    }

    return true;
  }
}
