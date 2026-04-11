/**
 * KnowledgeEdgeRepository — 知识图谱边的仓储实现
 *
 * 从 KnowledgeGraphService 提取的数据操作，使用 Drizzle 类型安全 API。
 * KnowledgeGraphService 将从直接 db.prepare() 迁移为调用此 Repository。
 */

import { and, count, desc, eq, exists, inArray, like, ne, or, sql } from 'drizzle-orm';
import { codeEntities, knowledgeEdges } from '../../infrastructure/database/drizzle/schema.js';
import { LanguageProfiles } from '../../shared/LanguageProfiles.js';
import { unixNow } from '../../shared/utils/common.js';
import { type DrizzleTx, type PaginatedResult, RepositoryBase } from '../base/RepositoryBase.js';

/* ═══ 类型定义 ═══ */

export interface KnowledgeEdge {
  id: number;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface EdgeInsert {
  fromId: string;
  fromType?: string;
  toId: string;
  toType?: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface EdgeStats {
  totalEdges: number;
  byRelation: Record<string, number>;
  nodeTypes: string[];
}

/* ═══ Repository 实现 ═══ */

export class KnowledgeEdgeRepositoryImpl extends RepositoryBase<
  typeof knowledgeEdges,
  KnowledgeEdge
> {
  constructor(
    drizzle: ConstructorParameters<typeof RepositoryBase<typeof knowledgeEdges, KnowledgeEdge>>[0]
  ) {
    super(drizzle, knowledgeEdges);
  }

  /* ─── CRUD ─── */

  async findById(id: number): Promise<KnowledgeEdge | null> {
    const rows = this.drizzle.select().from(this.table).where(eq(this.table.id, id)).limit(1).all();
    return rows.length > 0 ? this.#mapRow(rows[0]) : null;
  }

  async create(data: EdgeInsert): Promise<KnowledgeEdge> {
    return this.upsertEdge(data);
  }

  async delete(id: number): Promise<boolean> {
    const result = this.drizzle.delete(this.table).where(eq(this.table.id, id)).run();
    return result.changes > 0;
  }

  /* ─── 核心操作 ─── */

  /** INSERT OR REPLACE — 按 (fromId, fromType, toId, toType, relation) 唯一约束 upsert */
  async upsertEdge(edge: EdgeInsert): Promise<KnowledgeEdge> {
    const now = unixNow();
    const metaJson = JSON.stringify(edge.metadata ?? {});

    this.drizzle
      .insert(this.table)
      .values({
        fromId: edge.fromId,
        fromType: edge.fromType ?? 'recipe',
        toId: edge.toId,
        toType: edge.toType ?? 'recipe',
        relation: edge.relation,
        weight: edge.weight ?? 1.0,
        metadataJson: metaJson,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          this.table.fromId,
          this.table.fromType,
          this.table.toId,
          this.table.toType,
          this.table.relation,
        ],
        set: {
          weight: sql`${edge.weight ?? 1.0}`,
          metadataJson: metaJson,
          updatedAt: now,
        },
      })
      .run();

    // 返回 upserted 行
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table.fromId, edge.fromId),
          eq(this.table.fromType, edge.fromType ?? 'recipe'),
          eq(this.table.toId, edge.toId),
          eq(this.table.toType, edge.toType ?? 'recipe'),
          eq(this.table.relation, edge.relation)
        )
      )
      .limit(1)
      .all();

    return this.#mapRow(rows[0]);
  }

  /** 删除指定的边 */
  async removeEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string
  ): Promise<void> {
    this.drizzle
      .delete(this.table)
      .where(
        and(
          eq(this.table.fromId, fromId),
          eq(this.table.fromType, fromType),
          eq(this.table.toId, toId),
          eq(this.table.toType, toType),
          eq(this.table.relation, relation)
        )
      )
      .run();
  }

  /* ─── 查询 ─── */

  /** 查询指定节点的出边 */
  async findOutgoing(nodeId: string, nodeType: string): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(eq(this.table.fromId, nodeId), eq(this.table.fromType, nodeType)))
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询指定节点的入边 */
  async findIncoming(nodeId: string, nodeType: string): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(eq(this.table.toId, nodeId), eq(this.table.toType, nodeType)))
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询指定节点的入边（仅限指定关系类型） */
  async findIncomingByRelations(
    nodeId: string,
    nodeType: string,
    relations: string[]
  ): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table.toId, nodeId),
          eq(this.table.toType, nodeType),
          inArray(this.table.relation, relations)
        )
      )
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询指定节点按特定关系的入边 */
  async findIncomingByRelation(nodeId: string, relation: string): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(eq(this.table.toId, nodeId), eq(this.table.relation, relation)))
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询指定节点按特定关系的出边 */
  async findOutgoingByRelation(nodeId: string, relation: string): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(and(eq(this.table.fromId, nodeId), eq(this.table.relation, relation)))
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询指定节点按关系+类型条件的出边（仅 to_id 字段） */
  async findOutgoingToId(
    fromId: string,
    fromType: string,
    relation: string
  ): Promise<string | null> {
    const rows = this.drizzle
      .select({ toId: this.table.toId })
      .from(this.table)
      .where(
        and(
          eq(this.table.fromId, fromId),
          eq(this.table.fromType, fromType),
          eq(this.table.relation, relation)
        )
      )
      .limit(1)
      .all();
    return rows.length > 0 ? rows[0].toId : null;
  }

  /** 查询指定节点按多类型条件的入边 */
  async findIncomingByFromTypes(
    toId: string,
    toType: string,
    relation: string
  ): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table.toId, toId),
          eq(this.table.toType, toType),
          eq(this.table.relation, relation)
        )
      )
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 查询 from_id 在指定类型列表中的遵循边 — 用于 getConformances */
  async findConformances(fromId: string): Promise<string[]> {
    const rows = this.drizzle
      .select({ toId: this.table.toId })
      .from(this.table)
      .where(
        and(
          eq(this.table.fromId, fromId),
          inArray(this.table.fromType, ['class', 'category']),
          eq(this.table.relation, 'conforms')
        )
      )
      .all();
    return rows.map((r) => r.toId);
  }

  /** 按关系分组统计 */
  async countByRelation(): Promise<Record<string, number>> {
    const rows = this.drizzle
      .select({
        relation: this.table.relation,
        cnt: count(),
      })
      .from(this.table)
      .groupBy(this.table.relation)
      .all();
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.relation] = row.cnt;
    }
    return result;
  }

  /** 获取入度最高的节点（被引用最多），排除多语言基类和框架根类 */
  async getHotNodes(limit = 15): Promise<{ id: string; type: string; inDegree: number }[]> {
    const exclusions = LanguageProfiles.baseClassExclusions;
    const exclusionList = [...exclusions].map((v) => sql`${v}`);
    const rows = this.drizzle
      .select({
        toId: this.table.toId,
        toType: this.table.toType,
        inDegree: count(),
      })
      .from(this.table)
      .where(sql`${this.table.toId} NOT IN (${sql.join(exclusionList, sql`, `)})`)
      .groupBy(this.table.toId, this.table.toType)
      .orderBy(sql`count(*) DESC`)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.toId,
      type: r.toType,
      inDegree: r.inDegree,
    }));
  }

  /** 按关系类型统计某节点的入边数 */
  async countIncomingByRelation(toId: string, relation: string): Promise<number> {
    const [row] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(and(eq(this.table.toId, toId), eq(this.table.relation, relation)))
      .all();
    return row?.cnt ?? 0;
  }

  /** 按关系类型查询总数 */
  async countByRelationType(relation: string): Promise<number> {
    const [row] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(eq(this.table.relation, relation))
      .all();
    return row?.cnt ?? 0;
  }

  /** 按 metadata_json LIKE 模式删除边（可选过滤关系类型） */
  async deleteByMetadataLike(pattern: string, relations?: string[]): Promise<number> {
    const conditions = [like(this.table.metadataJson, pattern)];
    if (relations?.length) {
      conditions.push(inArray(this.table.relation, relations));
    }
    const result = this.drizzle
      .delete(this.table)
      .where(and(...conditions))
      .run();
    return result.changes;
  }

  /** 删除指定节点的所有出边（按 fromId + fromType） */
  async deleteOutgoing(fromId: string, fromType: string): Promise<number> {
    const result = this.drizzle
      .delete(this.table)
      .where(and(eq(this.table.fromId, fromId), eq(this.table.fromType, fromType)))
      .run();
    return result.changes;
  }

  /** 根据 entry ID 删除所有相关边（用于知识删除时清理图谱） */
  async deleteByEntryId(entryId: string): Promise<number> {
    const result = this.drizzle
      .delete(this.table)
      .where(or(eq(this.table.fromId, entryId), eq(this.table.toId, entryId)))
      .run();
    return result.changes;
  }

  /** 按关系类型查询 */
  async findByRelation(
    nodeId: string,
    nodeType: string,
    relation: string
  ): Promise<KnowledgeEdge[]> {
    const rows = this.drizzle
      .select()
      .from(this.table)
      .where(
        or(
          and(
            eq(this.table.fromId, nodeId),
            eq(this.table.fromType, nodeType),
            eq(this.table.relation, relation)
          ),
          and(
            eq(this.table.toId, nodeId),
            eq(this.table.toType, nodeType),
            eq(this.table.relation, relation)
          )
        )
      )
      .all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 获取所有边（可选类型过滤 + 限制数量） */
  async findAll(options: { nodeType?: string; limit?: number } = {}): Promise<KnowledgeEdge[]> {
    const { nodeType, limit = 1000 } = options;

    let query = this.drizzle.select().from(this.table);

    if (nodeType) {
      query = query.where(
        and(eq(this.table.fromType, nodeType), eq(this.table.toType, nodeType))
      ) as typeof query;
    }

    const rows = query.limit(limit).all();
    return rows.map((r) => this.#mapRow(r));
  }

  /** 统计信息 */
  async getStats(nodeType?: string): Promise<EdgeStats> {
    // 总数
    const condition = nodeType
      ? and(eq(this.table.fromType, nodeType), eq(this.table.toType, nodeType))
      : undefined;

    const [totalRow] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .where(condition)
      .all();
    const totalEdges = totalRow?.cnt ?? 0;

    // 按关系类型分组
    const relationRows = this.drizzle
      .select({
        relation: this.table.relation,
        cnt: count(),
      })
      .from(this.table)
      .where(condition)
      .groupBy(this.table.relation)
      .all();

    const byRelation: Record<string, number> = {};
    for (const row of relationRows) {
      byRelation[row.relation] = row.cnt;
    }

    // 节点类型
    const fromTypes = this.drizzle
      .selectDistinct({ t: this.table.fromType })
      .from(this.table)
      .all()
      .map((r) => r.t);
    const toTypes = this.drizzle
      .selectDistinct({ t: this.table.toType })
      .from(this.table)
      .all()
      .map((r) => r.t);
    const nodeTypes = [...new Set([...fromTypes, ...toTypes])];

    return { totalEdges, byRelation, nodeTypes };
  }

  /** 在事务中执行批量边操作 */
  async batchInTransaction(fn: (tx: DrizzleTx) => void): Promise<void> {
    this.transaction(fn);
  }

  /* ─── Panorama 域查询 (Phase 5e) ─── */

  /**
   * 统计 knowledge_edges JOIN code_entities 的边数 (fan-in/fan-out 分析)
   * direction='from': JOIN on from_id 侧 (fan-out: 模块内实体发出的边)
   * direction='to':   JOIN on to_id 侧 (fan-in: 模块内实体接收的边)
   */
  async countEdgesJoinedByEntityFiles(
    projectRoot: string,
    filePaths: string[],
    relation: string,
    direction: 'from' | 'to'
  ): Promise<number> {
    if (filePaths.length === 0) {
      return 0;
    }
    const joinOn =
      direction === 'from'
        ? and(
            eq(this.table.fromId, codeEntities.entityId),
            eq(this.table.fromType, codeEntities.entityType)
          )
        : and(
            eq(this.table.toId, codeEntities.entityId),
            eq(this.table.toType, codeEntities.entityType)
          );

    const [row] = this.drizzle
      .select({ cnt: count() })
      .from(this.table)
      .innerJoin(codeEntities, joinOn)
      .where(
        and(
          eq(codeEntities.projectRoot, projectRoot),
          inArray(codeEntities.filePath, filePaths),
          eq(this.table.relation, relation)
        )
      )
      .all();
    return row?.cnt ?? 0;
  }

  /**
   * 查询实体使用的设计模式名称 (uses_pattern 边)
   * 限定实体在指定项目的指定文件路径内
   */
  async findPatternsUsedByEntities(projectRoot: string, filePaths: string[]): Promise<string[]> {
    if (filePaths.length === 0) {
      return [];
    }
    const rows = this.drizzle
      .select({ patternName: this.table.toId })
      .from(this.table)
      .innerJoin(codeEntities, eq(this.table.fromId, codeEntities.entityId))
      .where(
        and(
          eq(codeEntities.projectRoot, projectRoot),
          eq(this.table.relation, 'uses_pattern'),
          inArray(codeEntities.filePath, filePaths)
        )
      )
      .all();
    return rows.map((r) => r.patternName);
  }

  /** 最频繁被调用的节点 (calls 关系 GROUP BY to_id) */
  async findTopCalledNodes(limit: number): Promise<Array<{ toId: string; callCount: number }>> {
    const rows = this.drizzle
      .select({
        toId: this.table.toId,
        callCount: count(),
      })
      .from(this.table)
      .where(eq(this.table.relation, 'calls'))
      .groupBy(this.table.toId)
      .orderBy(desc(count()))
      .limit(limit)
      .all();
    return rows.map((r) => ({ toId: r.toId, callCount: r.callCount }));
  }

  /** 入口点: 只有 calls 出度没有 calls 入度的节点 */
  async findEntryPoints(limit: number): Promise<string[]> {
    const rows = this.drizzle
      .selectDistinct({ fromId: this.table.fromId })
      .from(this.table)
      .where(
        and(
          eq(this.table.relation, 'calls'),
          sql`${this.table.fromId} NOT IN (SELECT ${this.table.toId} FROM ${this.table} WHERE ${this.table.relation} = 'calls')`
        )
      )
      .limit(limit)
      .all();
    return rows.map((r) => r.fromId);
  }

  /** 数据生产者: data_flow 出度 > threshold 的节点 */
  async findTopDataFlowSources(limit: number, threshold: number): Promise<string[]> {
    const rows = this.drizzle
      .select({
        fromId: this.table.fromId,
        outCnt: count(),
      })
      .from(this.table)
      .where(eq(this.table.relation, 'data_flow'))
      .groupBy(this.table.fromId)
      .having(sql`count(*) > ${threshold}`)
      .orderBy(desc(count()))
      .limit(limit)
      .all();
    return rows.map((r) => r.fromId);
  }

  /** 数据消费者: data_flow 入度 > threshold 的节点 */
  async findTopDataFlowSinks(limit: number, threshold: number): Promise<string[]> {
    const rows = this.drizzle
      .select({
        toId: this.table.toId,
        inCnt: count(),
      })
      .from(this.table)
      .where(eq(this.table.relation, 'data_flow'))
      .groupBy(this.table.toId)
      .having(sql`count(*) > ${threshold}`)
      .orderBy(desc(count()))
      .limit(limit)
      .all();
    return rows.map((r) => r.toId);
  }

  /**
   * 查询指定关系的边，过滤条件：from 侧是 module 或在指定项目的 code_entities 中存在
   * (用于 CouplingAnalyzer 构建模块间依赖边)
   */
  async findEdgesFilteredByEntityExistence(
    relation: string,
    projectRoot: string
  ): Promise<Array<{ fromId: string; fromType: string; toId: string; toType: string }>> {
    const rows = this.drizzle
      .select({
        fromId: this.table.fromId,
        fromType: this.table.fromType,
        toId: this.table.toId,
        toType: this.table.toType,
      })
      .from(this.table)
      .where(
        and(
          eq(this.table.relation, relation),
          or(
            eq(this.table.fromType, 'module'),
            exists(
              this.drizzle
                .select({ one: sql`1` })
                .from(codeEntities)
                .where(
                  and(
                    eq(codeEntities.entityId, this.table.fromId),
                    eq(codeEntities.projectRoot, projectRoot)
                  )
                )
            )
          )
        )
      )
      .all();
    return rows;
  }

  /** 查询 module→module 的 depends_on 边 (fromId, toId) */
  async findModuleDependencyPairs(): Promise<Array<{ fromId: string; toId: string }>> {
    const rows = this.drizzle
      .select({
        fromId: this.table.fromId,
        toId: this.table.toId,
      })
      .from(this.table)
      .where(
        and(
          eq(this.table.relation, 'depends_on'),
          eq(this.table.fromType, 'module'),
          eq(this.table.toType, 'module')
        )
      )
      .all();
    return rows;
  }

  /** 批量 INSERT OR IGNORE 边 (不更新已存在的行) */
  async bulkInsertIgnore(edges: EdgeInsert[]): Promise<number> {
    if (edges.length === 0) {
      return 0;
    }
    let inserted = 0;
    const now = unixNow();
    this.transaction((tx) => {
      for (const edge of edges) {
        tx.insert(this.table)
          .values({
            fromId: edge.fromId,
            fromType: edge.fromType ?? 'entity',
            toId: edge.toId,
            toType: edge.toType ?? 'recipe',
            relation: edge.relation,
            weight: edge.weight ?? 1.0,
            metadataJson: JSON.stringify(edge.metadata ?? {}),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        inserted++;
      }
    });
    return inserted;
  }

  /* ─── 内部辅助 ─── */

  #mapRow(row: typeof knowledgeEdges.$inferSelect): KnowledgeEdge {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadataJson ?? '{}');
    } catch {
      /* ignore parse errors */
    }
    return {
      id: row.id,
      fromId: row.fromId,
      fromType: row.fromType,
      toId: row.toId,
      toType: row.toType,
      relation: row.relation,
      weight: row.weight ?? 1.0,
      metadata,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
