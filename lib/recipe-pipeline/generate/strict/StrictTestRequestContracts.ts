import path from 'node:path';
import { z } from 'zod';

const STRICT_TEST_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u;
const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LEGACY_STRICT_TEST_ACTIVATION_KEYS = new Set([
  'confirmation',
  'demandKey',
  'dimension',
  'preflightHash',
  'privateRoot',
  'profile',
  'testMode',
]);

const StrictTestIdentity = z.string().regex(STRICT_TEST_IDENTITY_PATTERN);
const CanonicalSha256 = z.string().regex(CANONICAL_SHA256_PATTERN);
const CanonicalAbsolutePath = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value, {
    message: 'projectRoot must be a normalized absolute path',
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
  z.object({}).strict().parse(input);
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
