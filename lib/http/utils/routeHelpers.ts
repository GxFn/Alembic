/**
 * 路由共用工具函数
 * 提取自各路由文件中的重复实现
 */

import { KnowledgeEntry } from '../../domain/knowledge/KnowledgeEntry.js';

/**
 * 从请求中提取操作上下文（用户身份、IP、UA）
 * @param {import('express').Request} req
 * @returns {{ userId: string, ip: string, userAgent: string }}
 */
export function getContext(req) {
  return {
    userId: req.headers['x-user-id'] || 'anonymous',
    ip: req.ip,
    userAgent: req.headers['user-agent'] || '',
  };
}

/**
 * 安全的整数解析（带范围约束）
 * @param {*} value     待解析值
 * @param {number} defaultValue  解析失败时的默认值
 * @param {number} [min=1]       最小值
 * @param {number} [max=1000]    最大值
 * @returns {number}
 */
export function safeInt(value, defaultValue, min = 1, max = 1000) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, parsed));
}

/**
 * 将 KnowledgeEntry（或其 toJSON 输出）转换为对外 API 安全的格式
 * - 过滤系统内部标签（dimension:* / bootstrap:* 等）
 *
 * @param {KnowledgeEntry|Object} entryOrJson  实体或 toJSON 输出
 * @returns {Object} 过滤后的 JSON
 */
export function sanitizeForAPI(entryOrJson) {
  const json =
    typeof entryOrJson?.toJSON === 'function' ? entryOrJson.toJSON() : { ...entryOrJson };
  if (Array.isArray(json.tags)) {
    json.tags = json.tags.filter((t) => !KnowledgeEntry.isSystemTag(t));
  }
  return json;
}

/**
 * 将分页结果中的 data 数组批量过滤系统标签
 * @param {{ data: Array, pagination: Object }} result
 * @returns {{ data: Array, pagination: Object }}
 */
export function sanitizePaginatedForAPI(result) {
  if (!result?.data) {
    return result;
  }
  return {
    ...result,
    data: result.data.map(sanitizeForAPI),
  };
}
