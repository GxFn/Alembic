import { describe, expect, test, vi } from 'vitest';
import {
  consumeBootstrapCandidateRelations,
  extractBootstrapCandidateRelations,
} from '#workflows/deprecated-cold-start/consumers/BootstrapCandidateRelationConsumer.js';
import type { DimensionCandidateData } from '#workflows/deprecated-cold-start/consumers/BootstrapDimensionConsumer.js';

function createDimensionCandidates(): Record<string, DimensionCandidateData> {
  return {
    api: {
      analysisReport: {} as DimensionCandidateData['analysisReport'],
      producerResult: {
        toolCalls: [
          {
            tool: 'submit_knowledge',
            params: {
              title: 'API contract',
              relations: [{ type: 'depends_on', target: 'Client' }],
            },
          },
          {
            name: 'submit_with_check',
            args: {
              title: 'Validation flow',
            },
          },
          {
            tool: 'note_finding',
            params: { title: 'Ignored' },
          },
        ],
      } as DimensionCandidateData['producerResult'],
    },
  };
}

describe('bootstrap candidate relation consumer', () => {
  test('extracts candidate relation payloads from producer tool calls', () => {
    expect(extractBootstrapCandidateRelations(createDimensionCandidates())).toEqual([
      {
        title: 'API contract',
        relations: [{ type: 'depends_on', target: 'Client' }],
      },
      {
        title: 'Validation flow',
        relations: null,
      },
    ]);
  });

  test('populates code entity graph with extracted relations', async () => {
    const populateFromCandidateRelations = vi.fn(async () => ({ edgesCreated: 2, durationMs: 5 }));
    const CodeEntityGraph = vi.fn().mockImplementation(function MockCodeEntityGraph() {
      return { populateFromCandidateRelations };
    });
    const ctx = {
      container: {
        get: vi.fn((name: string) =>
          name === 'codeEntityRepository'
            ? { kind: 'entity' }
            : name === 'knowledgeEdgeRepository'
              ? { kind: 'edge' }
              : null
        ),
      },
    };

    const result = await consumeBootstrapCandidateRelations({
      ctx,
      projectRoot: '/repo',
      dimensionCandidates: createDimensionCandidates(),
      getCodeEntityGraphClass: async () => CodeEntityGraph as never,
    });

    expect(CodeEntityGraph).toHaveBeenCalledWith(
      { kind: 'entity' },
      { kind: 'edge' },
      expect.objectContaining({ projectRoot: '/repo' })
    );
    expect(populateFromCandidateRelations).toHaveBeenCalledWith([
      expect.objectContaining({ title: 'API contract' }),
      expect.objectContaining({ title: 'Validation flow' }),
    ]);
    expect(result).toEqual({ edgesCreated: 2, durationMs: 5, candidates: 2 });
  });

  test('returns null when repos, candidates, or graph population are unavailable', async () => {
    await expect(
      consumeBootstrapCandidateRelations({
        ctx: { container: { get: () => null } },
        projectRoot: '/repo',
        dimensionCandidates: createDimensionCandidates(),
      })
    ).resolves.toBeNull();

    await expect(
      consumeBootstrapCandidateRelations({
        ctx: { container: { get: () => ({}) } },
        projectRoot: '/repo',
        dimensionCandidates: {},
        getCodeEntityGraphClass: async () => {
          throw new Error('should not load');
        },
      })
    ).resolves.toBeNull();

    await expect(
      consumeBootstrapCandidateRelations({
        ctx: { container: { get: () => ({}) } },
        projectRoot: '/repo',
        dimensionCandidates: createDimensionCandidates(),
        getCodeEntityGraphClass: async () => {
          throw new Error('load failed');
        },
      })
    ).resolves.toBeNull();
  });
});
