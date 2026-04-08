/**
 * Shared BootstrapSessionManager singleton management.
 *
 * Previously duplicated (with identical logic) in:
 *   - bootstrap-internal.ts  → getOrCreateSessionManager()
 *   - bootstrap-external.ts  → getSessionManager()
 *   - rescan-external.ts     → getSessionManager()
 *
 * @module bootstrap/shared/session-helpers
 */

import type { McpContext } from '../../types.js';
import { BootstrapSessionManager } from '../BootstrapSession.js';

// ── Process-level singleton ──────────────────────────────

let _sessionManager: BootstrapSessionManager | null = null;

/**
 * Get or create the process-level BootstrapSessionManager singleton.
 *
 * Resolution order:
 *   1. Check container for registered instance
 *   2. Fall back to module-level singleton
 *   3. Register into container for cross-handler access
 */
export function getOrCreateSessionManager(
  container: McpContext['container']
): BootstrapSessionManager {
  // Check container first
  try {
    const mgr = container.get('bootstrapSessionManager');
    if (mgr) {
      return mgr as unknown as BootstrapSessionManager;
    }
  } catch {
    /* not registered yet */
  }

  // Fall back to module-level singleton
  if (!_sessionManager) {
    _sessionManager = new BootstrapSessionManager();
  }

  // Register into container for cross-handler access
  try {
    (container as { register?: (name: string, factory: () => unknown) => void }).register?.(
      'bootstrapSessionManager',
      () => _sessionManager
    );
  } catch {
    /* already registered or container doesn't support register */
  }

  return _sessionManager;
}
