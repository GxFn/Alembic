/**
 * @module tools/v2/compressor/parsers/PackageParser
 * 解析 npm/pnpm/yarn install 输出为紧凑结构化格式。
 */

interface PackageResult {
  added: number;
  removed: number;
  changed: number;
  warnings: string[];
  extra: string[];
}

const NPM_ADDED_RE = /added\s+(\d+)\s+packages?/;
const NPM_REMOVED_RE = /removed\s+(\d+)\s+packages?/;
const NPM_CHANGED_RE = /changed\s+(\d+)\s+packages?/;
const NPM_AUDIT_RE = /(\d+)\s+vulnerabilit(?:y|ies)/;

const PNPM_ADDED_RE = /Packages:\s+\+(\d+)/;
const PNPM_REMOVED_RE = /Packages:.*-(\d+)/;
const PNPM_PROGRESS_RE = /Progress:.*,\s+(\d+)\s+done/;

const YARN_ADDED_RE = /Done in\s+[\d.]+s/;
const YARN_FETCH_RE = /Fetched\s+(\d+)\s+packages?/;

const WARN_RE = /(?:npm\s+)?(?:WARN|warn)\s+(.+)/;
const DEPRECATED_RE = /deprecated\s+(.+)/i;

function tryNpm(raw: string): PackageResult | null {
  const added = NPM_ADDED_RE.exec(raw);
  const removed = NPM_REMOVED_RE.exec(raw);
  const changed = NPM_CHANGED_RE.exec(raw);

  if (!added && !removed && !changed) {
    return null;
  }

  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const warnMatch = WARN_RE.exec(line);
    if (warnMatch && warnings.length < 10) {
      warnings.push(warnMatch[1].trim());
    }
  }

  const audit = NPM_AUDIT_RE.exec(raw);
  const extra: string[] = [];
  if (audit) {
    extra.push(`${audit[0]}`);
  }

  return {
    added: added ? parseInt(added[1], 10) : 0,
    removed: removed ? parseInt(removed[1], 10) : 0,
    changed: changed ? parseInt(changed[1], 10) : 0,
    warnings,
    extra,
  };
}

function tryPnpm(raw: string): PackageResult | null {
  const added = PNPM_ADDED_RE.exec(raw);
  const removed = PNPM_REMOVED_RE.exec(raw);

  if (!added && !removed && !PNPM_PROGRESS_RE.test(raw)) {
    return null;
  }

  const warnings: string[] = [];
  for (const line of raw.split('\n')) {
    const warnMatch = WARN_RE.exec(line);
    if (warnMatch && warnings.length < 10) {
      warnings.push(warnMatch[1].trim());
    }
    const depMatch = DEPRECATED_RE.exec(line);
    if (depMatch && warnings.length < 10) {
      warnings.push(`deprecated: ${depMatch[1].trim()}`);
    }
  }

  return {
    added: added ? parseInt(added[1], 10) : 0,
    removed: removed ? parseInt(removed[1], 10) : 0,
    changed: 0,
    warnings,
    extra: [],
  };
}

function tryYarn(raw: string): PackageResult | null {
  if (!YARN_ADDED_RE.test(raw) && !raw.includes('YN0000')) {
    return null;
  }

  const warnings: string[] = [];
  let added = 0;

  for (const line of raw.split('\n')) {
    const fetchMatch = YARN_FETCH_RE.exec(line);
    if (fetchMatch) {
      added = parseInt(fetchMatch[1], 10);
    }

    const warnMatch = WARN_RE.exec(line);
    if (warnMatch && warnings.length < 10) {
      warnings.push(warnMatch[1].trim());
    }

    if (line.includes('YN0002') && warnings.length < 10) {
      warnings.push(line.trim());
    }
  }

  return {
    added,
    removed: 0,
    changed: 0,
    warnings,
    extra: [],
  };
}

function formatResult(result: PackageResult): string {
  const parts: string[] = [
    `added ${result.added} packages, removed ${result.removed}, ${result.warnings.length} warnings`,
  ];

  if (result.changed > 0) {
    parts[0] += `, changed ${result.changed}`;
  }

  if (result.extra.length > 0) {
    parts.push(result.extra.join(', '));
  }

  if (result.warnings.length > 0) {
    parts.push('');
    parts.push('Warnings:');
    for (const w of result.warnings) {
      parts.push(`  ${w}`);
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

    const result = tryNpm(raw) ?? tryPnpm(raw) ?? tryYarn(raw);
    if (!result) {
      return null;
    }

    return formatResult(result);
  } catch {
    return null;
  }
}
