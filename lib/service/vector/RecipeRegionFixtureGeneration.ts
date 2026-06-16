import {
  RECIPE_REGION_VECTOR_ID_PREFIX,
  RECIPE_SEMANTIC_REGION_CLASSES,
  RECIPE_SEMANTIC_REGION_METADATA_TYPE,
  type RecipeRegionGenerationTestOptions,
  type RecipeRegionGenerationTestReport,
  type RecipeRegionSourceEntry,
  type RecipeRegionSyncOptions,
  type RecipeRegionSyncResult,
  type RecipeSemanticRegionClass,
  type RecipeSourceRefsBridge,
  type SourceRefsBridgeStatus,
} from '@alembic/core/vector';
import {
  type ActiveRecipeRegionSqlRow,
  readActiveRecipeRegionRows,
  readKnowledgeEntryColumns,
  readRecipeSourceRefRows,
  type SqliteDatabaseHandle,
  unwrapSqliteDatabase,
} from '../../infrastructure/database/SqliteDatabaseAccess.js';

export interface RecipeRegionFixtureVectorService {
  testRecipeSemanticRegionGeneration(
    entries: RecipeRegionSourceEntry[],
    options?: RecipeRegionGenerationTestOptions
  ): Promise<RecipeRegionGenerationTestReport>;
  syncRecipeSemanticRegions(
    entries: RecipeRegionSourceEntry[],
    options?: RecipeRegionSyncOptions
  ): Promise<RecipeRegionSyncResult>;
}

