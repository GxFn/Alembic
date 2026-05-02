/**
 * @module tools/v2/compressor/parsers/LintOutputParser
 * 解析 eslint/biome/tsc 输出为紧凑结构化格式。
 */

interface LintResult {
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

interface LintIssue {
  file: string;
  line: string;
  message: string;
  severity: 'error' | 'warning';
}

const MAX_ISSUES = 10;

const ESLINT_SUMMARY_RE = /(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/;
const ESLINT_LINE_RE = /^\s*(.+?):(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}|\t)(.+)$/;

const TSC_LINE_RE = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/;
const TSC_LINE_ALT_RE = /^(.+?):(\d+):\d+\s+-\s+error\s+(TS\d+):\s+(.+)$/;

const _BIOME_LINE_RE = /^(.+?):(\d+):\d+\s+(lint\/\S+)\s+━+\s*$/;
const BIOME_DIAG_RE = /^(.+?):(\d+):\d+\s+(error|warning|info)\[(.+?)]\s+(.+)$/;

function tryEslint(raw: string): LintResult | null {
  const summaryMatch = ESLINT_SUMMARY_RE.exec(raw);
  const issues: LintIssue[] = [];

  for (const line of raw.split('\n')) {
    if (issues.length >= MAX_ISSUES) {
      break;
    }
    const m = ESLINT_LINE_RE.exec(line);
    if (m) {
      issues.push({
        file: m[1],
        line: m[2],
        severity: m[3] as 'error' | 'warning',
        message: `${m[4]} (${m[5]})`,
      });
    }
  }

  if (summaryMatch) {
    return {
      errors: parseInt(summaryMatch[2], 10),
      warnings: parseInt(summaryMatch[3], 10),
      issues,
    };
  }

  if (issues.length > 0) {
    return {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      issues,
    };
  }

  return null;
}

function tryTsc(raw: string): LintResult | null {
  const issues: LintIssue[] = [];

  for (const line of raw.split('\n')) {
    if (issues.length >= MAX_ISSUES) {
      break;
    }
    let m = TSC_LINE_RE.exec(line);
    if (!m) {
      m = TSC_LINE_ALT_RE.exec(line);
    }
    if (m) {
      issues.push({
        file: m[1],
        line: m[2],
        severity: 'error',
        message: `${m[3]}: ${m[4]}`,
      });
    }
  }

  if (issues.length === 0) {
    return null;
  }

  const errorCount = raw
    .split('\n')
    .filter((l) => TSC_LINE_RE.test(l) || TSC_LINE_ALT_RE.test(l)).length;

  return { errors: errorCount, warnings: 0, issues };
}

function tryBiome(raw: string): LintResult | null {
  const issues: LintIssue[] = [];

  for (const line of raw.split('\n')) {
    if (issues.length >= MAX_ISSUES) {
      break;
    }
    const m = BIOME_DIAG_RE.exec(line.trim());
    if (m) {
      issues.push({
        file: m[1],
        line: m[2],
        severity: m[3] === 'error' ? 'error' : 'warning',
        message: `${m[5]} (${m[4]})`,
      });
    }
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    issues,
  };
}

function formatResult(result: LintResult): string {
  const parts: string[] = [`${result.errors} errors, ${result.warnings} warnings`];

  if (result.issues.length > 0) {
    parts.push('');
    parts.push('Top issues:');
    for (const issue of result.issues.slice(0, MAX_ISSUES)) {
      parts.push(`  ${issue.file}:${issue.line}: ${issue.message}`);
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

    const result = tryEslint(raw) ?? tryTsc(raw) ?? tryBiome(raw);
    if (!result) {
      return null;
    }

    return formatResult(result);
  } catch {
    return null;
  }
}
