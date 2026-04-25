/**
 * tools/index.js — Barrel 导出文件
 *
 * 从各子模块导入所有工具，按原始顺序组装 ALL_TOOLS 数组并导出。
 */

// ── AI 分析类 (2) ──
import { enrichCandidate, refineBootstrapCandidates } from './ai-analysis.js';
// ── AST 结构化分析 + Agent Memory (11) ──
import {
  getCategoryMap,
  getClassHierarchy,
  getClassInfo,
  getMethodOverrides,
  getPreviousAnalysis,
  getPreviousEvidence,
  getProjectOverview,
  getProtocolInfo,
  noteFinding,
  queryCallGraph,
  queryCodeGraph,
} from './ast-graph.js';
// ── 组合工具 + 元工具 (6) ──
import {
  analyzeCode,
  getToolDetails,
  knowledgeOverview,
  planTask,
  reviewMyOutput,
  submitWithCheck,
} from './composite.js';
// ── Evolution Agent 工具 (3) ──
import { confirmDeprecation, proposeEvolution, skipEvolution } from './evolution-tools.js';
// ── Guard 安全类 (4) ──
import { getRecommendations, guardCheckCode, listGuardRules, queryViolations } from './guard.js';
// ── 基础设施类 (7) ──
import {
  bootstrapKnowledgeTool,
  createSkillTool,
  graphImpactAnalysis,
  loadSkill,
  queryAuditLog,
  rebuildIndex,
  suggestSkills,
} from './infrastructure.js';
// ── 知识图谱类 (2) ──
import { addGraphEdge, checkDuplicate } from './knowledge-graph.js';
// ── 生命周期操作类 (11) ──
import {
  approveCandidate,
  deprecateRecipe,
  getFeedbackStats,
  publishRecipe,
  qualityScore,
  recordUsage,
  rejectCandidate,
  submitCandidate,
  updateRecipe,
  validateCandidate,
} from './lifecycle.js';
// ── 项目数据访问 (5) ──
import {
  getFileSummary,
  listProjectStructure,
  readProjectFile,
  searchProjectCode,
  semanticSearchCode,
} from './project-access.js';
// ── 查询类 (6) ──
import {
  getProjectStats,
  getRecipeDetail,
  getRelatedRecipes,
  searchCandidates,
  searchKnowledge,
  searchRecipes,
} from './query.js';
// ── 扫描 Recipe 收集 (1) ──
import { collectScanRecipe } from './scan-recipe.js';
// ── 系统交互类 (3) ──
import { getEnvironmentInfo, runSafeCommand, writeProjectFile } from './system-interaction.js';
import type { ToolDefinition, ToolMetadata } from './ToolRegistry.js';

// ── Re-export 所有工具 ──
export {
  // 项目数据访问
  searchProjectCode,
  readProjectFile,
  listProjectStructure,
  getFileSummary,
  semanticSearchCode,
  // 查询类
  searchRecipes,
  searchCandidates,
  getRecipeDetail,
  getProjectStats,
  searchKnowledge,
  getRelatedRecipes,
  // AI 分析类
  enrichCandidate,
  refineBootstrapCandidates,
  // Guard 安全类
  listGuardRules,
  getRecommendations,
  guardCheckCode,
  queryViolations,
  // 知识图谱类
  checkDuplicate,
  addGraphEdge,
  // 生命周期操作类
  submitCandidate,
  approveCandidate,
  rejectCandidate,
  publishRecipe,
  deprecateRecipe,
  updateRecipe,
  recordUsage,
  qualityScore,
  validateCandidate,
  getFeedbackStats,
  // 基础设施类
  graphImpactAnalysis,
  rebuildIndex,
  queryAuditLog,
  loadSkill,
  createSkillTool,
  suggestSkills,
  bootstrapKnowledgeTool,
  // 组合工具 + 元工具
  analyzeCode,
  knowledgeOverview,
  submitWithCheck,
  getToolDetails,
  planTask,
  reviewMyOutput,
  // AST 结构化分析
  getProjectOverview,
  getClassHierarchy,
  getClassInfo,
  getProtocolInfo,
  getMethodOverrides,
  getCategoryMap,
  getPreviousAnalysis,
  // Agent Memory
  noteFinding,
  getPreviousEvidence,
  // 代码实体图谱
  queryCodeGraph,
  // 调用图查询 (Phase 5)
  queryCallGraph,
  // 扫描 Recipe 收集
  collectScanRecipe,
  // 系统交互类
  runSafeCommand,
  writeProjectFile,
  getEnvironmentInfo,
  // Evolution Agent 工具
  proposeEvolution,
  confirmDeprecation,
  skipEvolution,
};

