/**
 * Shared type definitions for bootstrap & rescan handler modules.
 *
 * Consolidates interfaces previously duplicated across:
 *   - bootstrap-internal.ts
 *   - bootstrap-external.ts
 *   - rescan-internal.ts
 *   - rescan-external.ts
 *
 * v2: 类型统一到 project-snapshot.ts，本文件 re-export + 提供向后兼容别名。
 *
 * @module bootstrap/shared/handler-types
 */

// ── 统一类型来源 (project-snapshot.ts) ────────────────────

export type {
  BootstrapSessionShape,
  DimensionDef,
  GuardAuditFileEntry as GuardAuditFile,
  GuardViolation,
  MissionBriefingResult,
} from '#types/project-snapshot.js';

// ── Target / File ─────────────────────────────────────────

/** Processed source file with language + priority metadata */
export interface TargetFile {
  name: string;
  relativePath: string;
  language: string;
  totalLines: number;
  priority: string;
  content: string;
  truncated: boolean;
}
