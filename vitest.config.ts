import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sourceImportAliases = new Map([
  ['agent', 'agent'],
  ['codex', 'codex'],
  ['core', 'core'],
  ['domain', 'domain'],
  ['external', 'external'],
  ['http', 'http'],
  ['infra', 'infrastructure'],
  ['inject', 'injection'],
  ['platform', 'platform'],
  ['repo', 'repository'],
  ['sandbox', 'sandbox'],
  ['service', 'service'],
  ['shared', 'shared'],
  ['tools', 'tools'],
  ['types', 'types'],
  ['workflows', 'workflows'],
]);

function resolveSourcePackageImport(source: string): string | null {
  const match = /^#([^/]+)\/(.+)$/.exec(source);
  if (!match) {
    return null;
  }
  const [, alias, subpath] = match;
  const directory = sourceImportAliases.get(alias);
  if (!directory) {
    return null;
  }
  const sourceSubpath = subpath.replace(/\.js$/, '.ts');
  return fileURLToPath(new URL(`./lib/${directory}/${sourceSubpath}`, import.meta.url));
}

export default defineConfig({
  plugins: [
    {
      name: 'alembic-source-package-imports',
      enforce: 'pre',
      resolveId(source) {
        return resolveSourcePackageImport(source);
      },
    },
  ],
  resolve: {
    conditions: ['alembic-dev'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 10000,
    setupFiles: ['test/setup.ts'],
    coverage: {
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/index.ts', 'lib/bootstrap.ts'],
      thresholds: {
        branches: 75,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
});
