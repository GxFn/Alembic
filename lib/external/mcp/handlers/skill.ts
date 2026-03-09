/**
 * MCP Handlers — Skills 加载与发现
 *
 * 为 MCP 外部 Agent 提供 Skills 访问能力，使其能按需获取领域操作指南。
 * Skills 是 Agent 的知识增强文档，指导如何正确使用 AutoSnippet 工具。
 *
 * 设计原则：
 *   - Skills 是只读文档，不涉及 AI 调用，不需要 Gateway gating
 *   - 外部 Agent 应根据当前任务类型选择加载合适的 Skill
 *   - list_skills 返回摘要帮助 Agent 判断该加载哪个 Skill
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '#infra/config/Paths.js';
import pathGuard from '#shared/PathGuard.js';
import { SKILLS_DIR } from '#shared/package-root.js';
import { resolveProjectRoot } from '#shared/resolveProjectRoot.js';
import type { McpContext } from './types.js';

/**
 * 获取项目级 Skills 目录（运行时动态解析）
 * 路径: {projectRoot}/AutoSnippet/skills/ — 跟随项目走
 */
function _getProjectSkillsDir(ctx?: McpContext) {
  return getProjectSkillsPath(resolveProjectRoot(ctx?.container));
}

/**
 * 解析 SKILL.md frontmatter 全部元数据
 *
 * 返回 { description, createdBy, createdAt }，缺失字段为 null。
 * 同时兼容旧格式（无 createdBy 的 SKILL.md）。
 */
