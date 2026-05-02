import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DimensionDef } from '#types/project-snapshot.js';
import { buildMissionBriefing } from '#workflows/capabilities/execution/external/MissionBriefingBuilder.js';
import type { ExternalRescanEvidencePlan } from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanner.js';

describe('MissionBriefing profiles', () => {
  test('defaults to cold-start profile without rescan evidence hints', () => {
    const briefing = buildMissionBriefing({
      projectMeta: { name: 'Demo', primaryLanguage: 'typescript', fileCount: 10 },
      activeDimensions: [dimension('architecture')],
      session: session(),
    });

    expect(briefing.meta?.profile).toBe('cold-start-external');
    expect(briefing.evidenceHints).toBeUndefined();
    expect((briefing.executionPlan as { workflow: string }).workflow).toContain(
      'knowledge({ action: "submit_batch" })'
    );
  });

  test('builds rescan profile execution instructions and evidence hints in the builder', () => {
    const evidencePlan = createEvidencePlan();
    const briefing = buildMissionBriefing({
      projectMeta: { name: 'Demo', primaryLanguage: 'typescript', fileCount: 10 },
      profile: 'rescan-external',
      rescan: {
        evidencePlan,
        prescreen: {
          needsVerification: [{ recipeId: 'recipe-1' }],
          autoResolved: [{ recipeId: 'recipe-2' }],
          dimensionGaps: { architecture: 2 },
        },
      },
      activeDimensions: [dimension('architecture')],
      session: session(),
    });

    expect(briefing.meta?.profile).toBe('rescan-external');
    expect((briefing.executionPlan as { workflow: string }).workflow).toContain('增量扫描模式');
    expect((briefing.executionPlan as { workflow: string }).workflow).toContain('仅 1 条需要验证');

    const hints = briefing.evidenceHints as Record<string, unknown>;
    expect(hints.rescanMode).toBe(true);
    expect(hints.allRecipes).toBe(evidencePlan.allRecipes);
    expect(hints.dimensionGaps).toBe(evidencePlan.dimensionGaps);
    expect(hints.executionReasons).toBe(evidencePlan.executionReasons);
  });

  test('rejects rescan profile without rescan context', () => {
    expect(() =>
      buildMissionBriefing({
        projectMeta: { name: 'Demo', fileCount: 1 },
        profile: 'rescan-external',
        activeDimensions: [],
        session: session(),
      })
    ).toThrow('rescan-external profile requires rescan evidence input');
  });

  test('applies the profile response budget through compression policy', () => {
    const briefing = buildMissionBriefing({
      projectMeta: { name: 'Demo', fileCount: 1 },
      activeDimensions: [dimension('architecture')],
      session: session(),
      responseBudget: { limitBytes: 1 },
    });

    expect(briefing.meta?.compressionLevel).toBe('aggressive');
    expect(briefing.meta?.warnings?.[0]).toContain('Response compressed');
  });

  test('external knowledge rescan workflow no longer patches executionPlan after briefing construction', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'lib/workflows/knowledge-rescan/external/ExternalKnowledgeRescanWorkflow.ts'
      ),
      'utf8'
    );

    expect(source).not.toContain('applyExternalIncrementalScanBriefingPresentation');
    expect(source).not.toContain('executionPlan as Record<string, unknown>).workflow');
    expect(source).toContain("profile: 'rescan-external'");
  });
});

function dimension(id: string): DimensionDef {
  return { id, label: id, guide: `${id} guide` } as DimensionDef;
}

function session() {
  return { toJSON: () => ({ id: 'session-1' }) };
}

function createEvidencePlan(): ExternalRescanEvidencePlan {
  return {
    allRecipes: [
      {
        id: 'recipe-1',
        title: 'Architecture recipe',
        trigger: '@architecture-recipe',
        knowledgeType: 'architecture',
        doClause: 'Reuse the architecture recipe.',
        lifecycle: 'active',
        content: { markdown: 'body', rationale: 'why', coreCode: 'const x = 1;' },
        sourceRefs: ['src/index.ts'],
        auditHint: { relevanceScore: 80, verdict: 'watch', decayReasons: [] },
      },
    ],
    dimensionGaps: [
      {
        dimensionId: 'architecture',
        existingCount: 1,
        gap: 2,
        existingTriggers: ['@architecture-recipe'],
        executionReasons: [{ kind: 'coverage-gap', detail: 'Need more recipes' }],
      },
    ],
    executionReasons: { architecture: [{ kind: 'coverage-gap', detail: 'Need more recipes' }] },
    totalGap: 2,
    decayCount: 0,
    occupiedTriggers: ['@architecture-recipe'],
    coveredDimensions: 0,
    gapSummary: '需补齐维度: architecture(需补2条)。',
  };
}
