#!/usr/bin/env node

/**
 * IC2 (Train B) — Dashboard api-types artifact generator.
 *
 * Emits the generated TypeScript contract Dashboard consumes as committed
 * text (P0 §8 spec): Core knowledge wire types (verbatim from the Core
 * declaration file), the failure taxonomy + problem envelope projection,
 * job kinds, and the provider-contracts route table with a deduplicated
 * response/input-schema registries (the raw per-route schemas repeat across
 * many routes; inlining them would commit a needlessly large artifact).
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

function schemaRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected JSON Schema object for ${context}`);
  }
  return value as Record<string, unknown>;
}

function schemaLiteral(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  throw new Error(`Unsupported JSON Schema literal: ${JSON.stringify(value)}`);
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) ? value : JSON.stringify(value);
}

/**
 * strict-test public contract 很小且 JSON Schema 是 provider 的唯一 wire authority。生成器把
 * 这份 schema 机械投影成 readonly TypeScript；不从样例猜字段，也不在 Dashboard 侧手写
 * 第二份 DTO。这里有意只实现当前 provider schema 使用的 draft-07 子集，遇到未知结构时
 * fail closed，迫使契约扩展同时更新生成器与类型探针。
 */
function readonlyTypeFromSchema(value: unknown, depth = 0): string {
  if (value === true) {
    return 'unknown';
  }
  if (value === false) {
    return 'never';
  }
  const schema = schemaRecord(value, 'readonly type projection');
  if (Object.hasOwn(schema, 'const')) {
    return schemaLiteral(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(schemaLiteral).join(' | ');
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (alternatives) {
    return alternatives.map((item) => `(${readonlyTypeFromSchema(item, depth)})`).join(' | ');
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map((item) => `(${readonlyTypeFromSchema(item, depth)})`).join(' & ');
  }
  if (schema.not) {
    const notSchema = schemaRecord(schema.not, 'not constraint');
    if (Array.isArray(notSchema.required)) {
      const indent = '  '.repeat(depth);
      const childIndent = '  '.repeat(depth + 1);
      const forbidden = notSchema.required.map(
        (key) => `${childIndent}readonly ${propertyName(String(key))}?: never;`
      );
      return `{\n${forbidden.join('\n')}\n${indent}}`;
    }
    throw new Error(`Unsupported JSON Schema not constraint: ${JSON.stringify(schema.not)}`);
  }
  if (schema.type === 'string') {
    return 'string';
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    return 'number';
  }
  if (schema.type === 'boolean') {
    return 'boolean';
  }
  if (schema.type === 'null') {
    return 'null';
  }
  if (schema.type === 'array') {
    return `readonly (${readonlyTypeFromSchema(schema.items ?? true, depth)})[]`;
  }
  if (schema.type === 'object' || schema.properties) {
    const properties = schemaRecord(schema.properties ?? {}, 'object properties');
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.map((item) => String(item)) : []
    );
    if (Object.keys(properties).length === 0 && schema.additionalProperties === false) {
      return 'Readonly<Record<string, never>>';
    }
    const indent = '  '.repeat(depth);
    const childIndent = '  '.repeat(depth + 1);
    const lines = Object.entries(properties).map(([key, child]) => {
      const optional = required.has(key) ? '' : '?';
      return `${childIndent}readonly ${propertyName(key)}${optional}: ${readonlyTypeFromSchema(child, depth + 1)};`;
    });
    if (schema.additionalProperties && schema.additionalProperties !== true) {
      lines.push(
        `${childIndent}readonly [key: string]: ${readonlyTypeFromSchema(schema.additionalProperties, depth + 1)};`
      );
    } else if (schema.additionalProperties === true && lines.length === 0) {
      return 'Readonly<Record<string, unknown>>';
    }
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  if (Object.keys(schema).length === 0) {
    return 'unknown';
  }
  throw new Error(`Unsupported JSON Schema type projection: ${JSON.stringify(schema)}`);
}

function schemaProperty(value: unknown, key: string, context: string): unknown {
  const schema = schemaRecord(value, context);
  const properties = schemaRecord(schema.properties, `${context}.properties`);
  if (!Object.hasOwn(properties, key)) {
    throw new Error(`Missing JSON Schema property ${context}.${key}`);
  }
  return properties[key];
}

function collectSchemaFormats(value: unknown, formats: Set<string>): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSchemaFormats(item, formats);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.format === 'string') {
    formats.add(record.format);
  }
  for (const child of Object.values(record)) {
    collectSchemaFormats(child, formats);
  }
}

