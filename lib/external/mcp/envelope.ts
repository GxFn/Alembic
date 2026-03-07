/**
 * envelope — MCP 响应标准化包装
 * 所有 MCP 工具返回的 content 均使用此格式
 */

/**
 * @param {object} opts
 * @param {boolean} opts.success
 * @param {*}       [opts.data]
 * @param {string}  [opts.message]
 * @param {object}  [opts.meta]        - { tool, version, responseTimeMs, source }
 * @param {string}  [opts.errorCode]
 * @returns {object} 标准化响应对象
 */
export interface EnvelopeMeta {
  responseTimeMs?: number;
  tool?: string;
  source?: string;
  version?: string;
  [key: string]: unknown;
}

export interface EnvelopeOptions<T = unknown> {
  success: boolean;
  data?: T | null;
  message?: string;
  meta?: EnvelopeMeta;
  errorCode?: string | null;
}

export function envelope<T = unknown>({
  success,
  data = null,
  message = '',
  meta = {},
  errorCode = null,
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
    meta: {
      ...(tool ? { tool } : {}),
      version,
      ...(respTime != null ? { responseTimeMs: respTime } : {}),
      ...(source ? { source } : {}),
    },
  };
}

export default envelope;
