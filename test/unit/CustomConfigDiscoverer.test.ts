/**
 * RubyDslParser + CustomConfigDiscoverer 单元测试
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomConfigDiscoverer } from '../../lib/core/discovery/CustomConfigDiscoverer.js';
import { parseBoxfile, parseModuleSpec } from '../../lib/core/discovery/parsers/RubyDslParser.js';

// ═══ RubyDslParser: parseBoxfile ═══════════════════════════

describe('RubyDslParser — parseBoxfile', () => {
  it('should extract host_app name and version', () => {
    const config = parseBoxfile(`
      host_app 'MinVideo', '8.0.0'
    `);
    expect(config.hostApp).toEqual({ name: 'MinVideo', version: '8.0.0' });
  });

  it('should extract host_app without version', () => {
    const config = parseBoxfile(`
      host_app 'MyApp'
    `);
    expect(config.hostApp).toEqual({ name: 'MyApp', version: '0.0.0' });
  });

  it('should extract layer names in order', () => {
    const config = parseBoxfile(`
      layer 'Services' do
      end

      layer 'Basics' do
      end

      layer 'Vendors' do
      end
    `);
    expect(config.layers).toHaveLength(3);
    expect(config.layers[0].name).toBe('Services');
    expect(config.layers[0].order).toBe(0);
    expect(config.layers[1].name).toBe('Basics');
    expect(config.layers[1].order).toBe(1);
    expect(config.layers[2].name).toBe('Vendors');
    expect(config.layers[2].order).toBe(2);
  });

  it('should extract access declarations', () => {
    const config = parseBoxfile(`
      layer 'Components' do
        access 'Services', 'Basics', 'Vendors'
      end
    `);
    expect(config.layers[0].accessibleLayers).toEqual(['Services', 'Basics', 'Vendors']);
  });

  it('should extract local modules with :path', () => {
    const config = parseBoxfile(`
      layer 'Services' do
        box 'BDMVService', :path => 'LocalModule/BDMVService'
      end
    `);
    const mod = config.layers[0].modules[0];
    expect(mod.name).toBe('BDMVService');
    expect(mod.isLocal).toBe(true);
    expect(mod.localPath).toBe('LocalModule/BDMVService');
  });

  it('should extract remote modules with version', () => {
    const config = parseBoxfile(`
      layer 'Vendors' do
        box 'AFNetworking', '4.0.1.2'
      end
    `);
    const mod = config.layers[0].modules[0];
    expect(mod.name).toBe('AFNetworking');
    expect(mod.isLocal).toBe(false);
    expect(mod.version).toBe('4.0.1.2');
    expect(mod.localPath).toBeUndefined();
  });

  it('should track group context for modules', () => {
    const config = parseBoxfile(`
      layer 'Vendors' do
        group 'Networking' do
          box 'AFNetworking', '4.0.0'
          box 'Alamofire', '5.0.0'
        end
        box 'SDWebImage', '5.0.0'
      end
    `);
    const mods = config.layers[0].modules;
    expect(mods).toHaveLength(3);
    expect(mods[0].group).toBe('Networking');
    expect(mods[1].group).toBe('Networking');
    expect(mods[2].group).toBeUndefined();
  });

  it('should handle mixed local and remote modules', () => {
    const config = parseBoxfile(`
      layer 'Services' do
        access 'Basics'
        box 'BDMVService', :path => 'LocalModule/BDMVService'
        box 'BDMVNetwork', '1.2.3'
      end
    `);
    const mods = config.layers[0].modules;
    expect(mods).toHaveLength(2);
    expect(mods[0].isLocal).toBe(true);
    expect(mods[1].isLocal).toBe(false);
  });

  it('should extract global dependencies (outside layers)', () => {
    const config = parseBoxfile(`
      box 'GlobalLib', '1.0.0'

      layer 'Services' do
        box 'LocalService', :path => 'LocalModule/LocalService'
      end
    `);
    expect(config.globalDependencies).toHaveLength(1);
    expect(config.globalDependencies[0].name).toBe('GlobalLib');
    expect(config.layers[0].modules).toHaveLength(1);
  });

  it('should handle Ruby-style path syntax (path:)', () => {
    const config = parseBoxfile(`
      layer 'Services' do
        box 'MyModule', path: 'LocalModule/MyModule'
      end
    `);
    const mod = config.layers[0].modules[0];
    expect(mod.isLocal).toBe(true);
    expect(mod.localPath).toBe('LocalModule/MyModule');
  });

  it('should skip comment lines', () => {
    const config = parseBoxfile(`
      layer 'Services' do
        # This is a comment
        # box 'CommentedOut', '1.0'
        box 'RealModule', '2.0'
      end
    `);
    expect(config.layers[0].modules).toHaveLength(1);
    expect(config.layers[0].modules[0].name).toBe('RealModule');
  });

  it('should handle complex multi-layer Boxfile', () => {
    const config = parseBoxfile(`
      host_app 'MinVideo', '8.0.0'

      layer 'Accessories' do
        access 'Services', 'Basics', 'Vendors'
        box 'BDMVAccessory', :path => 'LocalModule/BDMVAccessory'
      end

      layer 'Components' do
        access 'Services', 'Basics', 'Vendors', 'Underlays'
        box 'BDMVCommonBusiness', :path => 'LocalModule/BDMVCommonBusiness'
        box 'BDMVPlayer', :path => 'LocalModule/BDMVPlayer'
      end

      layer 'Services' do
        access 'Basics', 'Vendors'
        box 'BDMVService', :path => 'LocalModule/BDMVService'
      end

      layer 'Basics' do
        access 'Vendors'
        box 'FMTFoundation', :path => 'LocalModule/FMTFoundation'
      end

      layer 'Vendors' do
        group 'Networking' do
          box 'AFNetworking', '4.0.1.2'
        end
        group 'Image' do
          box 'SDWebImage', '5.0.0'
        end
      end
    `);

    expect(config.hostApp?.name).toBe('MinVideo');
    expect(config.layers).toHaveLength(5);
    expect(config.layers[0].name).toBe('Accessories');
    expect(config.layers[4].name).toBe('Vendors');

    // Local modules
    const localMods = config.layers.flatMap((l) => l.modules).filter((m) => m.isLocal);
    expect(localMods.length).toBeGreaterThanOrEqual(4);

    // Remote modules
    const remoteMods = config.layers.flatMap((l) => l.modules).filter((m) => !m.isLocal);
    expect(remoteMods).toHaveLength(2);
    expect(remoteMods[0].name).toBe('AFNetworking');

    // Access rules
    expect(config.layers[2].accessibleLayers).toEqual(['Basics', 'Vendors']);
  });
});

// ═══ RubyDslParser: parseModuleSpec ═══════════════════════

describe('RubyDslParser — parseModuleSpec', () => {
  it('should extract name and version', () => {
    const spec = parseModuleSpec(`
      Pod::Spec.new do |s|
        s.name         = 'BDMVService'
        s.version      = '1.2.3'
      end
    `);
    expect(spec.name).toBe('BDMVService');
    expect(spec.version).toBe('1.2.3');
  });

  it('should extract dependencies', () => {
    const spec = parseModuleSpec(`
      Pod::Spec.new do |s|
        s.name         = 'BDMVService'
        s.version      = '1.0.0'
        s.dependency 'FMTFoundation'
        s.dependency 'AFNetworking', '~> 4.0'
        s.dependency 'BDMVCookie'
      end
    `);
    expect(spec.dependencies).toEqual(['FMTFoundation', 'AFNetworking', 'BDMVCookie']);
  });

  it('should extract source_files path', () => {
    const spec = parseModuleSpec(`
      s.name = 'MyModule'
      s.version = '1.0'
      s.source_files = 'Sources/**/*.{h,m,swift}'
    `);
    expect(spec.sources).toBe('Sources/**/*.{h,m,swift}');
  });

  it('should extract deployment target', () => {
    const spec = parseModuleSpec(`
      s.name = 'MyModule'
      s.version = '1.0'
      s.ios.deployment_target = '13.0'
    `);
    expect(spec.deploymentTarget).toBe('13.0');
  });

  it('should handle spec with variable prefix', () => {
    const spec = parseModuleSpec(`
      EasyBox::Spec.new do |spec|
        spec.name         = 'FMTFoundation'
        spec.version      = '2.0.0'
        spec.sources      = 'Classes'
        spec.dependency 'BDMVBase'
      end
    `);
    expect(spec.name).toBe('FMTFoundation');
    expect(spec.version).toBe('2.0.0');
    expect(spec.sources).toBe('Classes');
    expect(spec.dependencies).toEqual(['BDMVBase']);
  });

  it('should deduplicate dependencies', () => {
    const spec = parseModuleSpec(`
      s.name = 'Test'
      s.version = '1.0'
      s.dependency 'BaseLib'
      s.dependency 'BaseLib', '~> 2.0'
    `);
    expect(spec.dependencies).toEqual(['BaseLib']);
  });
});

// ═══ CustomConfigDiscoverer ═══════════════════════════════

describe('CustomConfigDiscoverer', () => {
  const testDir = join(tmpdir(), `autosnippet-test-custom-config-${Date.now()}`);
  const discoverer = new CustomConfigDiscoverer();

  beforeAll(() => {
    // 创建测试项目结构
    mkdirSync(testDir, { recursive: true });

    // Boxfile
    writeFileSync(
      join(testDir, 'Boxfile'),
      `
