/**
 * 请求日志中间件
 * 使用 res.on('finish') 替代猴子补丁 res.send
 *
 * 精简策略:
 *   - GET 请求 + 2xx 状态码: 降为 debug（Dashboard 轮询高频噪音）
 *   - 非 GET / 非 2xx / 慢请求(>2s): 保留 info 级别
 *
 * ⚠️ 重要: 使用 req.originalUrl 而非 req.path。
 *    Express 4 子路由器 (app.use('/api/v1/x', router)) 会在执行
 *    handler 期间临时修改 req.url / req.path 为相对路径 (e.g. '/')。
 *    当 res.on('finish') 同步触发时 req.url 尚未恢复，导致日志中
 *    所有子路由请求都显示为 'GET / ...'，SILENT_PATHS 匹配也失效。
 *    req.originalUrl 始终保持请求的原始 URL，不受路由挂载影响。
 */

import type { NextFunction, Request, Response } from 'express';

/** Minimal logger interface (compatible with winston.Logger) */
interface AppLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// 轮询/心跳路径 — 完全静默
const SILENT_PATHS = [
  '/api/v1/health',
  '/api/health',
  '/api/realtime/events',
  '/api/sse',
  '/api/v1/remote/wait',
  '/socket.io',
];

/**
 * 从 originalUrl 中提取 pathname（去除 query string）
 */
function extractPath(originalUrl: string) {
  const idx = originalUrl.indexOf('?');
  return idx === -1 ? originalUrl : originalUrl.slice(0, idx);
}

export function requestLogger(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    // 在中间件进入时捕获 originalUrl — 此值不会被 Express 路由修改
    const originalPath = extractPath(req.originalUrl);

    res.on('finish', () => {
      const duration = Date.now() - startTime;

      // 完全静默的路径
      if (SILENT_PATHS.some((p) => originalPath.startsWith(p))) {
        return;
      }

      const logData = {
        method: req.method,
        path: originalPath,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
      };

      // 非 GET / 非 2xx / 慢请求 → info; GET + 2xx/304 → debug（304 是缓存命中，与 200 同级）
      const isNoisy =
        req.method === 'GET' &&
        ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 304) &&
        duration < 2000;
      const isSlow = duration >= 1000;
      if (isSlow) {
        logger.warn(`🐌慢请求： ${req.method} ${originalPath} - ${duration}ms`, logData);
      } else if (isNoisy) {
        logger.debug('HTTP', logData);
      } else {
        logger.info('HTTP', logData);
      }
    });

    next();
  };
}
