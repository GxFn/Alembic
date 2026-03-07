/**
 * 集成测试：wrapHandler — MCP 工具 Zod 校验 + 统一错误处理
 *
 * 覆盖范围:
 *   - Zod validation integration：TOOL_SCHEMAS 自动查找 + 显式 schema
 *   - null/undefined args 兜底空对象
 *   - ZodError → VALIDATION_ERROR 结构化响应
 *   - 业务错误直通（NotFoundError、ConflictError 等）
 *   - 未知异常 → INTERNAL_ERROR
 *   - meta.tool + responseTimeMs 注入
 */

import { z } from 'zod';
import { wrapHandler } from '../../lib/external/mcp/errorHandler.js';

describe('Integration: wrapHandler', () => {
  const TestSchema = z.object({
    query: z.string().min(1),
    limit: z.number().int().default(10),
  });

  describe('Zod validation', () => {
    test('should parse and apply defaults with explicit schema', async () => {
      let receivedArgs: Record<string, unknown> = {};
      const handler = wrapHandler(
        'test_tool',
        async (_ctx, args) => {
          receivedArgs = args;
          return { success: true };
        },
        TestSchema
      );

      const result = await handler({}, { query: 'hello' });
      expect(receivedArgs).toEqual({ query: 'hello', limit: 10 });
      expect(result).toEqual({ success: true });
    });

    test('should return VALIDATION_ERROR for invalid input', async () => {
      const handler = wrapHandler('test_tool', async () => ({ success: true }), TestSchema);

      const result = (await handler({}, { query: '' })) as Record<string, unknown>;
      expect(result.isError).toBe(true);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.errorCode).toBe('VALIDATION_ERROR');
      expect(parsed.message).toContain('输入校验失败');
      expect(parsed.meta.tool).toBe('test_tool');
    });

    test('should handle null args as empty object', async () => {
      let receivedArgs: Record<string, unknown> = {};
      const EmptySchema = z.object({
        verbose: z.boolean().default(false),
      });

      const handler = wrapHandler(
        'test_null',
        async (_ctx, args) => {
          receivedArgs = args;
          return { ok: true };
        },
        EmptySchema
      );

      // Simulate null args (common when MCP client sends no arguments)
      const result = await handler({}, null as unknown as Record<string, unknown>);
      expect(receivedArgs).toEqual({ verbose: false });
      expect(result).toEqual({ ok: true });
    });

    test('should use TOOL_SCHEMAS when no explicit schema', async () => {
      // Use a real tool name that exists in TOOL_SCHEMAS
      let receivedArgs: Record<string, unknown> = {};
      const handler = wrapHandler('autosnippet_health', async (_ctx, args) => {
        receivedArgs = args;
        return { health: 'ok' };
      });

      // HealthInput accepts empty object
      const result = await handler({}, {});
      expect(result).toEqual({ health: 'ok' });
    });

    test('should skip validation when no schema available', async () => {
      let receivedArgs: Record<string, unknown> = {};
      const handler = wrapHandler('unknown_tool_no_schema', async (_ctx, args) => {
        receivedArgs = args;
        return { raw: true };
      });

      // Should pass through raw args without validation
      const result = await handler({}, { anything: 'goes' });
      expect(receivedArgs).toEqual({ anything: 'goes' });
      expect(result).toEqual({ raw: true });
    });
  });

  describe('error handling', () => {
    test('should catch business errors with inferred code', async () => {
      const { NotFoundError } = await import('../../lib/shared/errors/index.js');

      const handler = wrapHandler(
        'test_notfound',
        async () => {
          throw new NotFoundError('Knowledge not found');
        },
        z.object({})
      );

      const result = (await handler({}, {})) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.errorCode).toBe('NOT_FOUND');
      expect(parsed.message).toContain('Knowledge not found');
    });

    test('should catch unknown errors as INTERNAL_ERROR', async () => {
      const handler = wrapHandler(
        'test_crash',
        async () => {
          throw new Error('unexpected boom');
        },
        z.object({})
      );

      const result = (await handler({}, {})) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.errorCode).toBe('INTERNAL_ERROR');
      expect(parsed.message).toContain('unexpected boom');
    });

    test('should include meta.responseTimeMs', async () => {
      const handler = wrapHandler(
        'test_timing',
        async () => {
          throw new Error('oops');
        },
        z.object({})
      );

      const result = (await handler({}, {})) as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.meta.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof parsed.meta.responseTimeMs).toBe('number');
    });
  });

  describe('validation error details', () => {
    test('should include field path in validation error message', async () => {
      const schema = z.object({
        name: z.string().min(3),
        nested: z.object({
          value: z.number(),
        }),
      });

      const handler = wrapHandler('test_fields', async () => ({ ok: true }), schema);
      const result = (await handler(
        {},
        {
          name: 'ab',
          nested: { value: 'not-a-number' },
        }
      )) as Record<string, unknown>;

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.errorCode).toBe('VALIDATION_ERROR');
      expect(parsed.message).toContain('name');
    });

    test('should handle missing required fields', async () => {
      const schema = z.object({
        required1: z.string(),
        required2: z.number(),
      });

      const handler = wrapHandler('test_missing', async () => ({ ok: true }), schema);
      const result = (await handler({}, {})) as Record<string, unknown>;

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.errorCode).toBe('VALIDATION_ERROR');
    });
  });
});
