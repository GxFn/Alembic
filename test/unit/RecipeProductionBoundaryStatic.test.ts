import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ALEMBIC_PROVIDER_ROUTE_CONTRACTS } from '../../lib/http/provider-contracts.js';

const repoRoot = process.cwd();

describe('Recipe production static boundary', () => {
  test('product code has no direct KnowledgeService create or AiScan auto-publish bypass', async () => {
    const productSources = await sourceFiles(path.join(repoRoot, 'lib'));
    const contents = await Promise.all(productSources.map((file) => fs.readFile(file, 'utf8')));
    const directCreates = productSources.filter((_file, index) =>
      /knowledgeService\s*\.\s*create\s*\(/.test(contents[index])
    );
    expect(directCreates).toEqual([]);

    const aiScan = await fs.readFile(path.join(repoRoot, 'lib/cli/AiScanService.ts'), 'utf8');
    expect(aiScan).not.toMatch(/knowledgeService|\.publish\s*\(/);
    expect(aiScan).toContain("args.action !== 'submit'");
  });

  test('only supported workflows create candidates and legacy POST is not a provider capability', async () => {
    for (const relativePath of [
      'lib/recipe-pipeline/generate/ColdStartWorkflow.ts',
      'lib/recipe-pipeline/generate/incremental/IncrementalRescanWorkflow.ts',
    ]) {
      const source = await fs.readFile(path.join(repoRoot, relativePath), 'utf8');
      expect(source).toContain('runGenerateWorkflow');
      expect(source).not.toMatch(
        /knowledgeService\s*\.\s*create|recipeProductionGateway\s*\.\s*create/
      );
    }
    expect(
      ALEMBIC_PROVIDER_ROUTE_CONTRACTS.find(
        (route) => route.method === 'post' && route.path === '/knowledge'
      )
    ).toBeUndefined();
  });

  test('resident search entrypoint contains no generation writer or maintenance call', async () => {
    const search = await fs.readFile(path.join(repoRoot, 'lib/http/routes/search.ts'), 'utf8');
    expect(search).not.toMatch(
      /recipeVectorGenerationRuntime|buildRecipeRetrievalGeneration|syncRecipeSemanticRegions|reconcileIndex/
    );
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
    })
  );
  return nested.flat();
}
