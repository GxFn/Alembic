/**
 * RecipeSaveRateLimiter — in-memory submit rate limiter.
 *
 * AD4 relocation: formerly lib/http/middleware/RateLimiter.ts bare module
 * state. Its only consumers are the resident submit pipelines (the http host
 * area never imported it), so infrastructure is the doctrine-correct leaf
 * home — the former resident -> http layer inversion (two blessed
 * exceptions) becomes a plain downward resident -> infrastructure edge.
 *
 * Lifecycle (AD4 doctrine): buckets are instance state with the same
 * opportunistic pruning as before plus clear() disposal. Production paths
 * use the container-registered singleton ('recipeSaveRateLimiter',
 * AppModule); resolveRecipeSaveRateLimiter falls back to a lazily-created
 * process-default instance when a caller's container lacks the registration
 * (e.g. minimal test contexts) — same effective process-global semantics as
 * the old module, now encapsulated and disposable.
 */

import Logger from '@alembic/core/logging';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter?: number;
}

export interface RecipeSaveRateLimitOptions {
  windowMs?: number;
  maxRequests?: number;
}

const PRUNE_INTERVAL_MS = 300_000; // 5 分钟清理一次过期 bucket

export class RecipeSaveRateLimiter {
  #buckets = new Map<string, { timestamps: number[] }>();
  #lastPrune = Date.now();

  /** 检查是否允许提交（行为与旧 checkRecipeSave 完全一致） */
  check(
    projectRoot: string,
    clientId: string,
    opts: RecipeSaveRateLimitOptions = {}
  ): RateLimitDecision {
    const windowMs = opts.windowMs ?? 60_000;
    const maxRequests = opts.maxRequests ?? 10;
    const key = `${projectRoot}:${clientId}`;
    const now = Date.now();

    this.#pruneIfNeeded(windowMs);

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.#buckets.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

    if (bucket.timestamps.length >= maxRequests) {
      const oldest = bucket.timestamps[0];
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      return { allowed: false, retryAfter };
    }

    bucket.timestamps.push(now);
    return { allowed: true };
  }

  /** 清理过期的 bucket 条目，防止内存泄漏 */
  #pruneIfNeeded(windowMs: number) {
    const now = Date.now();
    if (now - this.#lastPrune < PRUNE_INTERVAL_MS) {
      return;
    }
    this.#lastPrune = now;
    for (const [key, bucket] of this.#buckets) {
      bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
      if (bucket.timestamps.length === 0) {
        this.#buckets.delete(key);
      }
    }
  }

  /** 生命周期处置：清空全部 bucket（测试/关停用，旧 resetRateLimiter 的对等物） */
  clear() {
    this.#buckets.clear();
    this.#lastPrune = Date.now();
  }
}

let _defaultLimiter: RecipeSaveRateLimiter | null = null;

/** Lazily-created process default — managed lifecycle, disposable via reset. */
export function getDefaultRecipeSaveRateLimiter(): RecipeSaveRateLimiter {
  _defaultLimiter ??= new RecipeSaveRateLimiter();
  return _defaultLimiter;
}

/** 重置默认实例（测试用） */
export function resetDefaultRecipeSaveRateLimiter() {
  _defaultLimiter?.clear();
}

/**
 * Resolve the limiter from a duck-typed container ('recipeSaveRateLimiter'
 * singleton) with a logged fallback to the process default — mock containers
 * in tests do not register it.
 */
export function resolveRecipeSaveRateLimiter(container: unknown): RecipeSaveRateLimiter {
  try {
    const get = (container as { get?: (name: string) => unknown } | null | undefined)?.get;
    const fromContainer =
      typeof get === 'function' ? get.call(container, 'recipeSaveRateLimiter') : undefined;
    if (fromContainer instanceof RecipeSaveRateLimiter) {
      return fromContainer;
    }
  } catch {
    /* unregistered — fall through to the default instance */
  }
  Logger.getInstance().debug?.(
    '[RecipeSaveRateLimiter] container has no recipeSaveRateLimiter singleton — using process default'
  );
  return getDefaultRecipeSaveRateLimiter();
}
