/**
 * GraphCache — 基于文件的图数据持久化缓存
 *
 * 功能:
 * 1. 将图数据序列化为 JSON 写入磁盘
 * 2. 基于 contentHash 判断缓存是否有效（Package.swift / 源文件）
 * 3. 支持 SPM 依赖图和 AST ProjectGraph 两种场景
 *
 * 缓存位置: {projectRoot}/.asd/cache/
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DataPath, WriteZone } from '#infra/io/WriteZone.js';
import Logger from '../logging/Logger.js';

export class GraphCache {
  #cacheDir;
  #logger;
  #wz: WriteZone | null;

  /**
   * @param projectRoot 项目根目录（或 dataRoot — Ghost 模式下为外置工作区路径）
   * @param writeZone WriteZone 实例（可选，提供后写入操作走 WriteZone 管控）
   * 缓存目录: {projectRoot}/.asd/cache/
   */
  constructor(projectRoot: string, writeZone?: WriteZone) {
    this.#cacheDir = join(projectRoot, '.asd', 'cache');
    this.#logger = Logger.getInstance();
    this.#wz = writeZone ?? null;
  }

  /**
   * 保存缓存
   * @param key 缓存键名（生成 {key}.json）
   * @param data 要缓存的数据
   * @param meta 元信息（含 hash、timestamp 等）
   */
  save(key: string, data: unknown, meta: Record<string, unknown> = {}) {
    try {
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        ...meta,
        data,
      };
      const filePath = join(this.#cacheDir, `${key}.json`);
      const content = JSON.stringify(payload);

      if (this.#wz) {
        this.#wz.ensureDir(this.#wz.runtime('cache'));
        this.#wz.writeFile(this.#wz.runtime(`cache/${key}.json`), content);
      } else {
        if (!existsSync(this.#cacheDir)) {
          mkdirSync(this.#cacheDir, { recursive: true });
        }
        writeFileSync(filePath, content, 'utf-8');
      }
      this.#logger.debug(`[GraphCache] saved: ${key} (${content.length} bytes)`);
    } catch (err: unknown) {
      this.#logger.warn(`[GraphCache] save failed for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * 加载缓存
   * @param key 缓存键名
   * @returns | null}
   */
  load(key: string) {
    try {
      const filePath = join(this.#cacheDir, `${key}.json`);
      if (!existsSync(filePath)) {
        return null;
      }
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err: unknown) {
      this.#logger.warn(`[GraphCache] load failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 检查缓存是否有效（hash 匹配）
   * @param key 缓存键
   * @param currentHash 当前内容的 hash
   */
  isValid(key: string, currentHash: string) {
    const cached = this.load(key);
    if (!cached) {
      return false;
    }
    return cached.contentHash === currentHash;
  }

  /** 删除缓存 */
  invalidate(key: string) {
    try {
      if (this.#wz) {
        const target = this.#wz.runtime(`cache/${key}.json`);
        if (existsSync(target.absolute)) {
          this.#wz.remove(target);
          this.#logger.debug(`[GraphCache] invalidated: ${key}`);
        }
      } else {
        const filePath = join(this.#cacheDir, `${key}.json`);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
          this.#logger.debug(`[GraphCache] invalidated: ${key}`);
        }
      }
    } catch (err: unknown) {
      this.#logger.warn(`[GraphCache] invalidate failed for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * 计算文件内容 hash
   * @param filePath 文件绝对路径
   * @returns sha256 hex (前 16 字符)
   */
  computeFileHash(filePath: string) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return this.computeContentHash(content);
    } catch {
      return '';
    }
  }

  /**
   * 计算字符串内容 hash
   * @returns sha256 hex (前 16 字符)
   */
  computeContentHash(content: string) {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * 批量计算文件 hash 映射
   * @param filePaths 文件绝对路径数组
   * @param projectRoot 项目根目录
   * @returns { relativePath: hash }
   */
  computeFileHashes(filePaths: string[], projectRoot: string) {
    const hashes: Record<string, string> = {};
    for (const fp of filePaths) {
      const rel = relative(projectRoot, fp);
      hashes[rel] = this.computeFileHash(fp);
    }
    return hashes;
  }

  /** 获取缓存目录路径 */
  getCacheDir() {
    return this.#cacheDir;
  }
}
