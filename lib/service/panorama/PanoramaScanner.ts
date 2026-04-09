/**
 * PanoramaScanner — 全景数据内置扫描器
 *
 * 在全景数据缺失时自动运行轻量级结构扫描（Phase 1→2.1），
 * 填充 code_entities + knowledge_edges，使 PanoramaService 能产生有效数据。
 *
 * 非 MCP 操作，而是 PanoramaService 的内置依赖。
 * 调用时机：
 *   - PanoramaService 发现 DB 中无 code_entities 时自动触发
 *   - 手动调用 invalidate + getResult 时检查并补充
 *
 * @module PanoramaScanner
 */

/* ═══ Types ═══════════════════════════════════════════════ */

export interface PanoramaScannerOptions {
  projectRoot: string;
  container: ScannerContainer;
  logger?: ScannerLogger;
}

export interface ScannerContainer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI container: callers know the service type
  get(name: string): any;
}

export interface ScannerLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface ScanResult {
  entities: number;
  edges: number;
  modules: number;
  durationMs: number;
}

/* ═══ Silent Logger (fallback) ════════════════════════════ */

const SILENT_LOGGER: ScannerLogger = {
  info() {},
  warn() {},
};

/* ═══ PanoramaScanner Class ═══════════════════════════════ */

export class PanoramaScanner {
  readonly #projectRoot: string;
  readonly #container: ScannerContainer;
  readonly #logger: ScannerLogger;
  #hasScanned = false;

  constructor(opts: PanoramaScannerOptions) {
    this.#projectRoot = opts.projectRoot;
    this.#container = opts.container;
    this.#logger = opts.logger ?? SILENT_LOGGER;
  }

