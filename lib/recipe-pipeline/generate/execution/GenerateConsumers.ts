/**
 * 结构清洗 W2——五职责拆分至 consumers/ 与 skill-delivery/SkillConsumer；
 * 本文件保留为兼容 re-export，旧导入零断裂。
 *
 *   - consumers/DimensionResultConsumer.ts：单维度结果/错误消费（checkpoint/统计/事件/PCV 证据）
 *   - consumers/CandidateAccounting.ts：候选记账 + [Producer] 汇总日志（unique 双口径）
 *   - consumers/SessionResultConsumer.ts：会话结果合并与缺失维度检测
 *   - consumers/TierReflectionConsumer.ts：分层反思生成
 *   - skill-delivery/SkillConsumer.ts：skillWorthy 维度的 Project Skill 生成
 */

export * from './consumers/index.js';
