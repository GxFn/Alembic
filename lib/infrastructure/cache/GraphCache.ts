/**
 * GraphCache — 基于文件的图数据持久化缓存
 *
 * 功能:
 * 1. 将图数据序列化为 JSON 写入磁盘
 * 2. 基于 contentHash 判断缓存是否有效（Package.swift / 源文件）
 * 3. 支持 SPM 依赖图和 AST ProjectGraph 两种场景
 *
 * 缓存位置: {projectRoot}/.autosnippet/cache/
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Logger from '../logging/Logger.js';

export class GraphCache {
  #cacheDir;
  #logger;

  /**
   * @param {string} projectRoot 项目根目录
   */
  constructor(projectRoot) {
    this.#cacheDir = join(projectRoot, '.autosnippet', 'cache');
    this.#logger = Logger.getInstance();
  }

  /**
   * 保存缓存
   * @param {string} key 缓存键名（生成 {key}.json）
   * @param {object} data 要缓存的数据
   * @param {object} meta 元信息（含 hash、timestamp 等）
   */
  save(key, data, meta: any = {}) {
    try {
      if (!existsSync(this.#cacheDir)) {
        mkdirSync(this.#cacheDir, { recursive: true });
      }
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        ...meta,
        data,
      };
      const filePath = join(this.#cacheDir, `${key}.json`);
      writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
      this.#logger.debug(`[GraphCache] saved: ${key} (${JSON.stringify(payload).length} bytes)`);
    } catch (err: any) {
      this.#logger.warn(`[GraphCache] save failed for ${key}: ${err.message}`);
    }
  }

  /**
   * 加载缓存
   * @param {string} key 缓存键名
   * @returns {{ data: object, [key: string]: any } | null}
   */
  load(key) {
    try {
      const filePath = join(this.#cacheDir, `${key}.json`);
      if (!existsSync(filePath)) {
        return null;
      }
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err: any) {
      this.#logger.warn(`[GraphCache] load failed for ${key}: ${err.message}`);
      return null;
    }
  }

  /**
   * 检查缓存是否有效（hash 匹配）
   * @param {string} key 缓存键
   * @param {string} currentHash 当前内容的 hash
   * @returns {boolean}
   */
  isValid(key, currentHash) {
    const cached = this.load(key);
    if (!cached) {
      return false;
    }
    return cached.contentHash === currentHash;
  }

  /**
   * 删除缓存
   * @param {string} key
   */
  invalidate(key) {
    try {
      const filePath = join(this.#cacheDir, `${key}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        this.#logger.debug(`[GraphCache] invalidated: ${key}`);
      }
    } catch (err: any) {
      this.#logger.warn(`[GraphCache] invalidate failed for ${key}: ${err.message}`);
    }
  }

  /**
   * 计算文件内容 hash
   * @param {string} filePath 文件绝对路径
   * @returns {string} sha256 hex (前 16 字符)
   */
  computeFileHash(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return this.computeContentHash(content);
    } catch {
      return '';
    }
  }

  /**
   * 计算字符串内容 hash
   * @param {string} content
   * @returns {string} sha256 hex (前 16 字符)
   */
  computeContentHash(content) {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * 批量计算文件 hash 映射
   * @param {string[]} filePaths 文件绝对路径数组
   * @param {string} projectRoot 项目根目录
   * @returns {Object<string, string>} { relativePath: hash }
   */
  computeFileHashes(filePaths, projectRoot) {
    const hashes = {};
    for (const fp of filePaths) {
      const rel = relative(projectRoot, fp);
      hashes[rel] = this.computeFileHash(fp);
    }
    return hashes;
  }

  /**
   * 获取缓存目录路径
   */
  getCacheDir() {
    return this.#cacheDir;
  }
}
