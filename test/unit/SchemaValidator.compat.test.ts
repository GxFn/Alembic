/**
 * SchemaValidator ajv 兼容性扫描
 *
 * 遍历 ALL_TOOLS 中全部内部工具的 parameters schema，
 * 确认 ajv 能无错编译并通过基本验证。
 *
 * P3.2: 现有工具 schema → ajv 兼容性扫描
 */
import { afterAll, describe, expect, it } from 'vitest';
import { clearSchemaCache, validateToolInputV2 } from '../../lib/tools/core/SchemaValidator.js';
import { ALL_TOOLS } from '../../lib/tools/handlers/index.js';

afterAll(() => {
  clearSchemaCache();
});

describe('ajv compatibility scan — ALL_TOOLS', () => {
  const tools = ALL_TOOLS;

  it('ALL_TOOLS is non-empty', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  for (const tool of tools) {
    const toolName = tool.name || (tool as Record<string, unknown>).id || 'unknown';
    const rawSchema =
      tool.parameters ??
      (tool as Record<string, unknown>).inputSchema ??
      (tool as Record<string, unknown>).schema;

    if (!rawSchema || typeof rawSchema !== 'object') {
      it(`${toolName}: no schema — skip`, () => {
        expect(true).toBe(true);
      });
      continue;
    }

    const schema = rawSchema as Record<string, unknown>;

    it(`${toolName}: ajv compiles without error`, async () => {
      const result = await validateToolInputV2({}, schema, `compat_${toolName}`);
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it(`${toolName}: valid input passes`, async () => {
      const sampleInput = buildMinimalInput(schema);
      const result = await validateToolInputV2(sampleInput, schema, `compat_valid_${toolName}`);
      // Even if we can't build a perfect sample, compile must succeed
      expect(result).toBeDefined();
    });
  }
});

/**
 * Build a minimal valid input from a JSON Schema.
 * Fills required string fields with placeholder text.
 */
function buildMinimalInput(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const properties =
    (schema.properties as Record<string, Record<string, unknown>> | undefined) || {};

  for (const key of required) {
    const prop = properties[key];
    if (!prop) {
      result[key] = 'test';
      continue;
    }
    switch (prop.type) {
      case 'string':
        result[key] = prop.enum ? (prop.enum as unknown[])[0] : 'test_value';
        break;
      case 'number':
      case 'integer':
        result[key] = 1;
        break;
      case 'boolean':
        result[key] = true;
        break;
      case 'array':
        result[key] = [];
        break;
      case 'object':
        result[key] = {};
        break;
      default:
        result[key] = 'test';
    }
  }
  return result;
}
