/**
 * 集成测试：Drizzle ORM — 实例生命周期 + 真实 SQL 操作
 *
 * 覆盖范围:
 *   - initDrizzle / getDrizzle / resetDrizzle 生命周期
 *   - getDrizzle 未初始化时抛错
 *   - schema 表定义存在性
 *   - 通过 Drizzle 执行真实 SQL 读写
 */

import {
  getDrizzle,
  initDrizzle,
  resetDrizzle,
  schema,
} from '@alembic/core/infrastructure/database/drizzle';
import Database from 'better-sqlite3';

describe('Integration: Drizzle ORM', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    resetDrizzle();
    db = new Database(':memory:');
  });

  afterEach(() => {
    resetDrizzle();
    db.close();
  });

  describe('lifecycle', () => {
    test('getDrizzle should throw before initialization', () => {
      expect(() => getDrizzle()).toThrow('Drizzle not initialized');
    });

    test('initDrizzle should return DrizzleDB instance', () => {
      const drizzle = initDrizzle(db);
      expect(drizzle).toBeDefined();
      expect(typeof drizzle.select).toBe('function');
      expect(typeof drizzle.insert).toBe('function');
    });

    test('getDrizzle should return same instance after init', () => {
      const drizzle1 = initDrizzle(db);
      const drizzle2 = getDrizzle();
      expect(drizzle2).toBe(drizzle1);
    });

    test('resetDrizzle should clear instance', () => {
      initDrizzle(db);
      resetDrizzle();
      expect(() => getDrizzle()).toThrow('Drizzle not initialized');
    });

    test('re-init should replace existing instance', () => {
      const drizzle1 = initDrizzle(db);
      const db2 = new Database(':memory:');
      const drizzle2 = initDrizzle(db2);
      expect(getDrizzle()).toBe(drizzle2);
      expect(getDrizzle()).not.toBe(drizzle1);
      db2.close();
    });
  });

  describe('schema exports', () => {
    test('should export knowledge and other core tables', () => {
      // these are defined in the Drizzle schema
      expect(schema.knowledgeEntries).toBeDefined();
      expect(schema.guardViolations).toBeDefined();
    });
  });

  describe('real SQL operations via Drizzle', () => {
    test('should insert and select from guard_violations', () => {
      // Mirrors migrations 001+011: the nullable tool/surface attribution
      // columns exist in the current Core drizzle schema and are harmless
      // extra columns under the pre-011 schema, so this DDL is valid against
      // both Core baselines.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guard_violations (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          violations_json TEXT NOT NULL,
          violation_count INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          triggered_at TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          tool TEXT,
          surface TEXT
        )
      `);
      const drizzle = initDrizzle(db);

      drizzle
        .insert(schema.guardViolations)
        .values({
          id: 'guard-1',
          filePath: 'src/App.ts',
          violationsJson: '[]',
          violationCount: 0,
          summary: null,
          triggeredAt: 'manual',
          createdAt: Math.floor(Date.now() / 1000),
        })
        .run();

      const rows = drizzle.select().from(schema.guardViolations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('guard-1');
      expect(rows[0].filePath).toBe('src/App.ts');
    });
  });
});
