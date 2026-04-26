import { describe, expect, test } from 'vitest';
import {
  buildTerminalCommandPolicyInput,
  buildTerminalPtyPolicyInput,
  buildTerminalScriptPolicyInput,
  buildTerminalShellPolicyInput,
  evaluateTerminalCommandPolicy,
  evaluateTerminalPtyPolicy,
  evaluateTerminalScriptPolicy,
  evaluateTerminalShellPolicy,
} from '../../lib/tools/adapters/TerminalCommandPolicy.js';

function policyInput(overrides = {}) {
  return {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    env: {},
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    timeoutMs: 30_000,
    network: 'none' as const,
    filesystem: 'read-only' as const,
    interactive: 'never' as const,
    session: {
      mode: 'ephemeral' as const,
      id: null,
      cwdPersistence: 'none' as const,
      envPersistence: 'none' as const,
      processPersistence: 'none' as const,
    },
    ...overrides,
  };
}

function scriptPolicyInput(overrides = {}) {
  return {
    script: 'printf "ok"',
    scriptHash: 'hash',
    lineCount: 1,
    byteLength: 11,
    shell: '/bin/sh' as const,
    env: {},
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    timeoutMs: 30_000,
    network: 'none' as const,
    filesystem: 'read-only' as const,
    interactive: 'never' as const,
    ...overrides,
  };
}

function shellPolicyInput(overrides = {}) {
  return {
    command: 'printf "ok"',
    commandHash: 'hash',
    lineCount: 1,
    byteLength: 11,
    shell: '/bin/sh' as const,
    env: {},
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    timeoutMs: 30_000,
    network: 'none' as const,
    filesystem: 'read-only' as const,
    interactive: 'never' as const,
    ...overrides,
  };
}