function strictTestOperationMapText(
  routes: Readonly<Record<string, Record<string, unknown>>>
): string {
  const responseAliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    preflightStrictTestDimension: {
      '200': 'DashboardStrictTestPreflightSuccessV1',
      '400': 'DashboardStrictTestOrdinaryProblemV1',
      '422': 'DashboardStrictTestOrdinaryProblemV1',
    },
    startStrictTestDimensionRun: {
      '202': 'DashboardStrictTestRunStatusSuccessV1',
      '400': 'DashboardStrictTestOrdinaryProblemV1',
      '404': 'DashboardStrictTestOrdinaryProblemV1',
      '422': 'DashboardStrictTestStartProblemV1',
    },
    getStrictTestDimensionRun: {
      '200': 'DashboardStrictTestRunStatusSuccessV1',
      '400': 'DashboardStrictTestOrdinaryProblemV1',
      '404': 'DashboardStrictTestOrdinaryProblemV1',
      '422': 'DashboardStrictTestOrdinaryProblemV1',
    },
    getStrictTestDimensionReport: {
      '200': 'DashboardStrictTestReportSuccessV1',
      '400': 'DashboardStrictTestOrdinaryProblemV1',
      '404': 'DashboardStrictTestOrdinaryProblemV1',
      '409': 'DashboardStrictTestOrdinaryProblemV1',
      '422': 'DashboardStrictTestOrdinaryProblemV1',
    },
  };
  const requestBodyAliases: Readonly<Record<string, string | null>> = {
    preflightStrictTestDimension: 'DashboardStrictTestPreflightRequestV1',
    startStrictTestDimensionRun: 'DashboardStrictTestRunRequestV1',
    getStrictTestDimensionRun: null,
    getStrictTestDimensionReport: null,
  };
  const operationIds = Object.keys(responseAliases);
  const rows = operationIds.map((operationId) => {
    const route = routes[operationId];
    if (!route) {
      throw new Error(`Missing strict-test provider operation ${operationId}`);
    }
    const responseSchemas = schemaRecord(route.responseSchemas, `${operationId}.responseSchemas`);
    const aliases = responseAliases[operationId];
    const declaredStatuses = Object.keys(responseSchemas).sort();
    if (JSON.stringify(declaredStatuses) !== JSON.stringify(Object.keys(aliases).sort())) {
      throw new Error(`Strict-test response matrix drift for ${operationId}`);
    }
    const bodyAlias = requestBodyAliases[operationId];
    const pathAlias = operationId.startsWith('getStrictTestDimension')
      ? 'DashboardStrictTestRunPathParametersV1'
      : 'DashboardStrictTestEmptyPathParametersV1';
    const requestLines = [
      ...(bodyAlias ? [`      readonly body: ${bodyAlias};`] : ['      readonly body?: never;']),
      `      readonly pathParameters: ${pathAlias};`,
      '      readonly query: DashboardStrictTestEmptyQueryV1;',
    ];
    const responseLines = declaredStatuses.map(
      (status) => `      readonly ${status}: ${aliases[status]};`
    );
    return `  readonly ${operationId}: {\n    readonly request: {\n${requestLines.join('\n')}\n    };\n    readonly responses: {\n${responseLines.join('\n')}\n    };\n  };`;
  });
  return `export type DashboardStrictTestDimensionOperationIdV1 = ${unionOf(operationIds)};\n\nexport interface DashboardStrictTestDimensionOperationMapV1 {\n${rows.join('\n')}\n}\n\nexport type DashboardStrictTestOperationRequestV1<\n  TOperationId extends DashboardStrictTestDimensionOperationIdV1,\n> = DashboardStrictTestDimensionOperationMapV1[TOperationId]['request'];\n\nexport type DashboardStrictTestOperationResponseV1<\n  TOperationId extends DashboardStrictTestDimensionOperationIdV1,\n  TStatus extends number,\n> = TStatus extends keyof DashboardStrictTestDimensionOperationMapV1[TOperationId]['responses']\n  ? DashboardStrictTestDimensionOperationMapV1[TOperationId]['responses'][TStatus]\n  : never;`;
}

