#!/usr/bin/env node

/**
 * IC2 (Train B) — Dashboard api-types artifact generator.
 *
 * Emits the generated TypeScript contract Dashboard consumes as committed
 * text (P0 §8 spec): Core knowledge wire types (verbatim from the Core
 * declaration file), the failure taxonomy + problem envelope projection,
 * job kinds, and the provider-contracts route table with a deduplicated
 * response-schema registry (the raw per-route schemas repeat 2 distinct
 * envelope schemas 239 times; inlining them would commit ~1 MB).
 *
 * The canonical artifact text is committed in THIS repo at
 * lib/generated/dashboard-api-types.ts; AlembicDashboard lands the same
 * text at src/generated/api-types.ts in the pB2 wave (RC5 pattern:
 * committed text + drift gates on both sides; Dashboard keeps zero
 * package deps).
 *
 * Modes (dry-run by default):
 *   node dist/scripts/generate-dashboard-types.js          # check (alias --check)
 *   node dist/scripts/generate-dashboard-types.js --check  # regenerate + byte-compare
 *   node dist/scripts/generate-dashboard-types.js --write  # rewrite the committed artifact
 *
 * The npm-run-check drift gate lives in test/unit/DashboardApiTypesDrift.test.ts
 * (regenerate + byte-compare through this module, no dist build required).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALEMBIC_JOB_KINDS } from '@alembic/core/daemon';
import { CORE_FAILURE_TAXONOMY, CORE_FIELD_FAILURE_KINDS } from '@alembic/core/shared';
import { buildAlembicHttpProblem } from '../lib/http/problem-taxonomy.js';
import {
  ALEMBIC_PROVIDER_CONTRACT_VERSION,
  ALEMBIC_PROVIDER_ROUTE_CONTRACTS,
} from '../lib/http/provider-contracts.js';

export const DASHBOARD_TYPES_ARTIFACT_RELPATH = 'lib/generated/dashboard-api-types.ts';
export const DASHBOARD_TYPES_TARGET_RELPATH = 'AlembicDashboard/src/generated/api-types.ts';

/** Fields whose values are members of the failure-kind union. */
const KIND_TYPED_FIELDS = new Set(['kind', 'dashboardState', 'mcpStatus', 'reasonCode']);

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'alembic-ai') {
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Could not locate the alembic-ai repo root from ${startDir}`);
}

function fieldType(key: string, value: unknown): string {
  if (KIND_TYPED_FIELDS.has(key)) {
    return 'DashboardFailureKind';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (Array.isArray(value)) {
    if (key === 'errorKinds') {
      return 'readonly DashboardFailureKind[]';
    }
    if (value.every((item) => typeof item === 'string')) {
      return 'readonly string[]';
    }
    return 'readonly unknown[]';
  }
  if (value && typeof value === 'object') {
    return 'Record<string, unknown>';
  }
  return 'unknown';
}

/**
 * Derive an interface from runtime samples: field set = union over samples,
 * a field missing from any sample becomes optional, value types come from
 * the first sample carrying the field. Keys are emitted sorted so the
 * artifact is deterministic.
 */
function deriveInterfaceText(
  name: string,
  samples: readonly Record<string, unknown>[],
  overrides: Readonly<Record<string, string>> = {}
): string {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))].sort();
  const lines = keys.map((key) => {
    const carriers = samples.filter((sample) => key in sample && sample[key] !== undefined);
    const optional = carriers.length < samples.length ? '?' : '';
    const type = overrides[key] ?? fieldType(key, carriers[0]?.[key]);
    return `  readonly ${key}${optional}: ${type};`;
  });
  return `export interface ${name} {\n${lines.join('\n')}\n}`;
}

function unionOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(' | ');
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function generateDashboardApiTypes(
  repoRoot: string = findRepoRoot(__dirnameSafe())
): string {
  // ── Knowledge wire contract: verbatim Core declaration text ──
  const wireDtsPath = path.join(
    repoRoot,
    'node_modules/@alembic/core/dist/types/knowledge-wire.d.ts'
  );
  const wireTypes = readFileSync(wireDtsPath, 'utf8').trimEnd();

  // ── Failure taxonomy projection ──
  const failureKinds = [...CORE_FIELD_FAILURE_KINDS];
  const taxonomyInterface = deriveInterfaceText(
    'DashboardFailureTaxonomyEntry',
    CORE_FAILURE_TAXONOMY as unknown as Record<string, unknown>[]
  );

  // ── Problem envelope projection (wire shape of buildAlembicHttpProblem) ──
  const problemSampleFull = buildAlembicHttpProblem('SAMPLE', 'sample', 'invalid-input', {
    artifactRefs: ['sample'],
    detailRefs: ['sample'],
  }) as unknown as Record<string, unknown>;
  const problemSampleMinimal = buildAlembicHttpProblem(
    'SAMPLE',
    'sample',
    'invalid-input'
  ) as unknown as Record<string, unknown>;
  const problemInterface = deriveInterfaceText(
    'DashboardProblemDetail',
    [problemSampleFull, problemSampleMinimal],
    { failureId: 'string', mcpErrorCode: 'string' }
  );

  // ── Route table with deduplicated response-schema registry ──
  const schemaIdByContent = new Map<string, string>();
  const schemaById = new Map<string, unknown>();
  const routes = ALEMBIC_PROVIDER_ROUTE_CONTRACTS.map((contract) => {
    const { responseSchemas, ...rest } = contract as unknown as Record<string, unknown> & {
      responseSchemas?: Record<string, unknown>;
    };
    const refs: Record<string, string> = {};
    for (const [status, schema] of Object.entries(responseSchemas ?? {})) {
      const content = JSON.stringify(schema);
      let id = schemaIdByContent.get(content);
      if (!id) {
        id = `schema-${schemaIdByContent.size + 1}`;
        schemaIdByContent.set(content, id);
        schemaById.set(id, schema);
      }
      refs[status] = id;
    }
    return { ...rest, responseSchemas: refs };
  });
  const schemaIds = [...schemaById.keys()];
  const routeInterface = deriveInterfaceText('DashboardApiRouteContract', routes, {
    responseSchemas: 'Readonly<Record<string, DashboardApiSchemaId>>',
  });

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Dashboard API contract artifact (IC2, P0 §8): Core knowledge wire types,
 * failure taxonomy + problem envelope projection, job kinds, and the
 * Alembic provider-contracts route table with a deduplicated
 * response-schema registry.
 *
 * Authority chain: @alembic/core src/types/knowledge-wire.ts +
 * src/shared/FailureTaxonomy.ts, Alembic lib/http/provider-contracts.ts +
 * lib/http/problem-taxonomy.ts.
 * Regenerate (in Alembic): npm run build && npm run generate:dashboard-types
 * Drift gate (Alembic side): test/unit/DashboardApiTypesDrift.test.ts via npm run check.
 * Dashboard consumer path: src/generated/api-types.ts (landed by the pB2 wave).
 */

// ════════════════════════════════════════════════════════════════════
// Knowledge wire contract (verbatim from @alembic/core dist/types/knowledge-wire.d.ts)
// ════════════════════════════════════════════════════════════════════

${wireTypes}

// ════════════════════════════════════════════════════════════════════
// Failure taxonomy
// ════════════════════════════════════════════════════════════════════

export type DashboardFailureKind = ${unionOf(failureKinds)};

export const DASHBOARD_FAILURE_KINDS: readonly DashboardFailureKind[] = ${toJson(failureKinds)};

${taxonomyInterface}

export const DASHBOARD_FAILURE_TAXONOMY: readonly DashboardFailureTaxonomyEntry[] = ${toJson(CORE_FAILURE_TAXONOMY)};

// ════════════════════════════════════════════════════════════════════
// Problem envelope (wire shape of the Alembic HTTP problem projection)
// ════════════════════════════════════════════════════════════════════

${problemInterface}

// ════════════════════════════════════════════════════════════════════
// Job kinds
// ════════════════════════════════════════════════════════════════════

export type DashboardJobKind = ${unionOf([...ALEMBIC_JOB_KINDS])};

export const DASHBOARD_JOB_KINDS: readonly DashboardJobKind[] = ${toJson([...ALEMBIC_JOB_KINDS])};

// ════════════════════════════════════════════════════════════════════
// HTTP route contract table (${routes.length} routes, contract version ${ALEMBIC_PROVIDER_CONTRACT_VERSION})
// ════════════════════════════════════════════════════════════════════

export const DASHBOARD_API_CONTRACT_VERSION = ${ALEMBIC_PROVIDER_CONTRACT_VERSION};

export type DashboardApiSchemaId = ${unionOf(schemaIds)};

export const DASHBOARD_API_RESPONSE_SCHEMAS: Readonly<Record<DashboardApiSchemaId, Record<string, unknown>>> = ${toJson(Object.fromEntries(schemaById))};

${routeInterface}

export const DASHBOARD_API_ROUTES: readonly DashboardApiRouteContract[] = ${toJson(routes)};
`;
}

