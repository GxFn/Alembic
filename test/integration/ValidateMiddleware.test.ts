/**
 * 集成测试：validate 中间件 — Express Zod 请求校验
 *
 * 覆盖范围:
 *   - validate(schema) — body 校验
 *   - validateQuery(schema) — query 校验
 *   - validateParams(schema) — params 校验
 *   - 校验通过：body/query/params 被替换为 parsed 数据（含 defaults）
 *   - 校验失败：400 + VALIDATION_ERROR 结构
 */

import { z } from 'zod';
import { validate, validateParams, validateQuery } from '../../lib/http/middleware/validate.js';

// Mock Express request/response/next
function mockReq(overrides: Partial<{ body: unknown; query: unknown; params: unknown }> = {}) {
  return {
    body: overrides.body ?? {},
    query: overrides.query ?? {},
    params: overrides.params ?? {},
  } as unknown as import('express').Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res as unknown as import('express').Response & {
    statusCode: number;
    jsonBody: unknown;
  };
}

describe('Integration: validate middleware', () => {
  const TestSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().min(0).optional(),
    role: z.string().default('user'),
  });

  describe('validate(schema) — body', () => {
    test('should pass valid body and apply defaults', () => {
      const req = mockReq({ body: { name: 'Alice' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validate(TestSchema)(req, res, next);

      expect(called).toBe(true);
      expect(req.body).toEqual({ name: 'Alice', role: 'user' });
    });

    test('should pass body with all fields', () => {
      const req = mockReq({ body: { name: 'Bob', age: 30, role: 'admin' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validate(TestSchema)(req, res, next);

      expect(called).toBe(true);
      expect(req.body).toEqual({ name: 'Bob', age: 30, role: 'admin' });
    });

    test('should reject invalid body with 400', () => {
      const req = mockReq({ body: { name: '' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validate(TestSchema)(req, res, next);

      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
      expect((res.jsonBody as Record<string, unknown>).success).toBe(false);
      expect(
        ((res.jsonBody as Record<string, unknown>).error as Record<string, unknown>).code
      ).toBe('VALIDATION_ERROR');
    });

    test('should reject missing required field', () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validate(TestSchema)(req, res, next);

      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
    });

    test('should include flattened error details', () => {
      const req = mockReq({ body: { age: 'not-a-number' } });
      const res = mockRes();
      const next = () => {};

      validate(TestSchema)(req, res, next);

      const body = res.jsonBody as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.details).toBeDefined();
      expect(error.message).toBe('Request body validation failed');
    });

    test('should handle null body gracefully', () => {
      const req = mockReq({ body: null });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      // The null fallback in validate: req.body ?? {} → parsed as {}
      validate(TestSchema)(req, res, next);

      // {} missing required 'name' → should fail
      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('validateQuery(schema) — query', () => {
    const QuerySchema = z.object({
      q: z.string().min(1),
      limit: z.coerce.number().int().default(20),
    });

    test('should pass valid query and apply defaults', () => {
      const req = mockReq({ query: { q: 'auth' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validateQuery(QuerySchema)(req, res, next);

      expect(called).toBe(true);
      expect((req as unknown as Record<string, unknown>).query).toEqual({
        q: 'auth',
        limit: 20,
      });
    });

    test('should reject invalid query', () => {
      const req = mockReq({ query: { q: '' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validateQuery(QuerySchema)(req, res, next);

      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
      const body = res.jsonBody as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Query parameter validation failed');
    });
  });

  describe('validateParams(schema) — params', () => {
    const ParamsSchema = z.object({
      id: z.string().min(1),
    });

    test('should pass valid params', () => {
      const req = mockReq({ params: { id: 'abc-123' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validateParams(ParamsSchema)(req, res, next);

      expect(called).toBe(true);
      expect((req as unknown as Record<string, unknown>).params).toEqual({
        id: 'abc-123',
      });
    });

    test('should reject empty id param', () => {
      const req = mockReq({ params: { id: '' } });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validateParams(ParamsSchema)(req, res, next);

      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
      const body = res.jsonBody as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Path parameter validation failed');
    });

    test('should reject missing params', () => {
      const req = mockReq({ params: {} });
      const res = mockRes();
      let called = false;
      const next = () => {
        called = true;
      };

      validateParams(ParamsSchema)(req, res, next);

      expect(called).toBe(false);
      expect(res.statusCode).toBe(400);
    });
  });
});
