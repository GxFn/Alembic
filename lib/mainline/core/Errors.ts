export interface MainlineErrorOptions {
  readonly message: string;
  readonly code?: string;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export interface MainlineErrorJson {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
}

/**
 * MainlineError 是新主线的轻量错误基类。
 * 它只保留 code/status/details，不承载 HTTP、CLI、旧 service 的错误层级。
 */
export class MainlineError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(options: MainlineErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code ?? "MAINLINE_ERROR";
    this.statusCode = options.statusCode ?? 500;
    if (options.details) {
      this.details = { ...options.details };
    }
  }

  toJSON(): MainlineErrorJson {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class MainlineValidationError extends MainlineError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super({
      message,
      code: "MAINLINE_VALIDATION_ERROR",
      statusCode: 400,
      details,
    });
  }
}

export class MainlineTimeoutError extends MainlineError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super({
      message,
      code: "MAINLINE_TIMEOUT",
      statusCode: 408,
      details,
    });
  }
}

export class MainlineAbortError extends MainlineError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super({
      message,
      code: "MAINLINE_ABORTED",
      statusCode: 499,
      details,
    });
  }
}

export class MainlineWriteBoundaryError extends MainlineError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super({
      message,
      code: "MAINLINE_WRITE_BOUNDARY",
      statusCode: 400,
      details,
    });
  }
}

export function toMainlineError(
  error: unknown,
  fallbackMessage = "Mainline operation failed.",
): MainlineError {
  if (error instanceof MainlineError) {
    return error;
  }
  if (error instanceof Error) {
    return new MainlineError({
      message: error.message || fallbackMessage,
      code: "MAINLINE_UNKNOWN_ERROR",
      cause: error,
    });
  }
  return new MainlineError({
    message: typeof error === "string" ? error : fallbackMessage,
    code: "MAINLINE_UNKNOWN_ERROR",
    details: { value: error },
  });
}
