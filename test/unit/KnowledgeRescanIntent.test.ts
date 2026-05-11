import { describe, expect, test } from 'vitest';
import {
  createExternalKnowledgeRescanIntent,
  createInternalKnowledgeRescanIntent,
} from '../../lib/workflows/knowledge-rescan/KnowledgeRescanIntent.js';

describe('KnowledgeRescanIntent', () => {
  test('uses rescan-clean as the default internal cleanup policy', () => {
    const intent = createInternalKnowledgeRescanIntent({
      reason: 'n2-intent-smoke',
      dimensions: ['design-patterns', 'error-resilience'],
      skipAsyncFill: true,
    });

    expect(intent).toMatchObject({
      executor: 'internal-agent',
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

  test('keeps external rescan aligned with internal cleanup semantics', () => {
    const intent = createExternalKnowledgeRescanIntent({
      reason: 'external-rescan',
      dimensions: ['architecture'],
    });

    expect(intent).toMatchObject({
      executor: 'external-agent',
      analysisMode: 'incremental',
      cleanupPolicy: 'rescan-clean',
      completionPolicy: 'external-dimension-complete',
      dimensionIds: ['architecture'],
    });
  });
});
