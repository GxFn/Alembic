/**
 * Alembic Resident Tool Handlers — Skills 加载与发现
 *
 * 为 Alembic 本地 resident service 提供 Skills 访问能力，使其能按需获取领域操作指南。
 * Skills 是 Agent 的知识增强文档，指导如何正确使用 Alembic 工具。
 *
 * 设计原则：
 *   - Skills 是只读文档，不涉及 AI 调用，不需要 Gateway gating
 *   - resident tool consumer 应根据当前任务类型选择加载合适的 Skill
 *   - list_skills 返回摘要帮助 Agent 判断该加载哪个 Skill
 */

import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '@alembic/core/config';
import type { WriteZone } from '@alembic/core/io';
import { pathGuard } from '@alembic/core/io';
import { resolveDataRoot } from '@alembic/core/workspace';
import { PACKAGE_SKILLS_DIR } from '../../shared/package-assets.js';
import type { McpContext } from '../tool-schema/types.js';

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
function _parseSkillMeta(skillName: string, baseDir = PACKAGE_SKILLS_DIR) {
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
      .readdirSync(PACKAGE_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const name of builtinDirs) {
      const meta = _parseSkillMeta(name, PACKAGE_SKILLS_DIR);
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
  const builtinSkillPath = path.join(PACKAGE_SKILLS_DIR, skillName, 'SKILL.md');
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
      source === 'project' ? projectSkillsDir : PACKAGE_SKILLS_DIR
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
      fs.readdirSync(PACKAGE_SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .forEach((d) => {
          available.add(d.name);
        });
    } catch {
      /* skip: PACKAGE_SKILLS_DIR may not exist */
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
 * 创建项目级 Skill — 写入 Alembic 数据目录的 skills/<name>/SKILL.md
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

interface NormalizedCreateSkillArgs {
  name: string;
  description: string;
  content: string;
  overwrite: boolean;
  createdBy: string;
  title?: string;
}

interface ProjectSkillTarget {
  projectSkillsDir: string;
  skillDir: string;
  skillPath: string;
}

type SkillCheck<T> = { ok: true; value: T } | { ok: false; response: string };

function _skillFailure(code: string, message: string): SkillCheck<never> {
  return {
    ok: false,
    response: JSON.stringify({
      success: false,
      error: { code, message },
    }),
  };
}

function _normalizeCreateSkillArgs(args: CreateSkillArgs): SkillCheck<NormalizedCreateSkillArgs> {
  const {
    name,
    description,
    content,
    overwrite = false,
    createdBy = 'external-ai',
    title,
  } = args || {};
  if (!name || !description || !content) {
    return _skillFailure('MISSING_PARAM', 'name, description, content are all required');
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length < 3 || name.length > 64) {
    return _skillFailure(
      'INVALID_NAME',
      `Skill name must be kebab-case (a-z, 0-9, -), 3-64 chars. Got: "${name}"`
    );
  }
  return {
    ok: true,
    value: { name, description, content, overwrite, createdBy, title },
  };
}

function _resolveCreateSkillTarget(
  ctx: McpContext | null,
  name: string,
  overwrite: boolean
): SkillCheck<ProjectSkillTarget> {
  const builtinSkillPath = path.join(PACKAGE_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return _skillFailure(
      'BUILTIN_CONFLICT',
      `"${name}" is a built-in Skill and cannot be overwritten. Choose a different name.`
    );
  }
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillPath) && !overwrite) {
    return _skillFailure(
      'ALREADY_EXISTS',
      `Project skill "${name}" already exists. Set overwrite=true to replace.`
    );
  }
  return { ok: true, value: { projectSkillsDir, skillDir, skillPath } };
}

function _buildCreatedSkillFrontmatter(args: NormalizedCreateSkillArgs): string {
  const resolvedTitle =
    args.title ||
    (() => {
      const match = args.content.match(/^#\s+(.+)/m);
      return match ? match[1].trim() : '';
    })();
  const fmLines = ['---', `name: ${args.name}`];
  if (resolvedTitle) {
    fmLines.push(`title: "${resolvedTitle.replace(/"/g, '\\"')}"`);
  }
  fmLines.push(
    `description: ${args.description}`,
    `createdBy: ${args.createdBy}`,
    `createdAt: ${new Date().toISOString()}`,
    '---',
    ''
  );
  return fmLines.join('\n');
}

function _writeCreatedProjectSkill(
  ctx: McpContext | null,
  target: ProjectSkillTarget,
  args: NormalizedCreateSkillArgs
): SkillCheck<void> {
  try {
    const wz = _getWriteZone(ctx);
    const content = _buildCreatedSkillFrontmatter(args) + args.content;
    if (wz) {
      const dataRelSkillDir = target.skillDir.replace(wz.dataRoot, '').replace(/^\//, '');
      const dataRelSkillPath = target.skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.ensureDir(wz.data(dataRelSkillDir));
      wz.writeFile(wz.data(dataRelSkillPath), content);
    } else {
      pathGuard.assertProjectWriteSafe(target.skillDir);
      fs.mkdirSync(target.skillDir, { recursive: true });
      fs.writeFileSync(target.skillPath, content, 'utf8');
    }
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return _skillFailure(
      'WRITE_ERROR',
      `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function createSkill(ctx: McpContext | null, args: CreateSkillArgs) {
  const normalized = _normalizeCreateSkillArgs(args);
  if (!normalized.ok) {
    return normalized.response;
  }
  const target = _resolveCreateSkillTarget(ctx, normalized.value.name, normalized.value.overwrite);
  if (!target.ok) {
    return target.response;
  }
  const writeResult = _writeCreatedProjectSkill(ctx, target.value, normalized.value);
  if (!writeResult.ok) {
    return writeResult.response;
  }

  const indexResult = _regenerateEditorIndex(ctx ?? undefined);
  const { createdBy, description, name, overwrite } = normalized.value;
  const { skillPath } = target.value;

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
      hint: `Skill "${name}" created. Use the Skills load operation only for manual inspection; runtime consumers should rely on ProjectSkillDeliveryReceipt when available.`,
    },
  });
}

/**
 * Alembic 主包不再写入项目编辑器交付索引。
 */
function _regenerateEditorIndex(ctx?: McpContext) {
  void ctx;
  return {
    success: true,
    generated: false,
    reason: 'Alembic main package no longer writes project editor delivery indexes.',
  };
}

// ═══════════════════════════════════════════════════════════
// Handler: deleteSkill
// ═══════════════════════════════════════════════════════════

/**
 * 删除项目级 Skill — 移除 Alembic 数据目录的 skills/<name>/ 整个目录
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
  const builtinSkillPath = path.join(PACKAGE_SKILLS_DIR, name);
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

interface NormalizedUpdateSkillArgs {
  name: string;
  description?: string;
  content?: string;
}

interface SkillDocumentParts {
  frontmatter: string;
  body: string;
}

function _normalizeUpdateSkillArgs(args: UpdateSkillArgs): SkillCheck<NormalizedUpdateSkillArgs> {
  const { name, description, content } = args || {};
  if (!name) {
    return _skillFailure('MISSING_PARAM', 'name is required');
  }
  if (!description && !content) {
    return _skillFailure(
      'NOTHING_TO_UPDATE',
      'At least one of description or content must be provided.'
    );
  }
  return { ok: true, value: { name, description, content } };
}

function _resolveExistingProjectSkillTarget(
  ctx: McpContext | null,
  name: string
): SkillCheck<ProjectSkillTarget> {
  const builtinSkillPath = path.join(PACKAGE_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return _skillFailure(
      'BUILTIN_PROTECTED',
      `"${name}" is a built-in Skill and cannot be updated. Fork it as a project skill instead.`
    );
  }
  const projectSkillsDir = _getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return _skillFailure(
      'SKILL_NOT_FOUND',
      `Project skill "${name}" not found. Use alembic_skill({ operation: "create" }) to create it first.`
    );
  }
  return { ok: true, value: { projectSkillsDir, skillDir, skillPath } };
}

function _parseExistingSkillDocument(existing: string): SkillDocumentParts {
  const match = existing.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: '', body: existing };
}

function _frontmatterField(frontmatter: string, key: string) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)$`, 'm'));
  return match ? match[1].trim() : null;
}

function _buildUpdatedSkillDocument(args: NormalizedUpdateSkillArgs, existing: string) {
  const parsed = _parseExistingSkillDocument(existing);
  const newDesc =
    args.description || _frontmatterField(parsed.frontmatter, 'description') || args.name;
  const newBody = args.content !== undefined && args.content !== null ? args.content : parsed.body;
  const createdBy = _frontmatterField(parsed.frontmatter, 'createdBy') || 'external-ai';
  const createdAt = _frontmatterField(parsed.frontmatter, 'createdAt') || new Date().toISOString();
  const title = _frontmatterField(parsed.frontmatter, 'title');
  const fmLines = ['---', `name: ${args.name}`];
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
  return fmLines.join('\n') + newBody;
}

function _prepareUpdatedProjectSkill(
  target: ProjectSkillTarget,
  args: NormalizedUpdateSkillArgs
): SkillCheck<string> {
  try {
    const existing = fs.readFileSync(target.skillPath, 'utf8');
    return { ok: true, value: _buildUpdatedSkillDocument(args, existing) };
  } catch (err: unknown) {
    return _skillFailure(
      'UPDATE_ERROR',
      `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function _writeUpdatedProjectSkill(
  ctx: McpContext | null,
  target: ProjectSkillTarget,
  fileContent: string
): SkillCheck<void> {
  try {
    const wz = _getWriteZone(ctx);
    if (wz) {
      const dataRel = target.skillPath.replace(wz.dataRoot, '').replace(/^\//, '');
      wz.writeFile(wz.data(dataRel), fileContent);
    } else {
      pathGuard.assertProjectWriteSafe(target.skillDir);
      fs.writeFileSync(target.skillPath, fileContent, 'utf8');
    }
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return _skillFailure(
      'UPDATE_ERROR',
      `Failed to update skill: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function updateSkill(ctx: McpContext | null, args: UpdateSkillArgs) {
  const normalized = _normalizeUpdateSkillArgs(args);
  if (!normalized.ok) {
    return normalized.response;
  }
  const target = _resolveExistingProjectSkillTarget(ctx, normalized.value.name);
  if (!target.ok) {
    return target.response;
  }
  const prepared = _prepareUpdatedProjectSkill(target.value, normalized.value);
  if (!prepared.ok) {
    return prepared.response;
  }
  const writeResult = _writeUpdatedProjectSkill(ctx, target.value, prepared.value);
  if (!writeResult.ok) {
    return writeResult.response;
  }

  const indexResult = _regenerateEditorIndex(ctx ?? undefined);
  const { content, description, name } = normalized.value;

  return JSON.stringify({
    success: true,
    data: {
      skillName: name,
      updated: true,
      fieldsUpdated: [description ? 'description' : null, content ? 'content' : null].filter(
        Boolean
      ),
      editorIndex: indexResult,
      hint: `Skill "${name}" updated. Use the Skills load operation only for manual inspection; runtime consumers should rely on ProjectSkillDeliveryReceipt when available.`,
    },
  });
}

/** 关联 Skills（基于静态映射） */
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
