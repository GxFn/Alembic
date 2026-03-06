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

/**
 * 部署策略：
 *   'overwrite'         — AutoSnippet 完全拥有，始终覆盖
 *   'overwrite-dir'     — 递归覆盖整个目录（只覆盖 AutoSnippet 的文件）
 *   'signature-safe'    — 检查 AutoSnippet 签名再覆盖（保护用户自建文件）
 *   'create-only'       — 仅在文件不存在时创建（不更新）
 *   'merge-json'        — JSON 深度合并（只写入 autosnippet 键）
 *   'merge-gitignore'   — 增量追加缺失的 gitignore 规则
 *   'backup-overwrite'  — 备份旧文件后覆盖
 *   'generate'          — 自定义生成逻辑（由 generate 函数处理）
 *   'inject-marker'     — 在 <!-- autosnippet:begin/end --> 标记间注入/替换
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
  },
  {
    id: 'vscode-mcp',
    dest: '.vscode/mcp.json',
    strategy: 'merge-json',
    on: 'both',
    category: 'mcp',
    jsonKey: 'servers',
  },

  // ═══ Cursor Rules（AutoSnippet 完全拥有） ═══════════
  {
    id: 'cursor-conventions',
    src: 'cursor-rules/autosnippet-conventions.mdc',
    dest: '.cursor/rules/autosnippet-conventions.mdc',
    strategy: 'overwrite',
    on: 'both',
    category: 'cursor-rules',
  },
  {
    id: 'cursor-skills-template',
    src: 'cursor-rules/autosnippet-skills.mdc',
    dest: '.cursor/rules/autosnippet-skills.mdc',
    strategy: 'overwrite',
    on: 'both',
    category: 'cursor-rules',
  },
  {
    id: 'cursor-workflow',
    src: 'cursor-rules/autosnippet-workflow.mdc',
    dest: '.cursor/rules/autosnippet-workflow.mdc',
    strategy: 'overwrite',
    on: 'both',
    category: 'cursor-rules',
  },

  // ═══ Cursor Hooks ═════════════════════════════════════
  {
    id: 'cursor-hooks-json',
    src: 'cursor-hooks/hooks.json',
    dest: '.cursor/hooks.json',
    strategy: 'overwrite',
    on: 'both',
    category: 'cursor-hooks',
  },
  {
    id: 'cursor-hooks-dir',
    src: 'cursor-hooks/hooks/',
    dest: '.cursor/hooks/',
    strategy: 'overwrite-dir',
    on: 'both',
    category: 'cursor-hooks',
    chmod: true,
  },

  // ═══ Cursor Commands ══════════════════════════════════
  {
    id: 'cursor-commands',
    src: 'cursor-hooks/commands/',
    dest: '.cursor/commands/',
    strategy: 'overwrite-dir',
    on: 'both',
    category: 'cursor-commands',
  },

  // ═══ Claude Code ══════════════════════════════════════
  {
    id: 'claude-code',
    src: 'claude-code/',
    dest: '.claude/',
    strategy: 'overwrite-dir',
    on: 'both',
    category: 'claude-hooks',
    chmod: true,
    cleanup: ['.claude/hooks.yaml'], // 清理旧格式文件
  },

  // ═══ Agent Instructions（签名保护）════════════════════
  {
    id: 'copilot-instructions',
    src: 'copilot-instructions.md',
    dest: '.github/copilot-instructions.md',
    strategy: 'signature-safe',
    on: 'both',
    category: 'copilot-instructions',
    fallback: 'inject-marker', // 签名保护失败时，用标记注入
  },
  {
    id: 'agents-md',
    strategy: 'generate',
    generate: 'generateAgentsMd',
    dest: 'AGENTS.md',
    on: 'setup',
    category: 'agent-instructions',
  },

  // ═══ CI/CD ════════════════════════════════════════════
  {
    id: 'guard-ci',
    src: 'guard-ci.yml',
    dest: '.github/workflows/autosnippet-guard.yml',
    strategy: 'signature-safe',
    on: 'both',
    category: 'guard-ci',
  },
  {
    id: 'pre-commit',
    src: 'pre-commit-guard.sh',
    dest: null, // 动态决定：.husky/pre-commit 或 .git/hooks/pre-commit
    strategy: 'create-only',
    on: 'manual', // 暂不在 setup 中强制安装 git 工作流
    category: 'pre-commit-hook',
    chmod: true,
    resolveDest: 'resolvePreCommitDest',
  },

  // ═══ Constitution ═════════════════════════════════════
  // setup 由 stepCoreRepo 处理（create-only 语义）
  // upgrade 时备份旧文件后覆盖
  {
    id: 'constitution',
    src: 'constitution.yaml',
    dest: 'AutoSnippet/constitution.yaml',
    strategy: 'backup-overwrite',
    on: 'upgrade',
    category: 'constitution',
    requireDir: 'AutoSnippet',
  },

  // ═══ Gitignore ════════════════════════════════════════
  {
    id: 'gitignore',
    strategy: 'merge-gitignore',
    dest: '.gitignore',
    on: 'both',
    category: 'gitignore',
  },

  // ═══ Skills ═══════════════════════════════════════════
  {
    id: 'skills-install',
    strategy: 'generate',
    generate: 'installSkills',
    on: 'both',
    category: 'skills',
  },
  {
    id: 'skills-ensure-dir',
    strategy: 'generate',
    generate: 'ensureSkillsDir',
    on: 'both',
    category: 'skills',
  },

  // ═══ Dynamic Agent Instructions (requires DB) ════════
  {
    id: 'cursor-delivery',
    strategy: 'generate',
    generate: 'triggerCursorDelivery',
    on: 'upgrade',
    category: 'agent-instructions',
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
  },

  // ═══ VSCode Extension ═════════════════════════════════
  {
    id: 'vscode-extension',
    strategy: 'generate',
    generate: 'installVSCodeExtension',
    on: 'setup',
    category: 'vscode-extension',
  },
];

/**
 * .gitignore 规则清单 — Setup 和 Upgrade 共用
 * 每条规则：{ pattern, comment, negation? }
 */
