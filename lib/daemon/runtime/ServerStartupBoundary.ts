import type { AppRuntimeComponents } from '../../Bootstrap.js';

export interface ServerStartupRuntime {
  initialize(): Promise<AppRuntimeComponents>;
}

/**
 * Convert AppRuntime's strict startup-action result into a server-launch decision.
 * The setup/recovery orchestration remains owned by AppRuntime; launchers only
 * consume its explicit terminal disposition.
 */
export async function initializeServerRuntime(
  appRuntime: ServerStartupRuntime
): Promise<AppRuntimeComponents | null> {
  const components = await appRuntime.initialize();
  if (components.startupDisposition === 'startup-action-completed') {
    return null;
  }
  if (components.startupDisposition !== 'runtime-ready') {
    throw new Error(`SERVER_STARTUP_RUNTIME_NOT_READY:${components.startupDisposition}`);
  }
  return components;
}
