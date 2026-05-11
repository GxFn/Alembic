/**
 * PanoramaService 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { ModuleDiscoverer } from '../../lib/service/panorama/ModuleDiscoverer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import { PanoramaService } from '../../lib/service/panorama/PanoramaService.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';
import {
  createMockRepos,
  type MockEdge,
  type MockEntity,
  type MockRepoOptions,
} from '../helpers/panorama-mocks.js';

/* ═══ Helper ═════════════════════════════════════════════ */

function makeService(opts: {
  modules?: Array<{ entity_id: string; name?: string }>;
  parts?: Array<{ from_id: string; module_id: string }>;
  entityFiles?: Array<{ entity_id: string; file_path: string }>;
  allFiles?: Array<{ file_path: string }>;
  recipeCount?: number;
}) {
  const projectRoot = '/test';

  // Build entities array from decomposed inputs
  const entities: MockEntity[] = [];
  for (const m of opts.modules ?? []) {
    entities.push({
      entity_id: m.entity_id,
      entity_type: 'module',
      project_root: projectRoot,
      name: m.name ?? m.entity_id,
    });
  }
  for (const ef of opts.entityFiles ?? []) {
    entities.push({
      entity_id: ef.entity_id,
      entity_type: 'class',
      project_root: projectRoot,
      name: ef.entity_id,
      file_path: ef.file_path,
    });
  }
  // Add allFiles as entities (if no entityFiles matched)
  for (const af of opts.allFiles ?? []) {
    if (!entities.some((e) => e.file_path === af.file_path)) {
      const name = af.file_path.split('/').pop() ?? af.file_path;
      entities.push({
        entity_id: `file_${name}`,
        entity_type: 'class',
        project_root: projectRoot,
        name,
        file_path: af.file_path,
      });
    }
  }

  // Build edges
  const edges: MockEdge[] = [];
  for (const p of opts.parts ?? []) {
    edges.push({
      from_id: p.from_id,
      from_type: 'class',
      to_id: p.module_id,
      to_type: 'module',
      relation: 'is_part_of',
    });
  }

  const repoOpts: MockRepoOptions = { entities, edges, recipeCount: opts.recipeCount ?? 0 };
  const repos = createMockRepos(repoOpts);

  const roleRefiner = new RoleRefiner(
    repos.bootstrapRepo,
    repos.entityRepo,
    repos.edgeRepo,
    projectRoot
  );
  const couplingAnalyzer = new CouplingAnalyzer(repos.edgeRepo, repos.entityRepo, projectRoot);
  const moduleDiscoverer = new ModuleDiscoverer(repos.entityRepo, repos.edgeRepo, projectRoot);
  const aggregator = new PanoramaAggregator({
    roleRefiner,
    couplingAnalyzer,
    layerInferrer: new LayerInferrer(),
    bootstrapRepo: repos.bootstrapRepo,
    entityRepo: repos.entityRepo,
    edgeRepo: repos.edgeRepo,
    knowledgeRepo: repos.knowledgeRepo,
    projectRoot,
  });
  return new PanoramaService({
    aggregator,
    edgeRepo: repos.edgeRepo,
    knowledgeRepo: repos.knowledgeRepo,
    projectRoot,
    moduleDiscoverer,
  });
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaService', () => {
  it('should return overview with modules from code_entities', async () => {
    const service = makeService({
      modules: [
        { entity_id: 'BDFoundation', name: 'BDFoundation' },
        { entity_id: 'BDUIKit', name: 'BDUIKit' },
      ],
    });

    const overview = await service.getOverview();

    expect(overview.moduleCount).toBe(2);
    expect(overview.projectRoot).toBe('/test');
    expect(overview.computedAt).toBeGreaterThan(0);
    expect(overview.stale).toBe(false);
  });

  it('should return empty panorama when no module entities (scanner responsibility)', async () => {
    const service = makeService({
      modules: [],
      allFiles: [
        { file_path: '/test/Services/a.swift' },
        { file_path: '/test/Services/b.swift' },
        { file_path: '/test/UI/c.swift' },
      ],
    });

    const overview = await service.getOverview();

    expect(overview.moduleCount).toBe(0); // No module entities → empty (scanner handles fallback)
  });

  it('should return null for non-existent module', async () => {
    const service = makeService({ modules: [] });

    const detail = await service.getModule('NonExistent');
    expect(detail).toBeNull();
  });

  it('should return gaps', async () => {
    const service = makeService({
      modules: [{ entity_id: 'BigMod', name: 'BigMod' }],
      parts: [
        { from_id: 'ClassA', module_id: 'BigMod' },
        { from_id: 'ClassB', module_id: 'BigMod' },
        { from_id: 'ClassC', module_id: 'BigMod' },
        { from_id: 'ClassD', module_id: 'BigMod' },
        { from_id: 'ClassE', module_id: 'BigMod' },
      ],
      entityFiles: [
        { entity_id: 'ClassA', file_path: '/test/a' },
        { entity_id: 'ClassB', file_path: '/test/b' },
        { entity_id: 'ClassC', file_path: '/test/c' },
        { entity_id: 'ClassD', file_path: '/test/d' },
        { entity_id: 'ClassE', file_path: '/test/e' },
      ],
      recipeCount: 0,
    });

    const gaps = await service.getGaps();

    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps[0].priority).toBe('high');
  });

  it('should compute health score', async () => {
    const service = makeService({
      modules: [{ entity_id: 'Mod', name: 'Mod' }],
      recipeCount: 0,
    });

    const health = await service.getHealth();

    expect(health.healthScore).toBeGreaterThanOrEqual(0);
    expect(health.healthScore).toBeLessThanOrEqual(100);
    expect(health.moduleCount).toBe(1);
  });

  it('should cache result and invalidate', async () => {
    const service = makeService({ modules: [] });

    const result1 = await service.getResult();
    const result2 = await service.getResult();
    expect(result1).toBe(result2); // same reference = cached

    service.invalidate();
    const result3 = await service.getResult();
    expect(result3).not.toBe(result1); // different reference
  });

  it('should return getModule detail for existing module', async () => {
    const service = makeService({
      modules: [{ entity_id: 'TestMod', name: 'TestMod' }],
      parts: [{ from_id: 'Entity1', module_id: 'TestMod' }],
      entityFiles: [{ entity_id: 'Entity1', file_path: '/test/e1.swift' }],
      recipeCount: 1,
    });

    const detail = await service.getModule('TestMod');

    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('TestMod');
    expect(detail!.layerName).toBeDefined();
    expect(Array.isArray(detail!.fileGroups)).toBe(true);
    expect(Array.isArray(detail!.recipes)).toBe(true);
    expect(typeof detail!.summary).toBe('string');
    expect(typeof detail!.uncoveredFileCount).toBe('number');
  });

  it('should enrich module files when modules exist but have no is_part_of edges', async () => {
    const service = makeService({
      modules: [
        { entity_id: 'BDFoundation', name: 'BDFoundation' },
        { entity_id: 'BDUIKit', name: 'BDUIKit' },
      ],
      allFiles: [
        { file_path: '/test/Sources/BDFoundation/a.swift' },
        { file_path: '/test/Sources/BDFoundation/b.swift' },
        { file_path: '/test/Sources/BDUIKit/c.swift' },
      ],
    });

    const overview = await service.getOverview();

    expect(overview.moduleCount).toBe(2);
    expect(overview.totalFiles).toBe(3);

    const foundationLayer = overview.layers
      .flatMap((l) => l.modules)
      .find((m) => m.name === 'BDFoundation');
    expect(foundationLayer?.fileCount).toBe(2);

    const uikitLayer = overview.layers.flatMap((l) => l.modules).find((m) => m.name === 'BDUIKit');
    expect(uikitLayer?.fileCount).toBe(1);
  });

  it('getModule should not hang when files have divergent paths (commonPathPrefix regression)', async () => {
    const service = makeService({
      modules: [{ entity_id: 'TestMod', name: 'TestMod' }],
      parts: [
        { from_id: 'fileA', module_id: 'TestMod' },
        { from_id: 'fileB', module_id: 'TestMod' },
        { from_id: 'fileC', module_id: 'TestMod' },
      ],
      entityFiles: [
        { entity_id: 'fileA', file_path: '/project/ModA/Sources/A.swift' },
        { entity_id: 'fileB', file_path: '/project/ModB/Sources/B.swift' },
        { entity_id: 'fileC', file_path: '/project/ModC/Sources/C.swift' },
      ],
    });

    // Should complete without hanging (was an infinite loop before the fix)
    const detail = await service.getModule('TestMod');
    expect(detail).not.toBeNull();
    expect(detail!.module.name).toBe('TestMod');
    expect(detail!.fileGroups.length).toBeGreaterThan(0);
  });

  it('getModule should handle files in completely different trees', async () => {
    const service = makeService({
      modules: [{ entity_id: 'DivMod', name: 'DivMod' }],
      parts: [
        { from_id: 'x1', module_id: 'DivMod' },
        { from_id: 'x2', module_id: 'DivMod' },
      ],
      entityFiles: [
        { entity_id: 'x1', file_path: '/alpha/src/a.ts' },
        { entity_id: 'x2', file_path: '/beta/src/b.ts' },
      ],
    });

    const detail = await service.getModule('DivMod');
    expect(detail).not.toBeNull();
    // With no common path, groups should be at root level
    expect(detail!.module.fileCount).toBe(2);
  });
});
