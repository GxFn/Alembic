import { getTestModeConfig } from '#shared/test-mode.js';

export type BootstrapTerminalToolset =
  | 'baseline'
  | 'terminal-run'
  | 'terminal-shell'
  | 'terminal-pty';

export type BootstrapTerminalMode = 'run' | 'shell' | 'pty';

export interface BootstrapTerminalToolsetConfig {
  enabled: boolean;
  toolset: BootstrapTerminalToolset;
  modes: BootstrapTerminalMode[];
}

const TOOLSET_MODES: Record<BootstrapTerminalToolset, BootstrapTerminalMode[]> = {
  baseline: [],
  'terminal-run': ['run'],
  'terminal-shell': ['run', 'shell'],
  'terminal-pty': ['run', 'shell', 'pty'],
};

const ANALYZE_TOOLS: Record<BootstrapTerminalMode, string> = {
  run: 'terminal',
  shell: 'terminal_shell',
  pty: 'terminal_pty',
};

const EVOLUTION_TOOLS: Partial<Record<BootstrapTerminalMode, string>> = {
  run: 'terminal',
  shell: 'terminal_shell',
};

export function resolveBootstrapTerminalToolset(): BootstrapTerminalToolsetConfig {
  const terminalCfg = getTestModeConfig().terminal;
  const envToolset = terminalCfg.toolset;
  const requestedToolset = normalizeToolset(envToolset);

  const toolset = requestedToolset || 'terminal-run';
  const enabled = toolset !== 'baseline';
  const defaultModes = TOOLSET_MODES[toolset];

  return {
    enabled,
    toolset,
    modes: [...defaultModes],
  };
}

export function getBootstrapStageTerminalTools(
  stageName: string,
  config: BootstrapTerminalToolsetConfig
): string[] {
  if (!config.enabled || config.toolset === 'baseline') {
    return [];
  }

  if (stageName === 'analyze') {
    return config.modes.map((mode) => ANALYZE_TOOLS[mode]).filter(Boolean);
  }

  if (stageName === 'evolve' || stageName === 'evolution') {
    return config.modes
      .map((mode) => EVOLUTION_TOOLS[mode])
      .filter((tool): tool is string => typeof tool === 'string');
  }

  return [];
}

export function buildBootstrapTerminalPolicyHints(config: BootstrapTerminalToolsetConfig) {
  return {
    terminalCapability: {
      enabled: config.enabled,
      toolset: config.toolset,
      modes: [...config.modes],
      scriptAllowed: false,
    },
    constraints: [
      'Terminal tools are optional code-analysis evidence tools for analyze/evolve only.',
      'Prefer terminal({ action: "exec" }). Use terminal_shell only for pipes/redirection/substitution.',
      'Use terminal_pty only when a TTY transcript is required.',
      'No installs, network operations, project writes, deletions, chmod/chown, sudo, or daemons.',
    ],
  };
}

function normalizeToolset(value: unknown): BootstrapTerminalToolset | null {
  return value === 'baseline' ||
    value === 'terminal-run' ||
    value === 'terminal-shell' ||
    value === 'terminal-pty'
    ? value
    : null;
}
