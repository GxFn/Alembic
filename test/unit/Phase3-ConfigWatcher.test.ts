/**
 * Phase 2.5 ~ 3.6 单元测试
 *
 * 覆盖范围：
 * - Phase 2.5: CouplingAnalyzer 外部依赖 fan-in
 * - Phase 2.6: TechStackProfiler 技术栈画像
 * - Phase 3.1-3.3: ConfigWatcher (debounce + hash + 生命周期)
 * - Phase 3.5: YamlConfigParser (XcodeGen project.yml)
 * - Phase 3.6: CustomConfigDiscoverer 用户自定义配置
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigWatcher } from '../../lib/core/discovery/ConfigWatcher.js';
import { CustomConfigDiscoverer } from '../../lib/core/discovery/CustomConfigDiscoverer.js';
import {
  extractXcodeGenDependencyEdges,
  parseXcodeGenProject,
  parseXcodeGenTarget,
} from '../../lib/core/discovery/parsers/YamlConfigParser.js';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import type { ExternalDepProfile } from '../../lib/service/panorama/PanoramaTypes.js';
import { profileTechStack } from '../../lib/service/panorama/TechStackProfiler.js';

// ═══════════════════════════════════════════════════════════
// Phase 2.5: CouplingAnalyzer — External Fan-in
// ═══════════════════════════════════════════════════════════

describe('CouplingAnalyzer — External Fan-in', () => {
  function createMockDb(opts: { moduleEdges?: Array<Record<string, unknown>> } = {}) {
    return {
      transaction: (fn: () => void) => fn,
      exec: () => {},
      prepare: (sql: string) => ({
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: (..._params: unknown[]) => {
          if (sql.includes('knowledge_edges')) {
            return opts.moduleEdges ?? [];
          }
          return [];
        },
      }),
    };
  }

  it('should return empty externalDeps when no externalModules provided', () => {
    const db = createMockDb();
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModuleA', ['a.swift']],
      ['ModuleB', ['b.swift']],
    ]);

    const result = analyzer.analyze(moduleFiles);
    expect(result.externalDeps).toEqual([]);
  });

  it('should return empty externalDeps when no matching edges', () => {
    const db = createMockDb({ moduleEdges: [] });
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([['ModuleA', ['a.swift']]]);
    const externalModules = new Set(['RxSwift', 'Alamofire']);

    const result = analyzer.analyze(moduleFiles, externalModules);
    expect(result.externalDeps).toEqual([]);
  });

  it('should compute fan-in for external modules from edges', () => {
    const db = createMockDb({
      moduleEdges: [
        {
          from_id: 'ModuleA',
          to_id: 'RxSwift',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
        {
          from_id: 'ModuleB',
          to_id: 'RxSwift',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
        {
          from_id: 'ModuleA',
          to_id: 'Alamofire',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
      ],
    });
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['ModuleA', ['a.swift']],
      ['ModuleB', ['b.swift']],
    ]);
    const externalModules = new Set(['RxSwift', 'Alamofire']);

    const result = analyzer.analyze(moduleFiles, externalModules);
    expect(result.externalDeps.length).toBe(2);

    // RxSwift should have higher fan-in (2 dependBy)
    const rxDep = result.externalDeps.find((d) => d.name === 'RxSwift');
    expect(rxDep).toBeDefined();
    expect(rxDep!.fanIn).toBe(2);
    expect(rxDep!.dependedBy).toEqual(expect.arrayContaining(['ModuleA', 'ModuleB']));

    const alamofireDep = result.externalDeps.find((d) => d.name === 'Alamofire');
    expect(alamofireDep).toBeDefined();
    expect(alamofireDep!.fanIn).toBe(1);
  });

  it('should sort externalDeps by fan-in descending', () => {
    const db = createMockDb({
      moduleEdges: [
        {
          from_id: 'A',
          to_id: 'X',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
        {
          from_id: 'B',
          to_id: 'X',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
        {
          from_id: 'C',
          to_id: 'X',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
        {
          from_id: 'A',
          to_id: 'Y',
          relation: 'depends_on',
          weight: 0.5,
          from_type: 'module',
          to_type: 'module',
        },
      ],
    });
    const analyzer = new CouplingAnalyzer(db as never, '/test');

    const moduleFiles = new Map([
      ['A', ['a.swift']],
      ['B', ['b.swift']],
      ['C', ['c.swift']],
    ]);

    const result = analyzer.analyze(moduleFiles, new Set(['X', 'Y']));
    expect(result.externalDeps[0].name).toBe('X');
    expect(result.externalDeps[0].fanIn).toBe(3);
    expect(result.externalDeps[1].name).toBe('Y');
    expect(result.externalDeps[1].fanIn).toBe(1);
  });

  it('should include externalDeps in CouplingResult type', () => {
    const db = createMockDb();
    const analyzer = new CouplingAnalyzer(db as never, '/test');
    const result = analyzer.analyze(new Map());
    expect(result).toHaveProperty('externalDeps');
    expect(Array.isArray(result.externalDeps)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 2.6: TechStackProfiler
// ═══════════════════════════════════════════════════════════

describe('TechStackProfiler — profileTechStack', () => {
  it('should return empty profile for no deps', () => {
    const result = profileTechStack([]);
    expect(result.categories).toEqual([]);
    expect(result.hotspots).toEqual([]);
    expect(result.totalExternalDeps).toBe(0);
  });

  it('should classify known libraries correctly', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'Alamofire', fanIn: 5, dependedBy: ['A', 'B', 'C', 'D', 'E'] },
      { name: 'SDWebImage', fanIn: 3, dependedBy: ['A', 'B', 'C'] },
      { name: 'SnapKit', fanIn: 8, dependedBy: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
    ];

    const result = profileTechStack(deps);
    expect(result.totalExternalDeps).toBe(3);

    // Verify categories were assigned
    const alamofire = deps.find((d) => d.name === 'Alamofire');
    expect(alamofire?.category).toBe('Networking');

    const sd = deps.find((d) => d.name === 'SDWebImage');
    expect(sd?.category).toBe('Image');

    const snap = deps.find((d) => d.name === 'SnapKit');
    expect(snap?.category).toBe('UI');
  });

  it('should group deps by category', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'Alamofire', fanIn: 5, dependedBy: ['A'] },
      { name: 'Moya', fanIn: 3, dependedBy: ['B'] },
      { name: 'SnapKit', fanIn: 2, dependedBy: ['C'] },
    ];

    const result = profileTechStack(deps);
    const networking = result.categories.find((c) => c.name === 'Networking');
    expect(networking).toBeDefined();
    expect(networking!.deps).toHaveLength(2);
    expect(networking!.deps[0].name).toBe('Alamofire'); // higher fan-in first
  });

  it('should identify hotspots (fan-in >= 3)', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'RxSwift', fanIn: 10, dependedBy: Array(10).fill('M') },
      { name: 'Lottie', fanIn: 1, dependedBy: ['A'] },
      { name: 'SnapKit', fanIn: 5, dependedBy: Array(5).fill('N') },
    ];

    const result = profileTechStack(deps);
    expect(result.hotspots).toHaveLength(2);
    expect(result.hotspots[0].name).toBe('RxSwift'); // sorted by fan-in desc
    expect(result.hotspots[1].name).toBe('SnapKit');
  });

  it('should classify unknown libs using keyword heuristics', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'BDMVNetworkKit', fanIn: 2, dependedBy: ['A', 'B'] },
      { name: 'BDMVImageLoader', fanIn: 1, dependedBy: ['C'] },
      { name: 'SomeRandomLib', fanIn: 1, dependedBy: ['D'] },
    ];

    const result = profileTechStack(deps);

    const net = deps.find((d) => d.name === 'BDMVNetworkKit');
    expect(net?.category).toBe('Networking');

    const img = deps.find((d) => d.name === 'BDMVImageLoader');
    expect(img?.category).toBe('Image');

    const random = deps.find((d) => d.name === 'SomeRandomLib');
    expect(random?.category).toBe('Other');
  });

  it('should handle reactive libraries', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'RxSwift', fanIn: 5, dependedBy: ['A'] },
      { name: 'RxCocoa', fanIn: 3, dependedBy: ['B'] },
    ];

    const result = profileTechStack(deps);
    const reactive = result.categories.find((c) => c.name === 'Reactive');
    expect(reactive).toBeDefined();
    expect(reactive!.deps).toHaveLength(2);
  });

  it('should sort categories by dep count descending', () => {
    const deps: ExternalDepProfile[] = [
      { name: 'Alamofire', fanIn: 1, dependedBy: ['A'] },
      { name: 'RxSwift', fanIn: 1, dependedBy: ['B'] },
      { name: 'RxCocoa', fanIn: 1, dependedBy: ['C'] },
      { name: 'SnapKit', fanIn: 1, dependedBy: ['D'] },
      { name: 'Masonry', fanIn: 1, dependedBy: ['E'] },
      { name: 'Lottie', fanIn: 1, dependedBy: ['F'] },
    ];

    const result = profileTechStack(deps);
    // UI has 3 deps (SnapKit + Masonry + Lottie), Reactive has 2, Networking has 1
    expect(result.categories[0].name).toBe('UI');
    expect(result.categories[0].deps).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 3.1-3.3: ConfigWatcher
// ═══════════════════════════════════════════════════════════

describe('ConfigWatcher — lifecycle', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `autosnippet-configwatcher-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should construct without errors', () => {
    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'easybox',
    });
    expect(watcher).toBeDefined();
    expect(watcher.active).toBe(false);
    expect(watcher.watchedFileCount).toBe(0);
  });

  it('should dispose cleanly', () => {
    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'easybox',
    });
    watcher.dispose();
    expect(watcher.active).toBe(false);
  });

  it('should handle unknown system id gracefully', async () => {
    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'unknown-system',
    });

    await watcher.start();
    expect(watcher.active).toBe(false);
    watcher.dispose();
  });

  it('should start and watch easybox Boxfile', async () => {
    // Create a Boxfile in the test dir
    writeFileSync(join(testDir, 'Boxfile'), "host_app 'TestApp'\n");

    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'easybox',
      debounceMs: 100,
    });

    await watcher.start();
    expect(watcher.active).toBe(true);
    expect(watcher.watchedFileCount).toBeGreaterThanOrEqual(1);

    watcher.dispose();
    expect(watcher.active).toBe(false);
  });

  it('should accept custom debounce and fullRebuildInterval', () => {
    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'easybox',
      debounceMs: 5000,
      fullRebuildIntervalMs: 120_000,
    });
    expect(watcher).toBeDefined();
    watcher.dispose();
  });

  it('should accept onChange callback', async () => {
    const onChange = vi.fn();
    const watcher = new ConfigWatcher({
      projectRoot: testDir,
      systemId: 'easybox',
      onChange,
    });
    expect(watcher).toBeDefined();
    watcher.dispose();
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 3.5: YamlConfigParser (XcodeGen)
// ═══════════════════════════════════════════════════════════

describe('YamlConfigParser — parseXcodeGenProject', () => {
  it('should return empty result for invalid YAML', () => {
    const result = parseXcodeGenProject('not: [valid: yaml:');
    // Should not throw, return defaults
    expect(result.layers).toBeDefined();
  });

  it('should return empty result for empty YAML', () => {
    const result = parseXcodeGenProject('');
    expect(result.layers).toEqual([]);
    expect(result.globalDependencies).toEqual([]);
  });

  it('should extract project name as host app', () => {
    const result = parseXcodeGenProject(`
name: MyApp
targets: {}
`);
    expect(result.hostApp).toEqual({ name: 'MyApp', version: '0.0.0' });
  });

  it('should extract targets and group by type', () => {
    const result = parseXcodeGenProject(`
name: MyApp
targets:
  MyApp:
    type: application
    platform: iOS
    sources:
      - Sources/MyApp
    dependencies:
      - target: CoreModule
  CoreModule:
    type: framework
    platform: iOS
    sources:
      - Sources/CoreModule
  MyAppTests:
    type: unit-test
    platform: iOS
    sources:
      - Tests/MyAppTests
`);

    // Should have layers: App, Framework, Test
    expect(result.layers.length).toBeGreaterThanOrEqual(2);

    const appLayer = result.layers.find((l) => l.name === 'App');
    expect(appLayer).toBeDefined();
    expect(appLayer!.modules.some((m) => m.name === 'MyApp')).toBe(true);

    const fwLayer = result.layers.find((l) => l.name === 'Framework');
    expect(fwLayer).toBeDefined();
    expect(fwLayer!.modules.some((m) => m.name === 'CoreModule')).toBe(true);

    const testLayer = result.layers.find((l) => l.name === 'Test');
    expect(testLayer).toBeDefined();
    expect(testLayer!.modules.some((m) => m.name === 'MyAppTests')).toBe(true);
  });

  it('should extract source paths from targets', () => {
    const result = parseXcodeGenProject(`
name: MyApp
targets:
  MyApp:
    type: application
    sources:
      - Sources/MyApp
`);

    const appModule = result.layers.flatMap((l) => l.modules).find((m) => m.name === 'MyApp');
    expect(appModule?.localPath).toBe('Sources/MyApp');
  });

  it('should extract SPM packages as global dependencies', () => {
    const result = parseXcodeGenProject(`
name: MyApp
packages:
  Alamofire:
    url: https://github.com/Alamofire/Alamofire.git
    from: "5.6.0"
  RxSwift:
    url: https://github.com/ReactiveX/RxSwift.git
    from: "6.5.0"
targets:
  MyApp:
    type: application
    sources:
      - Sources
`);

    expect(result.globalDependencies).toHaveLength(2);

    const ala = result.globalDependencies.find((d) => d.name === 'Alamofire');
    expect(ala).toBeDefined();
    expect(ala!.version).toBe('5.6.0');
    expect(ala!.isLocal).toBe(false);

    const rx = result.globalDependencies.find((d) => d.name === 'RxSwift');
    expect(rx).toBeDefined();
    expect(rx!.version).toBe('6.5.0');
  });

  it('should handle local SPM packages', () => {
    const result = parseXcodeGenProject(`
name: MyApp
packages:
  LocalPkg:
    path: ../LocalPkg
targets:
  MyApp:
    type: application
    sources:
      - Sources
`);

    const local = result.globalDependencies.find((d) => d.name === 'LocalPkg');
    expect(local).toBeDefined();
    expect(local!.isLocal).toBe(true);
    expect(local!.localPath).toBe('../LocalPkg');
  });

  it('should handle complex source definitions', () => {
    const result = parseXcodeGenProject(`
name: MyApp
targets:
  MyApp:
    type: application
    sources:
      - path: Sources/App
        excludes:
          - "**/*.generated.swift"
