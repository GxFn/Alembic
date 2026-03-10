/**
 * AgentInstructionsGenerator — 通用 AI Agent 指令文件生成器
 *
 * Channel F: 为多种 AI 编码工具生成项目指令文件
 *   - AGENTS.md      → OpenAI Codex / 通用 Agent
 *   - CLAUDE.md       → Claude Code
 *   - .github/copilot-instructions.md → GitHub Copilot（动态版，替代静态模板）
 *
 * 设计原则：
 *   1. 内容来源统一 — 从 _loadEntries() 已加载的知识条目中提取
 *   2. 格式差异化 — 同一数据按目标工具特性适配输出
 *   3. 轻量索引 — 只输出摘要和规则，详细内容引导至 MCP 工具
 *   4. 幂等生成 — 每次 deliver 重写全部文件，不做增量 diff
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeEntryProps } from '../../domain/knowledge/KnowledgeEntry.js';
import { checkWriteSafety, safeWriteFile } from './FileProtection.js';
import { estimateTokens } from './TokenBudget.js';

/**
 * Agent 指令文件 token 预算
 * AGENTS.md / CLAUDE.md 不受 Cursor 200K 限制，但需控制体积以便 Agent 快速消化
 */
const AGENT_BUDGET = Object.freeze({
  MAX_RULES: 15,
  MAX_PATTERNS: 10,
  MAX_SKILLS: 10,
  MAX_TOTAL_TOKENS: 3000,
});

/** MCP 工具清单 — 精简版（跟随实际 MCP handler 注册名称） */
const MCP_TOOLS_SUMMARY = [
  {
    name: 'autosnippet_search',
    desc: 'Search knowledge base (mode: auto/context/keyword/semantic)',
  },
  {
    name: 'autosnippet_knowledge',
    desc: 'Knowledge CRUD (operation: list/get/insights/confirm_usage)',
  },
  {
    name: 'autosnippet_submit_knowledge',
    desc: 'Submit a knowledge candidate (strict validation)',
  },
  {
    name: 'autosnippet_submit_knowledge_batch',
    desc: 'Batch submit candidates (with dedup + throttle)',
  },
  { name: 'autosnippet_guard', desc: 'Code compliance check (single file or batch audit)' },
  { name: 'autosnippet_structure', desc: 'Project structure discovery (targets/files/metadata)' },
  { name: 'autosnippet_graph', desc: 'Knowledge graph query (query/impact/path/stats)' },
  { name: 'autosnippet_skill', desc: 'Skill management (list/load/create/update/delete/suggest)' },
  { name: 'autosnippet_save_document', desc: 'Save development document (auto-publish)' },
  { name: 'autosnippet_bootstrap', desc: 'Project cold-start & scan (knowledge/refine/scan)' },
  {
    name: 'autosnippet_task',
    desc: 'Unified task & decision management: prime (session entry, CALL FIRST) / create/claim/close/fail/defer/progress/decompose (task CRUD) / record_decision/revise_decision/unpin_decision/list_decisions (decisions)',
  },
  { name: 'autosnippet_health', desc: 'Service health & KB statistics' },
  { name: 'autosnippet_capabilities', desc: 'List all available MCP tools (self-discovery)' },
];

export class AgentInstructionsGenerator {
  logger: { info?: (...args: unknown[]) => void };
  projectName: string;
  projectRoot: string;
  constructor(
    projectRoot: string,
    projectName = 'Project',
    logger: { info?: (...args: unknown[]) => void } = console
  ) {
    this.projectRoot = projectRoot;
    this.projectName = projectName;
    this.logger = logger;
  }

