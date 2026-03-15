/**
 * SkillsSyncer — AutoSnippet Skills to .cursor/skills/ 同步器
 *
 * Channel C: 将内置 Skills 和项目级 Skills 统一同步到
 * .cursor/skills/ 目录，适配 Cursor Agent Skills 标准格式。
 *
 * - 内置 Skills：从 AutoSnippet 包 skills/ 目录直接复制（autosnippet-create 等）
 * - 项目级 Skills：从 AutoSnippet/skills/ 转换格式后写入（project-* → autosnippet-*）
 * - 同时为项目级 Skill 生成 references/RECIPES.md（相关 Recipe 摘要）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../../shared/ProjectMarkers.js';
import { SKILLS_DIR as BUILTIN_SKILLS_DIR } from '../../shared/package-root.js';

/**
 * 技能名称映射：AutoSnippet/skills/ → .cursor/skills/
 * AutoSnippet/skills/ 下面是 bootstrap 动态生成的项目级 skills，
 * 如 project-architecture/, project-code-standard/ 等。
 */
const SKILL_NAME_MAP = {
  'project-architecture': 'autosnippet-architecture',
  'project-code-standard': 'autosnippet-code-standard',
  'project-profile': 'autosnippet-profile',
  'project-agent-guidelines': 'autosnippet-guidelines',
  'project-event-and-data-flow': 'autosnippet-data-flow',
  'project-code-pattern': 'autosnippet-code-pattern',
  'project-objc-deep-scan': 'autosnippet-objc-deep-scan',
  'project-category-scan': 'autosnippet-category-scan',
  'project-best-practice': 'autosnippet-best-practice',
  // 新语言维度
  'project-module-exports': 'autosnippet-module-exports',
  'project-framework-conventions': 'autosnippet-framework-conventions',
  'project-python-structure': 'autosnippet-python-structure',
  'project-jvm-annotations': 'autosnippet-jvm-annotations',
};

/** 用途描述模板（英文，Cursor 优先） */
const SKILL_DESC_MAP = {
  'autosnippet-architecture':
    'Architecture patterns, module boundaries, and dependency rules for {project}. Use when creating new modules, reviewing architecture, or understanding dependencies.',
  'autosnippet-code-standard':
    'Coding standards and style conventions for {project}. Use when writing new code, reviewing formatting, or enforcing naming conventions.',
  'autosnippet-profile':
    'Project overview and profile for {project}. Use when needing background on the project, its tech stack, or structure.',
  'autosnippet-guidelines':
    'Agent interaction guidelines for {project}. Use when understanding how to work with this specific project.',
  'autosnippet-data-flow':
    'Event and data flow patterns for {project}. Use when working with events, state management, or data pipelines.',
  'autosnippet-code-pattern':
    'Common code patterns and idioms for {project}. Use when implementing features following project conventions.',
  'autosnippet-objc-deep-scan':
    'Objective-C deep scan results for {project}. Use when working with Objective-C code, method swizzling, or runtime features.',
  'autosnippet-category-scan':
    'Category and extension analysis for {project}. Use when working with categories or finding existing utility methods.',
  'autosnippet-best-practice':
    'Best practices and proven patterns for {project}. Use when making design decisions or code review.',
  // 新语言维度
  'autosnippet-module-exports':
    'Module export structure, barrel exports, and public API surface for {project}. Use when working with imports/exports or module boundaries.',
  'autosnippet-framework-conventions':
    'Framework-specific conventions (component structure, routing, state management) for {project}. Use when following framework patterns.',
  'autosnippet-python-structure':
    'Python package structure, __init__.py exports, import patterns and type hint coverage for {project}. Use when working with Python modules.',
  'autosnippet-jvm-annotations':
    'Annotation patterns (DI, ORM, API, custom) and meta-programming for {project}. Use when working with Spring, Jakarta, or framework annotations.',
};

export class SkillsSyncer {
  knowledgeService: {
    list: (
      filter: Record<string, unknown>,
      pagination: { page: number; pageSize: number }
    ) => Promise<unknown>;
  } | null;
  projectName: string;
  projectRoot: string;
  sourceDir: string;
  targetDir: string;
  /**
   * @param projectRoot 用户项目根目录
   * @param projectName 项目名称
   * @param [knowledgeService] 可选，用于生成 references/RECIPES.md
   */
  constructor(
    projectRoot: string,
    projectName = 'Project',
    knowledgeService: {
      list: (
        filter: Record<string, unknown>,
        pagination: { page: number; pageSize: number }
      ) => Promise<unknown>;
    } | null = null
  ) {
    this.projectRoot = projectRoot;
    this.projectName = projectName;
    this.knowledgeService = knowledgeService;
    this.sourceDir = path.join(projectRoot, DEFAULT_KNOWLEDGE_BASE_DIR, 'skills');
    this.targetDir = path.join(projectRoot, '.cursor', 'skills');
  }

