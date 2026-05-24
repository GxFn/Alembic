import type { AgentRunInput } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import type { BootstrapDimensionPlan } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  buildBootstrapDimensionInputProcessEvents,
  buildBootstrapDimensionResultProcessEvents,
  buildBootstrapTierReflectionProcessEvents,
} from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapProcessEvents.js';
import type { BootstrapDimensionProjection } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

describe('BootstrapProcessEvents', () => {
  test('projects safe bootstrap dimension input without file content or secrets', () => {
    const events = buildBootstrapDimensionInputProcessEvents({
      dimId: 'architecture',
      label: 'Architecture',
      plan: makePlan(),
      runInput: {
        profile: { id: 'bootstrap-dimension' },
        params: { dimId: 'architecture', apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' },
        message: {
          role: 'internal',
          content: 'Bootstrap dimension: Architecture',
          metadata: { sessionId: 'bs_1' },
          sessionId: 'bs_1',
        },
        context: {
          source: 'bootstrap',
          lang: 'typescript',
          fileCache: [
            {
              relativePath: 'src/index.ts',
              content: 'file content sk-proj-abcdefghijklmnopqrstuvwxyz',
            },
          ],
          promptContext: { dimensionId: 'architecture' },
          strategyContext: { large: true },
          systemRunContext: { secret: 'do not serialize' },
        },
        execution: { abortSignal: new AbortController().signal },
        presentation: { responseShape: 'system-task-result' },
      } as unknown as AgentRunInput,
      sessionId: 'bs_1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'llm.input',
      dimensionId: 'architecture',
      targetName: 'Architecture',
    });
    const text = events[0].content?.text || '';
    expect(text).toContain('"fileCount": 1');
    expect(text).toContain('[redacted-secret]');
    expect(text).not.toContain('file content');
    expect(text).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
  });

  test('projects visible output, tool calls, and self-check events from AgentRunResult', () => {
    const events = buildBootstrapDimensionResultProcessEvents({
      dimId: 'code-patterns',
      label: 'Code Patterns',
      projection: {
        analyzeResult: { reply: 'Analysis output' },
        produceResult: { reply: 'Producer output' },
        gateResult: {
          action: 'pass',
          pass: true,
          artifact: {
            qualityReport: {
              totalScore: 0.91,
              scores: { evidence: 0.95 },
              suggestions: ['Keep evidence grounded'],
            },
          },
        },
        runtimeToolCalls: [
          {
            tool: 'read_file',
            args: {
              filePath: 'src/index.ts',
              authorization: 'Bearer abcdefghijklmnop',
            },
            result: { ok: true, content: 'large raw result omitted by summary' },
            durationMs: 12,
          },
        ],
        combinedTokenUsage: { input: 123, output: 45 },
        efficiency: {
          toolCalls: 1,
          duplicateToolCalls: 0,
          cacheHits: 0,
          cacheMisses: 1,
          tokenUsage: { input: 123, output: 45, reasoning: 0, cacheHit: 0 },
          nudgeCount: 1,
          replanCount: 0,
          emptyRetries: 0,
          maxCompactionLevel: 0,
          totalCompactedItems: 0,
          forcedSummary: false,
        },
      } as unknown as BootstrapDimensionProjection,
      runResult: {
        reply: 'Final visible output',
        status: 'success',
        diagnostics: { degraded: false, gateFailures: [], timedOutStages: [] },
      },
      sessionId: 'bs_1',
    });

    expect(events.map((event) => event.kind)).toEqual(['tool', 'llm.output', 'llm.reflection']);
    expect(JSON.stringify(events)).toContain('read_file');
    expect(JSON.stringify(events)).toContain('Producer output');
    expect(JSON.stringify(events)).toContain('quality-gate-diagnostics');
    expect(JSON.stringify(events)).not.toContain('Bearer abcdefghijklmnop');
  });

  test('projects tier reflection as a developer-safe reflection event', () => {
    const events = buildBootstrapTierReflectionProcessEvents({
      reflection: {
        tierIndex: 1,
        completedDimensions: ['architecture', 'code-patterns'],
        topFindings: [{ finding: 'Shared API boundary' }],
        crossDimensionPatterns: ['src/api.ts appears in multiple dimensions'],
        suggestionsForNextTier: ['Inspect public API consumers'],
      },
      sessionId: 'bs_1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'llm.reflection',
      phase: 'tier-reflection',
      targetName: 'Tier 2',
    });
    expect(events[0].content?.text).toContain('Shared API boundary');
  });
});

function makePlan(): BootstrapDimensionPlan {
  return {
    dim: { id: 'architecture', label: 'Architecture' },
    dimConfig: { id: 'architecture', label: 'Architecture' },
    dimExistingRecipes: [],
    hasExistingRecipes: false,
    needsCandidates: true,
    prescreenDone: false,
  } as unknown as BootstrapDimensionPlan;
}
