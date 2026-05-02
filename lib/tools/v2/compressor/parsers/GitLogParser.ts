/**
 * @module tools/v2/compressor/parsers/GitLogParser
 * 解析 git log 命令输出为紧凑结构化格式。
 */

interface LogEntry {
  hash: string;
  date: string;
  author: string;
  message: string;
}

const COMMIT_RE = /^commit\s+([0-9a-f]{7,40})$/;
const AUTHOR_RE = /^Author:\s+(.+?)(?:\s+<.*>)?$/;
const DATE_RE = /^Date:\s+(.+)$/;

const ONELINE_RE = /^([0-9a-f]{7,40})\s+(.+)$/;

const FORMAT_RE =
  /^([0-9a-f]{7,40})\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:\s*[+-]\d{4})?)\s+(.+?):\s+(.+)$/;

const MAX_ENTRIES = 20;

function parseFullFormat(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length && entries.length < MAX_ENTRIES) {
    const commitMatch = COMMIT_RE.exec(lines[i]?.trim() ?? '');
    if (!commitMatch) {
      i++;
      continue;
    }

    const hash = commitMatch[1].slice(0, 7);
    let author = '';
    let date = '';
    let message = '';
    i++;

    while (i < lines.length) {
      const line = lines[i]?.trim() ?? '';
      const authorMatch = AUTHOR_RE.exec(line);
      if (authorMatch) {
        author = authorMatch[1];
        i++;
        continue;
      }
      const dateMatch = DATE_RE.exec(line);
      if (dateMatch) {
        date = dateMatch[1].trim().split(' ').slice(0, 4).join(' ');
        i++;
        continue;
      }
      if (line === '') {
        i++;
        continue;
      }
      if (COMMIT_RE.test(line)) {
        break;
      }

      if (!message) {
        message = line;
      }
      i++;
    }

    if (hash) {
      entries.push({ hash, date, author, message });
    }
  }

  return entries;
}

function parseOneline(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const line of raw.split('\n')) {
    if (entries.length >= MAX_ENTRIES) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fmtMatch = FORMAT_RE.exec(trimmed);
    if (fmtMatch) {
      entries.push({
        hash: fmtMatch[1].slice(0, 7),
        date: fmtMatch[2],
        author: fmtMatch[3],
        message: fmtMatch[4],
      });
      continue;
    }

    const oneMatch = ONELINE_RE.exec(trimmed);
    if (oneMatch) {
      entries.push({
        hash: oneMatch[1].slice(0, 7),
        date: '',
        author: '',
        message: oneMatch[2],
      });
    }
  }

  return entries;
}

function formatEntries(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const parts = [e.hash];
      if (e.date) {
        parts.push(e.date);
      }
      if (e.author) {
        parts.push(`${e.author}:`);
      }
      parts.push(e.message);
      return parts.join(' ');
    })
    .join('\n');
}

/** 尝试解析 raw 输出，失败返回 null */
export function parse(raw: string): string | null {
  try {
    if (!raw || raw.trim().length === 0) {
      return null;
    }

    const full = parseFullFormat(raw);
    if (full.length > 0) {
      return formatEntries(full);
    }

    const oneline = parseOneline(raw);
    if (oneline.length > 0) {
      return formatEntries(oneline);
    }

    return null;
  } catch {
    return null;
  }
}
