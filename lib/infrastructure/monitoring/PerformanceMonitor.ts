/**
 * 性能监控中间件
 * 记录 API 请求的响应时间、吞吐量和错误率
 */

import Logger from '../logging/Logger.js';

interface EndpointStats {
  count: number;
  errors: number;
  totalDuration: number;
  minDuration: number;
  maxDuration: number;
  avgDuration: number;
}

interface RequestData {
  route: string;
  method: string;
  path: string;
  statusCode: number;
  duration: number;
  userAgent?: string;
  ip?: string;
  timestamp: string;
}

export class PerformanceMonitor {
  config: { slowRequestThreshold: number; maxResponseTimeSamples: number; maxSlowRequests: number };
  metrics: {
    requests: { total: number; success: number; errors: number };
    endpoints: Map<string, EndpointStats>;
    responseTimes: number[];
    slowRequests: RequestData[];
    errorRate: number | string;
    averageResponseTime: number;
    startTime: number;
    rpm?: number;
    p95?: number;
    p99?: number;
  };
  statsInterval: ReturnType<typeof setInterval>;
  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        errors: 0,
      },
      endpoints: new Map(), // 各端点统计
      responseTimes: [], // 最近 1000 个请求的响应时间
      slowRequests: [], // 慢请求队列（> 1s）
      errorRate: 0,
      averageResponseTime: 0,
      startTime: Date.now(),
    };

    this.config = {
      slowRequestThreshold: 1000, // 慢请求阈值（毫秒）
      maxResponseTimeSamples: 1000, // 保留样本数
      maxSlowRequests: 100, // 最多保留慢请求数
    };

    // 定期计算统计数据（unref 避免阻止进程退出）
    this.statsInterval = setInterval(() => this.calculateStats(), 30000);
    if (this.statsInterval.unref) {
      this.statsInterval.unref();
    }
  }

  /**
   * Express 中间件
   */
  middleware() {
    return (
      req: {
        method: string;
        path: string;
        get: (header: string) => string | undefined;
        ip?: string;
      },
      res: { on: (event: string, cb: () => void) => void; statusCode: number },
      next: () => void
    ) => {
      const startTime = Date.now();
      const route = `${req.method} ${req.path}`;

      // 响应完成时记录
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        this.recordRequest({
          route,
          method: req.method,
          path: req.path,
          statusCode,
          duration,
          userAgent: req.get('user-agent'),
          ip: req.ip,
          timestamp: new Date().toISOString(),
        });
      });

      next();
    };
  }

  /**
   * 记录请求
   */
  recordRequest(requestData: RequestData) {
    const { route, statusCode, duration } = requestData;

    // 总体统计
    this.metrics.requests.total++;
    if (statusCode >= 200 && statusCode < 400) {
      this.metrics.requests.success++;
    } else if (statusCode >= 400) {
      this.metrics.requests.errors++;
    }

    // 端点统计（限制 Map 上限避免内存泄漏）
    if (!this.metrics.endpoints.has(route)) {
      if (this.metrics.endpoints.size >= 500) {
        // 淘汰最少访问的端点
        let minKey: string | null = null,
          minCount = Infinity;
        for (const [k, v] of this.metrics.endpoints) {
          if (v.count < minCount) {
            minCount = v.count;
            minKey = k;
          }
        }
        if (minKey) {
          this.metrics.endpoints.delete(minKey);
        }
      }
      this.metrics.endpoints.set(route, {
        count: 0,
        errors: 0,
        totalDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
        avgDuration: 0,
      });
    }

    const endpointStats = this.metrics.endpoints.get(route)!;
    endpointStats.count++;
    endpointStats.totalDuration += duration;
    endpointStats.minDuration = Math.min(endpointStats.minDuration, duration);
    endpointStats.maxDuration = Math.max(endpointStats.maxDuration, duration);
    endpointStats.avgDuration = endpointStats.totalDuration / endpointStats.count;

    if (statusCode >= 400) {
      endpointStats.errors++;
    }

    // 响应时间样本
    this.metrics.responseTimes.push(duration);
    if (this.metrics.responseTimes.length > this.config.maxResponseTimeSamples) {
      this.metrics.responseTimes.shift();
    }

    // 慢请求记录（排除设计上就是长耗时的 long-poll 端点）
    const isLongPoll = route.includes('/remote/wait');
    if (duration > this.config.slowRequestThreshold && !isLongPoll) {
      this.metrics.slowRequests.push({
        ...requestData,
        duration,
      });

      if (this.metrics.slowRequests.length > this.config.maxSlowRequests) {
        this.metrics.slowRequests.shift();
      }

      Logger.warn(`🐢 慢请求: ${route} - ${duration}ms`);
    }
  }

  /**
   * 计算统计数据
   */
  calculateStats() {
    const { total, errors } = this.metrics.requests;

    // 错误率
    this.metrics.errorRate = total > 0 ? ((errors / total) * 100).toFixed(2) : 0;

    // 平均响应时间
    if (this.metrics.responseTimes.length > 0) {
      const sum = this.metrics.responseTimes.reduce((acc, val) => acc + val, 0);
      this.metrics.averageResponseTime = Math.round(sum / this.metrics.responseTimes.length);
    }

    // 每分钟请求数 (RPM)
    const uptime = (Date.now() - this.metrics.startTime) / 1000 / 60; // 分钟
    this.metrics.rpm = uptime > 0 ? Math.round(total / uptime) : 0;

    // P95, P99 响应时间
    if (this.metrics.responseTimes.length > 0) {
      const sorted = [...this.metrics.responseTimes].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      const p99Index = Math.floor(sorted.length * 0.99);

      this.metrics.p95 = sorted[p95Index] || 0;
      this.metrics.p99 = sorted[p99Index] || 0;
    }

    Logger.info('📊 性能统计已更新', {
      requests: total,
      errors,
      errorRate: `${this.metrics.errorRate}%`,
      avgResponseTime: `${this.metrics.averageResponseTime}ms`,
      rpm: this.metrics.rpm,
    });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    this.calculateStats(); // 实时计算

    const topEndpoints = Array.from(this.metrics.endpoints.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([route, stats]) => ({
        route,
        ...stats,
        avgDuration: Math.round(stats.avgDuration),
      }));

    const slowestEndpoints = Array.from(this.metrics.endpoints.entries())
      .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
      .slice(0, 10)
      .map(([route, stats]) => ({
        route,
        avgDuration: Math.round(stats.avgDuration),
        count: stats.count,
      }));

    return {
      summary: {
        totalRequests: this.metrics.requests.total,
        successfulRequests: this.metrics.requests.success,
        failedRequests: this.metrics.requests.errors,
        errorRate: `${this.metrics.errorRate}%`,
        averageResponseTime: `${this.metrics.averageResponseTime}ms`,
        requestsPerMinute: this.metrics.rpm,
        p95ResponseTime: `${this.metrics.p95 || 0}ms`,
        p99ResponseTime: `${this.metrics.p99 || 0}ms`,
        uptime: Math.round((Date.now() - this.metrics.startTime) / 1000), // 秒
      },
      topEndpoints,
      slowestEndpoints,
      recentSlowRequests: this.metrics.slowRequests.slice(-10).map((req) => ({
        route: req.route,
        duration: `${req.duration}ms`,
        timestamp: req.timestamp,
        statusCode: req.statusCode,
      })),
    };
  }

  /**
   * 重置统计
   */
  reset() {
    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        errors: 0,
      },
      endpoints: new Map(),
      responseTimes: [],
      slowRequests: [],
      errorRate: 0,
      averageResponseTime: 0,
      startTime: Date.now(),
    };
    Logger.info('性能监控统计已重置');
  }

  /**
   * 停止监控
   */
  shutdown() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    Logger.info('性能监控已停止');
  }
}

// 单例实例
let performanceMonitorInstance: PerformanceMonitor | null = null;

/**
 * 初始化性能监控
 */
export function initPerformanceMonitor() {
  if (performanceMonitorInstance) {
    return performanceMonitorInstance;
  }

  performanceMonitorInstance = new PerformanceMonitor();
  Logger.info('✅ 性能监控已启用');
  return performanceMonitorInstance;
}

/**
 * 获取性能监控实例
 */
export function getPerformanceMonitor() {
  if (!performanceMonitorInstance) {
    throw new Error('性能监控未初始化，请先调用 initPerformanceMonitor()');
  }
  return performanceMonitorInstance;
}

export default PerformanceMonitor;
