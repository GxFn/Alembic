/**
 * tools/index.js — Barrel 导出文件
 *
 * 从各子模块导入所有工具，按原始顺序组装 ALL_TOOLS 数组并导出。
 */

// ── AI 分析类 (4) ──
import {
  enrichCandidate,
  extractRecipes,
  refineBootstrapCandidates,
  summarizeCode,
} from './ai-analysis.js';
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

// ── Guard 安全类 (6) ──
import {
  aiTranslate,
  generateGuardRule,
  getRecommendations,
  guardCheckCode,
  listGuardRules,
  queryViolations,
} from './guard.js';
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
// ── 知识图谱类 (3) ──
import { addGraphEdge, checkDuplicate, discoverRelations } from './knowledge-graph.js';
// ── 生命周期操作类 (11) ──
import {
  approveCandidate,
  deprecateRecipe,
  getFeedbackStats,
  publishRecipe,
  qualityScore,
  recordUsage,
  rejectCandidate,
  saveDocument,
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
  summarizeCode,
  extractRecipes,
  enrichCandidate,
  refineBootstrapCandidates,
  // Guard 安全类
  listGuardRules,
  getRecommendations,
  aiTranslate,
  guardCheckCode,
  queryViolations,
  generateGuardRule,
  // 知识图谱类
  checkDuplicate,
  discoverRelations,
  addGraphEdge,
  // 生命周期操作类
  submitCandidate,
  saveDocument,
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
  // AI 分析类 (5)
  summarizeCode,
  extractRecipes,
  enrichCandidate,
  refineBootstrapCandidates,
  aiTranslate,
  // Guard 安全类 (3)
  guardCheckCode,
  queryViolations,
  generateGuardRule,
  // 生命周期操作类 (7)
  submitCandidate,
  saveDocument,
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
  // 知识图谱类 (3)
  checkDuplicate,
  discoverRelations,
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
];

export default ALL_TOOLS;
