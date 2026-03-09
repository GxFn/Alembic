/**
 * ConversationStore — 对话持久化 + 上下文窗口管理
 *
 * 设计:
 * - 每个对话一个 JSONL 文件: .autosnippet/conversations/{id}.jsonl
 * - 索引文件: .autosnippet/conversations/index.json
 * - 按 category 隔离: 'user'(Dashboard) / 'system'(SignalCollector)
 * - Token 预算: 超限时自动生成摘要压缩旧轮次
 * - 静默降级: 持久化失败不影响核心功能
 *
 * Token 计算策略:
 *   采用字符数近似估算 (1 token ≈ 3.5 字符中文 / ≈ 4 字符英文)
 *   简单高效，无需额外依赖
 *
 * 文件结构:
 *   .autosnippet/conversations/
 *     index.json   — 对话元数据索引
 *     {id}.jsonl   — 每行一条消息 {role, content, ts}
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import pathGuard from '#shared/PathGuard.js';
import { estimateTokens as _estimateTokens } from '#shared/token-utils.js';

/** 对话索引中的条目 */
interface ConversationEntry {
  id: string;
  category: 'user' | 'system' | 'lark';
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  hasSummary: boolean;
}

/** 单条对话消息 */
interface ConversationMessage {
  role: string;
  content: string;
}

