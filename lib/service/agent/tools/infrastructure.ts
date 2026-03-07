/**
 * infrastructure.js — 基础设施类工具 (7)
 *
 * 29. graph_impact_analysis  知识图谱影响分析
 * 30. rebuild_index          向量索引重建
 * 31. query_audit_log        审计日志查询
 * 32. load_skill             加载 Skill 文档
 * 33. create_skill           创建项目级 Skill
 * 34. suggest_skills         推荐创建 Skill
 * 34. bootstrap_knowledge    冷启动知识库
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '#infra/logging/Logger.js';
import type { ToolHandlerContext } from './_shared.js';
import { PROJECT_SKILLS_DIR, SKILLS_DIR } from './_shared.js';

// ────────────────────────────────────────────────────────────
// 29. graph_impact_analysis
// ────────────────────────────────────────────────────────────
export const graphImpactAnalysis = {
  name: 'graph_impact_analysis',
  description: '知识图谱影响范围分析 — 查找修改某个 Recipe 后可能受影响的所有下游依赖。',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: 'Recipe ID' },
      maxDepth: { type: 'number', description: '最大深度，默认 3' },
    },
    required: ['recipeId'],
  },
  handler: async (params: { recipeId: string; maxDepth?: number }, ctx: ToolHandlerContext) => {
    const kgService = ctx.container.get('knowledgeGraphService');
    const impacted = kgService.getImpactAnalysis(params.recipeId, 'recipe', params.maxDepth || 3);
    return { recipeId: params.recipeId, impactedCount: impacted.length, impacted };
  },
};

// ────────────────────────────────────────────────────────────
// 30. rebuild_index
// ────────────────────────────────────────────────────────────
export const rebuildIndex = {
  name: 'rebuild_index',
  description:
    '向量索引重建 — 重新扫描 Recipe 文件并更新向量索引（用于索引过期或新增大量 Recipe 后）。',
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: '强制重建（跳过增量检测），默认 false' },
      dryRun: { type: 'boolean', description: '仅预览不实际写入，默认 false' },
    },
  },
  handler: async (params: { force?: boolean; dryRun?: boolean }, ctx: ToolHandlerContext) => {
    const pipeline = ctx.container.get('indexingPipeline');
    return pipeline.run({ force: params.force || false, dryRun: params.dryRun || false });
  },
};

// ────────────────────────────────────────────────────────────
// 31. query_audit_log
// ────────────────────────────────────────────────────────────
export const queryAuditLog = {
  name: 'query_audit_log',
  description: '审计日志查询 — 查看系统操作历史（谁在什么时间做了什么操作）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '按操作类型过滤 (create_candidate/approve_candidate/create_guard_rule 等)',
      },
      actor: { type: 'string', description: '按操作者过滤' },
      limit: { type: 'number', description: '返回数量，默认 20' },
    },
  },
  handler: async (
    params: { action?: string; actor?: string; limit?: number },
    ctx: ToolHandlerContext
  ) => {
    const auditLogger = ctx.container.get('auditLogger');
    const { action, actor, limit = 20 } = params;

    if (actor) {
      return auditLogger.getByActor(actor, limit);
    }
    if (action) {
      return auditLogger.getByAction(action, limit);
    }
    return auditLogger.getStats();
  },
};

// ────────────────────────────────────────────────────────────
// 32. load_skill — 按需加载 Agent Skill 文档
// ────────────────────────────────────────────────────────────
export const loadSkill = {
  name: 'load_skill',
  description:
    '加载指定的 Agent Skill 文档，获取领域操作指南和最佳实践参考。可用于冷启动指南 (autosnippet-coldstart)、候选管理 (autosnippet-candidates)、规范审计 (autosnippet-guard) 等。',
  parameters: {
    type: 'object',
    properties: {
      skillName: {
        type: 'string',
        description:
          'Skill 目录名（如 autosnippet-coldstart, autosnippet-candidates, autosnippet-guard 等）',
      },
    },
    required: ['skillName'],
  },
  handler: async (params: { skillName: string }) => {
    // 项目级 Skills 优先（覆盖同名内置 Skill）
    const projectSkillPath = path.join(PROJECT_SKILLS_DIR, params.skillName, 'SKILL.md');
    const builtinSkillPath = path.join(SKILLS_DIR, params.skillName, 'SKILL.md');
    const skillPath = fs.existsSync(projectSkillPath) ? projectSkillPath : builtinSkillPath;
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      const source = skillPath === projectSkillPath ? 'project' : 'builtin';
      return { skillName: params.skillName, source, content };
    } catch {
      const available = new Set();
      try {
        fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .forEach((d) => available.add(d.name));
      } catch {
        /* skip: SKILLS_DIR may not exist */
      }
      try {
        fs.readdirSync(PROJECT_SKILLS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .forEach((d) => available.add(d.name));
      } catch {
        /* skip: project skills dir may not exist */
      }
      return { error: `Skill "${params.skillName}" not found`, availableSkills: [...available] };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 33. create_skill — 创建项目级 Skill
// ────────────────────────────────────────────────────────────
export const createSkillTool = {
  name: 'create_skill',
  description:
    '创建项目级 Skill 文档，写入 AutoSnippet/skills/<name>/SKILL.md。Skill 是 Agent 的领域知识增强文档。创建后自动更新编辑器索引。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill 名称（kebab-case，如 my-auth-guide），3-64 字符',
      },
      description: { type: 'string', description: 'Skill 一句话描述（写入 frontmatter）' },
      content: { type: 'string', description: 'Skill 正文内容（Markdown 格式，不含 frontmatter）' },
      overwrite: { type: 'boolean', description: '如果同名 Skill 已存在，是否覆盖（默认 false）' },
    },
    required: ['name', 'description', 'content'],
  },
  handler: async (
    params: { name: string; description: string; content: string; overwrite?: boolean },
    ctx: ToolHandlerContext
  ) => {
    const { createSkill } = await import('../../../external/mcp/handlers/skill.js');
    // 根据 Agent 的 source 推断 createdBy
    const createdBy = ctx?.source === 'system' ? 'system-ai' : 'user-ai';
    const raw = createSkill(null, { ...params, createdBy });
    try {
      return JSON.parse(raw);
    } catch {
      return { success: false, error: raw };
    }
  },
};

