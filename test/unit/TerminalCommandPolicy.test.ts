import { describe, expect, test } from 'vitest';
import {
  buildTerminalCommandPolicyInput,
  evaluateTerminalCommandPolicy,
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
});