function __dirnameSafe(): string {
  return import.meta.dirname;
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const repoRoot = findRepoRoot(__dirnameSafe());
  const artifactPath = path.join(repoRoot, DASHBOARD_TYPES_ARTIFACT_RELPATH);
  const generated = generateDashboardApiTypes(repoRoot);

  if (write) {
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, generated, 'utf8');
    console.log(
      `[dashboard-types] wrote ${DASHBOARD_TYPES_ARTIFACT_RELPATH} (${generated.length} bytes)`
    );
    return;
  }

  // Default mode is check (dry-run): regenerate + byte-compare.
  if (!existsSync(artifactPath)) {
    console.error(
      `[dashboard-types] FAIL — committed artifact missing: ${DASHBOARD_TYPES_ARTIFACT_RELPATH}`
    );
    process.exitCode = 1;
    return;
  }
  const committed = readFileSync(artifactPath, 'utf8');
  if (committed === generated) {
    console.log(
      '[dashboard-types] PASS — committed artifact matches regenerated output byte-for-byte.'
    );
    return;
  }
  console.error(
    `[dashboard-types] FAIL — drift between generator output and ${DASHBOARD_TYPES_ARTIFACT_RELPATH}. ` +
      'Run: npm run build && npm run generate:dashboard-types'
  );
  process.exitCode = 1;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isDirectRun) {
  main();
}
