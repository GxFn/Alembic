/**
 * 监控 API 路由
 * 提供性能指标、错误统计和缓存状态的查询接口
 */

import Logger from '@alembic/core/logging';
import express from 'express';
import { z } from 'zod';
import { getCacheAdapter } from '../../infrastructure/cache/UnifiedCacheAdapter.js';
import { getErrorTracker } from '../../infrastructure/monitoring/ErrorTracker.js';
import { getPerformanceMonitor } from '../../infrastructure/monitoring/PerformanceMonitor.js';
import { getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { validate, validateQuery } from '../middleware/validate.js';

const router = express.Router();

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalNonEmptyString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());

const MonitoringErrorsSearchQuery = z.object({
  endDate: optionalNonEmptyString,
  limit: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(100)),
  route: optionalNonEmptyString,
  severity: optionalNonEmptyString,
  startDate: optionalNonEmptyString,
  type: optionalNonEmptyString,
});

const EmptyWriteBody = z.object({}).passthrough();

/**
 * GET /api/v1/monitoring/health
 * 系统健康检查
 */
// AO1 route-input-exempt: health read uses no body/query/params and preserves ignored query strings.
router.get('/health', async (req, res) => {
  try {
    const cacheAdapter = getCacheAdapter();
    const cacheHealth = await cacheAdapter.healthCheck();

    let realtimeHealth: Record<string, unknown> = { healthy: false, message: 'WebSocket 未启用' };
    try {
      const realtimeService = getRealtimeService();
      const clientCount = realtimeService.getConnectedClients();
      realtimeHealth = {
        healthy: true,
        connectedClients: clientCount,
        message: `${clientCount} 个客户端已连接`,
      };
    } catch (_error: unknown) {
      // WebSocket 服务未初始化
    }

    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          unit: 'MB',
        },
        cache: cacheHealth,
        realtime: realtimeHealth,
      },
    });
  } catch (error: unknown) {
    Logger.error('健康检查失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/monitoring/performance
 * 性能统计
 */
// AO1 route-input-exempt: performance read uses no body/query/params.
router.get('/performance', (req, res) => {
  try {
    const performanceMonitor = getPerformanceMonitor();
    const stats = performanceMonitor.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: unknown) {
    Logger.error('获取性能统计失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/monitoring/errors
 * 错误统计
 */
// AO1 route-input-exempt: errors summary read uses no body/query/params.
router.get('/errors', (req, res) => {
  try {
    const errorTracker = getErrorTracker();
    const stats = errorTracker.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: unknown) {
    Logger.error('获取错误统计失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/monitoring/errors/search
 * 搜索错误
 */
router.get('/errors/search', validateQuery(MonitoringErrorsSearchQuery), (req, res) => {
  try {
    const errorTracker = getErrorTracker();
    const query = req.query as unknown as z.infer<typeof MonitoringErrorsSearchQuery>;

    const results = errorTracker.searchErrors({
      type: query.type,
      route: query.route,
      severity: query.severity,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: query.limit,
    });

    res.json({
      success: true,
      data: {
        total: results.length,
        errors: results,
      },
    });
  } catch (error: unknown) {
    Logger.error('搜索错误失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/monitoring/cache
 * 缓存统计
 */
// AO1 route-input-exempt: cache read uses no body/query/params.
router.get('/cache', (req, res) => {
  try {
    const cacheAdapter = getCacheAdapter();
    const stats = cacheAdapter.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: unknown) {
    Logger.error('获取缓存统计失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * POST /api/v1/monitoring/cache/clear
 * 清空缓存（仅限 developer）
 */
router.post('/cache/clear', validate(EmptyWriteBody), async (req, res) => {
  // 角色检查：仅 admin 可操作
  const role = req.resolvedRole || 'visitor';
  if (role !== 'developer') {
    res.status(403).json({
      success: false,
      error: { message: '仅管理员可清空缓存' },
    });
    return;
  }

  try {
    const cacheAdapter = getCacheAdapter();
    await cacheAdapter.clear();

    Logger.info('缓存已通过 API 清空');

    res.json({
      success: true,
      data: { message: '缓存已清空' },
    });
  } catch (error: unknown) {
    Logger.error('清空缓存失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * GET /api/v1/monitoring/realtime
 * 实时连接统计
 */
// AO1 route-input-exempt: realtime read uses no body/query/params.
router.get('/realtime', (req, res) => {
  try {
    const realtimeService = getRealtimeService();
    const clientCount = realtimeService.getConnectedClients();

    res.json({
      success: true,
      data: {
        connectedClients: clientCount,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (_error: unknown) {
    // WebSocket 未启用
    res.json({
      success: true,
      data: {
        connectedClients: 0,
        enabled: false,
        message: 'WebSocket 服务未启用',
      },
    });
  }
});

/**
 * GET /api/v1/monitoring/dashboard
 * 综合监控仪表盘数据
 */
// AO1 route-input-exempt: dashboard read uses no body/query/params.
router.get('/dashboard', async (req, res) => {
  try {
    const performanceMonitor = getPerformanceMonitor();
    const errorTracker = getErrorTracker();
    const cacheAdapter = getCacheAdapter();

    const performanceStats = performanceMonitor.getStats();
    const errorStats = errorTracker.getStats();
    const cacheStats = cacheAdapter.getStats();
    const cacheHealth = await cacheAdapter.healthCheck();

    let realtimeStats = { enabled: false, connectedClients: 0 };
    try {
      const realtimeService = getRealtimeService();
      realtimeStats = {
        enabled: true,
        connectedClients: realtimeService.getConnectedClients(),
      };
    } catch (_error: unknown) {
      // WebSocket 未初始化
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        system: {
          uptime: Math.round(process.uptime()),
          memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            percentage: (
              (process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) *
              100
            ).toFixed(2),
            unit: 'MB',
          },
          cpu: {
            usage: process.cpuUsage(),
          },
        },
        performance: performanceStats.summary,
        errors: errorStats.summary,
        cache: {
          ...cacheStats,
          health: cacheHealth,
        },
        realtime: realtimeStats,
      },
    });
  } catch (error: unknown) {
    Logger.error('获取监控仪表盘数据失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

/**
 * POST /api/v1/monitoring/reset
 * 重置监控统计（仅限开发环境 + developer）
 */
router.post('/reset', validate(EmptyWriteBody), (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: { message: '生产环境不允许重置监控统计' },
    });
    return;
  }

  // 角色检查：仅 admin 可操作
  const role = req.resolvedRole || 'visitor';
  if (role !== 'developer') {
    res.status(403).json({
      success: false,
      error: { message: '仅管理员可重置监控统计' },
    });
    return;
  }

  try {
    const performanceMonitor = getPerformanceMonitor();
    const errorTracker = getErrorTracker();

    performanceMonitor.reset();
    errorTracker.clearErrors();

    Logger.info('监控统计已重置');

    res.json({
      success: true,
      data: { message: '监控统计已重置' },
    });
  } catch (error: unknown) {
    Logger.error('重置监控统计失败', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: { message: (error as Error).message },
    });
  }
});

export default router;
