/**
 * 图工具的宿主端口：Agent 的 graph 工具问"类 / 协议 / 层级 / 调用方 / 被调方 / 影响面 / 搜索"，
 * 回答来自 Core 的关系查询（源码索引）。
 *
 * 这里只做三件事：把模型给的实体名变成查询起点；查询前把索引追到当前源码；
 * 把协议回答整理成模型读得懂的事实，并附上可以原样引用的图引用（graphRefs）。
 * 不保存项目事实，不复制图算法，图引用的写法只有 Core 的那一份。
 */

import type { SourceGraphIndexOptions } from '@alembic/core';
import Logger from '@alembic/core/logging';
import {
  type FileSummary,
  formatRelationGraphRef,
  type ProjectImpactContext,
  type ProjectIndexState,
  type ProjectModuleDependencyContext,
  type ProjectRelationEnvelope,
  type ProjectRelationKind,
  type ProjectRelationRequest,
  type ProjectRelations,
  type ProjectRelationTarget,
  type ProjectRelationWalkContext,
  type ProjectSymbolListContext,
  type RelationSummary,
  type SymbolSummary,
} from '@alembic/core/project-context';

const logger = Logger.getInstance();

/** 一次追索引的结果在这段时间内复用：一轮分析里的连续几次图查询不必各查一遍文件变化。 */
const INDEX_REUSE_MS = 30_000;
/** 一次回答最多带几条图引用；再多模型也抄不过来。 */
const MAX_GRAPH_REFS = 12;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** 类信息里成员名的上限；完整清单用文件大纲去读。 */
const MAX_MEMBER_NAMES = 60;
/** 层级查询沿继承与遵循走几层。 */
const HIERARCHY_DEPTH = 4;
/** 没落到声明上时最多给几个可重问的候选。 */
const MAX_CANDIDATES = 8;
const OVERVIEW_MODULES = 40;
const OVERVIEW_DEPENDENCIES = 40;

