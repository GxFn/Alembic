import { getTestModeConfig } from '#shared/test-mode.js';

export type BootstrapTerminalToolset =
  | 'baseline'
  | 'terminal-run'
  | 'terminal-shell'
  | 'terminal-pty';

export type BootstrapTerminalMode = 'run' | 'shell' | 'pty';

export interface BootstrapTerminalToolsetConfig {
  terminalTest: boolean;
  terminalToolset: BootstrapTerminalToolset;
  allowedTerminalModes: BootstrapTerminalMode[];
}

const TOOLSET_MODES: Record<BootstrapTerminalToolset, BootstrapTerminalMode[]> = {
  baseline: [],
  'terminal-run': ['run'],
  'terminal-shell': ['run', 'shell'],
  'terminal-pty': ['run', 'shell', 'pty'],
};

const ANALYZE_TOOLS: Record<BootstrapTerminalMode, string> = {
  run: 'terminal_run',
  shell: 'terminal_shell',
  pty: 'terminal_pty',
};

const EVOLUTION_TOOLS: Partial<Record<BootstrapTerminalMode, string>> = {
  run: 'terminal_run',
  shell: 'terminal_shell',
};

export function resolveBootstrapTerminalToolset(
  input: { terminalTest?: unknown; terminalToolset?: unknown; allowedTerminalModes?: unknown } = {}
): BootstrapTerminalToolsetConfig {
  const terminalCfg = getTestModeConfig().terminal;
  const envEnabled = terminalCfg.enabled;
  const envToolset = terminalCfg.toolset;
  const requestedToolset = normalizeToolset(input.terminalToolset || envToolset);

  const explicitEnabled =
    typeof input.terminalTest === 'boolean' ? input.terminalTest : input.terminalTest === '1';
  const terminalTest =
    explicitEnabled || envEnabled || (!!requestedToolset && requestedToolset !== 'baseline');
  const terminalToolset = terminalTest ? requestedToolset || 'terminal-run' : 'baseline';
  const defaultModes = TOOLSET_MODES[terminalToolset];
  const allowedTerminalModes = normalizeModes(
    input.allowedTerminalModes,
    defaultModes,
    defaultModes
  );

  return {
    terminalTest,
    terminalToolset,
    allowedTerminalModes,
  };
}

export function getBootstrapStageTerminalTools(
  stageName: string,
  config: BootstrapTerminalToolsetConfig
): string[] {
  if (!config.terminalTest || config.terminalToolset === 'baseline') {
    return [];
  }

  if (stageName === 'analyze') {
    return config.allowedTerminalModes.map((mode) => ANALYZE_TOOLS[mode]).filter(Boolean);
  }

  if (stageName === 'evolve' || stageName === 'evolution') {
    return config.allowedTerminalModes
      .map((mode) => EVOLUTION_TOOLS[mode])
      .filter((tool): tool is string => typeof tool === 'string');
  }

  return [];
}

export function buildBootstrapTerminalPolicyHints(config: BootstrapTerminalToolsetConfig) {
  return {
    terminalTest: config.terminalTest,
    terminalToolset: config.terminalToolset,
    allowedTerminalModes: [...config.allowedTerminalModes],
    terminalScriptAllowed: false,
    constraints: [
      'Terminal tools are optional code-analysis evidence tools for analyze/evolve only.',
      'Prefer terminal_run. Use terminal_shell only for pipes/redirection/substitution.',
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

function normalizeModes(
  value: unknown,
  fallback: BootstrapTerminalMode[],
  allowed: BootstrapTerminalMode[]
): BootstrapTerminalMode[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const modes = value.filter(
    (mode): mode is BootstrapTerminalMode =>
      (mode === 'run' || mode === 'shell' || mode === 'pty') && allowed.includes(mode)
  );
  return modes.length > 0 ? modes : [...fallback];
}
