/**
 * ModuleDiscoverer 单元测试 — Host 模块分解
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleDiscoverer } from '../../lib/service/panorama/ModuleDiscoverer.js';
import { createMockRepos, type MockEdge, type MockEntity } from '../helpers/panorama-mocks.js';

/* Helper */

function makeDiscoverer(
  projectRoot: string,
  opts: {
    localModules?: Array<{ id: string; name: string; layer?: string }>;
    hostModules?: Array<{ id: string; name: string; fullPath?: string; layer?: string }>;
    edges?: Array<{ from_id: string; to_id: string }>;
    configLayers?: Array<{ name: string; order: number; accessibleLayers: string[] }>;
  } = {}
) {
  const { localModules = [], hostModules = [], edges = [], configLayers } = opts;

  const entities: MockEntity[] = [];

  for (const m of localModules) {
    entities.push({
      entity_id: m.id,
      entity_type: 'module',
      name: m.name,
      file_path: null,
      metadata_json: m.layer ? JSON.stringify({ layer: m.layer }) : undefined,
    });
  }

  for (const m of hostModules) {
    entities.push({
      entity_id: m.id,
      entity_type: 'module',
      name: m.name,
      file_path: null,
      metadata_json: JSON.stringify({
        nodeType: 'host',
        fullPath: m.fullPath,
        layer: m.layer,
      }),
    });
  }

  if (configLayers) {
    entities.push({
      entity_id: '__config_layers__',
      entity_type: 'module',
      name: '__config_layers__',
      metadata_json: JSON.stringify({ layers: configLayers }),
    });
  }

  const mockEdges: MockEdge[] = edges.map((e) => ({
    from_id: e.from_id,
    to_id: e.to_id,
    relation: 'is_part_of',
  }));

  const repos = createMockRepos({ entities, edges: mockEdges });

  const origFindById = repos.entityRepo.findByEntityIdOnly.bind(repos.entityRepo);
  repos.entityRepo.findByEntityIdOnly = (entityId: string, pr: string) => {
    const found = origFindById(entityId, pr);
    if (found) {
      return found;
    }
    if (entityId !== '__config_layers__') {
      return {
        id: 0,
        entityId,
        entityType: 'class',
        projectRoot: pr,
        name: entityId,
        filePath: `/test/${entityId}.swift`,
        lineNumber: null,
        superclass: null,
        protocols: [],
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      } as never;
    }
    return null;
  };

  return new ModuleDiscoverer(repos.entityRepo, repos.edgeRepo, projectRoot);
}

/* ═══ Temp Directory Helpers ══════════════════════════════ */

let tmpDir: string;

