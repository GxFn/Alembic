import { describe, expect, test, vi } from 'vitest';
import type { DimensionCandidateData } from '#workflows/bootstrap/consumers/BootstrapDimensionConsumer.js';
import {
  buildEffectiveSkillAnalysisText,
  consumeBootstrapSkills,
  extractSkillKeyFindings,
} from '#workflows/bootstrap/consumers/BootstrapSkillConsumer.js';
import type { SessionStore } from '../../lib/agent/memory/SessionStore.js';
import type { BootstrapEventEmitter } from '../../lib/service/bootstrap/BootstrapEventEmitter.js';

function makeCandidate(analysisText: string): DimensionCandidateData {
  return {
    analysisReport: {
      analysisText,
      referencedFiles: ['src/api.ts'],
      findings: [],
    },
    producerResult: { candidateCount: 0, toolCalls: [] },
  };
}

describe('bootstrap skill consumer', () => {
  test('extracts key findings by importance', () => {
    expect(
      extractSkillKeyFindings({
        findings: [
          { finding: 'low', importance: 1 },
          { finding: 'high', importance: 9 },
        ],
      })
    ).toEqual(['high', 'low']);
  });

  test('synthesizes short skill analysis text from findings and exploration summary', () => {
    const text = buildEffectiveSkillAnalysisText({
      dim: { id: 'api', label: 'API' },
      analysisText: 'short',
      keyFindings: ['finding one'],
      distilled: { toolCallSummary: ['read src/api.ts'] },
    });

    expect(text).toContain('## API');
    expect(text).toContain('1. finding one');
    expect(text).toContain('- read src/api.ts');
  });

  test('creates project skills and emits dimension completion', async () => {
    const generateSkillFn = vi.fn(async () => ({ success: true, skillName: 'project-api' }));
    const emitDimensionComplete = vi.fn();

    const results = await consumeBootstrapSkills({
      ctx: { container: { get: vi.fn() } } as never,
      dimensions: [{ id: 'api', label: 'API', skillWorthy: true }],
      dimensionCandidates: { api: makeCandidate('short') },
      sessionStore: {
        getDimensionReport: () => ({
          findings: [{ finding: 'api finding', importance: 8 }],
          workingMemoryDistilled: { toolCallSummary: ['read_file src/api.ts'] },
        }),
      } as unknown as SessionStore,
      emitter: { emitDimensionComplete } as unknown as BootstrapEventEmitter,
      generateSkillFn: generateSkillFn as never,
    });

    expect(results).toEqual({
      created: 1,
      failed: 0,
      skills: ['project-api'],
      errors: [],
    });
    expect(generateSkillFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'api' }),
      expect.stringContaining('api finding'),
      ['src/api.ts'],
      ['api finding'],
      'bootstrap-v3'
    );
    expect(emitDimensionComplete).toHaveBeenCalledWith('api', {
      type: 'skill',
      skillName: 'project-api',
      sourceCount: 1,
    });
  });

  test('records failed skill generation and respects abort checks', async () => {
    const generateSkillFn = vi.fn(async () => ({
      success: false,
      skillName: 'project-api',
      error: 'too short',
    }));
    const emitDimensionFailed = vi.fn();

    const results = await consumeBootstrapSkills({
      ctx: { container: { get: vi.fn() } } as never,
      dimensions: [
        { id: 'api', skillWorthy: true },
        { id: 'ui', skillWorthy: true },
      ],
      dimensionCandidates: {
        api: makeCandidate('valid analysis '.repeat(20)),
        ui: makeCandidate('valid analysis '.repeat(20)),
      },
      sessionStore: { getDimensionReport: () => ({ findings: [] }) } as unknown as SessionStore,
      emitter: { emitDimensionFailed } as unknown as BootstrapEventEmitter,
      shouldAbort: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      generateSkillFn: generateSkillFn as never,
    });

    expect(results.failed).toBe(1);
    expect(results.errors).toEqual([{ dimId: 'api', error: 'too short' }]);
    expect(generateSkillFn).toHaveBeenCalledTimes(1);
    expect(emitDimensionFailed).toHaveBeenCalledWith('api', expect.any(Error));
  });
});
