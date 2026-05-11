import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '#shared/package-root.js';
import { Capability } from './Capability.js';

interface ContextInput {
  projectBriefing?: string | null;
  memoryMode?: string;
  [key: string]: unknown;
}

interface StepResult {
  toolCalls?: Array<{ tool: string; args: unknown; result: unknown }>;
  [key: string]: unknown;
}

interface MemoryCoordinator {
  buildPromptInjection(mode: string): string | null;
  cacheToolResult?(tool: string, args: unknown, result: unknown): void;
}

interface ConversationOpts {
  memoryCoordinator?: MemoryCoordinator | null;
  soulPath?: string;
  projectBriefing?: string | null;
}

export class Conversation extends Capability {
  #memoryCoordinator;
  #soulContent;
  #projectBriefing;

  constructor(opts: ConversationOpts = {}) {
    super();
    this.#memoryCoordinator = opts.memoryCoordinator || null;
    this.#projectBriefing = opts.projectBriefing || null;

    const soulPath = opts.soulPath || path.resolve(PACKAGE_ROOT, 'SOUL.md');
    try {
      this.#soulContent = fs.existsSync(soulPath)
        ? fs.readFileSync(soulPath, 'utf-8').trim()
        : null;
    } catch {
      this.#soulContent = null;
    }
  }

  get name() {
    return 'conversation';
  }

  get promptFragment() {
    return `## 对话能力
你是 Alembic 知识管理助手。

行为规则:
1. 回答问题时优先从知识库搜索相关知识
2. 用户要求编辑/创建知识时，通过工具完成
3. 每轮至少调用一个工具获取信息（除非纯闲聊）
4. 保持对话连贯性，引用之前的上下文`;
  }

  get tools() {
    return ['knowledge', 'code', 'graph', 'meta'];
  }

  buildContext(context: ContextInput) {
    const parts: string[] = [];

    if (this.#soulContent) {
      parts.push(this.#soulContent);
    }

    const briefing = context.projectBriefing || this.#projectBriefing;
    if (briefing) {
      parts.push(`## 项目概况\n${briefing}`);
    }

    if (this.#memoryCoordinator) {
      try {
        const memoryContext = this.#memoryCoordinator.buildPromptInjection(
          context.memoryMode || 'user'
        );
        if (memoryContext) {
          parts.push(`## 记忆上下文\n${memoryContext}`);
        }
      } catch {
        /* non-critical */
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  onAfterStep(stepResult: StepResult) {
    if (this.#memoryCoordinator && stepResult.toolCalls?.length) {
      try {
        for (const tc of stepResult.toolCalls) {
          this.#memoryCoordinator.cacheToolResult?.(tc.tool, tc.args, tc.result);
        }
      } catch {
        /* non-critical */
      }
    }
  }
}
