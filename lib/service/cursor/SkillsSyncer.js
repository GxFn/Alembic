/**
 * SkillsSyncer — AutoSnippet Skills to .cursor/skills/ 同步器
 *
 * Channel C: 将 AutoSnippet/skills/ 下的项目级 SKILL.md 同步到
 * .cursor/skills/autosnippet-{name}/ 目录，适配 Cursor Agent Skills 标准格式。
 *
 * 同时为每个 Skill 生成 references/RECIPES.md（相关 Recipe 摘要）。
 */

import fs from 'node:fs';
import path from 'node:path';

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
};

/**
 * 用途描述模板（英文，Cursor 优先）
 */
const SKILL_DESC_MAP = {
  'autosnippet-architecture': 'Architecture patterns, module boundaries, and dependency rules for {project}. Use when creating new modules, reviewing architecture, or understanding dependencies.',
  'autosnippet-code-standard': 'Coding standards and style conventions for {project}. Use when writing new code, reviewing formatting, or enforcing naming conventions.',
  'autosnippet-profile': 'Project overview and profile for {project}. Use when needing background on the project, its tech stack, or structure.',
  'autosnippet-guidelines': 'Agent interaction guidelines for {project}. Use when understanding how to work with this specific project.',
  'autosnippet-data-flow': 'Event and data flow patterns for {project}. Use when working with events, state management, or data pipelines.',
  'autosnippet-code-pattern': 'Common code patterns and idioms for {project}. Use when implementing features following project conventions.',
  'autosnippet-objc-deep-scan': 'Objective-C deep scan results for {project}. Use when working with Objective-C code, method swizzling, or runtime features.',
  'autosnippet-category-scan': 'Category and extension analysis for {project}. Use when working with categories or finding existing utility methods.',
  'autosnippet-best-practice': 'Best practices and proven patterns for {project}. Use when making design decisions or code review.',
};

export class SkillsSyncer {
  /**
   * @param {string} projectRoot - 用户项目根目录
   * @param {string} projectName - 项目名称
   * @param {Object} [knowledgeService] - 可选，用于生成 references/RECIPES.md
   */
  constructor(projectRoot, projectName = 'Project', knowledgeService = null) {
    this.projectRoot = projectRoot;
    this.projectName = projectName;
    this.knowledgeService = knowledgeService;
    this.sourceDir = path.join(projectRoot, 'AutoSnippet', 'skills');
    this.targetDir = path.join(projectRoot, '.cursor', 'skills');
  }

  /**
   * 执行完整同步流程
   * @returns {{ synced: string[], skipped: string[], errors: string[] }}
   */
  async sync() {
    const result = { synced: [], skipped: [], errors: [] };

    // 检查源目录是否存在
    if (!fs.existsSync(this.sourceDir)) {
      return result;
    }

    // 扫描源目录
    const skillDirs = fs.readdirSync(this.sourceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dirName of skillDirs) {
      try {
        const sourceSkillPath = path.join(this.sourceDir, dirName, 'SKILL.md');
        if (!fs.existsSync(sourceSkillPath)) {
          result.skipped.push(dirName);
          continue;
        }

        const targetName = SKILL_NAME_MAP[dirName] || `autosnippet-${dirName.replace(/^project-/, '')}`;
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
      } catch (err) {
        result.errors.push(`${dirName}: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * 转换 SKILL.md 格式 — 从 AutoSnippet 格式到 Cursor Agent Skills 标准
   * @private
   */
  _convertSkillMd(source, targetName, sourceDirName) {
    // 提取原始内容（去掉 frontmatter）
    const bodyMatch = source.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : source.trim();

    // 获取描述
    const descTemplate = SKILL_DESC_MAP[targetName] || `Knowledge and patterns from {project}. Use when working with ${sourceDirName.replace(/^project-/, '')} related code.`;
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
    return lines.join('\n') + '\n';
  }

  /**
   * 生成 references/RECIPES.md
   * @private
   */
  async _generateRecipes(targetSkillDir, sourceDirName) {
    const refsDir = path.join(targetSkillDir, 'references');
    fs.mkdirSync(refsDir, { recursive: true });

    // 如果有 knowledgeService，查询该维度的 recipes
    let recipes = [];
    if (this.knowledgeService) {
      try {
        const dimension = sourceDirName.replace(/^project-/, '');
        const result = await this.knowledgeService.list(
          { lifecycle: 'active', category: dimension },
          { page: 1, pageSize: 50 }
        );
        recipes = result?.items || result?.data || [];
        if (Array.isArray(result)) recipes = result;
      } catch {
        // 忽略查询错误
      }
    }

    // 生成 RECIPES.md
    const dimensionLabel = sourceDirName.replace(/^project-/, '').replace(/-/g, ' ');
    const lines = [
      `# ${this._capitalizeWords(dimensionLabel)} Recipes`,
      '',
    ];

    if (recipes.length > 0) {
      lines.push('| Title | Trigger | Summary |');
      lines.push('|---|---|---|');
      for (const entry of recipes.slice(0, 20)) {
        const title = (entry.title || '').replace(/\|/g, '/');
        const trigger = entry.trigger || '-';
        const summary = (entry.summaryCn || entry.description || '').replace(/\|/g, '/').slice(0, 80);
        lines.push(`| ${title} | ${trigger} | ${summary} |`);
      }
    } else {
      lines.push('No recipes available yet. Run `asd bootstrap` to generate knowledge.');
    }

    lines.push('');
    lines.push(`For full content, use: \`autosnippet_search("${dimensionLabel}")\``);

    fs.writeFileSync(path.join(refsDir, 'RECIPES.md'), lines.join('\n') + '\n', 'utf8');
  }

  /**
   * 生成使用场景列表
   * @private
   */
  _generateUseCases(sourceDirName) {
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
    };
    return casesMap[sourceDirName] || [
      '- Working with code related to this dimension',
      '- Need guidance on project-specific patterns',
    ];
  }

  /**
   * @private
   */
  _capitalizeWords(str) {
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }
}

export default SkillsSyncer;
