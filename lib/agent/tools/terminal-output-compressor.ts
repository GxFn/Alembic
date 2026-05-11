import type { ToolTerminalOutputCompressor } from "./types.js";

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type TerminalParser = (raw: string) => string | null;

interface TerminalParserEntry {
  readonly name: string;
  readonly pattern: RegExp;
  readonly parse: TerminalParser;
}

const PARSERS: readonly TerminalParserEntry[] = [
  { name: "git-status", pattern: /^git\s+status\b/, parse: parseGitStatus },
  { name: "git-diff", pattern: /^git\s+diff\b/, parse: parseGitDiff },
  { name: "git-log", pattern: /^git\s+log\b/, parse: parseGitLog },
  {
    name: "test-output",
    pattern: /^(vitest|jest|mocha|pytest|npx\s+vitest|npx\s+jest|npm\s+test|pnpm\s+test)\b/,
    parse: parseTestOutput,
  },
  {
    name: "lint-output",
    pattern: /^(eslint|biome|tsc|npx\s+tsc|npm\s+run\s+lint)\b/,
    parse: parseLintOutput,
  },
  { name: "grep-output", pattern: /^(rg|grep|ag|ack)\b/, parse: parseGrepOutput },
  { name: "tree-output", pattern: /^(ls|find|tree)\b/, parse: parseTreeOutput },
  {
    name: "package-output",
    pattern: /^(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/,
    parse: parsePackageOutput,
  },
];

export class DefaultToolTerminalOutputCompressor implements ToolTerminalOutputCompressor {
  compress(
    raw: string,
    options: { readonly command: string; readonly tokenBudget?: number },
  ): string {
    if (!raw) {
      return raw;
    }
    const cleaned = cleanTerminalOutput(raw);
    const maxChars = Math.max(1_000, (options.tokenBudget ?? 4_000) * 4);
    for (const parser of PARSERS) {
      if (!parser.pattern.test(options.command.trim())) {
        continue;
      }
      try {
        const parsed = parser.parse(cleaned);
        if (parsed) {
          return truncateOutput(`[${parser.name}]\n${parsed}`, maxChars);
        }
      } catch {
        break;
      }
    }
    return truncateOutput(cleaned, maxChars);
  }
}

export function cleanTerminalOutput(raw: string): string {
  return collapseRepeatedLines(stripAnsi(raw).replace(/\r/g, "\n")).trimEnd();
}

function parseGitStatus(raw: string): string | null {
  const branch = raw.match(/On branch ([^\n]+)/)?.[1];
  const changed = raw
    .split("\n")
    .filter((line) => /^\s*(modified:|new file:|deleted:|renamed:|both modified:|\?\?)/.test(line))
    .slice(0, 80);
  if (!branch && changed.length === 0) {
    return null;
  }
  return [branch ? `branch: ${branch}` : "", `changed: ${changed.length}`, ...changed]
    .filter(Boolean)
    .join("\n");
}

function parseGitDiff(raw: string): string | null {
  const files = [...raw.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(
    (match) => match[2] ?? match[1],
  );
  const hunks = [...raw.matchAll(/^@@ .+ @@.*$/gm)].map((match) => match[0]);
  const additions = countLines(raw, "+");
  const deletions = countLines(raw, "-");
  if (files.length === 0 && hunks.length === 0) {
    return null;
  }
  return [
    `files: ${files.length}`,
    `additions: ${additions}`,
    `deletions: ${deletions}`,
    ...files.slice(0, 40).map((file) => `file: ${file}`),
    ...hunks.slice(0, 60),
  ].join("\n");
}

function parseGitLog(raw: string): string | null {
  const full = parseFullGitLog(raw);
  if (full.length > 0) {
    return full.join("\n");
  }
  const oneline = parseOnelineGitLog(raw);
  return oneline.length > 0 ? oneline.join("\n") : null;
}

function parseFullGitLog(raw: string): string[] {
  const entries: string[] = [];
  const lines = raw.split("\n");
  let index = 0;

  while (index < lines.length && entries.length < 20) {
    const commitMatch = /^commit\s+([0-9a-f]{7,40})$/.exec(lines[index]?.trim() ?? "");
    if (!commitMatch) {
      index += 1;
      continue;
    }

    const hash = commitMatch[1]?.slice(0, 7) ?? "";
    let author = "";
    let date = "";
    let message = "";
    index += 1;

    while (index < lines.length) {
      const line = lines[index]?.trim() ?? "";
      const authorMatch = /^Author:\s+(.+?)(?:\s+<.*>)?$/.exec(line);
      const dateMatch = /^Date:\s+(.+)$/.exec(line);
      if (authorMatch) {
        author = authorMatch[1] ?? "";
      } else if (dateMatch) {
        date = (dateMatch[1] ?? "").trim().split(" ").slice(0, 4).join(" ");
      } else if (line && !/^commit\s+[0-9a-f]{7,40}$/.test(line) && !message) {
        message = line;
      }
      if (/^commit\s+[0-9a-f]{7,40}$/.test(line)) {
        break;
      }
      index += 1;
    }

    if (hash) {
      entries.push(formatGitLogEntry(hash, date, author, message));
    }
  }

  return entries;
}

function parseOnelineGitLog(raw: string): string[] {
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    if (entries.length >= 20) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const formatted =
      /^([0-9a-f]{7,40})\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:\s*[+-]\d{4})?)\s+(.+?):\s+(.+)$/.exec(
        trimmed,
      );
    if (formatted) {
      entries.push(
        formatGitLogEntry(
          formatted[1]?.slice(0, 7) ?? "",
          formatted[2] ?? "",
          formatted[3] ?? "",
          formatted[4] ?? "",
        ),
      );
      continue;
    }
    const oneline = /^([0-9a-f]{7,40})\s+(.+)$/.exec(trimmed);
    if (oneline) {
      entries.push(formatGitLogEntry(oneline[1]?.slice(0, 7) ?? "", "", "", oneline[2] ?? ""));
    }
  }
  return entries;
}

