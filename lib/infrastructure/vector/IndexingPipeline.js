/**
 * IndexingPipeline — 索引管线
 * scan → chunk → detect incremental changes (sourceHash) → embed via AI → batch upsert
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { LanguageService } from '../../shared/LanguageService.js';
import { chunk } from './Chunker.js';

const SCANNABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt',
  '.swift', '.m', '.h',
  '.js', '.ts', '.jsx', '.tsx',
  '.py',
  '.java', '.kt',
  '.go',
  '.rs', '.rb',
]);

export class IndexingPipeline {
  #vectorStore; // VectorStore 实例
  #aiProvider; // AiProvider 实例 (可选, 用于 embedding)
  #scanDirs; // 要扫描的目录
  #projectRoot;

  constructor(options = {}) {
    this.#vectorStore = options.vectorStore || null;
    this.#aiProvider = options.aiProvider || null;
    this.#scanDirs = options.scanDirs || ['recipes', 'AutoSnippet/recipes'];
    this.#projectRoot = options.projectRoot || process.cwd();
  }

  setVectorStore(store) {
    this.#vectorStore = store;
  }
  setAiProvider(provider) {
    this.#aiProvider = provider;
  }

  /**
   * 运行完整索引管线
   * @param {object} options — { force: boolean, dryRun: boolean }
   * @returns {{ scanned, chunked, embedded, upserted, skipped, errors }}
   */
  async run(options = {}) {
    const { force = false, dryRun = false } = options;
    const stats = { scanned: 0, chunked: 0, embedded: 0, upserted: 0, skipped: 0, errors: 0 };

    if (!this.#vectorStore) {
      throw new Error('VectorStore not set');
    }

    // 1. 扫描文件
    const files = this.scan();
    stats.scanned = files.length;

    // 2. 增量检测 + 分块 + 嵌入 + 写入
    const existingIds = new Set(await this.#vectorStore.listIds());
    const batch = [];

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

        // 分块
        const chunks = chunk(content, {
          type: file.type,
          sourcePath: file.relativePath,
          sourceHash: hash,
          language: this.#detectLanguage(file.absolutePath),
        });
        stats.chunked += chunks.length;

        // 嵌入（如果有 AI Provider）
        for (let i = 0; i < chunks.length; i++) {
          const chunkItem = chunks[i];
          const id = `${baseId}_${i}`;
          let vector = [];

          if (this.#aiProvider && typeof this.#aiProvider.embed === 'function') {
            try {
              vector = await this.#aiProvider.embed(chunkItem.content);
              stats.embedded++;
            } catch {
              /* embed optional */
            }
          }

          batch.push({
            id,
            content: chunkItem.content,
            vector,
            metadata: { ...chunkItem.metadata, chunkIndex: i },
          });
        }

        // 清理旧 chunk (如果文件 chunk 数减少)
        for (const existId of existingIds) {
          if (existId.startsWith(`${baseId}_`)) {
            const idx = parseInt(existId.split('_').pop(), 10);
            if (idx >= chunks.length) {
              if (!dryRun) {
                await this.#vectorStore.remove(existId);
              }
            }
          }
        }
      } catch (_error) {
        stats.errors++;
      }
    }

    // 3. 批量写入
    if (!dryRun && batch.length > 0) {
      await this.#vectorStore.batchUpsert(batch);
      stats.upserted = batch.length;
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
