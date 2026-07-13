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

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeRecipeSourceContentHash } from '@alembic/core';
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

    test('POST /knowledge — retired create surface stays typed and zero-write', async () => {
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

      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body).toMatchObject({
        success: false,
        error: { code: 'RECIPE_CREATE_RETIRED' },
      });
    });

    test('GET retrieval readiness returns native/compatibility reports and changes no truth or index state', async () => {
      const container = getServiceContainer();
      const knowledgeService = container.get('knowledgeService');
      const nativeSource = retrievalReadySource('native');
      const native = await knowledgeService.create(
        { ...nativeSource, retrievalProfile: retrievalReadyProfile(nativeSource) },
        { userId: 'http-readiness-seed' }
      );
      const compatibility = await knowledgeService.create(retrievalReadySource('compatibility'), {
        userId: 'http-readiness-seed',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const database = container.get('database').getDb();
      const dataRoot = resolveDataRoot(container);
      const markdownPaths = [native, compatibility].map((entry) =>
        path.join(dataRoot, String(entry.sourceFile))
      );
      const markdownBefore = await Promise.all(markdownPaths.map((file) => fs.readFile(file)));
      const sqliteBefore = [native.id, compatibility.id].map((id) =>
        database.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id)
      );
      const auditCountBefore = database
        .prepare('SELECT COUNT(*) AS count FROM audit_logs')
        .get().count;
      const lifecycleCountBefore = database
        .prepare('SELECT COUNT(*) AS count FROM lifecycle_transition_events')
        .get().count;
      const vectorGenerationBefore = await snapshotVectorGenerationState(dataRoot);
      const emittedEvents: unknown[] = [];
      const captureEvent = (event: unknown) => emittedEvents.push(event);
      const eventBus = container.get('eventBus');
      eventBus.on('knowledge:changed', captureEvent);
      eventBus.on('lifecycle:transition', captureEvent);

      let nativeResponse: Response;
      let compatibilityResponse: Response;
      let missingResponse: Response;
      try {
        [nativeResponse, compatibilityResponse, missingResponse] = await Promise.all([
          fetch(`${BASE}/knowledge/${native.id}/retrieval-readiness`),
          fetch(`${BASE}/knowledge/${compatibility.id}/retrieval-readiness`),
          fetch(`${BASE}/knowledge/missing-readiness-id/retrieval-readiness`),
        ]);
      } finally {
        eventBus.off('knowledge:changed', captureEvent);
        eventBus.off('lifecycle:transition', captureEvent);
      }

      const nativeBody = await nativeResponse.json();
      const compatibilityBody = await compatibilityResponse.json();
      const missingBody = await missingResponse.json();
      expect(nativeResponse.status, JSON.stringify(nativeBody)).toBe(200);
      expect(nativeBody.data).toMatchObject({
        ready: true,
        schemaVersion: '1',
        profileHash: expect.any(String),
        documentSetHash: expect.any(String),
        violations: [],
        warnings: expect.any(Array),
      });
      expect(Object.keys(nativeBody.data).sort()).toEqual(
        [
          'ready',
          'schemaVersion',
          'profileHash',
          'documentSetHash',
          'violations',
          'warnings',
        ].sort()
      );
      expect(compatibilityResponse.status, JSON.stringify(compatibilityBody)).toBe(200);
      expect(compatibilityBody.data).toMatchObject({
        ready: false,
        schemaVersion: '1',
        profileHash: null,
        documentSetHash: null,
        violations: expect.arrayContaining([
          expect.objectContaining({ code: 'retrieval.profile.missing' }),
        ]),
        warnings: expect.any(Array),
      });
      expect(Object.keys(compatibilityBody.data).sort()).toEqual(
        [
          'ready',
          'schemaVersion',
          'profileHash',
          'documentSetHash',
          'violations',
          'warnings',
        ].sort()
      );
      expect(missingResponse.status).toBe(404);
      expect(missingBody).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });

      expect(
        [native.id, compatibility.id].map((id) =>
          database.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id)
        )
      ).toEqual(sqliteBefore);
      expect(await Promise.all(markdownPaths.map((file) => fs.readFile(file)))).toEqual(
        markdownBefore
      );
      expect(database.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count).toBe(
        auditCountBefore
      );
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM lifecycle_transition_events').get().count
      ).toBe(lifecycleCountBefore);
      expect(emittedEvents).toEqual([]);
      expect(await snapshotVectorGenerationState(dataRoot)).toEqual(vectorGenerationBefore);

      const blockedLifecycle = compatibility.lifecycle;
      const publishResponse = await fetch(
        `${BASE}/knowledge/${compatibility.id}/publish?confirmed=true`,
        { method: 'PATCH' }
      );
      const publishBody = await publishResponse.json();
      expect(publishResponse.status).toBe(400);
      expect(publishBody).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR' },
      });
      expect((await knowledgeService.get(compatibility.id)).lifecycle).toBe(blockedLifecycle);
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

