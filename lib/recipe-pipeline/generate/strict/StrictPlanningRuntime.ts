import { runStrictPlanAgent } from '@alembic/agent/runs';
import type { AgentService } from '@alembic/agent/service';
import {
  buildDimensionCatalogSnapshot,
  buildFactQueryCatalogSnapshot,
  type CertifiedPlanningFactsV1,
  type CompiledColdStartPlanV2,
  type CoveragePlanPolicyV1,
  compileColdStartPlan,
  createPlanningRoleVocabularyV1,
  createResolvedStrictColdStartConfigReceiptV1,
  type FactQueryFamilyV1,
  type ResolvedStrictColdStartConfigReceiptV1,
  type StrictColdStartConfigProjectionInputV1,
} from '@alembic/core/plans';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type {
  MainCertifiedModule,
  MainCertifiedProjectFactsCarrier,
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';
import { qualifyMainCertifiedPath } from '../../../project-facts/CertifiedProjectFactsRuntime.js';

export interface StrictPlanningAuthorizationV1 {
  readonly factQueryFamilies: readonly FactQueryFamilyV1[];
  readonly modelHash: string;
  readonly promptHash: string;
  readonly strictConfig: StrictColdStartConfigProjectionInputV1;
}

export interface StrictPlanningResultV1 {
  readonly certifiedPlanningFacts: CertifiedPlanningFactsV1;
  readonly compiledPlan: CompiledColdStartPlanV2;
  readonly configReceipt: ResolvedStrictColdStartConfigReceiptV1;
  readonly planCognitionHash: string;
}

export async function compileStrictColdStartPlanning(input: {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly authorization: StrictPlanningAuthorizationV1;
  readonly carrier: MainCertifiedProjectFactsCarrier;
  readonly projection: MainCertifiedProjectionPayload;
}): Promise<StrictPlanningResultV1> {
  const certifiedPlanningFacts = buildCertifiedPlanningFacts(input.carrier, input.projection);
  const catalog = buildDimensionCatalogSnapshot();
  const factQueryCatalog = buildFactQueryCatalogSnapshot(input.authorization.factQueryFamilies);
  const configReceipt = createResolvedStrictColdStartConfigReceiptV1(
    input.authorization.strictConfig
  );
  const policy = buildCoveragePolicy(certifiedPlanningFacts);
  let compiledPlan: CompiledColdStartPlanV2 | null = null;
  const cognition = await runStrictPlanAgent({
    agentService: input.agentService,
    contextProjection: {
      schemaVersion: 1,
      generationStage: 'coldStart',
      factsHash: certifiedPlanningFacts.factsHash,
      catalogHash: catalog.catalogHash,
      sourceRevisionVectorHash: certifiedPlanningFacts.sourceRevisionVectorHash,
      sourceArtifactHash: certifiedPlanningFacts.sourceArtifactHash,
      modelHash: input.authorization.modelHash,
      promptHash: input.authorization.promptHash,
      projectContextFacts: input.projection,
      frozenCapabilityIds: factQueryCatalog.capabilities,
      frozenQueryFamilyIds: factQueryCatalog.families.map((family) => family.id),
      hardCaps: { semanticRepairLimit: 2 },
    },
    validateReceipt(receipt) {
      compiledPlan = compileColdStartPlan(
        certifiedPlanningFacts,
        catalog,
        policy,
        receipt,
        configReceipt,
        factQueryCatalog
      );
    },
  });
  compiledPlan ??= compileColdStartPlan(
    certifiedPlanningFacts,
    catalog,
    policy,
    cognition,
    configReceipt,
    factQueryCatalog
  );
  return Object.freeze({
    certifiedPlanningFacts,
    compiledPlan,
    configReceipt,
    planCognitionHash: hashCanonicalJson(cognition),
  });
}

export function buildCertifiedPlanningFacts(
  carrier: MainCertifiedProjectFactsCarrier,
  projection: MainCertifiedProjectionPayload
): CertifiedPlanningFactsV1 {
  const filesByModule = new Map<string, MainCertifiedSourceFile[]>();
  for (const file of projection.files) {
    for (const moduleId of file.moduleIds) {
      const rows = filesByModule.get(moduleId) ?? [];
      rows.push(file);
      filesByModule.set(moduleId, rows);
    }
  }
  const modules = [...projection.modules]
    .map((module) =>
      mapPlanningModule(module, filesByModule.get(module.moduleId) ?? [], projection)
    )
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  if (modules.length !== projection.modules.length || modules.length === 0) {
    throw new Error('STRICT_PLANNING_MODULE_CONSERVATION_FAILED');
  }
  return Object.freeze({
    schemaVersion: 1,
    factsHash: carrier.factsContentHash,
    sourceRevisionVectorHash: carrier.sourceVectorHash,
    sourceArtifactHash: carrier.certificationBindingHash,
    modules,
  });
}

function mapPlanningModule(
  module: MainCertifiedModule,
  files: readonly MainCertifiedSourceFile[],
  projection: MainCertifiedProjectionPayload
): CertifiedPlanningFactsV1['modules'][number] {
  const ownedFiles = [...new Set(module.ownedFiles)].sort();
  const actualFiles = files.filter((file) => ownedFiles.includes(qualifyMainCertifiedPath(file)));
  if (actualFiles.length !== ownedFiles.length || ownedFiles.length === 0) {
    throw new Error(`STRICT_PLANNING_MODULE_OWNERSHIP_INCOMPLETE:${module.moduleId}`);
  }
  const decoded = actualFiles.map((file) => decodeSource(file));
  const entrypointRefs = actualFiles
    .filter((file) => /(^|\/)(index|main|app|server|cli)\.[^.]+$/u.test(file.relativePath))
    .map(fileRef);
  const publicSurfaceRefs = actualFiles
    .filter((file, index) =>
      /\bexport\b|module\.exports|\bpublic\s+(class|interface|func)\b/u.test(decoded[index] ?? '')
    )
    .map(fileRef);
  const boundaryRefs = actualFiles
    .filter((file, index) =>
      /\b(import|export|route|handler|gateway|adapter|facade)\b/iu.test(decoded[index] ?? '')
    )
    .map(fileRef);
  const crossRepoEdgeRefs = (projection.dependencyGraph?.edges ?? [])
    .filter((edge) => edge.from.includes(module.moduleId) || edge.to.includes(module.moduleId))
    .map((edge) => `dependency:${edge.from}->${edge.to}:${edge.type}`)
    .sort();
  const relativePath = commonOwnedRoot(ownedFiles);
  const moduleClass = entrypointRefs.length > 0 ? 'production-application' : 'production-library';
  const roles = deriveRoles({
    moduleClass,
    ownedFiles,
    publicSurface: publicSurfaceRefs.length > 0,
  });
  return Object.freeze({
    moduleId: module.moduleId,
    scopeId: `repo:${module.repoId}:module:${module.moduleId}`,
    relativePath,
    moduleClass,
    ownedProductionFileCount: ownedFiles.length,
    languages: [...new Set(actualFiles.map((file) => file.language).filter(Boolean))].sort(),
    frameworks: deriveFrameworks(decoded),
    roles,
    entrypointRefs,
    publicSurfaceRefs,
    crossRepoEdgeRefs,
    boundaryRefs,
    ownership: {
      origin: 'certified-project-context-v2',
      confidence: 1,
      evidenceRefs: actualFiles.map(fileRef).sort(),
    },
  });
}

function buildCoveragePolicy(facts: CertifiedPlanningFactsV1): CoveragePlanPolicyV1 {
  const mappings: Record<string, readonly string[]> = {};
  for (const module of facts.modules) {
    mappings[module.moduleClass] = [
      ...new Set([...(mappings[module.moduleClass] ?? []), ...module.roles]),
    ].sort();
  }
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: 'alembic-main-strict-coverage-v1',
    batchBarrierVersion: 'alembic-main-candidate-batch-barrier-v1',
    semanticRepairLimit: 2,
    roleVocabulary: createPlanningRoleVocabularyV1(
      hashCanonicalJson({ authority: 'certified-project-context-v2', mappings }),
      mappings
    ),
  });
}

