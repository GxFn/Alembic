/**
 * FileManifest — 所有可部署文件的单一真实来源
 *
 * Setup 和 Upgrade 共享同一份清单，由 FileDeployer 按策略执行。
 *
 * 字段说明：
 *   id        — 唯一标识（用于日志和结果报告）
 *   src       — 模板相对路径（相对于 templates/），null 表示需要 generate 函数
 *   dest      — 目标相对路径（相对于 projectRoot）
 *   strategy  — 部署策略（见 FileDeployer.STRATEGIES）
 *   on        — 适用场景：'both' | 'setup' | 'upgrade'
 *   chmod     — 是否需要 chmod +x（.sh 文件）
 *   generate  — 自定义生成函数名（strategy 为 'generate' 时使用）
 *   category  — 分组标签（用于 stepIDE 结果汇报）
 */

import { DEFAULT_KNOWLEDGE_BASE_DIR } from '../../shared/ProjectMarkers.js';

/**
 * 部署策略：
 *   'overwrite'         — Alembic 完全拥有，始终覆盖
 *   'overwrite-dir'     — 递归覆盖整个目录（只覆盖 Alembic 的文件）
 *   'signature-safe'    — 检查 Alembic 签名再覆盖（保护用户自建文件）
 *   'create-only'       — 仅在文件不存在时创建（不更新）
 *   'merge-json'        — JSON 深度合并（只写入 alembic 键）
 *   'merge-gitignore'   — 增量追加缺失的 gitignore 规则
 *   'backup-overwrite'  — 备份旧文件后覆盖
 *   'generate'          — 自定义生成逻辑（由 generate 函数处理）
 *   'inject-marker'     — 在 <!-- alembic:begin/end --> 标记间注入/替换
 *
 * ghostPolicy（Ghost 模式部署行为）：
 *   'deploy'    — 仍然部署到项目内（如 AGENTS.md, copilot-instructions, .gitignore）
 *   'skip'      — Ghost 模式下跳过（如 .cursor/rules）
 *   'global'    — 部署到全局配置而非项目（如 MCP config）
 *   undefined   — 默认行为同 'skip'
 */

