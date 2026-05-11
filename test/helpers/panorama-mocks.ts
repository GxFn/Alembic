/**
 * Panorama 测试用 Mock Repository 工厂
 *
 * 由于 Panorama 服务层从 raw-db 迁移到 Drizzle Repository，
 * 测试需要提供 repo mock 而非 db mock。
 *
 * 所有方法返回安全默认值 (空数组/0/null)，可通过 opts 覆盖关键返回值。
 */

import type { BootstrapRepositoryImpl } from '../../lib/repository/bootstrap/BootstrapRepository.js';
import type { CodeEntityRepositoryImpl } from '../../lib/repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../lib/repository/knowledge/KnowledgeEdgeRepository.js';
import type { KnowledgeRepositoryImpl } from '../../lib/repository/knowledge/KnowledgeRepository.impl.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export interface MockEntity {
  entity_id: string;
  entity_type?: string;
  project_root?: string;
  name?: string;
  file_path?: string | null;
  superclass?: string | null;
  protocols?: string;
  metadata_json?: string;
}

export interface MockEdge {
  from_id: string;
  from_type?: string;
  to_id: string;
  to_type?: string;
  relation: string;
  weight?: number;
}

export interface MockRepoOptions {
  entities?: MockEntity[];
  edges?: MockEdge[];
  recipeCount?: number;
  recipeRows?: Array<{ title: string; category: string; topicHint: string; kind: string }>;
  primaryLang?: string | null;
  /** Override for getEntityCount (defaults to entities.length) */
  entityCount?: number;
  /** Override for countEdgesJoinedByEntityFiles — keyed by `${relation}:${direction}` */
  edgeCounts?: Record<string, number>;
  /** Pattern names returned by findPatternsUsedByEntities */
  patterns?: string[];
}

/* ═══ CodeEntityRepository Mock ═══════════════════════════ */

function mapMockEntity(raw: MockEntity) {
  return {
    id: 0,
    entityId: raw.entity_id,
    entityType: raw.entity_type ?? 'class',
    projectRoot: raw.project_root ?? '/test',
    name: raw.name ?? raw.entity_id,
    filePath: raw.file_path ?? null,
    lineNumber: null,
    superclass: raw.superclass ?? null,
    protocols: raw.protocols ? JSON.parse(raw.protocols) : [],
    metadata: raw.metadata_json ? JSON.parse(raw.metadata_json) : {},
    createdAt: 0,
    updatedAt: 0,
  };
}

export function createMockEntityRepo(opts: MockRepoOptions = {}): CodeEntityRepositoryImpl {
  const entities = opts.entities ?? [];

  return {
    findLocalModules(_projectRoot: string) {
      return entities
        .filter((e) => {
          if (e.entity_type !== 'module') {
            return false;
          }
          if (e.metadata_json) {
            try {
              const meta = JSON.parse(e.metadata_json);
              if (meta.nodeType === 'external' || meta.nodeType === 'host') {
                return false;
              }
            } catch {
              /* ignore */
            }
          }
          return true;
        })
        .map((e) => ({ entityId: e.entity_id, name: e.name ?? e.entity_id }));
    },
    findByEntityIdOnly(entityId: string, _projectRoot: string) {
      const e = entities.find((x) => x.entity_id === entityId);
      return e ? mapMockEntity(e) : null;
    },
    findByProjectAndFilePaths(_projectRoot: string, filePaths: string[]) {
      return entities
        .filter((e) => e.file_path && filePaths.includes(e.file_path))
        .map(mapMockEntity);
    },
    findModulesByNodeTypes(_projectRoot: string, types: string[]) {
      return entities
        .filter((e) => {
          if (e.entity_type !== 'module') {
            return false;
          }
          if (e.metadata_json) {
            try {
              const meta = JSON.parse(e.metadata_json);
              return types.includes(meta.nodeType);
            } catch {
              return false;
            }
          }
          return false;
        })
        .map(mapMockEntity);
    },
    countModulesByNodeType(_projectRoot: string, type: string) {
      return entities.filter((e) => {
        if (e.entity_type !== 'module') {
          return false;
        }
        if (e.metadata_json) {
          try {
            const meta = JSON.parse(e.metadata_json);
            return meta.nodeType === type;
          } catch {
            return false;
          }
        }
        return false;
      }).length;
    },
    findDistinctFilePaths(_projectRoot: string, _limit?: number) {
      return entities.map((e) => e.file_path).filter((fp): fp is string => fp != null);
    },
    getEntityCount(_projectRoot: string) {
      return opts.entityCount ?? entities.length;
    },
  } as unknown as CodeEntityRepositoryImpl;
}