function _parseSkillMeta(skillName: string, baseDir = SKILLS_DIR) {
  try {
    const content = fs.readFileSync(path.join(baseDir, skillName, 'SKILL.md'), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta: { description: string; createdBy: string | null; createdAt: string | null } = {
      description: skillName,
      createdBy: null,
      createdAt: null,
    };
    if (fmMatch) {
      const fm = fmMatch[1];
      const descMatch = fm.match(/^description:\s*(.+?)$/m);
      if (descMatch) {
        const desc = descMatch[1].trim();
        const firstSentence = desc.split(/\.\s/)[0];
        meta.description =
          firstSentence.length < desc.length ? `${firstSentence}.` : desc.substring(0, 120);
      }
      const cbMatch = fm.match(/^createdBy:\s*(.+?)$/m);
      if (cbMatch) {
        meta.createdBy = cbMatch[1].trim();
      }
      const caMatch = fm.match(/^createdAt:\s*(.+?)$/m);
      if (caMatch) {
        meta.createdAt = caMatch[1].trim();
      }
    }
    return meta;
  } catch {
    return { description: skillName, createdBy: null, createdAt: null };
  }
}

/**
 * Skill 适用场景映射 — 帮助 Agent 判断何时该加载哪个 Skill
 */
const SKILL_USE_CASES: Record<string, string> = {
  'autosnippet-intent': '不确定该用哪个能力时，先加载此 Skill 做意图路由',
  'autosnippet-coldstart': '冷启动/初始化知识库时的完整 9 维度分析指南',
  'autosnippet-analysis': '深度项目分析 — 扫描 + 语义补齐 + 缺口填充',
  'autosnippet-candidates': '生成/提交高质量候选（V2 全字段结构化）',
  'autosnippet-create': '将代码提交到知识库（Dashboard 入口）',
  'autosnippet-guard': '代码规范审计（Guard 规则检查）',
  'autosnippet-recipes': '查询/使用项目标准（Recipe 上下文检索）',
  'autosnippet-structure': '了解项目结构（SPM Target / 依赖图谱 / 知识图谱）',
  'autosnippet-concepts': '学习 AutoSnippet 核心概念（知识库/Recipe/Snippet/向量库）',
  'autosnippet-lifecycle': '了解 Recipe 生命周期与 Agent 权限边界',
};

// ═══════════════════════════════════════════════════════════
// Handler: listSkills
// ═══════════════════════════════════════════════════════════

/**
 * 列出所有可用 Skills 及其摘要描述
 *
 * @returns {string} JSON envelope
 */
export function listSkills(ctx?: McpContext | null) {
  try {
    const skillMap = new Map();

    // 内置 Skills
    const builtinDirs = fs
      .readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const name of builtinDirs) {
      const meta = _parseSkillMeta(name, SKILLS_DIR);
      skillMap.set(name, {
        name,
        source: 'builtin',
        summary: meta.description,
        createdBy: null,
        createdAt: null,
        useCase: SKILL_USE_CASES[name] || null,
      });
    }

    // 项目级 Skills（覆盖同名内置）
    try {
      const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
      const projectDirs = fs
        .readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const name of projectDirs) {
        const meta = _parseSkillMeta(name, projectSkillsDir);
        skillMap.set(name, {
          name,
          source: 'project',
          summary: meta.description,
          createdBy: meta.createdBy,
          createdAt: meta.createdAt,
          useCase: SKILL_USE_CASES[name] || null,
        });
      }
    } catch {
      /* no project skills */
    }

    const skills = [...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    // _meta：附带 SignalCollector 推荐计数（如果后台服务可用）
    let suggestionCount = 0;
    try {
      const g = globalThis as unknown as {
        _signalCollector?: { getSnapshot(): { lastResult?: { newSuggestions?: number } } };
      };
      if (g._signalCollector) {
        const snapshot = g._signalCollector.getSnapshot();
        suggestionCount = snapshot?.lastResult?.newSuggestions || 0;
      }
    } catch {
      /* silent */
    }

    return JSON.stringify({
      success: true,
      data: {
        skills,
        total: skills.length,
        hint: '根据当前任务选择合适的 Skill 加载（load_skill）。不确定时先加载 autosnippet-intent 做意图路由。',
        _meta: { signalSuggestions: suggestionCount },
      },
    });
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILLS_READ_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Handler: loadSkill
// ═══════════════════════════════════════════════════════════

/**
 * 加载指定 Skill 的完整文档内容
 *
 * @param {object} _ctx  MCP context（未使用，保持签名一致）
 * @param {object} args  { skillName: string, section?: string }
 * @returns {string} JSON envelope
 */
export function loadSkill(ctx: McpContext | null, args: { skillName?: string; section?: string }) {
  const { skillName, section } = args || {};

  if (!skillName) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'skillName is required' },
    });
  }

  // 项目级 Skills 优先
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const projectSkillPath = path.join(projectSkillsDir, skillName, 'SKILL.md');
  const builtinSkillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const skillPath = fs.existsSync(projectSkillPath) ? projectSkillPath : builtinSkillPath;
  const source = skillPath === projectSkillPath ? 'project' : 'builtin';

  try {
    let content = fs.readFileSync(skillPath, 'utf8');

    // 如果指定了 section，只返回对应章节
    if (section) {
      const sectionRe = new RegExp(
        `^##\\s+.*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$\\n([\\s\\S]*?)(?=^##\\s|$)`,
        'mi'
      );
      const match = content.match(sectionRe);
      if (match) {
        content = match[0];
      }
    }

    // 提取 createdBy/createdAt
    const meta = _parseSkillMeta(skillName, source === 'project' ? projectSkillsDir : SKILLS_DIR);

    // ── SkillHooks: onSkillLoad (fire-and-forget) ──
    try {
      const skillHooks = ctx?.container?.get?.('skillHooks');
      if (skillHooks?.has?.('onSkillLoad')) {
        skillHooks.run('onSkillLoad', { skillName, source }).catch(() => {
          /* fire-and-forget */
        });
      }
    } catch {
      /* skillHooks not available */
    }

    return JSON.stringify({
      success: true,
      data: {
        skillName,
        source,
        content,
        charCount: content.length,
        createdBy: source === 'project' ? meta.createdBy : null,
        createdAt: source === 'project' ? meta.createdAt : null,
        useCase: SKILL_USE_CASES[skillName] || null,
        relatedSkills: _getRelatedSkills(skillName),
      },
    });
  } catch {
    // 列出所有可用 Skills
    const available = new Set();
    try {
      fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: SKILLS_DIR may not exist */
    }
    try {
      fs.readdirSync(_getProjectSkillsDir(ctx ?? undefined), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: project skills dir may not exist */
    }

    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Skill "${skillName}" not found`,
        availableSkills: [...available],
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Handler: createSkill
// ═══════════════════════════════════════════════════════════

/**
 * 创建项目级 Skill — 写入 {projectRoot}/AutoSnippet/skills/<name>/SKILL.md
 * 创建后自动 regenerate 编辑器索引（.cursor/rules/autosnippet-skills.mdc）
 *
 * @param {object} _ctx  MCP context
 * @param {object} args  { name, description, content, overwrite? }
 * @returns {string} JSON envelope
 */
interface CreateSkillArgs {
  name?: string;
  description?: string;
  content?: string;
  overwrite?: boolean;
  createdBy?: string;
  title?: string;
}

export function createSkill(ctx: McpContext | null, args: CreateSkillArgs) {
  const {
    name,
    description,
    content,
    overwrite = false,
    createdBy = 'external-ai',
    title,
  } = args || {};

  // ── 参数校验 ──
  if (!name || !description || !content) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name, description, content are all required' },
    });
  }

  // 名称格式校验：kebab-case（允许字母、数字、连字符）
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length < 3 || name.length > 64) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'INVALID_NAME',
        message: `Skill name must be kebab-case (a-z, 0-9, -), 3-64 chars. Got: "${name}"`,
      },
    });
  }

  // 不允许覆盖内置 Skill
  const builtinSkillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_CONFLICT',
        message: `"${name}" is a built-in Skill and cannot be overwritten. Choose a different name.`,
      },
    });
  }

  // 检查同名项目级 Skill
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillPath) && !overwrite) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'ALREADY_EXISTS',
        message: `Project skill "${name}" already exists. Set overwrite=true to replace.`,
      },
    });
  }

  // ── 写入 SKILL.md ──
  try {
    // 路径安全检查 — name 来自用户输入，可能含路径字符
    pathGuard.assertProjectWriteSafe(skillDir);
    fs.mkdirSync(skillDir, { recursive: true });

    // 自动推断 title: 优先使用传入参数，否则从 content 的第一个 # heading 提取
    const resolvedTitle =
      title ||
      (() => {
        const m = (content || '').match(/^#\s+(.+)/m);
        return m ? m[1].trim() : '';
      })();

    const fmLines = ['---', `name: ${name}`];
    if (resolvedTitle) {
      fmLines.push(`title: "${resolvedTitle.replace(/"/g, '\\"')}"`);
    }
    fmLines.push(
      `description: ${description}`,
      `createdBy: ${createdBy}`,
      `createdAt: ${new Date().toISOString()}`,
      '---',
      ''
    );
    const frontmatter = fmLines.join('\n');

    fs.writeFileSync(skillPath, frontmatter + content, 'utf8');
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  // ── regenerate 编辑器索引 ──
  const indexResult = _regenerateEditorIndex(ctx ?? undefined);

  // ── 清理 SignalCollector 已创建的 pendingSuggestions ──
  try {
    const g = globalThis as unknown as {
      _signalCollector?: { removePendingSuggestion(name: string): void };
    };
    if (g._signalCollector) {
      g._signalCollector.removePendingSuggestion(name);
    }
  } catch {
    /* silent */
  }

  // ── SkillHooks: onSkillCreated (fire-and-forget) ──
  try {
    const skillHooks = ctx?.container?.get?.('skillHooks');
    if (skillHooks?.has?.('onSkillCreated')) {
      skillHooks
        .run('onSkillCreated', { name, description, createdBy, path: skillPath })
        .catch(() => {
          /* fire-and-forget */
        });
    }
  } catch {
    /* skillHooks not available */
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      path: skillPath,
      overwritten: fs.existsSync(skillPath) && overwrite,
      editorIndex: indexResult,
      hint: `Skill "${name}" created. Use autosnippet_skill({ operation: "load", name: "${name}" }) to verify content.`,
    },
  });
}

