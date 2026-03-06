/**
 * 健康检查端点
 */

import express from 'express';

const router = express.Router();

/**
 * GET /api/v1/health
 * 服务器健康检查
 */
router.get('/', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: Math.floor(Date.now() / 1000),
    uptime: process.uptime(),
    version: '2.0.0',
  });
});

/**
 * GET /api/v1/health/ready
 * 就绪检查
 */
router.get('/ready', (req, res) => {
  res.json({
    success: true,
    ready: true,
    timestamp: Math.floor(Date.now() / 1000),
  });
});

export default router;
