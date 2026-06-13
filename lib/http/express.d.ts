/** Express Request augmentation — custom properties injected by middleware */
import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /** Neutral request source label set by sourceResolver middleware. */
    resolvedSource?: string;
    /** Audit source identifier set by sourceResolver middleware. */
    resolvedSourceActor?: string;
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
