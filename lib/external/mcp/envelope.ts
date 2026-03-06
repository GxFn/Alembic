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
export function envelope({ success, data = null, message = '', meta = {}, errorCode = null }: any) {
  const respTime = typeof (meta as any).responseTimeMs === 'number' ? (meta as any).responseTimeMs : undefined;
  const tool = typeof (meta as any).tool === 'string' ? (meta as any).tool : undefined;
  const source = typeof (meta as any).source === 'string' ? (meta as any).source : undefined;
  const version = typeof (meta as any).version === 'string' ? (meta as any).version : '2.0.0';

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
