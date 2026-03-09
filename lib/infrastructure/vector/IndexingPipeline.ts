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
import { KNOWLEDGE_BASE_DIR } from '../config/Defaults.js';
import { BatchEmbedder } from './BatchEmbedder.js';
import { chunk } from './Chunker.js';
import type { VectorStore } from './VectorStore.js';

/** ContextualEnricher 接口 (可选, 由 service 层注入) */
interface ContextualEnricherLike {
  enrichChunks(
    document: { title: string; content: string; kind: string; sourcePath?: string },
    chunks: Array<{ content: string; metadata: Record<string, unknown> }>
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> }>>;
}

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
  #contextualEnricher: ContextualEnricherLike | null; // 上下文增强器 (可选)

  constructor(
    options: {
      vectorStore?: VectorStore;
      aiProvider?: { embed: (texts: string | string[]) => Promise<number[] | number[][]> };
      scanDirs?: string[];
      projectRoot?: string;
      batchSize?: number;
      maxConcurrency?: number;
      contextualEnricher?: ContextualEnricherLike | null;
      chunking?: {
        strategy?: string;
        maxChunkTokens?: number;
        overlapTokens?: number;
        useAST?: boolean;
      };
    } = {}
  ) {
    this.#vectorStore = options.vectorStore || null;
    this.#aiProvider = options.aiProvider || null;
    this.#scanDirs = options.scanDirs || ['recipes', `${KNOWLEDGE_BASE_DIR}/recipes`];
    this.#projectRoot = options.projectRoot || process.cwd();
    this.#chunkingOptions = {
      strategy: options.chunking?.strategy ?? 'auto',
      maxChunkTokens: options.chunking?.maxChunkTokens ?? 512,
      overlapTokens: options.chunking?.overlapTokens ?? 50,
      useAST: options.chunking?.useAST ?? true,
    };

    this.#contextualEnricher = options.contextualEnricher || null;

    // 自动创建 BatchEmbedder (如果有 aiProvider)
    if (this.#aiProvider) {
      this.#batchEmbedder = new BatchEmbedder(this.#aiProvider, {
        batchSize: options.batchSize ?? 32,
        maxConcurrency: options.maxConcurrency ?? 2,
      });
    }
  }

  setVectorStore(store: VectorStore) {
    this.#vectorStore = store;
  }
  setAiProvider(
    provider: { embed: (texts: string | string[]) => Promise<number[] | number[][]> } | null
  ) {
    this.#aiProvider = provider;
    if (provider) {
      this.#batchEmbedder = new BatchEmbedder(provider, {
        batchSize: 32,
        maxConcurrency: 2,
      });
    }
  }

  setContextualEnricher(enricher: ContextualEnricherLike | null) {
    this.#contextualEnricher = enricher;
  }

  /**
   * 运行完整索引管线
   * @param {object} options - { force: boolean, dryRun: boolean, onProgress: function }
   * @returns {Promise<{ scanned, chunked, embedded, upserted, skipped, errors }>}
   */
  async run(
    options: {
      force?: boolean;
      dryRun?: boolean;
      clear?: boolean;
      onProgress?: (info: { phase: string; [key: string]: unknown }) => void;
    } = {}
  ) {
    const { force = false, dryRun = false, clear = false, onProgress } = options;
    const stats = {
      scanned: 0,
      chunked: 0,
      enriched: 0,
      embedded: 0,
      upserted: 0,
      skipped: 0,
      errors: 0,
    };

    if (!this.#vectorStore) {
      throw new Error('VectorStore not set');
    }

    // 0. clear — 清空现有索引后重建
    if (clear && !dryRun) {
      await this.#vectorStore.clear();
      onProgress?.({ phase: 'clear', detail: 'Existing index cleared' });
    }

    // 1. 扫描文件
    const files = this.scan();
    stats.scanned = files.length;

    // 2. 增量检测 + 分块 (先收集所有 chunks)
    const existingIds = new Set(await this.#vectorStore.listIds());
    const allChunks: { id: string; content: string; metadata: Record<string, unknown> }[] = []; // { id, content, metadata }
    const staleIds: unknown[] = []; // 需要清理的旧 chunk id

    for (const file of files) {
      try {
        const content = readFileSync(file.absolutePath, 'utf-8');
        const hash = this.hashContent(content);
        const baseId = relative(this.#projectRoot, file.absolutePath).replace(/\//g, '_');

        // 增量检测：hash 未变时跳过
        if (!force) {
          const existing = await this.#vectorStore.getById(`${baseId}_0`);
          if ((existing?.metadata as Record<string, unknown> | undefined)?.sourceHash === hash) {
            stats.skipped++;
            continue;
          }
        }

        // 分块 (使用 Chunker v2 - 支持 AST 策略)
        const language = this.#detectLanguage(file.absolutePath);
        const chunks = chunk(
          content,
          {
            type: file.type,
            sourcePath: file.relativePath,
            sourceHash: hash,
            language,
          },
          this.#chunkingOptions
        );
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
          if ((existId as string).startsWith(`${baseId}_`)) {
            const idx = Number.parseInt((existId as string).split('_').pop()!, 10);
            if (idx >= chunks.length) {
              staleIds.push(existId);
            }
          }
        }
      } catch (_error: unknown) {
        stats.errors++;
      }
    }

    // 2.5. Contextual Enrichment (可选, 在 embed 之前)
    if (this.#contextualEnricher && allChunks.length > 0) {
      onProgress?.({ phase: 'enrich', detail: 'Running contextual enrichment...' });
      // 按 sourcePath 分组，每个文档的 chunks 一起 enrich
      const chunksBySource = new Map<
        string,
        Array<{ index: number; chunk: (typeof allChunks)[0] }>
      >();
      for (let i = 0; i < allChunks.length; i++) {
        const sourcePath = (allChunks[i].metadata.sourcePath as string) || 'unknown';
        if (!chunksBySource.has(sourcePath)) {
          chunksBySource.set(sourcePath, []);
        }
        chunksBySource.get(sourcePath)!.push({ index: i, chunk: allChunks[i] });
      }

      for (const [sourcePath, group] of chunksBySource) {
        try {
          // 读取原始文档内容作为上下文
          const firstChunk = group[0].chunk;
          const docTitle = (firstChunk.metadata.sourcePath as string) || sourcePath;
          const docKind = (firstChunk.metadata.type as string) || 'recipe';
          // 拼接所有 chunk 作为文档摘要（enricher 内部会截断）
          const docContent = group.map((g) => g.chunk.content).join('\n\n');

          const enrichedChunks = await this.#contextualEnricher!.enrichChunks(
            { title: docTitle, content: docContent, kind: docKind, sourcePath },
            group.map((g) => ({
              content: g.chunk.content,
              metadata: g.chunk.metadata,
            }))
          );

          // 回写 enriched 内容
          for (let j = 0; j < enrichedChunks.length; j++) {
            const originalIndex = group[j].index;
            allChunks[originalIndex] = {
              ...allChunks[originalIndex],
              content: enrichedChunks[j].content,
              metadata: { ...allChunks[originalIndex].metadata, ...enrichedChunks[j].metadata },
            };
            if (enrichedChunks[j].metadata.contextEnriched) {
              stats.enriched++;
            }
          }
        } catch {
          // enrichment 失败不阻塞，使用原始 chunks
        }
      }
      onProgress?.({ phase: 'enrich', detail: `Enriched ${stats.enriched} chunks` });
    }

    // 3. 批量 embed (使用 BatchEmbedder)
    let vectorMap = new Map(); // id → vector

    if (this.#batchEmbedder && allChunks.length > 0) {
      try {
        vectorMap = await this.#batchEmbedder.embedAll(
          allChunks.map((c) => ({ id: c.id, content: c.content })),
          (embedded: number, total: number) => {
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
          await this.#vectorStore.remove(staleId as string);
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
    const files: { absolutePath: string; relativePath: string; type: string }[] = [];

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
  hashContent(content: string) {
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  #walkDir(
    dir: string,
    files: Array<{ absolutePath: string; relativePath: string; type: string }>
  ) {
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

  #detectLanguage(filePath: string) {
    const lang = LanguageService.inferLang(filePath);
    return lang === 'unknown' ? 'text' : lang;
  }
}
