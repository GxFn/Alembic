/**
 * _shared.js — 多个工具模块共享的常量和辅助函数
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
/** skills/ 目录绝对路径 */
export const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'skills');
/** 项目级 skills 目录 */
export const PROJECT_SKILLS_DIR = path.resolve(PROJECT_ROOT, '.autosnippet', 'skills');

// Bootstrap 维度展示分组 — 将 9 个细粒度维度合并为 4 个展示组
export const DIMENSION_DISPLAY_GROUP = {
  architecture: 'architecture', // → 架构与设计
  'code-pattern': 'architecture', // → 架构与设计
  'project-profile': 'architecture', // → 架构与设计
  'best-practice': 'best-practice', // → 规范与实践
  'code-standard': 'best-practice', // → 规范与实践
  'event-and-data-flow': 'event-and-data-flow', // → 事件与数据流
  'objc-deep-scan': 'objc-deep-scan', // → 深度扫描
  'category-scan': 'objc-deep-scan', // → 深度扫描
  'agent-guidelines': 'agent-guidelines', // skill-only
};

/**
 * 基于维度元数据 (dimensionMeta) 检查提交是否合法
 * @param {{ id: string, outputType: 'candidate'|'skill'|'dual', allowedKnowledgeTypes: string[] }} dimensionMeta
 * @param {object} params - submit_knowledge 的参数
 * @param {object} [logger]
 * @returns {{ status: string, reason: string } | null} 不合法返回 rejected，合法返回 null
 */
export function checkDimensionType(dimensionMeta, params, logger) {
  // 1. Skill-only 维度不允许提交 Candidate
  if (dimensionMeta.outputType === 'skill') {
    logger?.info(
      `[submit_knowledge] ✗ rejected — dimension "${dimensionMeta.id}" is skill-only, cannot submit candidates`
    );
    return {
      status: 'rejected',
      reason: `当前维度 "${dimensionMeta.id}" 的输出类型为 skill-only，不允许调用 submit_knowledge。请只在最终回复中提供 dimensionDigest JSON。`,
    };
  }

  // 2. knowledgeType 校验 — 不在允许列表时自动修正为第一个允许类型
  const allowed = dimensionMeta.allowedKnowledgeTypes || [];
  if (allowed.length > 0 && params.knowledgeType) {
    if (!allowed.includes(params.knowledgeType)) {
      const corrected = allowed[0];
      logger?.warn(
        `[submit_knowledge] knowledgeType "${params.knowledgeType}" → "${corrected}" (auto-corrected for dimension "${dimensionMeta.id}")`
      );
      params.knowledgeType = corrected;
    }
  }

  return null;
}