function dashboardSchemaValidationRuntimeText(): string {
  return `export type DashboardApiInputFormatValidators = Readonly<
  Partial<Record<DashboardApiInputStringFormat, (value: string) => boolean>>
>;

function dashboardApiSchemaRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateDashboardApiJsonSchema(
  schemaValue: unknown,
  value: unknown,
  formatValidators: DashboardApiInputFormatValidators
): boolean {
  if (schemaValue === true) {
    return true;
  }
  if (schemaValue === false) {
    return false;
  }
  const schema = dashboardApiSchemaRecord(schemaValue);
  if (!schema) {
    return false;
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return false;
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((item) =>
      validateDashboardApiJsonSchema(item, value, formatValidators)
    ).length !== 1
  ) {
    return false;
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((item) => validateDashboardApiJsonSchema(item, value, formatValidators))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((item) => validateDashboardApiJsonSchema(item, value, formatValidators))
  ) {
    return false;
  }
  if (schema.not && validateDashboardApiJsonSchema(schema.not, value, formatValidators)) {
    return false;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return false;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return false;
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return false;
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (typeof schema.format === 'string') {
      const validator = formatValidators[schema.format as DashboardApiInputStringFormat];
      if (!validator || !validator(value)) {
        return false;
      }
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return false;
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) {
      return false;
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return false;
    }
  } else if (schema.type === 'null') {
    if (value !== null) {
      return false;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return false;
    }
    if (
      schema.items &&
      !value.every((item) => validateDashboardApiJsonSchema(schema.items, item, formatValidators))
    ) {
      return false;
    }
  } else if (schema.type === 'object' || schema.properties || schema.required) {
    const record = dashboardApiSchemaRecord(value);
    if (!record) {
      return false;
    }
    const properties = dashboardApiSchemaRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.map((item) => String(item))
      : [];
    if (required.some((key) => !Object.hasOwn(record, key))) {
      return false;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (
        Object.hasOwn(record, key) &&
        !validateDashboardApiJsonSchema(child, record[key], formatValidators)
      ) {
        return false;
      }
    }
    const extraKeys = Object.keys(record).filter((key) => !Object.hasOwn(properties, key));
    if (schema.additionalProperties === false && extraKeys.length > 0) {
      return false;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      if (
        !extraKeys.every((key) =>
          validateDashboardApiJsonSchema(schema.additionalProperties, record[key], formatValidators)
        )
      ) {
        return false;
      }
    }
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    return false;
  }
  return true;
}

export function validateDashboardApiInputSchema(
  schemaId: DashboardApiInputSchemaId,
  value: unknown,
  formatValidators: DashboardApiInputFormatValidators
): boolean {
  return validateDashboardApiJsonSchema(
    DASHBOARD_API_INPUT_SCHEMAS[schemaId],
    value,
    formatValidators
  );
}

export function validateDashboardApiResponseSchema(
  schemaId: DashboardApiSchemaId,
  value: unknown,
  formatValidators: DashboardApiInputFormatValidators = {}
): boolean {
  return validateDashboardApiJsonSchema(
    DASHBOARD_API_RESPONSE_SCHEMAS[schemaId],
    value,
    formatValidators
  );
}

export function validateDashboardStrictTestOperationRequest<
  TOperationId extends DashboardStrictTestDimensionOperationIdV1,
>(
  operationId: TOperationId,
  value: unknown,
  formatValidators: DashboardApiInputFormatValidators
): value is DashboardStrictTestOperationRequestV1<TOperationId> {
  const route = DASHBOARD_API_ROUTES.find((candidate) => candidate.operationId === operationId);
  const request = dashboardApiSchemaRecord(value);
  if (!route || !request) {
    return false;
  }
  const expectedKeys = new Set(['pathParameters', 'query']);
  if (route.requestBodySchema) {
    expectedKeys.add('body');
  }
  if (
    Object.keys(request).some((key) => !expectedKeys.has(key)) ||
    [...expectedKeys].some((key) => !Object.hasOwn(request, key))
  ) {
    return false;
  }
  if (
    route.requestBodySchema &&
    !validateDashboardApiInputSchema(route.requestBodySchema, request.body, formatValidators)
  ) {
    return false;
  }
  const query = route.querySchema
    ? validateDashboardApiInputSchema(route.querySchema, request.query, formatValidators)
    : request.query === null;
  if (!query) {
    return false;
  }
  const pathParameters = dashboardApiSchemaRecord(request.pathParameters);
  if (!pathParameters) {
    return false;
  }
  const pathSchemas = route.pathParameterSchemas ?? {};
  if (
    Object.keys(pathParameters).sort().join('\\0') !== Object.keys(pathSchemas).sort().join('\\0')
  ) {
    return false;
  }
  return Object.entries(pathSchemas).every(([name, schemaId]) =>
    validateDashboardApiInputSchema(schemaId, pathParameters[name], formatValidators)
  );
}

export function validateDashboardStrictTestOperationResponse<
  TOperationId extends DashboardStrictTestDimensionOperationIdV1,
  TStatus extends number,
>(
  operationId: TOperationId,
  status: TStatus,
  value: unknown,
  formatValidators: DashboardApiInputFormatValidators = {}
): value is DashboardStrictTestOperationResponseV1<TOperationId, TStatus> {
  const route = DASHBOARD_API_ROUTES.find((candidate) => candidate.operationId === operationId);
  const schemaId = route?.responseSchemas[String(status)];
  return schemaId ? validateDashboardApiResponseSchema(schemaId, value, formatValidators) : false;
}`;
}