  /**
   * 生成所有 Agent 指令文件
   *
   * @param params.rules kind='rule' 的条目（已排序）
   * @param params.patterns kind='pattern' 的条目（已排序）
   * @param params.skills 可用 Skill 名称列表
   * @returns }
   */
  generate({
    rules = [],
    patterns = [],
    skills = [],
  }: {
    rules?: KnowledgeEntryProps[];
    patterns?: KnowledgeEntryProps[];
    skills?: string[];
  } = {}) {
    const startTime = Date.now();

    // 构建共享内容块
    const sections = this._buildSections({ rules, patterns, skills });

    // 避免 IDE 上下文重复：
    //   - 不自动生成 CLAUDE.md（用户自己维护）
    //   - 如果项目已有 CLAUDE.md，跳过 AGENTS.md（避免两份文件同时注入 IDE 上下文）
    const claudePath = path.join(this.projectRoot, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudePath);

    const agents = hasClaudeMd
      ? { filePath: path.join(this.projectRoot, 'AGENTS.md'), tokensUsed: 0, skipped: true }
      : this._writeAgentsMd(sections);
    const claude = { filePath: claudePath, tokensUsed: 0, skipped: true }; // 不自动生成
    const copilot = this._writeCopilotInstructions(sections);

    const duration = Date.now() - startTime;
    const allResults = [agents, claude, copilot];
    const filesWritten = allResults.filter((r) => !r.skipped).length;
    const skippedFiles = allResults.filter((r) => r.skipped);
    if (skippedFiles.length > 0) {
      this.logger.info?.(
        `[AgentInstructions] Skipped ${skippedFiles.length} file(s) — ` +
          `user-owned files will not be overwritten: ${skippedFiles.map((f) => f.filePath).join(', ')}`
      );
    }
    this.logger.info?.(
      `[AgentInstructions] Generated ${filesWritten} files in ${duration}ms — ` +
        `AGENTS.md: ${agents.tokensUsed}t, CLAUDE.md: ${claude.tokensUsed}t, ` +
        `copilot-instructions: ${copilot.tokensUsed}t`
    );

    return {
      agents,
      claude,
      copilot,
      stats: {
        filesWritten,
        filesSkipped: skippedFiles.length,
        totalTokens: agents.tokensUsed + claude.tokensUsed + copilot.tokensUsed,
        duration,
      },
    };
  }

  // ─── 内容构建 ──────────────────────────────────────