host_app 'TestApp', '1.0.0'

layer 'Services' do
  access 'Basics', 'Vendors'
  box 'ServiceA', :path => 'LocalModule/ServiceA'
  box 'ServiceB', :path => 'LocalModule/ServiceB'
end

layer 'Basics' do
  access 'Vendors'
  box 'Foundation', :path => 'LocalModule/Foundation'
end

layer 'Vendors' do
  box 'AFNetworking', '4.0.0'
  box 'SDWebImage', '5.0.0'
end
      `.trim()
    );

    // 宿主应用目录
    mkdirSync(join(testDir, 'TestApp'), { recursive: true });
    writeFileSync(
      join(testDir, 'TestApp', 'AppDelegate.m'),
      '#import "AppDelegate.h"\n@implementation AppDelegate\n@end'
    );

    // LocalModule/ServiceA
    mkdirSync(join(testDir, 'LocalModule', 'ServiceA', 'Sources'), { recursive: true });
    writeFileSync(
      join(testDir, 'LocalModule', 'ServiceA', 'ServiceA.boxspec'),
      `
EasyBox::Spec.new do |s|
  s.name         = 'ServiceA'
  s.version      = '1.0.0'
  s.sources      = 'Sources'
  s.dependency 'Foundation'
  s.dependency 'AFNetworking'