  /**
   * 检测 DB 中是否已有该项目的 code_entities 数据
   */
  hasData(): boolean {
    try {
      const db = this.#container.get('database');
      const rawDb = db?.getDb ? db.getDb() : db;
      if (!rawDb?.prepare) {
        return false;
      }
      const row = rawDb
        .prepare(`SELECT COUNT(*) as cnt FROM code_entities WHERE project_root = ?`)
        .get(this.#projectRoot) as { cnt: number } | undefined;
      return (row?.cnt ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * 确保全景数据存在。无数据时自动执行扫描。
   * 幂等：扫描过一次后不再重复（重启进程或手动 reset 可重新触发）。
   */
  async ensureData(): Promise<ScanResult | null> {
    if (this.#hasScanned || this.hasData()) {
      return null;
    }
    return this.scan();
  }

  /**
   * 执行完整扫描（强制，不检查缓存）
   */
  async scan(): Promise<ScanResult> {
    const t0 = Date.now();
    this.#logger.info('[PanoramaScanner] Starting structure scan...');

    let entities = 0;
    let edges = 0;
    let modules = 0;

    try {
      const {
        runPhase1_FileCollection,
        runPhase1_5_AstAnalysis,
        runPhase1_6_EntityGraph,
        runPhase1_7_CallGraph,
        runPhase2_DependencyGraph,
        runPhase2_1_ModuleEntities,
      } = await import('../../external/mcp/handlers/bootstrap/shared/bootstrap-phases.js');

      // Phase 1: 文件收集
      const phase1 = await runPhase1_FileCollection(this.#projectRoot, this.#logger, {
        maxFiles: 500,
      });

      if (!phase1.allFiles?.length) {
        this.#logger.warn('[PanoramaScanner] No files found, skipping scan');
        this.#hasScanned = true;
        return { entities: 0, edges: 0, modules: 0, durationMs: Date.now() - t0 };
      }

      // Phase 1.5: AST 分析
      const phase1_5 = await runPhase1_5_AstAnalysis(
        phase1.allFiles,
        phase1.langStats,
        this.#logger
      );

      // Phase 1.6: Entity Graph 写入
      if (phase1_5.astProjectSummary) {
        const phase1_6 = await runPhase1_6_EntityGraph(
          phase1_5.astProjectSummary,
          this.#projectRoot,
          this.#container,
          this.#logger
        );
        entities = phase1_6.codeEntityResult?.entitiesUpserted ?? 0;
        edges = phase1_6.codeEntityResult?.edgesCreated ?? 0;
      }

      // Phase 1.7: Call Graph (增强耦合准确度)
      if (phase1_5.astProjectSummary) {
        try {
          await runPhase1_7_CallGraph(
            phase1_5.astProjectSummary,
            this.#projectRoot,
            this.#container,
            this.#logger
          );
        } catch {
          // Call graph 失败不阻塞
        }
      }

      // Phase 2: 依赖图
      if (phase1.discoverer) {
        const phase2 = await runPhase2_DependencyGraph(
          phase1.discoverer,
          this.#container,
          this.#logger
        );
        edges += phase2.depEdgesWritten;

        // Phase 2.1: Module 实体
        if (phase2.depGraphData) {
          await runPhase2_1_ModuleEntities(
            phase2.depGraphData,
            this.#projectRoot,
            this.#container,
            this.#logger
          );
          modules = phase2.depGraphData.nodes?.length ?? 0;
        }
      }

      // Phase 2-extra: CustomConfig 增强
      // 当主 discoverer 不是 customConfig 时，尝试 CustomConfigDiscoverer
      // 以获取更丰富的模块视图（混编项目常见：jvm/node/dart 获胜但模块数偏少）
      if (phase1.discoverer && phase1.discoverer.id !== 'customConfig') {
        try {
          const { CustomConfigDiscoverer } = await import(
            '../../core/discovery/CustomConfigDiscoverer.js'
          );
          const ccDiscoverer = new CustomConfigDiscoverer();
          const ccDetect = await ccDiscoverer.detect(this.#projectRoot);

          if (ccDetect.match && ccDetect.confidence >= 0.7) {
            await ccDiscoverer.load(this.#projectRoot);
            const ccTargets = await ccDiscoverer.listTargets();

            // 仅当 CustomConfig 发现更多模块时才采纳
            if (ccTargets.length > modules) {
              this.#logger.info(
                `[PanoramaScanner] CustomConfig enrichment: ${ccTargets.length} modules ` +
                  `(primary discoverer '${phase1.discoverer.id}' found ${modules})`
              );
              const ccPhase2 = await runPhase2_DependencyGraph(
                ccDiscoverer as unknown as Parameters<typeof runPhase2_DependencyGraph>[0],
                this.#container,
                this.#logger,
                'custom-enrichment'
              );
              edges += ccPhase2.depEdgesWritten;

              if (ccPhase2.depGraphData) {
                await runPhase2_1_ModuleEntities(
                  ccPhase2.depGraphData,
                  this.#projectRoot,
                  this.#container,
                  this.#logger
                );
                modules = Math.max(modules, ccPhase2.depGraphData.nodes?.length ?? 0);
              }
            }
          }
        } catch {
          // CustomConfig 增强失败不阻塞主流程
        }
      }

      // Phase 2.2: 目录推断兜底
      // 当 Phase 2.1 未产出 module 实体时（无 Package.swift / build.gradle 等），
      // 从已有 code_entities 按顶层目录分组写入 module 实体
      if (modules === 0 && entities > 0) {
        modules = this.#inferModulesFromDirectories();
      }
    } catch (err: unknown) {
      this.#logger.warn(
        `[PanoramaScanner] Scan failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    this.#hasScanned = true;
    const durationMs = Date.now() - t0;
    this.#logger.info(
      `[PanoramaScanner] Scan complete: ${entities} entities, ${edges} edges, ${modules} modules (${durationMs}ms)`
    );

    return { entities, edges, modules, durationMs };
  }

  /**
   * 重置扫描状态（允许下次 ensureData 重新扫描）
   */
  reset(): void {
    this.#hasScanned = false;
  }

  /* ─── 目录推断兜底 ─────────────────────────────── */

  /**
   * 从 code_entities 中按顶层目录分组写入 module 实体 + is_part_of 边。
   * 仅在 Phase 2.1 未产出 module 时调用。
   */
  #inferModulesFromDirectories(): number {
    try {
      const db = this.#container.get('database');
      const rawDb = db?.getDb ? db.getDb() : db;
      if (!rawDb?.prepare) {
        return 0;
      }

      // 查询所有非 module 实体的文件路径
      const rows = rawDb
        .prepare(
          `SELECT DISTINCT entity_id, file_path FROM code_entities
           WHERE project_root = ? AND file_path IS NOT NULL AND entity_type != 'module'`
        )
        .all(this.#projectRoot) as Array<Record<string, unknown>>;

      if (rows.length === 0) {
        return 0;
      }

      // 按顶层目录分组
      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const filePath = row.file_path as string;
        if (!filePath) {
          continue;
        }

        const relative = filePath.startsWith(this.#projectRoot)
          ? filePath.slice(this.#projectRoot.length).replace(/^\//, '')
          : filePath;
        const firstDir = relative.split('/')[0];
        if (!firstDir || firstDir.startsWith('.')) {
          continue;
        }

        if (!groups.has(firstDir)) {
          groups.set(firstDir, []);
        }
        groups.get(firstDir)!.push(row.entity_id as string);
      }

      if (groups.size === 0) {
        return 0;
      }

      // 写入 module 实体 + is_part_of 边
      const insertEntity = rawDb.prepare(
        `INSERT OR IGNORE INTO code_entities (entity_id, name, entity_type, file_path, project_root)
         VALUES (?, ?, 'module', NULL, ?)`
      );
      const insertEdge = rawDb.prepare(
        `INSERT OR IGNORE INTO knowledge_edges (from_id, from_type, to_id, to_type, relation, weight)
         VALUES (?, 'entity', ?, 'module', 'is_part_of', 1.0)`
      );

      for (const [dirName, entityIds] of groups) {
        insertEntity.run(dirName, dirName, this.#projectRoot);
        for (const entityId of entityIds) {
          insertEdge.run(entityId, dirName);
        }
      }

      this.#logger.info(
        `[PanoramaScanner] Directory fallback: inferred ${groups.size} modules from top-level dirs`
      );
      return groups.size;
    } catch (err: unknown) {
      this.#logger.warn(
        `[PanoramaScanner] Directory fallback failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return 0;
    }
  }
}
