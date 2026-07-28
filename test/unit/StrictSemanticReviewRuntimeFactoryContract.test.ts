import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const factorySource = await readFile(
  fileURLToPath(
    new URL(
      '../../lib/service/semantic-review/StrictSemanticReviewRuntimeFactory.ts',
      import.meta.url
    )
  ),
  'utf8'
);

describe('StrictSemanticReviewRuntimeFactory public contract', () => {
  test('consumes createProjectContextFileRef from the project-context facade only', () => {
    const helperImportRoutes = [
      ...factorySource.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g),
    ]
      .filter(([, importedNames]) => importedNames.includes('createProjectContextFileRef'))
      .map(([, , moduleSpecifier]) => moduleSpecifier);

    expect(helperImportRoutes).toEqual(['@alembic/core/project-context']);
  });
});
