/**
 * 监控 API 路由
 * 提供性能指标、错误统计和缓存状态的查询接口
 */

import express from 'express';
import { getCacheAdapter } from '../../infrastructure/cache/UnifiedCacheAdapter.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getErrorTracker } from '../../infrastructure/monitoring/ErrorTracker.js';
import { getPerformanceMonitor } from '../../infrastructure/monitoring/PerformanceMonitor.js';
import { getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';

const router = express.Router();

/**
 * GET /api/v1/monitoring/health
 * 系统健康检查
 */
router.get('/health', async (req, res) => {
  try {
    const cacheAdapter = getCacheAdapter();
    const cacheHealth = await cacheAdapter.healthCheck();

    let realtimeHealth = { healthy: false, message: 'WebSocket 未启用' };
    try {
      const realtimeService = getRealtimeService();
      const clientCount = realtimeService.getConnectedClients();
      realtimeHealth = {
        healthy: true,
        // @ts-expect-error TS migration: TS2353
        connectedClients: clientCount,
        message: `${clientCount} 个客户端已连接`,
      };
    } catch (_error: any) {
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
  } catch (error: any) {
    Logger.error('健康检查失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * GET /api/v1/monitoring/performance
 * 性能统计
 */
router.get('/performance', (req, res) => {
  try {
    const performanceMonitor = getPerformanceMonitor();
    const stats = performanceMonitor.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    Logger.error('获取性能统计失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * GET /api/v1/monitoring/errors
 * 错误统计
 */
router.get('/errors', (req, res) => {
  try {
    const errorTracker = getErrorTracker();
    const stats = errorTracker.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    Logger.error('获取错误统计失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * GET /api/v1/monitoring/errors/search
 * 搜索错误
 */
router.get('/errors/search', (req, res) => {
  try {
    const errorTracker = getErrorTracker();
    const { type, route, severity, startDate, endDate, limit } = req.query;

    const results = errorTracker.searchErrors({
      type,
      route,
      severity,
      startDate,
      endDate,
      // @ts-expect-error TS migration: TS2345
      limit: limit ? parseInt(limit) : 100,
    });

    res.json({
      success: true,
      data: {
        total: results.length,
        errors: results,
      },
    });
  } catch (error: any) {
    Logger.error('搜索错误失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * GET /api/v1/monitoring/cache
 * 缓存统计
 */
router.get('/cache', (req, res) => {
  try {
    const cacheAdapter = getCacheAdapter();
    const stats = cacheAdapter.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    Logger.error('获取缓存统计失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * POST /api/v1/monitoring/cache/clear
 * 清空缓存（仅限 developer）
 */
router.post('/cache/clear', async (req, res) => {
  // 角色检查：仅 admin 可操作
  // @ts-expect-error TS migration: TS2339
  const role = req.resolvedRole || 'visitor';
  if (role !== 'developer') {
    return res.status(403).json({
      success: false,
      error: { message: '仅管理员可清空缓存' },
    });
  }

  try {
    const cacheAdapter = getCacheAdapter();
    await cacheAdapter.clear();

    Logger.info('缓存已通过 API 清空');

    res.json({
      success: true,
      data: { message: '缓存已清空' },
    });
  } catch (error: any) {
    Logger.error('清空缓存失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * GET /api/v1/monitoring/realtime
 * 实时连接统计
 */
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
  } catch (_error: any) {
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
    } catch (_error: any) {
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
  } catch (error: any) {
    Logger.error('获取监控仪表盘数据失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

/**
 * POST /api/v1/monitoring/reset
 * 重置监控统计（仅限开发环境 + developer）
 */
router.post('/reset', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error: { message: '生产环境不允许重置监控统计' },
    });
  }

  // 角色检查：仅 admin 可操作
  // @ts-expect-error TS migration: TS2339
  const role = req.resolvedRole || 'visitor';
  if (role !== 'developer') {
    return res.status(403).json({
      success: false,
      error: { message: '仅管理员可重置监控统计' },
    });
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
  } catch (error: any) {
    Logger.error('重置监控统计失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: { message: error.message },
    });
  }
});

export default router;
