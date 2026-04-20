/**
 * 认证 API 路由
 *
 * 提供简单的用户名/密码登录。凭证通过环境变量配置：
 *   ALEMBIC_AUTH_USERNAME (默认 admin)
 *   ALEMBIC_AUTH_PASSWORD (默认 alembic)
 *
 * 仅在前端 VITE_AUTH_ENABLED=true 时由 Dashboard 调用。
 * 使用 HMAC-SHA256 签发简单 JWT-like token（无第三方依赖）。
 */

import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { AuthLoginBody } from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════

const AUTH_USERNAME = process.env.ALEMBIC_AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.ALEMBIC_AUTH_PASSWORD || 'alembic';
const TOKEN_SECRET = process.env.ALEMBIC_AUTH_SECRET || crypto.randomBytes(32).toString('hex');

// 安全警告：仅在认证启用且使用默认凭据时提示
const authEnabled =
  process.env.VITE_AUTH_ENABLED === 'true' || process.env.ALEMBIC_AUTH_ENABLED === 'true';
if (authEnabled && (!process.env.ALEMBIC_AUTH_USERNAME || !process.env.ALEMBIC_AUTH_PASSWORD)) {
  console.warn(
    '[auth] WARNING: Using default credentials (admin/alembic). ' +
      'Set ALEMBIC_AUTH_USERNAME and ALEMBIC_AUTH_PASSWORD environment variables for production.'
  );
}
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// 将 secret 写回环境变量，供 roleResolver 等模块共享
if (!process.env.ALEMBIC_AUTH_SECRET) {
  process.env.ALEMBIC_AUTH_SECRET = TOKEN_SECRET;
}

// ═══════════════════════════════════════════════════════
//  Token helpers
// ═══════════════════════════════════════════════════════

function createToken(username: string) {
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

function verifyToken(token: string | undefined) {
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
router.post('/login', validate(AuthLoginBody), async (req: Request, res: Response) => {
  const { username, password } = req.body;

  // 恒时比较防止时序攻击
  const userOk =
    username.length === AUTH_USERNAME.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(AUTH_USERNAME));
  const passOk =
    password.length === AUTH_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(AUTH_PASSWORD));

  if (!userOk || !passOk) {
    return void res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' },
    });
  }

  const token = createToken(username);

  return void res.json({
    success: true,
    data: {
      token,
      user: { username, role: 'developer' },
    },
  });
});

/**
 * GET /auth/me
 * Header: Authorization: Bearer <token>
 */
router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = verifyToken(token);

  if (!payload) {
    return void res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Token 无效或已过期' },
    });
  }

  return void res.json({
    success: true,
    data: {
      user: { username: payload.sub, role: payload.role },
    },
  });
});

export { verifyToken };
export default router;
