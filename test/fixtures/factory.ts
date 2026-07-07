/**
 * Test Fixture Factory — 测试数据工厂
 *
 * 提供：
 *   - createTestBootstrap()      — 轻量化 Bootstrap（内存 DB、静默日志）
 *   - createTempGitRepo()        — 临时 git 仓库（用于 CapabilityProbe 测试）
 *   - createTestToken() / createExpiredToken() — 签发用于 Auth 测试的 token
 *   - getTestPort()              — 分配隔离的测试端口
 *
 * 历史上还导出过 mockCandidate / mockRecipe / mockGuardRule / mockGatewayRequest /
 * onCleanup / runCleanups，均为零消费方的死 fixture（gateway 请求形状已在
 * FullFlow/GatewayChain 测试内联，candidate/recipe/guard mock 无任何调用方），已清理。
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ═══════════════════════════════════════════════════════
//  Bootstrap Helper
// ═══════════════════════════════════════════════════════

/**
 * 创建测试用 Bootstrap 实例（内存 SQLite、静默日志）
 */
export async function createTestBootstrap() {
  // 动态 import 避免顶层加载问题
  const { AppRuntime } = await import('../../lib/Bootstrap.js');
  const appRuntime = new AppRuntime({ env: 'test' });
  const components = await appRuntime.initialize();
  return { bootstrap: appRuntime, components };
}

// ═══════════════════════════════════════════════════════
//  Temp Git Repo Helpers
// ═══════════════════════════════════════════════════════

/**
 * 在临时目录创建一个 git 仓库
 *
 * @param [options.withRemote=false] — 是否添加 remote
 * @param [options.remoteName='origin'] — remote 名称
 * @param [options.remoteUrl] — remote URL（默认不可 push 的假地址）
 * @param [options.initialCommit=true] — 是否创建初始提交
 * @returns }
 */
export function createTempGitRepo(options = {}) {
  const {
    withRemote = false,
    remoteName = 'origin',
    remoteUrl = 'https://example.com/fake/repo.git',
    initialCommit = true,
  } = options;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-test-git-'));

  const exec = (cmd) => execSync(cmd, { cwd: tmpDir, stdio: 'pipe', encoding: 'utf8' });

  exec('git init');
  exec('git config user.email "test@alembic.dev"');
  exec('git config user.name "Test User"');

  if (initialCommit) {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    exec('git add .');
    exec('git commit -m "initial"');
  }

  if (withRemote) {
    exec(`git remote add ${remoteName} ${remoteUrl}`);
  }

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { repoPath: tmpDir, cleanup };
}

// ═══════════════════════════════════════════════════════
//  Auth Token Helpers
// ═══════════════════════════════════════════════════════

const DEFAULT_TOKEN_SECRET = 'test-secret-key-for-integration-tests';

/**
 * 签发测试用 HMAC-SHA256 token
 *
 * @param payload — { sub, role, ... }
 * @param [secret] — 签名密钥（默认使用固定测试密钥）
 * @returns base64url payload + "." + base64url signature
 */
export function createTestToken(payload = {}, secret = DEFAULT_TOKEN_SECRET) {
  const fullPayload = {
    sub: 'test-user',
    role: 'http-request',
    iat: Date.now(),
    exp: Date.now() + 3600_000, // 1 小时
    ...payload,
  };

  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

/** 创建过期的 token（用于测试 token 过期逻辑） */
export function createExpiredToken(payload = {}, secret = DEFAULT_TOKEN_SECRET) {
  return createTestToken({ exp: Date.now() - 1000, ...payload }, secret);
}

// ═══════════════════════════════════════════════════════
//  Port Allocation
// ═══════════════════════════════════════════════════════

let _portBase =
  3050 + (parseInt(process.env.VITEST_POOL_ID || process.env.JEST_WORKER_ID, 10) || 0) * 100;

/** 获取下一个可用测试端口（避免与其他测试文件冲突） */
export function getTestPort() {
  return _portBase++;
}

export default {
  createTestBootstrap,
  createTempGitRepo,
  createTestToken,
  createExpiredToken,
  getTestPort,
};
