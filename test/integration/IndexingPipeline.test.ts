/**
 * 集成测试：IndexingPipeline + Chunker + VectorStore
 *
 * 覆盖范围:
 *   - IndexingPipeline scan / hashContent / run
 *   - Chunker 分块策略 (whole / section / fixed / auto)
 *   - 真实 VectorStore 与受控 embedding 交互
 *   - 增量索引（hash 变化检测）
 *   - dryRun 模式
 *   - 边界: 无文件、空内容
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunk, IndexingPipeline, JsonVectorAdapter } from '@alembic/core/vector';

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

    function createStore() {
      const store = new JsonVectorAdapter(tmpDir);
      store.initSync();
      return store;
    }

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

    test('indexes with injected store/provider and reports progress', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'test.md'), '# Test Recipe\nSome content here');

      const store = createStore();
      const embed = vi.fn(async (texts: string | string[]) =>
        Array.isArray(texts) ? texts.map(() => [1, 0]) : [1, 0]
      );
      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
      });
      pipeline.setVectorStore(store);
      pipeline.setAiProvider({ embed });
      const phases: string[] = [];
      expect(await pipeline.run({ onProgress: (info) => phases.push(info.phase) })).toMatchObject({
        scanned: 1,
        chunked: 1,
        embedded: 1,
        upserted: 1,
        errors: 0,
      });
      const ids = await store.listIds();
      expect(ids).toHaveLength(1);
      expect(await store.getById(ids[0])).toMatchObject({
        content: '# Test Recipe\nSome content here',
        vector: [1, 0],
        metadata: { sourcePath: 'recipes/test.md' },
      });
      expect(embed).toHaveBeenCalledOnce();
      expect(phases).toContain('upsert');
    });

    test('should skip unchanged files (incremental)', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      const source = path.join(recipesDir, 'stable.md');
      fs.writeFileSync(source, '# Stable Content');
      const store = createStore();
      const upsert = vi.spyOn(store, 'batchUpsert');
      const embed = vi.fn(async (texts: string | string[]) =>
        Array.isArray(texts) ? texts.map(() => [1, 0]) : [1, 0]
      );
      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
        vectorStore: store,
        aiProvider: { embed },
      });
      try {
        // 使用首次真实写入的 sourcePath/producer/完整分块事实，不伪造只有 hash 的旧行。
        expect(await pipeline.run()).toMatchObject({ skipped: 0, embedded: 1, upserted: 1 });
        const ids = await store.listIds();
        expect(ids).toHaveLength(1);
        expect(await store.getById(ids[0])).toMatchObject({
          content: '# Stable Content',
          vector: [1, 0],
          metadata: { sourcePath: 'recipes/stable.md' },
        });
        embed.mockClear();
        upsert.mockClear();

        expect(await pipeline.run()).toMatchObject({ skipped: 1, embedded: 0, upserted: 0 });
        expect(embed).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(await store.listIds()).toEqual(ids);

        fs.writeFileSync(source, '# Changed Content');
        expect(await pipeline.run()).toMatchObject({ skipped: 0, embedded: 1, upserted: 1 });
        expect(embed).toHaveBeenCalledOnce();
        expect(upsert).toHaveBeenCalledOnce();
        expect(await store.getById(ids[0])).toMatchObject({ content: '# Changed Content' });
      } finally {
        upsert.mockRestore();
      }
    });

    test('should run in dryRun mode without writing', async () => {
      const recipesDir = path.join(tmpDir, 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(path.join(recipesDir, 'dry.md'), '# Dry Run Test');

      const store = createStore();
      await store.upsert({ id: 'retained', content: 'prior data', vector: [], metadata: {} });
      const pipeline = new IndexingPipeline({
        scanDirs: ['recipes'],
        projectRoot: tmpDir,
        vectorStore: store,
      });

      const stats = await pipeline.run({ dryRun: true, clear: true });
      expect(stats.upserted).toBe(0);
      expect(stats.chunked).toBeGreaterThanOrEqual(1);
      expect(await store.listIds()).toEqual(['retained']);
      expect(await store.getById('retained')).toMatchObject({ content: 'prior data' });
    });

    test('should throw without VectorStore', async () => {
      const pipeline = new IndexingPipeline({ projectRoot: tmpDir });
      await expect(pipeline.run()).rejects.toThrow('VectorStore not set');
    });
  });
});
