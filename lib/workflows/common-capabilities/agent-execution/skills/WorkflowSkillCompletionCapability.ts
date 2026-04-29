import fs from 'node:fs';
import path from 'node:path';
import { getProjectSkillsPath } from '#infra/config/Paths.js';
import type { WriteZone } from '#infra/io/WriteZone.js';
import Logger from '#infra/logging/Logger.js';
import pathGuard from '#shared/PathGuard.js';
import { SKILLS_DIR } from '#shared/package-root.js';
import { resolveDataRoot, resolveProjectRoot } from '#shared/resolveProjectRoot.js';

const logger = Logger.getInstance();

interface SkillContext {
  container?: {
    singletons?: Record<string, unknown>;
    get?(name: string): unknown;
  } | null;
}

interface SkillDimensionDef {
  id: string;
  label?: string;
  skillWorthy?: boolean;
  skillMeta?: { name?: string; description?: string } | null;
}

interface CreateWorkflowSkillArgs {
  name?: string;
  description?: string;
  content?: string;
  overwrite?: boolean;
  createdBy?: string;
  title?: string;
}

interface SkillQualityResult {
  pass: boolean;
  reason: string | null;
  deduplicatedText?: string;
}

interface SkillCreateResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface SkillHooksLike {
  has(name: string): boolean;
  run(name: string, payload: Record<string, unknown>): Promise<unknown>;
}

const MIN_ANALYSIS_LENGTH = 100;
const HARD_REJECT_RATIO = 0.1;
const CONSECUTIVE_DUPE_THRESHOLD = 8;
const STRUCTURE_CHECK_THRESHOLD = 500;

const SKILL_USE_CASES: Record<string, string> = {
  'alembic-create': '将代码模式/规则/事实提交到知识库',
  'alembic-guard': '代码规范审计（Guard 规则检查）',
  'alembic-recipes': '查询/使用项目标准（Recipe 上下文检索）',
  'alembic-structure': '了解项目结构（Target / 依赖图谱 / 知识图谱）',
  'alembic-devdocs': '保存开发文档（架构决策、调试报告、设计文档）',
};

