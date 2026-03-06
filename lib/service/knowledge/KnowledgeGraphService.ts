/**
 * KnowledgeGraphService - 知识图谱服务
 *
 * 管理 Recipe 之间的关系（统一模型，包含所有知识类型）
 * 支持关系查询、路径分析、PageRank 权重计算
 */

import { RelationType } from '../../domain/index.js';
import Logger from '../../infrastructure/logging/Logger.js';

// Re-export unified RelationType for backward compatibility
export { RelationType };

export class KnowledgeGraphService {
  db: any;
  logger: any;
  constructor(db) {
    this.db = typeof db?.getDb === 'function' ? db.getDb() : db;
    this.logger = Logger.getInstance();
  }

  /**
   * 添加关系边
   */
  addEdge(fromId, fromType, toId, toType, relation, metadata: any = {}) {
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
    } catch (error: any) {
      this.logger.error('Failed to add edge', { fromId, toId, relation, error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * 删除关系边
   */
  removeEdge(fromId, fromType, toId, toType, relation) {
    this.db
      .prepare(`
      DELETE FROM knowledge_edges WHERE from_id = ? AND from_type = ? AND to_id = ? AND to_type = ? AND relation = ?
    `)
      .run(fromId, fromType, toId, toType, relation);
  }

  /**
   * 查询某个节点的所有关系
   */
  getEdges(nodeId, nodeType, direction = 'both') {
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
      outgoing: outgoing.map(this._mapEdge),
      incoming: incoming.map(this._mapEdge),
    };
  }

  /**
   * 查询指定关系类型的连接
   */
  getRelated(nodeId, nodeType, relation) {
    const rows = this.db
      .prepare(`
      SELECT * FROM knowledge_edges WHERE from_id = ? AND from_type = ? AND relation = ?
      UNION ALL
      SELECT * FROM knowledge_edges WHERE to_id = ? AND to_type = ? AND relation = ?
    `)
      .all(nodeId, nodeType, relation, nodeId, nodeType, relation);

    return rows.map(this._mapEdge);
  }

  /**
   * 查找两个节点之间的路径 (BFS, 最大深度 5)
   */
  findPath(fromId, fromType, toId, toType, maxDepth = 5) {
    const visited = new Set();
    const queue = [{ id: fromId, type: fromType, path: [] as any[] }];

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

    return { found: false, path: [] as any[], depth: -1 };
  }

  /**
   * 获取节点的影响范围（下游依赖分析）
   */
  getImpactAnalysis(nodeId, nodeType, maxDepth = 3) {
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
  getStats(nodeType) {
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
      totalEdges: edgeCount.total,
      byRelation: Object.fromEntries(byRelation.map((r) => [r.relation, r.count])),
      nodeTypes: byType,
    };
  }

  /**
   * 获取全量边（供 Dashboard 图谱可视化）
   * @param {number} [limit=500] 最大返回条数
   * @param {string} [nodeType] 过滤节点类型（如 'recipe'），为空则返回全部
   */
  getAllEdges(limit = 500, nodeType) {
    let sql, params;
    if (nodeType) {
      sql = `SELECT * FROM knowledge_edges WHERE from_type = ? AND to_type = ? ORDER BY updated_at DESC LIMIT ?`;
      params = [nodeType, nodeType, limit];
    } else {
      sql = `SELECT * FROM knowledge_edges ORDER BY updated_at DESC LIMIT ?`;
      params = [limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(this._mapEdge);
  }

  // Private

  _mapEdge(row) {
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

let instance: any = null;

export function initKnowledgeGraphService(db) {
  instance = new KnowledgeGraphService(db);
  return instance;
}

export function getKnowledgeGraphService() {
  return instance;
}

export default KnowledgeGraphService;
