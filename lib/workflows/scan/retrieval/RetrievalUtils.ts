import { extname } from 'node:path';
import type { EvidenceFile, ScanChangeSet } from '#workflows/scan/ScanTypes.js';

export function normalizeChangeSet(
  changeSet: ScanChangeSet | undefined
): ScanChangeSet | undefined {
  if (!changeSet) {
    return undefined;
  }
  return {
    added: uniqueStrings(changeSet.added),
    modified: uniqueStrings(changeSet.modified),
    deleted: uniqueStrings(changeSet.deleted),
    renamed: changeSet.renamed ?? [],
    source: changeSet.source,
  };
}

export function collectChangedFiles(changeSet: ScanChangeSet | undefined): string[] {
  if (!changeSet) {
    return [];
  }
  return uniqueStrings([
    ...changeSet.added,
    ...changeSet.modified,
    ...changeSet.deleted,
    ...(changeSet.renamed ?? []).flatMap((rename) => [rename.oldPath, rename.newPath]),
  ]);
}

export function inferPrimaryLang(files: EvidenceFile[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file.language) {
      continue;
    }
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
  }
  let best: string | null = null;
  let count = 0;
  for (const [language, languageCount] of counts) {
    if (languageCount > count) {
      best = language;
      count = languageCount;
    }
  }
  return best;
}

export function inferLanguage(filePath: string): string | undefined {
  const extension = extname(filePath).slice(1).toLowerCase();
  if (!extension) {
    return undefined;
  }
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    swift: 'swift',
    kt: 'kotlin',
    rs: 'rust',
  };
  return map[extension] ?? extension;
}

export function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  return [
    ...new Set([...values].filter((value): value is string => Boolean(value && value.length > 0))),
  ];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