export async function generateSkill(
  ctx: SkillContext,
  dim: SkillDimensionDef,
  analysisText: string,
  referencedFiles: string[] = [],
  keyFindings: string[] = [],
  source = 'bootstrap'
): Promise<{ success: boolean; skillName: string; error?: string }> {
  const skillName = dim.skillMeta?.name || `project-${dim.id}`;
  const validation = validateSkillQuality(analysisText);
  if (!validation.pass) {
    logger.warn(`[SkillGenerator] Skill "${dim.id}" skipped — ${validation.reason}`);
    return { success: false, skillName, error: validation.reason ?? undefined };
  }

  const effectiveText = validation.deduplicatedText || analysisText;
  const skillContent = buildSkillContent(dim, effectiveText, referencedFiles, keyFindings, source);

  try {
    const skillDescription = dim.skillMeta?.description || `Auto-generated skill for ${dim.label}`;
    const result = createWorkflowSkill(ctx, {
      name: skillName,
      description: skillDescription,
      content: skillContent,
      overwrite: true,
      createdBy: source,
    });

    if (result.success) {
      logger.info(`[SkillGenerator] Skill "${skillName}" created for "${dim.id}" (${source})`);
      return { success: true, skillName };
    }

    const errorMsg = result.error?.message || 'createSkill returned failure';
    throw new Error(errorMsg);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[SkillGenerator] Skill generation failed for "${dim.id}": ${msg}`);
    return { success: false, skillName, error: msg };
  }
}

function createWorkflowSkill(
  ctx: SkillContext | null,
  args: CreateWorkflowSkillArgs
): SkillCreateResult {
  const {
    name,
    description,
    content,
    overwrite = false,
    createdBy = 'external-ai',
    title,
  } = args || {};

  if (!name || !description || !content) {
    return {
      success: false,
      error: { code: 'MISSING_PARAM', message: 'name, description, content are all required' },
    };
  }

  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) || name.length < 3 || name.length > 64) {
    return {
      success: false,
      error: {
        code: 'INVALID_NAME',
        message: `Skill name must be kebab-case (a-z, 0-9, -), 3-64 chars. Got: "${name}"`,
      },
    };
  }

  const builtinSkillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(builtinSkillPath)) {
    return {
      success: false,
      error: {
        code: 'BUILTIN_CONFLICT',
        message: `"${name}" is a built-in Skill and cannot be overwritten. Choose a different name.`,
      },
    };
  }

  const projectSkillsDir = getProjectSkillsDir(ctx ?? undefined);
  const skillDir = path.join(projectSkillsDir, name);
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillPath) && !overwrite) {
    return {
      success: false,
      error: {
        code: 'ALREADY_EXISTS',
        message: `Project skill "${name}" already exists. Set overwrite=true to replace.`,
      },
    };
  }

  try {
    const writeZone = getWriteZone(ctx);
    const resolvedTitle =
      title ||
      (() => {
        const match = (content || '').match(/^#\s+(.+)/m);
        return match ? match[1].trim() : '';
      })();
    const frontmatter = buildSkillFrontmatter({
      name,
      description,
      createdBy,
      title: resolvedTitle,
    });

    if (writeZone) {
      const dataRelSkillDir = skillDir.replace(writeZone.dataRoot, '').replace(/^\//, '');
      const dataRelSkillPath = skillPath.replace(writeZone.dataRoot, '').replace(/^\//, '');
      writeZone.ensureDir(writeZone.data(dataRelSkillDir));
      writeZone.writeFile(writeZone.data(dataRelSkillPath), frontmatter + content);
    } else {
      pathGuard.assertProjectWriteSafe(skillDir);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, frontmatter + content, 'utf8');
    }
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const indexResult = regenerateEditorIndex(ctx ?? undefined);
  removePendingSuggestion(name);
  runSkillCreatedHook(ctx, { name, description, createdBy, path: skillPath });

  return {
    success: true,
    data: {
      skillName: name,
      path: skillPath,
      overwritten: fs.existsSync(skillPath) && overwrite,
      editorIndex: indexResult,
      hint: `Skill "${name}" created. Use alembic_skill({ operation: "load", name: "${name}" }) to verify content.`,
    },
  };
}

function validateSkillQuality(analysisText: string): SkillQualityResult {
  if (!analysisText || analysisText.trim().length < MIN_ANALYSIS_LENGTH) {
    return {
      pass: false,
      reason: `analysisText too short (${analysisText?.trim().length || 0} chars, min ${MIN_ANALYSIS_LENGTH})`,
    };
  }

  const textLines = analysisText.split('\n').filter((line: string) => line.trim().length > 0);
  const normalizedLines = textLines.map(normalizeLine).filter((line: string) => line.length > 0);
  const uniqueNormalized = new Set(normalizedLines);
  const uniqueRatio =
    normalizedLines.length > 0 ? uniqueNormalized.size / normalizedLines.length : 1;
  const maxConsDupes = maxConsecutiveDuplicates(normalizedLines);
  const isRepetitive =
    (normalizedLines.length > 30 && uniqueRatio < HARD_REJECT_RATIO) ||
    maxConsDupes >= CONSECUTIVE_DUPE_THRESHOLD;

  if (isRepetitive) {
    const cleaned = deduplicateConsecutive(analysisText);
    if (cleaned.trim().length >= MIN_ANALYSIS_LENGTH) {
      logger.info(
        `[SkillGenerator] Repetition detected (${uniqueNormalized.size}/${normalizedLines.length} unique, ` +
          `ratio ${uniqueRatio.toFixed(2)}, maxConsec ${maxConsDupes}), salvaged via dedup ` +
          `(${analysisText.length} -> ${cleaned.length} chars)`
      );
      return { pass: true, reason: null, deduplicatedText: cleaned };
    }
    return {
      pass: false,
      reason: `repetitive content detected (${uniqueNormalized.size}/${normalizedLines.length} unique, ratio ${uniqueRatio.toFixed(2)}, maxConsec ${maxConsDupes}) - dedup salvage also too short (${cleaned.trim().length} chars)`,
    };
  }

  const hasStructure =
    /^#{1,3}\s.+/m.test(analysisText) ||
    /^\d+\.\s/m.test(analysisText) ||
    /^[-*•]\s/m.test(analysisText) ||
    /```[\s\S]*?```/.test(analysisText) ||
    /^[-*]\s*[❌⚠✅🔴🟡🟢•]/u.test(analysisText) ||
    /\*\*[^*]+\*\*/.test(analysisText) ||
    analysisText.split(/\n\s*\n/).filter((paragraph: string) => paragraph.trim().length > 0)
      .length >= 3;
  if (!hasStructure && analysisText.length < STRUCTURE_CHECK_THRESHOLD) {
    return { pass: false, reason: 'no structured content detected' };
  }

  return { pass: true, reason: null };
}

function buildSkillContent(
  dim: SkillDimensionDef,
  analysisText: string,
  referencedFiles: string[] = [],
  keyFindings: string[] = [],
  source = 'bootstrap'
) {
  const parts: string[] = [];
  parts.push(`# ${dim.label || dim.id}`);
  parts.push('');
  parts.push(
    `> Auto-generated by Bootstrap (${source}). Sources: ${referencedFiles.length} files analyzed.`
  );
  parts.push('');

  if (keyFindings.length > 0) {
    parts.push('## 关键发现');
    parts.push('');
    for (const finding of keyFindings) {
      parts.push(`- ${finding}`);
    }
    parts.push('');
  }

  parts.push(analysisText);

  if (referencedFiles.length > 0) {
    parts.push('');
    parts.push('## Referenced Files');
    parts.push('');
    for (const file of referencedFiles.slice(0, 20)) {
      parts.push(`- \`${file}\``);
    }
  }

  return parts.filter((part) => part !== undefined).join('\n');
}

function buildSkillFrontmatter({
  name,
  description,
  createdBy,
  title,
}: {
  name: string;
  description: string;
  createdBy: string;
  title: string;
}) {
  const fmLines = ['---', `name: ${name}`];
  if (title) {
    fmLines.push(`title: "${title.replace(/"/g, '\\"')}"`);
  }
  fmLines.push(
    `description: ${description}`,
    `createdBy: ${createdBy}`,
    `createdAt: ${new Date().toISOString()}`,
    '---',
    ''
  );
  return fmLines.join('\n');
}

function regenerateEditorIndex(ctx?: SkillContext | null) {
  try {
    const projectSkills: { name: string; summary: string }[] = [];
    const projectSkillsDir = getProjectSkillsDir(ctx);
    try {
      const dirs = fs
        .readdirSync(projectSkillsDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
      for (const name of dirs) {
        const meta = parseSkillMeta(name, projectSkillsDir);
        projectSkills.push({ name, summary: meta.description });
      }
    } catch {
      /* no project skills dir */
    }

    const writeZone = getWriteZone(ctx);
    const projectRoot = resolveProjectRoot(ctx?.container);
    const rulesDir = path.join(projectRoot, '.cursor', 'rules');

    if (projectSkills.length === 0) {
      try {
        if (writeZone) {
          writeZone.remove(writeZone.project('.cursor/rules/alembic-skills.mdc'));
        } else {
          fs.unlinkSync(path.join(rulesDir, 'alembic-skills.mdc'));
        }
      } catch {
        /* no index */
      }
      return { generated: false, count: 0 };
    }

    const lines = [
      '# Alembic Project Skills Index',
      '',
      'This file is generated automatically. Use alembic_skill to load full skill content.',
      '',
      '## Available Project Skills',
      '',
    ];
    for (const skill of projectSkills) {
      lines.push(`- **${skill.name}**: ${skill.summary}`);
    }
    lines.push('', '## Built-in Skill Hints', '');
    for (const [skillName, useCase] of Object.entries(SKILL_USE_CASES)) {
      lines.push(`- **${skillName}**: ${useCase}`);
    }

    const content = `${lines.join('\n')}\n`;
    if (writeZone) {
      writeZone.ensureDir(writeZone.project('.cursor/rules'));
      writeZone.writeFile(writeZone.project('.cursor/rules/alembic-skills.mdc'), content);
    } else {
      pathGuard.assertProjectWriteSafe(rulesDir);
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'alembic-skills.mdc'), content, 'utf8');
    }
    return { generated: true, count: projectSkills.length };
  } catch (err: unknown) {
    return {
      generated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseSkillMeta(skillName: string, baseDir = SKILLS_DIR) {
  try {
    const content = fs.readFileSync(path.join(baseDir, skillName, 'SKILL.md'), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const meta: { description: string; createdBy: string | null; createdAt: string | null } = {
      description: skillName,
      createdBy: null,
      createdAt: null,
    };
    if (fmMatch) {
      const frontmatter = fmMatch[1];
      const descMatch = frontmatter.match(/^description:\s*(.+?)$/m);
      if (descMatch) {
        const description = descMatch[1].trim();
        const firstSentence = description.split(/\.\s/)[0];
        meta.description =
          firstSentence.length < description.length
            ? `${firstSentence}.`
            : description.substring(0, 120);
      }
      const createdByMatch = frontmatter.match(/^createdBy:\s*(.+?)$/m);
      if (createdByMatch) {
        meta.createdBy = createdByMatch[1].trim();
      }
      const createdAtMatch = frontmatter.match(/^createdAt:\s*(.+?)$/m);
      if (createdAtMatch) {
        meta.createdAt = createdAtMatch[1].trim();
      }
    }
    return meta;
  } catch {
    return { description: skillName, createdBy: null, createdAt: null };
  }
}

function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^[`>]+\s*/, '')
    .replace(/^#{1,3}\s+/, '')
    .replace(/\(来源[:：].*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maxConsecutiveDuplicates(lines: string[]): number {
  let max = 0;
  let current = 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === lines[index - 1] && lines[index].length > 0) {
      current++;
      if (current > max) {
        max = current;
      }
    } else {
      current = 0;
    }
  }
  return max;
}

function deduplicateConsecutive(text: string): string {
  const lines = text.split('\n');
  const result = [lines[0]];
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() !== lines[index - 1].trim() || lines[index].trim().length === 0) {
      result.push(lines[index]);
    }
  }
  return result.join('\n');
}

function getWriteZone(ctx?: SkillContext | null): WriteZone | undefined {
  return ctx?.container?.singletons?.writeZone as WriteZone | undefined;
}

function getProjectSkillsDir(ctx?: SkillContext | null): string {
  return getProjectSkillsPath(resolveDataRoot(ctx?.container));
}

function removePendingSuggestion(name: string): void {
  try {
    const globalState = globalThis as unknown as {
      _signalCollector?: { removePendingSuggestion(name: string): void };
    };
    globalState._signalCollector?.removePendingSuggestion(name);
  } catch {
    /* silent */
  }
}

function runSkillCreatedHook(
  ctx: SkillContext | null,
  payload: { name: string; description: string; createdBy: string; path: string }
): void {
  try {
    const skillHooks = ctx?.container?.get?.('skillHooks') as SkillHooksLike | undefined;
    if (skillHooks?.has?.('onSkillCreated')) {
      skillHooks.run('onSkillCreated', payload).catch(() => {
        /* fire-and-forget */
      });
    }
  } catch {
    /* skillHooks not available */
  }
}
