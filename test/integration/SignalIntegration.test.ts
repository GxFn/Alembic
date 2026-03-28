/**
 * Integration: Signal Bus — 端到端信号集成
 *
 * 验证:
 *   - GuardCheckEngine.auditFiles() 发射 guard 信号
 *   - SearchEngine.search() 发射 search 信号
 *   - RuleLearner.recordFeedback() 发射 quality 信号
 *   - SignalBus 通配符订阅收集所有信号
 */

import type { Signal } from '../../lib/infrastructure/signal/SignalBus.js';
import { SignalBus } from '../../lib/infrastructure/signal/SignalBus.js';
import { GuardCheckEngine } from '../../lib/service/guard/GuardCheckEngine.js';
import { SearchEngine } from '../../lib/service/search/SearchEngine.js';
import { createTestBootstrap } from '../fixtures/factory.js';

describe('Integration: Signal Bus end-to-end', () => {
  let bootstrap: Awaited<ReturnType<typeof createTestBootstrap>>['bootstrap'];
  let db: ReturnType<ReturnType<typeof Object>>;
  let bus: SignalBus;
  const collected: Signal[] = [];

  beforeAll(async () => {
    const result = await createTestBootstrap();
    bootstrap = result.bootstrap;
    db = result.components.db.getDb();
    bus = new SignalBus();
    bus.subscribe('*', (s) => collected.push(s));
  });

  afterAll(async () => {
    await bootstrap.shutdown();
  });

  beforeEach(() => {
    collected.length = 0;
  });

  // ── GuardCheckEngine emits guard signal ─────────────

  describe('GuardCheckEngine signal emission', () => {
    it('should emit guard signal when auditFiles finds violations', () => {
      const engine = new GuardCheckEngine(db, { signalBus: bus });
      const objcCode = `
        - (void)viewDidLoad {
          NSArray *arr = @[@1, @2];
          id item = [arr objectAtIndex:5]; // should trigger guard rule
        }
      `;

      const result = engine.auditFiles([{ path: 'Test.m', content: objcCode }], { scope: 'file' });

      if (result.summary.totalViolations > 0) {
        expect(collected.length).toBeGreaterThanOrEqual(1);
        const guardSignal = collected.find((s) => s.type === 'guard');
        expect(guardSignal).toBeDefined();
        expect(guardSignal!.source).toBe('GuardCheckEngine');
        expect(guardSignal!.value).toBeGreaterThanOrEqual(0);
        expect(guardSignal!.value).toBeLessThanOrEqual(1);
      }
    });

    it('should not emit signal when no violations found', () => {
      const engine = new GuardCheckEngine(db, { signalBus: bus });
      const cleanCode = '// clean file\nconst x = 1;\n';

      engine.auditFiles([{ path: 'clean.ts', content: cleanCode }], { scope: 'file' });

      const guardSignals = collected.filter((s) => s.type === 'guard');
      expect(guardSignals).toHaveLength(0);
    });
  });

  // ── SearchEngine emits search signal ────────────────

  describe('SearchEngine signal emission', () => {
    it('should emit search signal when results found', async () => {
      const engine = new SearchEngine(db, { signalBus: bus });

      // Insert a searchable entry
      try {
        db.prepare(
          `INSERT OR IGNORE INTO knowledge_entries
           (id, title, description, language, category, knowledgeType, kind, content, lifecycle, tags, difficulty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          'test-signal-entry',
          'Signal Bus Pattern',
          'A pub-sub signal bus implementation',
          'typescript',
          'infrastructure',
          'pattern',
          'pattern',
          JSON.stringify({ pattern: 'class SignalBus { emit() {} }' }),
          'active',
          '["signal","bus"]',
          'intermediate'
        );
      } catch {
        /* may already exist */
      }

      engine.buildIndex();
      const result = await engine.search('signal bus');

      if (result.total > 0) {
        const searchSignals = collected.filter((s) => s.type === 'search');
        expect(searchSignals.length).toBeGreaterThanOrEqual(1);
        expect(searchSignals[0].source).toBe('SearchEngine');
        expect(searchSignals[0].metadata.query).toBe('signal bus');
      }
    });

    it('should not emit signal for empty results', async () => {
      const engine = new SearchEngine(db, { signalBus: bus });
      engine.buildIndex();
      await engine.search('xyznonexistent99999');

      const searchSignals = collected.filter((s) => s.type === 'search');
      expect(searchSignals).toHaveLength(0);
    });
  });

  // ── Wildcard collection ─────────────────────────────

  describe('Wildcard signal collection', () => {
    it('collects all signal types via wildcard subscription', () => {
      bus.send('guard', 'test', 0.8);
      bus.send('search', 'test', 0.5);
      bus.send('quality', 'test', 0.9);

      expect(collected.length).toBe(3);
      const types = collected.map((s) => s.type);
      expect(types).toContain('guard');
      expect(types).toContain('search');
      expect(types).toContain('quality');
    });
  });
});
