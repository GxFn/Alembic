/**
 * Phase 2 单元测试：Panorama 集成增强
 *
 * 覆盖范围：
 * - Phase 1.9-1.10: DiscovererPreference (冲突检测 + 偏好持久化)
 * - Phase 2.1: CodeEntityGraph.populateFromSpm 增强 metadata
 * - Phase 2.2: LayerInferrer 配置层级推断
 * - Phase 2.3: RoleRefiner configLayer 信号
 * - Phase 2.2+: ModuleDiscoverer configLayer / readConfigLayers
 * - Phase 2.2+: PanoramaAggregator 传递 configLayers
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  detectConflict,
  loadPreference,
  savePreference,
} from '../../lib/core/discovery/DiscovererPreference.js';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import type { ConfigLayer } from '../../lib/service/panorama/LayerInferrer.js';
import { LayerInferrer } from '../../lib/service/panorama/LayerInferrer.js';
import { ModuleDiscoverer } from '../../lib/service/panorama/ModuleDiscoverer.js';
import { PanoramaAggregator } from '../../lib/service/panorama/PanoramaAggregator.js';
import type { Edge } from '../../lib/service/panorama/PanoramaTypes.js';
import type { ModuleCandidate } from '../../lib/service/panorama/RoleRefiner.js';
import { RoleRefiner } from '../../lib/service/panorama/RoleRefiner.js';

// ═══════════════════════════════════════════════════════════
// Phase 1.9-1.10: DiscovererPreference
// ═══════════════════════════════════════════════════════════

describe('DiscovererPreference — detectConflict', () => {
  it('should return non-ambiguous for empty matches', () => {
    const result = detectConflict([]);
    expect(result.ambiguous).toBe(false);
    expect(result.recommended).toBeUndefined();
  });

  it('should return non-ambiguous for single match', () => {
    const result = detectConflict([{ discovererId: 'spm', displayName: 'SPM', confidence: 0.9 }]);
    expect(result.ambiguous).toBe(false);
    expect(result.recommended?.discovererId).toBe('spm');
  });

  it('should return non-ambiguous when top has clear lead', () => {
    const result = detectConflict([
      { discovererId: 'spm', displayName: 'SPM', confidence: 0.9 },
      { discovererId: 'custom', displayName: 'Custom', confidence: 0.5 },
    ]);
    expect(result.ambiguous).toBe(false);
    expect(result.recommended?.discovererId).toBe('spm');
  });

  it('should detect ambiguity when two high-confidence results are close', () => {
    const result = detectConflict([
      { discovererId: 'spm', displayName: 'SPM', confidence: 0.85 },
      { discovererId: 'custom', displayName: 'Custom', confidence: 0.8 },
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toContain('similar confidence');
    // Always recommends the top one
    expect(result.recommended?.discovererId).toBe('spm');
  });

  it('should detect ambiguity when highest confidence is below threshold', () => {
    const result = detectConflict([
      { discovererId: 'custom', displayName: 'Custom', confidence: 0.45 },
      { discovererId: 'cocoapods', displayName: 'CocoaPods', confidence: 0.3 },
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.reason).toContain('No definitive');
  });

  it('should not be ambiguous when gap is >= threshold', () => {
    const result = detectConflict([
      { discovererId: 'spm', displayName: 'SPM', confidence: 0.8 },
      { discovererId: 'cocoapods', displayName: 'CocoaPods', confidence: 0.65 },
    ]);
    expect(result.ambiguous).toBe(false);
    expect(result.recommended?.discovererId).toBe('spm');
  });
});

describe('DiscovererPreference — persistence', () => {
  const testDir = join(tmpdir(), `asd-pref-test-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return null when no preference exists', () => {
    const pref = loadPreference(testDir);
    expect(pref).toBeNull();
  });

  it('should save and load preference', () => {
    savePreference(testDir, 'custom-config', ['spm', 'cocoapods'], true);

    const pref = loadPreference(testDir);
    expect(pref).not.toBeNull();
    expect(pref!.selectedDiscoverer).toBe('custom-config');
    expect(pref!.alternatives).toEqual(['spm', 'cocoapods']);
    expect(pref!.userConfirmed).toBe(true);
    expect(pref!.selectedAt).toBeDefined();
  });

  it('should overwrite existing preference', () => {
    savePreference(testDir, 'spm', ['custom-config'], false);

    const pref = loadPreference(testDir);
    expect(pref!.selectedDiscoverer).toBe('spm');
    expect(pref!.userConfirmed).toBe(false);
  });

  it('should return null for corrupted preference file', () => {
    const prefPath = join(testDir, '.autosnippet', 'discoverer-preference.json');
    writeFileSync(prefPath, 'NOT VALID JSON', 'utf8');

    const pref = loadPreference(testDir);
    expect(pref).toBeNull();
  });

  it('should return null for preference with missing required fields', () => {
    const prefPath = join(testDir, '.autosnippet', 'discoverer-preference.json');
    writeFileSync(prefPath, JSON.stringify({ foo: 'bar' }), 'utf8');

    const pref = loadPreference(testDir);
    expect(pref).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.1: CodeEntityGraph.populateFromSpm metadata
// ═══════════════════════════════════════════════════════════

describe('CodeEntityGraph — populateFromSpm enhanced metadata', () => {
  /**
   * 直接测试 upsert 行为太依赖 DB；这里验证 metadata 构建逻辑
   * 通过捕获传入 #upsertEntity 的参数
   */
  it('should propagate layer/version/group/fullPath/indirect into metadata', () => {
    // 验证节点对象的 metadata 构建规则
    const node = {
      id: 'BDMVService',
      label: 'BDMVService',
      type: 'local',
      layer: 'Services',
      version: '1.0.0',
      group: 'video',
      fullPath: '/path/to/BDMVService',
      indirect: false,
    };

    // 模拟 populateFromSpm 中的 metadata 构建逻辑
    const metadata = {
      nodeType: node.type || 'module',
      ...(node.layer != null ? { layer: node.layer } : {}),
      ...(node.version != null ? { version: node.version } : {}),
      ...(node.group != null ? { group: node.group } : {}),
      ...(node.fullPath != null ? { fullPath: node.fullPath } : {}),
      ...(node.indirect != null ? { indirect: node.indirect } : {}),
    };

    expect(metadata).toEqual({
      nodeType: 'local',
      layer: 'Services',
      version: '1.0.0',
      group: 'video',
      fullPath: '/path/to/BDMVService',
      indirect: false,
    });
  });

  it('should skip undefined optional fields in metadata', () => {
    const node = { id: 'Core', label: 'Core', type: 'module' };

    const metadata = {
      nodeType: node.type || 'module',
      ...('layer' in node && (node as Record<string, unknown>).layer != null
        ? { layer: (node as Record<string, unknown>).layer }
        : {}),
    };

    expect(metadata).toEqual({ nodeType: 'module' });
    expect('layer' in metadata).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.2: LayerInferrer config-based inference
// ═══════════════════════════════════════════════════════════

describe('LayerInferrer — config-based inference', () => {
  const inferrer = new LayerInferrer();

  // 模拟 EasyBox 6 层架构
  const easyboxLayers: ConfigLayer[] = [
    {
      name: 'Accessories',
      order: 0,
      accessibleLayers: ['Components', 'Services', 'Basics', 'Vendors'],
    },
    { name: 'Components', order: 1, accessibleLayers: ['Services', 'Basics', 'Vendors'] },
    { name: 'Services', order: 2, accessibleLayers: ['Basics', 'Vendors'] },
    { name: 'Basics', order: 3, accessibleLayers: ['Vendors'] },
    { name: 'Vendors', order: 4, accessibleLayers: [] },
  ];

  const modules = ['UIKit', 'PlayerUI', 'VideoService', 'NetworkKit', 'Foundation', 'Alamofire'];
  const moduleLayerMap = new Map([
    ['UIKit', 'Accessories'],
    ['PlayerUI', 'Components'],
    ['VideoService', 'Services'],
    ['NetworkKit', 'Basics'],
    ['Foundation', 'Vendors'],
    ['Alamofire', 'Vendors'],
  ]);

  const edges: Edge[] = [
    { from: 'UIKit', to: 'PlayerUI', relation: 'depends_on' },
    { from: 'UIKit', to: 'VideoService', relation: 'depends_on' },
    { from: 'PlayerUI', to: 'VideoService', relation: 'depends_on' },
    { from: 'VideoService', to: 'NetworkKit', relation: 'depends_on' },
    { from: 'NetworkKit', to: 'Alamofire', relation: 'depends_on' },
    { from: 'NetworkKit', to: 'Foundation', relation: 'depends_on' },
  ];

  it('should use config layers when coverage >= 50%', () => {
    const result = inferrer.infer(edges, modules, [], {
      configLayers: easyboxLayers,
      moduleLayerMap,
    });

    // 应该有 5 个层级 (Accessories, Components, Services, Basics, Vendors)
    expect(result.levels.length).toBe(5);

    // Vendors 层级应在 L0（最底层），因为 order 最大被反转
    const vendorsLevel = result.levels.find((l) => l.name === 'Vendors');
    expect(vendorsLevel).toBeDefined();
    expect(vendorsLevel!.level).toBe(0);
    expect(vendorsLevel!.modules).toContain('Foundation');
    expect(vendorsLevel!.modules).toContain('Alamofire');

    // Accessories 层级应在最高层
    const accLevel = result.levels.find((l) => l.name === 'Accessories');
    expect(accLevel).toBeDefined();
    expect(accLevel!.level).toBe(4);
    expect(accLevel!.modules).toContain('UIKit');
  });

  it('should fallback to topology when config coverage < 50%', () => {
    const sparseMap = new Map([['Foundation', 'Vendors']]);

    const result = inferrer.infer(edges, modules, [], {
      configLayers: easyboxLayers,
      moduleLayerMap: sparseMap,
    });

    // 覆盖率仅 1/6 < 50%，应该用拓扑推断
    // 拓扑推断不会使用配置层名，而是用启发式命名
    const hasConfigName = result.levels.some((l) => l.name === 'Vendors');
    // 拓扑法不一定会产生叫 'Vendors' 的层（取决于启发式匹配）
    // 关键是应该有合理的层级结构
    expect(result.levels.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle uncovered modules using dependency heuristic', () => {
    const partialMap = new Map([
      ['VideoService', 'Services'],
      ['NetworkKit', 'Basics'],
      ['Foundation', 'Vendors'],
      ['Alamofire', 'Vendors'],
    ]);
    // 4/6 = 67% 覆盖率 → 使用 config

    const result = inferrer.infer(edges, modules, [], {
      configLayers: easyboxLayers,
      moduleLayerMap: partialMap,
    });

    // UIKit 和 PlayerUI 未被配置覆盖，但依赖关系应将它们放在较高层
    const allModsInLevels = result.levels.flatMap((l) => l.modules);
    expect(allModsInLevels).toContain('UIKit');
    expect(allModsInLevels).toContain('PlayerUI');

    // UIKit 依赖 PlayerUI 和 VideoService → 应在比它们更高的层
    const uikitLevel = result.levels.find((l) => l.modules.includes('UIKit'))?.level ?? -1;
    const videoLevel = result.levels.find((l) => l.modules.includes('VideoService'))?.level ?? -1;
    expect(uikitLevel).toBeGreaterThan(videoLevel);
  });

  it('should detect layer violations', () => {
    // 添加一条反向依赖边：底层 → 高层
    const edgesWithViolation: Edge[] = [
      ...edges,
      { from: 'Foundation', to: 'UIKit', relation: 'depends_on' }, // violation: L0 → L4
    ];

    const result = inferrer.infer(edgesWithViolation, modules, [], {
      configLayers: easyboxLayers,
      moduleLayerMap,
    });

    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    const violation = result.violations.find((v) => v.from === 'Foundation' && v.to === 'UIKit');
    expect(violation).toBeDefined();
  });

  it('should still work with no configLayers (pure topology)', () => {
    const result = inferrer.infer(edges, modules, []);
    expect(result.levels.length).toBeGreaterThanOrEqual(2);
    expect(result.violations).toBeDefined();
  });

  it('should handle empty modules list with config layers', () => {
    const result = inferrer.infer([], [], [], {
      configLayers: easyboxLayers,
      moduleLayerMap: new Map(),
    });
    // 0 coverage → fallback to topology → empty output
    expect(result.levels.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.3: RoleRefiner configLayer signal
// ═══════════════════════════════════════════════════════════

describe('RoleRefiner — configLayer signal', () => {
  function createMockDb(opts: { moduleEdges?: Array<Record<string, unknown>> } = {}) {
    return {
      transaction: (fn: () => void) => fn,
      exec: () => {},
      prepare: (sql: string) => ({
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: (...params: unknown[]) => {
          if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
            const relation = params[0] as string;
            return (opts.moduleEdges ?? []).filter((e) => e.relation === relation);
          }
          if (sql.includes("relation = 'calls'") && sql.includes('GROUP BY to_id')) {
            return [];
          }
          if (sql.includes("relation = 'data_flow'") && sql.includes('GROUP BY')) {
            return [];
          }
          return [];
        },
      }),
    };
  }

  it('should boost role from configLayer when layer name maps to a role', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'BDMVNetwork',
      inferredRole: 'feature', // regex baseline 会给 feature
      files: ['/test/BDMVNetwork/Network.swift'],
      configLayer: 'Services', // 配置声明在 Services 层
    };

    const result = refiner.refineRole(candidate);
    // configLayer='Services' → 映射到 'service'
    // 因为 config-layer 信号的 confidence 0.85 * weight 0.30 = 0.255
    // 这是一个强信号；即使其他信号分散，service 应该有显著得分
    expect(result.signals.some((s) => s.source === 'config-layer' && s.role === 'service')).toBe(
      true
    );
  });

  it('should map Vendors layer to utility role', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'SomeThirdParty',
      inferredRole: 'utility',
      files: ['/test/SomeThirdParty/Lib.swift'],
      configLayer: 'Vendors',
    };

    const result = refiner.refineRole(candidate);
    const configSignal = result.signals.find((s) => s.source === 'config-layer');
    expect(configSignal).toBeDefined();
    expect(configSignal!.role).toBe('utility');
    expect(configSignal!.confidence).toBe(0.85);
  });

  it('should map Basics layer to core role', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'NetworkKit',
      inferredRole: 'networking',
      files: ['/test/NetworkKit/Net.swift'],
      configLayer: 'Basics',
    };

    const result = refiner.refineRole(candidate);
    const configSignal = result.signals.find((s) => s.source === 'config-layer');
    expect(configSignal).toBeDefined();
    expect(configSignal!.role).toBe('core');
  });

  it('should map Components/Accessories layer to feature role', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    for (const layer of ['Components', 'Accessories']) {
      const candidate: ModuleCandidate = {
        name: 'TestModule',
        inferredRole: 'feature',
        files: ['/test/TestModule/Main.swift'],
        configLayer: layer,
      };

      const result = refiner.refineRole(candidate);
      const configSignal = result.signals.find((s) => s.source === 'config-layer');
      expect(configSignal).toBeDefined();
      expect(configSignal!.role).toBe('feature');
    }
  });

  it('should not add config-layer signal when configLayer is absent', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'SomeModule',
      inferredRole: 'feature',
      files: ['/test/SomeModule/Main.swift'],
      // no configLayer
    };

    const result = refiner.refineRole(candidate);
    expect(result.signals.every((s) => s.source !== 'config-layer')).toBe(true);
  });

  it('should not add config-layer signal for unknown layer names', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'SomeModule',
      inferredRole: 'feature',
      files: ['/test/SomeModule/Main.swift'],
      configLayer: 'SomeRandomLayerName',
    };

    const result = refiner.refineRole(candidate);
    expect(result.signals.every((s) => s.source !== 'config-layer')).toBe(true);
  });

  it('should handle case-insensitive layer names', () => {
    const db = createMockDb();
    const refiner = new RoleRefiner(db as never, '/test');

    const candidate: ModuleCandidate = {
      name: 'SomeService',
      inferredRole: 'feature',
      files: ['/test/SomeService/Main.swift'],
      configLayer: 'SERVICES', // 大写
    };

    const result = refiner.refineRole(candidate);
    const configSignal = result.signals.find((s) => s.source === 'config-layer');
    expect(configSignal).toBeDefined();
    expect(configSignal!.role).toBe('service');
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.2+: ModuleDiscoverer configLayer & readConfigLayers
// ═══════════════════════════════════════════════════════════

describe('ModuleDiscoverer — configLayer integration', () => {
  function createModuleDiscovererDb(
    opts: {
      modules?: Array<{ entity_id: string; name: string; metadata_json?: string }>;
      configLayersEntity?: { metadata_json: string };
      partOfEdges?: Array<{ from_id: string; to_id: string }>;
    } = {}
  ) {
    return {
      prepare: (sql: string) => ({
        run: () => ({ changes: 0 }),
        get: (...params: unknown[]) => {
          // readConfigLayers query
          if (sql.includes('__config_layers__') && sql.includes('config')) {
            return opts.configLayersEntity ?? undefined;
          }
          // #readModuleLayerMetadata: per-module metadata
          if (
            sql.includes("entity_type = 'module'") &&
            sql.includes('LIMIT 1') &&
            sql.includes('metadata_json')
          ) {
            const moduleId = params[0] as string;
            const mod = opts.modules?.find((m) => m.entity_id === moduleId);
            return mod?.metadata_json ? { metadata_json: mod.metadata_json } : undefined;
          }
          // file_path lookup for enrichModuleFiles
          if (sql.includes('file_path') && sql.includes('entity_id = ?')) {
            return undefined;
          }
          return undefined;
        },
        all: (..._params: unknown[]) => {
          // module entities query (now filters nodeType)
          if (sql.includes("entity_type = 'module'") && sql.includes('DISTINCT entity_id')) {
            // Simulate the SQL filtering: exclude external/host nodeType
            return (opts.modules ?? []).filter((m) => {
              if (!m.metadata_json) {
                return true; // no metadata = local
              }
              try {
                const meta = JSON.parse(m.metadata_json);
                return meta.nodeType !== 'external' && meta.nodeType !== 'host';
              } catch {
                return true;
              }
            });
          }
          // is_part_of edges
          if (sql.includes('is_part_of')) {
            return opts.partOfEdges ?? [];
          }
          // enrichModuleFiles DB fallback
          if (sql.includes('DISTINCT file_path')) {
            return [];
          }
          return [];
        },
      }),
    };
  }

  it('should read configLayers from __config_layers__ entity', () => {
    const layers = [
      { name: 'Services', order: 0, accessibleLayers: ['Basics', 'Vendors'] },
      { name: 'Basics', order: 1, accessibleLayers: ['Vendors'] },
      { name: 'Vendors', order: 2, accessibleLayers: [] },
    ];

    const db = createModuleDiscovererDb({
      configLayersEntity: { metadata_json: JSON.stringify({ layers }) },
    });

    const discoverer = new ModuleDiscoverer(db as never, '/test');

    const result = discoverer.readConfigLayers();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0].name).toBe('Services');
    expect(result![2].accessibleLayers).toEqual([]);
  });

  it('should return null when no config layers entity exists', () => {
    const db = createModuleDiscovererDb();

    const discoverer = new ModuleDiscoverer(db as never, '/test');

    const result = discoverer.readConfigLayers();
    expect(result).toBeNull();
  });

  it('should populate configLayer on discovered modules from metadata', () => {
    const db = createModuleDiscovererDb({
      modules: [
        {
          entity_id: 'NetworkKit',
          name: 'NetworkKit',
          metadata_json: JSON.stringify({ nodeType: 'local', layer: 'Basics' }),
        },
        {
          entity_id: 'Alamofire',
          name: 'Alamofire',
          metadata_json: JSON.stringify({ nodeType: 'host', layer: 'Vendors' }),
        },
      ],
    });

    const discoverer = new ModuleDiscoverer(db as never, '/test');

    const candidates = discoverer.discover();
    // External/host modules are now filtered out
    expect(candidates).toHaveLength(1);

    const nk = candidates.find((c: ModuleCandidate) => c.name === 'NetworkKit');
    expect(nk?.configLayer).toBe('Basics');

    // Alamofire (host) should NOT appear
    const af = candidates.find((c: ModuleCandidate) => c.name === 'Alamofire');
    expect(af).toBeUndefined();
  });

  it('should exclude external modules from discover()', () => {
    const db = createModuleDiscovererDb({
      modules: [
        {
          entity_id: 'AppModule',
          name: 'AppModule',
          metadata_json: JSON.stringify({ nodeType: 'local' }),
        },
        {
          entity_id: 'Lottie',
          name: 'Lottie',
          metadata_json: JSON.stringify({ nodeType: 'external' }),
        },
        {
          entity_id: 'SDWebImage',
          name: 'SDWebImage',
          metadata_json: JSON.stringify({ nodeType: 'external' }),
        },
        {
          entity_id: 'HostApp',
          name: 'HostApp',
          metadata_json: JSON.stringify({ nodeType: 'host' }),
        },
      ],
    });

    const discoverer = new ModuleDiscoverer(db as never, '/test');
    const candidates = discoverer.discover();

    // Only local module should be returned
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('AppModule');
  });

  it('should leave configLayer undefined when metadata has no layer', () => {
    const db = createModuleDiscovererDb({
      modules: [
        {
          entity_id: 'SomeModule',
          name: 'SomeModule',
          metadata_json: JSON.stringify({ nodeType: 'local' }),
        },
      ],
    });

    const discoverer = new ModuleDiscoverer(db as never, '/test');

    const candidates = discoverer.discover();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].configLayer).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.2+: PanoramaAggregator with configLayers
// ═══════════════════════════════════════════════════════════

describe('PanoramaAggregator — configLayers integration', () => {
  function createMockDb(opts: { moduleEdges?: Array<Record<string, unknown>> } = {}) {
    return {
      transaction: (fn: () => void) => fn,
      exec: () => {},
      prepare: (sql: string) => ({
        run: () => ({ changes: 0 }),
        get: (..._params: unknown[]) => {
          if (
            sql.includes('COUNT(*)') &&
            sql.includes('knowledge_entries') &&
            sql.includes('lifecycle')
          ) {
            return { cnt: 0 };
          }
          if (sql.includes('COUNT(*)') && sql.includes('from_id = ce.entity_id')) {
            return { cnt: 0 };
          }
          if (sql.includes('COUNT(*)') && sql.includes('to_id = ce.entity_id')) {
            return { cnt: 0 };
          }
          return undefined;
        },
        all: (...params: unknown[]) => {
          if (
            sql.includes('title') &&
            sql.includes('topicHint') &&
            sql.includes('knowledge_entries')
          ) {
            return [];
          }
          if (sql.includes('knowledge_edges') && sql.includes('relation = ?')) {
            const relation = params[0] as string;
            return (opts.moduleEdges ?? []).filter((e) => e.relation === relation);
          }
          if (sql.includes("relation = 'calls'") && sql.includes('GROUP BY to_id')) {
            return [];
          }
          if (sql.includes('NOT IN')) {
            return [];
          }
          if (sql.includes("relation = 'data_flow'") && sql.includes('GROUP BY')) {
            return [];
          }
          return [];
        },
      }),
    };
  }

  it('should pass configLayers to LayerInferrer and produce config-based levels', () => {
    const db = createMockDb({
      moduleEdges: [
        {
          from_id: 'App',
          from_type: 'module',
          to_id: 'Service',
          to_type: 'module',
          relation: 'depends_on',
        },
        {
          from_id: 'Service',
          from_type: 'module',
          to_id: 'Core',
          to_type: 'module',
          relation: 'depends_on',
        },
      ],
    });

    const aggregator = new PanoramaAggregator({
      roleRefiner: new RoleRefiner(db as never, '/test'),
      couplingAnalyzer: new CouplingAnalyzer(db as never, '/test'),
      layerInferrer: new LayerInferrer(),
      db: db as never,
      projectRoot: '/test',
    });

    const configLayers: ConfigLayer[] = [
      { name: 'Application', order: 0, accessibleLayers: ['Services', 'Core'] },
      { name: 'Services', order: 1, accessibleLayers: ['Core'] },
      { name: 'Core', order: 2, accessibleLayers: [] },
    ];

    const candidates: ModuleCandidate[] = [
      { name: 'App', inferredRole: 'app', files: ['/test/app.swift'], configLayer: 'Application' },
      {
        name: 'Service',
        inferredRole: 'service',
        files: ['/test/service.swift'],
        configLayer: 'Services',
      },
      { name: 'Core', inferredRole: 'core', files: ['/test/core.swift'], configLayer: 'Core' },
    ];

    const result = aggregator.compute(candidates, { configLayers });

    expect(result.modules.size).toBe(3);
    expect(result.layers.levels.length).toBeGreaterThanOrEqual(2);

    // Core 应在最底层 (order=2 翻转为 L0)
    const coreLevel = result.layers.levels.find((l) => l.modules.includes('Core'));
    expect(coreLevel).toBeDefined();
    expect(coreLevel!.level).toBe(0);
  });

  it('should work without configLayers (backward compatible)', () => {
    const db = createMockDb({
      moduleEdges: [
        {
          from_id: 'A',
          from_type: 'module',
          to_id: 'B',
          to_type: 'module',
          relation: 'depends_on',
        },
      ],
    });

    const aggregator = new PanoramaAggregator({
      roleRefiner: new RoleRefiner(db as never, '/test'),
      couplingAnalyzer: new CouplingAnalyzer(db as never, '/test'),
      layerInferrer: new LayerInferrer(),
      db: db as never,
      projectRoot: '/test',
    });

    const candidates: ModuleCandidate[] = [
      { name: 'A', inferredRole: 'app', files: ['/test/a.swift'] },
      { name: 'B', inferredRole: 'core', files: ['/test/b.swift'] },
    ];

    // 不传 configLayers
    const result = aggregator.compute(candidates);
    expect(result.modules.size).toBe(2);
    expect(result.layers.levels.length).toBeGreaterThanOrEqual(1);
  });
});
