/**
 * SchemaValidator — ajv-based JSON Schema validation for tool inputs.
 *
 * Replaces the hand-rolled `validateToolInput` with full JSON Schema support:
 *   - additionalProperties detection
 *   - Nested object/array validation
 *   - pattern / minLength / maxLength / minimum / maximum
 *   - $ref / definitions (when needed)
 *
 * A singleton `Ajv` instance is reused across calls; schemas are compiled
 * and cached by a stable key (tool id or hash).
 *
 * @module tools/core/SchemaValidator
 */

import type { ToolParameterSchema } from './ToolInputSchema.js';

interface AjvErrorObject {
  keyword: string;
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: ajv's type resolution is broken under NodeNext; runtime access works fine.
type AjvValidateFunction = ((data: unknown) => boolean) & { errors?: AjvErrorObject[] | null };

// Lazy-loaded ajv instance (avoids import resolution issues with NodeNext)
let _ajv: { compile: (schema: Record<string, unknown>) => AjvValidateFunction } | null = null;

async function ensureAjv() {
  if (!_ajv) {
    const mod = await import('ajv');
    const AjvClass = (
      mod as unknown as { default: { new (opts: Record<string, unknown>): typeof _ajv } }
    ).default;
    _ajv = new AjvClass({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      useDefaults: false,
    });
  }
  return _ajv!;
}

// Eagerly initialize (fire-and-forget) so subsequent calls are synchronous.
let _ready: Promise<void> | null = ensureAjv().then(() => {
  _ready = null;
});

// ── Compiled cache ──

const _cache = new Map<string, AjvValidateFunction>();

function getOrCompile(
  ajv: NonNullable<typeof _ajv>,
  cacheKey: string,
  schema: Record<string, unknown>
): AjvValidateFunction {
  const cached = _cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const jsonSchema: Record<string, unknown> = {
    type: 'object',
    ...schema,
  };
  if (!('additionalProperties' in jsonSchema)) {
    jsonSchema.additionalProperties = true;
  }
  const validate = ajv.compile(jsonSchema);
  _cache.set(cacheKey, validate);
  return validate;
}

// ── Public API ──

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  /** Raw ajv errors for programmatic use */
  rawErrors?: AjvErrorObject[];
}

/**
 * Validate tool input against a JSON Schema using ajv.
 *
 * @param args - Tool input arguments
 * @param schema - JSON Schema (the `inputSchema` from ToolCapabilityManifest or ToolDefinitionV2)
 * @param cacheKey - Stable key for caching compiled schema (typically tool id)
 */
export async function validateToolInputV2(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  cacheKey?: string
): Promise<SchemaValidationResult> {
  if (_ready) {
    await _ready;
  }
  const ajv = _ajv ?? (await ensureAjv());
  const key = cacheKey || stableKey(schema);
  const validate = getOrCompile(ajv, key, schema);
  const valid = validate(args);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validate.errors || []).map(formatError);
  return { valid: false, errors, rawErrors: validate.errors ?? undefined };
}

/**
 * Bridge: validate using the old `ToolParameterSchema` interface.
 * Returns string[] for drop-in compatibility with `validateToolInput`.
 */
export async function validateToolInputCompat(
  args: Record<string, unknown>,
  schema: ToolParameterSchema,
  cacheKey?: string
): Promise<string[]> {
  const result = await validateToolInputV2(args, schema as Record<string, unknown>, cacheKey);
  return result.errors;
}

/**
 * Clear the compiled schema cache (useful in tests).
 */
export function clearSchemaCache(): void {
  _cache.clear();
}

// ── Internal helpers ──

function formatError(err: AjvErrorObject): string {
  const path = err.instancePath || '/';
  const msg = err.message || 'unknown validation error';

  switch (err.keyword) {
    case 'required':
      return `缺少必填参数 "${(err.params as { missingProperty?: string }).missingProperty}"`;
    case 'type':
      return `参数 "${path}" 类型应为 ${(err.params as { type?: string }).type}`;
    case 'enum':
      return `参数 "${path}" 必须是: ${((err.params as { allowedValues?: unknown[] }).allowedValues || []).map(String).join(', ')}`;
    case 'additionalProperties':
      return `参数 "${(err.params as { additionalProperty?: string }).additionalProperty}" 不在 schema 中`;
    default:
      return `${path === '/' ? '' : `参数 "${path}" `}${msg}`;
  }
}

function stableKey(schema: Record<string, unknown>): string {
  try {
    return JSON.stringify(schema);
  } catch {
    return `schema_${Date.now()}`;
  }
}
