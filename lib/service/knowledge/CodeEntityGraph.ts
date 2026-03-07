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

const logger = Logger.getInstance();

/* ══ Internal interfaces ══════════════════════════════════ */

interface CodeEntityRow {
  id: number;
  entity_id: string;
  entity_type: string;
  project_root: string;
  name: string;
  file_path: string | null;
  line_number: number | null;
  superclass: string | null;
  protocols: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface KnowledgeEdgeRow {
  id?: number;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  relation: string;
  weight: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface CeDbLike {
  getDb?: () => CeDbLike;
  transaction(fn: () => void): () => void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

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

interface PreparedStatements {
  upsert: ReturnType<CeDbLike['prepare']>;
  getEntity: ReturnType<CeDbLike['prepare']>;
  listByType: ReturnType<CeDbLike['prepare']>;
  clearEntities: ReturnType<CeDbLike['prepare']>;
  addEdge: ReturnType<CeDbLike['prepare']>;
  getCallers: ReturnType<CeDbLike['prepare']>;
  getCallees: ReturnType<CeDbLike['prepare']>;
  getEdge: ReturnType<CeDbLike['prepare']>;
}

interface SearchOptions {
  type?: string;
  limit?: number;
}

interface ContextAgentOptions {
  maxEntities?: number;
  maxEdges?: number;
}

/**
 * @typedef {Object} CodeEntity
 * @property {string} entityId   唯一标识 (通常 = name)
 * @property {string} entityType - 'class'|'protocol'|'category'|'module'|'pattern'
 * @property {string} name       显示名
 * @property {string} [filePath] 源文件路径
 * @property {number} [line]     起始行号
 * @property {string} [superclass] 父类
 * @property {string[]} [protocols] 遵循的协议列表
 * @property {object} [metadata] 额外信息
 */

/**
 * @typedef {Object} EntityEdge
 * @property {string} fromId
 * @property {string} fromType
 * @property {string} toId
 * @property {string} toType
 * @property {string} relation
 * @property {number} [weight]
 * @property {object} [metadata]
 */

/**
 * @typedef {Object} GraphPopulateResult
 * @property {number} entitiesUpserted  插入/更新的实体数
 * @property {number} edgesCreated      创建的边数
 * @property {number} durationMs        耗时
 */

export class CodeEntityGraph {
  projectRoot: string;
  db: CeDbLike;
  log: ReturnType<typeof Logger.getInstance>;
  stmts!: PreparedStatements;
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} [options]
   * @param {string} [options.projectRoot]
   * @param {import('winston').Logger} [options.logger]
   */
  constructor(
    db: CeDbLike,
    options: { projectRoot?: string; logger?: ReturnType<typeof Logger.getInstance> } = {}
  ) {
    this.db = typeof db?.getDb === 'function' ? (db.getDb()! as unknown as CeDbLike) : db;
    this.projectRoot = options.projectRoot || '';
    this.log = options.logger || logger;
    this.#ensureTable();
    this.#prepareStatements();
  }

  // ────────────────────────────────────────────
  // Public API — 图谱构建
  // ────────────────────────────────────────────

  /**
   * 从 AST ProjectAstSummary 填充图谱 (Phase 1.5 → Phase 1.6)
   *
   * 写入: class/protocol/category 实体 + inherits/conforms/extends 边
   *
   * @param {object} astSummary - analyzeProject() 产出的 ProjectAstSummary
   * @returns {GraphPopulateResult}
   */
  populateFromAst(astSummary: ProjectAstSummary | null): GraphPopulateResult {
    if (!astSummary) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let entities = 0;
    let edges = 0;

    const run = this.db.transaction(() => {
      // ── 类 ──
      for (const cls of astSummary.classes || []) {
        this.#upsertEntity({
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
        this.#upsertEntity({
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
        this.#upsertEntity({
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
        this.#addEdge(edge.from, fromType, edge.to, toType, edge.type, {
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
        this.#upsertEntity({
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
            this.#addEdge(className, 'class', patternId, 'pattern', 'uses_pattern', {
              weight: 0.8,
              source: 'ast-pattern-detection',
              file: inst.file,
            });
            edges++;
          }
        }
      }
    });

    run();

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
   * @param {object} depGraphData - spm.getDependencyGraph() 产出
   * @returns {GraphPopulateResult}
   */
  populateFromSpm(depGraphData: DepGraphData | null): GraphPopulateResult {
    if (!depGraphData) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let entities = 0;

    const run = this.db.transaction(() => {
      for (const node of depGraphData.nodes || []) {
        const nodeObj = typeof node === 'string' ? { id: node, label: node } : node;
        this.#upsertEntity({
          entityId: nodeObj.id || nodeObj.label || String(node),
          entityType: 'module',
          name: nodeObj.label || nodeObj.id || String(node),
          metadata: {
            nodeType: nodeObj.type || 'module',
          },
        });
        entities++;
      }
    });

    run();

    const result = { entitiesUpserted: entities, edgesCreated: 0, durationMs: Date.now() - t0 };
    this.log.info(
      `[CodeEntityGraph] SPM populate: ${entities} module entities (${result.durationMs}ms)`
    );
    return result;
  }

  /**
   * 从候选的 Relations 字段提取边写入图谱 (Phase 5/6)
   *
   * @param {Array<{title: string, relations: object}>} candidates 扁平关系数组或 Relations 对象
   * @returns {GraphPopulateResult}
   */
  populateFromCandidateRelations(candidates: CandidateWithRelations[] | null): GraphPopulateResult {
    if (!candidates?.length) {
      return { entitiesUpserted: 0, edgesCreated: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    let edges = 0;

    const run = this.db.transaction(() => {
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
          this.#addEdge(title, 'recipe', rel.target, 'recipe', relation, {
            weight: 0.7,
            source: 'candidate-relations',
            description: rel.description || '',
          });
          edges++;
        }
      }
    });

    run();

    const result = { entitiesUpserted: 0, edgesCreated: edges, durationMs: Date.now() - t0 };
    this.log.info(`[CodeEntityGraph] Candidate relations: ${edges} edges (${result.durationMs}ms)`);
    return result;
  }

  // ────────────────────────────────────────────
  // Public API — 图谱查询
  // ────────────────────────────────────────────

  /**
   * 获取单个实体信息
   * @param {string} entityId
   * @param {string} [entityType]
   * @returns {CodeEntity|null}
   */
  getEntity(entityId: string, entityType?: string): MappedCodeEntity | null {
    let row;
    if (entityType) {
      row = this.stmts.getEntity.get(entityId, entityType, this.projectRoot);
    } else {
      row = this.db
        .prepare(`SELECT * FROM code_entities WHERE entity_id = ? AND project_root = ? LIMIT 1`)
        .get(entityId, this.projectRoot);
    }
    return row ? this.#mapEntity(row as unknown as CodeEntityRow) : null;
  }

  /**
   * 按类型列出所有实体
   * @param {string} entityType - 'class'|'protocol'|'category'|'module'|'pattern'
   * @param {number} [limit=200]
   * @returns {CodeEntity[]}
   */
  listEntities(entityType: string, limit = 200): MappedCodeEntity[] {
    const rows = this.stmts.listByType.all(entityType, this.projectRoot, limit);
    return rows.map((r) => this.#mapEntity(r as unknown as CodeEntityRow));
  }

  /**
   * 搜索实体 (名称模糊匹配)
   * @param {string} query
   * @param {object} [options]
   * @param {string} [options.type] 过滤类型
   * @param {number} [options.limit=20]
   * @returns {CodeEntity[]}
   */
  searchEntities(query: string, options: SearchOptions = {}): MappedCodeEntity[] {
    const pattern = `%${query}%`;
    let sql = `SELECT * FROM code_entities WHERE project_root = ? AND name LIKE ?`;
    const params: (string | number)[] = [this.projectRoot, pattern];
    if (options.type) {
      sql += ` AND entity_type = ?`;
      params.push(options.type);
    }
    sql += ` ORDER BY name LIMIT ?`;
    params.push(options.limit || 20);
    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => this.#mapEntity(r as unknown as CodeEntityRow));
  }

  /**
   * 获取实体的所有关系边
   * @param {string} entityId
   * @param {string} entityType
   * @param {'both'|'out'|'in'} [direction='both']
   * @returns {{ outgoing: EntityEdge[], incoming: EntityEdge[] }}
   */
  getEntityEdges(entityId: string, entityType: string, direction = 'both') {
    const outgoing =
      direction === 'both' || direction === 'out'
        ? this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE from_id = ? AND from_type = ?`)
            .all(entityId, entityType)
            .map(this.#mapEdge)
        : [];
    const incoming =
      direction === 'both' || direction === 'in'
        ? this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE to_id = ? AND to_type = ?`)
            .all(entityId, entityType)
            .map(this.#mapEdge)
        : [];
    return { outgoing, incoming };
  }

  /**
   * 获取继承链 (向上遍历 inherits 边)
   * @param {string} className
   * @param {number} [maxDepth=10]
   * @returns {string[]} 继承链 [class, parent, grandparent, ...]
   */
  getInheritanceChain(className: string, maxDepth = 10): string[] {
    const chain = [className];
    let current = className;
    for (let i = 0; i < maxDepth; i++) {
      const parent = this.db
        .prepare(
          `SELECT to_id FROM knowledge_edges 
         WHERE from_id = ? AND from_type = 'class' AND relation = 'inherits' LIMIT 1`
        )
        .get(current);
      if (!parent) {
        break;
      }
      chain.push(parent.to_id as string);
      current = parent.to_id as string;
    }
    return chain;
  }

  /**
   * 获取所有子类/实现者 (向下遍历)
   * @param {string} entityId
   * @param {string} entityType - 'class'|'protocol'
   * @param {number} [maxDepth=3]
   * @returns {Array<{ id: string, type: string, depth: number, relation: string }>}
   */
  getDescendants(entityId: string, entityType: string, maxDepth = 3) {
    const results: { id: string; type: string; depth: number; relation: string }[] = [];
    const visited = new Set();
    const queue = [{ id: entityId, type: entityType, depth: 0 }];

    // 类的子类/Category + 协议的遵循者
    const relations =
      entityType === 'protocol' ? ['conforms', 'inherits'] : ['inherits', 'extends'];

    while (queue.length > 0) {
      const { id, type, depth } = queue.shift()!;
      if (depth >= maxDepth) {
        continue;
      }
      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      for (const rel of relations) {
        const children = this.db
          .prepare(
            `SELECT from_id, from_type FROM knowledge_edges 
           WHERE to_id = ? AND to_type = ? AND relation = ?`
          )
          .all(id, type, rel);

        for (const child of children) {
          const childKey = `${child.from_type}:${child.from_id}`;
          if (!visited.has(childKey)) {
            results.push({
              id: child.from_id as string,
              type: child.from_type as string,
              depth: depth + 1,
              relation: rel,
            });
            queue.push({
              id: child.from_id as string,
              type: child.from_type as string,
              depth: depth + 1,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * 获取协议遵循关系 (className → 遵循的协议列表)
   * @param {string} className
   * @returns {string[]}
   */
  getConformances(className: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT to_id FROM knowledge_edges 
       WHERE from_id = ? AND from_type IN ('class', 'category') AND relation = 'conforms'`
      )
      .all(className);
    return rows.map((r) => (r as unknown as KnowledgeEdgeRow).to_id);
  }

  /**
   * 查找两个实体间的路径 (BFS)
   * @param {string} fromId
   * @param {string} fromType
   * @param {string} toId
   * @param {string} toType
   * @param {number} [maxDepth=5]
   * @returns {{ found: boolean, path: EntityEdge[], depth: number }}
   */
  findPath(fromId: string, fromType: string, toId: string, toType: string, maxDepth = 5) {
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
      const { id, type, path } = queue.shift()!;
      if (path.length >= maxDepth) {
        continue;
      }

      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const neighbors = this.db
        .prepare(
          `SELECT to_id, to_type, relation, weight FROM knowledge_edges WHERE from_id = ? AND from_type = ?`
        )
        .all(id, type);

      for (const n of neighbors) {
        const step = {
          from: { id, type },
          to: { id: n.to_id as string, type: n.to_type as string },
          relation: n.relation as string,
        };
        const newPath = [...path, step];

        if (n.to_id === toId && n.to_type === toType) {
          return { found: true, path: newPath, depth: newPath.length };
        }
        queue.push({ id: n.to_id as string, type: n.to_type as string, path: newPath });
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
   * @param {string} entityId
   * @param {string} entityType
   * @param {number} [maxDepth=3]
   * @returns {Array<{ id: string, type: string, relation: string, depth: number }>}
   */
  getImpactRadius(entityId: string, entityType: string, maxDepth = 3) {
    const impacted: { id: string; type: string; relation: string; depth: number }[] = [];
    const visited = new Set();
    const queue = [{ id: entityId, type: entityType, depth: 0 }];

    while (queue.length > 0) {
      const { id, type, depth } = queue.shift()!;
      if (depth >= maxDepth) {
        continue;
      }

      const key = `${type}:${id}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      // 找出所有"依赖/引用此实体"的上游
      const dependents = this.db
        .prepare(
          `SELECT from_id, from_type, relation FROM knowledge_edges 
         WHERE to_id = ? AND to_type = ?`
        )
        .all(id, type);

      for (const dep of dependents) {
        const depKey = `${dep.from_type}:${dep.from_id}`;
        if (!visited.has(depKey)) {
          impacted.push({
            id: dep.from_id as string,
            type: dep.from_type as string,
            relation: dep.relation as string,
            depth: depth + 1,
          });
          queue.push({
            id: dep.from_id as string,
            type: dep.from_type as string,
            depth: depth + 1,
          });
        }
      }
    }

    return impacted;
  }

  /**
   * 项目拓扑概览 — 统计信息 + 关键度排名
   * @returns {object}
   */
  getTopology() {
    const entityStats = this.db
      .prepare(
        `SELECT entity_type, COUNT(*) as count FROM code_entities 
       WHERE project_root = ? GROUP BY entity_type`
      )
      .all(this.projectRoot);

    const edgeStats = this.db
      .prepare(`SELECT relation, COUNT(*) as count FROM knowledge_edges GROUP BY relation`)
      .all();

    // 入度最高的实体 = 被依赖最多
    const hotNodes = this.db
      .prepare(
        `SELECT to_id, to_type, COUNT(*) as in_degree 
       FROM knowledge_edges 
       GROUP BY to_id, to_type 
       ORDER BY in_degree DESC LIMIT 15`
      )
      .all();

    return {
      entities: Object.fromEntries(
        entityStats.map((s) => [
          (s as unknown as Record<string, unknown>).entity_type,
          (s as unknown as Record<string, unknown>).count,
        ])
      ),
      edges: Object.fromEntries(
        edgeStats.map((s) => [
          (s as unknown as Record<string, unknown>).relation,
          (s as unknown as Record<string, unknown>).count,
        ])
      ),
      totalEntities: entityStats.reduce(
        (sum: number, s) => sum + ((s as unknown as Record<string, number>).count || 0),
        0
      ),
      totalEdges: edgeStats.reduce(
        (sum: number, s) => sum + ((s as unknown as Record<string, number>).count || 0),
        0
      ),
      hotNodes: hotNodes.map((n) => ({
        id: (n as unknown as Record<string, unknown>).to_id,
        type: (n as unknown as Record<string, unknown>).to_type,
        inDegree: (n as unknown as Record<string, unknown>).in_degree,
      })),
    };
  }

  /**
   * 生成 Agent 可用的图谱上下文 (Markdown)
   * @param {object} [options]
   * @param {number} [options.maxEntities=30]
   * @param {number} [options.maxEdges=50]
   * @returns {string}
   */
  generateContextForAgent(options: ContextAgentOptions = {}): string {
    const maxEntities = options.maxEntities || 30;
    const _maxEdges = options.maxEdges || 50;
    const topo = this.getTopology();

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
    const classes = this.listEntities('class', maxEntities);
    if (classes.length > 0) {
      lines.push('### 类继承关系');
      for (const cls of classes) {
        const chain = this.getInheritanceChain(cls.entityId, 5);
        if (chain.length > 1) {
          lines.push(`- \`${chain.join(' → ')}\``);
        }
      }
      lines.push('');
    }

    // 协议
    const protocols = this.listEntities('protocol', 15);
    if (protocols.length > 0) {
      lines.push('### 协议');
      for (const p of protocols) {
        const conformers = this.getDescendants(p.entityId, 'protocol', 1);
        const cNames = conformers.map((c) => c.id).slice(0, 5);
        lines.push(
          `- \`${p.name}\` ← ${cNames.length > 0 ? cNames.map((n) => `\`${n}\``).join(', ') : '(无遵循者)'}`
        );
      }
      lines.push('');
    }

    // 调用图热路径 (Phase 5)
    try {
      const hotCallees = this.db
        .prepare(
          `SELECT to_id, COUNT(*) as call_count
           FROM knowledge_edges
           WHERE relation = 'calls'
           GROUP BY to_id
           ORDER BY call_count DESC
           LIMIT 15`
        )
        .all();

      if (hotCallees.length > 0) {
        lines.push('### 调用图热路径 (Call Graph Hot Paths)');
        for (const row of hotCallees) {
          // 查找前几个调用者
          const topCallers = this.db
            .prepare(
              `SELECT from_id FROM knowledge_edges
               WHERE relation = 'calls' AND to_id = ?
               LIMIT 3`
            )
            .all(row.to_id);
          const callerNames = topCallers
            .map((c) => `\`${(c as unknown as Record<string, string>).from_id}\``)
            .join(', ');
          lines.push(
            `- \`${row.to_id}\` ← ${row.call_count} 次调用 (${callerNames}${topCallers.length < (row.call_count as number) ? '...' : ''})`
          );
        }
        lines.push('');
      }

      // 数据流边摘要
      const dataFlowCount = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM knowledge_edges WHERE relation = 'data_flow'`)
        .get();

      if (dataFlowCount && (dataFlowCount as Record<string, number>).cnt > 0) {
        lines.push(`### 数据流`);
        lines.push(`- 数据流边: ${(dataFlowCount as Record<string, number>).cnt} 条`);
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
   * @param {Array<{ caller: string, callee: string, callType: string, resolveMethod: string, line: number, file: string, isAwait: boolean }>} callEdges
   * @param {Array<{ from: string, to: string, flowType: string, direction: string }>} dataFlowEdges
   * @returns {GraphPopulateResult}
   */
  populateCallGraph(callEdges: CallEdge[], dataFlowEdges: DataFlowEdge[]): GraphPopulateResult {
    const t0 = Date.now();
    let edges = 0;
    let entities = 0;

    const run = this.db.transaction(() => {
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

          this.#upsertEntity({
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
        this.#addEdge(agg.callerId, 'method', agg.calleeId, 'method', 'calls', {
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

        this.#addEdge(fromId, 'method', toId, 'method', 'data_flow', {
          weight: 0.5,
          source: 'phase5-data-flow',
          flowType: flow.flowType || '',
          direction: flow.direction || '',
        });
        edges++;
      }
    });

    run();

    const result = { entitiesUpserted: entities, edgesCreated: edges, durationMs: Date.now() - t0 };
    this.log.info(
      `[CodeEntityGraph] Call graph: ${callEdges.length} call edges, ${dataFlowEdges.length} data flow edges, ${entities} method entities (${result.durationMs}ms)`
    );
    return result;
  }

  /**
   * 获取调用者 — 谁调用了这个方法？
   *
   * @param {string} methodId - "ClassName.methodName" 或 FQN
   * @param {number} [maxDepth=2]
   * @returns {Array<{ caller: string, depth: number, callType: string }>}
   */
  getCallers(methodId: string, maxDepth = 2) {
    const results: { caller: string; depth: number; callType: string }[] = [];
    const visited = new Set();
    const queue = [{ id: methodId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth || visited.has(id)) {
        continue;
      }
      visited.add(id);

      const callers = this.stmts.getCallers.all(id);

      for (const row of callers) {
        const meta = JSON.parse((row.metadata_json as string) || '{}');
        results.push({
          caller: row.from_id as string,
          depth: depth + 1,
          callType: meta.callType || 'unknown',
        });
        if (depth + 1 < maxDepth) {
          queue.push({ id: row.from_id as string, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * 获取被调用者 — 这个方法调用了谁？
   *
   * @param {string} methodId - "ClassName.methodName" 或 FQN
   * @param {number} [maxDepth=2]
   * @returns {Array<{ callee: string, depth: number, callType: string }>}
   */
  getCallees(methodId: string, maxDepth = 2) {
    const results: { callee: string; depth: number; callType: string }[] = [];
    const visited = new Set();
    const queue = [{ id: methodId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth || visited.has(id)) {
        continue;
      }
      visited.add(id);

      const callees = this.stmts.getCallees.all(id);

      for (const row of callees) {
        const meta = JSON.parse((row.metadata_json as string) || '{}');
        results.push({
          callee: row.to_id as string,
          depth: depth + 1,
          callType: meta.callType || 'unknown',
        });
        if (depth + 1 < maxDepth) {
          queue.push({ id: row.to_id as string, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  /**
   * 获取方法的 Impact Radius (基于调用图)
   * — 修改此方法可能影响哪些上游方法？
   *
   * @param {string} methodId - "ClassName.methodName"
   * @returns {{ directCallers: number, transitiveCallers: number, affectedFiles: string[] }}
   */
  getCallImpactRadius(methodId: string) {
    const callers = this.getCallers(methodId, 3);
    const affectedFiles = new Set<string>();

    for (const c of callers) {
      const entity = this.getEntity(c.caller, 'method');
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
   *
   * @param {string} fqn
   * @returns {string}
   */
  _extractEntityId(fqn: string): string {
    if (fqn.includes('::')) {
      return fqn.split('::')[1];
    }
    return fqn;
  }

  /**
   * 清除项目的所有代码实体 (重新 populate 前调用)
   */
  clearProject() {
    const run = this.db.transaction(() => {
      this.stmts.clearEntities.run(this.projectRoot);
      // 清除 AST 产出的边 + Phase 5 调用图边 (保留 recipe/module 边)
      this.db
        .prepare(
          `DELETE FROM knowledge_edges WHERE metadata_json LIKE '%ast-bootstrap%' OR metadata_json LIKE '%ast-pattern-detection%' OR metadata_json LIKE '%phase5-%'`
        )
        .run();
    });
    run();
    this.log.info(`[CodeEntityGraph] Cleared entities for project: ${this.projectRoot}`);
  }

  /**
   * 增量清除 — 仅删除指定文件的 call graph 边和 method 实体
   *
   * @param {string[]} filePaths 变更文件的相对路径列表
   * @returns {{ deletedEdges: number, deletedEntities: number }}
   */
  clearCallGraphForFiles(filePaths: string[] | null) {
    if (!filePaths?.length) {
      return { deletedEdges: 0, deletedEntities: 0 };
    }

    let deletedEdges = 0;
    let deletedEntities = 0;

    const run = this.db.transaction(() => {
      // 1. 删除相关 call edges (metadata_json 包含 file 字段)
      const deleteEdgesStmt = this.db.prepare(
        `DELETE FROM knowledge_edges 
         WHERE metadata_json LIKE ? 
         AND (relation = 'calls' OR relation = 'data_flow')
         AND metadata_json LIKE '%phase5-%'`
      );

      for (const filePath of filePaths) {
        // 匹配 metadata 中 "file":"xxx" 字段
        const result = deleteEdgesStmt.run(`%"file":"${filePath}"%`);
        deletedEdges += result.changes;
      }

      // 2. 删除相关 method 实体
      const deleteEntitiesStmt = this.db.prepare(
        `DELETE FROM code_entities 
         WHERE file_path = ? AND entity_type = 'method' AND project_root = ?`
      );

      for (const filePath of filePaths) {
        const result = deleteEntitiesStmt.run(filePath, this.projectRoot);
        deletedEntities += result.changes;
      }
    });

    run();

    this.log.info(
      `[CodeEntityGraph] Incremental clear: ${deletedEdges} edges, ${deletedEntities} entities ` +
        `for ${filePaths.length} files`
    );

    return { deletedEdges, deletedEntities };
  }

  // ────────────────────────────────────────────
  // Private — Schema & Statements
  // ────────────────────────────────────────────

  #ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_entities (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id     TEXT NOT NULL,
        entity_type   TEXT NOT NULL,
        project_root  TEXT NOT NULL,
        name          TEXT NOT NULL,
        file_path     TEXT,
        line_number   INTEGER,
        superclass    TEXT,
        protocols     TEXT DEFAULT '[]',
        metadata_json TEXT DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        UNIQUE (entity_id, entity_type, project_root)
      );
      CREATE INDEX IF NOT EXISTS idx_ce_project    ON code_entities(project_root);
      CREATE INDEX IF NOT EXISTS idx_ce_type       ON code_entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_ce_name       ON code_entities(name);
      CREATE INDEX IF NOT EXISTS idx_ce_file       ON code_entities(file_path);
      CREATE INDEX IF NOT EXISTS idx_ce_superclass ON code_entities(superclass);
    `);
  }

  #prepareStatements() {
    this.stmts = {
      upsert: this.db.prepare(`
        INSERT INTO code_entities (entity_id, entity_type, project_root, name, file_path, line_number, superclass, protocols, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (entity_id, entity_type, project_root) DO UPDATE SET
          name = excluded.name,
          file_path = COALESCE(excluded.file_path, code_entities.file_path),
          line_number = COALESCE(excluded.line_number, code_entities.line_number),
          superclass = COALESCE(excluded.superclass, code_entities.superclass),
          protocols = excluded.protocols,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `),
      getEntity: this.db.prepare(
        `SELECT * FROM code_entities WHERE entity_id = ? AND entity_type = ? AND project_root = ?`
      ),
      listByType: this.db.prepare(
        `SELECT * FROM code_entities WHERE entity_type = ? AND project_root = ? ORDER BY name LIMIT ?`
      ),
      clearEntities: this.db.prepare(`DELETE FROM code_entities WHERE project_root = ?`),
      addEdge: this.db.prepare(`
        INSERT OR REPLACE INTO knowledge_edges (from_id, from_type, to_id, to_type, relation, weight, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      // Phase 5: 调用图查询 (pre-prepared 避免每次调用都创建)
      getCallers: this.db.prepare(
        `SELECT from_id, from_type, metadata_json FROM knowledge_edges
         WHERE to_id = ? AND relation = 'calls'`
      ),
      getCallees: this.db.prepare(
        `SELECT to_id, to_type, metadata_json FROM knowledge_edges
         WHERE from_id = ? AND relation = 'calls'`
      ),
      getEdge: this.db.prepare(
        `SELECT metadata_json FROM knowledge_edges
         WHERE from_id = ? AND from_type = ? AND to_id = ? AND to_type = ? AND relation = ?`
      ),
    };
  }

  // ────────────────────────────────────────────
  // Private — Helpers
  // ────────────────────────────────────────────

  #upsertEntity(entity: CodeEntityData) {
    const now = Math.floor(Date.now() / 1000);
    this.stmts.upsert.run(
      entity.entityId,
      entity.entityType,
      this.projectRoot,
      entity.name,
      entity.filePath || null,
      entity.line || null,
      entity.superclass || null,
      JSON.stringify(entity.protocols || []),
      JSON.stringify(entity.metadata || {}),
      now,
      now
    );
  }

  #addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    metadata: Record<string, unknown> = {}
  ) {
    const now = Math.floor(Date.now() / 1000);
    try {
      this.stmts.addEdge.run(
        fromId,
        fromType,
        toId,
        toType,
        relation,
        metadata.weight || 1.0,
        JSON.stringify(metadata),
        now,
        now
      );
    } catch (err: unknown) {
      // Ignore duplicate edge errors
      if (err instanceof Error && !err.message.includes('UNIQUE constraint')) {
        this.log.warn(`[CodeEntityGraph] addEdge failed: ${err.message}`);
      }
    }
  }

  /**
   * 从 AST 数据推断实体类型
   */
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

  /**
   * 映射 Relations 桶名到图谱边类型
   */
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

  #mapEdge(row: Record<string, unknown>): MappedEdge {
    return {
      fromId: row.from_id as string,
      fromType: row.from_type as string,
      toId: row.to_id as string,
      toType: row.to_type as string,
      relation: row.relation as string,
      weight: row.weight as number,
      metadata: JSON.parse((row.metadata_json as string) || '{}'),
    };
  }

  #mapEntity(row: CodeEntityRow): MappedCodeEntity {
    return {
      entityId: row.entity_id,
      entityType: row.entity_type,
      name: row.name,
      filePath: row.file_path,
      line: row.line_number,
      superclass: row.superclass,
      protocols: JSON.parse(row.protocols || '[]'),
      metadata: JSON.parse(row.metadata_json || '{}'),
      projectRoot: row.project_root,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export default CodeEntityGraph;
