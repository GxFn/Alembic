import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SandboxExecOptions, sandboxExec } from '../../lib/sandbox/SandboxExecutor.js';
import { buildSandboxProfile, type SandboxProfile } from '../../lib/sandbox/SandboxPolicy.js';
import { isSandboxExecAvailable } from '../../lib/sandbox/SandboxProbe.js';

let PROJECT_ROOT = '';

beforeEach(async () => {
  const realTmp = await fs.realpath(os.tmpdir());
  PROJECT_ROOT = path.join(realTmp, `alembic-sandbox-test-${Date.now()}`);
  await fs.mkdir(PROJECT_ROOT, { recursive: true });
  await fs.writeFile(path.join(PROJECT_ROOT, 'hello.txt'), 'world\n');
});

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true }).catch(() => {});
});

function makeOptions(bin: string, args: string[]): SandboxExecOptions {
  return {
    bin,
    args,
    cwd: PROJECT_ROOT,
    env: {},
    timeout: 10_000,
    maxBuffer: 1_048_576,
  };
}

function makeProfile(
  overrides: Partial<Parameters<typeof buildSandboxProfile>[0]> = {}
): SandboxProfile {
  const origMode = process.env.ALEMBIC_SANDBOX_MODE;
  process.env.ALEMBIC_SANDBOX_MODE = 'enforce';
  const profile = buildSandboxProfile({
    network: 'none',
    filesystem: 'read-only',
    cwd: PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
    timeoutMs: 10_000,
    ...overrides,
  });
  if (origMode === undefined) {
    delete process.env.ALEMBIC_SANDBOX_MODE;
  } else {
    process.env.ALEMBIC_SANDBOX_MODE = origMode;
  }
  return profile;
}

describe.runIf(process.platform === 'darwin')('SandboxExecution (macOS)', () => {
  it('can read files inside project root', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const result = await sandboxExec(
      makeOptions('/bin/cat', [path.join(PROJECT_ROOT, 'hello.txt')]),
      makeProfile()
    );
    expect(result.stdout.trim()).toBe('world');
    expect(result.exitCode).toBe(0);
    expect(result.sandboxed).toBe(true);
  });

  it('blocks writing to project root in read-only mode', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const outFile = path.join(PROJECT_ROOT, 'should-not-exist.txt');
    const result = await sandboxExec(
      makeOptions('/usr/bin/touch', [outFile]),
      makeProfile({ filesystem: 'read-only' })
    );
    expect(result.exitCode).not.toBe(0);
    const exists = await fs
      .access(outFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('allows writing to project root in project-write mode', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const outFile = path.join(PROJECT_ROOT, 'written.txt');
    const result = await sandboxExec(
      makeOptions('/usr/bin/touch', [outFile]),
      makeProfile({ filesystem: 'project-write' })
    );
    expect(result.exitCode).toBe(0);
    const exists = await fs
      .access(outFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('blocks network access in network=none mode', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const result = await sandboxExec(
      makeOptions('/usr/bin/curl', ['-s', '--max-time', '3', 'https://httpbin.org/get']),
      makeProfile({ network: 'none' })
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('can run basic shell commands (echo)', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const result = await sandboxExec(makeOptions('/bin/echo', ['hello sandbox']), makeProfile());
    expect(result.stdout.trim()).toBe('hello sandbox');
    expect(result.exitCode).toBe(0);
    expect(result.sandboxed).toBe(true);
  });

  it('can run /bin/sh in sandbox', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const result = await sandboxExec(
      makeOptions('/bin/sh', ['-c', 'echo $SANDBOX']),
      makeProfile()
    );
    expect(result.stdout.trim()).toBe('1');
  });

  it('does not leak OPENAI_API_KEY to sandbox process', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    process.env.OPENAI_API_KEY = 'sk-test-leak';
    try {
      const result = await sandboxExec(
        makeOptions('/bin/sh', ['-c', 'echo "KEY=$OPENAI_API_KEY"']),
        makeProfile()
      );
      expect(result.stdout.trim()).toBe('KEY=');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('falls back gracefully in disabled mode', async () => {
    const origMode = process.env.ALEMBIC_SANDBOX_MODE;
    process.env.ALEMBIC_SANDBOX_MODE = 'disabled';
    try {
      const profile = buildSandboxProfile({
        network: 'none',
        filesystem: 'read-only',
        cwd: PROJECT_ROOT,
        projectRoot: PROJECT_ROOT,
        timeoutMs: 10_000,
      });
      const result = await sandboxExec(makeOptions('/bin/echo', ['disabled mode']), profile);
      expect(result.stdout.trim()).toBe('disabled mode');
      expect(result.sandboxed).toBe(false);
      expect(result.degradeReason).toBe('disabled');
    } finally {
      if (origMode === undefined) {
        delete process.env.ALEMBIC_SANDBOX_MODE;
      } else {
        process.env.ALEMBIC_SANDBOX_MODE = origMode;
      }
    }
  });

  it('degrades for nested-sandbox-conflict binaries', async () => {
    const available = await isSandboxExecAvailable();
    if (!available) {
      return;
    }
    const result = await sandboxExec(makeOptions('/usr/bin/xcrun', ['--version']), makeProfile());
    expect(result.sandboxed).toBe(false);
    expect(result.degradeReason).toBe('nested-sandbox-conflict');
  });
});
