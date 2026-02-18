/**
 * 通用工具函数 — 消除跨模块重复代码
 *
 * @module shared/utils/common
 */

// ─── JSON 安全解析 ──────────────────────────────────────

/**
 * 安全解析 JSON 字符串，失败时返回 fallback
 * 消除各 Repository / handler 中重复的 try-catch JSON.parse
 *
 * @param {string|object|null|undefined} value — 值（可能是 JSON 字符串、对象或空值）
 * @param {*} [fallback=null] — 解析失败时的回退值
 * @returns {*}
 */
export function safeJsonParse(value, fallback = null) {
  if (value == null || value === 'null' || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 安全序列化到 JSON，处理 toJSON() 方法和空值
 * 消除 _entityToRow 中重复的 JSON.stringify 逻辑
 *
 * @param {*} value — 需要序列化的值
 * @param {*} [fallback='{}'] — 值为空时的回退
 * @returns {string}
 */
export function safeJsonStringify(value, fallback = '{}') {
  if (value == null) return fallback;
  if (typeof value?.toJSON === 'function') {
    return JSON.stringify(value.toJSON());
  }
  return JSON.stringify(value);
}

// ─── 时间 ────────────────────────────────────────────────

/**
 * 返回当前 Unix 时间戳（秒）
 * 消除各处 Math.floor(Date.now() / 1000) 的重复
 *
 * @returns {number}
 */
export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

// ─── 安全默认值 ──────────────────────────────────────────

/**
 * 返回非空字符串值或 fallback
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 */
export function strOr(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) return value;
  return fallback;
}

export default { safeJsonParse, safeJsonStringify, unixNow, strOr };
