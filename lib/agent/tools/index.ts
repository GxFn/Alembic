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

// ── ALL_TOOLS 数组（与原始 tools.js 顺序一致）──
export const ALL_TOOLS = [
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

export default ALL_TOOLS;
