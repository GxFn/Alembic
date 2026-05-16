import type { SandboxProfile } from './SandboxPolicy.js';

/**
 * 生成 macOS Seatbelt SBPL profile 字符串。
 *
 * SBPL 规则:
 *   - (version 1) 必须在第一行
 *   - (deny default) 全局默认拒绝
 *   - deny 规则优先于同级 allow（用于 denyPaths 覆盖 readPaths）
 *   - subpath 递归匹配子目录；literal 精确匹配文件
 */
export function buildSeatbeltProfile(profile: SandboxProfile): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    '; ── base system access ──',
    '; process/signal/mach/ipc/sysctl use wildcards because macOS dynamic',
    '; linker and system frameworks require a wide set of these operations.',
    '; Security is enforced via filesystem and network rules below.',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl*)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow system*)',
    '',
  ];

  lines.push('; ── filesystem deny (highest priority) ──');
  for (const p of profile.filesystem.denyPaths) {
    if (!p) {
      continue;
    }
    lines.push(`(deny file-read* (subpath ${sbplQuote(p)}))`);
    lines.push(`(deny file-write* (subpath ${sbplQuote(p)}))`);
  }
  lines.push('');

  lines.push('; ── filesystem read ──');
  lines.push('; Allow all reads globally; sensitive paths are denied above.');
  lines.push('; macOS dyld, frameworks, and toolchains require reading from');
  lines.push('; many scattered system paths that cannot be enumerated reliably.');
  lines.push('(allow file-read*)');
  lines.push('');

  lines.push('; ── filesystem write ──');
  for (const p of profile.filesystem.writePaths) {
    if (!p) {
      continue;
    }
    lines.push(`(allow file-write* (subpath ${sbplQuote(p)}))`);
  }
  lines.push('(allow file-write* (literal "/dev/null"))');
  lines.push('');

  lines.push('; ── network ──');
  if (!profile.network.allow) {
    lines.push('(deny network-outbound)');
    lines.push('(allow network-outbound (local udp "*:53"))');
    lines.push('(allow network-outbound (remote unix-socket))');
  } else if (profile.network.proxyPort && profile.network.proxyPort > 0) {
    lines.push('(deny network-outbound)');
    lines.push('(allow network-outbound (local udp "*:53"))');
    lines.push(`(allow network-outbound (remote tcp "localhost:${profile.network.proxyPort}"))`);
    lines.push('(allow network-outbound (remote unix-socket))');
  } else {
    lines.push('(allow network-outbound)');
  }
  lines.push('(deny network-inbound)');
  lines.push('');

  return lines.join('\n');
}

function sbplQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
