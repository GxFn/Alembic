import {
  classifyRecipeToDimension,
  DIMENSION_DISPLAY_GROUP,
  DIMENSION_REGISTRY,
} from '#domain/dimension/DimensionRegistry.js';

const KNOWN_DIMENSION_IDS = new Set(DIMENSION_REGISTRY.map((dimension) => dimension.id));

export interface RecipeDimensionFields {
  dimensionId?: string | null;
  category?: string | null;
  knowledgeType?: string | null;
  topicHint?: string | null;
  tags?: string[] | string | null;
  agentNotes?: unknown;
}

export interface RecipeDimensionResolveOptions {
  knownDimensionIds?: Iterable<string>;
}

export function isKnownDimensionId(
  value: unknown,
  options: RecipeDimensionResolveOptions = {}
): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim();
  if (KNOWN_DIMENSION_IDS.has(normalized)) {
    return true;
  }
  for (const id of options.knownDimensionIds ?? []) {
    if (id === normalized) {
      return true;
    }
  }
  return false;
}

export function resolveRecipeDimensionId(
  entry: RecipeDimensionFields,
  options: RecipeDimensionResolveOptions = {}
): string | null {
  const scopedDimensionIds = new Set(options.knownDimensionIds ?? []);
  const scopedOptions = { knownDimensionIds: scopedDimensionIds };
  const explicit = pickString(entry.dimensionId);
  if (isKnownDimensionId(explicit, scopedOptions)) {
    return explicit;
  }

  const noteDimension = extractAgentNoteDimensionId(entry.agentNotes);
  if (isKnownDimensionId(noteDimension, scopedOptions)) {
    return noteDimension;
  }

  const category = pickString(entry.category);
  if (isScopedDimensionId(category, scopedDimensionIds)) {
    return category;
  }

  const knowledgeType = pickString(entry.knowledgeType);
  if (isScopedDimensionId(knowledgeType, scopedDimensionIds)) {
    return knowledgeType;
  }

  const tags = normalizeTags(entry.tags);
  for (const tag of tags) {
    const normalized = tag.startsWith('dimension:') ? tag.slice('dimension:'.length) : tag;
    if (isScopedDimensionId(normalized, scopedDimensionIds)) {
      return normalized;
    }
  }

  if (isKnownDimensionId(category)) {
    return category;
  }

  if (isKnownDimensionId(knowledgeType)) {
    return knowledgeType;
  }

  for (const tag of tags) {
    const normalized = tag.startsWith('dimension:') ? tag.slice('dimension:'.length) : tag;
    if (isKnownDimensionId(normalized)) {
      return normalized;
    }
  }

  const inferred = classifyRecipeToDimension(pickString(entry.topicHint) || '', category || '');
  return inferred && isKnownDimensionId(inferred, scopedOptions) ? inferred : null;
}

export function recipeBelongsToDimension(
  entry: RecipeDimensionFields,
  dimension: { id: string; knowledgeTypes?: readonly string[] },
  options: RecipeDimensionResolveOptions = {}
): boolean {
  const knownDimensionIds = options.knownDimensionIds ?? [dimension.id];
  const resolved = resolveRecipeDimensionId(entry, { ...options, knownDimensionIds });
  if (resolved) {
    return resolved === dimension.id;
  }
  const knowledgeType = pickString(entry.knowledgeType);
  return (dimension.knowledgeTypes ?? []).includes(knowledgeType);
}

export function recipeDimensionIdOrUnknown(
  entry: RecipeDimensionFields,
  options: RecipeDimensionResolveOptions = {}
): string {
  return resolveRecipeDimensionId(entry, options) || 'unknown';
}

export function recipeStorageBucket(
  entry: RecipeDimensionFields,
  options: RecipeDimensionResolveOptions = {}
): string {
  return resolveRecipeDimensionId(entry, options) || pickString(entry.category) || 'general';
}

export function dimensionTags(dimensionId: string | null | undefined, existing: string[] = []) {
  if (!dimensionId) {
    return existing;
  }
  return [
    ...new Set([
      ...existing,
      dimensionId,
      `dimension:${dimensionId}`,
      'bootstrap',
      DIMENSION_DISPLAY_GROUP[dimensionId] || dimensionId,
    ]),
  ];
}

function extractAgentNoteDimensionId(agentNotes: unknown): string {
  if (!agentNotes) {
    return '';
  }
  if (typeof agentNotes === 'string') {
    try {
      return extractAgentNoteDimensionId(JSON.parse(agentNotes));
    } catch {
      return '';
    }
  }
  if (typeof agentNotes !== 'object' || Array.isArray(agentNotes)) {
    return '';
  }
  return pickString((agentNotes as Record<string, unknown>).dimensionId);
}

function normalizeTags(tags: RecipeDimensionFields['tags']): string[] {
  if (Array.isArray(tags)) {
    return tags.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof tags !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
}

function isScopedDimensionId(
  value: unknown,
  scopedDimensionIds: ReadonlySet<string>
): value is string {
  return typeof value === 'string' && scopedDimensionIds.has(value.trim());
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
