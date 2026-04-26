import { describe, expect, test } from 'vitest';
import { BudgetPolicy } from '../../lib/agent/policies.js';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentStageFactoryRegistry,
} from '../../lib/agent/service/index.js';

function createCompiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

describe('AgentProfileCompiler', () => {
  test('compiles legacy preset refs into a compiled profile', () => {
    const compiler = createCompiler();

    const profile = compiler.compile({ preset: 'chat' });

    expect(profile).toMatchObject({
      kind: 'compiled-agent-profile',
      id: 'chat',
      basePreset: 'chat',
      serviceKind: 'conversation',
      additionalTools: [],
    });
    expect(profile.runtimeOverrides).toEqual({});
  });

  test('compiles scan-extract into a pure runtime override with generated stages', () => {
    const compiler = createCompiler();

    const profile = compiler.compile({
      id: 'scan-extract',
      params: { label: 'TargetA', files: [{ name: 'A.ts', content: 'export const a = 1;' }] },
    });

    expect(profile.id).toBe('scan-extract');
    expect(profile.basePreset).toBe('insight');
    expect(profile.params.task).toBe('extract');
    expect(profile.runtimeOverrides).toMatchObject({
      capabilities: ['code_analysis'],
      memory: { enabled: false },
      strategy: { type: 'pipeline', maxRetries: 1 },
    });
    const strategy = profile.runtimeOverrides.strategy as unknown as {
      stages: Array<{ name: string }>;
    };
    expect(strategy.stages.map((stage) => stage.name)).toEqual([
      'analyze',
      'quality_gate',
      'produce',
      'rejection_gate',
    ]);
    expect(profile.runtimeOverrides.policies?.[0]).toBeInstanceOf(BudgetPolicy);
  });

  test('rejects profile definitions that contain non-serializable functions', () => {
    const registry = new AgentProfileRegistry([]);

    expect(() =>
      registry.register({
        id: 'bad',
        title: 'Bad',
        serviceKind: 'system-analysis',
        lifecycle: 'experimental',
        defaults: { persona: { build: () => 'bad' } },
      })
    ).toThrow(/must not contain functions/);
  });

  test('compiles signal-analysis action space from pure run params', () => {
    const compiler = createCompiler();

    const suggestProfile = compiler.compile(
      { id: 'signal-analysis' },
      { params: { mode: 'suggest' } }
    );
    const autoProfile = compiler.compile({ id: 'signal-analysis' }, { params: { mode: 'auto' } });

    expect(suggestProfile.actionSpace).toEqual({ mode: 'none' });
    expect(suggestProfile.additionalTools).toEqual([]);
    expect(autoProfile.actionSpace).toEqual({
      mode: 'listed',
      toolIds: ['suggest_skills', 'create_skill'],
    });
    expect(autoProfile.additionalTools).toEqual(['suggest_skills', 'create_skill']);
  });

  test('compiles evolution-audit budget from pure recipe params', () => {
    const compiler = createCompiler();

    const profile = compiler.compile(
      { id: 'evolution-audit' },
      {
        params: {
          recipes: Array.from({ length: 40 }, (_, index) => ({
            id: `recipe-${index}`,
            title: `Recipe ${index}`,
            trigger: `@recipe-${index}`,
          })),
        },
      }
    );

    expect(profile.basePreset).toBe('evolution');
    expect(profile.runtimeOverrides).toMatchObject({
      capabilities: ['evolution_analysis'],
      memory: { enabled: false },
    });
    const policy = profile.runtimeOverrides.policies?.[0] as BudgetPolicy;
    expect(policy).toBeInstanceOf(BudgetPolicy);
    expect(policy.maxIterations).toBe(120);
  });

  test('compiles bootstrap-dimension stages from pure run params', () => {
    const compiler = createCompiler();

    const candidateProfile = compiler.compile(
      { id: 'bootstrap-dimension' },
      { params: { needsCandidates: true, hasExistingRecipes: false, prescreenDone: false } }
    );
    const evolutionProfile = compiler.compile(
      { id: 'bootstrap-dimension' },
      { params: { needsCandidates: true, hasExistingRecipes: true, prescreenDone: false } }
    );
    const skillOnlyProfile = compiler.compile(
      { id: 'bootstrap-dimension' },
      { params: { needsCandidates: false, hasExistingRecipes: false, prescreenDone: false } }
    );

    const candidateStages = getStageNames(candidateProfile.runtimeOverrides.strategy);
    const evolutionStages = getStageNames(evolutionProfile.runtimeOverrides.strategy);
    const skillOnlyStages = getStageNames(skillOnlyProfile.runtimeOverrides.strategy);

    expect(candidateStages).toEqual(['analyze', 'quality_gate', 'produce', 'rejection_gate']);
    expect(evolutionStages).toEqual([
      'evolve',
      'evolution_gate',
      'analyze',
      'quality_gate',
      'produce',
      'rejection_gate',
    ]);
    expect(skillOnlyStages).toEqual(['analyze']);
  });

  test('compiles bootstrap-session as a pure parent coordination profile', () => {
    const compiler = createCompiler();

    const profile = compiler.compile({ id: 'bootstrap-session' }, { params: { concurrency: 4 } });

    expect(profile).toMatchObject({
      id: 'bootstrap-session',
      basePreset: 'insight',
      actionSpace: { mode: 'none' },
      concurrency: {
        mode: 'tiered',
        partitioner: 'bootstrapSessionDimensions',
        childProfile: 'bootstrap-dimension',
        merge: 'bootstrapSessionResults',
        concurrency: 4,
      },
    });
    expect(profile.runtimeOverrides.strategy).toBeUndefined();
  });
});

function getStageNames(strategy: unknown) {
  return (strategy as { stages: Array<{ name: string }> }).stages.map((stage) => stage.name);
}
