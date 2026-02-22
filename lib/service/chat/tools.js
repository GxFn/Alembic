/**
 * tools.js — ChatAgent 工具定义统一入口 (Barrel Re-export)
 *
 * 实际工具定义已拆分到 ./tools/ 子目录:
 *   - project-access.js  项目数据访问 (5)
 *   - query.js           查询类 (6)
 *   - ai-analysis.js     AI 分析类 (4)
 *   - knowledge-graph.js  知识图谱 (3)
 *   - guard.js           Guard 安全类 (6)
 *   - lifecycle.js       生命周期操作类 (11)
 *   - infrastructure.js  基础设施 + Skills (7)
 *   - composite.js       组合工具 + 元工具 (6)
 *   - ast-graph.js       AST 分析 + Agent Memory (10)
 *
 * 本文件仅做 re-export，保持向后兼容。
 */

export { ALL_TOOLS, default } from './tools/index.js';
