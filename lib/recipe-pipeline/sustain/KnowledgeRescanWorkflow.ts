/**
 * KnowledgeRescanWorkflow（兼容壳）
 *
 * 结构清洗 W3——本体迁至 generate/incremental/；保留兼容 re-export。
 * 增量重扫是 GenerateWorkflow mode='incremental' 的实现，归属 generate 环：
 *   - 编排器：generate/incremental/IncrementalRescanWorkflow.ts
 *   - coverage ledger 写入：generate/incremental/RescanCoverageLedgerWriter.ts
 * 注意：本壳不再承载 registerGenerateWorkflowImplementation 注册副作用
 * （注册随本体移动，GenerateWorkflow 懒加载路径已指向新家）。
 * 本壳仅为漏网旧导入兜底，一个波次后评估退役。
 */

export { runKnowledgeRescanWorkflow } from '../generate/incremental/IncrementalRescanWorkflow.js';
export {
  type KnowledgeRescanCoverageLedgerSkippedResult,
  type KnowledgeRescanCoverageLedgerWriteInput,
  type KnowledgeRescanCoverageLedgerWriteResult,
  writeKnowledgeRescanCoverageLedgerForDimension,
} from '../generate/incremental/RescanCoverageLedgerWriter.js';
