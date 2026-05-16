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
import migrate003 from '../../lib/infrastructure/database/migrations/003_add_remote_commands.js';

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
    test('should export remoteCommands table', () => {
      expect(schema.remoteCommands).toBeDefined();
    });

    test('should export remoteState table', () => {
      expect(schema.remoteState).toBeDefined();
    });

    test('should export knowledge and other core tables', () => {
      // these are defined in the Drizzle schema
      expect(schema.knowledgeEntries).toBeDefined();
      expect(schema.guardViolations).toBeDefined();
    });
  });

  describe('real SQL operations via Drizzle', () => {
    test('should insert and select from remote_commands', () => {
      // Run migration to create table
      migrate003(db);
      const drizzle = initDrizzle(db);

      // Insert a row via Drizzle
      drizzle
        .insert(schema.remoteCommands)
        .values({
          id: 'test-1',
          source: 'test',
          command: 'hello',
          status: 'pending',
          createdAt: Math.floor(Date.now() / 1000),
        })
        .run();

      // Read it back
      const rows = drizzle.select().from(schema.remoteCommands).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('test-1');
      expect(rows[0].command).toBe('hello');
      expect(rows[0].status).toBe('pending');
    });

    test('should insert and select from remote_state', () => {
      // remote_state is created inline, create it manually
      db.exec(
        'CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
      );
      const drizzle = initDrizzle(db);

      drizzle
        .insert(schema.remoteState)
        .values({
          key: 'test-key',
          value: 'test-value',
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .run();

      const rows = drizzle.select().from(schema.remoteState).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe('test-key');
      expect(rows[0].value).toBe('test-value');
    });

    test('should handle update operations', () => {
      migrate003(db);
      const drizzle = initDrizzle(db);

      drizzle
        .insert(schema.remoteCommands)
        .values({
          id: 'upd-1',
          source: 'test',
          command: 'update me',
          status: 'pending',
          createdAt: Math.floor(Date.now() / 1000),
        })
        .run();

      drizzle
        .update(schema.remoteCommands)
        .set({ status: 'running', claimedAt: Math.floor(Date.now() / 1000) })
        .where(eq(schema.remoteCommands.id, 'upd-1'))
        .run();

      const rows = drizzle
        .select()
        .from(schema.remoteCommands)
        .where(eq(schema.remoteCommands.id, 'upd-1'))
        .all();
      expect(rows[0].status).toBe('running');
      expect(rows[0].claimedAt).toBeGreaterThan(0);
    });
  });
});
