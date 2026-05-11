/** 健康检查端点 */

import express from 'express';
import { getDeveloperIdentity } from '../../shared/developer-identity.js';

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

/**
 * GET /api/v1/health/identity
 * 当前开发者身份（从 git config / 环境变量解析）
 */
router.get('/identity', (_req, res) => {
  res.json({
    success: true,
    developer: getDeveloperIdentity(),
  });
});

export default router;