/**
 * Regenerate .cursor/rules/autosnippet-skills.mdc 索引文件
 * 扫描所有项目级 Skills，生成摘要索引供 External Agent 被动发现
 *
 * @returns {{ success: boolean, path?: string, skillCount?: number, error?: string }}
 */
function _regenerateEditorIndex(ctx?: McpContext) {
  try {
    // 扫描项目级 Skills
    const projectSkills: { name: string; summary: string }[] = [];
    const projectSkillsDir = _getProjectSkillsDir(ctx);
    try {
      const dirs = fs
        .readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const name of dirs) {
        const meta = _parseSkillMeta(name, projectSkillsDir);
        projectSkills.push({ name, summary: meta.description });
      }
    } catch {
      /* no project skills dir */
    }

    const projectRoot = resolveProjectRoot(ctx?.container);
    const rulesDir = path.join(projectRoot, '.cursor', 'rules');

    if (projectSkills.length === 0) {
      // 没有项目级 Skills 时，删除索引文件（如果存在）
      const indexPath = path.join(rulesDir, 'autosnippet-skills.mdc');
      try {
        fs.unlinkSync(indexPath);
      } catch {
        /* not exists */
      }
      return { success: true, skillCount: 0 };
    }

    // 生成 .mdc 内容
    const skillLines = projectSkills.map((s) => `- **${s.name}**: ${s.summary}`).join('\n');

    const mdcContent = [
      '---',
      'description: AutoSnippet 项目级 Skills 索引（自动生成，请勿手动编辑）',
      'alwaysApply: true',
      '---',
      '',
      '# AutoSnippet Project Skills',
      '',
      `本项目已注册 ${projectSkills.length} 个自定义 Skill。使用 \`autosnippet_skill({ operation: "load", name })\` 加载完整内容。`,
      '',
      skillLines,
      '',
    ].join('\n');

    // 写入 .cursor/rules/
    pathGuard.assertProjectWriteSafe(rulesDir);
    fs.mkdirSync(rulesDir, { recursive: true });
    const indexPath = path.join(rulesDir, 'autosnippet-skills.mdc');
    fs.writeFileSync(indexPath, mdcContent, 'utf8');

    return { success: true, path: indexPath, skillCount: projectSkills.length };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════════════════════════
// Handler: deleteSkill
// ═══════════════════════════════════════════════════════════

/**
 * 删除项目级 Skill — 移除 {projectRoot}/AutoSnippet/skills/<name>/ 整个目录
 * 内置 Skill 不可删除。删除后自动 regenerate 编辑器索引。
 *
 * @param {object} _ctx  MCP context
 * @param {object} args  { name: string }
 * @returns {string} JSON envelope
 */
export function deleteSkill(ctx: McpContext | null, args: { name?: string }) {
  const { name } = args || {};

  if (!name) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name is required' },
    });
  }

  // 不允许删除内置 Skill
  const builtinSkillPath = path.join(SKILLS_DIR, name);
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_PROTECTED',
        message: `"${name}" is a built-in Skill and cannot be deleted.`,
      },
    });
  }

  // 检查项目级 Skill 是否存在
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  if (!fs.existsSync(skillDir)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Project skill "${name}" not found.`,
      },
    });
  }

  // ── 路径安全检查 ──
  try {
    pathGuard.assertProjectWriteSafe(skillDir);
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: { code: 'PATH_GUARD', message: err instanceof Error ? err.message : String(err) },
    });
  }

  // ── 删除目录 ──
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'DELETE_ERROR',
        message: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  // ── regenerate 编辑器索引 ──
  const indexResult = _regenerateEditorIndex(ctx ?? undefined);

  // ── SkillHooks: onSkillExpired (fire-and-forget) ──
  try {
    const skillHooks = ctx?.container?.get?.('skillHooks');
    if (skillHooks?.has?.('onSkillExpired')) {
      skillHooks.run('onSkillExpired', { name, reason: 'deleted' }).catch(() => {
        /* fire-and-forget */
      });
    }
  } catch {
    /* skillHooks not available */
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      deleted: true,
      editorIndex: indexResult,
      hint: `Skill "${name}" deleted successfully.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: updateSkill
// ═══════════════════════════════════════════════════════════

/**
 * 更新项目级 Skill — 修改 description 和/或 content
 * 内置 Skill 不可更新。更新后自动 regenerate 编辑器索引。
 *
 * @param {object} _ctx  MCP context
 * @param {object} args  { name, description?, content? }
 * @returns {string} JSON envelope
 */
interface UpdateSkillArgs {
  name?: string;
  description?: string;
  content?: string;
}

export function updateSkill(ctx: McpContext | null, args: UpdateSkillArgs) {
  const { name, description, content } = args || {};

  if (!name) {
    return JSON.stringify({
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name is required' },
    });
  }

  if (!description && !content) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'NOTHING_TO_UPDATE',
        message: 'At least one of description or content must be provided.',
      },
    });
  }

  // 不允许更新内置 Skill
  const builtinSkillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'BUILTIN_PROTECTED',
        message: `"${name}" is a built-in Skill and cannot be updated. Fork it as a project skill instead.`,
      },
    });
  }

  // 检查项目级 Skill 是否存在
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillPath = path.join(projectSkillsDir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `Project skill "${name}" not found. Use autosnippet_skill({ operation: "create" }) to create it first.`,
      },
    });
  }

  try {
    // ── 读取现有文件 ──
    const existing = fs.readFileSync(skillPath, 'utf8');

    // 解析现有 frontmatter
    const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let oldFm = '';
    let oldBody = existing;
    if (fmMatch) {
      oldFm = fmMatch[1];
      oldBody = fmMatch[2];
    }

    // 解析已有字段
    const getField = (fm: string, key: string) => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+?)$`, 'm'));
      return m ? m[1].trim() : null;
    };

    const newDesc = description || getField(oldFm, 'description') || name;
    const newBody = content !== undefined && content !== null ? content : oldBody;

    // 保留原有字段
    const createdBy = getField(oldFm, 'createdBy') || 'external-ai';
    const createdAt = getField(oldFm, 'createdAt') || new Date().toISOString();
    const title = getField(oldFm, 'title');

    // 重建 frontmatter
    const fmLines = ['---', `name: ${name}`];
    if (title) {
      fmLines.push(`title: ${title}`);
    }
    fmLines.push(
      `description: ${newDesc}`,
      `createdBy: ${createdBy}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${new Date().toISOString()}`,
      '---',
      ''
    );

    pathGuard.assertProjectWriteSafe(path.join(projectSkillsDir, name));
    fs.writeFileSync(skillPath, fmLines.join('\n') + newBody, 'utf8');
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'UPDATE_ERROR',
        message: `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  // ── regenerate 编辑器索引 ──
  const indexResult = _regenerateEditorIndex(ctx ?? undefined);

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      updated: true,
      fieldsUpdated: [description ? 'description' : null, content ? 'content' : null].filter(
        Boolean
      ),
      editorIndex: indexResult,
      hint: `Skill "${name}" updated. Use autosnippet_skill({ operation: "load", name: "${name}" }) to verify content.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: suggestSkills
// ═══════════════════════════════════════════════════════════

/**
 * 基于项目使用模式分析，推荐创建 Skill
 *
 * 分析维度：Guard 违规模式、Memory 偏好积累、Recipe 分布缺口、候选积压
 * Agent 可根据推荐结果自行决定是否调用 createSkill 创建
 *
 * @param {object} ctx  MCP context（含 container）
 * @returns {Promise<string>} JSON envelope
 */
export async function suggestSkills(ctx: McpContext) {
  try {
    // ── 优先使用 RecommendationPipeline (统一推荐管线) ──
    const pipeline = ctx?.container?.get?.('recommendationPipeline');
    if (pipeline && typeof pipeline.recommend === 'function') {
      const database = ctx?.container?.get?.('database');
      const projectRoot = resolveProjectRoot(ctx?.container);
      const existingSkills = _listExistingProjectSkillNames(ctx);
      const recommendations = await pipeline.recommend({
        projectRoot,
        database: database?.getDb?.() || database || null,
        container: ctx?.container,
        existingSkills,
      });

      // 记录展示指标
      try {
        const metrics = ctx?.container?.get?.('recommendationMetrics');
        if (metrics && typeof metrics.trackDisplayed === 'function') {
          metrics.trackDisplayed(recommendations);
        }
      } catch {
        /* metrics tracking is best-effort */
      }

      return JSON.stringify({
        success: true,
        data: {
          suggestions: recommendations,
          existingProjectSkills: [...existingSkills],
          hint:
            recommendations.length > 0
              ? `发现 ${recommendations.length} 个 Skill 创建建议（powered by RecommendationPipeline）。`
              : '当前项目使用模式暂无明确的 Skill 创建建议。',
        },
      });
    }

    // ── Fallback: 直接使用 SkillAdvisor ──
    const { SkillAdvisor } = await import('#service/skills/SkillAdvisor.js');
    const dbConn = ctx?.container?.get?.('database') || null;
    const database = dbConn?.getDb?.() || dbConn || null;
    const projectRoot = resolveProjectRoot(ctx?.container);
    const advisor = new SkillAdvisor(projectRoot, { database });
    const result = advisor.suggest();

    return JSON.stringify({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: { code: 'SUGGEST_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * 获取已有的项目级 Skill 名称集合
 */
function _listExistingProjectSkillNames(ctx?: McpContext | null): Set<string> {
  const names = new Set<string>();
  try {
    const dir = _getProjectSkillsDir(ctx ?? undefined);
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        names.add(d.name);
      }
    }
  } catch {
    /* no project skills */
  }
  return names;
}

/**
 * 推荐相关 Skills（基于静态映射）
 */
function _getRelatedSkills(skillName: string) {
  const relations = {
    'autosnippet-coldstart': [
      'autosnippet-analysis',
      'autosnippet-candidates',
      'autosnippet-structure',
    ],
    'autosnippet-analysis': [
      'autosnippet-candidates',
      'autosnippet-coldstart',
      'autosnippet-structure',
    ],
    'autosnippet-candidates': [
      'autosnippet-analysis',
      'autosnippet-create',
      'autosnippet-lifecycle',
    ],
    'autosnippet-create': ['autosnippet-candidates', 'autosnippet-lifecycle'],
    'autosnippet-guard': ['autosnippet-recipes', 'autosnippet-analysis'],
    'autosnippet-recipes': ['autosnippet-guard', 'autosnippet-structure', 'autosnippet-concepts'],
    'autosnippet-structure': ['autosnippet-analysis', 'autosnippet-coldstart'],
    'autosnippet-concepts': ['autosnippet-recipes', 'autosnippet-lifecycle'],
    'autosnippet-lifecycle': ['autosnippet-candidates', 'autosnippet-concepts'],
    'autosnippet-intent': [],
  };
  return (relations as Record<string, string[]>)[skillName] || [];
}

// ═══════════════════════════════════════════════════════
//  推荐反馈
// ═══════════════════════════════════════════════════════

/**
 * 记录推荐反馈
 *
 * operation: 'feedback'
 * @param args.recommendationId  推荐 ID
 * @param args.action           'adopted' | 'dismissed' | 'expired' | 'viewed' | 'modified'
 * @param args.reason           可选 — 忽略原因
 * @param args.source           可选 — 推荐来源
 * @param args.category         可选 — 推荐类别
 */
export async function recordFeedback(
  ctx: McpContext,
  args: {
    recommendationId?: string;
    action?: string;
    reason?: string;
    source?: string;
    category?: string;
  }
) {
  try {
    const validActions = ['adopted', 'dismissed', 'expired', 'viewed', 'modified'];
    if (!args.recommendationId || !args.action) {
      return JSON.stringify({
        success: false,
        error: { code: 'MISSING_PARAMS', message: 'recommendationId and action are required' },
      });
    }
    if (!validActions.includes(args.action)) {
      return JSON.stringify({
        success: false,
        error: {
          code: 'INVALID_ACTION',
          message: `action must be one of: ${validActions.join(', ')}`,
        },
      });
    }

    // 获取 FeedbackStore
    const feedbackStore = ctx?.container?.get?.('feedbackStore');
    if (!feedbackStore || typeof feedbackStore.record !== 'function') {
      return JSON.stringify({
        success: false,
        error: { code: 'STORE_UNAVAILABLE', message: 'FeedbackStore not initialized' },
      });
    }

    await feedbackStore.record({
      recommendationId: args.recommendationId,
      action: args.action,
      timestamp: new Date().toISOString(),
      source: args.source,
      category: args.category,
      reason: args.reason,
    });

    // 触发 SkillHooks: onRecommendFeedback
    try {
      const skillHooks = ctx?.container?.get?.('skillHooks');
      if (skillHooks?.has?.('onRecommendFeedback')) {
        await skillHooks.run('onRecommendFeedback', {
          recommendationId: args.recommendationId,
          action: args.action,
          reason: args.reason,
        });
      }
    } catch {
      /* hook error is non-blocking */
    }

    return JSON.stringify({
      success: true,
      data: { recorded: true, recommendationId: args.recommendationId, action: args.action },
    });
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'FEEDBACK_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