/* ═══ KnowledgeEdgeRepository Mock ════════════════════════ */

function mapMockEdge(raw: MockEdge) {
  return {
    id: 0,
    fromId: raw.from_id,
    fromType: raw.from_type ?? 'module',
    toId: raw.to_id,
    toType: raw.to_type ?? 'module',
    relation: raw.relation,
    weight: raw.weight ?? 1,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

export function createMockEdgeRepo(opts: MockRepoOptions = {}): KnowledgeEdgeRepositoryImpl {
  const edges = opts.edges ?? [];

  return {
    findByRelation(relation: string) {
      return edges.filter((e) => e.relation === relation).map(mapMockEdge);
    },
    findIncomingByRelation(toId: string, relation: string) {
      return edges.filter((e) => e.to_id === toId && e.relation === relation).map(mapMockEdge);
    },
    findOutgoingByRelation(fromId: string, relation: string) {
      return edges.filter((e) => e.from_id === fromId && e.relation === relation).map(mapMockEdge);
    },
    findOutgoing(fromId: string) {
      return edges.filter((e) => e.from_id === fromId).map(mapMockEdge);
    },
    findIncoming(toId: string) {
      return edges.filter((e) => e.to_id === toId).map(mapMockEdge);
    },
    findEdgesFilteredByEntityExistence(relation: string, _projectRoot: string) {
      return edges.filter((e) => e.relation === relation).map(mapMockEdge);
    },
    findModuleDependencyPairs() {
      return edges
        .filter(
          (e) =>
            e.relation === 'depends_on' &&
            (e.from_type ?? 'module') === 'module' &&
            (e.to_type ?? 'module') === 'module'
        )
        .map((e) => ({ fromId: e.from_id, toId: e.to_id }));
    },
    findTopCalledNodes(_limit?: number) {
      // Aggregate call edges by to_id
      const callCounts = new Map<string, number>();
      for (const e of edges) {
        if (e.relation === 'calls') {
          callCounts.set(e.to_id, (callCounts.get(e.to_id) ?? 0) + 1);
        }
      }
      return [...callCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([toId, callCount]) => ({ toId, callCount }));
    },
    findEntryPoints(_limit?: number) {
      return [];
    },
    findTopDataFlowSources(_limit?: number, _minOutFlow?: number) {
      return [];
    },
    findTopDataFlowSinks(_limit?: number, _minInFlow?: number) {
      return [];
    },
    countEdgesJoinedByEntityFiles(
      _projectRoot: string,
      _filePaths: string[],
      relation: string,
      direction: string
    ) {
      return opts.edgeCounts?.[`${relation}:${direction}`] ?? 0;
    },
    findPatternsUsedByEntities(_projectRoot: string, _filePaths: string[]) {
      return opts.patterns ?? [];
    },
  } as unknown as KnowledgeEdgeRepositoryImpl;
}

/* ═══ BootstrapRepository Mock ════════════════════════════ */

export function createMockBootstrapRepo(opts: MockRepoOptions = {}): BootstrapRepositoryImpl {
  return {
    getLatestPrimaryLang(_projectRoot: string) {
      return opts.primaryLang ?? null;
    },
  } as unknown as BootstrapRepositoryImpl;
}

/* ═══ KnowledgeRepository Mock ════════════════════════════ */

export function createMockKnowledgeRepo(opts: MockRepoOptions = {}): KnowledgeRepositoryImpl {
  return {
    countByCountableLifecycles() {
      return opts.recipeCount ?? 0;
    },
    findRecipeMetadata(_lifecycles: readonly string[]) {
      return opts.recipeRows ?? [];
    },
    findRecipesByModuleContext(
      _lifecycles: readonly string[],
      _moduleName: string,
      _categories: string[],
      _limit: number
    ) {
      return [];
    },
  } as unknown as KnowledgeRepositoryImpl;
}

/* ═══ Bundle Helper ═══════════════════════════════════════ */

export function createMockRepos(opts: MockRepoOptions = {}) {
  return {
    entityRepo: createMockEntityRepo(opts),
    edgeRepo: createMockEdgeRepo(opts),
    bootstrapRepo: createMockBootstrapRepo(opts),
    knowledgeRepo: createMockKnowledgeRepo(opts),
  };
}
