import { ConfigLoader } from '@alembic/core/config';
import { JobStore } from '@alembic/core/daemon';
import { ALL_DIMENSION_IDS, isKnownDimensionId } from '@alembic/core/dimensions';
import { SignalBus } from '@alembic/core/events';
import { createGuardCheckEngine, detectLanguage } from '@alembic/core/guard';
import { KnowledgeEntry, KnowledgeService, Lifecycle } from '@alembic/core/knowledge';
import { SearchEngine, tokenize } from '@alembic/core/search';
import { chunk, HnswIndex } from '@alembic/core/vector';
import { resolveKnowledgeScanDirs, WorkspaceResolver } from '@alembic/core/workspace';
import { describe, expect, it } from 'vitest';

// RIC-4c: the discovery/AST/parser facade smoke cases were removed with the
// ProjectIntelligenceCompatibility shim — their coverage now lives in Core
// (MultiFileAstAndDiscovery / MultiLanguageParsers / AstGrammar). The vector /
// search / knowledge / foundation facade smokes below stay (allowlisted Core).
describe('Core public surface smoke', () => {
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
