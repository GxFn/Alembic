#!/usr/bin/env node
/**
 * postbuild script: Add shebang lines to compiled bin/ files
 * and set executable permissions.
 *
 * This runs as a plain .mjs file (not compiled by tsc) because it's
 * part of the build pipeline itself.
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const __dirname = import.meta.dirname;
const distBin = join(__dirname, '..', 'dist', 'bin');

const shebang = '#!/usr/bin/env node\n';

const binFiles = ['cli.js', 'mcp-server.js', 'api-server.js'];

for (const file of binFiles) {
  const filePath = join(distBin, file);
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.startsWith('#!')) {
      writeFileSync(filePath, shebang + content);
    }
    chmodSync(filePath, 0o755);
  } catch (err) {
    console.warn(`⚠ ${file}: ${err.message}`);
  }
}
