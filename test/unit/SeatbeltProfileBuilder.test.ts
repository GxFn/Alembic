import { describe, expect, it } from 'vitest';
import type { SandboxProfile } from '../../lib/sandbox/SandboxPolicy.js';
import { buildSeatbeltProfile } from '../../lib/sandbox/SeatbeltProfileBuilder.js';

function makeProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    mode: 'enforce',
    filesystem: {
      readPaths: ['/project', '/usr/lib'],
      writePaths: ['/tmp/sandbox-abc'],
      denyPaths: ['/Users/me/.ssh', '/Users/me/.aws'],
      tempDir: '/tmp/sandbox-abc',
    },
    network: { allow: false, allowedDomains: [] },
    environment: {
      passthrough: ['PATH'],
      inject: { HOME: '/tmp/sandbox-abc', SANDBOX: '1' },
      strip: ['OPENAI_API_KEY'],
    },
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    ...overrides,
  };
}

describe('buildSeatbeltProfile', () => {
  it('starts with (version 1) and (deny default)', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    const lines = sbpl.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
  });

  it('includes deny rules for denyPaths', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    expect(sbpl).toContain('(deny file-read* (subpath "/Users/me/.ssh"))');
    expect(sbpl).toContain('(deny file-write* (subpath "/Users/me/.ssh"))');
    expect(sbpl).toContain('(deny file-read* (subpath "/Users/me/.aws"))');
  });

  it('allows all reads globally (deny-list model)', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    expect(sbpl).toContain('(allow file-read*)');
  });

  it('includes allow write rules for writePaths', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    expect(sbpl).toContain('(allow file-write* (subpath "/tmp/sandbox-abc"))');
  });

  it('denies sensitive paths before global read allow', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    const denyIdx = sbpl.indexOf('(deny file-read* (subpath "/Users/me/.ssh"))');
    const allowIdx = sbpl.indexOf('(allow file-read*)');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeLessThan(allowIdx);
  });

  it('denies network-outbound when network.allow is false', () => {
    const sbpl = buildSeatbeltProfile(
      makeProfile({ network: { allow: false, allowedDomains: [] } })
    );
    expect(sbpl).toContain('(deny network-outbound)');
    expect(sbpl).toContain('(allow network-outbound (local udp "*:53"))');
  });

  it('allows network-outbound when network.allow is true and no proxy', () => {
    const sbpl = buildSeatbeltProfile(
      makeProfile({ network: { allow: true, allowedDomains: [] } })
    );
    expect(sbpl).toContain('(allow network-outbound)');
    expect(sbpl).not.toContain('(deny network-outbound)');
  });

  it('restricts to proxy port when proxyPort is set', () => {
    const sbpl = buildSeatbeltProfile(
      makeProfile({ network: { allow: true, proxyPort: 18080, allowedDomains: ['github.com'] } })
    );
    expect(sbpl).toContain('(deny network-outbound)');
    expect(sbpl).toContain('(allow network-outbound (remote tcp "localhost:18080"))');
  });

  it('always denies network-inbound', () => {
    const sbpl = buildSeatbeltProfile(
      makeProfile({ network: { allow: true, allowedDomains: [] } })
    );
    expect(sbpl).toContain('(deny network-inbound)');
  });

  it('allows base system access (process, mach, ipc, sysctl wildcards)', () => {
    const sbpl = buildSeatbeltProfile(makeProfile());
    expect(sbpl).toContain('(allow process*)');
    expect(sbpl).toContain('(allow mach*)');
    expect(sbpl).toContain('(allow ipc*)');
    expect(sbpl).toContain('(allow sysctl*)');
  });

  it('escapes backslashes and quotes in paths', () => {
    const profile = makeProfile({
      filesystem: {
        readPaths: [],
        writePaths: ['/path/with\\backslash'],
        denyPaths: ['/path/with "quotes"'],
        tempDir: '/tmp/x',
      },
    });
    const sbpl = buildSeatbeltProfile(profile);
    expect(sbpl).toContain('(deny file-read* (subpath "/path/with \\"quotes\\""))');
    expect(sbpl).toContain('(allow file-write* (subpath "/path/with\\\\backslash"))');
  });

  it('skips empty paths in deny and write lists', () => {
    const profile = makeProfile({
      filesystem: {
        readPaths: [],
        writePaths: ['', '/valid-write'],
        denyPaths: [''],
        tempDir: '/tmp/x',
      },
    });
    const sbpl = buildSeatbeltProfile(profile);
    expect(sbpl).toContain('(allow file-write* (subpath "/valid-write"))');
    const lines = sbpl.split('\n');
    const emptySubpathLines = lines.filter((l) => l.includes('(subpath "")'));
    expect(emptySubpathLines).toHaveLength(0);
  });
});