  /**
   * 从知识条目构建共享内容段
   */
  _buildSections({
    rules,
    patterns,
    skills,
  }: {
    rules: KnowledgeEntryProps[];
    patterns: KnowledgeEntryProps[];
    skills: string[];
  }) {
    // 编码规则（Channel A 格式，一行一条）
    const ruleLines = rules
      .slice(0, AGENT_BUDGET.MAX_RULES)
      .filter((e: KnowledgeEntryProps) => e.doClause)
      .map((e: KnowledgeEntryProps) => {
        const langPrefix = e.language && e.scope !== 'universal' ? `[${e.language}] ` : '';
        const doText = e.doClause!.replace(/\.+$/, '');
        let line = `${langPrefix}${doText}`;
        if (e.dontClause) {
          // 有明确否定词的统一为 "Do NOT"，否则保留原文（如 "Avoid ..."）
          const hasNegPrefix = /^(Don't|Do not|Never)\s+/i.test(e.dontClause);
          if (hasNegPrefix) {
            const stripped = e.dontClause
              .replace(/^(Don't|Do not|Never)\s+/i, '')
              .replace(/\.+$/, '');
            line += `. Do NOT ${stripped}`;
          } else {
            line += `. ${e.dontClause.replace(/\.+$/, '')}`;
          }
        }
        return `- ${line}.`;
      });

    // 架构模式（摘要表格行）
    const patternRows = patterns
      .slice(0, AGENT_BUDGET.MAX_PATTERNS)
      .filter((e: KnowledgeEntryProps) => e.trigger && e.doClause)
      .map((e: KnowledgeEntryProps) => {
        const trigger = e.trigger!.startsWith('@') ? e.trigger! : `@${e.trigger}`;
        const when = (e.whenClause || '').substring(0, 60);
        const doText = (e.doClause || '').substring(0, 80);
        return `| ${trigger} | ${when} | ${doText} |`;
      });

    // Skills 列表
    const skillLines = skills.slice(0, AGENT_BUDGET.MAX_SKILLS).map((s: string) => `- \`${s}\``);

    // MCP 工具列表
    const toolLines = MCP_TOOLS_SUMMARY.map((t) => `- \`${t.name}\` — ${t.desc}`);

    return { ruleLines, patternRows, skillLines, toolLines };
  }

  // ─── AGENTS.md ─────────────────────────────────────

  _writeAgentsMd(sections: {
    ruleLines: string[];
    patternRows: string[];
    skillLines: string[];
    toolLines: string[];
  }) {
    const lines = [
      `# ${this.projectName} — Agent Instructions`,
      '',
      '> Auto-generated by [AutoSnippet](https://github.com/anthropic/autosnippet). Do not edit manually.',
      '> This file is regenerated when the knowledge base changes.',
      '',
      '## Project Knowledge Base',
      '',
      `This project uses **AutoSnippet** as its knowledge management system.`,
      `The knowledge base contains coding standards, architecture patterns, and best practices`,
      `accessible through MCP tools.`,
      '',
      ...this._renderConstraints(),
      '',
    ];

    // Coding Standards
    if (sections.ruleLines.length > 0) {
      lines.push('## Coding Standards', '');
      lines.push(...sections.ruleLines);
      lines.push('');
    }

    // Architecture Patterns
    if (sections.patternRows.length > 0) {
      lines.push('## Architecture Patterns', '');
      lines.push('| Trigger | When | Do |');
      lines.push('|---------|------|----|');
      lines.push(...sections.patternRows);
      lines.push('');
    }

    // MCP Tools
    lines.push('## MCP Tools (AutoSnippet)', '');
    lines.push('Use these MCP tools to access the full knowledge base:', '');
    lines.push(...sections.toolLines);
    lines.push('');

    // Skills
    if (sections.skillLines.length > 0) {
      lines.push('## Available Skills', '');
      lines.push('Load with `autosnippet_skill({ operation: "load", name: "<skill>" })`:', '');
      lines.push(...sections.skillLines);
      lines.push('');
    }

    // Workflow
    lines.push(...this._renderWorkflow());

    const content = `${lines.join('\n')}\n`;
    const filePath = path.join(this.projectRoot, 'AGENTS.md');
    const result = safeWriteFile(filePath, content, { logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(content), skipped: !result.written };
  }

  // ─── CLAUDE.md ─────────────────────────────────────

  _writeClaudeMd(sections: {
    ruleLines: string[];
    patternRows: string[];
    skillLines: string[];
    toolLines: string[];
  }) {
    const lines = [
      `# ${this.projectName} — Claude Code Instructions`,
      '',
      '> Auto-generated by AutoSnippet. Regenerated when knowledge base changes.',
      '',
    ];

    // Constraints (Claude prefers clear bullet points)
    lines.push(...this._renderConstraints());
    lines.push('');

    // Coding Standards
    if (sections.ruleLines.length > 0) {
      lines.push('## Coding Standards', '');
      lines.push('These are mandatory project rules extracted from the knowledge base:', '');
      lines.push(...sections.ruleLines);
      lines.push('');
    }

    // Patterns (Claude benefits from When/Do format)
    if (sections.patternRows.length > 0) {
      lines.push('## Key Patterns', '');
      lines.push('| Trigger | When | Do |');
      lines.push('|---------|------|----|');
      lines.push(...sections.patternRows);
      lines.push('');
    }

    // MCP — Claude Code natively supports MCP
    lines.push('## MCP Integration', '');
    lines.push(
      'This project has an AutoSnippet MCP server configured. ',
      'Use the following tools to access project knowledge:',
      ''
    );
    lines.push(...sections.toolLines);
    lines.push('');

    // Key tools highlight for Claude
    lines.push('### Task Workflow', '');
    lines.push(
      '1. **Every message → `autosnippet_task({ operation: "prime" })`** — Load decisions + tasks + knowledge context (ALWAYS FIRST)'
    );
    lines.push(
      '2. **Create task for non-trivial work** — ≥2 files OR ≥10 lines → `create` → `claim` → code → `close`'
    );
    lines.push(
      '3. **User agrees/disagrees → `autosnippet_task({ operation: "record_decision" })`** — Persist decision immediately'
    );
    lines.push(
      '4. **Before writing code**: `autosnippet_search({ query: "<topic>" })` to find relevant patterns'
    );
    lines.push(
      '5. **Complete task**: `autosnippet_task({ operation: "close", id: "<id>", reason: "..." })`'
    );
    lines.push(
      '6. **Session end**: Close or defer ALL in_progress tasks — zero in_progress on exit'
    );
    lines.push('');

    // Skills
    if (sections.skillLines.length > 0) {
      lines.push('## Skills', '');
      lines.push(...sections.skillLines);
      lines.push('');
    }

    const content = `${lines.join('\n')}\n`;
    const filePath = path.join(this.projectRoot, 'CLAUDE.md');
    const result = safeWriteFile(filePath, content, { logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(content), skipped: !result.written };
  }

  // ─── copilot-instructions.md ───────────────────────

  /**
   * 动态生成 copilot-instructions.md
   * 替代原有的静态模板复制
   */
  _writeCopilotInstructions(sections: {
    ruleLines: string[];
    patternRows: string[];
    skillLines: string[];
    toolLines: string[];
  }) {
    const lines = [
      '# AutoSnippet Copilot Instructions',
      '',
      '## Project Overview',
      `- Project: **${this.projectName}**`,
      '- Knowledge System: AutoSnippet V3 (ESM, SQLite, MCP)',
      '- Knowledge Base: `AutoSnippet/` directory (recipes, skills, constitution)',
      '',
      ...this._renderConstraints(),
      '',
    ];

    // Coding Standards
    if (sections.ruleLines.length > 0) {
      lines.push('## Coding Standards', '');
      lines.push(...sections.ruleLines);
      lines.push('');
    }

    // MCP Tools (compact for Copilot)
    lines.push('## MCP Tools', '');
    lines.push('Access the knowledge base through MCP:', '');
    // Copilot: show fewer, most essential tools
    const essentialTools = [
      '- `autosnippet_search` — Search knowledge (mode: auto/context/keyword/semantic)',
      '- `autosnippet_knowledge` — Browse/get recipes (operation: list/get/insights)',
      '- `autosnippet_submit_knowledge` — Submit candidate (strict validation, all fields required)',
      '- `autosnippet_guard` — Code compliance check',
      '- `autosnippet_skill` — Load project skills (list/load)',
      '- `autosnippet_health` — Service health & KB stats',
    ];
    lines.push(...essentialTools);
    lines.push('');

    // Knowledge Types
    lines.push('## Knowledge Types', '');
    lines.push('- **rule** — Coding standards, enforced by Guard');
    lines.push('- **pattern** — Reusable code patterns and architecture');
    lines.push('- **fact** — Structural knowledge (relations, data flow)');
    lines.push('');

    // Workflow
    lines.push(...this._renderWorkflow());

    const content = `${lines.join('\n')}\n`;
    const destDir = path.join(this.projectRoot, '.github');
    const filePath = path.join(destDir, 'copilot-instructions.md');
    const { canWrite } = checkWriteSafety(filePath);
    if (canWrite) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const result = safeWriteFile(filePath, content, { logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(content), skipped: !result.written };
  }

  // ─── 共享模板片段 ──────────────────────────────────

  /**
   * 核心约束（所有 Agent 共享）
   */
  _renderConstraints() {
    return [
      "## CRITICAL: You Operate autosnippet_task — The User Doesn't",
      '',
      'You are the task operator. Users speak naturally; you translate to task operations.',
      "DO NOT tell users to call autosnippet_task. That's YOUR job.",
      '',
      '- WRONG: "You can run autosnippet_task({ operation: \'create\' }) to create a task"',
      '- RIGHT: *(you run create yourself and tell the user "Created task asd-42: Fix login bug")*',
      '',
      '## Task Tracking Rules (MANDATORY)',
      '',
      '1. **MUST prime on EVERY message** — `autosnippet_task({ operation: "prime" })` BEFORE anything else. No exceptions.',
      '2. **MUST create task for non-trivial work** — ≥2 files OR ≥10 lines → create BEFORE starting.',
      '3. **MUST claim before coding** — `autosnippet_task({ operation: "claim", id })` then code.',
      '4. **MUST close when done** — `autosnippet_task({ operation: "close", id, reason })` with meaningful reason.',
      '5. **MUST handle unfinished tasks first** — If prime shows in-progress, ask user: Continue, Defer, Abandon? Do NOT auto-resume.',
      '6. **NEVER skip prime** — Even for follow-up messages.',
      '7. **NEVER start new work with open in-progress tasks** — Handle existing first.',
      '8. **NEVER leave tasks in in_progress when session ends** — Close or defer everything.',
      '9. **NEVER tell the user to run task commands** — You are the operator.',
      '',
      'When in doubt → create a task. When idle → `autosnippet_task({ operation: "ready" })`.',
      '',
      '**When NOT to create**: Quick questions, single-file trivial fixes (<10 lines), code explanation, running tests.',
      '',
      '## Knowledge Rules',
      '',
      '1. **User agrees/disagrees with a plan → `autosnippet_task({ operation: "record_decision" })` immediately** — Persist team memory first.',
      '2. **Do NOT modify** knowledge base files directly (`AutoSnippet/recipes/`, `.autosnippet/`).',
      '3. **Prefer Recipes** as project standards; source code is supplementary.',
      '4. Use `autosnippet_search` for knowledge retrieval; do not retry on failure in the same turn.',
      '5. Skills handle semantics and workflow; MCP handles capabilities — do not hardcode URLs in Skills.',
    ];
  }

  /**
   * 推荐工作流（AGENTS.md 用）
   */
  _renderWorkflow() {
    return [
      '## User Says → You Run',
      '',
      '| User Says | Your Action |',
      '|---|---|',
      '| "Fix this bug" / "帮我修 bug" | `create` → `claim` → code → `close` |',
      '| "Implement this" / "做功能" | `create` → `claim` → code → `close` |',
      '| "Continue" / "继续" | resume in-progress → code → `close` |',
      '| "Pause" / "先不做了" | `defer(id, reason)` |',
      '| "Abandon" / "不做了" | `fail(id, reason)` |',
      '| "Break it down" / "太大了" | `decompose(id, subtasks)` |',
      '| "What\'s next" / "有什么要做的" | `ready()` → present list |',
      '| "Agreed" / "就这么定了" | `record_decision(...)` |',
      '| Quick question (no code) | No task. Just answer. |',
      '',
      '## Session Closing Protocol',
      '',
      'Before ending work, you MUST complete this checklist:',
      '',
      '- [ ] Close every claimed task with reason describing what was accomplished',
      '- [ ] Defer any incomplete tasks with notes on why and what remains',
      '- [ ] Verify zero tasks in in_progress state',
      '- [ ] If prime showed ready tasks, mention them to the user for next session',
      '',
      '**Work is not done until all tasks are closed or deferred.**',
      '',
      '## Context Pressure',
      '',
      '- `_contextHint: CONTEXT_PRESSURE:WARNING` → Summarize completed work, then continue',
      '- `_contextHint: CONTEXT_PRESSURE:CRITICAL` → Call `autosnippet_task({ operation: "prime" })` immediately',
      '',
    ];
  }
}

export default AgentInstructionsGenerator;
