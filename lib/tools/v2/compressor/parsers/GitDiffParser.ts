/**
 * @module tools/v2/compressor/parsers/GitDiffParser
 * 解析 git diff 命令输出为紧凑结构化格式。
 */

interface FileStat {
  file: string;
  added: number;
  removed: number;
  hunks: string[];
}

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@\s+.+?\s+@@\s*(.*)$/;
const STAT_LINE_RE =
  /^\s*(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?[^,]*)?(?:,\s+(\d+)\s+deletions?.*)?$/;

function parseDiffContent(raw: string): FileStat[] | null {
  const files: FileStat[] = [];
  let current: FileStat | null = null;

  for (const line of raw.split('\n')) {
    const headerMatch = DIFF_HEADER_RE.exec(line);
    if (headerMatch) {
      if (current) {
        files.push(current);
      }
      current = { file: headerMatch[2], added: 0, removed: 0, hunks: [] };
      continue;
    }

    if (!current) {
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (current.hunks.length < 5) {
        current.hunks.push(hunkMatch[1] || '');
      }
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removed++;
    }
  }

  if (current) {
    files.push(current);
  }
  return files.length > 0 ? files : null;
}

function parseDiffStat(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const m = STAT_LINE_RE.exec(line.trim());
    if (m) {
      return line.trim();
    }
  }
  return null;
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const files = parseDiffContent(raw);
    if (!files) {
      const statLine = parseDiffStat(raw);
      return statLine ?? null;
    }

    const totalAdded = files.reduce((s, f) => s + f.added, 0);
    const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

    const parts: string[] = [
      `${files.length} files changed, +${totalAdded}/-${totalRemoved} lines`,
      '',
    ];

    for (const f of files) {
      parts.push(`${f.file}: +${f.added}/-${f.removed}`);
    }

    return parts.join('\n');
  } catch {
    return null;
  }
}
