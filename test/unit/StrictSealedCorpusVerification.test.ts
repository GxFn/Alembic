import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { describe, expect, it } from 'vitest';
import { verifyStrictSealedCorpus } from '../../lib/recipe-pipeline/generate/strict/StrictPrivateCorpusRuntime.js';

describe('strict sealed corpus verification', () => {
  it('binds the exact active members, durable refs, sparse evidence, and healthy vector manifest', async () => {
    const input = fixture();
    const verification = await verifyStrictSealedCorpus(input);

    expect(verification).toMatchObject({
      schemaVersion: 1,
      activeRecipeIds: ['recipe-a', 'recipe-b'],
      vectorGenerationId: 'generation-a',
      vectorManifestHash: sha('vector-manifest'),
      verdict: 'pass',
      failedPredicate: null,
    });
    expect(verification.sparseEvidenceHash).toMatch(/^sha256:/u);
    expect(verification.vectorInspectionHash).toMatch(/^sha256:/u);
    expect(verification.verificationHash).toMatch(/^sha256:/u);
    expect(Object.isFrozen(verification)).toBe(true);
  });

  it('fails closed when sparse evidence does not conserve every ready member', async () => {
    const input = fixture();
    input.repository.search = async () => ({ data: [] });
    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:sparse-member-conservation'
    );
  });

  it('fails closed when the vector generation is not exact and healthy', async () => {
    const input = fixture();
    input.vectorInspection.healthy = false;
    await expect(verifyStrictSealedCorpus(input)).rejects.toThrow(
      'STRICT_SEALED_CORPUS_VERIFICATION_FAILED:vector-generation-conservation'
    );
  });
});

function fixture(): Parameters<typeof verifyStrictSealedCorpus>[0] {
  const entries = [
    { id: 'recipe-a', title: 'Strict recovery A', lifecycle: 'active' },
    { id: 'recipe-b', title: 'Strict recovery B', lifecycle: 'active' },
  ];
  const readyMembers = entries.map((entry) => {
    const semantic = {
      schemaVersion: 1 as const,
      recipeId: entry.id,
      title: entry.title,
      runId: 'run-a',
      privateCorpusRevision: 'revision-a',
      analysisFixpointHash: sha('fixpoint'),
      authoredFingerprint: sha(`${entry.id}:fingerprint`),
      bindingHash: sha(`${entry.id}:binding`),
      persistenceReceiptHash: sha(`${entry.id}:persistence`),
      databaseRowHash: sha(`${entry.id}:database`),
      databaseReadbackHash: sha(`${entry.id}:database-readback`),
      fileHash: sha(`${entry.id}:file`),
      fileReadbackHash: sha(`${entry.id}:file-readback`),
      refReconciliationReceiptHash: sha(`${entry.id}:refs`),
      refReadbackHash: sha(`${entry.id}:ref-readback`),
      lifecycle: 'active' as const,
    };
    return { ...semantic, proofHash: hashCanonicalJson(semantic) };
  });
  return {
    activeRecipes: entries,
    readyMembers,
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
    durableReadbackHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        persistenceReceiptHash: member.persistenceReceiptHash,
        databaseRowHash: member.databaseRowHash,
        databaseReadbackHash: member.databaseReadbackHash,
        fileHash: member.fileHash,
        fileReadbackHash: member.fileReadbackHash,
      }))
    ),
    refReadbackHash: hashCanonicalJson(
      readyMembers.map((member) => ({
        recipeId: member.recipeId,
        refReconciliationReceiptHash: member.refReconciliationReceiptHash,
        refReadbackHash: member.refReadbackHash,
      }))
    ),
    vectorGenerationId: 'generation-a',
    vectorManifest: {
      generationId: 'generation-a',
      manifestHash: sha('vector-manifest'),
      status: 'ready' as const,
      recipeCount: 2,
      expectedIds: ['vector-a', 'vector-b'],
      expectedIdsByRecipe: { 'recipe-a': ['vector-a'], 'recipe-b': ['vector-b'] },
    },
    vectorInspection: {
      healthy: true,
      expectedCount: 2,
      presentCount: 2,
      missingIds: [],
      orphanIds: [],
      staleIds: [],
      staleGenerationIds: [],
      duplicateIds: [],
      partialIds: [],
      hashMismatchIds: [],
      dimensionMismatchIds: [],
    },
  } as Parameters<typeof verifyStrictSealedCorpus>[0];
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
