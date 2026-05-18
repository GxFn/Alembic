import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const repoRoot = join(import.meta.dirname, '..');

export function resolveWorkspaceSource({ name, localRelative, vendorRelative, requiredFile }) {
  const candidates = [
    { kind: 'local', root: join(repoRoot, localRelative), relativePath: localRelative },
    { kind: 'vendor', root: join(repoRoot, vendorRelative), relativePath: vendorRelative },
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate.root, requiredFile))) {
      return {
        ...candidate,
        displayPath: relative(repoRoot, candidate.root) || '.',
      };
    }
  }

  throw new Error(
    `Missing ${name} source. Expected ${localRelative}/${requiredFile} or ${vendorRelative}/${requiredFile}.`
  );
}
