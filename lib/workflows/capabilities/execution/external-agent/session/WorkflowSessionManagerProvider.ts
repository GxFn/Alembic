import { BootstrapSessionManager } from '#workflows/capabilities/execution/external-agent/session/BootstrapSession.js';

interface SessionManagerContainer {
  get(name: string): unknown;
  register?: (name: string, factory: () => unknown) => void;
}

let sessionManager: BootstrapSessionManager | null = null;

export function getOrCreateSessionManager(
  container: SessionManagerContainer
): BootstrapSessionManager {
  try {
    const manager = container.get('bootstrapSessionManager');
    if (manager) {
      return manager as BootstrapSessionManager;
    }
  } catch {
    // Not registered yet.
  }

  if (!sessionManager) {
    sessionManager = new BootstrapSessionManager();
  }

  try {
    container.register?.('bootstrapSessionManager', () => sessionManager);
  } catch {
    // Already registered or container does not support registration.
  }

  return sessionManager;
}
