/**
 * 对话 — 用户与 Alembic 知识助手的交互。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '#shared/package-root.js';
import { CapabilityV2 } from './CapabilityV2.js';

interface ConversationOpts {
  memoryCoordinator?: MemoryCoordinator | null;
  soulPath?: string;
  projectBriefing?: string | null;
  [key: string]: unknown;
}

interface MemoryCoordinator {
  buildPromptInjection(mode: string): string | null;
  cacheToolResult?(tool: string, args: unknown, result: unknown): void;
}

interface ContextInput {
  projectBriefing?: string | null;
  memoryMode?: string;
  [key: string]: unknown;
}

interface StepResult {
  toolCalls?: Array<{ tool: string; args: unknown; result: unknown }>;
  [key: string]: unknown;
}

export class ConversationV2 extends CapabilityV2 {
  #memoryCoordinator: MemoryCoordinator | null;
  #soulContent: string | null;
  #projectBriefing: string | null;

  constructor(opts: ConversationOpts = {}) {
    super();
    this.#memoryCoordinator = (opts.memoryCoordinator as MemoryCoordinator) || null;
    this.#projectBriefing = (opts.projectBriefing as string) || null;

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
  get description() {
    return 'User conversation with knowledge assistant';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline', 'structure'],
      knowledge: ['search', 'detail', 'submit'],
      graph: ['overview', 'query'],
      memory: ['save', 'recall'],
      meta: ['tools'],
    };
  }

  buildContext(context: ContextInput) {
    const parts: string[] = [];

    if (this.#soulContent) {
      parts.push(this.#soulContent);
    }

    const briefing = (context.projectBriefing as string) || this.#projectBriefing;
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
