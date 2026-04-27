import { describe, expect, test, vi } from 'vitest';
import { taskCheckAndSubmit, taskQualityAudit } from '../../lib/agent/tasks/AgentTaskHandlers.js';
import type { ToolResultEnvelope } from '../../lib/tools/core/ToolResultEnvelope.js';

function envelope<T>(toolId: string, structuredContent: T): ToolResultEnvelope<T> {
  return {
    ok: true,
    toolId,
    callId: `${toolId}-call`,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    text: 'ok',
    structuredContent,
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

describe('AgentTaskHandlers envelope boundary', () => {
  test('check_and_submit consumes ToolResultEnvelope results explicitly', async () => {
    const invokeToolEnvelope = vi.fn().mockResolvedValue(
      envelope('check_duplicate', {
        similar: [{ title: 'Existing Recipe', similarity: 0.8 }],
      })
    );
    const chat = vi.fn().mockResolvedValue('SIMILAR');

    const result = await taskCheckAndSubmit(
      {
        invokeToolEnvelope,
        aiProvider: { chat, chatWithStructuredOutput: vi.fn() },
        container: { get: vi.fn() },
      },
      { candidate: { title: 'New Recipe', code: 'const x = 1;' }, projectRoot: '/tmp/project' }
    );

    expect(invokeToolEnvelope).toHaveBeenCalledWith('check_duplicate', {
      candidate: { title: 'New Recipe', code: 'const x = 1;' },
      projectRoot: '/tmp/project',
      threshold: 0.5,
    });
    expect(result).toMatchObject({
      duplicates: [{ title: 'Existing Recipe', similarity: 0.8 }],
      aiVerdict: 'SIMILAR',
      recommendation: 'review_suggested',
    });
  });

  test('quality_audit runs scoring through invokeToolEnvelope', async () => {
    const recipes = [
      { id: 'r1', title: 'Low quality' },
      { id: 'r2', title: 'High quality' },
    ];
    const invokeToolEnvelope = vi
      .fn()
      .mockResolvedValueOnce(envelope('quality_score', { score: 0.4, grade: 'D', dimensions: {} }))
      .mockResolvedValueOnce(
        envelope('quality_score', { score: 0.95, grade: 'A', dimensions: {} })
      );
    const knowledgeService = {
      list: vi.fn().mockResolvedValue({ items: recipes }),
    };

    const result = await taskQualityAudit(
      {
        invokeToolEnvelope,
        container: {
          get: vi.fn((name: string) => (name === 'knowledgeService' ? knowledgeService : null)),
        },
      },
      { threshold: 0.6, maxCount: 10 }
    );

    expect(invokeToolEnvelope).toHaveBeenCalledTimes(2);
    expect(invokeToolEnvelope).toHaveBeenNthCalledWith(1, 'quality_score', { recipe: recipes[0] });
    expect(result).toMatchObject({
      total: 2,
      lowQualityCount: 1,
      lowQuality: [{ id: 'r1', score: 0.4, grade: 'D' }],
      gradeDistribution: { A: 1, D: 1 },
    });
  });
});
