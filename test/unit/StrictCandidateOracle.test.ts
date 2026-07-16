import { describe, expect, it } from 'vitest';
import { runCandidateFiveToolOracle } from '../../lib/recipe-pipeline/generate/strict/StrictPrivateCorpusRuntime.js';

describe('strict candidate five-tool oracle', () => {
  it('executes id, title, active-list, sparse, and vector reads against the candidate root', async () => {
    const input = fixture();
    const oracle = await runCandidateFiveToolOracle(input);

    expect(oracle.checks.map((check) => check.tool)).toEqual([
      'get-by-id',
      'get-by-title',
      'list-active',
      'search-sparse',
      'search-vector',
    ]);
    expect(oracle.checks.every((check) => check.pass)).toBe(true);
    expect(oracle.oracleHash).toMatch(/^sha256:/u);
  });

  it('fails closed when a sparse candidate query cannot retrieve its expected recipe', async () => {
    const input = fixture();
    input.repository.search = async () => ({ data: [] });
    await expect(runCandidateFiveToolOracle(input)).rejects.toThrow(
      'STRICT_CANDIDATE_ORACLE_FAILED:search-sparse'
    );
  });
});

function fixture(): Parameters<typeof runCandidateFiveToolOracle>[0] {
  const entries = [
    { id: 'recipe-a', title: 'Strict recovery A' },
    { id: 'recipe-b', title: 'Strict recovery B' },
  ];
  return {
    activeRecipes: entries,
    embedProvider: {
      async embed() {
        return [1, 0, 0];
      },
    },
    repository: {
      async findById(id: string) {
        return entries.find((entry) => entry.id === id) ?? null;
      },
      async findByTitle(title: string) {
        return entries.find((entry) => entry.title === title) ?? null;
      },
      async findByLifecycle() {
        return { data: entries };
      },
      async search(title: string) {
        return { data: entries.filter((entry) => entry.title === title) };
      },
    },
    vectorStore: {
      async searchVector() {
        return [{ item: { metadata: { recipeId: 'recipe-a' } }, score: 1 }];
      },
    },
  } as Parameters<typeof runCandidateFiveToolOracle>[0];
}
