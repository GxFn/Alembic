/**
 * PanoramaAggregator 单元测试
 */
import { describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import type { ModuleCandidate } from '../../lib/service/panorama/RoleRefiner.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';
import { createMockRepos, type MockEdge, type MockRepoOptions } from '../helpers/panorama-mocks.js';

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('PanoramaAggregator', () => {
  function makeAggregator(
    opts: {
      moduleEdges?: MockEdge[];
      recipeCount?: number;
      recipeRows?: MockRepoOptions['recipeRows'];
    } = {}
  ) {
    const projectRoot = '/test';
    const repos = createMockRepos({
      edges: opts.moduleEdges,
      recipeCount: opts.recipeCount,
      recipeRows: opts.recipeRows,
    });
    return new PanoramaAggregator({
      roleRefiner: new RoleRefiner(
        repos.bootstrapRepo,
        repos.entityRepo,
        repos.edgeRepo,
        projectRoot
      ),
      couplingAnalyzer: new CouplingAnalyzer(repos.edgeRepo, repos.entityRepo, projectRoot),
      layerInferrer: new LayerInferrer(),
      bootstrapRepo: repos.bootstrapRepo,
      entityRepo: repos.entityRepo,
      edgeRepo: repos.edgeRepo,
      knowledgeRepo: repos.knowledgeRepo,
      projectRoot,
    });
  }

  it('should compute panorama for simple module set', async () => {
    const aggregator = makeAggregator({
      moduleEdges: [
        {
          from_id: 'App',
          from_type: 'module',
          to_id: 'Core',
          to_type: 'module',
          relation: 'depends_on',
        },
      ],
    });

    const candidates: ModuleCandidate[] = [
      { name: 'App', inferredRole: 'app', files: ['/test/app.swift'] },
      { name: 'Core', inferredRole: 'core', files: ['/test/core.swift'] },
    ];

    const result = await aggregator.compute(candidates);

    expect(result.modules.size).toBe(2);
    expect(result.modules.has('App')).toBe(true);
    expect(result.modules.has('Core')).toBe(true);
    expect(result.layers.levels.length).toBeGreaterThanOrEqual(1);
    expect(result.healthRadar).toBeDefined();
    expect(result.healthRadar.dimensions.length).toBe(25);
    expect(result.computedAt).toBeGreaterThan(0);
  });

  it('should detect dimension-based gaps when no recipes exist', async () => {
    const aggregator = makeAggregator({ recipeCount: 0, recipeRows: [] });

    const candidates: ModuleCandidate[] = [
      { name: 'BigModule', inferredRole: 'service', files: ['/a', '/b', '/c', '/d', '/e'] },
    ];

    const result = await aggregator.compute(candidates);

    // 所有 25 个维度都应为 gap (missing)
    expect(result.gaps.length).toBe(25);
    expect(result.gaps[0].status).toBe('missing');
    expect(result.gaps[0].dimension).toBeDefined();
    expect(result.gaps[0].dimensionName).toBeDefined();
    // service 角色关联 error-handling, concurrency, security → 高优
    const highGaps = result.gaps.filter((g) => g.priority === 'high');
    expect(highGaps.length).toBeGreaterThanOrEqual(1);
    // healthRadar 维度覆盖为 0
    expect(result.healthRadar.coveredDimensions).toBe(0);
    expect(result.healthRadar.overallScore).toBe(0);
  });

  it('should score dimensions based on recipe topicHint', async () => {
    const aggregator = makeAggregator({
      recipeCount: 8,
      recipeRows: [
        {
          title: 'SPM 模块化',
          category: 'architecture',
          topicHint: 'architecture',
          kind: 'pattern',
        },
        { title: '依赖注入', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '分层策略', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: 'URL 路由', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '入口架构', category: 'architecture', topicHint: 'architecture', kind: 'pattern' },
        { title: '命名规范', category: 'code-standard', topicHint: 'conventions', kind: 'rule' },
        { title: 'MARK 分段', category: 'code-standard', topicHint: 'conventions', kind: 'rule' },
        {
          title: '错误恢复',
          category: 'best-practice',
          topicHint: 'error-handling',
          kind: 'pattern',
        },
      ],
    });

    const candidates: ModuleCandidate[] = [
      { name: 'TestMod', inferredRole: 'service', files: ['/a', '/b', '/c'] },
    ];

    const result = await aggregator.compute(candidates);
    const radar = result.healthRadar;

    // architecture: 5 recipes → strong (score=100)
    const arch = radar.dimensions.find((d) => d.id === 'architecture')!;
    expect(arch.recipeCount).toBe(5);
    expect(arch.score).toBe(100);
    expect(arch.status).toBe('strong');
    expect(arch.level).toBe('adopt');

    // coding-standards: 2 recipes → adequate (score=40)
    const cs = radar.dimensions.find((d) => d.id === 'coding-standards')!;
    expect(cs.recipeCount).toBe(2);
    expect(cs.score).toBe(40);
    expect(cs.status).toBe('adequate');

    // error-resilience: 1 recipe → weak (score=20)
    const eh = radar.dimensions.find((d) => d.id === 'error-resilience')!;
    expect(eh.recipeCount).toBe(1);
    expect(eh.score).toBe(20);
    expect(eh.status).toBe('weak');

    // concurrency-async: 0 → missing
    const cc = radar.dimensions.find((d) => d.id === 'concurrency-async')!;
    expect(cc.recipeCount).toBe(0);
    expect(cc.status).toBe('missing');

    // 维度覆盖: 3 / 25
    expect(radar.coveredDimensions).toBe(3);
    expect(radar.totalDimensions).toBe(25);
  });

  it('should compute call flow summary', async () => {
    const aggregator = makeAggregator();

    const result = await aggregator.compute([{ name: 'Mod', inferredRole: 'feature', files: [] }]);

    expect(result.callFlowSummary).toBeDefined();
    expect(result.callFlowSummary.topCalledMethods.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty module set', async () => {
    const aggregator = makeAggregator();

    const result = await aggregator.compute([]);

    expect(result.modules.size).toBe(0);
    expect(result.cycles).toHaveLength(0);
    // 即使 0 个模块，维度雷达仍会生成
    expect(result.healthRadar.dimensions.length).toBe(25);
  });

  it('should populate PanoramaModule fields correctly', async () => {
    const aggregator = makeAggregator({ recipeCount: 3 });

    const candidates: ModuleCandidate[] = [
      { name: 'TestMod', inferredRole: 'service', files: ['/a', '/b', '/c'] },
    ];

    const result = await aggregator.compute(candidates);
    const mod = result.modules.get('TestMod')!;

    expect(mod.name).toBe('TestMod');
    expect(mod.inferredRole).toBe('service');
    expect(mod.fileCount).toBe(3);
    expect(mod.recipeCount).toBe(3);
    expect(mod.coverageRatio).toBe(1); // 3 recipes / 3 files
  });
});
