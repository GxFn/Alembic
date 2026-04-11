/**
 * DeliveryRepoAdapter — CursorDeliveryPipeline 用的仓储适配器
 *
 * 将 call graph 分析中的 raw SQL 查询封装在 lib/repository/ 层。
 */

type RawDb = {
  prepare(sql: string): {
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
};

/** CursorDeliveryPipeline call graph 分析所需的最小接口 */
export interface CallGraphRepo {
  /** 查询 phase5 调用边 */
  findCallEdges(): Array<{ from_id: string; to_id: string; metadata_json: string }>;
  /** 查询方法级代码实体的 entity_id + file_path */
  findMethodEntities(): Array<{ entity_id: string; file_path: string }>;
}

/** Raw-db 适配器：实现 CallGraphRepo 接口 */
export class RawDbCallGraphAdapter implements CallGraphRepo {
  readonly #db: RawDb;

  constructor(db: RawDb) {
    this.#db = db;
  }

  findCallEdges() {
    return this.#db
      .prepare(
        `SELECT from_id, to_id, metadata_json FROM knowledge_edges
         WHERE relation = 'calls' AND metadata_json LIKE '%phase5%'`
      )
      .all() as Array<{ from_id: string; to_id: string; metadata_json: string }>;
  }

  findMethodEntities() {
    return this.#db
      .prepare(`SELECT entity_id, file_path FROM code_entities WHERE entity_type = 'method'`)
      .all() as Array<{ entity_id: string; file_path: string }>;
  }
}