function deriveRoles(input: {
  moduleClass: string;
  ownedFiles: readonly string[];
  publicSurface: boolean;
}): string[] {
  const haystack = input.ownedFiles.join('\n').toLowerCase();
  const roles = new Set<string>([
    input.moduleClass === 'production-application' ? 'application' : 'library',
  ]);
  if (input.publicSurface) {
    roles.add('public-api');
  }
  for (const [token, role] of [
    ['service', 'service'],
    ['network', 'networking'],
    ['http', 'networking'],
    ['repository', 'storage'],
    ['database', 'storage'],
    ['model', 'model'],
    ['domain', 'core'],
  ] as const) {
    if (haystack.includes(token)) {
      roles.add(role);
    }
  }
  return [...roles].sort();
}

function deriveFrameworks(contents: readonly string[]): string[] {
  const joined = contents.join('\n');
  return [
    ['react', /(?:from\s+['"]react|require\(['"]react)/u],
    ['vue', /(?:from\s+['"]vue|require\(['"]vue)/u],
    ['express', /(?:from\s+['"]express|require\(['"]express)/u],
    ['nestjs', /@nestjs\//u],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(joined))
    .map(([name]) => name as string);
}

function commonOwnedRoot(files: readonly string[]): string {
  const segments = files.map((file) => file.split('/'));
  const common: string[] = [];
  for (let index = 0; index < Math.min(...segments.map((row) => row.length)); index += 1) {
    const value = segments[0]?.[index];
    if (!value || segments.some((row) => row[index] !== value)) {
      break;
    }
    common.push(value);
  }
  return common.length > 0 ? common.join('/') : '.';
}

function decodeSource(file: MainCertifiedSourceFile): string {
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

function fileRef(file: MainCertifiedSourceFile): string {
  return `source:${file.repoId}:${file.relativePath}:${file.blobHash}`;
}
