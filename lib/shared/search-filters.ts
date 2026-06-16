export type SearchFilterValue = string | string[];

export interface NormalizedSearchFilters {
  category?: SearchFilterValue;
  dimensionId?: SearchFilterValue;
  kind?: SearchFilterValue;
  knowledgeType?: SearchFilterValue;
  language?: SearchFilterValue;
  scope?: SearchFilterValue;
  tags?: string[];
}

const FILTER_KEYS = [
  'category',
  'dimensionId',
  'kind',
  'knowledgeType',
  'language',
  'scope',
] as const;

type ScalarFilterKey = (typeof FILTER_KEYS)[number];

export function normalizeSearchFilters(input: Record<string, unknown>): NormalizedSearchFilters {
  const filtersRecord = readRecord(input.filters);
  const output: NormalizedSearchFilters = {};

  for (const key of FILTER_KEYS) {
    const values = readStringValues(input[key] ?? filtersRecord?.[key]);
    assignFilterValue(output, key, values);
  }

  const tags = readStringValues(
    input.tags ?? input.tag ?? filtersRecord?.tags ?? filtersRecord?.tag
  );
  if (tags.length > 0) {
    output.tags = uniqueStrings(tags);
  }

  return output;
}

export function hasSearchFilters(filters: NormalizedSearchFilters): boolean {
  return Object.keys(filters).length > 0;
}

export function toSearchFilterRecord(
  filters: NormalizedSearchFilters
): Record<string, SearchFilterValue> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0
    )
  ) as Record<string, SearchFilterValue>;
}

function assignFilterValue(
  output: NormalizedSearchFilters,
  key: ScalarFilterKey,
  values: string[]
): void {
  const unique = uniqueStrings(values);
  if (unique.length === 0) {
    return;
  }
  output[key] = unique.length === 1 ? unique[0] : unique;
}

function readStringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap(readStringValues);
  }
  return [];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
