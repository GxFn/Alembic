import {
  createHostAgentKnowledgeRescanIntent,
  createInternalKnowledgeRescanIntent,
} from '@alembic/core/host-agent-workflows';
import { describe, expect, test } from 'vitest';

describe('KnowledgeRescanIntent', () => {
  test('uses rescan-clean as the default cleanup policy', () => {
    const intent = createInternalKnowledgeRescanIntent({
      reason: 'n2-intent-smoke',
      dimensions: ['design-patterns', 'error-resilience'],
      skipAsyncFill: true,
    });

    expect(intent).toMatchObject({
      analysisMode: 'incremental',
      cleanupPolicy: 'rescan-clean',
      completionPolicy: 'auto-fill',
      dimensionIds: ['design-patterns', 'error-resilience'],
      reason: 'n2-intent-smoke',
      internalExecution: { skipAsyncFill: true },
    });
  });

  test('uses force-rescan only when force is requested', () => {
    const intent = createInternalKnowledgeRescanIntent({
      force: true,
      dimensions: ['design-patterns'],
    });

    expect(intent.analysisMode).toBe('full');
    expect(intent.cleanupPolicy).toBe('force-rescan');
  });

  test('passes explicit internal rescan analysis limits into the workflow intent', () => {
    const intent = createInternalKnowledgeRescanIntent({
      reason: 'wide-rescan',
      maxFiles: 15_000,
      contentMaxLines: 1_500,
    });

    expect(intent.projectAnalysis).toMatchObject({
      maxFiles: 15_000,
      contentMaxLines: 1_500,
    });
  });

  test('keeps host-agent rescan aligned with internal cleanup semantics', () => {
    const intent = createHostAgentKnowledgeRescanIntent({
      reason: 'host-agent-rescan',
      dimensions: ['architecture'],
    });

    expect(intent).toMatchObject({
      executor: 'host-agent',
      analysisMode: 'incremental',
      cleanupPolicy: 'rescan-clean',
      completionPolicy: 'host-agent-dimension-complete',
      dimensionIds: ['architecture'],
      projectAnalysis: {
        sourceTag: 'rescan-host-agent',
      },
    });
  });
});
