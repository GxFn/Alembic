import { afterEach, describe, expect, it } from 'vitest';
import {
  hasNestedSandboxConflict,
  resetSandboxProbeCache,
} from '../../lib/sandbox/SandboxProbe.js';

describe('hasNestedSandboxConflict', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    resetSandboxProbeCache();
  });

  it('detects xcodebuild as conflict', () => {
    expect(hasNestedSandboxConflict('/usr/bin/xcodebuild')).toBe(true);
  });

  it('detects swift as conflict', () => {
    expect(hasNestedSandboxConflict('/usr/bin/swift')).toBe(true);
  });

  it('detects swiftc as conflict', () => {
    expect(hasNestedSandboxConflict('swiftc')).toBe(true);
  });

  it('detects xcrun as conflict', () => {
    expect(hasNestedSandboxConflict('/usr/bin/xcrun')).toBe(true);
  });

  it('does not flag ls', () => {
    expect(hasNestedSandboxConflict('/bin/ls')).toBe(false);
  });

  it('does not flag node', () => {
    expect(hasNestedSandboxConflict('/usr/local/bin/node')).toBe(false);
  });

  it('does not flag git', () => {
    expect(hasNestedSandboxConflict('git')).toBe(false);
  });

  it('picks up extra conflict bins from env', () => {
    process.env.ALEMBIC_SANDBOX_NESTED_CONFLICT_BINS = 'my-custom-tool';
    resetSandboxProbeCache();
    expect(hasNestedSandboxConflict('my-custom-tool')).toBe(true);
    expect(hasNestedSandboxConflict('xcodebuild')).toBe(true);
  });
});
