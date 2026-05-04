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
