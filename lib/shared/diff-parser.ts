/**
 * diff-parser — Git diff 获取与解析
 *
 * 通过 `git diff -U0` 获取文件的行级变更内容，
 * 解析 unified diff 格式，提取变更行中的代码标识符。
 *
 * @module shared/diff-parser
 */

import { execFileSync } from 'node:child_process';
import { tokenizeIdentifiers } from '../service/evolution/ContentImpactAnalyzer.js';

/* ────────────── Types ────────────── */

export interface DiffHunk {
  /** 删除的行（- 前缀，已去掉前缀） */
  removedLines: string[];
  /** 新增的行（+ 前缀，已去掉前缀） */
  addedLines: string[];
}

/* ────────────── Public API ────────────── */

/**
 * 获取文件的 git diff 内容（unified format，零上下文行）。
 *
 * @param projectRoot 项目根目录绝对路径
 * @param relativePath 相对于项目根的文件路径
 * @returns diff 文本，或 null（无 git / untracked / 无变更）
 */
export function getFileDiff(projectRoot: string, relativePath: string): string | null {
  try {
    // git diff HEAD -U0 -- file：包含 staged + unstaged 的变更
    const output = execFileSync('git', ['diff', 'HEAD', '-U0', '--', relativePath], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * 解析 unified diff 文本，提取变更行。
 *
 * 忽略 @@ 头、文件头（---/+++）、上下文行（无 +/- 前缀的行）。
 */
export function parseDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      if (current && (current.removedLines.length > 0 || current.addedLines.length > 0)) {
        hunks.push(current);
      }
      current = { removedLines: [], addedLines: [] };
    } else if (current !== null) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        current.removedLines.push(line.slice(1));
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        current.addedLines.push(line.slice(1));
      }
    }
  }

  if (current && (current.removedLines.length > 0 || current.addedLines.length > 0)) {
    hunks.push(current);
  }

  return hunks;
}

/**
 * 从 diff hunks 中提取所有代码标识符。
 *
 * 同时包含 removed 和 added 行：
 *   - removed：捕获「删除了 Recipe 描述的 API」
 *   - added：捕获「新增了与 Recipe 冲突的 API」
 */
export function tokenizeDiffLines(hunks: DiffHunk[]): Set<string> {
  const allLines = hunks.flatMap((h) => [...h.removedLines, ...h.addedLines]);
  const text = allLines.join('\n');
  return new Set(tokenizeIdentifiers(text));
}
