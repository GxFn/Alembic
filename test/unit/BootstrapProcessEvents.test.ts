import type { AgentRunInput } from '@alembic/agent/service';
import { describe, expect, test } from 'vitest';
import type { BootstrapDimensionPlan } from '../../lib/workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import {
  buildBootstrapAgentProgressProcessEvents,
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

  test('maps developer-safe Agent progress process events and keeps host-owned fields out', () => {
    const events = buildBootstrapAgentProgressProcessEvents({
      dimId: 'architecture',
      label: 'Architecture',
      sessionId: 'bs_1',
      event: {
        type: 'agent_process_event',
        agentId: 'agent_1',
        preset: 'insight',
        timestamp: 1,
        processEvent: {
          content: {
            role: 'developer',
            text: '中期反思: verify src/index.ts before producing findings',
          },
          createdAt: '2026-05-24T10:00:00.000Z',
          dimensionId: 'architecture',
          displayPolicy: 'full',
          kind: 'llm.reflection',
          metadata: {
            nudgeType: 'convergence',
            token: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
          },
          phase: 'VERIFY',
          retention: 'job-retained',
          severity: 'info',
          sourceClass: 'developer-facing',
          summary: 'Injected convergence reflection.',
          targetName: 'Architecture',
          title: 'Agent 中期反思',
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      dimensionId: 'architecture',
      kind: 'llm.reflection',
      metadata: {
        agentId: 'agent_1',
        nudgeType: 'convergence',
        preset: 'insight',
        progressType: 'agent_process_event',
        sessionId: 'bs_1',
        token: '[redacted-secret]',
      },
      phase: 'VERIFY',
      sourceClass: 'developer-facing',
      targetName: 'Architecture',
      title: 'Agent 中期反思',
    });
    expect(events[0].jobId).toBeUndefined();
    expect(events[0].sequence).toBeUndefined();
  });

  test('drops Agent process progress that is not developer-visible', () => {
    const baseEvent = {
      type: 'agent_process_event',
      agentId: 'agent_1',
      preset: 'insight',
      timestamp: 1,
      processEvent: {
        content: { role: 'assistant', text: 'hidden reasoning' },
        createdAt: '2026-05-24T10:00:00.000Z',
        dimensionId: 'architecture',
        displayPolicy: 'full',
        kind: 'llm.output',
        metadata: {},
        phase: 'THINK',
        retention: 'transient',
        severity: 'info',
        sourceClass: 'hidden-reasoning',
        title: 'Hidden reasoning',
      },
    } as const;

    expect(
      buildBootstrapAgentProgressProcessEvents({
        dimId: 'architecture',
        event: baseEvent,
        sessionId: 'bs_1',
      })
    ).toEqual([]);
    expect(
      buildBootstrapAgentProgressProcessEvents({
        dimId: 'architecture',
        event: {
          ...baseEvent,
          processEvent: {
            ...baseEvent.processEvent,
            displayPolicy: 'hidden',
            sourceClass: 'developer-facing',
          },
        },
        sessionId: 'bs_1',
      })
    ).toEqual([]);
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

  test('projects key findings digest from dimension digest and analysis report', () => {
    const events = buildBootstrapDimensionResultProcessEvents({
      dimId: 'architecture',
      label: 'Architecture',
      projection: {
        analysisReport: {
          analysisText: 'Architecture analysis',
          dimensionId: 'architecture',
          evidenceMap: null,
          findings: [
            {
              evidence: 'lib/main.ts:42',
              finding: 'Bootstrap bridge owns event persistence.',
              importance: 9,
            },
          ],
          referencedFiles: ['lib/main.ts'],
        },
        artifact: {},
        combinedTokenUsage: { input: 1, output: 1 },
        efficiency: null,
        producerResult: {
          candidateCount: 1,
          reply:
            '```json\n{"dimensionDigest":{"summary":"bridge summary","candidateCount":1,"keyFindings":["Dashboard can consume a findings digest event."]}}\n```',
          toolCalls: [],
        },
        runtimeToolCalls: [],
        submitCalls: [],
      } as unknown as BootstrapDimensionProjection,
      runResult: {
        reply: 'final',
        status: 'success',
      },
      sessionId: 'bs_1',
    });

    const digest = events.find((event) => event.phase === 'dimension-findings');
    expect(digest).toMatchObject({
      kind: 'summary',
      metadata: {
        candidateCount: 1,
        dimensionId: 'architecture',
        digestSummary: 'bridge summary',
        findingCount: 2,
        findingSources: ['dimension-digest', 'analysis-report'],
        projection: 'dimension-findings-digest',
      },
      targetName: 'Architecture',
      title: 'Bootstrap Architecture findings digest',
    });
    expect(digest?.content?.text).toContain('Dashboard can consume a findings digest event.');
    expect(digest?.content?.text).toContain('Bootstrap bridge owns event persistence.');
    expect(digest?.content?.text).toContain('lib/main.ts:42');
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

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'llm.reflection',
      phase: 'tier-reflection',
      targetName: 'Tier 2',
    });
    expect(events[0].content?.text).toContain('Shared API boundary');
    expect(events[1]).toMatchObject({
      kind: 'summary',
      phase: 'tier-findings',
      targetName: 'Tier 2',
      title: 'Bootstrap tier 2 findings digest',
    });
    expect(events[1].content?.text).toContain('Shared API boundary');
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
