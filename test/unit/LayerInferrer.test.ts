/**
 * LayerInferrer 单元测试
 */
import { describe, expect, it } from 'vitest';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import type { CyclicDependency, Edge } from '../../lib/service/panorama/PanoramaTypes.js';

describe('LayerInferrer', () => {
  const inferrer = new LayerInferrer();

  it('should assign all modules to L0 when no edges', () => {
    const result = inferrer.infer([], ['ModA', 'ModB', 'ModC'], []);

    expect(result.levels).toHaveLength(1);
    expect(result.levels[0].level).toBe(0);
    expect(result.levels[0].modules).toHaveLength(3);
    expect(result.violations).toHaveLength(0);
  });

  it('should infer layers from linear dependency chain', () => {
    const edges: Edge[] = [
      { from: 'App', to: 'Service', weight: 1, relation: 'depends_on' },
      { from: 'Service', to: 'Core', weight: 1, relation: 'depends_on' },
    ];

    const result = inferrer.infer(edges, ['App', 'Service', 'Core'], []);

    // Core = L0 (no deps), Service = L1, App = L2
    expect(result.levels.length).toBeGreaterThanOrEqual(2);

    const coreLevel = result.levels.find((l) => l.modules.includes('Core'));
    const serviceLevel = result.levels.find((l) => l.modules.includes('Service'));
    const appLevel = result.levels.find((l) => l.modules.includes('App'));

    expect(coreLevel).toBeDefined();
    expect(serviceLevel).toBeDefined();
    expect(appLevel).toBeDefined();
    expect(coreLevel!.level).toBeLessThan(serviceLevel!.level);
    expect(serviceLevel!.level).toBeLessThan(appLevel!.level);
  });

  it('should skip cycle edges and still produce layers', () => {
    const edges: Edge[] = [
      { from: 'A', to: 'B', weight: 1, relation: 'depends_on' },
      { from: 'B', to: 'C', weight: 1, relation: 'depends_on' },
      { from: 'C', to: 'A', weight: 1, relation: 'depends_on' }, // cycle edge
    ];

    const cycles: CyclicDependency[] = [{ cycle: ['A', 'B', 'C'], severity: 'warning' }];

    const result = inferrer.infer(edges, ['A', 'B', 'C'], cycles);

    // Should produce layers despite cycle
    expect(result.levels.length).toBeGreaterThanOrEqual(1);
  });

  it('should infer layer name from module names', () => {
    const edges: Edge[] = [
      { from: 'BDUIKit', to: 'BDFoundation', weight: 1, relation: 'depends_on' },
    ];

    const result = inferrer.infer(edges, ['BDUIKit', 'BDFoundation'], []);

    const foundationLevel = result.levels.find((l) => l.modules.includes('BDFoundation'));
    const uiLevel = result.levels.find((l) => l.modules.includes('BDUIKit'));

    expect(foundationLevel).toBeDefined();
    expect(uiLevel).toBeDefined();
    // BDFoundation should be at lower layer, BDUIKit at higher
    expect(foundationLevel!.name).toBe('Foundation');
    // BDUIKit matches 'ui|view|screen|component|widget' or gets position-based name
    expect(uiLevel!.level).toBeGreaterThan(foundationLevel!.level);
  });

  it('should detect layer violations (low layer depends on high layer)', () => {
    const edges: Edge[] = [
      { from: 'App', to: 'Service', weight: 1, relation: 'depends_on' },
      { from: 'Service', to: 'Core', weight: 1, relation: 'depends_on' },
      { from: 'Core', to: 'App', weight: 0.5, relation: 'calls' }, // violation: core → app
    ];

    const result = inferrer.infer(edges, ['App', 'Service', 'Core'], []);

    // Core is lower layer, App is higher → Core calling App is a violation
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    const violation = result.violations.find((v) => v.from === 'Core' && v.to === 'App');
    expect(violation).toBeDefined();
  });

  it('should handle diamond dependency', () => {
    const edges: Edge[] = [
      { from: 'App', to: 'ServiceA', weight: 1, relation: 'depends_on' },
      { from: 'App', to: 'ServiceB', weight: 1, relation: 'depends_on' },
      { from: 'ServiceA', to: 'Core', weight: 1, relation: 'depends_on' },
      { from: 'ServiceB', to: 'Core', weight: 1, relation: 'depends_on' },
    ];

    const result = inferrer.infer(edges, ['App', 'ServiceA', 'ServiceB', 'Core'], []);

    const coreLevel = result.levels.find((l) => l.modules.includes('Core'));
    const appLevel = result.levels.find((l) => l.modules.includes('App'));
    const serviceALevel = result.levels.find((l) => l.modules.includes('ServiceA'));

    expect(coreLevel!.level).toBe(0);
    expect(serviceALevel!.level).toBe(1);
    expect(appLevel!.level).toBe(2);
  });

  it('should handle isolated modules', () => {
    const edges: Edge[] = [{ from: 'A', to: 'B', weight: 1, relation: 'depends_on' }];

    const result = inferrer.infer(edges, ['A', 'B', 'Isolated'], []);

    // Isolated should be at L0
    const isolatedLevel = result.levels.find((l) => l.modules.includes('Isolated'));
    expect(isolatedLevel).toBeDefined();
    expect(isolatedLevel!.level).toBe(0);
  });

  it('should use position-based naming for generic modules', () => {
    const edges: Edge[] = [
      { from: 'Alpha', to: 'Beta', weight: 1, relation: 'depends_on' },
      { from: 'Beta', to: 'Gamma', weight: 1, relation: 'depends_on' },
    ];

    const result = inferrer.infer(edges, ['Alpha', 'Beta', 'Gamma'], []);

    // Names should be inferred from position
    expect(result.levels.length).toBeGreaterThanOrEqual(2);
  });
});
