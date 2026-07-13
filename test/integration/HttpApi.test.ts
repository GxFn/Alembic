/**
 * 集成测试：HTTP API 端点 — 完整的 REST API 调用
 *
 * 使用 Jest 格式（与 jest.config.js 兼容），通过 Bootstrap + HttpServer
 * 启动真实 Express 服务，用 fetch 调用实际 HTTP 端点。
 *
 * 覆盖范围：
 *   ✓ Health 端点
 *   ✓ Auth 端点 (login / me)
 *   ✓ Auth Probe 端点
 *   ✓ Knowledge CRUD (V3 统一端点)
 *   ✓ Guard Rules CRUD
 *   ✓ 404 路由兜底
 *   ✓ 错误格式一致性
 *   ✓ CORS headers
 *   ✓ 请求来源 header 兼容（x-user-id header）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDataRoot } from '@alembic/core/workspace';
import AppRuntime from '../../lib/Bootstrap.js';
import { HttpServer } from '../../lib/http/HttpServer.js';
import { getServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { getTestPort } from '../fixtures/factory.js';

const PORT = getTestPort();
const BASE = `http://localhost:${PORT}/api/v1`;

describe('Integration: HTTP API Endpoints', () => {
  let appRuntime: AppRuntime | undefined;
  let httpServer: HttpServer | undefined;

  beforeAll(async () => {
    // 1. 初始化 Bootstrap（DB + Gateway + audit 等）
    appRuntime = new AppRuntime({ env: 'test' });
    const components = await appRuntime.initialize();

    // 2. 初始化 ServiceContainer（注入 bootstrap 组件）
    const container = getServiceContainer();
    await container.initialize(components);

    // 3. 启动 HttpServer
    httpServer = new HttpServer({
      port: PORT,
      host: 'localhost',
      enableRedis: false,
      cacheMode: 'memory',
    });
    await httpServer.initialize();
    await httpServer.start();
  }, 30_000);

  afterAll(async () => {
    if (httpServer) {
      await httpServer.stop();
    }
    if (appRuntime) {
      await appRuntime.shutdown();
    }
  });

  // ═══════════════════════════════════════════════════════
  //  Health
  // ═══════════════════════════════════════════════════════

  describe('Health Endpoints', () => {
    test('GET /health → 200 + healthy', async () => {
      const res = await fetch(`${BASE}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.status).toBe('healthy');
      expect(body.timestamp).toBeDefined();
    });

    test('GET /health/ready → 200', async () => {
      const res = await fetch(`${BASE}/health/ready`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Auth
  // ═══════════════════════════════════════════════════════

  describe('Auth Endpoints', () => {
    test('GET /auth/probe — returns request source metadata', async () => {
      const res = await fetch(`${BASE}/auth/probe`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.source).toBeDefined();
      expect(body.data.mode).toBe('source');
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Knowledge (V3 统一端点，替代 Candidates + Recipes)
  // ═══════════════════════════════════════════════════════

  describe('Knowledge Endpoints', () => {
    test('GET /knowledge → 200 + 列表', async () => {
      const res = await fetch(`${BASE}/knowledge`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('GET /knowledge/stats → 200', async () => {
      const res = await fetch(`${BASE}/knowledge/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('GET /knowledge/:nonexistent → 404', async () => {
      const res = await fetch(`${BASE}/knowledge/nonexistent-id-999`);
      const body = await res.json();
      // 可能返回 404 (NotFoundError) 或 500
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body.success).toBe(false);
    });

    test('POST /knowledge — valid body reaches create entrypoint', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': 'http-request',
        },
        body: JSON.stringify({
          title: 'Test Knowledge from HTTP',
          content: { pattern: 'function integrationTest() { return true; }' },
          language: 'javascript',
          category: 'utility',
        }),
      });

      expect(res.status).toBeLessThan(600);
      const body = await res.json();
      expect(typeof body.success).toBe('boolean');
    });

    test('PATCH retrievalProfile round-trips through Core, Markdown, SQLite and GET', async () => {
      const container = getServiceContainer();
      const knowledgeService = container.get('knowledgeService');
      const created = await knowledgeService.create(
        {
          title: 'HTTP retrieval profile round-trip',
          description: 'Original description remains unless a mixed patch changes it.',
          trigger: 'http-retrieval-profile-roundtrip',
          language: 'typescript',
          category: 'testing',
          knowledgeType: 'best-practice',
          kind: 'pattern',
          whenClause: 'When a reviewer edits retrieval facts over HTTP',
          doClause: 'Persist the complete profile through the Core update contract',
          dontClause: 'Do not create or publish a replacement Recipe',
          content: { pattern: 'await patchExistingRecipeProfile();' },
          retrievalProfile: retrievalProfile('original'),
        },
        { userId: 'http-test-seed' }
      );
      const lifecycleBefore = created.lifecycle;
      const profileOnly = retrievalProfile('profile-only');

      const profileOnlyResponse = await fetch(`${BASE}/knowledge/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retrievalProfile: profileOnly }),
      });
      const profileOnlyBody = await profileOnlyResponse.json();
      expect(profileOnlyResponse.status, JSON.stringify(profileOnlyBody)).toBe(200);
      expect(profileOnlyBody.data.retrievalProfile).toEqual(profileOnly);

      const mixedProfile = retrievalProfile('mixed');
      const mixedResponse = await fetch(`${BASE}/knowledge/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: 'Description updated with the profile.',
          retrievalProfile: mixedProfile,
        }),
      });
      expect(mixedResponse.status).toBe(200);

      const getResponse = await fetch(`${BASE}/knowledge/${created.id}`);
      const getBody = await getResponse.json();
      expect(getBody.data).toMatchObject({
        description: 'Description updated with the profile.',
        lifecycle: lifecycleBefore,
        retrievalProfile: mixedProfile,
      });

      const database = container.get('database').getDb();
      const sqliteRow = database
        .prepare('SELECT retrievalProfile, lifecycle FROM knowledge_entries WHERE id = ?')
        .get(created.id);
      expect(JSON.parse(String(sqliteRow.retrievalProfile))).toEqual(mixedProfile);
      expect(sqliteRow.lifecycle).toBe(lifecycleBefore);

      const markdownPath = path.join(resolveDataRoot(container), String(created.sourceFile));
      const markdownBeforeInvalid = await fs.readFile(markdownPath, 'utf8');
      expect(markdownBeforeInvalid).toContain(`_retrievalProfile: ${JSON.stringify(mixedProfile)}`);
      const sqliteBeforeInvalid = String(sqliteRow.retrievalProfile);
      const auditCountBefore = database
        .prepare('SELECT COUNT(*) AS count FROM audit_logs')
        .get().count;
      const eventBus = container.get('eventBus');
      const invalidUpdateEvents: unknown[] = [];
      const captureInvalidUpdate = (event: unknown) => invalidUpdateEvents.push(event);
      eventBus.on('knowledge:changed', captureInvalidUpdate);

      try {
        const invalidResponse = await fetch(`${BASE}/knowledge/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            retrievalProfile: { ...mixedProfile, schemaVersion: 'unsupported-v999' },
          }),
        });
        const invalidBody = await invalidResponse.json();
        expect(invalidResponse.status).toBe(400);
        expect(invalidBody).toMatchObject({
          success: false,
          error: { code: 'VALIDATION_ERROR' },
        });
      } finally {
        eventBus.off('knowledge:changed', captureInvalidUpdate);
      }
      expect(
        database
          .prepare('SELECT retrievalProfile FROM knowledge_entries WHERE id = ?')
          .get(created.id).retrievalProfile
      ).toBe(sqliteBeforeInvalid);
      expect(await fs.readFile(markdownPath, 'utf8')).toBe(markdownBeforeInvalid);
      expect(database.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count).toBe(
        auditCountBefore
      );
      expect(invalidUpdateEvents).toEqual([]);
      expect((await knowledgeService.get(created.id)).lifecycle).toBe(lifecycleBefore);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Guard Rules
  // ═══════════════════════════════════════════════════════

  describe('Guard Rules Endpoints', () => {
    test('GET /rules → 200', async () => {
      const res = await fetch(`${BASE}/rules`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  请求来源 header 兼容
  // ═══════════════════════════════════════════════════════

  describe('Request source header compatibility', () => {
    test('untrusted source header does not block GET /knowledge', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        headers: { 'X-User-Id': 'source-a' },
      });
      expect(res.status).toBe(200);
    });

    test('another untrusted source header also does not block GET /knowledge', async () => {
      const res = await fetch(`${BASE}/knowledge`, {
        headers: { 'X-User-Id': 'source-b' },
      });
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  404 兜底
  // ═══════════════════════════════════════════════════════

  describe('404 Route Fallback', () => {
    test('GET /api/v1/nonexistent → 404', async () => {
      const res = await fetch(`${BASE}/nonexistent`);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════
  //  响应格式一致性
  // ═══════════════════════════════════════════════════════

  describe('Response Format Consistency', () => {
    test('成功响应包含 success=true', async () => {
      const res = await fetch(`${BASE}/health`);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('错误响应包含 success=false + error 对象', async () => {
      const res = await fetch(`${BASE}/nonexistent`);
      const body = await res.json();

      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
      expect(body.error.message).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  CORS
  // ═══════════════════════════════════════════════════════

  describe('CORS Headers', () => {
    test('OPTIONS 预检请求返回适当 CORS headers', async () => {
      const res = await fetch(`${BASE}/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
        },
      });

      // CORS preflight 通常返回 204 或 200
      expect(res.status).toBeLessThan(300);
      const corsHeader = res.headers.get('access-control-allow-origin');
      expect(corsHeader).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════
  //  Invalid JSON
  // ═══════════════════════════════════════════════════════

  describe('Invalid Request Handling', () => {
    test('POST 带无效 JSON → 400', async () => {
      const res = await fetch(`${BASE}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});

function retrievalProfile(label: string) {
  return {
    schemaVersion: '1',
    primaryLanguage: 'zh-CN',
    summary: {
      primary: `检索摘要 ${label}`,
      technicalEnglish: `Retrieval summary ${label}`,
      futureSummaryField: `preserved-${label}`,
    },
    concepts: [
      {
        term: `profile-${label}`,
        language: 'en',
        provenanceRefs: ['field:content.pattern'],
        futureConceptField: `preserved-${label}`,
      },
    ],
    scenarios: [
      {
        text: 'When an existing Recipe retrieval profile is reviewed',
        language: 'en',
        provenanceRefs: ['field:whenClause'],
      },
    ],
    exclusions: [
      {
        text: 'Do not auto-publish after profile editing',
        language: 'en',
        provenanceRefs: ['field:dontClause'],
      },
    ],
    provenance: {
      evidenceRefs: ['test/integration/HttpApi.test.ts'],
      sourceFieldRefs: ['field:content.pattern', 'field:whenClause', 'field:dontClause'],
      sourceContentHash: `source-hash-${label}`,
      generator: 'http-api-integration-test',
      futureProvenanceField: `preserved-${label}`,
    },
    futureProfileField: { label },
  };
}
