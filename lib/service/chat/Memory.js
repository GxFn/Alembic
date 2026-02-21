/**
 * Memory — 跨对话轻量记忆（带 source 隔离 + 去重）
 *
 * 设计:
 * - JSONL 文件存储，每行一条记忆
 * - 支持 TTL 自动过期
 * - 上限 maxEntries，超出时截断旧条目
 * - 读写均做静默降级（Memory 是增强，不是核心路径）
 * - source 标签: 'user'(用户对话) / 'system'(SignalCollector 等后台)
 * - 去重: 相同 type+content 的记忆不重复写入
 *
 * 记忆类型:
 * - preference: 用户偏好（"我们不用 singleton"、"以后用 DI"）
 * - decision:   关键决策（"Network 模块审核通过"）
 * - context:    项目上下文（"主语言是 Swift，使用 SPM"）
 *
 * 隔离规则:
 *   toPromptSection({ source }) 可按 source 过滤
 *   用户对话只看 source=user 的记忆
 *   系统分析可看全部记忆
 *
 * 文件路径: .autosnippet/memory.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import pathGuard from '../../shared/PathGuard.js';

export class Memory {
  #filePath;
  #maxEntries;

  /**
   * @param {string} projectRoot — 用户项目根目录
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=50] — 最大记忆条数
   */
  constructor(projectRoot, { maxEntries = 50 } = {}) {
    this.#filePath = path.join(projectRoot, '.autosnippet', 'memory.jsonl');
    this.#maxEntries = maxEntries;
    // 路径安全检查
    pathGuard.assertProjectWriteSafe(this.#filePath);
  }

  /**
   * 读取最近 N 条记忆，过滤过期项
   * @param {number} [limit=20]
   * @param {object} [opts]
   * @param {'user'|'system'} [opts.source] — 按 source 过滤
   * @returns {{ ts: string, type: string, content: string, source?: string, ttl?: number }[]}
   */
  load(limit = 20, { source } = {}) {
    try {
      if (!fs.existsSync(this.#filePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.#filePath, 'utf-8').trim();
      if (!raw) {
        return [];
      }
      const lines = raw.split('\n').filter(Boolean);
      const now = Date.now();
      return lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((m) => !m.ttl || now - new Date(m.ts).getTime() < m.ttl * 86400000)
        .filter((m) => !source || (m.source || 'user') === source)
        .slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * 追加一条记忆（自动去重）
   * @param {{ type: string, content: string, source?: string, ttl?: number }} entry
   */
  append(entry) {
    try {
      // 去重: 检查是否已有相同 type+content 的记忆
      const existing = this.load(this.#maxEntries);
      const normalizedContent = (entry.content || '').trim().substring(0, 200);
      const isDuplicate = existing.some(
        (m) => m.type === entry.type && m.content === normalizedContent
      );
      if (isDuplicate) {
        return;
      }

      const dir = path.dirname(this.#filePath);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        source: entry.source || 'user',
        ...entry,
        content: normalizedContent,
      });
      fs.appendFileSync(this.#filePath, `${line}\n`, 'utf-8');
      this.#compact();
    } catch {
      /* write failure non-critical */
    }
  }

  /**
   * 生成供系统提示词的记忆摘要
   *
   * @param {object} [opts]
   * @param {'user'|'system'} [opts.source] — 只包含指定 source 的记忆
   *   - 用户对话建议传 'user' 避免系统分析记忆污染
   *   - 后台分析可传 undefined 获取全部
   * @returns {string}
   */
  toPromptSection({ source } = {}) {
    const memories = this.load(20, { source });
    if (memories.length === 0) {
      return '';
    }
    const lines = memories.map((m) => `- [${m.type}] ${m.content}`).join('\n');
    return `\n## 历史记忆\n以下是之前对话中积累的项目偏好和决策，请参考：\n${lines}\n`;
  }

  /**
   * 当前记忆条数
   * @param {object} [opts]
   * @param {'user'|'system'} [opts.source]
   */
  size({ source } = {}) {
    return this.load(this.#maxEntries, { source }).length;
  }

  /**
   * 超过 maxEntries 时截断旧条目
   */
  #compact() {
    try {
      const raw = fs.readFileSync(this.#filePath, 'utf-8').trim();
      if (!raw) {
        return;
      }
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > this.#maxEntries) {
        fs.writeFileSync(this.#filePath, `${lines.slice(-this.#maxEntries).join('\n')}\n`, 'utf-8');
      }
    } catch {
      /* ignore */
    }
  }
}

export default Memory;
