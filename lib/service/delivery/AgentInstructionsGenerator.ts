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
 *   2. 互补不重复 — .mdc 处理行为规则，Channel F 处理项目知识
 *   3. 轻量索引 — 只输出摘要和规则，详细内容引导至 MCP 工具
 *   4. 幂等生成 — 每次 deliver 重写全部文件，不做增量 diff
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeEntryProps } from '../../domain/knowledge/KnowledgeEntry.js';
import { TEMPLATES_DIR } from '../../shared/package-root.js';
import { mergeSection } from './FileProtection.js';
import { estimateTokens } from './TokenBudget.js';

/**
 * Agent 指令文件 token 预算
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
    name: 'asd_task',
    desc: 'Task & decision management: prime (CALL FIRST every message) / create/claim/close/fail/defer/progress/decompose / record_decision/revise_decision',
  },
  {
    name: 'asd_search',
    desc: 'Search knowledge base (mode: auto/context/keyword/semantic)',
  },
  {
    name: 'asd_knowledge',
    desc: 'Knowledge CRUD (operation: list/get/insights/confirm_usage)',
  },
  {
    name: 'asd_submit_knowledge',
    desc: 'Submit a knowledge candidate (strict validation)',
  },
  { name: 'asd_guard', desc: 'Code compliance check (single file or batch audit)' },
  { name: 'asd_structure', desc: 'Project structure discovery (targets/files/metadata)' },
  { name: 'asd_graph', desc: 'Knowledge graph query (query/impact/path/stats)' },
  { name: 'asd_skill', desc: 'Skill management (list/load/create/update/delete)' },
  { name: 'asd_bootstrap', desc: 'Project cold-start & scan' },
  {
    name: 'asd_rescan',
    desc: 'Incremental rescan: preserves Recipes, cleans caches, re-analyzes project, runs relevance audit',
  },
  {
    name: 'asd_evolve',
    desc: 'Batch Recipe evolution decisions (propose_evolution/confirm_deprecation/skip), used per-dimension during rescan or standalone',
  },
  {
    name: 'asd_panorama',
    desc: 'Project panorama (operation: overview/module/gaps/health)',
  },
  { name: 'asd_health', desc: 'Service health & KB statistics' },
  { name: 'asd_capabilities', desc: 'List all available MCP tools (self-discovery)' },
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

    // AGENTS.md 与 CLAUDE.md 互斥（双向）：
    //   有 CLAUDE.md → 走 CLAUDE.md 路线（跳过 AGENTS.md）
    //   否则 → 走 AGENTS.md 路线（跳过 CLAUDE.md）
    const claudePath = path.join(this.projectRoot, 'CLAUDE.md');
    const agentsPath = path.join(this.projectRoot, 'AGENTS.md');
    const useClaudeMode = fs.existsSync(claudePath);

    const agents = useClaudeMode
      ? { filePath: agentsPath, tokensUsed: 0, skipped: true }
      : this._writeAgentsMd(sections);
    const claude = useClaudeMode
      ? this._writeClaudeMd(sections)
      : { filePath: claudePath, tokensUsed: 0, skipped: true };
    const copilot = this._writeCopilotInstructions(sections);

    const duration = Date.now() - startTime;
    const allResults = [agents, claude, copilot];
    const filesWritten = allResults.filter((r) => !r.skipped).length;
    const skippedFiles = allResults.filter((r) => r.skipped);
    if (skippedFiles.length > 0) {
      this.logger.info?.(
        `[AgentInstructions] Skipped ${skippedFiles.length} file(s): ` +
          skippedFiles.map((f) => f.filePath).join(', ')
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
    // 文件头部（仅用于新建/旧版重写场景）
    const header = [
      `# ${this.projectName} — Agent Instructions`,
      '',
      '> Auto-generated by [Alembic](https://github.com/GxFn/Alembic). Do not edit manually.',
      '',
      'This project uses **Alembic** for knowledge management.',
      'Access the knowledge base through MCP tools.',
      '',
    ].join('\n');

    // 动态区段内容（始终在 markers 内管理）
    const sectionLines: string[] = [];

    if (sections.ruleLines.length > 0) {
      sectionLines.push('## Coding Standards', '', ...sections.ruleLines, '');
    }

    if (sections.patternRows.length > 0) {
      sectionLines.push(
        '## Architecture Patterns',
        '',
        '| Trigger | When | Do |',
        '|---------|------|----|',
        ...sections.patternRows,
        ''
      );
    }

    sectionLines.push('## MCP Tools', '', ...sections.toolLines, '');

    if (sections.skillLines.length > 0) {
      sectionLines.push(
        '## Skills',
        '',
        'Load with `asd_skill({ operation: "load", name: "<skill>" })`:',
        '',
        ...sections.skillLines,
        ''
      );
    }

    sectionLines.push(
      '## Constraints',
      '',
      '1. Do NOT modify knowledge base files directly (`Alembic/recipes/`, `.asd/`).',
      '2. Prefer Recipes as project standards; source code is supplementary.',
      '3. Create or update knowledge only through MCP tools.',
      ''
    );

    const sectionContent = sectionLines.join('\n');
    const filePath = path.join(this.projectRoot, 'AGENTS.md');
    const result = mergeSection(filePath, sectionContent, { header, logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(sectionContent), skipped: !result.written };
  }

  // ─── CLAUDE.md ─────────────────────────────────────

  _writeClaudeMd(sections: {
    ruleLines: string[];
    patternRows: string[];
    skillLines: string[];
    toolLines: string[];
  }) {
    const header = [
      `# ${this.projectName} — Claude Code Instructions`,
      '',
      '> Auto-generated by Alembic. Regenerated when knowledge base changes.',
      '',
      'This project uses **Alembic** for knowledge management.',
      'Access the knowledge base through MCP tools.',
      '',
    ].join('\n');

    const sectionLines: string[] = [];

    if (sections.ruleLines.length > 0) {
      sectionLines.push('## Coding Standards', '', ...sections.ruleLines, '');
    }

    if (sections.patternRows.length > 0) {
      sectionLines.push(
        '## Key Patterns',
        '',
        '| Trigger | When | Do |',
        '|---------|------|----|',
        ...sections.patternRows,
        ''
      );
    }

    sectionLines.push('## MCP Tools', '', ...sections.toolLines, '');

    if (sections.skillLines.length > 0) {
      sectionLines.push('## Skills', '', ...sections.skillLines, '');
    }

    sectionLines.push(
      '',
      '## Constraints',
      '',
      '1. Do NOT modify knowledge base files directly (`Alembic/recipes/`, `.asd/`).',
      '2. Prefer Recipes as project standards; source code is supplementary.',
      '3. Create or update knowledge only through MCP tools.',
      ''
    );

    const sectionContent = sectionLines.join('\n');
    const filePath = path.join(this.projectRoot, 'CLAUDE.md');
    const result = mergeSection(filePath, sectionContent, { header, logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(sectionContent), skipped: !result.written };
  }

  // ─── copilot-instructions.md ───────────────────────

  /**
   * 动态生成 copilot-instructions.md
   * 读取 templates/instructions/conventions.md + HTML markers
   */
  _writeCopilotInstructions(_sections: {
    ruleLines: string[];
    patternRows: string[];
    skillLines: string[];
    toolLines: string[];
  }) {
    const body = this._loadConventionsTemplate();
    const section = [
      '<!-- asd:begin -->',
      '',
      '# Alembic Conventions',
      '',
      body,
      '',
      '<!-- asd:end -->',
    ].join('\n');

    const filePath = path.join(this.projectRoot, '.github', 'copilot-instructions.md');
    const result = mergeSection(filePath, section, { logger: this.logger });

    return { filePath, tokensUsed: estimateTokens(section), skipped: !result.written };
  }

  // ─── 模板读取 ──────────────────────────────────────

  /**
   * 读取 templates/instructions/conventions.md — 唯一内容源
   * .mdc、copilot-instructions.md、Channel F 动态版全部从这里读取
   */
  _loadConventionsTemplate(): string {
    const tplPath = path.join(TEMPLATES_DIR, 'instructions/conventions.md');
    return fs.readFileSync(tplPath, 'utf8').trimEnd();
  }
}

export default AgentInstructionsGenerator;
