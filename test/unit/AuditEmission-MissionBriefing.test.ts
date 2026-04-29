/**
 * Gap-Fill Tests: M1 (Bootstrap Phase 1.8, MissionBriefing, strategyContext) + M7 (audit:entry)
 *
 * 验证文档与实现差异的补齐代码
 */
import { describe, expect, it, vi } from 'vitest';

/* ═══ 1. AuditLogger audit:entry emission ═══════════════════ */

describe('AuditLogger audit:entry EventBus emission', () => {
  it('emits audit:entry on successful save', async () => {
    const mockEventBus = { emit: vi.fn() };
    const mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
    };

    // Dynamic import to avoid module-level side effects
    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never, mockEventBus);

    await logger.log({
      actor: 'agent',
      action: 'check',
      resource: '/file.ts',
      result: 'success',
    });

    expect(mockStore.save).toHaveBeenCalledOnce();
    expect(mockEventBus.emit).toHaveBeenCalledOnce();
    expect(mockEventBus.emit).toHaveBeenCalledWith(
      'audit:entry',
      expect.objectContaining({
        actor: 'agent',
        action: 'check',
        resource: '/file.ts',
        result: 'success',
      })
    );
  });

  it('does not emit when eventBus is null', async () => {
    const mockStore = {
      save: vi.fn().mockResolvedValue(undefined),
    };

    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never);

    await logger.log({
      actor: 'user',
      action: 'create',
      resource: '/test',
      result: 'success',
    });

    expect(mockStore.save).toHaveBeenCalledOnce();
    // No crash — graceful when no eventBus
  });

  it('does not emit when save fails', async () => {
    const mockEventBus = { emit: vi.fn() };
    const mockStore = {
      save: vi.fn().mockRejectedValue(new Error('DB error')),
    };

    const { AuditLogger } = await import('../../lib/infrastructure/audit/AuditLogger.js');
    const logger = new AuditLogger(mockStore as never, mockEventBus);

    // Should not throw
    await logger.log({
      actor: 'agent',
      action: 'create',
      resource: '/test',
      result: 'success',
    });

    // EventBus should NOT be called if save failed
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });
});

/* ═══ 2. MissionBriefingBuilder panorama field ══════════════ */

describe('MissionBriefingBuilder panorama injection', () => {
  it('buildMissionBriefing includes panorama field from panoramaResult', async () => {
    // We test the summarizePanorama logic indirectly via buildMissionBriefing
    // Create a mock panorama result matching PanoramaResult shape
    const mockPanoramaResult = {
      modules: new Map([
        [
          'BDAuth',
          {
            name: 'BDAuth',
            inferredRole: 'service',
            refinedRole: 'service',
            roleConfidence: 0.9,
            layer: 3,
            fanIn: 23,
            fanOut: 5,
            files: [],
            fileCount: 10,
            recipeCount: 5,
            coverageRatio: 0.5,
          },
        ],
        [
          'BDRouter',
          {
            name: 'BDRouter',
            inferredRole: 'core',
            refinedRole: 'core',
            roleConfidence: 0.85,
            layer: 2,
            fanIn: 18,
            fanOut: 3,
            files: [],
            fileCount: 8,
            recipeCount: 2,
            coverageRatio: 0.25,
          },
        ],
      ]),
      layers: {
        levels: [
          { level: 0, name: 'Foundation', modules: ['Utils'] },
          { level: 1, name: 'Service', modules: ['BDAuth'] },
          { level: 2, name: 'UI', modules: ['BDRouter'] },
        ],
        violations: [],
      },
      cycles: [{ cycle: ['A', 'B'], severity: 'warning' }],
      gaps: [
        {
          dimension: 'error-handling',
          dimensionName: '错误处理',
          recipeCount: 0,
          status: 'missing',
          priority: 'high',
          suggestedTopics: ['exception-pattern'],
          affectedRoles: ['service'],
        },
      ],
      callFlowSummary: {
        topCalledMethods: [],
        entryPoints: [],
        dataProducers: [],
        dataConsumers: [],
      },
      healthRadar: {
        dimensions: [],
        overallScore: 0,
        totalRecipes: 0,
        coveredDimensions: 0,
        totalDimensions: 11,
        dimensionCoverage: 0,
      },
      computedAt: Date.now(),
    };

    const { buildMissionBriefing } = await import(
      '#workflows/common-capabilities/agent-execution/mission-briefing/MissionBriefingBuilder.js'
    );

    const briefing = buildMissionBriefing({
      projectMeta: { name: 'TestProject', fileCount: 100 },
      activeDimensions: [],
      session: { toJSON: () => ({ id: 'test-session' }) },
      panoramaResult: mockPanoramaResult,
    });

    expect(briefing.panorama).not.toBeNull();
    expect(briefing.panorama!.layers).toHaveLength(3);
    expect(briefing.panorama!.layers[0]).toEqual({
      level: 0,
      name: 'Foundation',
      modules: ['Utils'],
    });
    expect(briefing.panorama!.couplingHotspots).toHaveLength(2);
    expect(briefing.panorama!.couplingHotspots[0].module).toBe('BDAuth');
    expect(briefing.panorama!.cyclicDependencies).toHaveLength(1);
    expect(briefing.panorama!.knowledgeGaps).toHaveLength(1);
    expect(briefing.panorama!.knowledgeGaps[0].dimension).toBe('error-handling');
  });

  it('buildMissionBriefing sets panorama to null when no panoramaResult', async () => {
    const { buildMissionBriefing } = await import(
      '#workflows/common-capabilities/agent-execution/mission-briefing/MissionBriefingBuilder.js'
    );

    const briefing = buildMissionBriefing({
      projectMeta: { name: 'TestProject', fileCount: 10 },
      activeDimensions: [],
      session: { toJSON: () => ({ id: 'test' }) },
    });

    expect(briefing.panorama).toBeNull();
  });
});
