/**
 * IndexingPipeline v2 — 索引管线
 * scan → chunk (AST / section / fixed) → detect incremental changes (sourceHash) → batch embed → batch upsert
 *
 * v2 变更:
 * - 集成 BatchEmbedder: 批量 embed 替代串行 per-chunk embed, ~50× 加速
 * - 集成 Chunker v2: auto 策略自动选择 AST / section / fixed 分块
 * - 新增 onProgress 回调支持
 * - 新增 chunking 配置透传 (strategy, maxChunkTokens, overlapTokens, useAST)
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import { chunk } from './Chunker.js';
import { BatchEmbedder } from './BatchEmbedder.js';

const SCANNABLE_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.swift',
  '.m',
  '.h',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.java',
  '.kt',
  '.go',
  '.rs',
  '.rb',
]);

export class IndexingPipeline {
  #vectorStore; // VectorStore 实例
  #aiProvider; // AiProvider 实例 (可选, 用于 embedding)
  #batchEmbedder; // BatchEmbedder 实例 (可选, 自动从 aiProvider 创建)
  #scanDirs; // 要扫描的目录
  #projectRoot;
  #chunkingOptions; // Chunker v2 透传选项

  constructor(options = {}) {
    this.#vectorStore = options.vectorStore || null;
    this.#aiProvider = options.aiProvider || null;
    this.#scanDirs = options.scanDirs || ['recipes', 'AutoSnippet/recipes'];
    this.#projectRoot = options.projectRoot || process.cwd();
    this.#chunkingOptions = {
      strategy: options.chunking?.strategy ?? 'auto',
      maxChunkTokens: options.chunking?.maxChunkTokens ?? 512,
      overlapTokens: options.chunking?.overlapTokens ?? 50,
      useAST: options.chunking?.useAST ?? true,
    };

    // 自动创建 BatchEmbedder (如果有 aiProvider)
    if (this.#aiProvider) {
      this.#batchEmbedder = new BatchEmbedder(this.#aiProvider, {
        batchSize: options.batchSize ?? 32,
        maxConcurrency: options.maxConcurrency ?? 2,
      });
    }
  }

  setVectorStore(store) {
    this.#vectorStore = store;
  }
  setAiProvider(provider) {
    this.#aiProvider = provider;
    if (provider) {
      this.#batchEmbedder = new BatchEmbedder(provider, {
        batchSize: 32,
        maxConcurrency: 2,
      });
    }
  }

  /**
   * 运行完整索引管线
   * @param {object} options - { force: boolean, dryRun: boolean, onProgress: function }
   * @returns {Promise<{ scanned, chunked, embedded, upserted, skipped, errors }>}
   */
  async run(options = {}) {
    const { force = false, dryRun = false, onProgress } = options;
    const stats = { scanned: 0, chunked: 0, embedded: 0, upserted: 0, skipped: 0, errors: 0 };

    if (!this.#vectorStore) {
      throw new Error('VectorStore not set');
    }

    // 1. 扫描文件
    const files = this.scan();
    stats.scanned = files.length;

    // 2. 增量检测 + 分块 (先收集所有 chunks)
    const existingIds = new Set(await this.#vectorStore.listIds());
    const allChunks = []; // { id, content, metadata }
    const staleIds = []; // 需要清理的旧 chunk id

    for (const file of files) {
      try {
        const content = readFileSync(file.absolutePath, 'utf-8');
        const hash = this.hashContent(content);
        const baseId = relative(this.#projectRoot, file.absolutePath).replace(/\//g, '_');

        // 增量检测：hash 未变时跳过
        if (!force) {
          const existing = await this.#vectorStore.getById(`${baseId}_0`);
          if (existing?.metadata?.sourceHash === hash) {
            stats.skipped++;
            continue;
          }
        }

        // 分块 (使用 Chunker v2 - 支持 AST 策略)
        const language = this.#detectLanguage(file.absolutePath);
        const chunks = chunk(content, {
          type: file.type,
          sourcePath: file.relativePath,
          sourceHash: hash,
          language,
        }, this.#chunkingOptions);
        stats.chunked += chunks.length;

        // 收集 chunks
        for (let i = 0; i < chunks.length; i++) {
          allChunks.push({
            id: `${baseId}_${i}`,
            content: chunks[i].content,
            metadata: { ...chunks[i].metadata, chunkIndex: i },
          });
        }

        // 标记需要清理的旧 chunk
        for (const existId of existingIds) {
          if (existId.startsWith(`${baseId}_`)) {
            const idx = Number.parseInt(existId.split('_').pop(), 10);
            if (idx >= chunks.length) {
              staleIds.push(existId);
            }
          }
        }
      } catch (_error) {
        stats.errors++;
      }
    }

    // 3. 批量 embed (使用 BatchEmbedder)
    let vectorMap = new Map(); // id → vector

    if (this.#batchEmbedder && allChunks.length > 0) {
      try {
        vectorMap = await this.#batchEmbedder.embedAll(
          allChunks.map((c) => ({ id: c.id, content: c.content })),
          (embedded, total) => {
            stats.embedded = embedded;
            onProgress?.({ phase: 'embed', embedded, total });
          }
        );
        stats.embedded = vectorMap.size;
      } catch {
        // embed 全部失败, 继续写入 (无向量)
      }
    }

    // 4. 批量写入
    if (!dryRun && allChunks.length > 0) {
      const batch = allChunks.map((c) => ({
        id: c.id,
        content: c.content,
        vector: vectorMap.get(c.id) || [],
        metadata: c.metadata,
      }));

      await this.#vectorStore.batchUpsert(batch);
      stats.upserted = batch.length;
      onProgress?.({ phase: 'upsert', upserted: stats.upserted });
    }

    // 5. 清理旧 chunks
    if (!dryRun) {
      for (const staleId of staleIds) {
        try {
          await this.#vectorStore.remove(staleId);
        } catch {
          /* skip cleanup errors */
        }
      }
    }

    return stats;
  }

  /**
   * 扫描项目中的可索引文件
   * @returns {Array<{ absolutePath, relativePath, type }>}
   */
  scan() {
    const files = [];

    for (const dir of this.#scanDirs) {
      const absDir = join(this.#projectRoot, dir);
      if (!existsSync(absDir)) {
        continue;
      }
      this.#walkDir(absDir, files);
    }

    // 也扫描根目录的 README
    const readmePath = join(this.#projectRoot, 'README.md');
    if (existsSync(readmePath)) {
      files.push({
        absolutePath: readmePath,
        relativePath: 'README.md',
        type: 'readme',
      });
    }

    return files;
  }

  /**
   * 计算内容 hash
   */
  hashContent(content) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  #walkDir(dir, files) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
          }
          this.#walkDir(fullPath, files);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (SCANNABLE_EXTENSIONS.has(ext)) {
            files.push({
              absolutePath: fullPath,
              relativePath: relative(this.#projectRoot, fullPath),
              type: ext === '.md' || ext === '.markdown' ? 'recipe' : 'code',
            });
          }
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  #detectLanguage(filePath) {
    const lang = LanguageService.inferLang(filePath);
    return lang === 'unknown' ? 'text' : lang;
  }
}