function readCoreKnowledgeWireTypes(repoRoot: string): string {
  const candidateRelpaths = [
    'node_modules/@alembic/core/dist/types/KnowledgeWire.d.ts',
    'node_modules/@alembic/core/dist/types/knowledge-wire.d.ts',
  ];
  for (const relpath of candidateRelpaths) {
    const dtsPath = path.join(repoRoot, relpath);
    if (existsSync(dtsPath)) {
      return readFileSync(dtsPath, 'utf8').trimEnd();
    }
  }
  throw new Error(
    `Could not locate Core knowledge wire declarations. Tried: ${candidateRelpaths.join(', ')}`
  );
}

export function generateDashboardApiTypes(
  repoRoot: string = findRepoRoot(__dirnameSafe())
): string {
  // ── Knowledge wire contract: verbatim Core declaration text ──
  const wireTypes = readCoreKnowledgeWireTypes(repoRoot);

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
  const responseSchemaIdByContent = new Map<string, string>();
  const responseSchemaById = new Map<string, unknown>();
  const inputSchemaIdByContent = new Map<string, string>();
  const inputSchemaById = new Map<string, unknown>();
  const inputSchemaRef = (schema: unknown): string | null => {
    if (schema === null || schema === undefined) {
      return null;
    }
    const content = JSON.stringify(schema);
    let id = inputSchemaIdByContent.get(content);
    if (!id) {
      id = `input-schema-${inputSchemaIdByContent.size + 1}`;
      inputSchemaIdByContent.set(content, id);
      inputSchemaById.set(id, schema);
    }
    return id;
  };
  const routes = ALEMBIC_PROVIDER_ROUTE_CONTRACTS.map((contract) => {
    const { pathParameterSchemas, querySchema, requestBodySchema, responseSchemas, ...rest } =
      contract as unknown as Record<string, unknown> & {
        pathParameterSchemas?: Record<string, unknown>;
        querySchema?: unknown;
        requestBodySchema?: unknown;
        responseSchemas?: Record<string, unknown>;
      };
    const responseRefs: Record<string, string> = {};
    for (const [status, schema] of Object.entries(responseSchemas ?? {})) {
      const content = JSON.stringify(schema);
      let id = responseSchemaIdByContent.get(content);
      if (!id) {
        id = `schema-${responseSchemaIdByContent.size + 1}`;
        responseSchemaIdByContent.set(content, id);
        responseSchemaById.set(id, schema);
      }
      responseRefs[status] = id;
    }
    const pathParameterRefs = Object.fromEntries(
      Object.entries(pathParameterSchemas ?? {}).map(([name, schema]) => [
        name,
        inputSchemaRef(schema),
      ])
    );
    const querySchemaRef = inputSchemaRef(querySchema);
    const requestBodySchemaRef = inputSchemaRef(requestBodySchema);
    return {
      ...rest,
      ...(Object.keys(pathParameterRefs).length > 0
        ? { pathParameterSchemas: pathParameterRefs }
        : {}),
      ...(querySchemaRef ? { querySchema: querySchemaRef } : {}),
      ...(requestBodySchemaRef ? { requestBodySchema: requestBodySchemaRef } : {}),
      responseSchemas: responseRefs,
    };
  });
  const responseSchemaIds = [...responseSchemaById.keys()];
  const inputSchemaIds = [...inputSchemaById.keys()];
  const inputFormats = new Set<string>();
  for (const schema of inputSchemaById.values()) {
    collectSchemaFormats(schema, inputFormats);
  }
  const routeInterface = deriveInterfaceText('DashboardApiRouteContract', routes, {
    pathParameterSchemas: 'Readonly<Record<string, DashboardApiInputSchemaId>>',
    querySchema: 'DashboardApiInputSchemaId | null',
    requestBodySchema: 'DashboardApiInputSchemaId | null',
    responseSchemas: 'Readonly<Record<string, DashboardApiSchemaId>>',
  });
  const strictProviderRoutes = Object.fromEntries(
    ALEMBIC_PROVIDER_ROUTE_CONTRACTS.filter((route) => route.tags.includes('Strict Test')).map(
      (route) => [route.operationId, route as unknown as Record<string, unknown>]
    )
  );
  const strictRoute = (operationId: string): Record<string, unknown> => {
    const route = strictProviderRoutes[operationId];
    if (!route) {
      throw new Error(`Missing strict-test provider route ${operationId}`);
    }
    return route;
  };
  const strictResponse = (operationId: string, status: string): unknown => {
    const schemas = schemaRecord(
      strictRoute(operationId).responseSchemas,
      `${operationId}.responseSchemas`
    );
    if (!Object.hasOwn(schemas, status)) {
      throw new Error(`Missing strict-test provider response ${operationId}:${status}`);
    }
    return schemas[status];
  };
  const preflightRoute = strictRoute('preflightStrictTestDimension');
  const startRoute = strictRoute('startStrictTestDimensionRun');
  const statusRoute = strictRoute('getStrictTestDimensionRun');
  const ordinaryProblemSchema = strictResponse('preflightStrictTestDimension', '400');
  const ordinaryProblemAllOf = schemaRecord(
    ordinaryProblemSchema,
    'strict-test ordinary problem'
  ).allOf;
  if (!Array.isArray(ordinaryProblemAllOf) || ordinaryProblemAllOf.length === 0) {
    throw new Error('Strict-test ordinary problem must retain its closed allOf authority');
  }
  const problemDetailSchema = schemaProperty(
    ordinaryProblemAllOf[0],
    'error',
    'strict-test ordinary problem base'
  );
  const statusPathSchemas = schemaRecord(
    statusRoute.pathParameterSchemas,
    'strict-test status path parameters'
  );
  const startProblemSchema = schemaRecord(
    strictResponse('startStrictTestDimensionRun', '422'),
    'strict-test start problem'
  );
  const startProblemVariants = startProblemSchema.oneOf;
  if (!Array.isArray(startProblemVariants) || startProblemVariants.length !== 2) {
    throw new Error('Strict-test start problem must retain its closed two-branch union');
  }
  const strictTestContractTypes = `export type DashboardStrictTestPreflightRequestV1 = ${readonlyTypeFromSchema(preflightRoute.requestBodySchema)};

export type DashboardStrictTestRunRequestV1 = ${readonlyTypeFromSchema(startRoute.requestBodySchema)};

export type DashboardStrictTestEmptyQueryV1 = ${readonlyTypeFromSchema(preflightRoute.querySchema)};

export type DashboardStrictTestEmptyPathParametersV1 = Readonly<Record<string, never>>;

export type DashboardStrictTestRunPathParametersV1 = ${readonlyTypeFromSchema({
    type: 'object',
    required: Object.keys(statusPathSchemas),
    additionalProperties: false,
    properties: statusPathSchemas,
  })};

export type DashboardStrictTestPreflightPublicDtoV1 = ${readonlyTypeFromSchema(
    schemaProperty(
      strictResponse('preflightStrictTestDimension', '200'),
      'data',
      'strict-test preflight success'
    )
  )};

export type DashboardStrictTestRunStatusPublicDtoV1 = ${readonlyTypeFromSchema(
    schemaProperty(
      strictResponse('getStrictTestDimensionRun', '200'),
      'data',
      'strict-test status success'
    )
  )};

export type DashboardStrictTestReportPublicDtoV1 = ${readonlyTypeFromSchema(
    schemaProperty(
      strictResponse('getStrictTestDimensionReport', '200'),
      'data',
      'strict-test report success'
    )
  )};

export type DashboardStrictTestProblemDetailV1 = ${readonlyTypeFromSchema(problemDetailSchema)};

export interface DashboardStrictTestSuccessEnvelopeV1<TData> {
  readonly success: true;
  readonly data: TData;
}

export type DashboardStrictTestPreflightSuccessV1 =
  DashboardStrictTestSuccessEnvelopeV1<DashboardStrictTestPreflightPublicDtoV1>;
export type DashboardStrictTestRunStatusSuccessV1 =
  DashboardStrictTestSuccessEnvelopeV1<DashboardStrictTestRunStatusPublicDtoV1>;
export type DashboardStrictTestReportSuccessV1 =
  DashboardStrictTestSuccessEnvelopeV1<DashboardStrictTestReportPublicDtoV1>;

export type DashboardStrictTestOrdinaryProblemV1 = ${readonlyTypeFromSchema(ordinaryProblemSchema)};

export type DashboardStrictTestProblemWithStatusV1 = ${readonlyTypeFromSchema(
    startProblemVariants[1]
  )};

export type DashboardStrictTestStartProblemV1 = ${readonlyTypeFromSchema(
    strictResponse('startStrictTestDimensionRun', '422')
  )};`;
  const strictTestOperationMap = strictTestOperationMapText(strictProviderRoutes);
  const inputFormatType = inputFormats.size > 0 ? unionOf([...inputFormats].sort()) : 'never';
  const schemaValidationRuntime = dashboardSchemaValidationRuntimeText();

  return `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Dashboard API contract artifact (IC2, P0 §8): Core knowledge wire types,
 * failure taxonomy + problem envelope projection, job kinds, and the
 * Alembic provider-contracts route table with a deduplicated
 * response/input-schema registries.
 *
 * Authority chain: @alembic/core src/types/KnowledgeWire.ts +
 * src/shared/FailureTaxonomy.ts, Alembic lib/http/provider-contracts.ts +
 * lib/http/problem-taxonomy.ts.
 * Regenerate (in Alembic): npm run build && npm run generate:dashboard-types
 * Drift gate (Alembic side): test/unit/DashboardApiTypesDrift.test.ts via npm run check.
 * Dashboard consumer path: src/generated/api-types.ts (landed by the pB2 wave).
 */

// ════════════════════════════════════════════════════════════════════
// Knowledge wire contract (verbatim from @alembic/core dist/types/KnowledgeWire.d.ts)
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

export type DashboardApiSchemaId = ${unionOf(responseSchemaIds)};

export const DASHBOARD_API_RESPONSE_SCHEMAS: Readonly<Record<DashboardApiSchemaId, Record<string, unknown>>> = ${toJson(Object.fromEntries(responseSchemaById))};

export type DashboardApiInputSchemaId = ${unionOf(inputSchemaIds)};

export const DASHBOARD_API_INPUT_SCHEMAS: Readonly<Record<DashboardApiInputSchemaId, Record<string, unknown>>> = ${toJson(Object.fromEntries(inputSchemaById))};

export type DashboardApiInputStringFormat = ${inputFormatType};

${routeInterface}

export const DASHBOARD_API_ROUTES: readonly DashboardApiRouteContract[] = ${toJson(routes)};

// ════════════════════════════════════════════════════════════════════
// Strict-test consumer contract (readonly types mechanically projected from provider JSON Schema)
// ════════════════════════════════════════════════════════════════════

${strictTestContractTypes}

${strictTestOperationMap}

// Main-owned custom formats are injected explicitly. Missing format authority fails closed.
${schemaValidationRuntime}
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