  /**
   * 执行完整同步流程
   * @returns >}
   */
  async sync() {
    const result = {
      synced: [] as string[],
      skipped: [] as string[],
      errors: [] as string[],
      builtinSynced: [] as string[],
    };

    // ── Phase 1: 同步内置 Skills ──
    this._syncBuiltinSkills(result);

    // ── Phase 2: 同步项目级 Skills ──
    await this._syncProjectSkills(result);

    return result;
  }

  /**
   * 同步内置 Skills：从 AutoSnippet 包 skills/ 目录直接复制到 .cursor/skills/
   */
  _syncBuiltinSkills(result: { builtinSynced: string[]; errors: string[] }) {
    if (!fs.existsSync(BUILTIN_SKILLS_DIR)) {
      return;
    }

    const builtinDirs = fs
      .readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const name of builtinDirs) {
      try {
        const src = path.join(BUILTIN_SKILLS_DIR, name);
        const dest = path.join(this.targetDir, name);
        fs.cpSync(src, dest, { recursive: true, force: true });
        result.builtinSynced.push(name);
      } catch (err: unknown) {
        result.errors.push(`builtin/${name}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 同步项目级 Skills：从 AutoSnippet/skills/ 转换格式后写入 .cursor/skills/
   */
  async _syncProjectSkills(result: { synced: string[]; skipped: string[]; errors: string[] }) {
    // 检查源目录是否存在
    if (!fs.existsSync(this.sourceDir)) {
      return;
    }

    // 扫描源目录
    const skillDirs = fs
      .readdirSync(this.sourceDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const dirName of skillDirs) {
      try {
        const sourceSkillPath = path.join(this.sourceDir, dirName, 'SKILL.md');
        if (!fs.existsSync(sourceSkillPath)) {
          result.skipped.push(dirName);
          continue;
        }

        const targetName =
          (SKILL_NAME_MAP as Record<string, string>)[dirName] ||
          `autosnippet-${dirName.replace(/^project-/, '')}`;
        const targetSkillDir = path.join(this.targetDir, targetName);

        // 创建目标目录
        fs.mkdirSync(targetSkillDir, { recursive: true });

        // 读取源 SKILL.md
        const sourceContent = fs.readFileSync(sourceSkillPath, 'utf8');

        // 转换格式
        const targetContent = this._convertSkillMd(sourceContent, targetName, dirName);

        // 写入目标 SKILL.md
        fs.writeFileSync(path.join(targetSkillDir, 'SKILL.md'), targetContent, 'utf8');

        // 生成 references/RECIPES.md
        await this._generateRecipes(targetSkillDir, dirName);

        result.synced.push(targetName);
      } catch (err: unknown) {
        result.errors.push(`${dirName}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 转换 SKILL.md 格式 — 从 AutoSnippet 格式到 Cursor Agent Skills 标准
   */
  _convertSkillMd(source: string, targetName: string, sourceDirName: string) {
    // 提取原始内容（去掉 frontmatter）
    const bodyMatch = source.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : source.trim();

    // 获取描述
    const descTemplate =
      (SKILL_DESC_MAP as Record<string, string>)[targetName] ||
      `Knowledge and patterns from {project}. Use when working with ${sourceDirName.replace(/^project-/, '')} related code.`;
    const description = descTemplate.replace(/\{project\}/g, this.projectName);

    // 构建 Cursor 标准格式
    const dimensionLabel = sourceDirName.replace(/^project-/, '').replace(/-/g, ' ');
    const lines = [
      '---',
      `name: ${targetName}`,
      `description: "${description}"`,
      '---',
      '',
      `# ${this._capitalizeWords(dimensionLabel)} — ${this.projectName}`,
      '',
      'Use this skill when:',
      ...this._generateUseCases(sourceDirName),
      '',
      '## Instructions',
      '',
      body,
      '',
      '## Deeper Knowledge',
      '',
      `For detailed recipes and code examples:`,
      `- \`autosnippet_search("${dimensionLabel}")\``,
      '',
      '## Referenced Files',
      '',
      'See `references/RECIPES.md` for related recipe summaries.',
    ];
    return `${lines.join('\n')}\n`;
  }

  /**
   * 生成 references/RECIPES.md
   */
  async _generateRecipes(targetSkillDir: string, sourceDirName: string) {
    const refsDir = path.join(targetSkillDir, 'references');
    fs.mkdirSync(refsDir, { recursive: true });

    // 如果有 knowledgeService，查询该维度的 recipes
    let recipes: Record<string, unknown>[] = [];
    if (this.knowledgeService) {
      try {
        const dimension = sourceDirName.replace(/^project-/, '');
        const result = await this.knowledgeService.list(
          { lifecycle: 'active', category: dimension },
          { page: 1, pageSize: 50 }
        );
        const resultObj = result as Record<string, unknown> | unknown[] | null | undefined;
        if (Array.isArray(resultObj)) {
          recipes = resultObj as Record<string, unknown>[];
        } else if (resultObj && typeof resultObj === 'object') {
          recipes = ((resultObj as Record<string, unknown>).items ||
            (resultObj as Record<string, unknown>).data ||
            []) as Record<string, unknown>[];
        }
      } catch {
        // 忽略查询错误
      }
    }

    // 生成 RECIPES.md
    const dimensionLabel = sourceDirName.replace(/^project-/, '').replace(/-/g, ' ');
    const lines = [`# ${this._capitalizeWords(dimensionLabel)} Recipes`, ''];

    if (recipes.length > 0) {
      lines.push('| Title | Trigger | Kind | Lang | Summary |');
      lines.push('|---|---|---|---|---|');
      for (const entry of recipes.slice(0, 20)) {
        const title = ((entry.title as string) || '').replace(/\|/g, '/');
        const trigger = (entry.trigger as string) || '-';
        const kind = (entry.kind as string) || '-';
        const lang = (entry.language as string) || '-';
        const summary = (
          ((entry.summaryCn as string) || (entry.description as string) || '') as string
        )
          .replace(/\|/g, '/')
          .slice(0, 80);
        lines.push(`| ${title} | ${trigger} | ${kind} | ${lang} | ${summary} |`);
      }
    } else {
      lines.push('No recipes available yet. Run `asd bootstrap` to generate knowledge.');
    }

    lines.push('');
    lines.push(`For full content, use: \`autosnippet_search("${dimensionLabel}")\``);

    fs.writeFileSync(path.join(refsDir, 'RECIPES.md'), `${lines.join('\n')}\n`, 'utf8');
  }

  /**
   * 生成使用场景列表
   */
  _generateUseCases(sourceDirName: string) {
    const casesMap = {
      'project-architecture': [
        '- Creating new modules, services, or managers',
        '- Reviewing architectural decisions',
        '- Understanding module boundaries and dependency rules',
      ],
      'project-code-standard': [
        '- Writing new code and need to follow coding standards',
        '- Reviewing code formatting and naming conventions',
        '- Setting up new files with proper structure',
      ],
      'project-profile': [
        '- Need background on the project and tech stack',
        '- Understanding the overall project structure',
        '- Onboarding or getting project context',
      ],
      'project-agent-guidelines': [
        '- Understanding project-specific workflow requirements',
        '- Following project conventions for AI-assisted coding',
      ],
      'project-event-and-data-flow': [
        '- Working with events, notifications, or callbacks',
        '- Implementing data flow or state management',
        '- Understanding how data moves through the system',
      ],
      'project-code-pattern': [
        '- Implementing features using project conventions',
        '- Looking for common code patterns and idioms',
        '- Need a code template for a typical operation',
      ],
      'project-objc-deep-scan': [
        '- Working with Objective-C runtime features',
        '- Understanding method swizzling or hook registries',
        '- Modifying sensitive Objective-C code',
      ],
      'project-category-scan': [
        '- Looking for existing utility methods',
        '- Working with categories or extensions',
        '- Avoiding duplicate implementations',
      ],
      'project-best-practice': [
        '- Making design decisions',
        '- Code review and quality improvements',
        '- Choosing between implementation approaches',
      ],
      'project-module-exports': [
        '- Working with module imports and exports',
        '- Understanding the public API surface',
        '- Refactoring barrel exports or re-export chains',
      ],
      'project-framework-conventions': [
        '- Following framework-specific patterns (React/Vue/Angular)',
        '- Organizing components and routes',
        '- Implementing state management patterns',
      ],
      'project-python-structure': [
        '- Working with Python modules and packages',
        '- Understanding import patterns and __init__.py exports',
        '- Adding type hints or decorators',
      ],
      'project-jvm-annotations': [
        '- Working with dependency injection annotations',
        '- Configuring ORM entities and API endpoints',
        '- Using or creating custom annotations',
      ],
    };
    return (
      (casesMap as Record<string, string[]>)[sourceDirName] || [
        '- Working with code related to this dimension',
        '- Need guidance on project-specific patterns',
      ]
    );
  }

  _capitalizeWords(str: string) {
    return str.replace(/\b\w/g, (c: string) => c.toUpperCase());
  }
}

export default SkillsSyncer;
