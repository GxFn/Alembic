/**
 * 集成测试：Drizzle ORM — 实例生命周期 + 真实 SQL 操作
 *
 * 覆盖范围:
 *   - initDrizzle / getDrizzle / resetDrizzle 生命周期
 *   - getDrizzle 未初始化时抛错
 *   - schema 表定义存在性
 *   - 通过 Drizzle 执行真实 SQL 读写
 */

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  getDrizzle,
  initDrizzle,
  resetDrizzle,
  schema,
} from '../../lib/infrastructure/database/drizzle/index.js';
import migrate001 from '../../lib/infrastructure/database/migrations/001_initial_schema.js';
import migrate004 from '../../lib/infrastructure/database/migrations/004_evolution_proposals.js';

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
    test('should insert and select from knowledge_entries', () => {
      // Run migration to create table
      migrate001(db);
      migrate004(db);
      const drizzle = initDrizzle(db);

      // Insert a row via Drizzle
      drizzle
        .insert(schema.knowledgeEntries)
        .values({
          id: 'test-1',
          title: 'hello',
          language: 'typescript',
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .run();

      // Read it back
      const rows = drizzle.select().from(schema.knowledgeEntries).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('test-1');
      expect(rows[0].title).toBe('hello');
      expect(rows[0].language).toBe('typescript');
    });

    test('should handle update operations', () => {
      migrate001(db);
      migrate004(db);
      const drizzle = initDrizzle(db);

      drizzle
        .insert(schema.knowledgeEntries)
        .values({
          id: 'upd-1',
          title: 'update me',
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .run();

      drizzle
        .update(schema.knowledgeEntries)
        .set({ title: 'updated', updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(schema.knowledgeEntries.id, 'upd-1'))
        .run();

      const rows = drizzle
        .select()
        .from(schema.knowledgeEntries)
        .where(eq(schema.knowledgeEntries.id, 'upd-1'))
        .all();
      expect(rows[0].title).toBe('updated');
    });
  });
});
