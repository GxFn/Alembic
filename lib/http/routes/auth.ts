/**
 * 认证 API 路由
 *
 * 提供简单的用户名/密码登录。凭证通过环境变量配置：
 *   ASD_AUTH_USERNAME (默认 admin)
 *   ASD_AUTH_PASSWORD (默认 autosnippet)
 *
 * 仅在前端 VITE_AUTH_ENABLED=true 时由 Dashboard 调用。
 * 使用 HMAC-SHA256 签发简单 JWT-like token（无第三方依赖）。
 */

import crypto from 'node:crypto';
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════

const AUTH_USERNAME = process.env.ASD_AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.ASD_AUTH_PASSWORD || 'autosnippet';
const TOKEN_SECRET = process.env.ASD_AUTH_SECRET || crypto.randomBytes(32).toString('hex');

// 安全警告：仅在认证启用且使用默认凭据时提示
const authEnabled =
  process.env.VITE_AUTH_ENABLED === 'true' || process.env.ASD_AUTH_ENABLED === 'true';
if (authEnabled && (!process.env.ASD_AUTH_USERNAME || !process.env.ASD_AUTH_PASSWORD)) {
  console.warn(
    '[auth] WARNING: Using default credentials (admin/autosnippet). ' +
      'Set ASD_AUTH_USERNAME and ASD_AUTH_PASSWORD environment variables for production.'
  );
}
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// 将 secret 写回环境变量，供 roleResolver 等模块共享
if (!process.env.ASD_AUTH_SECRET) {
  process.env.ASD_AUTH_SECRET = TOKEN_SECRET;
}

// ═══════════════════════════════════════════════════════
//  Token helpers
// ═══════════════════════════════════════════════════════

function createToken(username) {
  const payload = {
    sub: username,
    role: 'developer',
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payloadB64)
    .digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) {
      return null; // 已过期
    }
    return payload;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════
//  Routes
// ═══════════════════════════════════════════════════════

/**
 * POST /auth/login
 * Body: { username, password }
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '用户名和密码不能为空' },
      });
    }

    // 恒时比较防止时序攻击
    const userOk =
      username.length === AUTH_USERNAME.length &&
      crypto.timingSafeEqual(Buffer.from(username), Buffer.from(AUTH_USERNAME));
    const passOk =
      password.length === AUTH_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(AUTH_PASSWORD));

    if (!userOk || !passOk) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' },
      });
    }

    const token = createToken(username);

    return res.json({
      success: true,
      data: {
        token,
        user: { username, role: 'developer' },
      },
    });
  })
);

/**
 * GET /auth/me
 * Header: Authorization: Bearer <token>
 */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const payload = verifyToken(token);

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Token 无效或已过期' },
      });
    }

    return res.json({
      success: true,
      data: {
        user: { username: payload.sub, role: payload.role },
      },
    });
  })
);

export { verifyToken };
export default router;
