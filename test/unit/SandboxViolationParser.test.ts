import { describe, expect, it } from 'vitest';
import {
  parseSandboxViolations,
  summarizeViolations,
} from '../../lib/sandbox/SandboxViolationParser.js';

describe('parseSandboxViolations', () => {
  it('parses a single file-write violation', () => {
    const stderr = 'sandbox: touch(1234) deny(1) file-write-create /tmp/test.txt';
    const violations = parseSandboxViolations(stderr);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      process: 'touch',
      pid: 1234,
      operation: 'file-write-create',
      path: '/tmp/test.txt',
      raw: stderr,
    });
  });

  it('parses multiple violations', () => {
    const stderr = [
      'sandbox: curl(5678) deny(1) network-outbound 93.184.216.34:443',
      'some other output',
      'sandbox: touch(5679) deny(1) file-write-create /etc/passwd',
    ].join('\n');
    const violations = parseSandboxViolations(stderr);
    expect(violations).toHaveLength(2);
    expect(violations[0].operation).toBe('network-outbound');
    expect(violations[1].operation).toBe('file-write-create');
  });

  it('handles violation without path', () => {
    const stderr = 'sandbox: node(9999) deny(1) network-outbound';
    const violations = parseSandboxViolations(stderr);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBeUndefined();
  });

  it('returns empty array for clean stderr', () => {
    const violations = parseSandboxViolations('normal error output\nno sandbox issues here');
    expect(violations).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    expect(parseSandboxViolations('')).toHaveLength(0);
  });
});

describe('summarizeViolations', () => {
  it('groups by operation', () => {
    const violations = [
      { process: 'a', pid: 1, operation: 'file-write-create', path: '/a', raw: '' },
      { process: 'b', pid: 2, operation: 'file-write-create', path: '/b', raw: '' },
      { process: 'c', pid: 3, operation: 'network-outbound', path: undefined, raw: '' },
    ];
    const summary = summarizeViolations(violations);
    expect(summary.count).toBe(3);
    expect(summary.operations['file-write-create']).toBe(2);
    expect(summary.operations['network-outbound']).toBe(1);
    expect(summary.paths).toEqual(['/a', '/b']);
  });

  it('caps paths at 10', () => {
    const violations = Array.from({ length: 20 }, (_, i) => ({
      process: 'p',
      pid: i,
      operation: 'file-read',
      path: `/path/${i}`,
      raw: '',
    }));
    const summary = summarizeViolations(violations);
    expect(summary.paths).toHaveLength(10);
    expect(summary.count).toBe(20);
  });

  it('handles empty violations', () => {
    const summary = summarizeViolations([]);
    expect(summary.count).toBe(0);
    expect(summary.operations).toEqual({});
    expect(summary.paths).toEqual([]);
  });
});
