import Logger from '../../infrastructure/logging/Logger.js';
import { unixNow } from '../../shared/utils/common.js';

/** Only allow safe SQL identifier characters: letters, digits, underscore */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** @deprecated alias — use SAFE_IDENTIFIER_RE */
const SAFE_COLUMN_RE = SAFE_IDENTIFIER_RE;

/**
 * BaseRepository - 基础仓储类
 * 提供通用的 CRUD 操作和查询功能
 */
export class BaseRepository {
  /** @type {Set<string>|null} lazily-populated column whitelist */
  #columnWhitelist = null;

  constructor(database, tableName) {
    // 校验 tableName 防止 SQL 注入（与列名使用相同的标识符规则）
    if (!SAFE_IDENTIFIER_RE.test(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }
    this.db = database.getDb();
    this.tableName = tableName;
    this.logger = Logger.getInstance();
  }

  /**
   * Validate that a column name is safe for SQL interpolation.
   * Rejects anything that doesn't match /^[a-zA-Z_]\w*$/ or
   * is not a real column in the table.
   */
  _assertSafeColumn(key) {
    if (!SAFE_COLUMN_RE.test(key)) {
      throw new Error(`Invalid column name: ${key}`);
    }
    // Lazily build column whitelist from table pragma
    if (!this.#columnWhitelist) {
      try {
        const cols = this.db.prepare(`PRAGMA table_info(${this.tableName})`).all();
        this.#columnWhitelist = new Set(cols.map(c => c.name));
      } catch {
        this.#columnWhitelist = new Set();
      }
    }
    if (this.#columnWhitelist.size > 0 && !this.#columnWhitelist.has(key)) {
      throw new Error(`Unknown column "${key}" for table ${this.tableName}`);
    }
  }

  /**
   * 创建实体
   */
  async create(entity) {
    throw new Error('create() must be implemented in subclass');
  }

  /**
   * 根据 ID 获取实体
   */
  async findById(id) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM ${this.tableName} WHERE id = ? LIMIT 1
      `);
      const row = stmt.get(id);
      
      if (!row) {
        return null;
      }

      return this._mapRowToEntity(row);
    } catch (error) {
      this.logger.error(`Error finding by id in ${this.tableName}`, {
        id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 获取所有实体
   */
  async findAll(filters = {}) {
    try {
      let query = `SELECT * FROM ${this.tableName}`;
      const params = [];

      // 添加过滤条件
      if (Object.keys(filters).length > 0) {
        const conditions = Object.keys(filters).map((key) => {
          this._assertSafeColumn(key);
          params.push(filters[key]);
          return `${key} = ?`;
        });
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ' ORDER BY created_at DESC';

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params);

      return rows.map((row) => this._mapRowToEntity(row));
    } catch (error) {
      this.logger.error(`Error finding all in ${this.tableName}`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 分页查询
   */
  async findWithPagination(filters = {}, { page = 1, pageSize = 20 } = {}) {
    try {
      const offset = (page - 1) * pageSize;

      let countQuery = `SELECT COUNT(*) as count FROM ${this.tableName}`;
      let query = `SELECT * FROM ${this.tableName}`;
      const params = [];

      // 添加过滤条件
      if (Object.keys(filters).length > 0) {
        const conditions = Object.keys(filters).map((key) => {
          this._assertSafeColumn(key);
          params.push(filters[key]);
          return `${key} = ?`;
        });
        const whereClause = ` WHERE ${conditions.join(' AND ')}`;
        countQuery += whereClause;
        query += whereClause;
      }

      // 获取总数
      const countStmt = this.db.prepare(countQuery);
      const countResult = countStmt.get(...params.slice(0, Object.keys(filters).length));
      const total = countResult.count;

      // 获取分页数据
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      const dataStmt = this.db.prepare(query);
      const data = dataStmt.all(
        ...params.slice(0, Object.keys(filters).length),
        pageSize,
        offset
      );

      return {
        data: data.map((row) => this._mapRowToEntity(row)),
        pagination: {
          page,
          pageSize,
          total,
          pages: Math.ceil(total / pageSize),
        },
      };
    } catch (error) {
      this.logger.error(`Error in pagination for ${this.tableName}`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 更新实体
   */
  async update(id, updates) {
    try {
      const updateKeys = Object.keys(updates);
      const updateValues = Object.values(updates);
      
      for (const key of updateKeys) this._assertSafeColumn(key);
      const setClause = updateKeys.map((key) => `${key} = ?`).join(', ');
      const query = `
        UPDATE ${this.tableName}
        SET ${setClause}, updated_at = ?
        WHERE id = ?
      `;

      const stmt = this.db.prepare(query);
      stmt.run(...updateValues, unixNow(), id);

      return this.findById(id);
    } catch (error) {
      this.logger.error(`Error updating in ${this.tableName}`, {
        id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 删除实体
   */
  async delete(id) {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM ${this.tableName} WHERE id = ?
      `);
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      this.logger.error(`Error deleting from ${this.tableName}`, {
        id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 计数
   */
  async count(filters = {}) {
    try {
      let query = `SELECT COUNT(*) as count FROM ${this.tableName}`;
      const params = [];

      if (Object.keys(filters).length > 0) {
        const conditions = Object.keys(filters).map((key) => {
          this._assertSafeColumn(key);
          params.push(filters[key]);
          return `${key} = ?`;
        });
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      const stmt = this.db.prepare(query);
      const result = stmt.get(...params);
      return result.count;
    } catch (error) {
      this.logger.error(`Error counting in ${this.tableName}`, {
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * 映射行数据到实体（由子类实现）
   */
  _mapRowToEntity(row) {
    throw new Error('_mapRowToEntity() must be implemented in subclass');
  }

  /**
   * 映射实体到行数据（由子类实现）
   */
  _mapEntityToRow(entity) {
    throw new Error('_mapEntityToRow() must be implemented in subclass');
  }
}

export default BaseRepository;
