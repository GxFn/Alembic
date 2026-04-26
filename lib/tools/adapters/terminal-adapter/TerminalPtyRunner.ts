export function buildPtyWrapperCommand(
  pty: {
    command: string;
    shell: '/bin/sh';
    pty: {
      rows: number;
      cols: number;
      stdin: 'disabled' | 'provided';
    };
  },
  runnerPath: string
): { ok: true; bin: string; args: string[]; auditArgs: string[] } | { ok: false; error: string } {
  if (process.platform === 'win32') {
    return { ok: false, error: 'terminal_pty is not available on win32' };
  }
  return {
    ok: true,
    bin: 'python3',
    args: [
      runnerPath,
      pty.shell,
      pty.command,
      String(pty.pty.rows),
      String(pty.pty.cols),
      pty.pty.stdin,
    ],
    auditArgs: [
      runnerPath,
      pty.shell,
      '<command-redacted>',
      String(pty.pty.rows),
      String(pty.pty.cols),
      pty.pty.stdin,
    ],
  };
}
