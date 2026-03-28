/**
 * RoleRefiner — 四重信号融合角色精化
 *
 * 将 TargetClassifier 的正则推断 (~65% 准确率) 提升到 ≥90%，
 * 通过融合 AST 结构、CallGraph 行为、DataFlow 数据流、EntityGraph 拓扑四重信号。
 *
 * 信号权重:
 *   AST 结构        0.30   继承链/协议/import/后缀
 *   CallGraph 行为   0.30   被调用分析/扇入扇出比/调用类型
 *   DataFlow 数据流  0.15   源汇分析/转换检测
 *   EntityGraph 拓扑 0.10   入度分析/模式检测
 *   正则基线         0.15   TargetClassifier 结果
 *
 * @module RoleRefiner
 */

import type { CeDbLike } from './PanoramaTypes.js';

/* ═══ Types ═══════════════════════════════════════════════ */

export type ModuleRole =
  | 'core'
  | 'service'
  | 'ui'
  | 'networking'
  | 'storage'
  | 'test'
  | 'app'
  | 'routing'
  | 'utility'
  | 'model'
  | 'auth'
  | 'config'
  | 'feature';

export interface RoleSignal {
  role: ModuleRole;
  confidence: number; // 0-1
  weight: number;
  source: string;
}

export type RoleResolution = 'clear' | 'uncertain' | 'fallback';

export interface RefinedRole {
  refinedRole: ModuleRole;
  confidence: number;
  resolution: RoleResolution;
  alternatives?: Array<[string, number]>;
  signals: RoleSignal[];
}

export interface ModuleCandidate {
  name: string;
  inferredRole: ModuleRole;
  files: string[];
}

/* ═══ Constants ═══════════════════════════════════════════ */

const WEIGHTS = {
  ast: 0.3,
  callGraph: 0.3,
  dataFlow: 0.15,
  entityGraph: 0.1,
  regex: 0.15,
} as const;

/* ─── 语言族定义 ─────────────────────────────────────────── */

type LangFamily = 'apple' | 'jvm' | 'dart' | 'python' | 'web' | 'go' | 'rust';

/** primary_lang / LanguageService 输出 → 语言族 */
const LANG_TO_FAMILY: Record<string, LangFamily> = {
  swift: 'apple',
  objectivec: 'apple',
  java: 'jvm',
  kotlin: 'jvm',
  dart: 'dart',
  python: 'python',
  typescript: 'web',
  javascript: 'web',
  tsx: 'web',
  go: 'go',
  rust: 'rust',
};

/* ─── 按语言族分区的超类映射 ─────────────────────────────── */

const SUPERCLASS_BY_FAMILY: Record<LangFamily, Record<string, ModuleRole>> = {
  apple: {
    UIViewController: 'ui',
    UIView: 'ui',
    UITableViewCell: 'ui',
    UICollectionViewCell: 'ui',
    UINavigationController: 'routing',
    UITabBarController: 'routing',
    NSObject: 'core',
    NSManagedObject: 'storage',
  },
  jvm: {
    Activity: 'ui',
    AppCompatActivity: 'ui',
    Fragment: 'ui',
    DialogFragment: 'ui',
    View: 'ui',
    RecyclerViewAdapter: 'ui',
    Service: 'service',
    IntentService: 'service',
    BroadcastReceiver: 'service',
    ContentProvider: 'storage',
    ViewModel: 'ui',
    AndroidViewModel: 'ui',
    Application: 'app',
  },
  dart: {
    StatefulWidget: 'ui',
    StatelessWidget: 'ui',
    State: 'ui',
    ChangeNotifier: 'service',
    Cubit: 'service',
    Bloc: 'service',
  },
  python: {
    BaseModel: 'model',
    Model: 'model',
    APIView: 'service',
    ViewSet: 'service',
    TestCase: 'test',
  },
  web: {
    Component: 'ui',
    Controller: 'service',
    Module: 'app',
  },
  go: {},
  rust: {},
};

/* ─── 按语言族分区的协议/接口映射 ────────────────────────── */

