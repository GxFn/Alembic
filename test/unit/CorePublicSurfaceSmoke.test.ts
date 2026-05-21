import { KnowledgeEntry, KnowledgeService, Lifecycle } from '@alembic/core/knowledge';
import {
  analyzeSourceFile,
  CallGraphAnalyzer,
  detectConflict,
  extractXcodeGenDependencyEdges,
  parseGradleProject,
  parseStarlarkBuildFile,
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

  it('keeps AST, call graph, and parser facades consumable from Alembic', () => {
    const summary = analyzeSourceFile(
      'export class UserService { findUser(id: string) { return id; } }',
      'typescript'
    );
    const gradle = parseGradleProject('rootProject.name = "demo"\ninclude(":app", ":core")');
    const starlark = parseStarlarkBuildFile('swift_library(name = "Core", deps = [":Utils"])');

    expect(summary?.classes.some((item) => item.name === 'UserService')).toBe(true);
    expect(new CallGraphAnalyzer('/project')).toBeDefined();
    expect(gradle.includedModules.map((module) => module.path)).toEqual([':app', ':core']);
    expect(starlark.targets[0]?.name).toBe('Core');
  });

  it('keeps knowledge facade contracts consumable from Alembic', () => {
    const entry = new KnowledgeEntry({
      id: 'smoke-entry',
      title: 'Smoke Pattern',
      trigger: '@smoke',
      description: 'Thin Alembic consumer check',
      language: 'typescript',
      category: 'Boundary',
      kind: 'pattern',
      knowledgeType: 'code-pattern',
      content: { pattern: 'const value = true;' },
      reasoning: { whyStandard: 'public facade remains consumable', confidence: 0.8 },
      lifecycle: Lifecycle.ACTIVE,
    });

    expect(entry.title).toBe('Smoke Pattern');
    expect(Lifecycle.ACTIVE).toBe('active');
    expect(KnowledgeService).toBeDefined();
  });
});
