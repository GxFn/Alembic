/**
 * envelope — Alembic resident tool 响应标准化包装
 * resident service 与历史 MCP-compatible 工具返回均使用此格式
 */

/**
 * @param [opts.meta] { tool, version, responseTimeMs, source }
 * @returns 标准化响应对象
 */
export interface EnvelopeMeta {
  responseTimeMs?: number;
  tool?: string;
  source?: string;
  version?: string;
  [key: string]: unknown;
}

import type { CORE_FAILURE_TAXONOMY_VERSION, CoreFieldFailureKind } from '@alembic/core/shared';

// W5-B3:原 handler-runtime/problem.ts 解散——buildToolUsageProblem 运行时函数 0 消费删除,
// envelope problem 字段的类型形状(MT3/D25 taxonomy 投影)内联至此(唯一消费者)。
export interface ToolFieldProblem {
  readonly field: string;
  readonly error: string;
}

export interface ToolUsageProblem {
  readonly code: string;
  readonly reasonCode: CoreFieldFailureKind;
  readonly failureId: string;
  readonly problemClass: string;
  readonly failingStep: string;
  readonly nextAction: string;
  readonly retryable: boolean;
  readonly retryPolicy: string;
  readonly taxonomyVersion: typeof CORE_FAILURE_TAXONOMY_VERSION;
  readonly fieldProblems?: readonly ToolFieldProblem[];
}

export interface EnvelopeOptions<T = unknown> {
  success: boolean;
  data?: T | null;
  message?: string;
  meta?: EnvelopeMeta;
  errorCode?: string | null;
  /** Structured usage-problem object (MT3/D25): taxonomy reason code, failing step, next action, retry safety. */
  problem?: ToolUsageProblem | null;
}

export function envelope<T = unknown>({
  success,
  data = null,
  message = '',
  meta = {},
  errorCode = null,
  problem = null,
}: EnvelopeOptions<T>) {
  const respTime = typeof meta.responseTimeMs === 'number' ? meta.responseTimeMs : undefined;
  const tool = typeof meta.tool === 'string' ? meta.tool : undefined;
  const source = typeof meta.source === 'string' ? meta.source : undefined;
  const version = typeof meta.version === 'string' ? meta.version : '2.0.0';

  return {
    success: Boolean(success),
    errorCode: errorCode || null,
    message: message || '',
    data,
    ...(problem ? { problem } : {}),
    meta: {
      ...(tool ? { tool } : {}),
      version,
      ...(respTime != null ? { responseTimeMs: respTime } : {}),
      ...(source ? { source } : {}),
    },
  };
}

export default envelope;
