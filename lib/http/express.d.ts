/** Express Request augmentation — custom properties injected by middleware */
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Request source label retained for legacy call surfaces. */
    resolvedRole?: string;
    /** Request source identifier retained for audit context. */
    resolvedUser?: string;
    /** Gateway shortcut (set by gatewayMiddleware) */
    gw: (
      action: string,
      resource: string,
      data?: Record<string, unknown>
    ) => Promise<{
      success: boolean;
      data?: unknown;
      error?: { message: string; statusCode?: number; code?: string };
      requestId?: string;
    }>;
  }
}
