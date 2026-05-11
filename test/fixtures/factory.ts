/**
 * Test Fixture Factory — 自动生成测试数据
 *
 * 提供：
 *   - createTestBootstrap()      — 轻量化 Bootstrap（内存 DB、静默日志）
 *   - createTempGitRepo()        — 临时 git 仓库（用于 CapabilityProbe 测试）
 *   - mockCandidate / mockRecipe — 填充完整的实体数据
 *   - createTestToken()          — 签发用于 Auth 测试的 token
 */

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = import.meta.dirname;
const _PROJECT_ROOT = path.resolve(__dirname, '../..');

// ═══════════════════════════════════════════════════════
//  Bootstrap Helper
// ═══════════════════════════════════════════════════════

/**
 * 创建测试用 Bootstrap 实例（内存 SQLite、静默日志）
 * @returns >}
 */
export async function createTestBootstrap() {
  // 动态 import 避免顶层加载问题
  const { Bootstrap } = await import('../../lib/bootstrap.js');
  const bootstrap = new Bootstrap({ env: 'test' });
  const components = await bootstrap.initialize();
  return { bootstrap, components };
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
//  Mock Entity Factories
// ═══════════════════════════════════════════════════════

let _counter = 0;
function uid() {
  return `test-${Date.now()}-${++_counter}`;
}

/** 生成完整的 Candidate 数据 */
export function mockCandidate(overrides = {}) {
  return {
    id: uid(),
    title: 'Test Candidate',
    code: 'function testHelper() { return true; }',
    language: 'javascript',
    category: 'utility',
    status: 'pending',
    source: { type: 'manual', actor: 'developer' },
    metadata: {
      capturedAt: new Date().toISOString(),
      context: 'test',
    },
    reasoning: {
      whyStandard: 'Commonly used utility pattern',
      sources: ['code-review', 'best-practices'],
      qualitySignals: { clarity: 0.9, reusability: 0.85 },
      alternatives: ['inline approach'],
      confidence: 0.88,
    },
    ...overrides,
  };
}

/** 生成完整的 Recipe 数据 */
export function mockRecipe(overrides = {}) {
  return {
    id: uid(),
    name: 'Test Recipe',
    description: 'A test recipe for integration testing',
    kind: 'pattern',
    language: 'javascript',
    category: 'utility',
    status: 'draft',
    content: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template pattern syntax
      pattern: 'function ${name}() { ${body} }',
      variables: ['name', 'body'],
    },
    tags: ['test', 'utility'],
    metadata: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

/** 生成完整的 GuardRule 数据 */
export function mockGuardRule(overrides = {}) {
  return {
    id: uid(),
    name: 'Test Guard Rule',
    description: 'Test rule for integration tests',
    type: 'forbidden-pattern',
    severity: 'warning',
    enabled: true,
    pattern: 'eval\\(',
    language: 'javascript',
    metadata: {
      createdAt: new Date().toISOString(),
      author: 'test',
    },
    ...overrides,
  };
}

/** 生成带 reasoning 的完整 Gateway 请求数据 */
export function mockGatewayRequest(overrides = {}) {
  return {
    actor: 'developer',
    action: 'test_action',
    resource: '/test',
    data: {
      code: 'function example() {}',
      reasoning: {
        whyStandard: 'Test reasoning',
        sources: ['test'],
        qualitySignals: { clarity: 0.9 },
        alternatives: [],
        confidence: 0.85,
      },
      ...overrides.data,
    },
    ...overrides,
  };
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
    role: 'developer',
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

// ═══════════════════════════════════════════════════════
//  Cleanup Helpers
// ═══════════════════════════════════════════════════════

const _cleanups = [];

/** 注册清理回调（测试 afterAll 中调用 runCleanups） */
export function onCleanup(fn) {
  _cleanups.push(fn);
}

/** 执行所有注册的清理回调 */
export async function runCleanups() {
  while (_cleanups.length) {
    const fn = _cleanups.pop();
    try {
      await fn();
    } catch {
      /* ignore */
    }
  }
}

export default {
  createTestBootstrap,
  createTempGitRepo,
  mockCandidate,
  mockRecipe,
  mockGuardRule,
  mockGatewayRequest,
  createTestToken,
  createExpiredToken,
  getTestPort,
  onCleanup,
  runCleanups,
};
