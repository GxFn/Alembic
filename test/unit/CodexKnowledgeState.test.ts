import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { inspectCodexKnowledge } from '../../lib/codex/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex knowledge state', () => {
  test('reports a running bootstrap job before usable knowledge exists', () => {
    const root = createProject();
    initializeWorkspace(root);
    writeJob(root, {
      id: 'bootstrap_active',
      kind: 'bootstrap',
      request: {
        contentMaxLines: 120,
        maxFiles: 500,
        skipGuard: false,
      },
      status: 'running',
      source: 'codex',
      channelId: 'codex',
      createdByTool: 'alembic_codex_bootstrap',
      createdAt: '2026-05-12T00:00:00Z',
      updatedAt: '2026-05-12T00:01:00Z',
    });

    const state = inspectCodexKnowledge(root);

    expect(state.status).toBe('bootstrap_running');
    expect(state.jobs?.bootstrapRunning).toBe(true);
    expect(state.jobs?.active.map((job) => job.id)).toEqual(['bootstrap_active']);
    expect(state.jobs?.active[0]?.request).toEqual({
      contentMaxLines: 120,
      maxFiles: 500,
      skipGuard: false,
    });
    expect(state.usable).toBe(false);
  });

  test('keeps missing vector index as a non-blocking signal when knowledge is usable', () => {
    const root = createProject();
    initializeWorkspace(root);
    writeRecipe(root, 'core.md', '# Core recipe\n');

    const state = inspectCodexKnowledge(root);

    expect(state.status).toBe('knowledge_ready');
    expect(state.usable).toBe(true);
    expect(state.vector?.status).toBe('missing');
    expect(state.vector?.skipped).toBe(true);
    expect(state.vector?.nonBlocking).toBe(true);
  });

  test('marks knowledge stale when the latest refresh job failed after current knowledge', () => {
    const root = createProject();
    initializeWorkspace(root);
    const recipePath = writeRecipe(root, 'core.md', '# Core recipe\n');
    const oldDate = new Date('2026-05-10T00:00:00Z');
    utimesSync(recipePath, oldDate, oldDate);
    writeJob(root, {
      id: 'rescan_failed',
      kind: 'rescan',
      status: 'failed',
      source: 'codex',
      channelId: 'codex',
      createdByTool: 'alembic_codex_rescan',
      createdAt: '2026-05-12T00:00:00Z',
      updatedAt: '2026-05-12T00:01:00Z',
      completedAt: '2026-05-12T00:01:00Z',
    });

    const state = inspectCodexKnowledge(root);

    expect(state.status).toBe('knowledge_stale');
    expect(state.freshness?.status).toBe('refresh_failed');
    expect(state.freshness?.stale).toBe(true);
    expect(state.jobs?.latestTerminal?.id).toBe('rescan_failed');
    expect(state.usable).toBe(true);
  });

  test('keeps active rescan request details in the job summary', () => {
    const root = createProject();
    initializeWorkspace(root);
    writeRecipe(root, 'core.md', '# Core recipe\n');
    writeJob(root, {
      id: 'rescan_active',
      kind: 'rescan',
      request: {
        dimensions: ['architecture', 'testing'],
        reason: 'codex follow-up',
      },
      status: 'queued',
      source: 'codex',
      channelId: 'codex',
      createdByTool: 'alembic_codex_rescan',
      createdAt: '2026-05-12T00:00:00Z',
      updatedAt: '2026-05-12T00:01:00Z',
    });

    const state = inspectCodexKnowledge(root);

    expect(state.status).toBe('knowledge_ready');
    expect(state.jobs?.rescanRunning).toBe(true);
    expect(state.jobs?.active[0]?.request).toEqual({
      dimensions: ['architecture', 'testing'],
      reason: 'codex follow-up',
    });
  });

  test('reads SourceRef stale counts and latest bootstrap snapshot from SQLite without services', () => {
    const root = createProject();
    initializeWorkspace(root);
    writeRecipe(root, 'core.md', '# Core recipe\n');
    seedCodexDatabase(root);

    const state = inspectCodexKnowledge(root);

    expect(state.status).toBe('knowledge_stale');
    expect(state.freshness?.status).toBe('source_refs_stale');
    expect(state.sourceRefs).toMatchObject({
      activeCount: 1,
      staleCount: 1,
      staleRecipeCount: 1,
      status: 'stale',
      tableExists: true,
      totalCount: 2,
    });
    expect(state.snapshots).toMatchObject({
      status: 'ready',
      tableExists: true,
      totalCount: 1,
      latest: {
        affectedDimsCount: 1,
        candidateCount: 3,
        changedFilesCount: 2,
        dimensionCount: 2,
        fileCount: 10,
        id: 'snap_1',
        isIncremental: true,
        primaryLang: 'typescript',
        sessionId: 'session_1',
      },
    });
  });
});

function createProject() {
  const root = mkdtempSync(join(tmpdir(), 'alembic-codex-knowledge-'));
  roots.push(root);
  return root;
}

function initializeWorkspace(root: string) {
  mkdirSync(join(root, '.asd', 'jobs'), { recursive: true });
  mkdirSync(join(root, 'Alembic', 'recipes'), { recursive: true });
  writeFileSync(join(root, '.asd', 'config.json'), '{}\n');
  writeFileSync(join(root, '.asd', 'alembic.db'), '');
}

function writeRecipe(root: string, name: string, content: string) {
  const filePath = join(root, 'Alembic', 'recipes', name);
  writeFileSync(filePath, content);
  return filePath;
}

function writeJob(root: string, job: Record<string, unknown>) {
  writeFileSync(join(root, '.asd', 'jobs', `${String(job.id)}.json`), JSON.stringify(job, null, 2));
}

function seedCodexDatabase(root: string) {
  const db = new Database(join(root, '.asd', 'alembic.db'));
  try {
    db.exec(`
      CREATE TABLE recipe_source_refs (
        recipe_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        new_path TEXT,
        verified_at INTEGER NOT NULL
      );
      CREATE TABLE bootstrap_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        duration_ms INTEGER DEFAULT 0,
        file_count INTEGER DEFAULT 0,
        dimension_count INTEGER DEFAULT 0,
        candidate_count INTEGER DEFAULT 0,
        primary_lang TEXT,
        file_hashes TEXT NOT NULL DEFAULT '{}',
        dimension_meta TEXT NOT NULL DEFAULT '{}',
        episodic_data TEXT,
        is_incremental INTEGER DEFAULT 0,
        parent_id TEXT,
        changed_files TEXT DEFAULT '[]',
        affected_dims TEXT DEFAULT '[]',
        status TEXT DEFAULT 'complete'
      );
    `);
    db.prepare(
      `INSERT INTO recipe_source_refs
        (recipe_id, source_path, status, verified_at)
       VALUES
        ('recipe_1', 'src/a.ts', 'active', 1),
        ('recipe_1', 'src/missing.ts', 'stale', 1)`
    ).run();
    db.prepare(
      `INSERT INTO bootstrap_snapshots
        (id, session_id, project_root, created_at, file_count, dimension_count, candidate_count,
         primary_lang, is_incremental, changed_files, affected_dims, status)
       VALUES
        ('snap_1', 'session_1', ?, '2026-05-12T00:00:00Z', 10, 2, 3,
         'typescript', 1, '["src/a.ts","src/b.ts"]', '["architecture"]', 'complete')`
    ).run(root);
  } finally {
    db.close();
  }
}