const HTTP_DIRECT_TOOL_NAMES = new Set([
  'search_project_code',
  'read_project_file',
  'list_project_structure',
  'get_file_summary',
  'semantic_search_code',
  'search_recipes',
  'search_candidates',
  'get_recipe_detail',
  'get_project_stats',
  'search_knowledge',
  'get_related_recipes',
  'list_guard_rules',
  'get_recommendations',
  'guard_check_code',
  'query_violations',
  'check_duplicate',
  'quality_score',
  'validate_candidate',
  'get_feedback_stats',
  'graph_impact_analysis',
  'query_audit_log',
  'load_skill',
  'suggest_skills',
  'analyze_code',
  'knowledge_overview',
  'get_tool_details',
  'plan_task',
  'review_my_output',
  'get_project_overview',
  'get_class_hierarchy',
  'get_class_info',
  'get_protocol_info',
  'get_method_overrides',
  'get_category_map',
  'get_previous_analysis',
  'get_previous_evidence',
  'query_code_graph',
  'query_call_graph',
  'get_environment_info',
]);

const SIDE_EFFECT_TOOL_NAMES = new Set([
  'run_safe_command',
  'write_project_file',
  'submit_knowledge',
  'submit_with_check',
  'approve_candidate',
  'reject_candidate',
  'publish_recipe',
  'deprecate_recipe',
  'update_recipe',
  'record_usage',
  'add_graph_edge',
  'rebuild_index',
  'create_skill',
  'bootstrap_knowledge',
  'enrich_candidate',
  'refine_bootstrap_candidates',
  'note_finding',
  'collect_scan_recipe',
  'propose_evolution',
  'confirm_deprecation',
  'skip_evolution',
]);

const TOOL_GATEWAY_METADATA = new Map<
  string,
  Pick<ToolMetadata, 'gatewayAction' | 'gatewayResource'>
