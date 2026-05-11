/**
 * 集成测试：zodToMcpSchema — Zod → MCP JSON Schema
 *
 * 覆盖范围:
 *   - $schema 移除
 *   - additionalProperties: false 移除
 *   - integer 冗余边界清理 (±MAX_SAFE_INTEGER)
 *   - default 字段从 required 移除
 *   - 递归 properties / items / anyOf / oneOf / allOf
 *   - 真实项目 schema 转换一致性
 */

import { z } from 'zod';
import { zodToMcpSchema } from '../../lib/external/mcp/zodToMcpSchema.js';
import { HealthInput, SearchInput, TaskInput } from '../../lib/shared/schemas/mcp-tools.js';

describe('Integration: zodToMcpSchema', () => {
  describe('basic shape', () => {
    test('should return object type with properties and required', () => {
      const schema = z.object({ name: z.string() });
      const result = zodToMcpSchema(schema);
      expect(result.type).toBe('object');
      expect(result.properties).toBeDefined();
      expect(result.required).toContain('name');
    });

    test('should handle empty object', () => {
      const schema = z.object({});
      const result = zodToMcpSchema(schema);
      expect(result.type).toBe('object');
      expect(result.properties).toEqual({});
      expect(result.required).toEqual([]);
    });
  });

  describe('$schema removal', () => {
    test('should not contain $schema in output', () => {
      const schema = z.object({ name: z.string() });
      const result = zodToMcpSchema(schema);
      expect(result['$schema']).toBeUndefined();
    });
  });

  describe('additionalProperties removal', () => {
    test('should remove additionalProperties: false', () => {
      const schema = z.object({ x: z.number() });
      const result = zodToMcpSchema(schema);
      expect(result['additionalProperties']).toBeUndefined();
    });
  });

  describe('integer boundary cleanup', () => {
    test('should remove MAX_SAFE_INTEGER boundaries', () => {
      const schema = z.object({ count: z.number().int() });
      const result = zodToMcpSchema(schema);
      const countProp = result.properties['count'];
      expect(countProp['minimum']).toBeUndefined();
      expect(countProp['maximum']).toBeUndefined();
    });

    test('should preserve explicit boundaries', () => {
      const schema = z.object({ count: z.number().int().min(0).max(100) });
      const result = zodToMcpSchema(schema);
      const countProp = result.properties['count'];
      expect(countProp['minimum']).toBe(0);
      expect(countProp['maximum']).toBe(100);
    });
  });

  describe('default fields removal from required', () => {
    test('should exclude fields with default from required', () => {
      const schema = z.object({
        name: z.string(),
        limit: z.number().default(10),
        offset: z.number().default(0),
      });
      const result = zodToMcpSchema(schema);
      expect(result.required).toContain('name');
      expect(result.required).not.toContain('limit');
      expect(result.required).not.toContain('offset');
    });

    test('should still include default props in properties', () => {
      const schema = z.object({
        mode: z.string().default('auto'),
      });
      const result = zodToMcpSchema(schema);
      expect(result.properties['mode']).toBeDefined();
    });
  });

  describe('recursive cleaning', () => {
    test('should clean nested object properties', () => {
      const schema = z.object({
        meta: z.object({
          count: z.number().int(),
        }),
      });
      const result = zodToMcpSchema(schema);
      const metaProp = result.properties['meta'] as Record<string, unknown>;
      const metaProps = metaProp['properties'] as Record<string, Record<string, unknown>>;
      // Nested integer should have boundaries cleaned
      if (metaProps?.['count']) {
        expect(metaProps['count']['minimum']).toBeUndefined();
        expect(metaProps['count']['maximum']).toBeUndefined();
      }
    });

    test('should clean array items', () => {
      const schema = z.object({
        ids: z.array(z.number().int()),
      });
      const result = zodToMcpSchema(schema);
      const idsProp = result.properties['ids'] as Record<string, unknown>;
      const items = idsProp['items'] as Record<string, unknown>;
      if (items?.['minimum'] !== undefined) {
        // Should have cleaned MAX_SAFE_INTEGER
        expect(items['minimum']).not.toBe(-9007199254740991);
      }
    });

    test('should clean union (anyOf) branches', () => {
      const schema = z.object({
        value: z.union([z.string(), z.number().int()]),
      });
      const result = zodToMcpSchema(schema);
      const valueProp = result.properties['value'] as Record<string, unknown>;
      if (Array.isArray(valueProp['anyOf'])) {
        for (const branch of valueProp['anyOf'] as Record<string, unknown>[]) {
          if (branch['type'] === 'integer') {
            expect(branch['minimum']).toBeUndefined();
            expect(branch['maximum']).toBeUndefined();
          }
        }
      }
    });
  });

  describe('real project schemas', () => {
    test('SearchInput should produce valid MCP schema', () => {
      const result = zodToMcpSchema(SearchInput);
      expect(result.type).toBe('object');
      expect(result.properties['query']).toBeDefined();
      expect(result.required).toContain('query');
      // mode has default, should not be required
      expect(result.required).not.toContain('mode');
      expect(result.required).not.toContain('limit');
    });

    test('HealthInput should produce valid MCP schema', () => {
      const result = zodToMcpSchema(HealthInput);
      expect(result.type).toBe('object');
      // All fields optional → required should be empty
      expect(result.required).toEqual([]);
    });

    test('TaskInput should produce valid MCP schema', () => {
      const result = zodToMcpSchema(TaskInput);
      expect(result.type).toBe('object');
      expect(result.properties['operation']).toBeDefined();
      expect(result.required).toContain('operation');
    });

    test('all schemas should not contain $schema', () => {
      for (const schema of [SearchInput, HealthInput, TaskInput]) {
        const result = zodToMcpSchema(schema);
        expect(result['$schema']).toBeUndefined();
      }
    });
  });
});