export const MANIFEST = [
  // ═══ MCP Config ═══════════════════════════════════════
  {
    id: 'cursor-mcp',
    dest: '.cursor/mcp.json',
    strategy: 'merge-json',
    on: 'both',
    category: 'mcp',
    jsonKey: 'mcpServers',
    ghostPolicy: 'global' as const,
  },
  {
    id: 'vscode-mcp',
    dest: '.vscode/mcp.json',
    strategy: 'merge-json',
    on: 'both',
    category: 'mcp',
    jsonKey: 'servers',
    ghostPolicy: 'global' as const,
  },

  // ═══ Cursor Rules（Alembic 完全拥有） ═══════════
  {
    id: 'cursor-conventions',
    strategy: 'generate',
    generate: 'generateConventionsMdc',
    dest: '.cursor/rules/alembic-conventions.mdc',
    on: 'both',
    category: 'cursor-rules',
    ghostPolicy: 'deploy' as const,
  },
  {
    id: 'cursor-skills-template',
    src: 'cursor-rules/alembic-skills.mdc',
    dest: '.cursor/rules/alembic-skills.mdc',
    strategy: 'overwrite',
    on: 'both',
    category: 'cursor-rules',
    ghostPolicy: 'deploy' as const,
  },

  // ═══ Agent Instructions（全部从模板生成）═══════════════
  {
    id: 'copilot-instructions',
    strategy: 'generate',
    generate: 'generateCopilotInstructions',
    dest: '.github/copilot-instructions.md',
    on: 'both',
    category: 'copilot-instructions',
    ghostPolicy: 'deploy' as const,
  },
  {
    id: 'agents-md',
    strategy: 'generate',
    generate: 'generateAgentsMd',
    dest: 'AGENTS.md',
    on: 'setup',
    category: 'agent-instructions',
    ghostPolicy: 'deploy' as const,
  },

  // ═══ Constitution ═════════════════════════════════════
  // setup 由 stepCoreRepo 处理（create-only 语义）
  // upgrade 时备份旧文件后覆盖
  {
    id: 'constitution',
    src: 'constitution.yaml',
    dest: `${DEFAULT_KNOWLEDGE_BASE_DIR}/constitution.yaml`,
    strategy: 'backup-overwrite',
    on: 'upgrade',
    category: 'constitution',
    requireDir: DEFAULT_KNOWLEDGE_BASE_DIR,
    ghostPolicy: 'skip' as const,
  },

  // ═══ Gitignore ════════════════════════════════════════
  {
    id: 'gitignore',
    strategy: 'merge-gitignore',
    dest: '.gitignore',
    on: 'both',
    category: 'gitignore',
    ghostPolicy: 'deploy' as const,
  },

  // ═══ Skills ═══════════════════════════════════════════
  {
    id: 'skills-install',
    strategy: 'generate',
    generate: 'installSkills',
    on: 'both',
    category: 'skills',
    ghostPolicy: 'deploy' as const,
  },
  {
    id: 'skills-ensure-dir',
    strategy: 'generate',
    generate: 'ensureSkillsDir',
    on: 'both',
    category: 'skills',
    ghostPolicy: 'deploy' as const,
  },

  // ═══ Dynamic Agent Instructions (requires DB) ════════
  {
    id: 'cursor-delivery',
    strategy: 'generate',
    generate: 'triggerCursorDelivery',
    on: 'upgrade',
    category: 'agent-instructions',
    ghostPolicy: 'skip' as const,
  },

  // ═══ Auto-approve injection ═══════════════════════════
  // setup 不注入 autoApprove — 让用户首次使用时亲眼授权每个工具
  // bootstrap 成功后由 bootstrap-external.js 自动注入
  {
    id: 'auto-approve',
    strategy: 'generate',
    generate: 'injectAutoApprove',
    on: 'upgrade',
    category: 'mcp',
    ghostPolicy: 'global' as const,
  },

  // ═══ VSCode Extension ═════════════════════════════════
  {
    id: 'vscode-extension',
    strategy: 'generate',
    generate: 'installVSCodeExtension',
    on: 'setup',
    category: 'vscode-extension',
    ghostPolicy: 'deploy' as const,
  },
];

/**
 * .gitignore 规则清单 — Setup 和 Upgrade 共用
 * 每条规则：{ pattern, comment, negation? }
 */
/**
 * Section markers for the Alembic block inside .gitignore.
 * merge-gitignore uses these to insert/replace the entire block atomically.
 */
export const GITIGNORE_SECTION_BEGIN = '# >>> Alembic (managed block — do not edit) >>>';
export const GITIGNORE_SECTION_END = '# <<< Alembic <<<';

/**
 * Alembic-specific .gitignore rules.
 * Only patterns that are Alembic runtime/build artifacts belong here.
 * Generic OS/editor patterns (.DS_Store, *.swp, nohup.out) are NOT our business.
 */
export const GITIGNORE_RULES = [
  // Runtime cache
  { pattern: '.asd/*', comment: '运行时缓存（不入库）' },
  { pattern: '!.asd/config.json', negation: true },

  // Environment (contains API keys created by `alembic setup`)
  { pattern: '.env', comment: '环境变量（含 API Key）' },

  // Logs（已收纳到 .asd/ 下，由 .asd/* 统一覆盖）
];

/** .gitignore 迁移规则 — 升级时清理旧格式 */
export const GITIGNORE_MIGRATIONS: { find: RegExp; replace: string }[] = [];

/** MCP Server 配置生成器 */
export function buildMcpServerEntry(projectRoot: string, ide: 'cursor' | 'vscode', global = false) {
  // 项目级配置支持 ${workspaceFolder}；全局配置必须用绝对路径
  const base = {
    command: 'alembic-mcp',
    env: { ALEMBIC_PROJECT_DIR: global ? projectRoot : '${workspaceFolder}' },
  };
  if (ide === 'vscode') {
    return { type: 'stdio', ...base };
  }
  return base;
}
