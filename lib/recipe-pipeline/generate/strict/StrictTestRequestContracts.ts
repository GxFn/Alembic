import path from 'node:path';
import { z } from 'zod';

const STRICT_TEST_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u;
const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT = 'alembic-canonical-absolute-path-v1';
const LEGACY_STRICT_TEST_ACTIVATION_KEYS = new Set([
  'confirmation',
  'demandKey',
  'dimension',
  'preflightHash',
  'privateRoot',
  'profile',
  'testMode',
]);

const StrictTestIdentity = z.string().min(1).max(256).regex(STRICT_TEST_IDENTITY_PATTERN);
const CanonicalSha256 = z.string().regex(CANONICAL_SHA256_PATTERN);

/**
 * Main 的 canonical path authority 使用当前宿主 Node path dialect。Provider 与生成消费者
 * 只能通过这个稳定 format id 复用同一判定器；禁止把它降级成 POSIX-only regex，或在
 * Dashboard 侧猜测 Main 所在平台。
 */
export function isStrictTestCanonicalAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value;
}

export const STRICT_TEST_INPUT_STRING_FORMAT_VALIDATORS = Object.freeze({
  [STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT]: isStrictTestCanonicalAbsolutePath,
});

const CanonicalAbsolutePath = z
  .string()
  .min(1)
  .refine(isStrictTestCanonicalAbsolutePath, {
    message: 'projectRoot must be a normalized absolute path',
  })
  .meta({
    format: STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT,
    'x-alembic-validator': STRICT_TEST_CANONICAL_ABSOLUTE_PATH_FORMAT,
  });

/**
 * strict-test 只能由独立 API 的精确 contract 进入。这里故意不接收 profile、dimension、
 * confirmation、testMode 或任何 filesystem authority，避免路由层剥除未知字段后误激活。
 */
const StrictTestPreflightRequestSchema = z
  .object({
    demandKey: StrictTestIdentity,
    projectRoot: CanonicalAbsolutePath,
    runId: StrictTestIdentity,
  })
  .strict();

const StrictTestRunRequestSchema = z
  .object({
    demandKey: StrictTestIdentity,
    preflightHash: CanonicalSha256,
    runId: StrictTestIdentity,
  })
  .strict();
const StrictTestEmptyQuerySchema = z.object({}).strict();

/**
 * Provider/OpenAPI 只消费由真实运行时 parser 机械导出的 draft-07 片段。这样字段闭合、
 * identity 长度/正则和 hash 规则不会在 HTTP manifest 中形成第二份手写真相；移除局部
 * `$schema` 只是为了嵌入仓库既有 OpenAPI 3.0 文档，不迁移全局 dialect。
 */
function runtimeParserJsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(z.toJSONSchema(schema, { target: 'draft-7' })).filter(
        ([key]) => key !== '$schema'
      )
    )
  );
}

export const STRICT_TEST_PREFLIGHT_REQUEST_JSON_SCHEMA = runtimeParserJsonSchema(
  StrictTestPreflightRequestSchema
);
export const STRICT_TEST_RUN_REQUEST_JSON_SCHEMA = runtimeParserJsonSchema(
  StrictTestRunRequestSchema
);
export const STRICT_TEST_RUN_ID_JSON_SCHEMA = runtimeParserJsonSchema(StrictTestIdentity);
export const STRICT_TEST_EMPTY_QUERY_JSON_SCHEMA = runtimeParserJsonSchema(
  StrictTestEmptyQuerySchema
);

export type StrictTestPreflightRequestV1 = z.infer<typeof StrictTestPreflightRequestSchema>;
export type StrictTestRunRequestV1 = z.infer<typeof StrictTestRunRequestSchema>;

export function parseStrictTestPreflightRequest(input: unknown): StrictTestPreflightRequestV1 {
  return StrictTestPreflightRequestSchema.parse(input);
}

export function parseStrictTestRunRequest(input: unknown): StrictTestRunRequestV1 {
  return StrictTestRunRequestSchema.parse(input);
}

export function parseStrictTestRunId(input: unknown): string {
  return StrictTestIdentity.parse(input);
}

export function assertStrictTestEmptyQuery(input: unknown): void {
  StrictTestEmptyQuerySchema.parse(input);
}

/**
 * legacy bootstrap 的顶层 Zod schema 历史上会剥除未知字段。先检查原始 body，防止调用者把
 * strict-test profile 字段混入旧入口后仍创建 bootstrap DaemonJob。`dimensions` 保留其既有
 * production V1 含义，但绝不被解释成 strict-test selection。
 */
export function assertNoLegacyStrictTestActivation(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return;
  }
  const forbidden = Object.keys(input).find((key) => LEGACY_STRICT_TEST_ACTIVATION_KEYS.has(key));
  if (forbidden) {
    throw new Error(`STRICT_TEST_LEGACY_ACTIVATION_FORBIDDEN:${forbidden}`);
  }
}