function formatGitLogEntry(hash: string, date: string, author: string, message: string): string {
  return [hash, date, author ? `${author}:` : "", message].filter(Boolean).join(" ");
}

function parseTestOutput(raw: string): string | null {
  const lines = importantLines(raw, [
    /Test Files/i,
    /Tests/i,
    /failed/i,
    /passed/i,
    /AssertionError/i,
    /Error:/,
    /^\s*[✕×✓]/,
  ]);
  return lines.length > 0 ? lines.join("\n") : null;
}

function parseLintOutput(raw: string): string | null {
  const lines = importantLines(raw, [
    /error TS\d+/,
    /\berror\b/i,
    /\bwarning\b/i,
    /Found \d+/i,
    /Checked \d+/i,
    /lint/i,
  ]);
  return lines.length > 0 ? lines.join("\n") : null;
}

function parseGrepOutput(raw: string): string | null {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  return [`matches: ${lines.length}`, ...lines.slice(0, 120)].join("\n");
}

function parseTreeOutput(raw: string): string | null {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  return [`entries: ${lines.length}`, ...lines.slice(0, 160)].join("\n");
}

function parsePackageOutput(raw: string): string | null {
  const lines = importantLines(raw, [
    /added|removed|updated|changed|audited/i,
    /vulnerabilit/i,
    /deprecated/i,
    /error/i,
    /warn/i,
  ]);
  return lines.length > 0 ? lines.join("\n") : null;
}

function importantLines(raw: string, patterns: readonly RegExp[]): string[] {
  return raw
    .split("\n")
    .filter((line) => patterns.some((pattern) => pattern.test(line)))
    .slice(0, 160);
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

function collapseRepeatedLines(raw: string): string {
  const output: string[] = [];
  let previous = "";
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line === previous) {
      count += 1;
      continue;
    }
    if (count > 2) {
      output.push(`[repeated ${count}x] ${previous}`);
    }
    output.push(line);
    previous = line;
    count = 1;
  }
  if (count > 2) {
    output.push(`[repeated ${count}x] ${previous}`);
  }
  return output.join("\n");
}

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function countLines(raw: string, prefix: string): number {
  return raw
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}