describe('TerminalCommandPolicy', () => {
  test('allows structured read-only commands and returns an approval preview', () => {
    const decision = evaluateTerminalCommandPolicy(policyInput());

    expect(decision).toMatchObject({
      allowed: true,
      risk: 'medium',
      preview: {
        command: `${process.execPath} -e "process.stdout.write(\\"ok\\")"`,
        cwd: process.cwd(),
        env: {
          keys: [],
          persistence: 'none',
        },
        network: 'none',
        filesystem: 'read-only',
        interactive: 'never',
        session: {
          mode: 'ephemeral',
          id: null,
          cwdPersistence: 'none',
          envPersistence: 'none',
          processPersistence: 'none',
        },
      },
    });
  });

  test('blocks shell executables', () => {
    const decision = evaluateTerminalCommandPolicy(
      policyInput({ bin: 'bash', args: ['-lc', 'ls'] })
    );

    expect(decision).toMatchObject({
      allowed: false,
      matchedRule: 'shell-bin',
      reason: expect.stringContaining('shell execution'),
      risk: 'low',
    });
  });

  test('blocks recursive force remove', () => {
    const decision = evaluateTerminalCommandPolicy(
      policyInput({ bin: 'rm', args: ['-rf', '/tmp/a'] })
    );

    expect(decision).toMatchObject({
      allowed: false,
      matchedRule: 'rm-recursive-force',
      risk: 'high',
    });
  });

  test('blocks open network and workspace-wide writes in v1', () => {
    expect(evaluateTerminalCommandPolicy(policyInput({ network: 'open' }))).toMatchObject({
      allowed: false,
      matchedRule: 'network-open',
    });
    expect(
      evaluateTerminalCommandPolicy(policyInput({ filesystem: 'workspace-write' }))
    ).toMatchObject({
      allowed: false,
      matchedRule: 'workspace-write',
    });
  });

  test('blocks commands declared as interactive', () => {
    const decision = evaluateTerminalCommandPolicy(policyInput({ interactive: 'allowed' }));

    expect(decision).toMatchObject({
      allowed: false,
      matchedRule: 'interactive-command',
      reason: expect.stringContaining('Interactive terminal commands'),
      risk: 'high',
      preview: {
        interactive: 'allowed',
      },
    });
  });

  test('allows structured persistent execFile sessions with high risk', () => {
    const decision = evaluateTerminalCommandPolicy(
      policyInput({
        session: {
          mode: 'persistent',
          id: 'build-session',
          cwdPersistence: 'none',
          envPersistence: 'none',
          processPersistence: 'none',
        },
      })
    );

    expect(decision).toMatchObject({
      allowed: true,
      risk: 'high',
      preview: {
        session: {
          mode: 'persistent',
          id: 'build-session',
        },
      },
    });
  });

  test('allows explicit environment persistence in persistent sessions', () => {
    const decision = evaluateTerminalCommandPolicy(
      policyInput({
        env: { ALEMBIC_ENV_TEST: 'value' },
        session: {
          mode: 'persistent',
          id: 'env-build',
          cwdPersistence: 'none',
          envPersistence: 'explicit',
          processPersistence: 'none',
        },
      })
    );

    expect(decision).toMatchObject({
      allowed: true,
      risk: 'high',
      preview: {
        env: {
          keys: ['ALEMBIC_ENV_TEST'],
          persistence: 'explicit',
        },
        session: {
          envPersistence: 'explicit',
        },
      },
    });
    expect(JSON.stringify(decision.preview)).not.toContain('value');
  });

  test('blocks sensitive-looking environment variables from persistence', () => {
    const decision = evaluateTerminalCommandPolicy(
      policyInput({
        env: { API_TOKEN: 'secret' },
        session: {
          mode: 'persistent',
          id: 'env-secret',
          cwdPersistence: 'none',
          envPersistence: 'explicit',
          processPersistence: 'none',
        },
      })
    );

    expect(decision).toMatchObject({
      allowed: false,
      matchedRule: 'env-persistence-sensitive-key',
      reason: expect.stringContaining('Sensitive-looking environment variables'),
      risk: 'high',
    });
  });

  test('rejects invalid session descriptors before policy evaluation', () => {
    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          session: { mode: 'ephemeral', id: '../bad' },
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('session.id'),
    });
  });

  test('requires session.id for persistent sessions', () => {
    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          session: { mode: 'persistent' },
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('persistent sessions require session.id'),
    });
  });

  test('requires persistent sessions for explicit env persistence', () => {
    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          session: { mode: 'ephemeral', envPersistence: 'explicit' },
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('requires a persistent session'),
    });
  });

  test('rejects invalid interactivity descriptors before policy evaluation', () => {
    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          interactive: 'prompt',
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('interactive'),
    });
  });

  test('rejects invalid env descriptors before policy evaluation', () => {
    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          env: { 'bad-key': 'value' },
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('env key'),
    });

    expect(
      buildTerminalCommandPolicyInput(
        {
          bin: process.execPath,
          env: { PAGER: 'less' },
        },
        process.cwd()
      )
    ).toEqual({
      ok: false,
      error: expect.stringContaining('controlled by policy'),
    });
  });

  test('builds terminal_script policy input with hash-only preview metadata', () => {
    const built = buildTerminalScriptPolicyInput(
      {
        script: 'printf "script-ok"',
        env: { ALEMBIC_SCRIPT_ENV: 'hidden' },
        filesystem: 'project-write',
      },
      process.cwd()
    );

    expect(built).toMatchObject({
      ok: true,
      input: {
        shell: '/bin/sh',
        lineCount: 1,
        env: { ALEMBIC_SCRIPT_ENV: 'hidden' },
        filesystem: 'project-write',
      },
    });
    if (!built.ok) {
      throw new Error('terminal_script input did not build');
    }
    const decision = evaluateTerminalScriptPolicy(built.input);
    expect(decision).toMatchObject({
      allowed: true,
      risk: 'high',
      preview: {
        shell: '/bin/sh',
        scriptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        env: {
          keys: ['ALEMBIC_SCRIPT_ENV'],
          persistence: 'none',
        },
      },
    });
    expect(JSON.stringify(decision.preview)).not.toContain('script-ok');
    expect(JSON.stringify(decision.preview)).not.toContain('hidden');
  });

  test('blocks dangerous terminal_script content and unsafe intents', () => {
    expect(
      evaluateTerminalScriptPolicy(scriptPolicyInput({ script: 'rm -rf ./dist' }))
    ).toMatchObject({
      allowed: false,
      matchedRule: 'script-rm-recursive-force',
      risk: 'high',
    });
    expect(evaluateTerminalScriptPolicy(scriptPolicyInput({ network: 'open' }))).toMatchObject({
      allowed: false,
      matchedRule: 'network-open',
    });
    expect(
      evaluateTerminalScriptPolicy(scriptPolicyInput({ filesystem: 'workspace-write' }))
    ).toMatchObject({
      allowed: false,
      matchedRule: 'workspace-write',
    });
    expect(
      evaluateTerminalScriptPolicy(scriptPolicyInput({ env: { API_TOKEN: 'secret' } }))
    ).toMatchObject({
      allowed: false,
      matchedRule: 'script-sensitive-env-key',
    });
  });

  test('builds terminal_shell policy input with redacted preview metadata', () => {
    const built = buildTerminalShellPolicyInput(
      {
        command: 'printf "shell-ok" | cat',
        env: { ALEMBIC_SHELL_ENV: 'hidden' },
        filesystem: 'project-write',
      },
      process.cwd()
    );

    expect(built).toMatchObject({
      ok: true,
      input: {
        shell: '/bin/sh',
        command: 'printf "shell-ok" | cat',
        filesystem: 'project-write',
      },
    });
    if (!built.ok) {
      throw new Error('terminal_shell input did not build');
    }
    const decision = evaluateTerminalShellPolicy(built.input);
    expect(decision).toMatchObject({
      allowed: true,
      risk: 'high',
      preview: {
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        env: {
          keys: ['ALEMBIC_SHELL_ENV'],
          persistence: 'none',
        },
      },
    });
    expect(JSON.stringify(decision.preview)).not.toContain('shell-ok');
    expect(JSON.stringify(decision.preview)).not.toContain('hidden');
  });

  test('blocks terminal_shell interactive and dangerous shell payloads', () => {
    expect(evaluateTerminalShellPolicy(shellPolicyInput({ interactive: 'allowed' }))).toMatchObject(
      {
        allowed: false,
        matchedRule: 'shell-interactive-command',
      }
    );
    expect(
      evaluateTerminalShellPolicy(shellPolicyInput({ command: 'rm -rf ./dist' }))
    ).toMatchObject({
      allowed: false,
      matchedRule: 'shell-rm-recursive-force',
    });
    expect(evaluateTerminalShellPolicy(shellPolicyInput({ network: 'open' }))).toMatchObject({
      allowed: false,
      matchedRule: 'network-open',
    });
  });

  test('builds terminal_pty policy input for observation-only PTY sessions', () => {
    const built = buildTerminalPtyPolicyInput(
      {
        command: 'printf "pty-ok"',
        rows: 30,
        cols: 100,
      },
      process.cwd()
    );

    expect(built).toMatchObject({
      ok: true,
      input: {
        shell: '/bin/sh',
        interactive: 'allowed',
        pty: {
          rows: 30,
          cols: 100,
          stdin: 'disabled',
          wrapper: 'python-pty',
        },
      },
    });
    if (!built.ok) {
      throw new Error('terminal_pty input did not build');
    }
    expect(evaluateTerminalPtyPolicy(built.input)).toMatchObject({
      allowed: true,
      risk: 'high',
      preview: {
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        pty: {
          stdin: 'disabled',
          wrapper: 'python-pty',
        },
      },
    });
  });

  test('builds terminal_pty policy input with redacted bounded stdin metadata', () => {
    const built = buildTerminalPtyPolicyInput(
      {
        command: 'cat',
        stdin: 'pty-stdin-secret\n',
      },
      process.cwd()
    );

    expect(built).toMatchObject({
      ok: true,
      input: {
        stdin: 'pty-stdin-secret\n',
        pty: {
          stdin: 'provided',
          stdinHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          stdinLineCount: 2,
          stdinByteLength: 17,
        },
      },
    });
    if (!built.ok) {
      throw new Error('terminal_pty input did not build');
    }
    const decision = evaluateTerminalPtyPolicy(built.input);
    expect(decision).toMatchObject({
      allowed: true,
      preview: {
        pty: {
          stdin: 'provided',
          stdinHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.stringify(decision.preview)).not.toContain('pty-stdin-secret');
  });

  test('blocks unsafe terminal_pty payloads and invalid dimensions', () => {
    expect(
      evaluateTerminalPtyPolicy({
        ...shellPolicyInput({ command: 'eval "$X"' }),
        stdin: '',
        pty: {
          rows: 24,
          cols: 80,
          stdin: 'disabled' as const,
          wrapper: 'python-pty' as const,
        },
      })
    ).toMatchObject({
      allowed: false,
      matchedRule: 'pty-eval',
    });
    expect(
      evaluateTerminalPtyPolicy({
        ...shellPolicyInput({ command: 'cat' }),
        stdin: 'rm -rf ./dist',
        pty: {
          rows: 24,
          cols: 80,
          stdin: 'provided' as const,
          stdinHash: 'hash',
          stdinLineCount: 1,
          stdinByteLength: 13,
          wrapper: 'python-pty' as const,
        },
      })
    ).toMatchObject({
      allowed: false,
      matchedRule: 'pty-rm-recursive-force-stdin',
    });
    expect(buildTerminalPtyPolicyInput({ command: 'printf ok', rows: 0 }, process.cwd())).toEqual({
      ok: false,
      error: expect.stringContaining('rows'),
    });
  });
});