>([
  ['search_project_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['read_project_file', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['list_project_structure', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_file_summary', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['semantic_search_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['search_recipes', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_recipe_detail', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_project_stats', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['search_knowledge', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_related_recipes', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['check_duplicate', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['quality_score', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_feedback_stats', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['graph_impact_analysis', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['knowledge_overview', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['get_recommendations', { gatewayAction: 'read:recipes', gatewayResource: 'recipes' }],
  ['search_candidates', { gatewayAction: 'read:candidates', gatewayResource: 'candidates' }],
  ['list_guard_rules', { gatewayAction: 'read:guard_rules', gatewayResource: 'guard_rules' }],
  ['query_violations', { gatewayAction: 'read:guard_rules', gatewayResource: 'guard_rules' }],
  ['guard_check_code', { gatewayAction: 'guard_rule:check_code', gatewayResource: 'guard_rules' }],
  ['query_audit_log', { gatewayAction: 'read:audit_logs', gatewayResource: '/audit_logs/self' }],
  ['load_skill', { gatewayAction: 'read:skills', gatewayResource: 'skills' }],
  ['suggest_skills', { gatewayAction: 'read:skills', gatewayResource: 'skills' }],
  ['get_tool_details', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['plan_task', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['review_my_output', { gatewayAction: 'read:agent_tools', gatewayResource: 'agent_tools' }],
  ['validate_candidate', { gatewayAction: 'validate:candidates', gatewayResource: 'candidates' }],
  ['analyze_code', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_project_overview', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_class_hierarchy', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_class_info', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_protocol_info', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_method_overrides', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_category_map', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_previous_analysis', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_previous_evidence', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['query_code_graph', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['query_call_graph', { gatewayAction: 'read:project', gatewayResource: 'project' }],
  ['get_environment_info', { gatewayAction: 'read:environment', gatewayResource: 'environment' }],
]);

const TOOL_POLICY_PROFILES = new Map<string, ToolMetadata['policyProfile']>([
  ['run_safe_command', 'system'],
  ['write_project_file', 'write'],
  ['rebuild_index', 'admin'],
  ['bootstrap_knowledge', 'admin'],
  ['create_skill', 'write'],
  ['guard_check_code', 'analysis'],
  ['validate_candidate', 'analysis'],
  ['analyze_code', 'analysis'],
  ['plan_task', 'analysis'],
  ['review_my_output', 'analysis'],
]);

const TOOL_ABORT_MODES = new Map<string, ToolMetadata['abortMode']>([
  ['run_safe_command', 'hardTimeout'],
  ['search_project_code', 'cooperative'],
  ['semantic_search_code', 'cooperative'],
  ['list_project_structure', 'cooperative'],
  ['guard_check_code', 'cooperative'],
  ['rebuild_index', 'cooperative'],
  ['bootstrap_knowledge', 'cooperative'],
]);

const NON_COMPOSABLE_TOOL_NAMES = new Set([
  'get_tool_details',
  'plan_task',
  'review_my_output',
  'get_environment_info',
]);

function inferPolicyProfile(toolName: string, sideEffect: boolean): ToolMetadata['policyProfile'] {
  const explicit = TOOL_POLICY_PROFILES.get(toolName);
  if (explicit) {
    return explicit;
  }
  return sideEffect ? 'write' : 'read';
}

function inferSurface(tool: ToolDefinition, directCallable: boolean): ToolMetadata['surface'] {
  if (tool.metadata?.surface) {
    return tool.metadata.surface;
  }
  return directCallable ? ['runtime', 'http'] : ['runtime'];
}

function inferAuditLevel(
  gatewayMetadata: Pick<ToolMetadata, 'gatewayAction' | 'gatewayResource'>,
  sideEffect: boolean
): ToolMetadata['auditLevel'] {
  if (sideEffect) {
    return 'full';
  }
  return gatewayMetadata.gatewayAction ? 'checkOnly' : 'none';
}

function withToolMetadata(tool: ToolDefinition): ToolDefinition {
  const gatewayMetadata = TOOL_GATEWAY_METADATA.get(tool.name) || {};
  const directCallable = HTTP_DIRECT_TOOL_NAMES.has(tool.name);
  const sideEffect = SIDE_EFFECT_TOOL_NAMES.has(tool.name);
  const metadata: ToolMetadata = {
    ...(tool.metadata || {}),
    ...gatewayMetadata,
    surface: inferSurface(tool, directCallable),
    directCallable,
    sideEffect,
    composable: !sideEffect && !NON_COMPOSABLE_TOOL_NAMES.has(tool.name),
    policyProfile: inferPolicyProfile(tool.name, sideEffect),
    auditLevel: inferAuditLevel(gatewayMetadata, sideEffect),
    abortMode: TOOL_ABORT_MODES.get(tool.name) || (sideEffect ? 'preStart' : 'none'),
  };
  return { ...tool, metadata };
}

// ── ALL_TOOLS 数组（与原始 tools.js 顺序一致）──
const RAW_TOOLS: ToolDefinition[] = [
  // 项目数据访问 (5) — 含 v10 Agent-Pull 工具
  searchProjectCode,
  readProjectFile,
  listProjectStructure,
  getFileSummary,
  semanticSearchCode,
  // 查询类 (8)
  searchRecipes,
  searchCandidates,
  getRecipeDetail,
  getProjectStats,
  searchKnowledge,
  getRelatedRecipes,
  listGuardRules,
  getRecommendations,
  // AI 分析类 (2)
  enrichCandidate,
  refineBootstrapCandidates,
  // Guard 安全类 (2)
  guardCheckCode,
  queryViolations,
  // 生命周期操作类 (7)
  submitCandidate,
  approveCandidate,
  rejectCandidate,
  publishRecipe,
  deprecateRecipe,
  updateRecipe,
  recordUsage,
  // 质量与反馈类 (3)
  qualityScore,
  validateCandidate,
  getFeedbackStats,
  // 知识图谱类 (2)
  checkDuplicate,
  addGraphEdge,
  // 基础设施类 (3)
  graphImpactAnalysis,
  rebuildIndex,
  queryAuditLog,
  // Skills & Bootstrap (4)
  loadSkill,
  createSkillTool,
  suggestSkills,
  bootstrapKnowledgeTool,
  // 组合工具 (3) — 减少 ReAct 轮次
  analyzeCode,
  knowledgeOverview,
  submitWithCheck,
  // 元工具 (3) — Agent 自主能力增强
  getToolDetails,
  planTask,
  reviewMyOutput,
  // AST 结构化分析 (7) — v3.0 AI-First Bootstrap
  getProjectOverview,
  getClassHierarchy,
  getClassInfo,
  getProtocolInfo,
  getMethodOverrides,
  getCategoryMap,
  getPreviousAnalysis,
  // Agent Memory 增强 (2) — 工作记忆 + 情景记忆
  noteFinding,
  getPreviousEvidence,
  // 代码实体图谱 (1) — Phase E
  queryCodeGraph,
  // 调用图查询 (1) — Phase 5
  queryCallGraph,
  // 系统交互 (3) — Agent 终端/文件写入/环境探测
  runSafeCommand,
  writeProjectFile,
  getEnvironmentInfo,
  // 扫描 Recipe 收集 (1) — scanKnowledge produce 阶段专用
  collectScanRecipe,
  // Evolution Agent 工具 (3) — 提案驱动的 Recipe 进化决策
  proposeEvolution,
  confirmDeprecation,
  skipEvolution,
];

export const ALL_TOOLS = RAW_TOOLS.map(withToolMetadata);

export default ALL_TOOLS;
