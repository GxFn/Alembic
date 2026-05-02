import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSandboxEnvironment,
  buildTerminalEnvironmentWithSandbox,
} from '../../lib/sandbox/SandboxEnvironment.js';
import type { SandboxProfile } from '../../lib/sandbox/SandboxPolicy.js';

function makeProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    mode: 'enforce',
    filesystem: {
      readPaths: [],
      writePaths: [],
      denyPaths: [],
      tempDir: '/tmp/sb',
    },
    network: { allow: false, allowedDomains: [] },
    environment: {
      passthrough: ['PATH', 'LANG'],
      inject: { HOME: '/tmp/sb', SANDBOX: '1' },
      strip: ['OPENAI_API_KEY', 'SSH_AUTH_SOCK'],
    },
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    ...overrides,
  };
}

describe('buildSandboxEnvironment', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.LANG = 'en_US.UTF-8';
    process.env.OPENAI_API_KEY = 'sk-secret';
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent';
    process.env.HOME = '/Users/test';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('only passes through whitelisted env vars', () => {
    const result = buildSandboxEnvironment({}, makeProfile());
    expect(result.PATH).toBe('/usr/bin:/bin');
    expect(result.LANG).toBe('en_US.UTF-8');
    expect(result.HOME).toBe('/tmp/sb');
  });

  it('strips sensitive env vars even if they appear in commandEnv', () => {
    const result = buildSandboxEnvironment({ OPENAI_API_KEY: 'sk-from-command' }, makeProfile());
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('injects sandbox-level vars', () => {
    const result = buildSandboxEnvironment({}, makeProfile());
    expect(result.SANDBOX).toBe('1');
    expect(result.HOME).toBe('/tmp/sb');
  });

  it('merges commandEnv (non-stripped)', () => {
    const result = buildSandboxEnvironment({ MY_VAR: 'hello' }, makeProfile());
    expect(result.MY_VAR).toBe('hello');
  });

  it('does not include non-whitelisted host env vars', () => {
    process.env.SECRET_KEY = 'very-secret';
    const result = buildSandboxEnvironment({}, makeProfile());
    expect(result.SECRET_KEY).toBeUndefined();
  });
});

describe('buildTerminalEnvironmentWithSandbox', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.PATH = '/usr/bin';
    process.env.OPENAI_API_KEY = 'sk-test';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('falls back to full host env when profile is null', () => {
    const result = buildTerminalEnvironmentWithSandbox(process.env, { FOO: 'bar' }, null);
    expect(result.PATH).toBe('/usr/bin');
    expect(result.FOO).toBe('bar');
    expect(result.OPENAI_API_KEY).toBe('sk-test');
    expect(result.CI).toBe('1');
  });

  it('falls back to full host env when profile is disabled', () => {
    const disabled: SandboxProfile = {
      ...makeProfile(),
      mode: 'disabled',
    };
    const result = buildTerminalEnvironmentWithSandbox(process.env, { FOO: 'bar' }, disabled);
    expect(result.OPENAI_API_KEY).toBe('sk-test');
  });

  it('uses sandbox env when profile is enforce', () => {
    const result = buildTerminalEnvironmentWithSandbox(process.env, { FOO: 'bar' }, makeProfile());
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.FOO).toBe('bar');
    expect(result.SANDBOX).toBe('1');
  });
});
