/**
 * RoleRefiner 单元测试
 */
import { describe, expect, it } from 'vitest';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';
import { createMockRepos, type MockRepoOptions } from '../helpers/panorama-mocks.js';

/* ═══ Helper ══════════════════════════════════════════════ */

function makeRefiner(opts: MockRepoOptions = {}) {
  const repos = createMockRepos(opts);
  return new RoleRefiner(repos.bootstrapRepo, repos.entityRepo, repos.edgeRepo, '/test');
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('RoleRefiner', () => {
  it('should return fallback when no signals available', async () => {
    const refiner = makeRefiner();

    const result = await refiner.refineRole({
      name: 'MyModule',
      inferredRole: 'feature',
      files: [],
    });

    expect(result.refinedRole).toBe('feature');
    expect(['fallback', 'uncertain']).toContain(result.resolution);
  });

  it('should refine role based on AST superclass signals', async () => {
    const refiner = makeRefiner({
      entities: [
        {
          entity_id: 'MyVC',
          entity_type: 'class',
          superclass: 'UIViewController',
          protocols: '[]',
          file_path: '/test/a.swift',
        },
        {
          entity_id: 'MyView',
          entity_type: 'class',
          superclass: 'UIView',
          protocols: '[]',
          file_path: '/test/b.swift',
        },
      ],
    });

    const result = await refiner.refineRole({
      name: 'UIModule',
      inferredRole: 'ui',
      files: ['/test/a.swift', '/test/b.swift'],
    });

    expect(result.refinedRole).toBe('ui');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should refine role based on protocol conformance', async () => {
    const refiner = makeRefiner({
      entities: [
        {
          entity_id: 'MyModel',
          entity_type: 'class',
          superclass: null,
          protocols: '["Codable", "Decodable"]',
          file_path: '/test/model.swift',
        },
      ],
    });

    const result = await refiner.refineRole({
      name: 'DataModule',
      inferredRole: 'model',
      files: ['/test/model.swift'],
    });

    expect(result.refinedRole).toBe('model');
  });

  it('should refine role from call graph fan-in heavy → core', async () => {
    const refiner = makeRefiner({
      edgeCounts: { 'calls:to': 50, 'calls:from': 5 },
    });

    const result = await refiner.refineRole({
      name: 'Foundation',
      inferredRole: 'core',
      files: ['/test/foundation.swift'],
    });

    expect(result.refinedRole).toBe('core');
  });

  it('should refine role from call graph fan-out heavy → ui', async () => {
    const refiner = makeRefiner({
      edgeCounts: { 'calls:to': 3, 'calls:from': 40 },
    });

    const result = await refiner.refineRole({
      name: 'ScreenModule',
      inferredRole: 'ui',
      files: ['/test/screen.swift'],
    });

    expect(result.refinedRole).toBe('ui');
  });

  it('should detect singleton pattern → service', async () => {
    const refiner = makeRefiner({
      patterns: ['singleton'],
    });

    const result = await refiner.refineRole({
      name: 'ManagerModule',
      inferredRole: 'service',
      files: ['/test/manager.swift'],
    });

    expect(result.refinedRole).toBe('service');
  });

  it('should handle uncertain resolution when signals conflict', async () => {
    const refiner = makeRefiner({
      entities: [
        {
          entity_id: 'MyVC',
          entity_type: 'class',
          superclass: 'UIViewController',
          protocols: '[]',
          file_path: '/test/a.swift',
        },
      ],
      patterns: ['singleton'],
      edgeCounts: { 'calls:to': 20, 'calls:from': 20 },
    });

    const result = await refiner.refineRole({
      name: 'HybridModule',
      inferredRole: 'feature',
      files: ['/test/a.swift'],
    });

    expect(result.refinedRole).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('should batch refine all modules', async () => {
    const refiner = makeRefiner();

    const results = await refiner.refineAll([
      { name: 'ModA', inferredRole: 'core', files: [] },
      { name: 'ModB', inferredRole: 'ui', files: [] },
    ]);

    expect(results.size).toBe(2);
    expect(results.has('ModA')).toBe(true);
    expect(results.has('ModB')).toBe(true);
  });

  it('should include regex baseline signal', async () => {
    const refiner = makeRefiner();

    const result = await refiner.refineRole({
      name: 'TestModule',
      inferredRole: 'service',
      files: [],
    });

    const baselineSignal = result.signals.find((s) => s.source === 'regex-baseline');
    expect(baselineSignal).toBeDefined();
    expect(baselineSignal!.role).toBe('service');
    expect(baselineSignal!.weight).toBe(0.15);
  });

  it('should use language-specific maps — Java Activity → ui', async () => {
    const refiner = makeRefiner({
      primaryLang: 'java',
      entities: [
        {
          entity_id: 'MainActivity',
          entity_type: 'class',
          superclass: 'AppCompatActivity',
          protocols: '[]',
          file_path: '/test/Main.java',
        },
      ],
    });

    const result = await refiner.refineRole({
      name: 'AppModule',
      inferredRole: 'feature',
      files: ['/test/Main.java'],
    });

    expect(result.refinedRole).toBe('ui');
  });

  it('should NOT match cross-language superclass — Swift project ignores Activity', async () => {
    const refiner = makeRefiner({
      primaryLang: 'swift',
      entities: [
        {
          entity_id: 'Activity',
          entity_type: 'class',
          superclass: 'Activity',
          protocols: '[]',
          file_path: '/test/Act.swift',
        },
      ],
    });

    const result = await refiner.refineRole({
      name: 'SomeModule',
      inferredRole: 'feature',
      files: ['/test/Act.swift'],
    });

    const astSignals = result.signals.filter((s) => s.source === 'ast-structure');
    expect(astSignals.length).toBe(0);
  });

  it('should fallback to all families when no bootstrap data', async () => {
    const refiner = makeRefiner({ primaryLang: null });

    const result = await refiner.refineRole({
      name: 'GenericModule',
      inferredRole: 'feature',
      files: [],
    });

    expect(result.refinedRole).toBeDefined();
  });
});
