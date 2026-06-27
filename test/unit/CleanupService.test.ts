import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CleanupService } from '../../lib/service/cleanup/CleanupService.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('CleanupService', () => {
  test('fullReset clears post-initial Core and Alembic data tables', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    const executedSql: string[] = [];
    const db = {
      exec(sql: string) {
        executedSql.push(sql);
      },
      prepare() {
        return {
          run() {},
          all() {
            return [];
          },
          get() {
            return undefined;
          },
        };
      },
      close() {},
    };

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir, db });
    const result = await service.fullReset();

    const expectedFullResetTables = [
      'coverage_ledger',
      'deep_mining_rounds',
      'recipe_warnings',
      'source_graph_generations',
      'source_graph_files',
      'source_graph_symbols',
      'source_graph_edges',
      'git_diff_checkpoints',
      'project_context_file_snapshots',
      'token_usage',
    ];

    for (const table of expectedFullResetTables) {
      expect(executedSql).toContain(`DELETE FROM ${table}`);
      expect(result.clearedTables).toContain(table);
    }
  });

  test('rescanClean preserves incremental evidence tables', async () => {
    const executedSql: string[] = [];
    const db = {
      exec(sql: string) {
        executedSql.push(sql);
      },
      prepare() {
        return {
          run() {},
          all() {
            return [];
          },
        };
      },
      close() {},
    };

    const service = new CleanupService({ projectRoot: '/project', db });
    await service.rescanClean();

    expect(executedSql).not.toContain('DELETE FROM bootstrap_snapshots');
    expect(executedSql).not.toContain('DELETE FROM bootstrap_dim_files');
    expect(executedSql).not.toContain('DELETE FROM recipe_source_refs');
    expect(executedSql).not.toContain('DELETE FROM coverage_ledger');
    expect(executedSql).not.toContain('DELETE FROM deep_mining_rounds');
  });

  test('rescanClean removes the runtime bootstrap report from dataRoot', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-cleanup-'));
    fs.mkdirSync(path.join(tmpDir, '.asd'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'Alembic', '.asd'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.asd', 'bootstrap-report.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'Alembic', '.asd', 'bootstrap-report.json'), '{}');

    const service = new CleanupService({ projectRoot: '/project', dataRoot: tmpDir });
    const result = await service.rescanClean();

    expect(result.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, '.asd', 'bootstrap-report.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'Alembic', '.asd', 'bootstrap-report.json'))).toBe(true);
  });
});
