import { describe, expect, test } from 'vitest';
import { SystemRunContextFactory } from '../../lib/agent/service/index.js';

describe('SystemRunContextFactory', () => {
  test('builds projected system run context with explicit scope metadata', () => {
    const factory = new SystemRunContextFactory({ aiProvider: { model: 'mock' } });

    const context = factory.createSystemContext({
      label: 'extract:TargetC',
      lang: 'swift',
      budget: { maxIterations: 12 },
    });

    const systemRunContext = context.systemRunContext as Record<string, unknown>;
    const sharedState = context.sharedState as Record<string, unknown>;

    expect(systemRunContext.scopeId).toBe('scan:extract:TargetC');
    expect(systemRunContext.source).toBe('system');
    expect(systemRunContext.outputType).toBe('candidate');
    expect(systemRunContext.dimId).toBe('extract:TargetC');
    expect(context.trace).toBe(context.activeContext);
    expect(systemRunContext.activeContext).toBe(context.activeContext);
    expect(systemRunContext.trace).toBe(context.trace);
    expect(sharedState._dimensionScopeId).toBe('scan:extract:TargetC');
    expect(sharedState._projectLanguage).toBe('swift');
  });
});
