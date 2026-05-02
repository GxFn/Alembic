/**
 * @module tools/v2/compressor/parsers/GitStatusParser
 * 解析 git status 命令输出为紧凑结构化格式。
 */

const PORCELAIN_RE = /^([MADRCU?! ]{2})\s+(.+)$/;

interface StatusBuckets {
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  renamed: string[];
}

function parsePorcelain(lines: string[]): StatusBuckets | null {
  const buckets: StatusBuckets = {
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
  };
  let matched = 0;

  for (const line of lines) {
    const m = PORCELAIN_RE.exec(line);
    if (!m) {
      continue;
    }
    matched++;
    const [idx, wt] = [m[1][0], m[1][1]];
    const file = m[2].trim();

    if (idx === '?') {
      buckets.untracked.push(file);
    } else {
      if (idx === 'A') {
        buckets.staged.push(file);
      } else if (idx === 'D') {
        buckets.deleted.push(file);
      } else if (idx === 'R') {
        buckets.renamed.push(file);
      } else if (idx === 'M') {
        buckets.staged.push(file);
      }

      if (wt === 'M') {
        buckets.modified.push(file);
      } else if (wt === 'D') {
        buckets.deleted.push(file);
      }
    }
  }

  return matched > 0 ? buckets : null;
}

function parseHumanReadable(raw: string): StatusBuckets | null {
  const buckets: StatusBuckets = {
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    renamed: [],
  };

  let section: 'staged' | 'modified' | 'untracked' | null = null;
  let matched = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Changes to be committed')) {
      section = 'staged';
    } else if (trimmed.startsWith('Changes not staged')) {
      section = 'modified';
    } else if (trimmed.startsWith('Untracked files')) {
      section = 'untracked';
    } else if (trimmed === '' || trimmed.startsWith('(use ')) {
    } else if (section) {
      const fileMatch = trimmed.match(
        /^(?:new file|modified|deleted|renamed|typechange)?:?\s*(.+)$/
      );
      if (fileMatch) {
        matched++;
        const file = fileMatch[1].trim();
        if (section === 'staged') {
          buckets.staged.push(file);
        } else if (section === 'modified') {
          buckets.modified.push(file);
        } else {
          buckets.untracked.push(file);
        }
      }
    }
  }

  return matched > 0 ? buckets : null;
}

function formatBuckets(buckets: StatusBuckets): string {
  const parts: string[] = [];
  const entries: [string, string[]][] = [
    ['staged', buckets.staged],
    ['modified', buckets.modified],
    ['deleted', buckets.deleted],
    ['renamed', buckets.renamed],
    ['untracked', buckets.untracked],
  ];

  for (const [label, files] of entries) {
    if (files.length > 0) {
      parts.push(`${label}(${files.length}): ${files.join(', ')}`);
    }
  }

  return parts.join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const lines = raw.split('\n').filter((l) => l.length > 0);

    const porcelain = parsePorcelain(lines);
    if (porcelain) {
      return formatBuckets(porcelain);
    }

    const human = parseHumanReadable(raw);
    if (human) {
      return formatBuckets(human);
    }

    return null;
  } catch {
    return null;
  }
}
