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

/**
 * MCP 工具清单 — 精简版（跟随实际 MCP handler 注册名称）
 */
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
  { name: 'autosnippet_ready', desc: 'Session entry point — loads decisions + ready tasks (call FIRST)' },
  { name: 'autosnippet_decide', desc: 'Decision management (record/revise/unpin/list)' },
  { name: 'autosnippet_task', desc: 'Task CRUD (create/claim/close/fail/defer/progress/decompose)' },
  { name: 'autosnippet_health', desc: 'Service health & KB statistics' },
  { name: 'autosnippet_capabilities', desc: 'List all available MCP tools (self-discovery)' },
];

export class AgentInstructionsGenerator {
  /**
   * @param {string} projectRoot
   * @param {string} projectName
   * @param {Object} [logger]
   */
  constructor(projectRoot, projectName = 'Project', logger = console) {
    this.projectRoot = projectRoot;
    this.projectName = projectName;
    this.logger = logger;
  }

  /**
   * 生成所有 Agent 指令文件
   *
   * @param {Object} params
   * @param {Array<Object>} params.rules - kind='rule' 的条目（已排序）
   * @param {Array<Object>} params.patterns - kind='pattern' 的条目（已排序）
   * @param {string[]} params.skills - 可用 Skill 名称列表
   * @returns {{ agents: Object, claude: Object, copilot: Object }}
   */
  generate({ rules = [], patterns = [], skills = [] }) {
    const startTime = Date.now();

    // 构建共享内容块
    const sections = this._buildSections({ rules, patterns, skills });

    // 生成 3 个目标文件
    const agents = this._writeAgentsMd(sections);
    const claude = this._writeClaudeMd(sections);
    const copilot = this._writeCopilotInstructions(sections);

    const duration = Date.now() - startTime;
    const filesWritten = [agents, claude, copilot].filter((r) => !r.skipped).length;
    const skippedFiles = [agents, claude, copilot].filter((r) => r.skipped);
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
   * @private
   */
  _buildSections({ rules, patterns, skills }) {
    // 编码规则（Channel A 格式，一行一条）
    const ruleLines = rules
      .slice(0, AGENT_BUDGET.MAX_RULES)
      .filter((e) => e.doClause)
      .map((e) => {
        const langPrefix = e.language && e.scope !== 'universal' ? `[${e.language}] ` : '';
        const doText = e.doClause.replace(/\.+$/, '');
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
      .filter((e) => e.trigger && e.doClause)
      .map((e) => {
        const trigger = e.trigger.startsWith('@') ? e.trigger : `@${e.trigger}`;
        const when = (e.whenClause || '').substring(0, 60);
        const doText = (e.doClause || '').substring(0, 80);
        return `| ${trigger} | ${when} | ${doText} |`;
      });

    // Skills 列表
    const skillLines = skills.slice(0, AGENT_BUDGET.MAX_SKILLS).map((s) => `- \`${s}\``);

    // MCP 工具列表
    const toolLines = MCP_TOOLS_SUMMARY.map((t) => `- \`${t.name}\` — ${t.desc}`);

    return { ruleLines, patternRows, skillLines, toolLines };
  }

  // ─── AGENTS.md ─────────────────────────────────────

  /**
   * @private
   */
  _writeAgentsMd(sections) {
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

  /**
   * @private
   */
  _writeClaudeMd(sections) {
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
    lines.push('### Recommended Workflow', '');
    lines.push(
      '1. **Every message → `autosnippet_ready()`** — Load decisions + tasks + knowledge context (ALWAYS FIRST)'
    );
    lines.push(
      '2. **User agrees/disagrees → `autosnippet_decide(record/revise/unpin)`** — Persist decision immediately'
    );
    lines.push(
      '3. **Before writing code**: `autosnippet_search({ query: "<topic>" })` to find relevant patterns'
    );
    lines.push(
      '4. **Check compliance**: `autosnippet_guard({ code: "<your code>" })` before committing'
    );
    lines.push(
      '5. **Complete task**: `autosnippet_task({ operation: "close", id: "<id>" })`'
    );
    lines.push(
      '6. **Guard diagnostics**: Read ruleId → `autosnippet_search({ query: "<ruleId>" })` → fix'
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
   * @private
   */
  _writeCopilotInstructions(sections) {
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
    lines.push('## Workflow', '');
    lines.push('1. Search before coding: `autosnippet_search({ query: "..." })`');
    lines.push('2. Prefer Recipe over raw source code');
    lines.push('3. Submit discoveries: `autosnippet_submit_knowledge({ ... })`');
    lines.push('4. Do NOT directly modify `AutoSnippet/` or `.autosnippet/` files');
    lines.push('');

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
   * @private
   */
  _renderConstraints() {
    return [
      '## Mandatory Constraints',
      '',
      '1. **Every message → `autosnippet_ready()`** — Load latest decisions and task context. Skipping causes contradictions with team agreements.',
      '2. **User agrees/disagrees with a plan → `autosnippet_decide(record/revise/unpin)` immediately** — Persist team memory first, then continue execution.',
      '3. **Do NOT modify** knowledge base files directly (`AutoSnippet/recipes/`, `.autosnippet/`).',
      '4. Create or update knowledge **only** through MCP tools (`autosnippet_submit_knowledge`).',
      '5. **Prefer Recipes** as project standards; source code is supplementary.',
      '6. Use `autosnippet_search` for knowledge retrieval; do not retry on failure in the same turn.',
      '7. Skills handle semantics and workflow; MCP handles capabilities — do not hardcode URLs in Skills.',
    ];
  }

  /**
   * 推荐工作流（AGENTS.md 用）
   * @private
   */
  _renderWorkflow() {
    return [
      '## Recommended Workflow',
      '',
      '### First Actions (MANDATORY)',
      '1. **Every message** → `autosnippet_ready()` — Load decisions + tasks + knowledge context (never skip)',
      '2. **User agrees/disagrees** → `autosnippet_decide({ operation: "record" | "revise" | "unpin" })` — Persist decision before continuing',
      '',
      '### Task Lifecycle',
      '3. `autosnippet_task({ operation: "claim", id: "asd-xxx" })` — Start working',
      '4. `autosnippet_search({ query: "<topic>" })` — Search knowledge before coding',
      '5. **CODE** — Write the implementation',
      '6. `autosnippet_guard({ code: "<code>" })` — Check compliance',
      '7. `autosnippet_task({ operation: "close", id: "asd-xxx" })` — Complete',
      '',
      '### Guard Diagnostics Response',
      'When editor shows diagnostics from "AutoSnippet Guard":',
      '1. Read the `ruleId` from the diagnostic message',
      '2. `autosnippet_search({ query: "<ruleId>" })` to find the Recipe',
      '3. Apply the Recipe\'s `doClause` + `coreCode` to fix',
      '4. Save and verify the diagnostic disappears',
      '',
      '### Context Pressure',
      '- `_contextHint: CONTEXT_PRESSURE:WARNING` → Summarize completed work, then continue',
      '- `_contextHint: CONTEXT_PRESSURE:CRITICAL` → Call `autosnippet_ready()` immediately',
      '',
    ];
  }
}

export default AgentInstructionsGenerator;
