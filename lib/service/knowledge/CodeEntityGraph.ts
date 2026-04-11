/**
 * CodeEntityGraph — 代码实体关系图谱
 *
 * Phase E: 在 Semantic Memory 之上构建代码实体图谱
 *
 * 节点类型:
 *   - class      : ObjC @interface / Swift class/struct
 *   - protocol   : ObjC @protocol / Swift protocol
 *   - category   : ObjC Category / Swift Extension
 *   - module     : SPM/CocoaPods module
 *   - pattern    : 设计模式 (singleton, delegate, etc.)
 *
 * 边类型 (复用 knowledge_edges 表):
 *   - inherits    : 类继承
 *   - conforms    : 协议遵循
 *   - extends     : Category/Extension
 *   - depends_on  : 模块依赖
 *   - uses_pattern: 使用设计模式
 *   - is_part_of  : 属于模块
 *   - calls       : 方法调用 (Phase 5)
 *   - data_flow   : 数据流向 (Phase 5)
 *
 * @module CodeEntityGraph
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type { CodeEntityRepositoryImpl } from '../../repository/code/CodeEntityRepository.js';
import type { KnowledgeEdgeRepositoryImpl } from '../../repository/knowledge/KnowledgeEdgeRepository.js';

const logger = Logger.getInstance();

/* ══ Repository type aliases ══════════════════════════════ */

type EntityRepoLike = Pick<
  CodeEntityRepositoryImpl,
  | 'upsert'
  | 'batchUpsert'
  | 'findByEntityId'
  | 'findByEntityIdOnly'
  | 'listByType'
  | 'searchByName'
  | 'clearProject'
  | 'deleteByFile'
  | 'deleteByFileAndType'
  | 'countByType'
>;

type EdgeRepoLike = Pick<
  KnowledgeEdgeRepositoryImpl,
  | 'upsertEdge'
  | 'removeEdge'
  | 'findOutgoing'
  | 'findIncoming'
  | 'findIncomingByRelation'
  | 'findOutgoingByRelation'
  | 'findOutgoingToId'
  | 'findIncomingByFromTypes'
  | 'findConformances'
  | 'findByRelation'
  | 'countByRelation'
  | 'getHotNodes'
  | 'countIncomingByRelation'
  | 'countByRelationType'
  | 'deleteByMetadataLike'
>;

/* ══ Internal interfaces ══════════════════════════════════ */

interface AstClass {
  name: string;
  isCategory?: boolean;
  file?: string;
  line?: number;
  endLine?: number;
  superclass?: string;
  protocols?: string[];
}

interface AstProtocol {
  name: string;
  file?: string;
  line?: number;
  inherits?: string[];
  methods?: unknown[];
}

interface AstCategory {
  className: string;
  categoryName: string;
  file?: string;
  line?: number;
  protocols?: string[];
  methods?: unknown[];
}

interface AstEdge {
  from: string;
  to: string;
  type: string;
}

interface PatternInstance {
  className?: string;
  name?: string;
  file?: string;
}

interface PatternStat {
  count: number;
  files?: string[];
  instances?: PatternInstance[];
}

interface ProjectAstSummary {
  classes?: AstClass[];
  protocols?: AstProtocol[];
  categories?: AstCategory[];
  inheritanceGraph?: AstEdge[];
  patternStats?: Record<string, PatternStat>;
}

interface DepGraphNode {
  id?: string;
  label?: string;
  type?: string;
  layer?: string;
  version?: string;
  group?: string;
  fullPath?: string;
  indirect?: boolean;
  [key: string]: unknown;
}

interface DepGraphData {
  nodes?: (DepGraphNode | string)[];
}

interface CandidateWithRelations {
  title?: string;
  id?: string;
  relations?: Record<string, unknown>;
}

interface CallEdge {
  caller: string;
  callee: string;
  callType: string;
  resolveMethod: string;
  line: number;
  file: string;
  isAwait: boolean;
  argCount?: number;
}

interface DataFlowEdge {
  from?: string;
  to?: string;
  flowType?: string;
  direction?: string;
  [key: string]: unknown;
}

interface GraphPopulateResult {
  entitiesUpserted: number;
  edgesCreated: number;
  durationMs: number;
}

interface CodeEntityData {
  entityId: string;
  entityType: string;
  name: string;
  filePath?: string | null;
  line?: number | null;
  superclass?: string | null;
  protocols?: string[];
  metadata?: Record<string, unknown>;
}