function createDirStructure(base: string, tree: Record<string, string[]>): void {
  for (const [dir, files] of Object.entries(tree)) {
    const dirPath = path.join(base, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(path.join(dirPath, file), '// stub');
    }
  }
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('ModuleDiscoverer', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moddisc-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('discover() — regular modules', () => {
    it('returns empty when no modules and no host', async () => {
      const discoverer = makeDiscoverer(tmpDir, { localModules: [], hostModules: [] });
      const result = await discoverer.discover();
      expect(result).toEqual([]);
    });

    it('returns local modules with is_part_of edges', async () => {
      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [
          { id: 'CoreKit', name: 'CoreKit', layer: 'Foundation' },
          { id: 'UIModule', name: 'UIModule', layer: 'Feature' },
        ],
        edges: [
          { from_id: 'CoreKit_File1', to_id: 'CoreKit' },
          { from_id: 'UIModule_File1', to_id: 'UIModule' },
        ],
      });

      const result = await discoverer.discover();
      expect(result.length).toBe(2);

      const coreKit = result.find((m) => m.name === 'CoreKit');
      expect(coreKit).toBeDefined();
      expect(coreKit!.files).toEqual(['/test/CoreKit_File1.swift']);
      expect(coreKit!.configLayer).toBe('Foundation');
    });
  });

  describe('#decomposeHostModules', () => {
    it('decomposes host module into sub-modules by directory', async () => {
      const hostDir = path.join(tmpDir, 'MinVideo');
      createDirStructure(tmpDir, {
        'MinVideo/Player': [
          'PlayerViewController.swift',
          'PlayerService.swift',
          'PlayerModel.swift',
        ],
        'MinVideo/Search': ['SearchViewController.swift', 'SearchService.swift'],
        'MinVideo/Common': ['Extensions.swift', 'Constants.swift'],
      });
      fs.mkdirSync(path.join(hostDir, 'Assets.xcassets'), { recursive: true });
      fs.writeFileSync(path.join(hostDir, 'AppDelegate.swift'), '// stub');
      fs.writeFileSync(path.join(hostDir, 'SceneDelegate.swift'), '// stub');

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [{ id: 'BDMVBanner', name: 'BDMVBanner', layer: 'Components' }],
        hostModules: [{ id: 'MinVideo', name: 'MinVideo', fullPath: hostDir }],
        edges: [{ from_id: 'BDMVBanner_File1', to_id: 'BDMVBanner' }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name).sort();
      expect(names).toContain('BDMVBanner');
      expect(names).toContain('Player');
      expect(names).toContain('Search');
      expect(names).toContain('Common');
      expect(names).toContain('MinVideo');

      const player = result.find((m) => m.name === 'Player');
      expect(player).toBeDefined();
      expect(player!.files.length).toBe(3);

      const common = result.find((m) => m.name === 'Common');
      expect(common).toBeDefined();
      expect(common!.inferredRole).toBe('core');

      const minVideo = result.find((m) => m.name === 'MinVideo');
      expect(minVideo).toBeDefined();
      expect(minVideo!.inferredRole).toBe('app');
      expect(minVideo!.files.length).toBe(2);

      expect(names).not.toContain('Assets.xcassets');
    });

    it('skips host sub-dirs with fewer than 2 source files', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Tiny': ['OnlyOneFile.swift'],
        'MyApp/Normal': ['File1.swift', 'File2.swift'],
      });

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name);
      expect(names).toContain('Normal');
      expect(names).not.toContain('Tiny');
    });

    it('prefixes sub-module name on collision with existing module', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Common': ['AppCommon1.swift', 'AppCommon2.swift'],
        'MyApp/Feature': ['Feature1.swift', 'Feature2.swift'],
      });

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [{ id: 'Common', name: 'Common' }],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
        edges: [{ from_id: 'Common_File1', to_id: 'Common' }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name);
      expect(names).toContain('MyApp/Common');
      expect(names).toContain('Feature');
      expect(names).toContain('Common');
    });

    it('only returns host sub-modules when no local modules exist', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Player': ['Player1.swift', 'Player2.swift'],
      });
      fs.writeFileSync(path.join(hostDir, 'MainEntry.swift'), '// stub');

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      expect(result.length).toBe(2);
      expect(result.find((m) => m.name === 'Player')).toBeDefined();
      expect(result.find((m) => m.name === 'MyApp')).toBeDefined();
    });

    it('skips hidden dirs and build artifact dirs', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/.hidden': ['Hidden1.swift', 'Hidden2.swift'],
        'MyApp/build': ['Build1.swift', 'Build2.swift'],
        'MyApp/Pods': ['Pod1.swift', 'Pod2.swift'],
        'MyApp/Valid': ['Valid1.swift', 'Valid2.swift'],
      });

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name);
      expect(names).toContain('Valid');
      expect(names).not.toContain('.hidden');
      expect(names).not.toContain('build');
      expect(names).not.toContain('Pods');
    });

    it('skips iOS resource directories by suffix', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Valid': ['V1.swift', 'V2.swift'],
      });
      for (const suffix of ['.xcassets', '.bundle', '.lproj', '.framework', '.storyboard']) {
        const dir = path.join(hostDir, `Resource${suffix}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Stub1.swift'), '// stub');
        fs.writeFileSync(path.join(dir, 'Stub2.swift'), '// stub');
      }

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name);
      expect(names).toContain('Valid');
      for (const suffix of ['.xcassets', '.bundle', '.lproj', '.framework', '.storyboard']) {
        expect(names).not.toContain(`Resource${suffix}`);
      }
    });

    it('skips vendor/3rd-party directories', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/3rd': ['Vendor1.swift', 'Vendor2.swift', 'Vendor3.swift'],
        'MyApp/vendor': ['V1.swift', 'V2.swift'],
        'MyApp/third_party': ['T1.swift', 'T2.swift'],
        'MyApp/Feature': ['F1.swift', 'F2.swift'],
      });

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      const names = result.map((m) => m.name);
      expect(names).toContain('Feature');
      expect(names).not.toContain('3rd');
      expect(names).not.toContain('vendor');
      expect(names).not.toContain('third_party');
    });

    it('assigns configLayer=Application when configLayers exist', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Player': ['P1.swift', 'P2.swift'],
        'MyApp/Search': ['S1.swift', 'S2.swift'],
      });
      fs.writeFileSync(path.join(hostDir, 'AppDelegate.swift'), '// stub');
      fs.writeFileSync(path.join(hostDir, 'SceneDelegate.swift'), '// stub');

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [{ id: 'CoreKit', name: 'CoreKit', layer: 'Foundation' }],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
        edges: [{ from_id: 'CoreKit_File1', to_id: 'CoreKit' }],
        configLayers: [
          { name: 'Components', order: 0, accessibleLayers: ['Foundation'] },
          { name: 'Foundation', order: 1, accessibleLayers: [] },
        ],
      });

      const result = await discoverer.discover();

      const player = result.find((m) => m.name === 'Player');
      expect(player).toBeDefined();
      expect(player!.configLayer).toBe('Application');

      const search = result.find((m) => m.name === 'Search');
      expect(search!.configLayer).toBe('Application');

      const myApp = result.find((m) => m.name === 'MyApp');
      expect(myApp!.configLayer).toBe('Application');
    });

    it('does not assign configLayer when no configLayers exist', async () => {
      const hostDir = path.join(tmpDir, 'MyApp');
      createDirStructure(tmpDir, {
        'MyApp/Player': ['P1.swift', 'P2.swift'],
      });

      const discoverer = makeDiscoverer(tmpDir, {
        localModules: [],
        hostModules: [{ id: 'MyApp', name: 'MyApp', fullPath: hostDir }],
      });

      const result = await discoverer.discover();

      const player = result.find((m) => m.name === 'Player');
      expect(player).toBeDefined();
      expect(player!.configLayer).toBeUndefined();
    });
  });

  describe('readConfigLayers', () => {
    it('returns config layers from DB', async () => {
      const discoverer = makeDiscoverer(tmpDir, {
        configLayers: [
          { name: 'Application', order: 0, accessibleLayers: ['Service'] },
          { name: 'Service', order: 1, accessibleLayers: ['Foundation'] },
          { name: 'Foundation', order: 2, accessibleLayers: [] },
        ],
      });

      const layers = await discoverer.readConfigLayers();

      expect(layers).not.toBeNull();
      expect(layers!.length).toBe(3);
      expect(layers![0].name).toBe('Application');
    });

    it('returns null when no config layers', async () => {
      const discoverer = makeDiscoverer(tmpDir);
      const layers = await discoverer.readConfigLayers();
      expect(layers).toBeNull();
    });

    it('injects Application layer when host modules exist and no app layer in config', async () => {
      const discoverer = makeDiscoverer(tmpDir, {
        hostModules: [{ id: 'MyApp', name: 'MyApp' }],
        configLayers: [
          { name: 'Components', order: 0, accessibleLayers: ['Foundation'] },
          { name: 'Foundation', order: 1, accessibleLayers: [] },
        ],
      });

      const layers = await discoverer.readConfigLayers();

      expect(layers).not.toBeNull();
      expect(layers!.length).toBe(3);
      const appLayer = layers!.find((l) => l.name === 'Application');
      expect(appLayer).toBeDefined();
      expect(appLayer!.order).toBe(-1);
      expect(appLayer!.accessibleLayers).toContain('Components');
      expect(appLayer!.accessibleLayers).toContain('Foundation');
    });

    it('does not inject Application layer when config already has one', async () => {
      const discoverer = makeDiscoverer(tmpDir, {
        hostModules: [{ id: 'MyApp', name: 'MyApp' }],
        configLayers: [
          { name: 'Application', order: 0, accessibleLayers: ['Service'] },
          { name: 'Service', order: 1, accessibleLayers: [] },
        ],
      });

      const layers = await discoverer.readConfigLayers();
      expect(layers!.length).toBe(2);
    });

    it('does not inject Application layer when no host modules', async () => {
      const discoverer = makeDiscoverer(tmpDir, {
        configLayers: [
          { name: 'Components', order: 0, accessibleLayers: ['Foundation'] },
          { name: 'Foundation', order: 1, accessibleLayers: [] },
        ],
      });

      const layers = await discoverer.readConfigLayers();
      expect(layers!.length).toBe(2);
    });
  });
});