const PROTOCOL_BY_FAMILY: Record<LangFamily, Record<string, ModuleRole>> = {
  apple: {
    UITableViewDataSource: 'ui',
    UITableViewDelegate: 'ui',
    UICollectionViewDataSource: 'ui',
    URLSessionDelegate: 'networking',
    Codable: 'model',
    Decodable: 'model',
    Encodable: 'model',
  },
  jvm: {
    Serializable: 'model',
    Parcelable: 'model',
    Runnable: 'core',
    Callable: 'core',
    OnClickListener: 'ui',
    Adapter: 'ui',
    Repository: 'storage',
  },
  dart: {
    Widget: 'ui',
  },
  web: {
    OnInit: 'ui',
    OnDestroy: 'ui',
    CanActivate: 'routing',
    NestMiddleware: 'service',
  },
  go: {
    Handler: 'service',
    ReadWriter: 'core',
    Reader: 'core',
    Writer: 'core',
    Stringer: 'utility',
  },
  rust: {
    Display: 'utility',
    Debug: 'utility',
    Serialize: 'model',
    Deserialize: 'model',
    Future: 'core',
    Stream: 'core',
    Service: 'service',
  },
  python: {},
};

/* ─── 按语言族分区的 import 模式 ─────────────────────────── */

interface ImportPattern {
  regex: RegExp;
  role: ModuleRole;
}

const IMPORT_PATTERNS_BY_FAMILY: Record<LangFamily, ImportPattern[]> = {
  apple: [
    { regex: /alamofire|urlsession|afnetworking|moya/i, role: 'networking' },
    { regex: /\buikit\b|swiftui|rx.*cocoa|snapkit|masonry/i, role: 'ui' },
    { regex: /realm|coredata|fmdb|grdb/i, role: 'storage' },
    { regex: /xctest/i, role: 'test' },
  ],
  jvm: [
    { regex: /retrofit|okhttp|volley/i, role: 'networking' },
    { regex: /android\.widget|jetpack.*compose|recyclerview/i, role: 'ui' },
    { regex: /room|hibernate|greendao/i, role: 'storage' },
    { regex: /junit|espresso|mockito/i, role: 'test' },
  ],
  dart: [
    { regex: /\bdio\b|http_client/i, role: 'networking' },
    { regex: /flutter|cupertino|material/i, role: 'ui' },
    { regex: /sqflite|hive|objectbox/i, role: 'storage' },
    { regex: /flutter_test/i, role: 'test' },
  ],
  python: [
    { regex: /requests|aiohttp|httpx|urllib/i, role: 'networking' },
    { regex: /tkinter|pyqt|kivy/i, role: 'ui' },
    { regex: /sqlalchemy|django\.db|peewee|tortoise/i, role: 'storage' },
    { regex: /pytest|unittest/i, role: 'test' },
  ],
  web: [
    { regex: /axios|fetch|got|superagent/i, role: 'networking' },
    { regex: /react|angular|vue|svelte|next|nuxt/i, role: 'ui' },
    { regex: /typeorm|prisma|sequelize|mongoose|knex/i, role: 'storage' },
    { regex: /jest|mocha|vitest|cypress|playwright/i, role: 'test' },
    { regex: /express|fastify|nestjs|koa/i, role: 'routing' },
  ],
  go: [
    { regex: /net\/http|resty/i, role: 'networking' },
    { regex: /gin|echo|fiber|mux|chi/i, role: 'routing' },
    { regex: /gorm|sqlx|ent/i, role: 'storage' },
    { regex: /testing/i, role: 'test' },
  ],
  rust: [
    { regex: /reqwest|hyper|surf/i, role: 'networking' },
    { regex: /actix|axum|warp|rocket/i, role: 'routing' },
    { regex: /diesel|sqlx|sea-orm/i, role: 'storage' },
    { regex: /tokio-test/i, role: 'test' },
  ],
};

/** 通用 import 模式（任何语言都适用） */
const UNIVERSAL_IMPORT_PATTERNS: ImportPattern[] = [
  { regex: /network/i, role: 'networking' },
  { regex: /sqlite/i, role: 'storage' },
  { regex: /router|routing|navigation/i, role: 'routing' },
];

/* ═══ RoleRefiner Class ═══════════════════════════════════ */

export class RoleRefiner {
  readonly #db: CeDbLike;
  readonly #projectRoot: string;
  #families: LangFamily[] | null = null;
  #superclassMap: Record<string, ModuleRole> | null = null;
  #protocolMap: Record<string, ModuleRole> | null = null;
  #importPatterns: ImportPattern[] | null = null;

