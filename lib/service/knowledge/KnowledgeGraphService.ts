/**
 * KnowledgeGraphService - 知识图谱服务
 *
 * 管理 Recipe 之间的关系（统一模型，包含所有知识类型）
 * 支持关系查询、路径分析、PageRank 权重计算
 */

import type { Database } from 'better-sqlite3';
import { RelationType } from '../../domain/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

/** SQLite row from knowledge_edges table */
interface EdgeRow {
  id: number;
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

interface MappedEdge {
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

interface DbLike {
  getDb?: () => Database;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): EdgeRow;
    all(...params: unknown[]): EdgeRow[];
  };
}

// Re-export unified RelationType for backward compatibility
export { RelationType };

export class KnowledgeGraphService {
  db: DbLike;
  logger: ReturnType<typeof Logger.getInstance>;
  constructor(db: DbLike) {
    this.db = typeof db?.getDb === 'function' ? (db.getDb() as unknown as DbLike) : db;
    this.logger = Logger.getInstance();
  }

  /**
   * 添加关系边
   */
  addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    metadata: Record<string, unknown> = {}
  ) {
    const now = Math.floor(Date.now() / 1000);
    try {
      this.db
        .prepare(`
        INSERT OR REPLACE INTO knowledge_edges (from_id, from_type, to_id, to_type, relation, weight, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
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

      return { success: true };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to add edge', { fromId, toId, relation, error: errMsg });
      return { success: false, error: errMsg };
    }
  }

  /**
   * 删除关系边
   */
  removeEdge(fromId: string, fromType: string, toId: string, toType: string, relation: string) {
    this.db
      .prepare(`
      DELETE FROM knowledge_edges WHERE from_id = ? AND from_type = ? AND to_id = ? AND to_type = ? AND relation = ?
    `)
      .run(fromId, fromType, toId, toType, relation);
  }

  /**
   * 查询某个节点的所有关系
   */
  getEdges(nodeId: string, nodeType: string, direction = 'both') {
    const outgoing =
      direction === 'both' || direction === 'out'
        ? this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE from_id = ? AND from_type = ?`)
            .all(nodeId, nodeType)
        : [];

    const incoming =
      direction === 'both' || direction === 'in'
        ? this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE to_id = ? AND to_type = ?`)
            .all(nodeId, nodeType)
        : [];

    return {
      outgoing: outgoing.map((row) => this._mapEdge(row)),
      incoming: incoming.map((row) => this._mapEdge(row)),
    };
  }

  /**
   * 查询指定关系类型的连接
   */
  getRelated(nodeId: string, nodeType: string, relation: string) {
    const rows = this.db
      .prepare(`
      SELECT * FROM knowledge_edges WHERE from_id = ? AND from_type = ? AND relation = ?
      UNION ALL
      SELECT * FROM knowledge_edges WHERE to_id = ? AND to_type = ? AND relation = ?
    `)
      .all(nodeId, nodeType, relation, nodeId, nodeType, relation);

    return rows.map((row) => this._mapEdge(row));
  }

  /**
   * 查找两个节点之间的路径 (BFS, 最大深度 5)
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
        .prepare(`
        SELECT to_id, to_type, relation, weight FROM knowledge_edges WHERE from_id = ? AND from_type = ?
      `)
        .all(id, type);

      for (const neighbor of neighbors) {
        const newPath = [
          ...path,
          {
            from: { id, type },
            to: { id: neighbor.to_id, type: neighbor.to_type },
            relation: neighbor.relation,
          },
        ];

        if (neighbor.to_id === toId && neighbor.to_type === toType) {
          return { found: true, path: newPath, depth: newPath.length };
        }

        queue.push({ id: neighbor.to_id, type: neighbor.to_type, path: newPath });
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
   * 获取节点的影响范围（下游依赖分析）
   */
  getImpactAnalysis(nodeId: string, nodeType: string, maxDepth = 3) {
    const impacted = new Map();
    const queue = [{ id: nodeId, type: nodeType, depth: 0 }];

    while (queue.length > 0) {
      const { id, type, depth } = queue.shift()!;
      if (depth >= maxDepth) {
        continue;
      }

      const dependents = this.db
        .prepare(`
        SELECT from_id, from_type, relation FROM knowledge_edges 
        WHERE to_id = ? AND to_type = ? AND relation IN ('requires', 'extends', 'enforces', 'depends_on', 'inherits', 'implements', 'calls', 'prerequisite')
      `)
        .all(id, type);

      for (const dep of dependents) {
        const key = `${dep.from_type}:${dep.from_id}`;
        if (!impacted.has(key)) {
          impacted.set(key, {
            id: dep.from_id,
            type: dep.from_type,
            relation: dep.relation,
            depth: depth + 1,
          });
          queue.push({ id: dep.from_id, type: dep.from_type, depth: depth + 1 });
        }
      }
    }

    return Array.from(impacted.values());
  }

  /**
   * 获取图谱整体统计
   */
  /**
   * @param {string} [nodeType] 过滤节点类型（如 'recipe'），为空则返回全部
   */
  getStats(nodeType?: string) {
    const typeFilter = nodeType
      ? ` WHERE from_type = '${nodeType}' AND to_type = '${nodeType}'`
      : '';
    const edgeCount = this.db
      .prepare(`SELECT COUNT(*) as total FROM knowledge_edges${typeFilter}`)
      .get();
    const byRelation = this.db
      .prepare(
        `SELECT relation, COUNT(*) as count FROM knowledge_edges${typeFilter} GROUP BY relation`
      )
      .all();
    const byType = this.db
      .prepare(
        `SELECT from_type as type, COUNT(DISTINCT from_id) as count FROM knowledge_edges${typeFilter} GROUP BY from_type
       UNION
       SELECT to_type as type, COUNT(DISTINCT to_id) as count FROM knowledge_edges${typeFilter} GROUP BY to_type`
      )
      .all();

    return {
      totalEdges: (edgeCount as unknown as Record<string, number>).total,
      byRelation: Object.fromEntries(
        byRelation.map((r) => [r.relation, (r as unknown as Record<string, unknown>).count])
      ),
      nodeTypes: byType,
    };
  }

  /**
   * 获取全量边（供 Dashboard 图谱可视化）
   * @param {number} [limit=500] 最大返回条数
   * @param {string} [nodeType] 过滤节点类型（如 'recipe'），为空则返回全部
   */
  getAllEdges(limit = 500, nodeType?: string) {
    let sql: string, params: (string | number)[];
    if (nodeType) {
      sql = `SELECT * FROM knowledge_edges WHERE from_type = ? AND to_type = ? ORDER BY updated_at DESC LIMIT ?`;
      params = [nodeType, nodeType, limit];
    } else {
      sql = `SELECT * FROM knowledge_edges ORDER BY updated_at DESC LIMIT ?`;
      params = [limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this._mapEdge(row));
  }

  // Private

  _mapEdge(row: EdgeRow): MappedEdge {
    return {
      id: row.id,
      fromId: row.from_id,
      fromType: row.from_type,
      toId: row.to_id,
      toType: row.to_type,
      relation: row.relation,
      weight: row.weight,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let instance: KnowledgeGraphService | null = null;

export function initKnowledgeGraphService(db: DbLike) {
  instance = new KnowledgeGraphService(db);
  return instance;
}

export function getKnowledgeGraphService(): KnowledgeGraphService | null {
  return instance;
}

export default KnowledgeGraphService;
