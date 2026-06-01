import type {
  CreateRecipeItem,
  CreateRecipeRequest,
  RecipeProductionGateway,
  RecipeProductionProjectScopeSourceRefOptions,
} from '@alembic/core/knowledge';
import { resolveProjectScopeSourceIdentitiesFromContainer } from './ProjectScopeAnalysis.js';

interface ContainerLike {
  singletons?: Record<string, unknown>;
}

type RecipeProductionGatewayCreate = RecipeProductionGateway['create'];
type RecipeProductionOptions = NonNullable<CreateRecipeRequest['options']>;

interface RecipeProductionGatewayLike {
  create: RecipeProductionGatewayCreate;
}

const PROJECT_SCOPE_SOURCE_REF_GATE_ATTACHED = Symbol.for(
  'alembic.projectScopeSourceRefGate.attached'
);

type GateAttachedGateway<T> = T & {
  [PROJECT_SCOPE_SOURCE_REF_GATE_ATTACHED]?: true;
};

export function attachProjectScopeSourceRefGateToRecipeProductionGateway<
  T extends RecipeProductionGatewayLike,
>(gateway: T, container: ContainerLike): T {
  const mutableGateway = gateway as GateAttachedGateway<T>;
  if (mutableGateway[PROJECT_SCOPE_SOURCE_REF_GATE_ATTACHED]) {
    return gateway;
  }

  const create = gateway.create.bind(gateway);
  // RecipeProductionGateway 是 singleton，但 ProjectScope identities 会随冷启动/重扫刷新；
  // 所以必须在 create 时读取当前 container，不能在注册 singleton 时捕获一次。
  mutableGateway.create = (async (request: CreateRecipeRequest) => {
    const options = withProjectScopeRecipeProductionSourceRefOptions(
      container,
      request.options ?? {}
    );
    const items = options.projectScopeSourceRefs
      ? appendVisibleSourceMarkersToSourceRefs(request.items)
      : request.items;
    return create({
      ...request,
      items,
      options,
    });
  }) as RecipeProductionGatewayCreate;
  mutableGateway[PROJECT_SCOPE_SOURCE_REF_GATE_ATTACHED] = true;

  return gateway;
}

export function withProjectScopeRecipeProductionSourceRefOptions(
  container: ContainerLike,
  options: RecipeProductionOptions = {}
): RecipeProductionOptions {
  if (options.projectScopeSourceRefs) {
    return options;
  }

  const projectScopeSourceRefs =
    resolveRecipeProductionProjectScopeSourceRefOptionsFromContainer(container);
  if (!projectScopeSourceRefs) {
    return options;
  }

  return {
    ...options,
    projectScopeSourceRefs,
  };
}

export function resolveRecipeProductionProjectScopeSourceRefOptionsFromContainer(
  container: ContainerLike | null | undefined
): RecipeProductionProjectScopeSourceRefOptions | undefined {
  const sourceIdentities = resolveProjectScopeSourceIdentitiesFromContainer(container);
  if (sourceIdentities.length === 0) {
    return undefined;
  }
  return { sourceIdentities };
}

function appendVisibleSourceMarkersToSourceRefs(items: CreateRecipeItem[]): CreateRecipeItem[] {
  return items.map((item) => {
    const markers = extractVisibleSourceMarkers(item);
    if (markers.length === 0) {
      return item;
    }
    return {
      ...item,
      sourceRefs: uniqueStrings([
        ...(Array.isArray(item.sourceRefs) ? item.sourceRefs : []),
        ...markers,
      ]),
    };
  });
}

function extractVisibleSourceMarkers(item: CreateRecipeItem): string[] {
  const markers: string[] = [];
  const content = isRecord(item.content) ? item.content : {};
  markers.push(...extractMarkedSourceRefsFromMarkdown(stringValue(content.markdown)));
  markers.push(...extractMarkedSourceRefsFromMarkdown(stringValue(content.source)));
  markers.push(...extractMarkedSourceRefsFromCode(stringValue(item.coreCode)));
  markers.push(...extractMarkedSourceRefsFromCode(stringValue(content.pattern)));
  return uniqueStrings(markers);
}

function extractMarkedSourceRefsFromMarkdown(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const refs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!SOURCE_MARKER_LINE_PATTERN.test(line)) {
      continue;
    }
    refs.push(...extractPathLikeRefs(line));
  }
  return refs;
}

function extractMarkedSourceRefsFromCode(text: string | null): string[] {
  if (!text) {
    return [];
  }
  const refs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^(\/\/|#|\/\*|\*)/.test(trimmed) || !SOURCE_MARKER_LINE_PATTERN.test(trimmed)) {
      continue;
    }
    refs.push(...extractPathLikeRefs(trimmed));
  }
  return refs;
}

const SOURCE_MARKER_LINE_PATTERN =
  /\b(source|sources|sourceRefs?|file|files|path|paths|ref|refs)\b|来源|文件|路径/i;

const PATH_LIKE_SOURCE_REF_PATTERN =
  /(?:^|[\s`"'([{])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|css|go|html|java|js|jsx|json|kt|md|mjs|py|rs|scss|sql|swift|ts|tsx|yaml|yml)(?::\d+(?::\d+)?)?)(?=$|[\s`"',).;\]}])/g;

function extractPathLikeRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(PATH_LIKE_SOURCE_REF_PATTERN)) {
    if (match[1]) {
      refs.push(stripSourceRefLineSuffix(match[1]));
    }
  }
  return uniqueStrings(refs);
}

function stripSourceRefLineSuffix(sourceRef: string): string {
  return sourceRef.replace(/:\d+(?::\d+)?$/, '');
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
