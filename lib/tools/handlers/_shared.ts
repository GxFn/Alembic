/** _shared.js — 多个工具模块共享的常量和辅助函数 */

import path from 'node:path';
import type { UnifiedValidator } from '#domain/knowledge/UnifiedValidator.js';
import { SKILLS_DIR as _SKILLS_DIR, PACKAGE_ROOT } from '#shared/package-root.js';
import type { InternalToolHandlerContext } from '#tools/core/InternalToolHandler.js';

export const PROJECT_ROOT = PACKAGE_ROOT;
/** skills/ 目录绝对路径 */
export const SKILLS_DIR = _SKILLS_DIR;

// Bootstrap 维度展示分组 — 从 DimensionRegistry 自动生成
export { DIMENSION_DISPLAY_GROUP } from '#domain/dimension/DimensionRegistry.js';

/**
 * 基于维度元数据 (dimensionMeta) 检查提交是否合法
 * @param dimensionMeta
 * @param params submit_knowledge 的参数
 * @returns | null} 不合法返回 rejected，合法返回 null
 */
export function checkDimensionType(
  dimensionMeta: DimensionMeta,
  params: Record<string, unknown>,
  logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
  } | null
) {
  // 1. knowledgeType 校验 — 不在允许列表时自动修正为第一个允许类型
  const allowed = dimensionMeta.allowedKnowledgeTypes || [];
  if (allowed.length > 0 && params.knowledgeType) {
    if (!allowed.includes(params.knowledgeType as string)) {
      const corrected = allowed[0];
      logger?.warn(
        `[submit_knowledge] knowledgeType "${params.knowledgeType as string}" → "${corrected}" (auto-corrected for dimension "${dimensionMeta.id}")`
      );
      params.knowledgeType = corrected;
    }
  }

  return null;
}

// ─── Shared tool handler types ─────────────────────────────

/** DI container service lookup (returns dynamic service instances) */
export interface ServiceContainer {
  // biome-ignore lint/suspicious/noExplicitAny: DI container returns dynamic services consumed by many tool modules.
  get(name: string): any;
}

/** Dimension metadata injected by bootstrap pipeline */
export interface DimensionMeta {
  id: string;
  outputType?: string;
  allowedKnowledgeTypes?: string[];
}

/** Common tool handler context provided by InternalToolAdapter/ToolRegistry fallback. */
export interface ToolHandlerContext extends InternalToolHandlerContext {
  container: ServiceContainer;
  projectRoot: string;
  _dimensionMeta?: DimensionMeta;
  _validator?: UnifiedValidator;
}

/**
 * 剥离标题中冗余的项目名前缀（如 "BiliDili 分页控制器" → "分页控制器"）
 * 同一知识库内所有条目都属于同一项目，标题中重复项目名没有信息量。
 */
export function stripProjectNamePrefix(title: string, projectRoot: string): string {
  if (!title || !projectRoot) {
    return title;
  }
  const projectName = path.basename(projectRoot);
  if (!projectName || projectName.length < 2) {
    return title;
  }
  // 匹配: "ProjectName 标题" / "ProjectName的标题" / "ProjectName — 标题"
  const prefix = new RegExp(
    `^${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[的—–-]?\\s*`,
    'i'
  );
  const stripped = title.replace(prefix, '');
  return stripped.length > 0 ? stripped : title;
}
