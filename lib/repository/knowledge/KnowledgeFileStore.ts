/**
 * KnowledgeFileStore — .md 文件操作接口
 *
 * 从 KnowledgeFileWriter 类提炼的接口，使文件操作可被 mock 测试。
 * 实现类: KnowledgeFileWriter (lib/service/knowledge/KnowledgeFileWriter.ts)
 *
 * 设计原则:
 *   - .md 文件 = 唯一真相源 (Source of Truth)
 *   - DB = 索引缓存
 *   - 所有写操作必须经过此接口落盘为 .md 文件
 */

import type { KnowledgeEntry } from '../../domain/knowledge/KnowledgeEntry.js';

/**
 * KnowledgeFileStore — .md 文件写操作接口
 */
export interface KnowledgeFileStore {
  /** 序列化 entry 为 YAML frontmatter + Markdown body */
  serialize(entry: KnowledgeEntry): string;

  /** 写入 .md 文件到 candidates/ 或 recipes/（基于 lifecycle），返回文件路径 */
  persist(entry: KnowledgeEntry): string | null;

  /** 删除 .md 文件，成功返回 true */
  remove(entry: KnowledgeEntry): boolean;

  /** 生命周期变更时在 candidates/ ↔ recipes/ 间移动文件，返回新路径 */
  moveOnLifecycleChange(entry: KnowledgeEntry): string | null;
}

/**
 * KnowledgeFileScanner — .md 文件扫描接口（从 KnowledgeSyncService 提炼）
 *
 * 扫描逻辑当前在 KnowledgeSyncService._collectMdFiles()，
 * 解析逻辑是模块级 parseKnowledgeMarkdown() 函数。
 */
export interface KnowledgeFileScanner {
  /** 扫描 candidates/ + recipes/ 下所有 .md 文件路径 */
  scanAll(): string[];

  /** 解析单个 .md 文件内容为字段对象 */
  parse(content: string, relPath?: string): Record<string, unknown>;

  /** 计算内容哈希（用于检测手工编辑） */
  computeHash(content: string): string;
}
