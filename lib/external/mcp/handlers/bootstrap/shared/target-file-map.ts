/**
 * Build targetFileMap from collected source files.
 *
 * Previously duplicated in:
 *   - bootstrap-internal.ts (Phase 4.5)
 *   - rescan-internal.ts (Step 6)
 *
 * @module bootstrap/shared/target-file-map
 */

import { inferLang } from '#external/mcp/handlers/LanguageExtensions.js';
import { inferFilePriority } from '#external/mcp/handlers/TargetClassifier.js';
import type { TargetFile } from './handler-types.js';

/** Minimal file shape required by buildTargetFileMap */
interface SourceFile {
  name: string;
  relativePath: string;
  targetName: string;
  content: string;
}

/**
 * Build a map of target → TargetFile[] from collected source files.
 *
 * @param allFiles  - Collected source files from Phase 1
 * @param contentMaxLines - Max lines to include in content (default: 120)
 * @param sort - Whether to sort files by priority within each target (default: false)
 * @returns Record<targetName, TargetFile[]>
 */
export function buildTargetFileMap(
  allFiles: SourceFile[],
  contentMaxLines: number,
  sort = false
): Record<string, TargetFile[]> {
  const targetFileMap: Record<string, TargetFile[]> = {};

  for (const f of allFiles) {
    if (!targetFileMap[f.targetName]) {
      targetFileMap[f.targetName] = [];
    }
    const lines = f.content.split('\n');
    targetFileMap[f.targetName].push({
      name: f.name,
      relativePath: f.relativePath,
      language: inferLang(f.name),
      totalLines: lines.length,
      priority: inferFilePriority(f.name),
      content: lines.slice(0, contentMaxLines).join('\n'),
      truncated: lines.length > contentMaxLines,
    });
  }

  if (sort) {
    const prio: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (const tName of Object.keys(targetFileMap)) {
      targetFileMap[tName].sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1));
    }
  }

  return targetFileMap;
}
