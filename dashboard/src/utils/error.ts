/**
 * 类型安全的错误信息提取工具
 *
 * 用于 `catch (err: unknown)` 场景，替代 `catch (err: any)` 的 `.message` 直接访问。
 */

/** Axios 风格错误结构（仅类型守卫用，不引入 axios 依赖） */
interface AxiosLikeError {
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string };
      message?: string;
      aiError?: boolean;
    };
  };
  code?: string;
  name?: string;
  message?: string;
}

/**
 * 从 unknown 错误中安全提取可读消息
 *
 * 提取优先级:
 *  1. Axios `err.response.data.error` (string)
 *  2. Axios `err.response.data.error.message`
 *  3. Axios `err.response.data.message`
 *  4. Error `.message`
 *  5. 字符串本身
 *  6. fallback
 */
export function getErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (typeof err === 'string') {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (isAxiosLikeError(err)) {
    const data = err.response?.data;
    if (data) {
      if (typeof data.error === 'string') {
        return data.error;
      }
      if (typeof data.error === 'object' && data.error?.message) {
        return data.error.message;
      }
      if (typeof data.message === 'string') {
        return data.message;
      }
    }
    if (err.message) {
      return err.message;
    }
  }
  // 通用 { message: string } 对象
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return fallback;
}

/** 检查是否为 Axios 风格错误 (有 response.status) */
function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as AxiosLikeError).response === 'object'
  );
}

/** 提取 Axios 响应状态码 (无则返回 undefined) */
export function getErrorStatus(err: unknown): number | undefined {
  if (isAxiosLikeError(err)) {
    return err.response?.status;
  }
  return undefined;
}

/** 提取 Axios 响应 data (无则返回 undefined) */
export function getErrorData(err: unknown): Record<string, unknown> | undefined {
  if (isAxiosLikeError(err)) {
    return err.response?.data as Record<string, unknown> | undefined;
  }
  return undefined;
}

/** 检查是否为 AbortError (fetch abort / AbortController) */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 检查是否为 Axios 取消错误 */
export function isAxiosCancel(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    '__CANCEL__' in err
  );
}

/** 检查错误消息是否包含 timeout 关键词 */
export function isTimeoutError(err: unknown): boolean {
  if (isAxiosLikeError(err)) {
    if (err.code === 'ECONNABORTED') {
      return true;
    }
  }
  return getErrorMessage(err, '').toLowerCase().includes('timeout');
}

/** 检查是否为 AI 特有错误 (response.data.aiError === true) */
export function isAiError(err: unknown): boolean {
  if (isAxiosLikeError(err)) {
    return err.response?.data?.aiError === true;
  }
  return false;
}
