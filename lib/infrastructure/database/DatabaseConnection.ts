import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pathGuard from '../../shared/PathGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * DatabaseConnection - 数据库连接管理器
 *
 * 重要：相对 DB 路径通过 projectRoot 解析，而非 process.cwd()。
 * 这样即使 MCP 服务器的 cwd 不是项目目录，DB 也不会创建到项目外。
 */
export class DatabaseConnection {
  config: any;
  db: any;
  constructor(config: any) {
    this.config = config;
    this.db = null;
  }

  /**
   * 连接数据库
   */
  async connect() {
    const dbPath = this.config.path;

    // 使用 projectRoot（PathGuard 已配置）优先解析相对路径，
    // 而非 path.resolve()（依赖 cwd，MCP 场景下 cwd 可能是用户主目录）
    const projectRoot = pathGuard.projectRoot;
    const resolvedDbPath =
      projectRoot && !path.isAbsolute(dbPath)
        ? path.resolve(projectRoot, dbPath)
        : path.resolve(dbPath);

    // 路径安全检查 — 防止 DB 文件创建到项目允许范围外
    pathGuard.assertProjectWriteSafe(resolvedDbPath);

    // 确保数据目录存在
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(resolvedDbPath, {
      verbose: this.config.verbose
        ? (msg: unknown) => {
            process.stderr.write(`[SQL] ${msg}\n`);
          }
        : undefined,
    });

    // 启用 WAL 模式（Write-Ahead Logging）
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    return this.db;
  }

  /**
   * 运行所有 migration（支持 .sql 和 .js）
   */
  async runMigrations() {
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') || file.endsWith('.js'))
      .sort();

    // 确保 schema_migrations 表存在
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    for (const file of migrationFiles) {
      const version = file.replace(/\.(sql|js)$/, '');

      // 检查是否已应用
      const applied = this.db
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(version);

      if (!applied) {
        process.stderr.write(`Applying migration: ${version}\n`);

        if (file.endsWith('.js')) {
          // JS migration: export default function(db) { ... }
          const mod = await import(path.join(migrationsDir, file));
          const migrate = mod.default || mod;
          const runMigration = this.db.transaction(() => {
            migrate(this.db);
            this.db
              .prepare(
                'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
              )
              .run(version, new Date().toISOString());
          });
          runMigration();
        } else {
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          const runMigration = this.db.transaction(() => {
            this.db.exec(sql);
            this.db
              .prepare(
                'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
              )
              .run(version, new Date().toISOString());
          });
          runMigration();
        }

        process.stderr.write(`✅ Migration ${version} applied\n`);
      }
    }
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * 获取数据库实例
   */
  getDb() {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.db;
  }
}

export default DatabaseConnection;
