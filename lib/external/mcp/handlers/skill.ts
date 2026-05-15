/**
 * MCP Handlers — Skills 加载与发现
 *
 * 为 MCP 外部 Agent 提供 Skills 访问能力，使其能按需获取领域操作指南。
 * Skills 是 Agent 的知识增强文档，指导如何正确使用 Alembic 工具。
 *
 * 设计原则：
 *   - Skills 是只读文档，不涉及 AI 调用，不需要 Gateway gating
 *   - 外部 Agent 应根据当前任务类型选择加载合适的 Skill
 *   - list_skills 返回摘要帮助 Agent 判断该加载哪个 Skill
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '#infra/config/Paths.js';
import type { WriteZone } from '#infra/io/WriteZone.js';
import pathGuard from '#shared/PathGuard.js';
import { INJECTABLE_SKILLS_DIR } from '#shared/package-root.js';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import type { McpContext } from './types.js';

function _getWriteZone(ctx?: McpContext | null): WriteZone | undefined {
  return ctx?.container?.singletons?.writeZone as WriteZone | undefined;
}

/**
 * 获取项目级 Skills 目录（运行时动态解析）
 * Ghost 模式下指向外置工作区: ~/.asd/workspaces/<id>/Alembic/skills/
 * 标准模式: {projectRoot}/Alembic/skills/
 */
function _getProjectSkillsDir(ctx?: McpContext) {
  return getProjectSkillsPath(resolveDataRoot(ctx?.container));
}

/**
 * 解析 SKILL.md frontmatter 全部元数据
 *
 * 返回 { description, createdBy, createdAt }，缺失字段为 null。
 * 同时兼容旧格式（无 createdBy 的 SKILL.md）。
 */
function _parseSkillMeta(skillName: string, baseDir = INJECTABLE_SKILLS_DIR) {
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

/** Skill 适用场景映射 — 帮助 Agent 判断何时该加载哪个 Skill */
const SKILL_USE_CASES: Record<string, string> = {
  'alembic-create': '将代码模式/规则/事实提交到知识库',
  'alembic-guard': '代码规范审计（Guard 规则检查）',
  'alembic-recipes': '查询/使用项目标准（Recipe 上下文检索）',
  'alembic-structure': '了解项目结构（Target / 依赖图谱 / 知识图谱）',
  'alembic-devdocs': '保存开发文档（架构决策、调试报告、设计文档）',
};

// ═══════════════════════════════════════════════════════════
// Handler: listSkills
// ═══════════════════════════════════════════════════════════

/**
 * 列出所有可用 Skills 及其摘要描述
 *
 * @returns JSON envelope
 */
export function listSkills(ctx?: McpContext | null) {
  try {
    const skillMap = new Map();

    // 内置 Skills
    const builtinDirs = fs
      .readdirSync(INJECTABLE_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const name of builtinDirs) {
      const meta = _parseSkillMeta(name, INJECTABLE_SKILLS_DIR);
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

    return JSON.stringify({
      success: true,
      data: {
        skills,
        total: skills.length,
        hint: '根据当前任务选择合适的 Skill 加载（load_skill）。',
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
 * @param _ctx MCP context（未使用，保持签名一致）
 * @param args { skillName: string, section?: string }
 * @returns JSON envelope
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
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, skillName, 'SKILL.md');
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
    const meta = _parseSkillMeta(
      skillName,
      source === 'project' ? projectSkillsDir : INJECTABLE_SKILLS_DIR
    );

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
      fs.readdirSync(INJECTABLE_SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: INJECTABLE_SKILLS_DIR may not exist */
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
 * 创建项目级 Skill — 写入 Alembic 数据根目录的 skills/<name>/SKILL.md
 *
 * @param _ctx MCP context
 * @param args { name, description, content, overwrite? }
 * @returns JSON envelope
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
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name, 'SKILL.md');
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
    const wz = _getWriteZone(ctx);

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

    if (wz) {
      const dataRelSkillDir = skillDir.replace(wz.dataRoot, '').replace(/^\//, '');
      const dataRelSkillPath = skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.ensureDir(wz.data(dataRelSkillDir));
      wz.writeFile(wz.data(dataRelSkillPath), frontmatter + content);
    } else {
      pathGuard.assertProjectWriteSafe(skillDir);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, frontmatter + content, 'utf8');
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
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
      hint: `Skill "${name}" created. Use alembic_skill({ operation: "load", name: "${name}" }) to verify content.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: deleteSkill
// ═══════════════════════════════════════════════════════════

/**
 * 删除项目级 Skill — 移除 {projectRoot}/Alembic/skills/<name>/ 整个目录
 * 内置 Skill 不可删除。
 *
 * @param _ctx MCP context
 * @param args { name: string }
 * @returns JSON envelope
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
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name);
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

  // ── 删除目录 ──
  try {
    const wz = _getWriteZone(ctx);
    if (wz) {
      const dataRel = skillDir.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.remove(wz.data(dataRel), { recursive: true });
    } else {
      pathGuard.assertProjectWriteSafe(skillDir);
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'DELETE_ERROR',
        message: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

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
      hint: `Skill "${name}" deleted successfully.`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Handler: updateSkill
// ═══════════════════════════════════════════════════════════

/**
 * 更新项目级 Skill — 修改 description 和/或 content
 * 内置 Skill 不可更新。
 *
 * @param _ctx MCP context
 * @param args { name, description?, content? }
 * @returns JSON envelope
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
  const builtinSkillPath = path.join(INJECTABLE_SKILLS_DIR, name, 'SKILL.md');
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
        message: `Project skill "${name}" not found. Use alembic_skill({ operation: "create" }) to create it first.`,
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

    const wz = _getWriteZone(ctx);
    const fileContent = fmLines.join('\n') + newBody;
    if (wz) {
      const dataRel = skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.writeFile(wz.data(dataRel), fileContent);
    } else {
      pathGuard.assertProjectWriteSafe(path.join(projectSkillsDir, name));
      fs.writeFileSync(skillPath, fileContent, 'utf8');
    }
  } catch (err: unknown) {
    return JSON.stringify({
      success: false,
      error: {
        code: 'UPDATE_ERROR',
        message: `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      updated: true,
      fieldsUpdated: [description ? 'description' : null, content ? 'content' : null].filter(
        Boolean
      ),
      hint: `Skill "${name}" updated. Use alembic_skill({ operation: "load", name: "${name}" }) to verify content.`,
    },
  });
}

/** 相关 Skills（基于静态映射） */
function _getRelatedSkills(skillName: string) {
  const relations = {
    'alembic-create': ['alembic-recipes'],
    'alembic-guard': ['alembic-recipes'],
    'alembic-recipes': ['alembic-guard', 'alembic-structure', 'alembic-create'],
    'alembic-structure': ['alembic-recipes', 'alembic-create'],
    'alembic-devdocs': ['alembic-recipes', 'alembic-create'],
  };
  return (relations as Record<string, string[]>)[skillName] || [];
}
