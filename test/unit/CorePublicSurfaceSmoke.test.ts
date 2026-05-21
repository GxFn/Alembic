import {
  detectConflict,
  extractXcodeGenDependencyEdges,
  parseXcodeGenProject,
  profileTechStack,
} from '@alembic/core/project-intelligence';
import { chunk, HnswIndex } from '@alembic/core/vector';
import { describe, expect, it } from 'vitest';

describe('Core public surface smoke', () => {
  it('keeps project-intelligence config and panorama helpers consumable from Alembic', () => {
    const project = parseXcodeGenProject(`
      name: Demo
      targets:
        App:
          type: application
          dependencies:
            - target: Core
        Core:
          type: framework
    `);
    const edges = extractXcodeGenDependencyEdges(`
      targets:
        App:
          dependencies:
            - target: Core
    `);
    const conflict = detectConflict([
      { discovererId: 'spm', displayName: 'SPM', confidence: 0.9 },
      { discovererId: 'custom', displayName: 'Custom', confidence: 0.4 },
    ]);
    const techStack = profileTechStack([
      { name: 'Alamofire', fanIn: 3, dependedBy: ['App', 'Feature', 'Service'] },
    ]);

    expect(project.hostApp?.name).toBe('Demo');
    expect(project.layers.flatMap((layer) => layer.modules.map((module) => module.name))).toEqual([
      'App',
      'Core',
    ]);
    expect(edges).toEqual([['App', 'Core']]);
    expect(conflict.ambiguous).toBe(false);
    expect(techStack.categories[0]?.name).toBe('Networking');
  });

  it('keeps vector facade consumable without duplicating Core algorithm tests', () => {
    const index = new HnswIndex({ M: 4, efConstruct: 8, efSearch: 8 });
    index.addPoint('a', [1, 0, 0]);
    index.addPoint('b', [0, 1, 0]);

    const chunks = chunk('# Title\n\nA short note for vector indexing.', {
      language: 'markdown',
      sourcePath: 'docs/note.md',
    });

    expect(index.searchKnn([1, 0, 0], 1)[0]?.id).toBe('a');
    expect(chunks[0]?.metadata.sourcePath).toBe('docs/note.md');
  });
});