  constructor(db: CeDbLike, projectRoot: string) {
    this.#db = db;
    this.#projectRoot = projectRoot;
  }

  /** 检测项目语言族，基于 bootstrap_snapshots.primary_lang */
  #detectFamilies(): LangFamily[] {
    if (this.#families) {
      return this.#families;
    }

    const row = this.#db
      .prepare(
        `SELECT primary_lang FROM bootstrap_snapshots
         WHERE project_root = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(this.#projectRoot) as Record<string, unknown> | undefined;

    const primaryLang = row?.primary_lang as string | null;
    if (primaryLang && LANG_TO_FAMILY[primaryLang]) {
      this.#families = [LANG_TO_FAMILY[primaryLang]];
    } else {
      // 无 bootstrap 数据时回退：使用所有语言族
      this.#families = Object.keys(SUPERCLASS_BY_FAMILY) as LangFamily[];
    }

    return this.#families;
  }

  /** 构建当前项目语言族的超类合并映射 */
  #getSuperclassMap(): Record<string, ModuleRole> {
    if (this.#superclassMap) {
      return this.#superclassMap;
    }
    const merged: Record<string, ModuleRole> = {};
    for (const fam of this.#detectFamilies()) {
      Object.assign(merged, SUPERCLASS_BY_FAMILY[fam]);
    }
    this.#superclassMap = merged;
    return merged;
  }

  /** 构建当前项目语言族的协议合并映射 */
  #getProtocolMap(): Record<string, ModuleRole> {
    if (this.#protocolMap) {
      return this.#protocolMap;
    }
    const merged: Record<string, ModuleRole> = {};
    for (const fam of this.#detectFamilies()) {
      Object.assign(merged, PROTOCOL_BY_FAMILY[fam]);
    }
    this.#protocolMap = merged;
    return merged;
  }

  /** 构建当前项目语言族的 import 模式列表 */
  #getImportPatterns(): ImportPattern[] {
    if (this.#importPatterns) {
      return this.#importPatterns;
    }
    const patterns = [...UNIVERSAL_IMPORT_PATTERNS];
    for (const fam of this.#detectFamilies()) {
      patterns.push(...IMPORT_PATTERNS_BY_FAMILY[fam]);
    }
    this.#importPatterns = patterns;
    return patterns;
  }

  /**
   * 精化单个模块的角色
   */
  refineRole(module: ModuleCandidate): RefinedRole {
    const signals: RoleSignal[] = [];

    // 1. AST 结构信号 (0.30)
    signals.push(...this.#extractAstSignals(module));

    // 2. CallGraph 行为信号 (0.30)
    signals.push(...this.#extractCallSignals(module));

    // 3. DataFlow 数据流信号 (0.15)
    signals.push(...this.#extractFlowSignals(module));

    // 4. EntityGraph 拓扑信号 (0.10)
    signals.push(...this.#extractTopoSignals(module));

    // 5. 正则基线 (0.15)
    signals.push({
      role: module.inferredRole,
      confidence: 0.5,
      weight: WEIGHTS.regex,
      source: 'regex-baseline',
    });

    // 加权投票
    const roleScores: Record<string, number> = {};
    for (const signal of signals) {
      roleScores[signal.role] = (roleScores[signal.role] ?? 0) + signal.confidence * signal.weight;
    }

    const sorted = Object.entries(roleScores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      return {
        refinedRole: module.inferredRole,
        confidence: 0,
        resolution: 'fallback',
        signals,
      };
    }

    const [topRole, topScore] = sorted[0];
    const secondScore = sorted[1]?.[1] ?? 0;

    // 冲突解决
    if (topScore > 0.7) {
      return {
        refinedRole: topRole as ModuleRole,
        confidence: Math.min(topScore, 1),
        resolution: 'clear',
        signals,
      };
    }
    if (topScore - secondScore < 0.1) {
      return {
        refinedRole: topRole as ModuleRole,
        confidence: Math.min(topScore, 1),
        resolution: 'uncertain',
        alternatives: sorted.slice(0, 3) as Array<[string, number]>,
        signals,
      };
    }
    return {
      refinedRole: topRole as ModuleRole,
      confidence: Math.min(topScore, 1),
      resolution: topScore > 0.4 ? 'clear' : 'fallback',
      signals,
    };
  }

  /**
   * 批量精化所有模块
   */
  refineAll(modules: ModuleCandidate[]): Map<string, RefinedRole> {
    const result = new Map<string, RefinedRole>();
    for (const m of modules) {
      result.set(m.name, this.refineRole(m));
    }
    return result;
  }

  /* ─── Signal Extractors ──────────────────────────── */

  /** AST 结构信号: 继承链、协议、import */
  #extractAstSignals(module: ModuleCandidate): RoleSignal[] {
    const signals: RoleSignal[] = [];
    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    // 查询模块内实体的继承关系
    const placeholders = filePaths.map(() => '?').join(',');
    const entities = this.#db
      .prepare(
        `SELECT entity_id, entity_type, superclass, protocols, file_path
         FROM code_entities
         WHERE project_root = ? AND file_path IN (${placeholders})`
      )
      .all(this.#projectRoot, ...filePaths) as Array<Record<string, unknown>>;

    const roleCounts: Record<string, number> = {};
    const superclassMap = this.#getSuperclassMap();
    const protocolMap = this.#getProtocolMap();

    for (const entity of entities) {
      // 继承链推断
      const superclass = entity.superclass as string | null;
      if (superclass && superclassMap[superclass]) {
        const role = superclassMap[superclass];
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      }

      // 协议推断
      try {
        const protocols = JSON.parse((entity.protocols as string) || '[]') as string[];
        for (const proto of protocols) {
          if (protocolMap[proto]) {
            const role = protocolMap[proto];
            roleCounts[role] = (roleCounts[role] ?? 0) + 0.5;
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }

    // import 模式推断
    const imports = this.#db
      .prepare(
        `SELECT DISTINCT to_id FROM knowledge_edges
         WHERE from_type = 'module' AND from_id = ? AND relation = 'depends_on'`
      )
      .all(module.name) as Array<Record<string, unknown>>;

    for (const imp of imports) {
      const depName = (imp.to_id as string).toLowerCase();
      for (const pat of this.#getImportPatterns()) {
        if (pat.regex.test(depName)) {
          roleCounts[pat.role] = (roleCounts[pat.role] ?? 0) + 0.5;
        }
      }
    }

    // 转换为信号
    const totalSignals = Object.values(roleCounts).reduce((a, b) => a + b, 0);
    if (totalSignals > 0) {
      for (const [role, count] of Object.entries(roleCounts)) {
        signals.push({
          role: role as ModuleRole,
          confidence: Math.min(count / totalSignals, 1),
          weight: WEIGHTS.ast,
          source: 'ast-structure',
        });
      }
    }

    return signals;
  }

  /** CallGraph 行为信号: 调用流向分析 */
  #extractCallSignals(module: ModuleCandidate): RoleSignal[] {
    const signals: RoleSignal[] = [];

    // 查模块实体的 call edge 统计
    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    const placeholders = filePaths.map(() => '?').join(',');

    // fan-out: 模块内实体调用外部
    const outEdges = this.#db
      .prepare(
        `SELECT COUNT(*) as cnt FROM knowledge_edges ke
         JOIN code_entities ce ON ke.from_id = ce.entity_id AND ke.from_type = ce.entity_type
         WHERE ce.project_root = ? AND ce.file_path IN (${placeholders})
         AND ke.relation = 'calls'`
      )
      .get(this.#projectRoot, ...filePaths) as Record<string, unknown> | undefined;

    // fan-in: 外部调用模块内实体
    const inEdges = this.#db
      .prepare(
        `SELECT COUNT(*) as cnt FROM knowledge_edges ke
         JOIN code_entities ce ON ke.to_id = ce.entity_id AND ke.to_type = ce.entity_type
         WHERE ce.project_root = ? AND ce.file_path IN (${placeholders})
         AND ke.relation = 'calls'`
      )
      .get(this.#projectRoot, ...filePaths) as Record<string, unknown> | undefined;

    const fanOut = Number(outEdges?.cnt ?? 0);
    const fanIn = Number(inEdges?.cnt ?? 0);

    if (fanIn + fanOut === 0) {
      return signals;
    }

    const ratio = fanIn / (fanIn + fanOut);

    // 高被调用 → 偏 core/service (被依赖)
    // 高调用 → 偏 app/ui (消费者)
    if (ratio > 0.7) {
      signals.push({
        role: 'core',
        confidence: ratio * 0.8,
        weight: WEIGHTS.callGraph,
        source: 'call-fanin-heavy',
      });
    } else if (ratio < 0.3) {
      signals.push({
        role: 'ui',
        confidence: (1 - ratio) * 0.6,
        weight: WEIGHTS.callGraph,
        source: 'call-fanout-heavy',
      });
    } else {
      signals.push({
        role: 'service',
        confidence: 0.5,
        weight: WEIGHTS.callGraph,
        source: 'call-balanced',
      });
    }

    return signals;
  }

  /** DataFlow 数据流信号: 源/汇分析 */
  #extractFlowSignals(module: ModuleCandidate): RoleSignal[] {
    const signals: RoleSignal[] = [];
    const filePaths = module.files;
    if (filePaths.length === 0) {
      return signals;
    }

    const placeholders = filePaths.map(() => '?').join(',');

    // data_flow out (data producer)
    const outFlow = this.#db
      .prepare(
        `SELECT COUNT(*) as cnt FROM knowledge_edges ke
         JOIN code_entities ce ON ke.from_id = ce.entity_id AND ke.from_type = ce.entity_type
         WHERE ce.project_root = ? AND ce.file_path IN (${placeholders})
         AND ke.relation = 'data_flow'`
      )
      .get(this.#projectRoot, ...filePaths) as Record<string, unknown> | undefined;

    // data_flow in (data consumer)
    const inFlow = this.#db
      .prepare(
        `SELECT COUNT(*) as cnt FROM knowledge_edges ke
         JOIN code_entities ce ON ke.to_id = ce.entity_id AND ke.to_type = ce.entity_type
         WHERE ce.project_root = ? AND ce.file_path IN (${placeholders})
         AND ke.relation = 'data_flow'`
      )
      .get(this.#projectRoot, ...filePaths) as Record<string, unknown> | undefined;

    const out = Number(outFlow?.cnt ?? 0);
    const _in = Number(inFlow?.cnt ?? 0);

    if (out + _in === 0) {
      return signals;
    }

    // 大量产出数据 → model/networking
    if (out > _in * 2) {
      signals.push({
        role: 'model',
        confidence: 0.6,
        weight: WEIGHTS.dataFlow,
        source: 'dataflow-producer',
      });
    }
    // 大量消费数据 → ui
    if (_in > out * 2) {
      signals.push({
        role: 'ui',
        confidence: 0.5,
        weight: WEIGHTS.dataFlow,
        source: 'dataflow-consumer',
      });
    }

    return signals;
  }

  /** EntityGraph 拓扑信号: 入度分析/模式检测 */
  #extractTopoSignals(module: ModuleCandidate): RoleSignal[] {
    const signals: RoleSignal[] = [];

    // 查模块下是否有 singleton / delegate 等设计模式
    const patterns = this.#db
      .prepare(
        `SELECT ke.to_id as pattern_name FROM knowledge_edges ke
         JOIN code_entities ce ON ke.from_id = ce.entity_id
         WHERE ce.project_root = ? AND ke.relation = 'uses_pattern'
         AND ce.entity_id IN (
           SELECT entity_id FROM code_entities
           WHERE project_root = ? AND file_path IN (${module.files.map(() => '?').join(',')})
         )`
      )
      .all(this.#projectRoot, this.#projectRoot, ...module.files) as Array<Record<string, unknown>>;

    for (const p of patterns) {
      const name = (p.pattern_name as string | undefined)?.toLowerCase();
      if (!name) {
        continue;
      }
      if (name === 'singleton') {
        signals.push({
          role: 'service',
          confidence: 0.6,
          weight: WEIGHTS.entityGraph,
          source: 'pattern-singleton',
        });
      }
      if (name === 'delegate') {
        signals.push({
          role: 'ui',
          confidence: 0.4,
          weight: WEIGHTS.entityGraph,
          source: 'pattern-delegate',
        });
      }
    }

    return signals;
  }
}