interface MappedCodeEntity {
  entityId: string;
  entityType: string;
  name: string;
  filePath: string | null;
  line: number | null;
  superclass: string | null;
  protocols: string[];
  metadata: Record<string, unknown>;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
}

interface MappedEdge {
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown>;
}

interface SearchOptions {
  type?: string;
  limit?: number;
}

interface ContextAgentOptions {
  maxEntities?: number;
  maxEdges?: number;
}

export class CodeEntityGraph {
  projectRoot: string;
  #entityRepo: EntityRepoLike;
  #edgeRepo: EdgeRepoLike;
  log: ReturnType<typeof Logger.getInstance>;
  constructor(
    entityRepo: EntityRepoLike,
    edgeRepo: EdgeRepoLike,
    options: { projectRoot?: string; logger?: ReturnType<typeof Logger.getInstance> } = {}
  ) {
    this.#entityRepo = entityRepo;
    this.#edgeRepo = edgeRepo;
    this.projectRoot = options.projectRoot || '';
    this.log = options.logger || logger;
  }

  // ────────────────────────────────────────────
  // Public API — 图谱构建
  // ────────────────────────────────────────────

  /**
   * 从 AST ProjectAstSummary 填充图谱 (Phase 1.5 → Phase 1.6)
   *
   * 写入: class/protocol/category 实体 + inherits/conforms/extends 边
   *
   * @param astSummary analyzeProject() 产出的 ProjectAstSummary
   */
  async populateFromAst(astSummary: ProjectAstSummary | null): Promise<GraphPopulateResult> {
    if (!astSummary) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let entities = 0;
    let edges = 0;

    // ── 类 ──
    for (const cls of astSummary.classes || []) {
      await this.#upsertEntity({
        entityId: cls.name,
        entityType: cls.isCategory ? 'category' : 'class',
        name: cls.name,
        filePath: cls.file || null,
        line: cls.line || null,
        superclass: cls.superclass || null,
        protocols: cls.protocols || [],
        metadata: {
          endLine: cls.endLine,
          isCategory: cls.isCategory || false,
        },
      });
      entities++;
    }

    // ── 协议 ──
    for (const proto of astSummary.protocols || []) {
      await this.#upsertEntity({
        entityId: proto.name,
        entityType: 'protocol',
        name: proto.name,
        filePath: proto.file || null,
        line: proto.line || null,
        protocols: proto.inherits || [],
        metadata: {
          methodCount: proto.methods?.length || 0,
        },
      });
      entities++;
    }

    // ── Category ──
    for (const cat of astSummary.categories || []) {
      const catId = `${cat.className}(${cat.categoryName})`;
      await this.#upsertEntity({
        entityId: catId,
        entityType: 'category',
        name: catId,
        filePath: cat.file || null,
        line: cat.line || null,
        protocols: cat.protocols || [],
        metadata: {
          className: cat.className,
          categoryName: cat.categoryName,
          methodCount: cat.methods?.length || 0,
        },
      });
      entities++;
    }

    // ── 继承/遵循/扩展 边 (从 AST inheritanceGraph) ──
    for (const edge of astSummary.inheritanceGraph || []) {
      const fromType = this.#inferEntityType(edge.from, astSummary);
      const toType = this.#inferEntityType(edge.to, astSummary);
      await this.#addEdge(edge.from, fromType, edge.to, toType, edge.type, {
        weight: 1.0,
        source: 'ast-bootstrap',
      });
      edges++;
    }

    // ── 设计模式 (从 patternStats) ──
    for (const [patternType, stat] of Object.entries(astSummary.patternStats || {}) as [
      string,
      PatternStat,
    ][]) {
      const patternId = `pattern:${patternType}`;
      await this.#upsertEntity({
        entityId: patternId,
        entityType: 'pattern',
        name: patternType,
        metadata: {
          count: stat.count,
          files: stat.files?.slice(0, 10),
        },
      });
      entities++;

      // 实例 → uses_pattern 边
      for (const inst of (stat.instances || []).slice(0, 50)) {
        const className = inst.className || inst.name;
        if (className) {
          await this.#addEdge(className, 'class', patternId, 'pattern', 'uses_pattern', {
            weight: 0.8,
            source: 'ast-pattern-detection',
            file: inst.file,
          });
          edges++;
        }
      }
    }

    const result = { entitiesUpserted: entities, edgesCreated: edges, durationMs: Date.now() - t0 };
    this.log.info(
      `[CodeEntityGraph] AST populate: ${entities} entities, ${edges} edges (${result.durationMs}ms)`
    );
    return result;
  }

  /**
   * 从 SPM 依赖图填充模块实体 (Phase 2)
   *
   * 当前 bootstrap.js 已将 SPM 边写入 knowledge_edges，
   * 此方法补充 module 实体节点。
   *
   * @param depGraphData spm.getDependencyGraph() 产出
   */
  async populateFromSpm(depGraphData: DepGraphData | null): Promise<GraphPopulateResult> {
    if (!depGraphData) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let entities = 0;

    for (const node of depGraphData.nodes || []) {
      const nodeObj = typeof node === 'string' ? { id: node, label: node } : node;
      await this.#upsertEntity({
        entityId: nodeObj.id || nodeObj.label || String(node),
        entityType: 'module',
        name: nodeObj.label || nodeObj.id || String(node),
        metadata: {
          nodeType: nodeObj.type || 'module',
          ...(nodeObj.layer != null ? { layer: nodeObj.layer } : {}),
          ...(nodeObj.version != null ? { version: nodeObj.version } : {}),
          ...(nodeObj.group != null ? { group: nodeObj.group } : {}),
          ...(nodeObj.fullPath != null ? { fullPath: nodeObj.fullPath } : {}),
          ...(nodeObj.indirect != null ? { indirect: nodeObj.indirect } : {}),
        },
      });
      entities++;
    }

    // 存储 layers 元数据（如果存在）到特殊实体
    const layers = (depGraphData as Record<string, unknown>).layers as
      | Array<Record<string, unknown>>
      | undefined;
    if (layers?.length) {
      await this.#upsertEntity({
        entityId: '__config_layers__',
        entityType: 'config',
        name: 'Config Layers',
        metadata: { layers },
      });
      entities++;
    }

    const result = { entitiesUpserted: entities, edgesCreated: 0, durationMs: Date.now() - t0 };
    this.log.info(
      `[CodeEntityGraph] SPM populate: ${entities} module entities (${result.durationMs}ms)`
    );
    return result;
  }

  /**
   * 从候选的 Relations 字段提取边写入图谱 (Phase 5/6)
   *
   * @param candidates 扁平关系数组或 Relations 对象
   */
  async populateFromCandidateRelations(
    candidates: CandidateWithRelations[] | null
  ): Promise<GraphPopulateResult> {
    if (!candidates?.length) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let edges = 0;

    for (const candidate of candidates) {
      const title = candidate.title || candidate.id || '';
      if (!title) {
        continue;
      }

      // 处理 Relations 对象或扁平数组
      let flatRelations: { type: string; target: string; description?: string }[];
      const rels = candidate.relations as Record<string, unknown>;
      if (typeof (rels as Record<string, Function>)?.toFlatArray === 'function') {
        flatRelations = (
          rels as unknown as {
            toFlatArray: () => { type: string; target: string; description?: string }[];
          }
        ).toFlatArray();
      } else if (Array.isArray(candidate.relations)) {
        flatRelations = candidate.relations as {
          type: string;
          target: string;
          description?: string;
        }[];
      } else if (candidate.relations && typeof candidate.relations === 'object') {
        // 桶结构 → 扁平
        flatRelations = [];
        for (const [type, list] of Object.entries(candidate.relations)) {
          for (const r of Array.isArray(list) ? list : []) {
            flatRelations.push({ type, target: r.target, description: r.description });
          }
        }
      } else {
        continue;
      }

      for (const rel of flatRelations) {
        if (!rel.target) {
          continue;
        }
        // 映射关系类型到边类型
        const relation = this.#mapRelationType(rel.type);
        await this.#addEdge(title, 'recipe', rel.target, 'recipe', relation, {
          weight: 0.7,
          source: 'candidate-relations',
          description: rel.description || '',
        });
        edges++;
      }
    }

    const result = { entitiesUpserted: 0, edgesCreated: edges, durationMs: Date.now() - t0 };
    this.log.info(`[CodeEntityGraph] Candidate relations: ${edges} edges (${result.durationMs}ms)`);
    return result;
  }

  // ────────────────────────────────────────────
  // Public API — 图谱查询
  // ────────────────────────────────────────────

  /** 获取单个实体信息 */
  async getEntity(entityId: string, entityType?: string): Promise<MappedCodeEntity | null> {
    let entity;
    if (entityType) {
      entity = await this.#entityRepo.findByEntityId(entityId, entityType, this.projectRoot);
    } else {
      entity = await this.#entityRepo.findByEntityIdOnly(entityId, this.projectRoot);
    }
    return entity ? this.#mapRepoEntity(entity) : null;
  }

  /**
   * 按类型列出所有实体
   * @param entityType 'class'|'protocol'|'category'|'module'|'pattern'
   */
  async listEntities(entityType: string, limit = 200): Promise<MappedCodeEntity[]> {
    const entities = await this.#entityRepo.listByType(entityType, this.projectRoot, limit);
    return entities.map((e) => this.#mapRepoEntity(e));
  }

  /**
   * 搜索实体 (名称模糊匹配)
   * @param [options.type] 过滤类型
   */
  async searchEntities(query: string, options: SearchOptions = {}): Promise<MappedCodeEntity[]> {
    const entities = await this.#entityRepo.searchByName(query, this.projectRoot, {
      entityType: options.type,
      limit: options.limit || 20,
    });
    return entities.map((e) => this.#mapRepoEntity(e));
  }

  /**
   * 获取实体的所有关系边
   */
  async getEntityEdges(entityId: string, entityType: string, direction = 'both') {
    const outgoing =
      direction === 'both' || direction === 'out'
        ? await this.#edgeRepo.findOutgoing(entityId, entityType)
        : [];
    const incoming =
      direction === 'both' || direction === 'in'
        ? await this.#edgeRepo.findIncoming(entityId, entityType)
        : [];
    return {
      outgoing: outgoing.map((e) => this.#mapRepoEdge(e)),
      incoming: incoming.map((e) => this.#mapRepoEdge(e)),
    };
  }

  /**
   * 获取继承链 (向上遍历 inherits 边)
   * @returns 继承链 [class, parent, grandparent, ...]
   */
  async getInheritanceChain(className: string, maxDepth = 10): Promise<string[]> {
    const chain = [className];
    let current = className;
    for (let i = 0; i < maxDepth; i++) {
      const parentId = await this.#edgeRepo.findOutgoingToId(current, 'class', 'inherits');
      if (!parentId) {
        break;
      }
      chain.push(parentId);
      current = parentId;
    }
    return chain;
  }

  /**
   * 获取所有子类/实现者 (向下遍历)
   * @param entityType 'class'|'protocol'
   */
  async getDescendants(entityId: string, entityType: string, maxDepth = 3) {
    const results: { id: string; type: string; depth: number; relation: string }[] = [];
    const visited = new Set();
    const queue = [{ id: entityId, type: entityType, depth: 0 }];

    // 类的子类/Category + 协议的遵循者
    const relations =
      entityType === 'protocol' ? ['conforms', 'inherits'] : ['inherits', 'extends'];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const { id, type, depth } = current;
      if (depth >= maxDepth) {
        continue;
      }
      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      for (const rel of relations) {
        const children = await this.#edgeRepo.findIncomingByFromTypes(id, type, rel);

        for (const child of children) {
          const childKey = `${child.fromType}:${child.fromId}`;
          if (!visited.has(childKey)) {
            results.push({
              id: child.fromId,
              type: child.fromType,
              depth: depth + 1,
              relation: rel,
            });
            queue.push({
              id: child.fromId,
              type: child.fromType,
              depth: depth + 1,
            });
          }
        }
      }
    }

    return results;
  }

  /** 获取协议遵循关系 (className → 遵循的协议列表) */
  async getConformances(className: string): Promise<string[]> {
    return this.#edgeRepo.findConformances(className);
  }

  /**
   * 查找两个实体间的路径 (BFS)
   */
  async findPath(fromId: string, fromType: string, toId: string, toType: string, maxDepth = 5) {
    const visited = new Set();
    const queue = [
      {
        id: fromId,
        type: fromType,
        path: [] as {
          from: { id: string; type: string };
          to: { id: string; type: string };
          relation: string;
        }[],
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const { id, type, path } = current;
      if (path.length >= maxDepth) {
        continue;
      }

      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const neighbors = await this.#edgeRepo.findOutgoing(id, type);

      for (const n of neighbors) {
        const step = {
          from: { id, type },
          to: { id: n.toId, type: n.toType },
          relation: n.relation,
        };
        const newPath = [...path, step];

        if (n.toId === toId && n.toType === toType) {
          return { found: true, path: newPath, depth: newPath.length };
        }
        queue.push({ id: n.toId, type: n.toType, path: newPath });
      }
    }

    return {
      found: false,
      path: [] as {
        from: { id: string; type: string };
        to: { id: string; type: string };
        relation: string;
      }[],
      depth: -1,
    };
  }

  /**
   * 影响分析: 修改某实体后，哪些实体可能受影响
   */
  async getImpactRadius(entityId: string, entityType: string, maxDepth = 3) {
    const impacted: { id: string; type: string; relation: string; depth: number }[] = [];
    const visited = new Set();
    const queue = [{ id: entityId, type: entityType, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const { id, type, depth } = current;
      if (depth >= maxDepth) {
        continue;
      }

      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      // 找出所有"依赖/引用此实体"的上游
      const dependents = await this.#edgeRepo.findIncoming(id, type);

      for (const dep of dependents) {
        const depKey = `${dep.fromType}:${dep.fromId}`;
        if (!visited.has(depKey)) {
          impacted.push({
            id: dep.fromId,
            type: dep.fromType,
            relation: dep.relation,
            depth: depth + 1,
          });
          queue.push({
            id: dep.fromId,
            type: dep.fromType,
            depth: depth + 1,
          });
        }
      }
    }

    return impacted;
  }

  /** 项目拓扑概览 — 统计信息 + 关键度排名 */
  async getTopology() {
    const entityStats = await this.#entityRepo.countByType(this.projectRoot);
    const edgeStats = await this.#edgeRepo.countByRelation();
    const hotNodes = await this.#edgeRepo.getHotNodes(15);

    const totalEntities = Object.values(entityStats).reduce((sum, c) => sum + c, 0);
    const totalEdges = Object.values(edgeStats).reduce((sum, c) => sum + c, 0);

    return {
      entities: entityStats,
      edges: edgeStats,
      totalEntities,
      totalEdges,
      hotNodes: hotNodes.map((n) => ({
        id: n.id,
        type: n.type,
        inDegree: n.inDegree,
      })),
    };
  }

  /** 生成 Agent 可用的图谱上下文 (Markdown) */
  async generateContextForAgent(options: ContextAgentOptions = {}): Promise<string> {
    const maxEntities = options.maxEntities || 30;
    const topo = await this.getTopology();

    if (topo.totalEntities === 0) {
      return '';
    }

    const lines = [
      '## 代码实体图谱 (Code Entity Graph)',
      '',
      `### 统计`,
      ...Object.entries(topo.entities).map(([t, c]) => `- ${t}: ${c}`),
      `- 总边数: ${topo.totalEdges}`,
      '',
    ];

    // 核心实体 (入度最高)
    if (topo.hotNodes.length > 0) {
      lines.push('### 核心实体 (被依赖最多)');
      for (const n of topo.hotNodes.slice(0, 10)) {
        lines.push(`- \`${n.id}\` (${n.type}, 入度=${n.inDegree})`);
      }
      lines.push('');
    }

    // 类继承概览
    const classes = await this.listEntities('class', maxEntities);
    if (classes.length > 0) {
      lines.push('### 类继承关系');
      for (const cls of classes) {
        const chain = await this.getInheritanceChain(cls.entityId, 5);
        if (chain.length > 1) {
          lines.push(`- \`${chain.join(' → ')}\``);
        }
      }
      lines.push('');
    }

    // 协议
    const protocols = await this.listEntities('protocol', 15);
    if (protocols.length > 0) {
      lines.push('### 协议');
      for (const p of protocols) {
        const conformers = await this.getDescendants(p.entityId, 'protocol', 1);
        const cNames = conformers.map((c) => c.id).slice(0, 5);
        lines.push(
          `- \`${p.name}\` ← ${cNames.length > 0 ? cNames.map((n) => `\`${n}\``).join(', ') : '(无遵循者)'}`
        );
      }
      lines.push('');
    }

    // 调用图热路径 (Phase 5)
    try {
      const hotCallees = await this.#edgeRepo.getHotNodes(15);
      // Filter for 'calls' relation — use countIncomingByRelation for each
      const callHotPaths: { toId: string; callCount: number; callerNames: string }[] = [];
      for (const node of hotCallees) {
        const callCount = await this.#edgeRepo.countIncomingByRelation(node.id, 'calls');
        if (callCount > 0) {
          const topCallers = await this.#edgeRepo.findIncomingByRelation(node.id, 'calls');
          const callerNames = topCallers
            .slice(0, 3)
            .map((c) => `\`${c.fromId}\``)
            .join(', ');
          callHotPaths.push({
            toId: node.id,
            callCount,
            callerNames: `${callerNames}${topCallers.length > 3 ? '...' : ''}`,
          });
        }
      }

      if (callHotPaths.length > 0) {
        lines.push('### 调用图热路径 (Call Graph Hot Paths)');
        for (const row of callHotPaths.slice(0, 15)) {
          lines.push(`- \`${row.toId}\` ← ${row.callCount} 次调用 (${row.callerNames})`);
        }
        lines.push('');
      }

      // 数据流边摘要
      const dataFlowCount = await this.#edgeRepo.countByRelationType('data_flow');
      if (dataFlowCount > 0) {
        lines.push(`### 数据流`);
        lines.push(`- 数据流边: ${dataFlowCount} 条`);
        lines.push('');
      }
    } catch (_e: unknown) {
      // 调用图数据可能尚未填充, 静默跳过
    }

    return lines.join('\n');
  }

  // ────────────────────────────────────────────
  // Public API — Phase 5: 调用图
  // ────────────────────────────────────────────

  /**
   * 从解析后的调用边填充图谱 (Phase 5)
   *
   * @param callEdges
   * @param dataFlowEdges
   */
  async populateCallGraph(
    callEdges: CallEdge[],
    dataFlowEdges: DataFlowEdge[]
  ): Promise<GraphPopulateResult> {
    const t0 = Date.now();
    let edges = 0;
    let entities = 0;

    // ── 注册方法实体 (确保 from/to 的 entity 存在) ──
    const registeredMethods = new Set();
    for (const edge of callEdges) {
      for (const fqn of [edge.caller, edge.callee]) {
        if (registeredMethods.has(fqn)) {
          continue;
        }
        registeredMethods.add(fqn);

        const entityId = this._extractEntityId(fqn);
        const entityName = entityId; // 短名
        const filePath = fqn.includes('::') ? fqn.split('::')[0] : null;

        await this.#upsertEntity({
          entityId,
          entityType: 'method',
          name: entityName,
          filePath,
          metadata: { fqn, source: 'phase5-call-graph' },
        });
        entities++;
      }
    }

    // ── 调用边 (聚合同一 caller-callee 对的多次调用，解决 Issue #4) ──
    const aggregated = new Map(); // key = "callerId|calleeId" → aggregated metadata
    for (const edge of callEdges) {
      const callerId = this._extractEntityId(edge.caller);
      const calleeId = this._extractEntityId(edge.callee);
      const key = `${callerId}|${calleeId}`;

      if (aggregated.has(key)) {
        const agg = aggregated.get(key);
        agg.callCount++;
        agg.callSites.push({ line: edge.line, isAwait: edge.isAwait });
        // 提升权重: direct 优先
        if (edge.resolveMethod === 'direct') {
          agg.resolveMethod = 'direct';
        }
        if (edge.isAwait) {
          agg.hasAwait = true;
        }
      } else {
        aggregated.set(key, {
          callerId,
          calleeId,
          callType: edge.callType,
          resolveMethod: edge.resolveMethod,
          file: edge.file,
          hasAwait: edge.isAwait,
          callCount: 1,
          callSites: [{ line: edge.line, isAwait: edge.isAwait }],
        });
      }
    }

    for (const agg of aggregated.values()) {
      await this.#addEdge(agg.callerId, 'method', agg.calleeId, 'method', 'calls', {
        weight: agg.resolveMethod === 'direct' ? 1.0 : 0.6,
        source: 'phase5-call-graph',
        callType: agg.callType,
        resolveMethod: agg.resolveMethod,
        file: agg.file,
        isAwait: agg.hasAwait,
        callCount: agg.callCount,
        callSites: agg.callSites.slice(0, 10), // 最多保留 10 个调用点
      });
      edges++;
    }

    // ── 数据流边 ──
    for (const flow of dataFlowEdges) {
      const fromId = this._extractEntityId(flow.from || '');
      const toId = this._extractEntityId(flow.to || '');

      await this.#addEdge(fromId, 'method', toId, 'method', 'data_flow', {
        weight: 0.5,
        source: 'phase5-data-flow',
        flowType: flow.flowType || '',
        direction: flow.direction || '',
      });
      edges++;
    }

    const result = { entitiesUpserted: entities, edgesCreated: edges, durationMs: Date.now() - t0 };
    this.log.info(
      `[CodeEntityGraph] Call graph: ${callEdges.length} call edges, ${dataFlowEdges.length} data flow edges, ${entities} method entities (${result.durationMs}ms)`
    );
    return result;
  }

  /**
   * 获取调用者 — 谁调用了这个方法？
   *
   * @param methodId "ClassName.methodName" 或 FQN
   * @returns >}
   */
  async getCallers(methodId: string, maxDepth = 2) {
    const results: { caller: string; depth: number; callType: string }[] = [];
    const visited = new Set();
    const queue = [{ id: methodId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const { id, depth } = current;
      if (depth >= maxDepth || visited.has(id)) {
        continue;
      }
      visited.add(id);

      const callers = await this.#edgeRepo.findIncomingByRelation(id, 'calls');

      for (const edge of callers) {
        results.push({
          caller: edge.fromId,
          depth: depth + 1,
          callType: (edge.metadata?.callType as string) || 'unknown',
        });
        if (depth + 1 < maxDepth) {
          queue.push({ id: edge.fromId, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * 获取被调用者 — 这个方法调用了谁？
   *
   * @param methodId "ClassName.methodName" 或 FQN
   * @returns >}
   */
  async getCallees(methodId: string, maxDepth = 2) {
    const results: { callee: string; depth: number; callType: string }[] = [];
    const visited = new Set();
    const queue = [{ id: methodId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      const { id, depth } = current;
      if (depth >= maxDepth || visited.has(id)) {
        continue;
      }
      visited.add(id);

      const callees = await this.#edgeRepo.findOutgoingByRelation(id, 'calls');

      for (const edge of callees) {
        results.push({
          callee: edge.toId,
          depth: depth + 1,
          callType: (edge.metadata?.callType as string) || 'unknown',
        });
        if (depth + 1 < maxDepth) {
          queue.push({ id: edge.toId, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * 获取方法的 Impact Radius (基于调用图)
   * — 修改此方法可能影响哪些上游方法？
   *
   * @param methodId "ClassName.methodName"
   * @returns }
   */
  async getCallImpactRadius(methodId: string) {
    const callers = await this.getCallers(methodId, 3);
    const affectedFiles = new Set<string>();

    for (const c of callers) {
      const entity = await this.getEntity(c.caller, 'method');
      if (entity?.filePath) {
        affectedFiles.add(entity.filePath);
      }
    }

    return {
      directCallers: callers.filter((c) => c.depth === 1).length,
      transitiveCallers: callers.length,
      affectedFiles: [...affectedFiles],
    };
  }

  /**
   * 从 FQN 中提取短 Entity ID
   *
   * "src/service/UserService.ts::UserService.getUser" → "UserService.getUser"
   * "src/utils/helpers.ts::formatDate" → "formatDate"
   */
  _extractEntityId(fqn: string): string {
    if (fqn.includes('::')) {
      return fqn.split('::')[1];
    }
    return fqn;
  }

  /** 清除项目的所有代码实体 (重新 populate 前调用) */
  async clearProject() {
    await this.#entityRepo.clearProject(this.projectRoot);
    // 清除 AST 产出的边 + Phase 5 调用图边 (保留 recipe/module 边)
    await this.#edgeRepo.deleteByMetadataLike('%ast-bootstrap%');
    await this.#edgeRepo.deleteByMetadataLike('%ast-pattern-detection%');
    await this.#edgeRepo.deleteByMetadataLike('%phase5-%');
    this.log.info(`[CodeEntityGraph] Cleared entities for project: ${this.projectRoot}`);
  }

  /**
   * 增量清除 — 仅删除指定文件的 call graph 边和 method 实体
   *
   * @param filePaths 变更文件的相对路径列表
   * @returns }
   */
  async clearCallGraphForFiles(filePaths: string[] | null) {
    if (!filePaths?.length) {
      return { deletedEdges: 0, deletedEntities: 0 };
    }

    let deletedEdges = 0;
    let deletedEntities = 0;

    // 1. 删除相关 call edges (metadata_json 包含 file 字段)
    for (const filePath of filePaths) {
      // 匹配 metadata 中 "file":"xxx" 字段
      const changes = await this.#edgeRepo.deleteByMetadataLike(`%"file":"${filePath}"%`, [
        'calls',
        'data_flow',
      ]);
      deletedEdges += changes;
    }

    // 2. 删除相关 method 实体
    for (const filePath of filePaths) {
      const changes = await this.#entityRepo.deleteByFileAndType(
        filePath,
        'method',
        this.projectRoot
      );
      deletedEntities += changes;
    }

    this.log.info(
      `[CodeEntityGraph] Incremental clear: ${deletedEdges} edges, ${deletedEntities} entities ` +
        `for ${filePaths.length} files`
    );

    return { deletedEdges, deletedEntities };
  }

  // ────────────────────────────────────────────
  // Private — Helpers
  // ────────────────────────────────────────────

  async #upsertEntity(entity: CodeEntityData) {
    await this.#entityRepo.upsert({
      entityId: entity.entityId,
      entityType: entity.entityType,
      projectRoot: this.projectRoot,
      name: entity.name,
      filePath: entity.filePath ?? null,
      lineNumber: entity.line ?? null,
      superclass: entity.superclass ?? null,
      protocols: entity.protocols ?? [],
      metadata: entity.metadata ?? {},
    });
  }

  async #addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    metadata: Record<string, unknown> = {}
  ) {
    try {
      await this.#edgeRepo.upsertEdge({
        fromId,
        fromType,
        toId,
        toType,
        relation,
        weight: (metadata.weight as number) || 1.0,
        metadata,
      });
    } catch (err: unknown) {
      // Ignore duplicate edge errors
      if (err instanceof Error && !err.message.includes('UNIQUE constraint')) {
        this.log.warn(`[CodeEntityGraph] addEdge failed: ${err.message}`);
      }
    }
  }

  /** 从 AST 数据推断实体类型 */
  #inferEntityType(name: string, astSummary: ProjectAstSummary): string {
    if (!name) {
      return 'class'; // guard against undefined
    }
    if (astSummary.protocols?.some((p) => p.name === name)) {
      return 'protocol';
    }
    if (name.includes('(') && name.includes(')')) {
      return 'category';
    }
    return 'class';
  }

  /** 映射 Relations 桶名到图谱边类型 */
  #mapRelationType(type: string): string {
    const mapping = {
      inherits: 'inherits',
      implements: 'conforms',
      calls: 'calls',
      depends_on: 'depends_on',
      data_flow: 'data_flow',
      conflicts: 'conflicts',
      extends: 'extends',
      related: 'related',
      alternative: 'related',
      prerequisite: 'depends_on',
      deprecated_by: 'related',
      solves: 'related',
      enforces: 'enforces',
      references: 'references',
    };
    return (mapping as Record<string, string>)[type] || 'related';
  }

  #mapRepoEdge(edge: {
    fromId: string;
    fromType: string;
    toId: string;
    toType: string;
    relation: string;
    weight: number;
    metadata: Record<string, unknown>;
  }): MappedEdge {
    return {
      fromId: edge.fromId,
      fromType: edge.fromType,
      toId: edge.toId,
      toType: edge.toType,
      relation: edge.relation,
      weight: edge.weight,
      metadata: edge.metadata,
    };
  }

  #mapRepoEntity(entity: {
    entityId: string;
    entityType: string;
    name: string;
    filePath: string | null;
    lineNumber: number | null;
    superclass: string | null;
    protocols: string[];
    metadata: Record<string, unknown>;
    projectRoot: string;
    createdAt: number;
    updatedAt: number;
  }): MappedCodeEntity {
    return {
      entityId: entity.entityId,
      entityType: entity.entityType,
      name: entity.name,
      filePath: entity.filePath,
      line: entity.lineNumber,
      superclass: entity.superclass,
      protocols: entity.protocols,
      metadata: entity.metadata,
      projectRoot: entity.projectRoot,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export default CodeEntityGraph;