`);

    const appModule = result.layers.flatMap((l) => l.modules).find((m) => m.name === 'MyApp');
    expect(appModule?.localPath).toBe('Sources/App');
  });
});

describe('YamlConfigParser — parseXcodeGenTarget', () => {
  const yamlContent = `
name: MyApp
targets:
  MyApp:
    type: application
    sources:
      - Sources/MyApp
    dependencies:
      - target: CoreModule
      - package: Alamofire
  CoreModule:
    type: framework
    sources:
      - Sources/Core
`;

  it('should parse specific target dependencies', () => {
    const spec = parseXcodeGenTarget('MyApp', yamlContent);
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('MyApp');
    expect(spec!.dependencies).toEqual(['CoreModule', 'Alamofire']);
    expect(spec!.sources).toBe('Sources/MyApp');
  });

  it('should return null for unknown target', () => {
    const spec = parseXcodeGenTarget('NonExistent', yamlContent);
    expect(spec).toBeNull();
  });

  it('should return null for empty content', () => {
    const spec = parseXcodeGenTarget('MyApp', '');
    expect(spec).toBeNull();
  });
});

describe('YamlConfigParser — extractXcodeGenDependencyEdges', () => {
  it('should extract edges from target dependencies', () => {
    const edges = extractXcodeGenDependencyEdges(`