export interface RecipeRegionFixtureProofStore {
  getStats(): Promise<Record<string, unknown>>;
  listIds(): Promise<string[]>;
  searchByFilter(filter: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

export interface RecipeRegionFixtureGenerationOptions {
  dataRoot: string;
  database: unknown;
  projectRoot: string;
  vectorService: RecipeRegionFixtureVectorService;
  proofStore?: RecipeRegionFixtureProofStore | null;
  boundedSampleSize?: number;
  maxRegionChars?: number;
}

export type RecipeRegionFixtureGenerationStatus = 'completed' | 'blocked' | 'failed';

export interface RecipeRegionFixtureVectorIndexProof {
  indexPath?: string;
  indexSize?: number;
  timestamp: string;
  totalVectorIds: number;
  recipeRegionItemCount: number;
  metadataTypeCount: number;
  legacyEntryCount: number;
  legacyEntryOnly: boolean;
  distinctRecipeIdsCovered: number;
  missingRecipeIds: string[];
  regionClassDistribution: Record<RecipeSemanticRegionClass, number>;
}

export interface LoadedRecipeRegionEntries {
  activeRecipeCount: number;
  entries: RecipeRegionSourceEntry[];
  sourceRefsBridgeByRecipeId: Record<string, RecipeSourceRefsBridge>;
}

export interface RecipeRegionFixtureGenerationResult {
  status: RecipeRegionFixtureGenerationStatus;
  blockers: string[];
  projectRoot: string;
  dataRoot: string;
  boundedSampleSize: number;
  activeRecipeCount: number;
  boundedReport?: RecipeRegionGenerationTestReport;
  fullSyncResult?: RecipeRegionSyncResult;
  proof: RecipeRegionFixtureVectorIndexProof;
}

export function loadActiveRecipeRegionEntries(database: unknown): LoadedRecipeRegionEntries {
  const db = requireSqliteDatabase(database);
  const columns = new Set(readKnowledgeEntryColumns(db).map((column) => column.name));
  const rows = readActiveRecipeRegionRows(db, recipeRegionProjection(columns));

  const entries = rows.map(recipeRegionSourceEntryFromRow);
  return {
    activeRecipeCount: entries.length,
    entries,
    sourceRefsBridgeByRecipeId: readSourceRefsBridgeByRecipeId(
      db,
      entries.map((entry) => entry.id)
    ),
  };
}

export async function runRecipeRegionFixtureGeneration(
  options: RecipeRegionFixtureGenerationOptions
): Promise<RecipeRegionFixtureGenerationResult> {
  const loaded = loadActiveRecipeRegionEntries(options.database);
  const boundedSampleSize = Math.max(1, options.boundedSampleSize ?? 3);
  const initialProof = await collectRecipeRegionVectorIndexProof({
    activeRecipeIds: loaded.entries.map((entry) => entry.id),
    proofStore: options.proofStore,
  });

  if (loaded.entries.length === 0) {
    return {
      status: 'blocked',
      blockers: ['active-recipe-rows-missing'],
      projectRoot: options.projectRoot,
      dataRoot: options.dataRoot,
      boundedSampleSize,
      activeRecipeCount: 0,
      proof: initialProof,
    };
  }

  const boundedEntries = loaded.entries.slice(0, boundedSampleSize);
  const boundedBridge = pickSourceRefsBridge(
    loaded.sourceRefsBridgeByRecipeId,
    boundedEntries.map((entry) => entry.id)
  );
  const boundedReport = await options.vectorService.testRecipeSemanticRegionGeneration(
    boundedEntries,
    {
      maxRegionChars: options.maxRegionChars,
      removeStale: true,
      sourceRefsBridgeByRecipeId: boundedBridge,
    }
  );

  if (!boundedReport.safeForFullFixtureGeneration) {
    return {
      status: 'blocked',
      blockers: ['bounded-generation-test-not-safe-for-full-fixture', ...boundedReport.errors],
      projectRoot: options.projectRoot,
      dataRoot: options.dataRoot,
      boundedSampleSize,
      activeRecipeCount: loaded.activeRecipeCount,
      boundedReport,
      proof: await collectRecipeRegionVectorIndexProof({
        activeRecipeIds: loaded.entries.map((entry) => entry.id),
        proofStore: options.proofStore,
      }),
    };
  }

  try {
    const fullSyncResult = await options.vectorService.syncRecipeSemanticRegions(loaded.entries, {
      maxRegionChars: options.maxRegionChars,
      removeStale: true,
      sourceRefsBridgeByRecipeId: loaded.sourceRefsBridgeByRecipeId,
    });
    const proof = await collectRecipeRegionVectorIndexProof({
      activeRecipeIds: loaded.entries.map((entry) => entry.id),
      generatedMetadataRecipeIds: fullSyncResult.generatedMetadata.map(
        (metadata) => metadata.recipeId
      ),
      proofStore: options.proofStore,
    });
    const blockers = fixtureCompletionBlockers(fullSyncResult, proof);

    return {
      status: blockers.length === 0 ? 'completed' : 'blocked',
      blockers,
      projectRoot: options.projectRoot,
      dataRoot: options.dataRoot,
      boundedSampleSize,
      activeRecipeCount: loaded.activeRecipeCount,
      boundedReport,
      fullSyncResult,
      proof,
    };
  } catch (err: unknown) {
    return {
      status: 'failed',
      blockers: [`full-generation-threw:${err instanceof Error ? err.message : String(err)}`],
      projectRoot: options.projectRoot,
      dataRoot: options.dataRoot,
      boundedSampleSize,
      activeRecipeCount: loaded.activeRecipeCount,
      boundedReport,
      proof: await collectRecipeRegionVectorIndexProof({
        activeRecipeIds: loaded.entries.map((entry) => entry.id),
        proofStore: options.proofStore,
      }),
    };
  }
}

function requireSqliteDatabase(database: unknown): SqliteDatabaseHandle {
  const db = unwrapSqliteDatabase(database);
  if (!db) {
    throw new Error('SQLite database is required for Recipe region fixture generation');
  }
  return db;
}

function recipeRegionProjection(columns: Set<string>): string {
  return [
    'id',
    'title',
    'description',
    'lifecycle',
    'language',
    'dimensionId',
    'category',
    'kind',
    'knowledgeType',
    'tags',
    'trigger',
    'topicHint',
    'whenClause',
    'doClause',
    'dontClause',
    'coreCode',
    'usageGuide',
    'content',
    'reasoning',
    'sourceFile',
    'moduleName',
    'contentHash',
    'updatedAt',
  ]
    .map((column) => (columns.has(column) ? column : `NULL AS ${column}`))
    .join(', ');
}

function recipeRegionSourceEntryFromRow(row: ActiveRecipeRegionSqlRow): RecipeRegionSourceEntry {
  return {
    id: row.id,
    title: compactString(row.title),
    description: compactString(row.description),
    lifecycle: compactString(row.lifecycle),
    language: compactString(row.language),
    dimensionId: compactString(row.dimensionId),
    category: compactString(row.category),
    knowledgeType: compactString(row.knowledgeType),
    kind: compactString(row.kind),
    tags: parseStringList(row.tags),
    trigger: compactString(row.trigger),
    topicHint: compactString(row.topicHint),
    whenClause: compactString(row.whenClause),
    doClause: compactString(row.doClause),
    dontClause: compactString(row.dontClause),
    coreCode: compactString(row.coreCode),
    usageGuide: compactString(row.usageGuide),
    content: parseJsonOrText(row.content),
    reasoning: parseJsonOrText(row.reasoning),
    sourceFile: compactString(row.sourceFile) || null,
    moduleName: compactString(row.moduleName),
    contentHash: row.contentHash,
    updatedAt: row.updatedAt,
  };
}

function readSourceRefsBridgeByRecipeId(
  db: SqliteDatabaseHandle,
  recipeIds: string[]
): Record<string, RecipeSourceRefsBridge> {
  const bridge: Record<string, RecipeSourceRefsBridge> = {};
  for (const recipeId of recipeIds) {
    bridge[recipeId] = { status: 'missing', refs: [] };
  }
  const rows = readRecipeSourceRefRows(db, recipeIds);

  const grouped = new Map<string, Array<{ ref: string; status: string }>>();
  for (const row of rows) {
    const ref = compactString(row.source_path);
    if (!ref) {
      continue;
    }
    const refs = grouped.get(row.recipe_id) ?? [];
    refs.push({ ref, status: compactString(row.status) });
    grouped.set(row.recipe_id, refs);
  }

  for (const recipeId of recipeIds) {
    const refs = grouped.get(recipeId) ?? [];
    bridge[recipeId] = {
      status: sourceRefsBridgeStatusFor(refs.map((ref) => ref.status)),
      refs: [...new Set(refs.map((ref) => ref.ref))],
    };
  }
  return bridge;
}

async function collectRecipeRegionVectorIndexProof(options: {
  activeRecipeIds: string[];
  generatedMetadataRecipeIds?: string[];
  proofStore?: RecipeRegionFixtureProofStore | null;
}): Promise<RecipeRegionFixtureVectorIndexProof> {
  const generatedMetadataRecipeIds = new Set(options.generatedMetadataRecipeIds ?? []);
  const regionClassDistribution = emptyRegionClassDistribution();

  if (!options.proofStore) {
    const missingRecipeIds = options.activeRecipeIds.filter(
      (recipeId) => !generatedMetadataRecipeIds.has(recipeId)
    );
    return {
      timestamp: new Date().toISOString(),
      totalVectorIds: 0,
      recipeRegionItemCount: generatedMetadataRecipeIds.size > 0 ? 1 : 0,
      metadataTypeCount: generatedMetadataRecipeIds.size > 0 ? 1 : 0,
      legacyEntryCount: 0,
      legacyEntryOnly: false,
      distinctRecipeIdsCovered: generatedMetadataRecipeIds.size,
      missingRecipeIds,
      regionClassDistribution,
    };
  }

  const [ids, regionItems, stats] = await Promise.all([
    options.proofStore.listIds(),
    options.proofStore.searchByFilter({
      type: RECIPE_SEMANTIC_REGION_METADATA_TYPE,
      deprecated: false,
    }),
    options.proofStore.getStats(),
  ]);
  const legacyEntryCount = ids.filter((id) => id.startsWith('entry_')).length;
  const recipeRegionItems = regionItems.filter((item) =>
    compactString(item.id).startsWith(RECIPE_REGION_VECTOR_ID_PREFIX)
  );
  const coveredRecipeIds = new Set<string>();
  for (const item of recipeRegionItems) {
    const metadata = parseRecord(item.metadata);
    const recipeId = compactString(metadata.recipeId);
    const regionClass = metadata.regionClass;
    if (recipeId) {
      coveredRecipeIds.add(recipeId);
    }
    if (isRecipeSemanticRegionClass(regionClass)) {
      regionClassDistribution[regionClass]++;
    }
  }
  for (const recipeId of generatedMetadataRecipeIds) {
    coveredRecipeIds.add(recipeId);
  }

  return {
    indexPath: typeof stats.indexPath === 'string' ? stats.indexPath : undefined,
    indexSize: typeof stats.indexSize === 'number' ? stats.indexSize : undefined,
    timestamp: new Date().toISOString(),
    totalVectorIds: ids.length,
    recipeRegionItemCount: recipeRegionItems.length,
    metadataTypeCount: regionItems.length,
    legacyEntryCount,
    legacyEntryOnly: legacyEntryCount > 0 && recipeRegionItems.length === 0,
    distinctRecipeIdsCovered: coveredRecipeIds.size,
    missingRecipeIds: options.activeRecipeIds.filter((recipeId) => !coveredRecipeIds.has(recipeId)),
    regionClassDistribution,
  };
}

function fixtureCompletionBlockers(
  fullSyncResult: RecipeRegionSyncResult,
  proof: RecipeRegionFixtureVectorIndexProof
): string[] {
  const blockers: string[] = [];
  if (fullSyncResult.status !== 'completed') {
    blockers.push(`full-generation-status-${fullSyncResult.status}`);
  }
  if (fullSyncResult.errors.length > 0) {
    blockers.push(...fullSyncResult.errors);
  }
  if (fullSyncResult.generated <= 0) {
    blockers.push('full-generation-produced-no-region-chunks');
  }
  if (fullSyncResult.embedded !== fullSyncResult.generated) {
    blockers.push(
      `full-generation-embedding-incomplete:${fullSyncResult.embedded}/${fullSyncResult.generated}`
    );
  }
  if (fullSyncResult.upserted !== fullSyncResult.generated) {
    blockers.push(
      `full-generation-upsert-incomplete:${fullSyncResult.upserted}/${fullSyncResult.generated}`
    );
  }
  if (proof.recipeRegionItemCount === 0 || proof.metadataTypeCount === 0) {
    blockers.push('recipe-semantic-region-fixture-missing');
  }
  if (proof.missingRecipeIds.length > 0) {
    blockers.push(`active-recipe-region-coverage-missing:${proof.missingRecipeIds.join(',')}`);
  }
  if (proof.legacyEntryOnly) {
    blockers.push('legacy-entry-only-vector-index');
  }
  return blockers;
}

function pickSourceRefsBridge(
  bridgeByRecipeId: Record<string, RecipeSourceRefsBridge>,
  recipeIds: string[]
): Record<string, RecipeSourceRefsBridge> {
  const picked: Record<string, RecipeSourceRefsBridge> = {};
  for (const recipeId of recipeIds) {
    picked[recipeId] = bridgeByRecipeId[recipeId] ?? { status: 'missing', refs: [] };
  }
  return picked;
}

function sourceRefsBridgeStatusFor(statuses: string[]): SourceRefsBridgeStatus {
  if (statuses.length === 0) {
    return 'missing';
  }
  return statuses.every((status) => status === 'active') ? 'active' : 'partial';
}

function emptyRegionClassDistribution(): Record<RecipeSemanticRegionClass, number> {
  return Object.fromEntries(
    RECIPE_SEMANTIC_REGION_CLASSES.map((regionClass) => [regionClass, 0])
  ) as Record<RecipeSemanticRegionClass, number>;
}

function isRecipeSemanticRegionClass(value: unknown): value is RecipeSemanticRegionClass {
  return (
    typeof value === 'string' &&
    (RECIPE_SEMANTIC_REGION_CLASSES as readonly string[]).includes(value)
  );
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return compactStringArray(value);
  }
  const parsed = parseJsonOrText(value);
  if (Array.isArray(parsed)) {
    return compactStringArray(parsed);
  }
  return compactString(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonOrText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compactStringArray(value: unknown[]): string[] {
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .map((item) => item.trim())
    .filter(Boolean);
}