end
      `.trim()
    );
    writeFileSync(
      join(testDir, 'LocalModule', 'ServiceA', 'Sources', 'ServiceA.swift'),
      'class ServiceA {}'
    );

    // LocalModule/ServiceB
    mkdirSync(join(testDir, 'LocalModule', 'ServiceB', 'Sources'), { recursive: true });
    writeFileSync(
      join(testDir, 'LocalModule', 'ServiceB', 'ServiceB.boxspec'),
      `
EasyBox::Spec.new do |s|
  s.name         = 'ServiceB'
  s.version      = '2.0.0'
  s.sources      = 'Sources'
  s.dependency 'Foundation'
  s.dependency 'SDWebImage'
end
      `.trim()
    );
    writeFileSync(
      join(testDir, 'LocalModule', 'ServiceB', 'Sources', 'ServiceB.m'),
      '@implementation ServiceB @end'
    );

    // LocalModule/Foundation
    mkdirSync(join(testDir, 'LocalModule', 'Foundation', 'Classes'), { recursive: true });
    writeFileSync(
      join(testDir, 'LocalModule', 'Foundation', 'Foundation.boxspec'),
      `
EasyBox::Spec.new do |s|
  s.name         = 'Foundation'
  s.version      = '3.0.0'
  s.sources      = 'Classes'