const TYPE_HIERARCHY_EXTENDS: ReadonlySet<string> = new Set(['extends', 'inherits']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set([
  'method',
  'function',
  'constructor',
  'getter',
  'setter',
]);

export interface ProjectGraphPortsOptions {
  /** Core 的关系查询入口，绑定在宿主数据库的源码索引上。 */
  relations: Pick<ProjectRelations, 'ensureIndex' | 'query'>;
  /**
   * 建索引的选项。必须与挖掘准备阶段用的是同一份：选项不同索引的身份就不同，两处会轮流重建。
   */
  indexOptions: () => SourceGraphIndexOptions;
}

/** 回答里的一个声明：名字、种类与它写在哪。 */
export interface GraphSymbolFact {
  name: string;
  kind: string;
  /** `路径:行号`。 */
  location: string;
  signature?: string;
}

/** 回答所依据的索引状态；有解析缺口时关系可能不全，"没有"不等于"不存在"。 */
export interface GraphIndexFact {
  freshness: string;
  coverageGaps: number;
}

/** 没能把实体名落到一个声明上：没找到，或者同名的不止一个。这是回答，不是故障。 */
export interface GraphUnresolved {
  entity: string;
  resolved: false;
  reason: 'not-found' | 'ambiguous';
  message: string;
  /** 可以直接拿来重问的写法：`路径#名字`。 */
  candidates: string[];
}

export interface GraphTypeInfo {
  className: string;
  kind: string;
  filePath: string;
  line?: number;
  /** 源码里写出的父类；项目之外的类型也在这里。 */
  superClass?: string;
  /** 源码里写出的协议 / 接口。 */
  protocols?: string[];
  methods: string[];
  properties: string[];
  memberCount: number;
  /** 项目里直接继承或遵循它的类型。 */
  subtypes: string[];
  graphRefs: string[];
  index: GraphIndexFact;
}

export interface GraphProtocolInfo {
  protocolName: string;
  kind: string;
  filePath: string;
  line?: number;
  methods: string[];
  /** 项目里遵循 / 实现它的类型。 */
  conformers: string[];
  graphRefs: string[];
  index: GraphIndexFact;
}

export interface GraphHierarchy {
  entity: string;
  symbol: GraphSymbolFact;
  /** 源码里写出的父类型名字，含项目之外的。 */
  declared?: { extends: string[]; implements: string[] };
  /** 项目内的父类型，按离它的层数排列。 */
  supertypes: Array<GraphSymbolFact & { distance: number }>;
  subtypes: Array<GraphSymbolFact & { distance: number }>;
  truncated: boolean;
  graphRefs: string[];
  index: GraphIndexFact;
}

export interface GraphCallList {
  entity: string;
  /** 起点是一个声明时给出它；起点是文件时给出文件路径。 */
  symbol?: GraphSymbolFact;
  filePath?: string;
  direction: 'callers' | 'callees';
  /** 另一端的声明，以及每一处调用发生的位置。 */
  calls: Array<GraphSymbolFact & { sites: string[]; tier: string }>;
  truncated: boolean;
  graphRefs: string[];
  index: GraphIndexFact;
}

export interface GraphImpact {
  entity: string;
  /** 依赖它的文件（直接或隔着几层）。 */
  impactedFiles: string[];
  impactedSymbols: GraphSymbolFact[];
  /** 其中的测试文件。 */
  tests: string[];
  depth: number;
  truncated: boolean;
  graphRefs: string[];
  index: GraphIndexFact;
}

export interface GraphSearchResult {
  query: string;
  results: GraphSymbolFact[];
  index: GraphIndexFact;
}

export interface GraphOverview {
  index: GraphIndexFact & {
    files?: number;
    symbols?: number;
    relations?: number;
    externalEngine: string;
  };
  modules: Array<{ name: string; kind: string; files: number }>;
  /** 模块之间由代码里的关系构成的依赖，按关系数量排列。 */
  moduleDependencies: Array<{
    from: string;
    to: string;
    relations: number;
    kinds: Record<string, number>;
  }>;
  unownedFiles: number;
  truncated: boolean;
  graphRefs: string[];
}

/** Agent 的 graph 工具按方法名探测的两个端口。 */
export interface ProjectGraphPorts {
  projectGraph: {
    getOverview(): Promise<GraphOverview>;
    getClassInfo(entity: string): Promise<GraphTypeInfo | GraphUnresolved>;
    getProtocolInfo(entity: string): Promise<GraphProtocolInfo | GraphUnresolved>;
    getClassHierarchy(entity: string): Promise<GraphHierarchy | GraphUnresolved>;
    getCallers(entity: string, limit?: number): Promise<GraphCallList | GraphUnresolved>;
    getCallees(entity: string, limit?: number): Promise<GraphCallList | GraphUnresolved>;
    searchEntities(query: string, limit?: number): Promise<GraphSearchResult>;
  };
  /** 影响面查询在 Agent 的工具里挂在这个端口名下。 */
  codeEntityGraph: {
    impactAnalysis(entity: string, limit?: number): Promise<GraphImpact | GraphUnresolved>;
  };
}

type Resolved<T> =
  | { ok: true; data: T; index: GraphIndexFact }
  | { ok: false; unresolved: GraphUnresolved };

export function createProjectGraphPorts(options: ProjectGraphPortsOptions): ProjectGraphPorts {
  const { relations } = options;

  /**
   * 把索引追到当前源码。并发与短期复用由 Core 的入口负责；这里只管结果：
   * 追不上就是故障——没有索引时任何"没找到"都不可信，所以抛错而不是给空结果。
   */
  const currentIndex = async (): Promise<{ projectRoot: string }> => {
    const indexOptions = options.indexOptions();
    const startedAt = Date.now();
    const state = await relations.ensureIndex(indexOptions, { maxAgeMs: INDEX_REUSE_MS });
    if (!state.available) {
      logger.warn(
        `[ProjectGraph] source index unavailable: freshness=${state.freshness} ` +
          `reason=${state.reason ?? 'unknown'} durationMs=${Date.now() - startedAt}`
      );
      throw new Error(
        `Source index is unavailable (${state.freshness}): ${
          state.reason ?? 'the index could not be built for this project'
        }`
      );
    }
    return { projectRoot: indexOptions.projectRoot };
  };

  const ask = async (
    request: Omit<ProjectRelationRequest, 'scope'>
  ): Promise<ProjectRelationEnvelope> => {
    const { projectRoot } = await currentIndex();
    return relations.query({ ...request, scope: { projectRoot } });
  };

  /** 问一个起点已经确定的问题；答不出来就是故障。 */
  const answer = async <T>(request: Omit<ProjectRelationRequest, 'scope'>): Promise<T> => {
    const envelope = await ask(request);
    const failure = failureOf(envelope);
    if (failure) {
      throw new Error(failure.message);
    }
    return envelope.data as T;
  };

  /**
   * 问一个需要起点的问题。实体名落不到声明上时给出"没找到 / 有歧义"的回答与可重问的写法；
   * 其余错误（索引不可用、请求不合法）是故障，原样抛出。
   */
  const askAbout = async <T>(
    kind: ProjectRelationKind,
    entity: string,
    extra: Partial<Omit<ProjectRelationRequest, 'scope' | 'kind' | 'target'>> = {}
  ): Promise<Resolved<T>> => {
    const attempts = entityTargets(entity);
    let last: ProjectRelationEnvelope | undefined;
    for (const [attempt, target] of attempts.entries()) {
      const envelope = await ask({ kind, target, ...extra });
      const error = failureOf(envelope);
      if (!error) {
        if (attempt > 0) {
          // 第一种读法没落到声明上，换了一种读法才成：留痕，便于判断模型的写法习惯。
          logger.info(
            `[ProjectGraph] entity resolved on reading #${attempt + 1}: entity=${entity} ` +
              `target=${JSON.stringify(target)} kind=${kind}`
          );
        }
        return { ok: true, data: envelope.data as T, index: indexFact(envelope.index) };
      }
      last = envelope;
      if (error.code !== 'not-found') {
        break;
      }
    }
    const error = last ? failureOf(last) : undefined;
    if (error?.code === 'not-found' || error?.code === 'ambiguous') {
      const candidates = await similarDeclarations(entity, error.code === 'ambiguous');
      logger.info(
        `[ProjectGraph] entity not resolved: entity=${entity} kind=${kind} reason=${error.code} ` +
          `candidates=${candidates.length}`
      );
      return {
        ok: false,
        unresolved: {
          entity,
          resolved: false,
          reason: error.code,
          message:
            error.code === 'ambiguous'
              ? `More than one declaration is named ${entity}. Ask again with one of the candidates (path#name).`
              : `No declaration or file named ${entity} is in the source index.${
                  candidates.length > 0 ? ' Similar declarations are listed as candidates.' : ''
                }`,
          candidates,
        },
      };
    }
    throw new Error(error?.message ?? `Graph query ${kind} failed for ${entity}`);
  };

  /**
   * 名字相同（歧义）或相近（没找到）的声明，写成可以直接重问的 `路径#名字`。
   * 索引的搜索按相关度排序，会带回不相干的声明；这里只留名字互相包含的。
   */
  const similarDeclarations = async (entity: string, exactOnly: boolean): Promise<string[]> => {
    const name = leafName(entity);
    if (!name) {
      return [];
    }
    const found = await answer<ProjectSymbolListContext>({
      kind: 'search',
      query: exactOnly ? name : name.slice(0, Math.max(3, name.length - 2)),
      limit: MAX_LIMIT,
    });
    const wanted = normalizeEntity(entity);
    const lower = name.toLowerCase();
    const symbols = (found.symbols ?? []).filter((symbol) => {
      if (exactOnly) {
        return symbol.name === wanted || symbol.qualifiedName === wanted;
      }
      const candidate = symbol.name.toLowerCase();
      return candidate.length >= 3 && (candidate.includes(lower) || lower.includes(candidate));
    });
    return symbols
      .slice(0, MAX_CANDIDATES)
      .map((symbol) => `${symbol.filePath}#${displayName(symbol)}`);
  };

  const typeInfo = async (entity: string) => {
    const members = await askAbout<ProjectSymbolListContext>('members', entity, {
      limit: MAX_LIMIT,
    });
    if (!members.ok) {
      return members;
    }
    const anchor = members.data.anchor;
    if (!anchor) {
      throw new Error(`Graph query members returned no anchor for ${entity}`);
    }
    // 起点用引用再问，避免同名声明在第二次查询里重新产生歧义。
    const target: ProjectRelationTarget = { ref: anchor.symbol.ref };
    const supertypes = await answer<ProjectRelationWalkContext>({
      kind: 'supertypes',
      target,
      limit: MAX_LIMIT,
    });
    const subtypes = await answer<ProjectRelationWalkContext>({
      kind: 'subtypes',
      target,
      limit: MAX_LIMIT,
    });
    return {
      ok: true as const,
      anchor,
      members: members.data,
      supertypes,
      subtypes,
      index: members.index,
    };
  };

  const callList = async (
    direction: 'callers' | 'callees',
    entity: string,
    limit: number | undefined
  ): Promise<GraphCallList | GraphUnresolved> => {
    const answer = await askAbout<ProjectRelationWalkContext>(direction, entity, {
      limit: boundedLimit(limit),
    });
    if (!answer.ok) {
      return answer.unresolved;
    }
    const { data } = answer;
    // 另一端的声明各占一项，它的每一处调用位置列在 sites 里。
    const byOtherEnd = new Map<string, GraphSymbolFact & { sites: string[]; tier: string }>();
    for (const relation of data.relations ?? []) {
      const endpoint = direction === 'callers' ? relation.from : relation.to;
      const key = endpoint?.ref?.id ?? endpoint?.label;
      if (!endpoint || !key) {
        continue;
      }
      const symbol = (data.symbols ?? []).find((candidate) => candidate.ref?.id === key);
      const entry = byOtherEnd.get(key) ?? {
        ...(symbol
          ? symbolFact(symbol)
          : {
              // 调用方是文件顶层代码时，另一端是文件本身。
              name: endpoint.label,
              kind: 'file',
              location: endpoint.filePath ?? endpoint.label,
            }),
        sites: [],
        tier: relation.resolution?.tier ?? 'certain',
      };
      const site = siteOf(relation);
      if (site && !entry.sites.includes(site)) {
        entry.sites.push(site);
      }
      if (relation.resolution?.tier === 'trusted') {
        entry.tier = 'trusted';
      }
      byOtherEnd.set(key, entry);
    }
    return {
      entity,
      ...(data.anchor.symbol
        ? { symbol: symbolFact(data.anchor.symbol) }
        : { filePath: data.anchor.file?.filePath }),
      direction,
      calls: [...byOtherEnd.values()],
      truncated: data.truncated === true,
      graphRefs: graphRefsOf(data.relations),
      index: answer.index,
    };
  };

  return {
    projectGraph: {
      async getOverview() {
        const envelope = await ask({ kind: 'module-dependencies', limit: OVERVIEW_DEPENDENCIES });
        const failure = failureOf(envelope);
        if (failure) {
          throw new Error(failure.message);
        }
        const data = envelope.data as ProjectModuleDependencyContext;
        const modules = data.modules ?? [];
        const nameOf = new Map(modules.map((module) => [module.id, module.name]));
        const dependencies = data.dependencies ?? [];
        return {
          index: {
            ...indexFact(envelope.index),
            ...(envelope.index.counts ?? {}),
            externalEngine: envelope.index.externalEngine,
          },
          modules: modules.slice(0, OVERVIEW_MODULES).map((module) => ({
            name: module.name,
            kind: module.kind ?? 'module',
            files: module.ownedFileCount ?? 0,
          })),
          moduleDependencies: dependencies.map((dependency) => ({
            from: nameOf.get(dependency.from) ?? dependency.from,
            to: nameOf.get(dependency.to) ?? dependency.to,
            relations: Object.values(dependency.counts).reduce((sum, count) => sum + count, 0),
            kinds: dependency.counts,
          })),
          unownedFiles: data.unownedFiles ?? 0,
          truncated: data.truncated === true || modules.length > OVERVIEW_MODULES,
          // 每一对模块取一条有代表性的关系，供引用。
          graphRefs: graphRefsOf(
            dependencies.flatMap((dependency) => dependency.samples.slice(0, 1))
          ),
        };
      },

      async getClassInfo(entity) {
        const info = await typeInfo(entity);
        if (!info.ok) {
          return info.unresolved;
        }
        const { anchor, members, supertypes, subtypes } = info;
        const memberNames = (callable: boolean) =>
          uniqueNames(
            (members.symbols ?? [])
              .filter((symbol) => CALLABLE_KINDS.has(symbol.kind) === callable)
              .map((symbol) => symbol.name)
          ).slice(0, MAX_MEMBER_NAMES);
        // 父类与协议以源码写出的名字为准（项目之外的类型也在其中），项目内解析到的关系用来纠偏：
        // Swift 的继承列表不区分父类与协议，语法层把第一个名字记成 extends；项目内解析出它是
        // 被"实现 / 遵循"的，它就是协议。只有 class 才有父类。
        const resolvedExtends = relationTargets(supertypes, (kind) =>
          TYPE_HIERARCHY_EXTENDS.has(kind)
        );
        const resolvedImplements = relationTargets(
          supertypes,
          (kind) => !TYPE_HIERARCHY_EXTENDS.has(kind)
        );
        const writtenExtends = (anchor.heritage?.extends ?? []).filter(
          (name) => !resolvedImplements.includes(name)
        );
        const superClass =
          anchor.symbol.kind === 'class' ? (writtenExtends[0] ?? resolvedExtends[0]) : undefined;
        const protocols = uniqueNames([
          ...(anchor.heritage?.implements ?? []),
          ...(anchor.heritage?.extends ?? []),
          ...resolvedExtends,
          ...resolvedImplements,
        ]).filter((name) => name !== superClass);
        return {
          className: displayName(anchor.symbol),
          kind: anchor.symbol.kind,
          filePath: anchor.symbol.filePath,
          ...(anchor.symbol.range ? { line: anchor.symbol.range.startLine } : {}),
          ...(superClass ? { superClass } : {}),
          ...(protocols.length > 0 ? { protocols } : {}),
          methods: memberNames(true),
          properties: memberNames(false),
          memberCount: (members.symbols ?? []).length,
          subtypes: uniqueNames((subtypes.symbols ?? []).map(displayName)),
          graphRefs: graphRefsOf([...(supertypes.relations ?? []), ...(subtypes.relations ?? [])]),
          index: info.index,
        };
      },

      async getProtocolInfo(entity) {
        const info = await typeInfo(entity);
        if (!info.ok) {
          return info.unresolved;
        }
        const { anchor, members, subtypes } = info;
        return {
          protocolName: displayName(anchor.symbol),
          kind: anchor.symbol.kind,
          filePath: anchor.symbol.filePath,
          ...(anchor.symbol.range ? { line: anchor.symbol.range.startLine } : {}),
          methods: uniqueNames((members.symbols ?? []).map((symbol) => symbol.name)).slice(
            0,
            MAX_MEMBER_NAMES
          ),
          conformers: uniqueNames((subtypes.symbols ?? []).map(displayName)),
          graphRefs: graphRefsOf(subtypes.relations),
          index: info.index,
        };
      },

      async getClassHierarchy(entity) {
        const members = await askAbout<ProjectSymbolListContext>('members', entity, { limit: 1 });
        if (!members.ok) {
          return members.unresolved;
        }
        const anchor = members.data.anchor;
        if (!anchor) {
          throw new Error(`Graph query members returned no anchor for ${entity}`);
        }
        const target: ProjectRelationTarget = { ref: anchor.symbol.ref };
        const walk = (kind: 'supertypes' | 'subtypes') =>
          answer<ProjectRelationWalkContext>({
            kind,
            target,
            depth: HIERARCHY_DEPTH,
            limit: MAX_LIMIT,
          });
        const supertypes = await walk('supertypes');
        const subtypes = await walk('subtypes');
        const withDistance = (data: ProjectRelationWalkContext) =>
          (data.symbols ?? []).map((symbol) => ({
            ...symbolFact(symbol),
            distance: data.distances?.[symbol.ref?.id ?? ''] ?? 1,
          }));
        return {
          entity,
          symbol: symbolFact(anchor.symbol),
          ...(anchor.heritage ? { declared: anchor.heritage } : {}),
          supertypes: withDistance(supertypes),
          subtypes: withDistance(subtypes),
          truncated: supertypes.truncated === true || subtypes.truncated === true,
          graphRefs: graphRefsOf([...(supertypes.relations ?? []), ...(subtypes.relations ?? [])]),
          index: members.index,
        };
      },

      getCallers: (entity, limit) => callList('callers', entity, limit),
      getCallees: (entity, limit) => callList('callees', entity, limit),

      async searchEntities(query, limit) {
        const envelope = await ask({
          kind: 'search',
          query: normalizeEntity(query),
          limit: boundedLimit(limit),
        });
        const failure = failureOf(envelope);
        if (failure) {
          throw new Error(failure.message);
        }
        const data = envelope.data as ProjectSymbolListContext;
        return {
          query,
          results: (data.symbols ?? []).map(symbolFact),
          index: indexFact(envelope.index),
        };
      },
    },

    codeEntityGraph: {
      async impactAnalysis(entity, limit) {
        const answer = await askAbout<ProjectImpactContext>('impact', entity, {
          limit: boundedLimit(limit, MAX_LIMIT),
        });
        if (!answer.ok) {
          return answer.unresolved;
        }
        const { data } = answer;
        return {
          entity,
          impactedFiles: paths(data.impactedFiles),
          impactedSymbols: (data.impactedSymbols ?? []).map(symbolFact),
          tests: paths(data.tests),
          depth: data.depth,
          truncated: data.truncated === true,
          // 影响面的要点是"别的文件依赖它"：跨文件的关系排在前面，引用名额先给它们。
          graphRefs: graphRefsOf(crossFileFirst(data.relations)),
          index: answer.index,
        };
      },
    },
  };
}

/**
 * 这次查询没有给出回答时的那条错误。回答可用时附带的提示（比如模块划分时的警告）不算。
 */
function failureOf(
  envelope: ProjectRelationEnvelope
): { code: string; message: string } | undefined {
  if ((envelope.data as { available?: boolean }).available !== false) {
    return undefined;
  }
  const error = envelope.errors?.[0];
  return {
    code: error?.code ?? 'query-unavailable',
    message:
      error?.message ??
      (envelope.data as { reason?: string }).reason ??
      `Graph query ${envelope.kind} gave no answer`,
  };
}

/**
 * 模型给的实体名 → 查询起点，按可能性排出几种读法，前一种落不到声明上再试后一种。
 *
 * 认得的写法：`Type.member`、`路径#名字`、`路径:行号`、单独的路径、`Type#member`（JSDoc 习惯）、
 * `-[Type selector:]`（ObjC 习惯）、带括号的调用写法 `name()`。
 */
function entityTargets(entity: string): ProjectRelationTarget[] {
  const text = entity.trim();
  const hash = text.indexOf('#');
  if (hash > 0) {
    const left = text.slice(0, hash);
    const right = normalizeEntity(text.slice(hash + 1));
    return looksLikePath(left)
      ? [{ filePath: normalizePath(left), symbol: right }]
      : [{ symbol: `${left}.${right}` }];
  }
  const line = /^(.+):(\d+)$/.exec(text);
  if (line && looksLikePath(line[1])) {
    return [{ filePath: normalizePath(line[1]), line: Number(line[2]) }];
  }
  if (text.includes('/')) {
    return [{ filePath: normalizePath(text) }];
  }
  const symbol = normalizeEntity(text);
  // 根目录下的文件名（main.swift）与 `Type.member` 写法相同：先当声明找，找不到再当文件找。
  return /\.[A-Za-z0-9]+$/.test(text) ? [{ symbol }, { filePath: text }] : [{ symbol }];
}

/** 去掉调用括号，把 ObjC 的方括号写法换成 `Type.selector`。 */
function normalizeEntity(entity: string): string {
  const text = entity.trim();
  const objc = /^[-+]\s*\[\s*(\S+)\s+([^\]]+?)\s*\]$/.exec(text);
  if (objc) {
    return `${objc[1]}.${objc[2]}`;
  }
  return text.replace(/\(.*\)$/, '');
}