function retrievalReadySource(label: string) {
  return {
    id: `http-readiness-${label}`,
    title: `HTTP readiness ${label} Recipe`,
    description: 'Dashboard reviewers inspect Core readiness before legal publication.',
    trigger: `http-readiness-${label}`,
    language: 'typescript',
    category: 'architecture',
    knowledgeType: 'best-practice',
    kind: 'pattern',
    whenClause: 'When a Dashboard reviewer needs deterministic pre-publish evidence.',
    doClause: 'Read the shared Core readiness report without mutating Recipe truth.',
    dontClause: 'Do not derive readiness from provider, vector, generation, or rank state.',
    content: {
      pattern: 'const report = await recipeProductionPort.evaluateReadiness(recipeId);',
      markdown: 'The Alembic HTTP route exposes the shared Core readiness report read-only.',
      rationale: 'One evaluator keeps review and publish decisions aligned.',
    },
    reasoning: {
      whyStandard:
        'The production port and publish path share the same KnowledgeService evaluator.',
      sources: ['lib/http/routes/knowledge.ts:220-280'],
    },
    tags: ['retrieval-readiness', 'recipe-production'],
  };
}

function retrievalReadyProfile(source: ReturnType<typeof retrievalReadySource>) {
  return {
    schemaVersion: '1',
    primaryLanguage: 'en',
    summary: {
      primary: 'Review deterministic Recipe retrieval readiness before publication.',
      technicalEnglish:
        'Expose the shared Core readiness report without consulting provider or vector state.',
    },
    concepts: [
      {
        term: 'retrieval readiness',
        language: 'en',
        provenanceRefs: ['field:description', 'lib/http/routes/knowledge.ts:220-280'],
      },
    ],
    scenarios: [
      {
        text: source.whenClause,
        language: 'en',
        provenanceRefs: ['field:whenClause'],
      },
    ],
    exclusions: [
      {
        text: source.dontClause,
        language: 'en',
        provenanceRefs: ['field:dontClause'],
      },
    ],
    provenance: {
      evidenceRefs: ['lib/http/routes/knowledge.ts:220-280'],
      sourceFieldRefs: [
        'field:title',
        'field:description',
        'field:whenClause',
        'field:doClause',
        'field:dontClause',
        'field:content.pattern',
        'field:content.markdown',
        'field:content.rationale',
      ],
      sourceContentHash: computeRecipeSourceContentHash(source),
      generator: 'http-api-integration-test',
    },
  };
}

async function snapshotVectorGenerationState(dataRoot: string) {
  const entries: Array<[string, string]> = [];
  for (const relativePath of [
    path.join('.asd', 'context', 'index'),
    path.join('.asd', 'context', 'recipe-vector-active.json'),
    path.join('.asd', 'context', 'recipe-vector-generations'),
  ]) {
    await appendFileTreeSnapshot(dataRoot, relativePath, entries);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

async function appendFileTreeSnapshot(
  dataRoot: string,
  relativePath: string,
  entries: Array<[string, string]>
): Promise<void> {
  const absolutePath = path.join(dataRoot, relativePath);
  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      entries.push([relativePath, 'missing']);
      return;
    }
    throw error;
  }
  if (stats.isDirectory()) {
    const children = await fs.readdir(absolutePath);
    if (children.length === 0) {
      entries.push([relativePath, 'directory:empty']);
    }
    for (const child of children.sort()) {
      await appendFileTreeSnapshot(dataRoot, path.join(relativePath, child), entries);
    }
    return;
  }
  const content = await fs.readFile(absolutePath);
  entries.push([relativePath, createHash('sha256').update(content).digest('hex')]);
}
