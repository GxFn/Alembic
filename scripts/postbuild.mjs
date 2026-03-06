#!/usr/bin/env node
/**
 * postbuild script: Add shebang lines to compiled bin/ files
 * and set executable permissions.
 * 
 * This runs as a plain .mjs file (not compiled by tsc) because it's
 * part of the build pipeline itself.
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
    console.log(`✓ ${file}: shebang + chmod`);
  } catch (err) {
    console.warn(`⚠ ${file}: ${err.message}`);
  }
}

console.log('postbuild done.');
