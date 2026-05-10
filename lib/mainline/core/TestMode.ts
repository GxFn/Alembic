import type { MainlineEnvironment } from "./Environment.js";

export interface MainlineTerminalTestConfig {
  readonly enabled: boolean;
  readonly toolset: string;
}

export interface MainlineSandboxTestConfig {
  readonly mode: "enforce" | "audit" | "disabled";
  readonly available: boolean;
}

export interface MainlineTestModeConfig {
  readonly enabled: boolean;
  readonly bootstrapDims: string[];
  readonly rescanDims: string[];
  readonly terminal: MainlineTerminalTestConfig;
  readonly sandbox: MainlineSandboxTestConfig;
}

export function getMainlineTestModeConfig(env: MainlineEnvironment): MainlineTestModeConfig {
  const terminalToolset = env.get("ALEMBIC_TERMINAL_TOOLSET") ?? "terminal-run";
  const rawSandbox = env.get("ALEMBIC_SANDBOX_MODE")?.toLowerCase();
  return {
    enabled: env.getBoolean("ALEMBIC_TEST_MODE"),
    bootstrapDims: env.getList("ALEMBIC_TEST_BOOTSTRAP_DIMS"),
    rescanDims: env.getList("ALEMBIC_TEST_RESCAN_DIMS"),
    terminal: {
      enabled: terminalToolset !== "baseline",
      toolset: terminalToolset,
    },
    sandbox: {
      mode:
        rawSandbox === "disabled" || rawSandbox === "0" || rawSandbox === "off"
          ? "disabled"
          : rawSandbox === "audit"
            ? "audit"
            : "enforce",
      available: process.platform === "darwin",
    },
  };
}

export function filterMainlineItemsByTestIds<T extends { id: string }>(
  items: readonly T[],
  allowedIds: readonly string[],
  enabled: boolean,
): T[] {
  if (!enabled || allowedIds.length === 0) {
    return [...items];
  }
  const allowed = new Set(allowedIds);
  return items.filter((item) => allowed.has(item.id));
}