function leafName(entity: string): string {
  const normalized = normalizeEntity(
    entity.includes('#') ? (entity.split('#').at(-1) ?? '') : entity
  );
  return normalized.split('.').at(-1) ?? normalized;
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || /\.[A-Za-z0-9]+$/.test(value);
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function displayName(symbol: SymbolSummary): string {
  return symbol.qualifiedName ?? symbol.name;
}

function symbolFact(symbol: SymbolSummary): GraphSymbolFact {
  return {
    name: displayName(symbol),
    kind: symbol.kind,
    location: symbol.range ? `${symbol.filePath}:${symbol.range.startLine}` : symbol.filePath,
    ...(symbol.signature ? { signature: symbol.signature } : {}),
  };
}

function siteOf(relation: RelationSummary): string | undefined {
  if (!relation.filePath) {
    return undefined;
  }
  return relation.range ? `${relation.filePath}:${relation.range.startLine}` : relation.filePath;
}

/** 关系 → 图引用。写法由 Core 定；不是事实或无从复核的关系不产生引用。 */
function graphRefsOf(relations: readonly RelationSummary[] | undefined): string[] {
  const refs: string[] = [];
  for (const relation of relations ?? []) {
    const ref = formatRelationGraphRef(relation);
    if (ref && !refs.includes(ref)) {
      refs.push(ref);
    }
    if (refs.length >= MAX_GRAPH_REFS) {
      break;
    }
  }
  return refs;
}

function crossFileFirst(relations: readonly RelationSummary[] | undefined): RelationSummary[] {
  const crossesFiles = (relation: RelationSummary) =>
    Boolean(relation.from?.filePath && relation.to?.filePath) &&
    relation.from?.filePath !== relation.to?.filePath;
  // sort 是稳定的：同一组内保持索引给出的顺序。
  return [...(relations ?? [])].sort(
    (left, right) => Number(crossesFiles(right)) - Number(crossesFiles(left))
  );
}

function relationTargets(
  data: ProjectRelationWalkContext,
  accept: (kind: string) => boolean
): string[] {
  return uniqueNames(
    (data.relations ?? [])
      .filter((relation) => accept(relation.kind))
      .flatMap((relation) => relation.to?.label ?? [])
  );
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

function paths(files: readonly FileSummary[] | undefined): string[] {
  return (files ?? []).map((file) => file.filePath);
}

function indexFact(index: ProjectIndexState): GraphIndexFact {
  return { freshness: index.freshness, coverageGaps: index.coverageGaps };
}

function boundedLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MAX_LIMIT)
    : fallback;
}
