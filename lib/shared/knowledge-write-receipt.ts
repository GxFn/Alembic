import Logger from '@alembic/core/logging';

/** 只表示宿主没有拿到写回执；不推断 Core 未写入，也不将已发生的副作用视为回滚。 */
export class KnowledgeWriteReceiptUnavailableError extends Error {
  readonly code = 'KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE';
  readonly statusCode = 502;
  readonly retryable = false;
  readonly details: Readonly<{
    operation: string;
    id: string;
    coreReceipt: null;
    writeState: 'unknown';
    requiresReadback: true;
    retryable: false;
  }>;

  constructor(operation: string, id: string) {
    super(`Core knowledge ${operation} returned no write receipt; readback is required`);
    this.name = 'KnowledgeWriteReceiptUnavailableError';
    this.details = Object.freeze({
      operation,
      id,
      coreReceipt: null,
      writeState: 'unknown',
      requiresReadback: true,
      retryable: false,
    });
  }
}

/** 调用方先 await Core：原有异常原样传播，只有明确的 nullable 返回走此接入边界。 */
export function requireKnowledgeWriteReceipt<T extends object>(
  receipt: T | null,
  operation: string,
  id: string
): T {
  if (receipt === null) {
    const error = new KnowledgeWriteReceiptUnavailableError(operation, id);
    Logger.getInstance().warn(
      '[KnowledgeWriteReceipt] missing receipt; automatic retry is unsafe',
      {
        code: error.code,
        ...error.details,
      }
    );
    throw error;
  }
  return receipt;
}