export const GITIGNORE_RULES = [
  // 核心运行时
  { pattern: '.autosnippet/*', comment: 'AutoSnippet 运行时缓存（不入库）' },
  { pattern: '!.autosnippet/config.json', negation: true },

  // 环境变量
  { pattern: '.env', comment: 'AutoSnippet 环境变量（含 API Key，不入库）' },

  // 日志
  { pattern: 'logs/', comment: 'AutoSnippet 运行日志' },

  // AI 草稿
  { pattern: '.autosnippet-drafts/', comment: 'AutoSnippet AI 草稿（临时）' },
  { pattern: '_draft_*.md', comment: 'AutoSnippet AI 草稿文件（项目根目录临时文件）' },

  // 系统 / 编辑器临时文件
  { pattern: '.DS_Store', comment: 'macOS 元数据' },
  { pattern: 'nohup.out' },
  { pattern: '*.sw[a-p]' },
];

/**
 * .gitignore 迁移规则 — 升级时清理旧格式
 */
export const GITIGNORE_MIGRATIONS = [
  // v2.4.0: ".autosnippet/" → ".autosnippet/*"
  { find: /^\.autosnippet\/$/m, replace: '.autosnippet/*' },
  // Skills 已迁移到 AutoSnippet/skills/，清理旧 negation
  { find: /^!?\.autosnippet\/skills\/.*\n?/gm, replace: '' },
];

/**
 * MCP Server 配置生成器
 * @param {string} projectRoot
 * @param {'cursor'|'vscode'} ide
 */
export function buildMcpServerEntry(projectRoot, ide) {
  const base = {
    command: 'asd-mcp',
    env: { ASD_PROJECT_DIR: projectRoot },
  };
  if (ide === 'vscode') {
    return { type: 'stdio', ...base };
  }
  return base;
}