/** AI Provider 最小接口（用于 summarize） */
interface AiProvider {
  chat(prompt: string, opts?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

const DEFAULT_TOKEN_BUDGET = 12000; // ~12K tokens 留给历史, 其余给系统提示词和当前消息
const MAX_CONVERSATIONS = 100; // 索引最多保留 100 个对话
const _SUMMARY_TARGET_TOKENS = 500; // 压缩后的摘要目标 token 数

export class ConversationStore {
  #dir;
  #indexPath;
  #logger;

  /** @param projectRoot 用户项目根目录 */
  constructor(projectRoot: string) {
    this.#dir = path.join(projectRoot, '.autosnippet', 'conversations');
    this.#indexPath = path.join(this.#dir, 'index.json');
    this.#logger = Logger.getInstance();
    // 路径安全检查
    pathGuard.assertProjectWriteSafe(this.#dir);
  }

  // ═══════════════════════════════════════════════════════
  //  公共 API
  // ═══════════════════════════════════════════════════════

  /**
   * 创建新对话
   * @param opts.category 对话类别
   * @param [opts.title] 对话标题
   * @returns conversationId
   */
  create({ category = 'user', title = '' } = {}) {
    const id = crypto.randomUUID();
    const entry = {
      id,
      category,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      hasSummary: false,
    };

    const index = this.#loadIndex();
    index.unshift(entry);

    // 限制索引大小
    if (index.length > MAX_CONVERSATIONS) {
      const removed = index.splice(MAX_CONVERSATIONS);
      // 清理旧对话文件
      for (const old of removed) {
        this.#deleteConversationFile(old.id);
      }
    }

    this.#saveIndex(index);
    return id;
  }

  /**
   * 追加消息到对话
   * @param {{ role: string, content: string }} message
   */
  append(conversationId: string, message: ConversationMessage) {
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      const filePath = this.#conversationPath(conversationId);
      const line = JSON.stringify({
        role: message.role,
        content: message.content,
        ts: new Date().toISOString(),
      });
      fs.appendFileSync(filePath, `${line}\n`, 'utf-8');

      // 更新索引
      const index = this.#loadIndex();
      const entry = index.find((e: ConversationEntry) => e.id === conversationId);
      if (entry) {
        entry.updatedAt = new Date().toISOString();
        entry.messageCount = (entry.messageCount || 0) + 1;
        // 用首条用户消息作为标题
        if (!entry.title && message.role === 'user') {
          entry.title = message.content.substring(0, 60);
        }
        this.#saveIndex(index);
      }
    } catch (err: unknown) {
      this.#logger.warn(`[ConversationStore] append failed: ${(err as Error).message}`);
    }
  }

  /**
   * 加载对话历史（带 token 预算控制）
   *
   * 如果历史超出 tokenBudget:
   *   - 保留开头的摘要（如有）
   *   - 截断中间的旧消息
   *   - 保留最新的消息
   *
   * @param [opts.tokenBudget] token 预算
   * @returns []}
   */
  load(conversationId: string, { tokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
    try {
      const filePath = this.#conversationPath(conversationId);
      if (!fs.existsSync(filePath)) {
        return [];
      }

      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return [];
      }

      const messages = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            const parsed = JSON.parse(line);
            return { role: parsed.role, content: parsed.content } as ConversationMessage;
          } catch {
            return null;
          }
        })
        .filter((m): m is ConversationMessage => m !== null);

      return this.#fitWithinBudget(messages, tokenBudget);
    } catch {
      return [];
    }
  }

  /**
   * 对话列表
   * @param [opts.category] 按类别过滤
   */
  list({ category, limit = 20 }: { category?: 'user' | 'system' | 'lark'; limit?: number } = {}) {
    const index = this.#loadIndex();
    let results = index;
    if (category) {
      results = results.filter((e: ConversationEntry) => e.category === category);
    }
    return results.slice(0, limit);
  }

  /** 删除对话 */
  delete(conversationId: string) {
    this.#deleteConversationFile(conversationId);
    const index = this.#loadIndex();
    const filtered = index.filter((e: ConversationEntry) => e.id !== conversationId);
    this.#saveIndex(filtered);
  }

  /**
   * 为对话生成压缩摘要（需要 AI）
   * 将旧消息替换为一条 system 摘要消息
   *
   * @param opts.aiProvider AI Provider 实例
   * @returns 是否成功压缩
   */
  async summarize(conversationId: string, { aiProvider }: { aiProvider: AiProvider }) {
    if (!aiProvider) {
      return false;
    }

    try {
      const filePath = this.#conversationPath(conversationId);
      if (!fs.existsSync(filePath)) {
        return false;
      }

      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return false;
      }

      const messages = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (messages.length < 6) {
        return false; // 太短不需要压缩
      }

      // 保留最近 4 条消息，压缩其余
      const toSummarize = messages.slice(0, -4);
      const toKeep = messages.slice(-4);

      const summaryPrompt = `请用 2-3 句话总结以下对话的要点（保留关键决策、用户偏好、操作结果）：\n\n${toSummarize
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n')
        .substring(0, 4000)}`;

      const summary = await aiProvider.chat(summaryPrompt, {
        temperature: 0.3,
        maxTokens: 300,
      });

      if (!summary) {
        return false;
      }

      // 重写对话文件: 摘要 + 最近消息
      const newMessages = [
        { role: 'system', content: `[对话摘要] ${summary.trim()}`, ts: new Date().toISOString() },
        ...toKeep,
      ];

      fs.writeFileSync(
        filePath,
        `${newMessages.map((m) => JSON.stringify(m)).join('\n')}\n`,
        'utf-8'
      );

      // 更新索引
      const index = this.#loadIndex();
      const entry = index.find((e: ConversationEntry) => e.id === conversationId);
      if (entry) {
        entry.hasSummary = true;
        entry.messageCount = newMessages.length;
        this.#saveIndex(index);
      }

      this.#logger.info(
        `[ConversationStore] summarized conversation ${conversationId}: ${messages.length} → ${newMessages.length} messages`
      );
      return true;
    } catch (err: unknown) {
      this.#logger.warn(`[ConversationStore] summarize failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 清理过期对话
   * @param [opts.maxAgeDays=30] 超过此天数的对话将被删除
   * @param [opts.category] 只清理特定类别
   * @returns }
   */
  cleanup({
    maxAgeDays = 30,
    category,
  }: {
    maxAgeDays?: number;
    category?: 'user' | 'system' | 'lark';
  } = {}) {
    const index = this.#loadIndex();
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let deleted = 0;

    const kept = index.filter((entry: ConversationEntry) => {
      if (category && entry.category !== category) {
        return true;
      }
      const updatedAt = new Date(entry.updatedAt).getTime();
      if (updatedAt < cutoff) {
        this.#deleteConversationFile(entry.id);
        deleted++;
        return false;
      }
      return true;
    });

    if (deleted > 0) {
      this.#saveIndex(kept);
      this.#logger.info(`[ConversationStore] cleaned up ${deleted} old conversations`);
    }

    return { deleted };
  }

  /** 估算 token 数 — 委托给共享 token-utils（CJK 感知） */
  estimateTokens(text: string) {
    return _estimateTokens(text);
  }

  // ═══════════════════════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════════════════════

  /**
   * 将消息列表裁剪到 token 预算内
   * 策略: 保留首条摘要(如有) + 最新消息，丢弃中间旧消息
   */
  #fitWithinBudget(messages: ConversationMessage[], tokenBudget: number) {
    if (messages.length === 0) {
      return [];
    }

    // 计算总 token
    let totalTokens = 0;
    const tokenCounts = messages.map((m: ConversationMessage) => {
      const tokens = this.estimateTokens(m.content);
      totalTokens += tokens;
      return tokens;
    });

    if (totalTokens <= tokenBudget) {
      return messages;
    }

    // 超预算 — 保留首条(摘要) + 从末尾往前取
    const result: ConversationMessage[] = [];
    let used = 0;

    // 如果首条是 system 摘要，优先保留
    if (messages[0].role === 'system' && messages[0].content.startsWith('[对话摘要]')) {
      result.push(messages[0]);
      used += tokenCounts[0];
    }

    // 从末尾往前填充
    const tail: ConversationMessage[] = [];
    for (let i = messages.length - 1; i >= (result.length > 0 ? 1 : 0); i--) {
      if (used + tokenCounts[i] > tokenBudget) {
        break;
      }
      tail.unshift(messages[i]);
      used += tokenCounts[i];
    }

    // 如果丢弃了消息，插入提示
    const keptFromStart = result.length;
    const keptFromEnd = tail.length;
    const dropped = messages.length - keptFromStart - keptFromEnd;

    if (dropped > 0) {
      result.push({
        role: 'system',
        content: `[上下文截断] 省略了 ${dropped} 条较早的消息以适应上下文窗口。`,
      });
    }

    result.push(...tail);
    return result;
  }

  #conversationPath(id: string) {
    return path.join(this.#dir, `${id}.jsonl`);
  }

  #deleteConversationFile(id: string) {
    try {
      const filePath = this.#conversationPath(id);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      /* ignore */
    }
  }

  #loadIndex() {
    try {
      if (fs.existsSync(this.#indexPath)) {
        return JSON.parse(fs.readFileSync(this.#indexPath, 'utf-8'));
      }
    } catch {
      /* corrupt — reset */
    }
    return [];
  }

  #saveIndex(index: ConversationEntry[]) {
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      fs.writeFileSync(this.#indexPath, JSON.stringify(index, null, 2), 'utf-8');
    } catch (err: unknown) {
      this.#logger.warn(`[ConversationStore] index save failed: ${(err as Error).message}`);
    }
  }
}

export default ConversationStore;