end
      `.trim()
    );
    writeFileSync(
      join(testDir, 'LocalModule', 'Foundation', 'Classes', 'Base.h'),
      '#import <UIKit/UIKit.h>'
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── detect ──

  it('should detect EasyBox project with high confidence', async () => {
    const result = await discoverer.detect(testDir);
    expect(result.match).toBe(true);
    expect(result.confidence).toBe(0.8);
    expect(result.reason).toContain('EasyBox');
  });

  it('should not match a directory without markers', async () => {
    const emptyDir = join(tmpdir(), `autosnippet-test-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = await discoverer.detect(emptyDir);
      expect(result.match).toBe(false);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // ── load + listTargets ──

  it('should load project and list local targets', async () => {
    await discoverer.load(testDir);
    const targets = await discoverer.listTargets();

    // 宿主应用 + 3 个本地模块
    expect(targets.length).toBeGreaterThanOrEqual(4);

    const names = targets.map((t) => t.name);
    expect(names).toContain('TestApp');
    expect(names).toContain('ServiceA');
    expect(names).toContain('ServiceB');
    expect(names).toContain('Foundation');

    // 远程依赖不应出现在 targets 中
    expect(names).not.toContain('AFNetworking');
    expect(names).not.toContain('SDWebImage');
  });

  it('should set correct target types', async () => {
    const targets = await discoverer.listTargets();
    const hostTarget = targets.find((t) => t.name === 'TestApp');
    const libTarget = targets.find((t) => t.name === 'ServiceA');

    expect(hostTarget?.type).toBe('application');
    expect(libTarget?.type).toBe('library');
  });

  it('should include layer metadata in targets', async () => {
    const targets = await discoverer.listTargets();
    const serviceA = targets.find((t) => t.name === 'ServiceA');
    expect(serviceA?.metadata?.layer).toBe('Services');
  });

  // ── getTargetFiles ──

  it('should collect source files for a target', async () => {
    const targets = await discoverer.listTargets();
    const serviceA = targets.find((t) => t.name === 'ServiceA');
    expect(serviceA).toBeDefined();

    const files = await discoverer.getTargetFiles(serviceA!);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.name === 'ServiceA.swift')).toBe(true);
  });

  // ── getDependencyGraph ──

  it('should build complete dependency graph with external nodes', async () => {
    const graph = await discoverer.getDependencyGraph();

    // 节点应包含 local + external + host
    const nodeIds = graph.nodes.map((n) => (typeof n === 'string' ? n : n.id));
    expect(nodeIds).toContain('TestApp');
    expect(nodeIds).toContain('ServiceA');
    expect(nodeIds).toContain('ServiceB');
    expect(nodeIds).toContain('Foundation');
    expect(nodeIds).toContain('AFNetworking');
    expect(nodeIds).toContain('SDWebImage');
  });

  it('should classify nodes correctly (local vs external vs host)', async () => {
    const graph = await discoverer.getDependencyGraph();

    const getNode = (id: string) =>
      graph.nodes.find((n) => typeof n !== 'string' && n.id === id) as
        | { id: string; type?: string; [key: string]: unknown }
        | undefined;

    expect(getNode('TestApp')?.type).toBe('host');
    expect(getNode('ServiceA')?.type).toBe('local');
    expect(getNode('AFNetworking')?.type).toBe('external');
  });

  it('should include dependency edges from boxspec', async () => {
    const graph = await discoverer.getDependencyGraph();

    const hasEdge = (from: string, to: string) =>
      graph.edges.some((e) => e.from === from && e.to === to);

    // ServiceA → Foundation (local → local)
    expect(hasEdge('ServiceA', 'Foundation')).toBe(true);
    // ServiceA → AFNetworking (local → external)
    expect(hasEdge('ServiceA', 'AFNetworking')).toBe(true);
    // ServiceB → SDWebImage (local → external)
    expect(hasEdge('ServiceB', 'SDWebImage')).toBe(true);
  });

  it('should include layer metadata in dependency graph', async () => {
    const graph = await discoverer.getDependencyGraph();

    expect(graph.layers).toBeDefined();
    expect(graph.layers?.length).toBe(3);

    const servicesLayer = graph.layers?.find((l) => l.name === 'Services');
    expect(servicesLayer).toBeDefined();
    expect(servicesLayer?.accessibleLayers).toEqual(['Basics', 'Vendors']);
    expect(servicesLayer?.order).toBe(0);
  });

  it('should include version info for external nodes', async () => {
    const graph = await discoverer.getDependencyGraph();
    const afNode = graph.nodes.find((n) => typeof n !== 'string' && n.id === 'AFNetworking') as
      | { id: string; version?: string; [key: string]: unknown }
      | undefined;

    expect(afNode?.version).toBe('4.0.0');
  });

  // ── id & displayName ──

  it('should have correct id', () => {
    expect(discoverer.id).toBe('customConfig');
  });

  it('should include system name in displayName after load', async () => {
    await discoverer.load(testDir);
    expect(discoverer.displayName).toContain('EasyBox');
  });
});