// ────────────────────────────────────────────────────────────
// 34. suggest_skills — 基于使用模式推荐 Skill 创建
// ────────────────────────────────────────────────────────────
export const suggestSkills = {
  name: 'suggest_skills',
  description:
    '基于项目使用模式分析，推荐创建 Skill。分析 Guard 违规频率、Memory 偏好积累、Recipe 分布缺口、候选积压率。返回推荐列表（含 name/description/rationale/priority），可据此直接调用 create_skill 创建。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_params: Record<string, never>, ctx: ToolHandlerContext) => {
    const { SkillAdvisor } = await import('../../skills/SkillAdvisor.js');
    const database = ctx?.container?.get?.('database') || null;
    const projectRoot = ctx?.projectRoot || process.cwd();
    const advisor = new SkillAdvisor(projectRoot, { database });
    return advisor.suggest();
  },
};

// ────────────────────────────────────────────────────────────
// 34. bootstrap_knowledge — 冷启动知识库初始化
// ────────────────────────────────────────────────────────────
export const bootstrapKnowledgeTool = {
  name: 'bootstrap_knowledge',
  description:
    '冷启动知识库初始化（纯启发式，不使用 AI）: SPM Target 扫描 → 依赖图谱 → Guard 审计 → 9 维度 Candidate 自动创建。支持 Skill 增强维度定义。产出为初稿候选，后续由 DAG pipeline 自动编排 AI 增强（enrich → refine）。',
  parameters: {
    type: 'object',
    properties: {
      maxFiles: { type: 'number', description: '最大扫描文件数，默认 500' },
      skipGuard: { type: 'boolean', description: '是否跳过 Guard 审计，默认 false' },
      contentMaxLines: { type: 'number', description: '每文件读取最大行数，默认 120' },
      loadSkills: {
        type: 'boolean',
        description: '是否加载 Skills 增强维度定义（推荐开启），默认 true',
      },
      skipAsyncFill: {
        type: 'boolean',
        description: '跳过异步 AI 填充（CLI 非 --wait 模式下使用，避免 DB 断连）',
      },
    },
  },
  handler: async (
    params: {
      maxFiles?: number;
      skipGuard?: boolean;
      contentMaxLines?: number;
      loadSkills?: boolean;
      skipAsyncFill?: boolean;
    },
    ctx: ToolHandlerContext
  ) => {
    const { bootstrapKnowledge } = await import(
      '../../../external/mcp/handlers/bootstrap-internal.js'
    );
    const logger = Logger.getInstance();
    const result = await bootstrapKnowledge(
      { container: ctx.container, logger },
      {
        maxFiles: params.maxFiles || 500,
        skipGuard: params.skipGuard || false,
        contentMaxLines: params.contentMaxLines || 120,
        loadSkills: params.loadSkills ?? true,
        skipAsyncFill: params.skipAsyncFill || false,
      }
    );
    // bootstrapKnowledge 返回 envelope JSON string，解析提取 data
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return parsed?.data || parsed;
  },
};
