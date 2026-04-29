/**
 * content-hash — 统一 SHA256-hex16 内容哈希
 *
 * 项目中多处使用完全相同的 SHA256 前 16 字符 hex 哈希算法，
 * 统一提取为公共函数，消除重复实现。
 *
 * 消费者：
 *   - FileDiffSnapshotStore: 文件快照 diff
 *   - GraphCache: SPM/AST 图缓存
 *   - IndexingPipeline: 向量索引去重
 *   - KnowledgeFileWriter: Recipe 内容完整性
 *
 * @module shared/content-hash
 */

import { createHash } from 'node:crypto';

/**
 * 计算内容的 SHA256 哈希值（前 16 个十六进制字符）。
 *
 * @param content 要哈希的文本内容
 * @returns 16 字符的 hex 字符串
 */
export function computeContentHash(content: string): string {
  return createHash('sha256')
    .update(content || '')
    .digest('hex')
    .substring(0, 16);
}
