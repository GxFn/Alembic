export const NON_INTERACTIVE_ENV = {
  CI: '1',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  LESS: '-FRX',
  PAGER: 'cat',
};

export function buildTerminalEnvironment(
  env: NodeJS.ProcessEnv,
  commandEnv: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...commandEnv,
    ...NON_INTERACTIVE_ENV,
  };
}

export function buildCommandEnvironment(
  sessionEnv: Record<string, string>,
  commandEnv: Record<string, string>
): Record<string, string> {
  return {
    ...sessionEnv,
    ...commandEnv,
  };
}

export function summarizeTerminalEnv(
  env: Record<string, string>,
  persistence: 'none' | 'explicit'
): { keys: string[]; persistence: 'none' | 'explicit' } {
  return {
    keys: Object.keys(env).sort(),
    persistence,
  };
}
