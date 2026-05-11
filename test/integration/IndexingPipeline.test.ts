/**
 * 集成测试：IndexingPipeline + Chunker + VectorStore
 *
 * 覆盖范围:
 *   - IndexingPipeline scan / hashContent / run
 *   - Chunker 分块策略 (whole / section / fixed / auto)
 *   - Mock VectorStore 交互验证
 *   - 增量索引（hash 变化检测）
 *   - dryRun 模式
 *   - 边界: 无文件、空内容
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunk } from '../../lib/infrastructure/vector/Chunker.js';
import { IndexingPipeline } from '../../lib/infrastructure/vector/IndexingPipeline.js';

describe('Integration: Indexing Pipeline & Chunker', () => {
  // ─── Chunker ──────────────────────────────────

  describe('Chunker', () => {
    test('should return empty for empty content', () => {
      const result = chunk('', {});
      expect(result).toEqual([]);
    });

    test('should return empty for whitespace-only content', () => {
      const result = chunk('   \n  ', {});
      expect(result).toEqual([]);
    });

    test('should use whole strategy for small content', () => {
      const content = 'function hello() { return "world"; }';
      const result = chunk(
        content,
        { language: 'javascript' },
        { strategy: 'auto', maxChunkTokens: 1000 }
      );
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(content);
      expect(result[0].metadata.chunkStrategy).toBe('whole');
    });

    test('should use section strategy for markdown with headers', () => {
      const content = `# Introduction\nSome intro text that is long enough.\n\n## Section A\nDetails about section A with enough content to exceed token limit.\n\n## Section B\nDetails about section B with enough content.`;
      const result = chunk(content, {}, { strategy: 'section', maxChunkTokens: 30 });
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    test('should use fixed strategy for plain text', () => {
      const content = 'word '.repeat(500);
      const result = chunk(content, {}, { strategy: 'fixed', maxChunkTokens: 50 });
      expect(result.length).toBeGreaterThan(1);
    });

    test('should carry metadata through chunks', () => {
      const content = 'x '.repeat(500);
      const result = chunk(
        content,
        { sourcePath: 'test.md', sourceHash: 'abc123', language: 'text' },
        { strategy: 'fixed', maxChunkTokens: 50 }
      );
      for (const c of result) {
        expect(c.metadata.sourcePath).toBe('test.md');
        expect(c.metadata.sourceHash).toBe('abc123');
      }
    });

    test('auto strategy should detect markdown', () => {
      const content = `# Title\nLong content here. ${'a '.repeat(800)}\n\n## Another section\nMore content. ${'b '.repeat(800)}`;
      const result = chunk(content, { language: '' }, { strategy: 'auto', maxChunkTokens: 100 });
      expect(result.length).toBeGreaterThan(1);
    });
  });

  // ─── IndexingPipeline ─────────────────────────

  describe('IndexingPipeline', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-idx-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('should hash content deterministically', () => {
      const pipeline = new IndexingPipeline();
      const hash1 = pipeline.hashContent('hello world');
      const hash2 = pipeline.hashContent('hello world');
      const hash3 = pipeline.hashContent('different');
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1.length).toBe(16);
    });

    test('should scan recipe directory', () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'pattern-a.md'), '# Pattern A\nDescription here');
      fs.writeFileSync(path.join(recipesDir, 'pattern-b.md'), '# Pattern B\nAnother pattern');
      fs.writeFileSync(path.join(recipesDir, 'code.ts'), 'export const x = 1;');
      // Non-scannable file
      fs.writeFileSync(path.join(recipesDir, 'image.png'), 'binary');

      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
      });

      const files = pipeline.scan();
      expect(files.length).toBeGreaterThanOrEqual(3); // 2 md + 1 ts (+ maybe README)
      expect(files.some((f) => f.relativePath.includes('pattern-a.md'))).toBe(true);
      expect(files.some((f) => f.relativePath.includes('code.ts'))).toBe(true);
      // .png should not be included
      expect(files.some((f) => f.relativePath.includes('image.png'))).toBe(false);
    });

    test('should scan README.md at project root', () => {
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# My Project');
      const pipeline = new IndexingPipeline({
        scanDirs: [],
        projectRoot: tmpDir,
      });
      const files = pipeline.scan();
      expect(files.some((f) => f.relativePath === 'README.md')).toBe(true);
    });

    test('should skip non-existent scan dirs', () => {
      const pipeline = new IndexingPipeline({
        scanDirs: ['nonexistent'],
        projectRoot: tmpDir,
      });
      const files = pipeline.scan();
      // Should not throw, just return empty or just README
      expect(Array.isArray(files)).toBe(true);
    });

    test('should run with mock vector store', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'test.md'), '# Test Recipe\nSome content here');

      const upserted: Array<{ id: string; content: string }> = [];
      const mockVectorStore = {
        init: async () => {},
        listIds: async () => [],
        getById: async () => null,
        batchUpsert: async (items: Array<{ id: string; content: string }>) => {
          upserted.push(...items);
        },
        remove: async () => {},
      };

      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
        vectorStore: mockVectorStore as any,
      });

      const stats = await pipeline.run();
      expect(stats.scanned).toBeGreaterThanOrEqual(1);
      expect(stats.chunked).toBeGreaterThanOrEqual(1);
      expect(stats.upserted).toBeGreaterThanOrEqual(1);
      expect(upserted.length).toBeGreaterThanOrEqual(1);
    });

    test('should skip unchanged files (incremental)', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'stable.md'), '# Stable Content');

      const content = fs.readFileSync(path.join(recipesDir, 'stable.md'), 'utf-8');
      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
      });
      const hash = pipeline.hashContent(content);

      const mockVectorStore = {
        listIds: async () => ['recipes_stable.md_0'],
        getById: async (id: string) => {
          if (id === 'recipes_stable.md_0') {
            return { metadata: { sourceHash: hash } };
          }
          return null;
        },
        batchUpsert: async () => {},
        remove: async () => {},
      };

      pipeline.setVectorStore(mockVectorStore as any);
      const stats = await pipeline.run();
      expect(stats.skipped).toBeGreaterThanOrEqual(1);
    });

    test('should run in dryRun mode without writing', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'dry.md'), '# Dry Run Test');

      let upsertCalled = false;
      const mockVectorStore = {
        listIds: async () => [],
        getById: async () => null,
        batchUpsert: async () => {
          upsertCalled = true;
        },
        remove: async () => {},
      };

      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
        vectorStore: mockVectorStore as any,
      });

      const stats = await pipeline.run({ dryRun: true });
      expect(upsertCalled).toBe(false);
      expect(stats.upserted).toBe(0);
      expect(stats.chunked).toBeGreaterThanOrEqual(1);
    });

    test('should throw without VectorStore', async () => {
      const pipeline = new IndexingPipeline({ projectRoot: tmpDir });
      await expect(pipeline.run()).rejects.toThrow('VectorStore not set');
    });

    test('should set vector store and AI provider dynamically', () => {
      const pipeline = new IndexingPipeline();
      const mockStore = { init: async () => {} };
      const mockAi = { embed: async () => [[0.1, 0.2]] };

      pipeline.setVectorStore(mockStore as any);
      pipeline.setAiProvider(mockAi as any);
      // Should not throw
      expect(true).toBe(true);
    });

    test('should report progress via callback', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'progress.md'), '# Progress');

      const mockVectorStore = {
        listIds: async () => [],
        getById: async () => null,
        batchUpsert: async () => {},
        remove: async () => {},
      };

      const phases: string[] = [];
      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
        vectorStore: mockVectorStore as any,
      });

      await pipeline.run({
        onProgress: (info) => phases.push(info.phase),
      });

      expect(phases).toContain('upsert');
    });
  });
});
