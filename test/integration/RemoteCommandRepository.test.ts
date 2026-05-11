/**
 * 集成测试：RemoteCommandRepository — 远程指令队列 CRUD
 *
 * 覆盖范围:
 *   - enqueue / findById / findFirstPending
 *   - claim (CAS: pending → running)
 *   - complete (running → completed/failed)
 *   - flushPending (批量取消)
 *   - getHistory / getStatusCounts
 *   - findRecentClaim / findRecentChatId
 *   - cleanupTimeouts
 *   - setState / getState (KV store)
 */

import Database from 'better-sqlite3';
import { initDrizzle, resetDrizzle } from '../../lib/infrastructure/database/drizzle/index.js';
import migrate003 from '../../lib/infrastructure/database/migrations/003_add_remote_commands.js';
import { RemoteCommandRepository } from '../../lib/repository/remote/RemoteCommandRepository.js';

describe('Integration: RemoteCommandRepository', () => {
  let db: InstanceType<typeof Database>;
  let repo: RemoteCommandRepository;

  beforeEach(() => {
    resetDrizzle();
    db = new Database(':memory:');
    // Create remote_commands table
    migrate003(db);
    // Init Drizzle
    initDrizzle(db);
    // Create repository
    repo = new RemoteCommandRepository(db);
  });

  afterEach(() => {
    resetDrizzle();
    db.close();
  });

  describe('enqueue + findById', () => {
    test('should enqueue and retrieve a command', () => {
      repo.enqueue({
        id: 'cmd-1',
        source: 'lark',
        command: '/search auth',
        chatId: 'chat-1',
        userId: 'user-1',
        userName: 'Alice',
      });

      const row = repo.findById('cmd-1');
      expect(row).not.toBeNull();
      expect(row!.id).toBe('cmd-1');
      expect(row!.source).toBe('lark');
      expect(row!.command).toBe('/search auth');
      expect(row!.status).toBe('pending');
      expect(row!.chatId).toBe('chat-1');
      expect(row!.userName).toBe('Alice');
      expect(row!.createdAt).toBeGreaterThan(0);
      expect(row!.claimedAt).toBeNull();
      expect(row!.completedAt).toBeNull();
    });

    test('should return null for non-existent id', () => {
      expect(repo.findById('nope')).toBeNull();
    });

    test('should default userName to lark_user', () => {
      repo.enqueue({
        id: 'cmd-2',
        source: 'telegram',
        command: '/health',
      });
      const row = repo.findById('cmd-2');
      expect(row!.userName).toBe('lark_user');
    });
  });

  describe('findFirstPending', () => {
    test('should return null when queue is empty', () => {
      expect(repo.findFirstPending()).toBeNull();
    });

    test('should return oldest pending command', () => {
      repo.enqueue({ id: 'a', source: 'test', command: 'first' });
      repo.enqueue({ id: 'b', source: 'test', command: 'second' });

      const first = repo.findFirstPending();
      expect(first).not.toBeNull();
      expect(first!.id).toBe('a');
    });

    test('should skip claimed commands', () => {
      repo.enqueue({ id: 'a', source: 'test', command: 'first' });
      repo.enqueue({ id: 'b', source: 'test', command: 'second' });
      repo.claim('a');

      const first = repo.findFirstPending();
      expect(first!.id).toBe('b');
    });
  });

  describe('claim', () => {
    test('should transition pending → running', () => {
      repo.enqueue({ id: 'c-1', source: 'test', command: 'go' });
      const success = repo.claim('c-1');
      expect(success).toBe(true);

      const row = repo.findById('c-1');
      expect(row!.status).toBe('running');
      expect(row!.claimedAt).toBeGreaterThan(0);
    });

    test('should fail if already claimed (CAS)', () => {
      repo.enqueue({ id: 'c-2', source: 'test', command: 'go' });
      repo.claim('c-2');
      const secondClaim = repo.claim('c-2');
      expect(secondClaim).toBe(false);
    });

    test('should fail for non-existent id', () => {
      expect(repo.claim('nope')).toBe(false);
    });
  });

  describe('complete', () => {
    test('should set result and status', () => {
      repo.enqueue({ id: 'd-1', source: 'test', command: 'go' });
      repo.claim('d-1');
      repo.complete('d-1', 'Done!', 'completed');

      const row = repo.findById('d-1');
      expect(row!.status).toBe('completed');
      expect(row!.result).toBe('Done!');
      expect(row!.completedAt).toBeGreaterThan(0);
    });

    test('should default status to completed', () => {
      repo.enqueue({ id: 'd-2', source: 'test', command: 'go' });
      repo.claim('d-2');
      repo.complete('d-2', 'OK');

      expect(repo.findById('d-2')!.status).toBe('completed');
    });

    test('should support failed status', () => {
      repo.enqueue({ id: 'd-3', source: 'test', command: 'go' });
      repo.claim('d-3');
      repo.complete('d-3', 'Error occurred', 'failed');

      expect(repo.findById('d-3')!.status).toBe('failed');
    });
  });

  describe('flushPending', () => {
    test('should cancel all pending and return them', () => {
      repo.enqueue({ id: 'f-1', source: 'test', command: 'a' });
      repo.enqueue({ id: 'f-2', source: 'test', command: 'b' });
      repo.enqueue({ id: 'f-3', source: 'test', command: 'c' });
      // Claim one to make it non-pending
      repo.claim('f-2');

      const flushed = repo.flushPending();
      expect(flushed).toHaveLength(2);
      expect(flushed.map((f) => f.id)).toEqual(['f-1', 'f-3']);

      // Verify they are now cancelled
      expect(repo.findById('f-1')!.status).toBe('cancelled');
      expect(repo.findById('f-3')!.status).toBe('cancelled');
      // Claimed one should still be running
      expect(repo.findById('f-2')!.status).toBe('running');
    });

    test('should return empty array when no pending', () => {
      expect(repo.flushPending()).toEqual([]);
    });
  });

  describe('getHistory', () => {
    test('should return commands in descending creation order', () => {
      repo.enqueue({ id: 'h-1', source: 'test', command: 'first' });
      repo.enqueue({ id: 'h-2', source: 'test', command: 'second' });
      repo.enqueue({ id: 'h-3', source: 'test', command: 'third' });

      const history = repo.getHistory(10);
      expect(history).toHaveLength(3);
      // Most recent first
      expect(history[0].id).toBe('h-3');
    });

    test('should respect limit', () => {
      for (let i = 0; i < 5; i++) {
        repo.enqueue({ id: `h-${i}`, source: 'test', command: `cmd-${i}` });
      }
      expect(repo.getHistory(2)).toHaveLength(2);
    });

    test('should default limit to 20', () => {
      const history = repo.getHistory();
      expect(history).toEqual([]);
    });
  });

  describe('getStatusCounts', () => {
    test('should count by status', () => {
      repo.enqueue({ id: 's-1', source: 'test', command: 'a' });
      repo.enqueue({ id: 's-2', source: 'test', command: 'b' });
      repo.enqueue({ id: 's-3', source: 'test', command: 'c' });
      repo.claim('s-1');
      repo.claim('s-2');
      repo.complete('s-2', 'done');

      const counts = repo.getStatusCounts();
      expect(counts.pending).toBe(1);
      expect(counts.running).toBe(1);
      expect(counts.completed).toBe(1);
      expect(counts.timeout).toBe(0);
    });

    test('should return all zeros for empty queue', () => {
      const counts = repo.getStatusCounts();
      expect(counts).toEqual({ pending: 0, running: 0, completed: 0, timeout: 0 });
    });
  });

  describe('findRecentClaim', () => {
    test('should return most recent claim timestamp', () => {
      repo.enqueue({ id: 'rc-1', source: 'test', command: 'a' });
      repo.claim('rc-1');

      const recent = repo.findRecentClaim();
      expect(recent).not.toBeNull();
      expect(recent!.claimedAt).toBeGreaterThan(0);
    });

    test('should return null when no claims', () => {
      repo.enqueue({ id: 'rc-2', source: 'test', command: 'a' });
      expect(repo.findRecentClaim()).toBeNull();
    });
  });

  describe('findRecentChatId', () => {
    test('should return most recent chatId', () => {
      repo.enqueue({ id: 'ch-1', source: 'test', command: 'a', chatId: 'chat-99' });
      repo.enqueue({ id: 'ch-2', source: 'test', command: 'b' }); // no chatId

      const chatId = repo.findRecentChatId();
      expect(chatId).toBe('chat-99');
    });

    test('should return null when no chatId', () => {
      repo.enqueue({ id: 'ch-3', source: 'test', command: 'a' });
      expect(repo.findRecentChatId()).toBeNull();
    });
  });

  describe('cleanupTimeouts', () => {
    test('should timeout old pending commands', () => {
      // Insert directly with old timestamp
      db.prepare(
        `INSERT INTO remote_commands (id, source, command, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run('old-1', 'test', 'stale', 'pending', Math.floor(Date.now() / 1000) - 600);

      const cleaned = repo.cleanupTimeouts(300, 300);
      expect(cleaned).toBe(1);

      expect(repo.findById('old-1')!.status).toBe('timeout');
    });

    test('should timeout old running commands', () => {
      db.prepare(
        `INSERT INTO remote_commands (id, source, command, status, created_at, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'old-2',
        'test',
        'stale',
        'running',
        Math.floor(Date.now() / 1000) - 600,
        Math.floor(Date.now() / 1000) - 600
      );

      const cleaned = repo.cleanupTimeouts(300, 300);
      expect(cleaned).toBe(1);
      expect(repo.findById('old-2')!.status).toBe('timeout');
    });

    test('should not timeout recent commands', () => {
      repo.enqueue({ id: 'fresh', source: 'test', command: 'new' });
      const cleaned = repo.cleanupTimeouts(300, 300);
      expect(cleaned).toBe(0);
    });
  });

  describe('setState / getState', () => {
    test('should store and retrieve state', () => {
      repo.setState('last_poll', '1234567890');
      expect(repo.getState('last_poll')).toBe('1234567890');
    });

    test('should return null for unknown key', () => {
      expect(repo.getState('unknown')).toBeNull();
    });

    test('should upsert on conflict', () => {
      repo.setState('key1', 'value1');
      repo.setState('key1', 'value2');
      expect(repo.getState('key1')).toBe('value2');
    });

    test('should store multiple keys independently', () => {
      repo.setState('a', '1');
      repo.setState('b', '2');
      expect(repo.getState('a')).toBe('1');
      expect(repo.getState('b')).toBe('2');
    });
  });
});
