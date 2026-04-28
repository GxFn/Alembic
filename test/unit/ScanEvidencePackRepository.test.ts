import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getDrizzle,
  initDrizzle,
  resetDrizzle,
} from '../../lib/infrastructure/database/drizzle/index.js';
import migrate009 from '../../lib/infrastructure/database/migrations/009_scan_runs.js';
import migrate010 from '../../lib/infrastructure/database/migrations/010_scan_evidence_packs.js';
import { ScanEvidencePackRepository } from '../../lib/repository/scan/ScanEvidencePackRepository.js';
import { ScanRunRepository } from '../../lib/repository/scan/ScanRunRepository.js';
import type { KnowledgeEvidencePack } from '../../lib/workflows/scan/ScanTypes.js';

function makePack(overrides: Partial<KnowledgeEvidencePack> = {}): KnowledgeEvidencePack {
  return {
    project: { root: '/repo', primaryLang: 'typescript', fileCount: 1, modules: ['api'] },
    changes: {
      files: ['src/api.ts'],
      impactedDimensions: ['networking'],
      impactedRecipeIds: ['recipe-1'],
      impactDetails: [],
    },
    files: [{ relativePath: 'src/api.ts', language: 'typescript', role: 'changed' }],
    knowledge: [{ id: 'recipe-1', title: 'Recipe 1', lifecycle: 'active' }],
    graph: { entities: [], edges: [] },
    gaps: [],
    diagnostics: { truncated: false, warnings: [], retrievalMs: 3 },
    ...overrides,
  };
}

describe('ScanEvidencePackRepository', () => {
  let sqlite: InstanceType<typeof Database>;
  let now: number;
  let runRepository: ScanRunRepository;
  let evidenceRepository: ScanEvidencePackRepository;

  beforeEach(() => {
    resetDrizzle();
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate009(sqlite);
    migrate010(sqlite);
    initDrizzle(sqlite);
    now = 1_000;
    const drizzle = getDrizzle();
    runRepository = new ScanRunRepository(drizzle, () => now);
    evidenceRepository = new ScanEvidencePackRepository(drizzle, () => now);
  });

  afterEach(() => {
    resetDrizzle();
    sqlite.close();
  });

  test('stores and reads an evidence pack by run id', () => {
    const run = runRepository.create({ projectRoot: '/repo', mode: 'deep-mining', depth: 'deep' });
    const created = evidenceRepository.create({
      runId: run.id,
      packKind: 'deep-mining',
      pack: makePack(),
      summary: { knowledgeCount: 1 },
    });

    expect(created.id).toMatch(/^pack-1000-[0-9a-f]+$/);
    expect(created.runId).toBe(run.id);
    expect(created.charCount).toBeGreaterThan(0);

    const packs = evidenceRepository.findByRunId(run.id);
    expect(packs).toHaveLength(1);
    expect(packs[0].packKind).toBe('deep-mining');
    expect(packs[0].pack.project.root).toBe('/repo');
    expect(packs[0].summary).toEqual({ knowledgeCount: 1 });
  });

  test('records truncated diagnostics', () => {
    const run = runRepository.create({
      projectRoot: '/repo',
      mode: 'incremental-correction',
      depth: 'standard',
    });
    const pack = makePack({
      diagnostics: { truncated: true, warnings: ['large'], retrievalMs: 5 },
    });

    const created = evidenceRepository.create({
      runId: run.id,
      pack,
      packKind: 'incremental-correction',
    });
    const found = evidenceRepository.findById(created.id);

    expect(found?.truncated).toBe(true);
    expect(found?.pack.diagnostics.warnings).toEqual(['large']);
  });

  test('preserves cold-start evidence pack kind', () => {
    const run = runRepository.create({
      projectRoot: '/repo',
      mode: 'cold-start',
      depth: 'standard',
    });
    const created = evidenceRepository.create({
      runId: run.id,
      packKind: 'cold-start',
      pack: makePack(),
    });

    expect(evidenceRepository.findById(created.id)?.packKind).toBe('cold-start');
  });
});
