import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSandboxProfile,
  getConfiguredAllowedDomains,
  getExtraReadPaths,
  getSandboxMode,
  summarizeSandboxProfile,
} from '../../lib/sandbox/SandboxPolicy.js';

describe('getSandboxMode', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('defaults to enforce when unset', () => {
    delete process.env.ALEMBIC_SANDBOX_MODE;
    expect(getSandboxMode()).toBe('enforce');
  });

  it('returns disabled for "disabled"', () => {
    process.env.ALEMBIC_SANDBOX_MODE = 'disabled';
    expect(getSandboxMode()).toBe('disabled');
  });

  it('returns disabled for "0"', () => {
    process.env.ALEMBIC_SANDBOX_MODE = '0';
    expect(getSandboxMode()).toBe('disabled');
  });

  it('returns disabled for "off"', () => {
    process.env.ALEMBIC_SANDBOX_MODE = 'OFF';
    expect(getSandboxMode()).toBe('disabled');
  });

  it('returns audit for "audit"', () => {
    process.env.ALEMBIC_SANDBOX_MODE = 'audit';
    expect(getSandboxMode()).toBe('audit');
  });

  it('returns enforce for anything else', () => {
    process.env.ALEMBIC_SANDBOX_MODE = 'whatever';
    expect(getSandboxMode()).toBe('enforce');
  });
});

describe('getConfiguredAllowedDomains', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns empty when unset', () => {
    delete process.env.ALEMBIC_SANDBOX_ALLOWED_DOMAINS;
    expect(getConfiguredAllowedDomains()).toEqual([]);
  });

  it('parses comma-separated list', () => {
    process.env.ALEMBIC_SANDBOX_ALLOWED_DOMAINS = 'github.com, npmjs.org, example.com';
    expect(getConfiguredAllowedDomains()).toEqual(['github.com', 'npmjs.org', 'example.com']);
  });
});

describe('getExtraReadPaths', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns empty when unset', () => {
    delete process.env.ALEMBIC_SANDBOX_EXTRA_READ_PATHS;
    expect(getExtraReadPaths()).toEqual([]);
  });

  it('parses comma-separated paths', () => {
    process.env.ALEMBIC_SANDBOX_EXTRA_READ_PATHS = '/opt/sdk, /opt/tools';
    expect(getExtraReadPaths()).toEqual(['/opt/sdk', '/opt/tools']);
  });
});

describe('buildSandboxProfile', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALEMBIC_SANDBOX_MODE = 'enforce';
    process.env.HOME = '/Users/test';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns disabled profile when mode is disabled', () => {
    process.env.ALEMBIC_SANDBOX_MODE = 'disabled';
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.mode).toBe('disabled');
  });

  it('creates enforce profile with correct structure', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 60_000,
    });
    expect(profile.mode).toBe('enforce');
    expect(profile.network.allow).toBe(false);
    expect(profile.filesystem.readPaths).toContain('/project');
    expect(profile.filesystem.writePaths).toHaveLength(1);
    expect(profile.filesystem.tempDir).toBeTruthy();
    expect(profile.environment.inject.SANDBOX).toBe('1');
    expect(profile.limits.timeoutMs).toBe(60_000);
  });

  it('adds projectRoot to writePaths for project-write', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'project-write',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.writePaths).toContain('/project');
  });

  it('allows network for allowlisted intent', () => {
    process.env.ALEMBIC_SANDBOX_ALLOWED_DOMAINS = 'github.com';
    const profile = buildSandboxProfile({
      network: 'allowlisted',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.network.allow).toBe(true);
    expect(profile.network.allowedDomains).toContain('github.com');
  });

  it('denies paths for sensitive directories', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.denyPaths).toContain('/Users/test/.ssh');
    expect(profile.filesystem.denyPaths).toContain('/Users/test/.aws');
    expect(profile.filesystem.denyPaths).toContain('/project/.env');
    expect(profile.filesystem.denyPaths).toContain('/project/.git');
  });

  it('strips sensitive env vars', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.environment.strip).toContain('OPENAI_API_KEY');
    expect(profile.environment.strip).toContain('SSH_AUTH_SOCK');
    expect(profile.environment.strip).toContain('GITHUB_TOKEN');
  });

  it('includes extra read paths from config', () => {
    process.env.ALEMBIC_SANDBOX_EXTRA_READ_PATHS = '/opt/custom-sdk';
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.readPaths).toContain('/opt/custom-sdk');
  });

  it('includes default Homebrew paths when HOMEBREW_PREFIX is unset', () => {
    delete process.env.HOMEBREW_PREFIX;
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.readPaths).toContain('/opt/homebrew');
    expect(profile.filesystem.readPaths).toContain('/usr/local');
  });

  it('uses HOMEBREW_PREFIX when set (Apple Silicon)', () => {
    process.env.HOMEBREW_PREFIX = '/opt/homebrew';
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.readPaths).toContain('/opt/homebrew');
    expect(profile.filesystem.readPaths).not.toContain('/usr/local');
  });

  it('uses HOMEBREW_PREFIX when set (Intel Mac)', () => {
    process.env.HOMEBREW_PREFIX = '/usr/local';
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.filesystem.readPaths).toContain('/usr/local');
    expect(profile.filesystem.readPaths).not.toContain('/opt/homebrew');
  });

  it('sets proxyPort = -1 for allowlisted network with domains', () => {
    process.env.ALEMBIC_SANDBOX_ALLOWED_DOMAINS = 'registry.npmjs.org,github.com';
    const profile = buildSandboxProfile({
      network: 'allowlisted',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.network.proxyPort).toBe(-1);
    expect(profile.network.allowedDomains).toEqual(['registry.npmjs.org', 'github.com']);
  });

  it('does not set proxyPort for network=none', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    expect(profile.network.proxyPort).toBeUndefined();
  });
});

describe('summarizeSandboxProfile', () => {
  it('returns audit-friendly summary', () => {
    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'read-only',
      cwd: '/project',
      projectRoot: '/project',
      timeoutMs: 30_000,
    });
    const summary = summarizeSandboxProfile(profile);
    expect(summary.mode).toBe('enforce');
    expect(summary.networkAllow).toBe(false);
    expect(typeof summary.filesystemWritePaths).toBe('number');
    expect(typeof summary.envStripped).toBe('number');
  });
});
