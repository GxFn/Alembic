/**
 * RateLimiter — 简易内存限流器
 * 防止短时间内批量提交导致资源耗尽
 */

const _buckets = new Map();
let _lastPrune = Date.now();
const PRUNE_INTERVAL = 300_000; // 5 分钟清理一次过期 bucket

/**
 * 清理过期的 bucket 条目，防止内存泄漏
 */
function _pruneIfNeeded(windowMs) {
  const now = Date.now();
  if (now - _lastPrune < PRUNE_INTERVAL) {
    return;
  }
  _lastPrune = now;
  for (const [key, bucket] of _buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length === 0) {
      _buckets.delete(key);
    }
  }
}

/**
 * 检查是否允许提交
 * @param {string} projectRoot 项目根路径作为命名空间
 * @param {string} clientId 客户端标识
 * @param {object} [opts] - { windowMs: 60000, maxRequests: 10 }
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
export function checkRecipeSave(projectRoot, clientId, opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 10;
  const key = `${projectRoot}:${clientId}`;
  const now = Date.now();

  // 定期清理过期 bucket
  _pruneIfNeeded(windowMs);

  let bucket = _buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    _buckets.set(key, bucket);
  }

  // 清除过期记录
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= maxRequests) {
    const oldest = bucket.timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false, retryAfter };
  }

  bucket.timestamps.push(now);
  return { allowed: true };
}

/**
 * 重置限流器（测试用）
 */
export function resetRateLimiter() {
  _buckets.clear();
}

export default { checkRecipeSave, resetRateLimiter };