name: MyApp
targets:
  MyApp:
    type: application
    dependencies:
      - target: CoreModule
      - target: UIKit
      - package: Alamofire
  CoreModule:
    type: framework
    dependencies:
      - target: Foundation
`);

    expect(edges).toHaveLength(4);
    expect(edges).toContainEqual(['MyApp', 'CoreModule']);
    expect(edges).toContainEqual(['MyApp', 'UIKit']);
    expect(edges).toContainEqual(['MyApp', 'Alamofire']);
    expect(edges).toContainEqual(['CoreModule', 'Foundation']);
  });

  it('should return empty for no targets', () => {
    const edges = extractXcodeGenDependencyEdges('name: MyApp');
    expect(edges).toEqual([]);
  });

  it('should handle targets with no dependencies', () => {
    const edges = extractXcodeGenDependencyEdges(`
targets:
  MyApp:
    type: application
    sources:
      - Sources
`);
    expect(edges).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 3.6: User Custom Config (boxspec.json extension)
// ═══════════════════════════════════════════════════════════

describe('CustomConfigDiscoverer — User Custom Systems', () => {
  let testDir: string;
  let kbDir: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `autosnippet-customsys-test-${Date.now()}`);
    kbDir = join(testDir, 'AutoSnippet');
    mkdirSync(kbDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect built-in systems without boxspec', async () => {
    // Create a Boxfile marker
    writeFileSync(join(testDir, 'Boxfile'), 'host_app "Test"');

    const discoverer = new CustomConfigDiscoverer();
    const result = await discoverer.detect(testDir);
    expect(result.match).toBe(true);
    expect(result.confidence).toBe(0.8);
    expect(result.reason).toContain('EasyBox');
  });

  it('should detect user-defined custom system from boxspec.json', async () => {
    // Create a custom marker file
    writeFileSync(join(testDir, 'MyBuildfile'), 'custom config content');

    // Write boxspec.json with customDiscoverer
    writeFileSync(
      join(kbDir, 'AutoSnippet.boxspec.json'),
      JSON.stringify({
        name: 'TestProject',
        schemaVersion: 2,
        customDiscoverer: {
          id: 'mybuild',
          displayName: 'MyBuildTool',
          markers: ['MyBuildfile'],
          moduleSpecPattern: '*.mybuildspec',
          language: ['swift'],
          confidence: 0.9,
          parser: 'ruby-dsl',
        },
      })
    );

    const discoverer = new CustomConfigDiscoverer();
    const result = await discoverer.detect(testDir);
    expect(result.match).toBe(true);
    // User custom system (confidence 0.9) should win — or Boxfile (0.8).
    // Since user systems are checked first, MyBuildfile matches first
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toContain('MyBuildTool');
  });

  it('should handle invalid customDiscoverer gracefully', async () => {
    writeFileSync(
      join(kbDir, 'AutoSnippet.boxspec.json'),
      JSON.stringify({
        name: 'TestProject',
        schemaVersion: 2,
        customDiscoverer: { invalid: true }, // missing required fields
      })
    );

    const discoverer = new CustomConfigDiscoverer();
    // Should still work, falling back to built-in systems
    const result = await discoverer.detect(testDir);
    expect(result.match).toBe(true); // Boxfile still exists
  });

  it('should handle array of custom discoverers', async () => {
    writeFileSync(
      join(kbDir, 'AutoSnippet.boxspec.json'),
      JSON.stringify({
        name: 'TestProject',
        schemaVersion: 2,
        customDiscoverer: [
          {
            id: 'tool-a',
            displayName: 'ToolA',
            markers: ['ToolAFile'],
            language: ['swift'],
            confidence: 0.85,
            parser: 'yaml',
          },
          {
            id: 'tool-b',
            displayName: 'ToolB',
            markers: ['ToolBFile'],
            language: ['objectivec'],
            confidence: 0.7,
            parser: 'ruby-dsl',
          },
        ],
      })
    );

    // Neither marker exists
    rmSync(join(testDir, 'MyBuildfile'), { force: true });
    rmSync(join(testDir, 'ToolAFile'), { force: true });
    rmSync(join(testDir, 'ToolBFile'), { force: true });

    // Create ToolBFile
    writeFileSync(join(testDir, 'ToolBFile'), 'content');

    const discoverer = new CustomConfigDiscoverer();
    const result = await discoverer.detect(testDir);
    // Should match ToolB (0.7) or Boxfile (0.8)
    // Boxfile still exists from earlier test, but user systems checked first:
    // tool-a markers=['ToolAFile'] → not found, tool-b markers=['ToolBFile'] → found
    expect(result.match).toBe(true);
  });
});
