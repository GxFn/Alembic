import { ConfigLoader } from '@alembic/core/config';
import { JobStore } from '@alembic/core/daemon';
import { ALL_DIMENSION_IDS, isKnownDimensionId } from '@alembic/core/dimensions';
import { SignalBus } from '@alembic/core/events';
import { createGuardCheckEngine, detectLanguage } from '@alembic/core/guard';
import { KnowledgeEntry, KnowledgeService, Lifecycle } from '@alembic/core/knowledge';
import {
  analyzeSourceFile,
  detectConflict,
  ensureProjectGrammarResources,
  extractXcodeGenDependencyEdges,
  parseGradleProject,
  parseStarlarkBuildFile,
  parseXcodeGenProject,
  profileTechStack,
} from '@alembic/core/project-intelligence';
import { SearchEngine, tokenize } from '@alembic/core/search';
import { chunk, HnswIndex } from '@alembic/core/vector';
import { resolveKnowledgeScanDirs, WorkspaceResolver } from '@alembic/core/workspace';
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

  it('keeps search facade consumable without duplicating Core ranking tests', () => {
    const db = { prepare: () => ({ all: () => [] }) };
    const search = new SearchEngine(db);

    expect(tokenize('URLSessionRetry')).toEqual(expect.arrayContaining(['url', 'session']));
    expect(typeof search.search).toBe('function');
  });

  it('keeps AST and parser facades consumable from Alembic', async () => {
    await ensureProjectGrammarResources({ ts: 1 });
    const summary = analyzeSourceFile(
      'export class UserService { findUser(id: string) { return id; } }',
      'typescript'
    );
    const gradle = parseGradleProject('rootProject.name = "demo"\ninclude(":app", ":core")');
    const starlark = parseStarlarkBuildFile('swift_library(name = "Core", deps = [":Utils"])');

    expect(summary?.classes.some((item) => item.name === 'UserService')).toBe(true);
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

  it('keeps foundation facades consumable from Alembic host wiring', () => {
    const guard = createGuardCheckEngine(null);

    expect(new SignalBus()).toBeDefined();
    expect(JobStore).toBeDefined();
    expect(new WorkspaceResolver({ projectRoot: '/tmp/project' })).toBeDefined();
    expect(resolveKnowledgeScanDirs({ projectRoot: '/tmp/project' })).toEqual(
      expect.arrayContaining(['recipes', 'candidates'])
    );
    expect(detectLanguage('ViewController.swift')).toBe('swift');
    expect(guard.auditFile('ViewController.swift', 'try! risky()').summary.total).toBeGreaterThan(
      0
    );
    expect(ALL_DIMENSION_IDS.length).toBeGreaterThan(0);
    expect(isKnownDimensionId(ALL_DIMENSION_IDS[0])).toBe(true);
    expect(ConfigLoader).toBeDefined();
  });
});
