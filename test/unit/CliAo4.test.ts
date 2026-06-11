import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('AO4 CLI suite', () => {
  test('package manifest exposes the compiled Alembic CLI entrypoint', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.bin).toMatchObject({
      alembic: 'dist/bin/cli.js',
    });
    expect(packageJson.files).toContain('dist');
  });

  test('source CLI keeps the owned runtime commands wired through commander', () => {
    const source = readFileSync(join(repoRoot, 'bin', 'cli.ts'), 'utf8');

    expect(source).toContain("program.name('alembic')");
    expect(source).toContain(".command('start [target]')");
    expect(source).toContain(".command('daemon')");
    expect(source).toContain(".command('status')");
    expect(source).toContain('program.parse(process.argv)');
  });
});
