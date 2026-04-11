/**
 * LanguageProfiles — 全景分析多语言统一注册中心
 *
 * 设计原则:
 *   1. **语言族 (LanguageFamily)** 是核心抽象 — 同族语言共享 import 语法、框架类体系、生态库
 *   2. **单一数据源** — 新增语言只需添加一条 FamilyProfile，所有消费者自动生效
 *   3. **与 LanguageService 互补** — LanguageService 管理基础映射 (ext→lang)，
 *      LanguageProfiles 管理分析知识 (import 解析、角色推断、技术栈分类)
 *   4. **按关注点暴露 API** — 消费者调用自己需要的访问器，无需了解内部数据结构
 *
 * 消费者:
 *   - CouplingAnalyzer  → importPatterns, sourceExts
 *   - RoleRefiner        → familyOf, superclassRoles, protocolRoles, importRolePatterns
 *   - TechStackProfiler  → knownLibraries, keywordCategories
 *   - ModuleDiscoverer   → skipDirs, artifactSuffixes, vendorDirs, sourceExts
 *
 * @module LanguageProfiles
 */

import { LanguageService } from './LanguageService.js';

/* ═══ Public Types ════════════════════════════════════════ */

/** 模块在软件架构中扮演的角色 */
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

export type LanguageFamily = 'apple' | 'jvm' | 'dart' | 'python' | 'web' | 'go' | 'rust' | 'dotnet';

/** import 语句解析模式 — 用于依赖边提取 */
export interface ImportPattern {
  /** 匹配 import 语句的正则 (对 trimmed 行执行) */
  regex: RegExp;
  /** 从匹配结果提取模块名候选列表 */
  extract: (m: RegExpExecArray) => string[];
}

/** import 关键词 → 角色推断模式 */
export interface RolePattern {
  regex: RegExp;
  role: ModuleRole;
}

/* ═══ Per-Family Profile ══════════════════════════════════ */

interface FamilyProfile {
  family: LanguageFamily;
  /** 该族包含的规范语言 ID (LanguageService normalize 后的值) */
  languages: string[];

  /* ─── CouplingAnalyzer: 依赖提取 ─────────── */
  importPatterns: ImportPattern[];

  /* ─── RoleRefiner: 角色推断 ──────────────── */
  superclassRoles: Record<string, ModuleRole>;
  protocolRoles: Record<string, ModuleRole>;
  importRolePatterns: RolePattern[];

  /* ─── TechStackProfiler: 库分类 ─────────── */
  knownLibraries: Record<string, string>;

  /* ─── ModuleDiscoverer: 文件系统启发 ────── */
  artifactSuffixes: string[];
  vendorDirs: string[];
  extraSkipDirs: string[];
}

/* ═══ Family Definitions ══════════════════════════════════ */

const APPLE: FamilyProfile = {
  family: 'apple',
  languages: ['swift', 'objectivec'],
  importPatterns: [
    // #import <ModuleName/Header.h>
    { regex: /^#import\s+<([^/]+)\//, extract: (m) => [m[1]] },
    // @import ModuleName;
    { regex: /^@import\s+([A-Za-z_]\w*)(?:\.\w+)*\s*;/, extract: (m) => [m[1]] },
    // import ModuleName
    { regex: /^import\s+([A-Za-z_]\w+)\s*$/, extract: (m) => [m[1]] },
  ],
  superclassRoles: {
    UIViewController: 'ui',
    UIView: 'ui',
    UITableViewCell: 'ui',
    UICollectionViewCell: 'ui',
    UINavigationController: 'routing',
    UITabBarController: 'routing',
    UIApplication: 'app',
    NSObject: 'core',
    NSManagedObject: 'storage',
  },
  protocolRoles: {
    UITableViewDataSource: 'ui',
    UITableViewDelegate: 'ui',
    UICollectionViewDataSource: 'ui',
    UIApplicationDelegate: 'app',
    UISceneDelegate: 'app',
    UIWindowSceneDelegate: 'app',
    URLSessionDelegate: 'networking',
    Codable: 'model',
    Decodable: 'model',
    Encodable: 'model',
  },
  importRolePatterns: [
    { regex: /alamofire|urlsession|afnetworking|moya/i, role: 'networking' },
    { regex: /\buikit\b|swiftui|rx.*cocoa|snapkit|masonry/i, role: 'ui' },
    { regex: /realm|coredata|fmdb|grdb/i, role: 'storage' },
    { regex: /xctest/i, role: 'test' },
  ],
  knownLibraries: {
    afnetworking: 'Networking',
    alamofire: 'Networking',
    moya: 'Networking',
    urlsession: 'Networking',
    starscream: 'Networking',
    socketrocket: 'Networking',
    sdwebimage: 'Image',
    kingfisher: 'Image',
    nuke: 'Image',
    yyimage: 'Image',
    flanimatedimage: 'Image',
    snapkit: 'UI',
    masonry: 'UI',
    flexlayout: 'UI',
    texture: 'UI',
    asyncdisplaykit: 'UI',
    iglistkit: 'UI',
    mbprogresshud: 'UI',
    svprogresshud: 'UI',
    yytext: 'UI',
    dzzfloatingactionbutton: 'UI',
    herocard: 'UI',
    swiftui: 'UI',
    rxswift: 'Reactive',
    rxcocoa: 'Reactive',
    reactiveswift: 'Reactive',
    combine: 'Reactive',
    openombine: 'Reactive',
    promisekit: 'Reactive',
    realm: 'Storage',
    coredata: 'Storage',
    fmdb: 'Storage',
    grdb: 'Storage',
    wcdb: 'Storage',
    mmkv: 'Storage',
    userdefaults: 'Storage',
    yymodel: 'Serialization',
    objectmapper: 'Serialization',
    codable: 'Serialization',
    swiftyjson: 'Serialization',
    mantle: 'Serialization',
    handyjson: 'Serialization',
    mjextension: 'Serialization',
    cocoalumberjack: 'Logging',
    swiftybeaver: 'Logging',
    oslog: 'Logging',
    urlnavigator: 'Routing',
    deeplink: 'Routing',
    ctmediator: 'Routing',
    quick: 'Testing',
    nimble: 'Testing',
    xctest: 'Testing',
    ocmock: 'Testing',
    ohhttpstubs: 'Testing',
    cryptoswift: 'Security',
    keychain: 'Security',
    keychainaccess: 'Security',
    commoncrypto: 'Security',
    swinject: 'Architecture',
    needle: 'Architecture',
    swiftlint: 'Tooling',
    r_swift: 'Tooling',
    swiftgen: 'Tooling',
    cocoapods: 'Tooling',
  },
  artifactSuffixes: [
    '.xcassets',
    '.bundle',
    '.lproj',
    '.framework',
    '.xcdatamodeld',
    '.xcodeproj',
    '.xcworkspace',
    '.storyboard',
    '.xib',
    '.playground',
  ],
  vendorDirs: ['Pods', 'Carthage'],
  extraSkipDirs: ['.build', '.swiftpm', 'DerivedData'],
};

const JVM: FamilyProfile = {
  family: 'jvm',
  languages: ['java', 'kotlin'],
  importPatterns: [
    // import com.example.auth.Class → 返回所有包段作为候选
    {
      regex: /^import\s+(?:static\s+)?([\w.]+)/,
      extract: (m) => {
        const SKIP = new Set(['java', 'javax', 'android', 'androidx', 'kotlin', 'kotlinx']);
        return m[1]
          .split('.')
          .filter((s) => !SKIP.has(s) && s[0] === s[0].toLowerCase() && s.length > 1);
      },
    },
  ],
  superclassRoles: {
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
  protocolRoles: {
    Serializable: 'model',
    Parcelable: 'model',
    Runnable: 'core',
    Callable: 'core',
    OnClickListener: 'ui',
    Adapter: 'ui',
    Repository: 'storage',
  },
  importRolePatterns: [
    { regex: /retrofit|okhttp|volley/i, role: 'networking' },
    { regex: /android\.widget|jetpack.*compose|recyclerview/i, role: 'ui' },
    { regex: /room|hibernate|greendao/i, role: 'storage' },
    { regex: /junit|espresso|mockito/i, role: 'test' },
  ],
  knownLibraries: {
    retrofit: 'Networking',
    okhttp: 'Networking',
    volley: 'Networking',
    glide: 'Image',
    picasso: 'Image',
    coil: 'Image',
    compose: 'UI',
    rxjava: 'Reactive',
    rxkotlin: 'Reactive',
    room: 'Storage',
    hibernate: 'Storage',
    greendao: 'Storage',
    gson: 'Serialization',
    moshi: 'Serialization',
    jackson: 'Serialization',
    timber: 'Logging',
    logback: 'Logging',
    log4j: 'Logging',
    arouter: 'Routing',
    junit: 'Testing',
    espresso: 'Testing',
    mockito: 'Testing',
    hilt: 'Architecture',
    dagger: 'Architecture',
    spring: 'Framework',
    springboot: 'Framework',
  },
  artifactSuffixes: ['.apk', '.aar', '.jar', '.war'],
  vendorDirs: ['res', 'gen'],
  extraSkipDirs: ['.gradle', '.idea', 'target'],
};

const DART: FamilyProfile = {
  family: 'dart',
  languages: ['dart'],
  importPatterns: [
    // import 'package:module/file.dart'
    {
      regex: /^import\s+['"]package:([^/'"]+)/,
      extract: (m) => [m[1]],
    },
  ],
  superclassRoles: {
    StatefulWidget: 'ui',
    StatelessWidget: 'ui',
    State: 'ui',
    ChangeNotifier: 'service',
    Cubit: 'service',
    Bloc: 'service',
  },
  protocolRoles: {
    Widget: 'ui',
  },
  importRolePatterns: [
    { regex: /\bdio\b|http_client/i, role: 'networking' },
    { regex: /flutter|cupertino|material/i, role: 'ui' },
    { regex: /sqflite|hive|objectbox/i, role: 'storage' },
    { regex: /flutter_test/i, role: 'test' },
  ],
  knownLibraries: {
    dio: 'Networking',
    flutter: 'UI',
    rxdart: 'Reactive',
  },
  artifactSuffixes: [],
  vendorDirs: [],
  extraSkipDirs: ['.dart_tool', '.fvm'],
};

const PYTHON: FamilyProfile = {
  family: 'python',
  languages: ['python'],
  importPatterns: [
    // from module import ... / import module
    { regex: /^(?:from|import)\s+([A-Za-z_]\w*)/, extract: (m) => [m[1]] },
  ],
  superclassRoles: {
    BaseModel: 'model',
    Model: 'model',
    APIView: 'service',
    ViewSet: 'service',
    TestCase: 'test',
  },
  protocolRoles: {},
  importRolePatterns: [
    { regex: /requests|aiohttp|httpx|urllib/i, role: 'networking' },
    { regex: /tkinter|pyqt|kivy/i, role: 'ui' },
    { regex: /sqlalchemy|django\.db|peewee|tortoise/i, role: 'storage' },
    { regex: /pytest|unittest/i, role: 'test' },
  ],
  knownLibraries: {
    requests: 'Networking',
    aiohttp: 'Networking',
    httpx: 'Networking',
    pillow: 'Image',
    sqlalchemy: 'Storage',
    django: 'Framework',
    flask: 'Framework',
    fastapi: 'Framework',
    pytest: 'Testing',
    asyncio: 'Async',
  },
  artifactSuffixes: [],
  vendorDirs: [],
  extraSkipDirs: ['__pycache__', 'venv', '.venv', '.tox'],
};

const WEB: FamilyProfile = {
  family: 'web',
  languages: ['javascript', 'typescript'],
  importPatterns: [
    // import ... from 'module'
    {
      regex: /^import\s+.*?from\s+['"]([^./'"@][^'"]*?)['"]/,
      extract: (m) => [m[1].split('/')[0]],
    },
    // import 'module'
    { regex: /^import\s+['"]([^./'"@][^'"]*?)['"]/, extract: (m) => [m[1].split('/')[0]] },
    // require('module')
    { regex: /require\(\s*['"]([^./'"@][^'"]*?)['"]\s*\)/, extract: (m) => [m[1].split('/')[0]] },
  ],
  superclassRoles: {
    Component: 'ui',
    Controller: 'service',
    Module: 'app',
  },
  protocolRoles: {
    OnInit: 'ui',
    OnDestroy: 'ui',
    CanActivate: 'routing',
    NestMiddleware: 'service',
  },
  importRolePatterns: [
    { regex: /axios|fetch|got|superagent/i, role: 'networking' },
    { regex: /react|angular|vue|svelte|next|nuxt/i, role: 'ui' },
    { regex: /typeorm|prisma|sequelize|mongoose|knex/i, role: 'storage' },
    { regex: /jest|mocha|vitest|cypress|playwright/i, role: 'test' },
    { regex: /express|fastify|nestjs|koa/i, role: 'routing' },
  ],
  knownLibraries: {
    axios: 'Networking',
    got: 'Networking',
    superagent: 'Networking',
    sharp: 'Image',
    react: 'UI',
    angular: 'UI',
    vue: 'UI',
    svelte: 'UI',
    tailwindcss: 'UI',
    bootstrap: 'UI',
    rxjs: 'Reactive',
    typeorm: 'Storage',
    prisma: 'Storage',
    sequelize: 'Storage',
    mongoose: 'Storage',
    knex: 'Storage',
    express: 'Framework',
    fastify: 'Framework',
    nestjs: 'Framework',
    koa: 'Framework',
    nextjs: 'Framework',
    nuxt: 'Framework',
    jest: 'Testing',
    mocha: 'Testing',
    vitest: 'Testing',
    cypress: 'Testing',
    playwright: 'Testing',
    jsonwebtoken: 'Security',
    passport: 'Security',
    bcrypt: 'Security',
    inversify: 'Architecture',
    tsyringe: 'Architecture',
    eslint: 'Tooling',
    prettier: 'Tooling',
    webpack: 'Tooling',
    vite: 'Tooling',
    winston: 'Logging',
    pino: 'Logging',
  },
  artifactSuffixes: [],
  vendorDirs: [],
  extraSkipDirs: ['node_modules', '.next', '.nuxt', 'dist', 'out', 'coverage'],
};

const GO: FamilyProfile = {
  family: 'go',
  languages: ['go'],
  importPatterns: [
    // import "path/module" or import alias "path/module"
    {
      regex: /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"/,
      extract: (m) => {
        const parts = m[1].split('/');
        return parts.length > 1 ? [parts[parts.length - 1], parts[parts.length - 2]] : [parts[0]];
      },
    },
  ],
  superclassRoles: {},
  protocolRoles: {
    Handler: 'service',
    ReadWriter: 'core',
    Reader: 'core',
    Writer: 'core',
    Stringer: 'utility',
  },
  importRolePatterns: [
    { regex: /net\/http|resty/i, role: 'networking' },
    { regex: /gin|echo|fiber|mux|chi/i, role: 'routing' },
    { regex: /gorm|sqlx|ent/i, role: 'storage' },
    { regex: /testing/i, role: 'test' },
  ],
  knownLibraries: {
    gin: 'Framework',
    echo: 'Framework',
    fiber: 'Framework',
    gorm: 'Storage',
  },
  artifactSuffixes: [],
  vendorDirs: ['vendor'],
  extraSkipDirs: [],
};

const RUST: FamilyProfile = {
  family: 'rust',
  languages: ['rust'],
  importPatterns: [
    // use crate_name::sub
    { regex: /^use\s+([a-z_]\w*)::/, extract: (m) => [m[1]] },
    // extern crate name
    { regex: /^extern\s+crate\s+([a-z_]\w*)/, extract: (m) => [m[1]] },
  ],
  superclassRoles: {},
  protocolRoles: {
    Display: 'utility',
    Debug: 'utility',
    Serialize: 'model',
    Deserialize: 'model',
    Future: 'core',
    Stream: 'core',
    Service: 'service',
  },
  importRolePatterns: [
    { regex: /reqwest|hyper|surf/i, role: 'networking' },
    { regex: /actix|axum|warp|rocket/i, role: 'routing' },
    { regex: /diesel|sqlx|sea-orm/i, role: 'storage' },
    { regex: /tokio-test/i, role: 'test' },
  ],
  knownLibraries: {
    reqwest: 'Networking',
    hyper: 'Networking',
    actix: 'Framework',
    axum: 'Framework',
    rocket: 'Framework',
    diesel: 'Storage',
    sqlx: 'Storage',
    serde: 'Serialization',
    tokio: 'Async',
    tracing: 'Logging',
  },
  artifactSuffixes: [],
  vendorDirs: [],
  extraSkipDirs: ['target'],
};

const DOTNET: FamilyProfile = {
  family: 'dotnet',
  languages: ['csharp'],
  importPatterns: [
    // using Namespace.Sub
    { regex: /^using\s+(?:static\s+)?([A-Z]\w*)\./, extract: (m) => [m[1]] },
  ],
  superclassRoles: {
    Controller: 'service',
    ControllerBase: 'service',
    DbContext: 'storage',
    Page: 'ui',
  },
  protocolRoles: {
    IDisposable: 'core',
    IEnumerable: 'core',
    IHostedService: 'service',
  },
  importRolePatterns: [
    { regex: /HttpClient|RestSharp/i, role: 'networking' },
    { regex: /EntityFramework|Dapper/i, role: 'storage' },
    { regex: /xUnit|NUnit|MSTest/i, role: 'test' },
  ],
  knownLibraries: {},
  artifactSuffixes: ['.dll', '.exe', '.nupkg'],
  vendorDirs: [],
  extraSkipDirs: ['bin', 'obj'],
};

/* ═══ Cross-cutting (language-neutral) ════════════════════ */

/** C / C++ 共用 import 模式 — 不属于任何特定生态族 */
const C_CPP_IMPORT_PATTERNS: ImportPattern[] = [
  { regex: /^#include\s+<([^/]+)\//, extract: (m) => [m[1]] },
];

/** 通用 import → 角色推断（任何语言适用） */
const UNIVERSAL_ROLE_PATTERNS: RolePattern[] = [
  { regex: /network/i, role: 'networking' },
  { regex: /sqlite/i, role: 'storage' },
  { regex: /router|routing|navigation/i, role: 'routing' },
];

/** 跨平台知名库（不属于单一生态） */
const CROSS_PLATFORM_LIBRARIES: Record<string, string> = {
  grpc: 'Networking',
  protobuf: 'Serialization',
  sqlite: 'Storage',
  redis: 'Storage',
  lottie: 'UI',
  yoga: 'UI',
  sentry: 'Diagnostics',
  firebase: 'Diagnostics',
  crashlytics: 'Diagnostics',
  bugly: 'Diagnostics',
};

/** 关键词 → 分类的启发式映射 (KNOWN_LIBRARIES 未命中时的 fallback) */
const KEYWORD_CATEGORIES: ReadonlyArray<[RegExp, string]> = [
  [/net(work)?|http|api|url|request|socket|grpc/i, 'Networking'],
  [/image|photo|picture|avatar|thumbnail/i, 'Image'],
  [/ui|view|layout|widget|button|label|cell|collection|table/i, 'UI'],
  [/anim(at)?|lottie|transition|motion/i, 'Animation'],
  [/rx|reactive|combine|signal|observable|promise/i, 'Reactive'],
  [/db|database|sql|realm|store|cache|storage|persist/i, 'Storage'],
  [/json|model|mapper|serial|codable|parse|decode/i, 'Serialization'],
  [/log|debug|trace|monitor|crash|sentry|bugly|diagnostic/i, 'Diagnostics'],
  [/route|router|navigation|deeplink|scheme|mediator/i, 'Routing'],
  [/test|mock|stub|spec|expect|assert/i, 'Testing'],
  [/crypto|encrypt|security|keychain|auth|token|oauth/i, 'Security'],
  [/player|video|audio|media|av|stream/i, 'Media'],
  [/map|location|geo|coordinate|clocation/i, 'Location'],
  [/pay|purchase|billing|iap/i, 'Payment'],
  [/push|notification|apns|message/i, 'Messaging'],
  [/analytics|track|event|statistics/i, 'Analytics'],
  [/ad|banner|interstitial|reward/i, 'Advertising'],
];

/** 第三方 / vendor 目录 (跨平台通用) */
const COMMON_VENDOR_DIRS: ReadonlyArray<string> = [
  '3rd',
  'third_party',
  'thirdparty',
  'vendor',
  'vendors',
  'external',
  'libs',
  'assets',
  'resources',
  'migrations',
  'fixtures',
];

/* ═══ Registry ════════════════════════════════════════════ */

const ALL_FAMILIES: readonly FamilyProfile[] = [APPLE, JVM, DART, PYTHON, WEB, GO, RUST, DOTNET];

/** langId → family 查找表 (运行时构建) */
const LANG_TO_FAMILY_MAP = new Map<string, LanguageFamily>();
for (const fp of ALL_FAMILIES) {
  for (const lang of fp.languages) {
    LANG_TO_FAMILY_MAP.set(lang, fp.family);
  }
}
// 常见别名也注册（normalize 后可能仍用到原始值）
const ALIASES: Record<string, string> = {
  'objective-c': 'objectivec',
  objc: 'objectivec',
  scala: 'java',
  groovy: 'java',
  clojure: 'java',
  jsx: 'javascript',
  tsx: 'typescript',
  'c#': 'csharp',
  golang: 'go',
};
for (const [alias, canonical] of Object.entries(ALIASES)) {
  const fam = LANG_TO_FAMILY_MAP.get(canonical);
  if (fam) {
    LANG_TO_FAMILY_MAP.set(alias, fam);
  }
}

/** family → profile 快速查找 */
const FAMILY_MAP = new Map<LanguageFamily, FamilyProfile>();
for (const fp of ALL_FAMILIES) {
  FAMILY_MAP.set(fp.family, fp);
}

/* ═══ Merged caches (lazy) ════════════════════════════════ */

let _importPatterns: ImportPattern[] | null = null;
let _knownLibraries: Record<string, string> | null = null;
let _skipDirs: Set<string> | null = null;
let _artifactSuffixes: string[] | null = null;
let _vendorDirs: Set<string> | null = null;
let _thirdPartyPathRegex: RegExp | null = null;

/* ═══ LanguageProfiles — Static API ═══════════════════════ */

export class LanguageProfiles {
  /* ─── Family Resolution ─────────────────────── */

  /** 将规范化语言 ID 映射到语言族 */
  static familyOf(langId: string): LanguageFamily | undefined {
    const normalized = LanguageService.normalize(langId);
    return LANG_TO_FAMILY_MAP.get(normalized) ?? LANG_TO_FAMILY_MAP.get(langId.toLowerCase());
  }

  /** 返回所有已注册的语言族 ID */
  static allFamilies(): LanguageFamily[] {
    return ALL_FAMILIES.map((fp) => fp.family);
  }

  /** 根据主语言解析项目涉及的语言族 */
  static resolveFamilies(primaryLang: string | null): LanguageFamily[] {
    if (!primaryLang) {
      return ALL_FAMILIES.map((fp) => fp.family);
    }
    const fam = LanguageProfiles.familyOf(primaryLang);
    return fam ? [fam] : ALL_FAMILIES.map((fp) => fp.family);
  }

  /* ─── CouplingAnalyzer: Import Extraction ───── */

  /**
   * 获取所有 import 解析模式 (合并全部语言族 + C/C++)
   *
   * CouplingAnalyzer 对每行代码尝试所有模式，
   * 按「特异性递减」排列：最特殊的模式在前。
   */
  static get importPatterns(): readonly ImportPattern[] {
    if (!_importPatterns) {
      _importPatterns = [];
      for (const fp of ALL_FAMILIES) {
        _importPatterns.push(...fp.importPatterns);
      }
      _importPatterns.push(...C_CPP_IMPORT_PATTERNS);
    }
    return _importPatterns;
  }

  /**
   * 源代码文件扩展名集合 — 委托 LanguageService
   *
   * 消除 CouplingAnalyzer / ModuleDiscoverer 自建 SOURCE_EXTS 的重复。
   */
  static get sourceExts(): ReadonlySet<string> {
    return LanguageService.sourceExts;
  }

  /* ─── RoleRefiner: Role Inference ───────────── */

  /**
   * 合并指定语言族的超类→角色映射
   * @param families 项目检测到的语言族
   */
  static superclassRoles(families: LanguageFamily[]): Record<string, ModuleRole> {
    const merged: Record<string, ModuleRole> = {};
    for (const fam of families) {
      const fp = FAMILY_MAP.get(fam);
      if (fp) {
        Object.assign(merged, fp.superclassRoles);
      }
    }
    return merged;
  }

  /**
   * 合并指定语言族的协议/接口→角色映射
   * @param families 项目检测到的语言族
   */
  static protocolRoles(families: LanguageFamily[]): Record<string, ModuleRole> {
    const merged: Record<string, ModuleRole> = {};
    for (const fam of families) {
      const fp = FAMILY_MAP.get(fam);
      if (fp) {
        Object.assign(merged, fp.protocolRoles);
      }
    }
    return merged;
  }

  /**
   * 合并指定语言族的 import→角色模式 + 通用模式
   * @param families 项目检测到的语言族
   */
  static importRolePatterns(families: LanguageFamily[]): RolePattern[] {
    const patterns: RolePattern[] = [];
    for (const fam of families) {
      const fp = FAMILY_MAP.get(fam);
      if (fp) {
        patterns.push(...fp.importRolePatterns);
      }
    }
    patterns.push(...UNIVERSAL_ROLE_PATTERNS);
    return patterns;
  }

  /* ─── TechStackProfiler: Library Classification ── */

  /**
   * 获取全量已知库→分类映射 (合并所有族 + 跨平台库)
   *
   * TechStackProfiler 不按族过滤 — 外部依赖可能跨生态
   */
  static get knownLibraries(): Readonly<Record<string, string>> {
    if (!_knownLibraries) {
      _knownLibraries = {};
      for (const fp of ALL_FAMILIES) {
        Object.assign(_knownLibraries, fp.knownLibraries);
      }
      Object.assign(_knownLibraries, CROSS_PLATFORM_LIBRARIES);
    }
    return _knownLibraries;
  }

  /** 关键词启发式分类 — KNOWN_LIBRARIES 未命中时的 fallback */
  static get keywordCategories(): ReadonlyArray<[RegExp, string]> {
    return KEYWORD_CATEGORIES;
  }

  /* ─── ModuleDiscoverer: Filesystem Heuristics ── */

  /**
   * 应跳过的目录名集合 (合并 LanguageService.scanSkipDirs + 各族额外目录)
   */
  static get skipDirs(): ReadonlySet<string> {
    if (!_skipDirs) {
      _skipDirs = new Set(LanguageService.scanSkipDirs);
      for (const fp of ALL_FAMILIES) {
        for (const d of fp.extraSkipDirs) {
          _skipDirs.add(d);
        }
      }
      // panorama 特有的跳过目录
      _skipDirs.add('.autosnippet');
    }
    return _skipDirs;
  }

  /** 构建产物后缀 (合并全部族) */
  static get artifactSuffixes(): readonly string[] {
    if (!_artifactSuffixes) {
      const set = new Set<string>();
      for (const fp of ALL_FAMILIES) {
        for (const s of fp.artifactSuffixes) {
          set.add(s);
        }
      }
      _artifactSuffixes = [...set];
    }
    return _artifactSuffixes;
  }

  /** Vendor / 第三方目录名集合 (合并通用 + 各族) */
  static get vendorDirs(): ReadonlySet<string> {
    if (!_vendorDirs) {
      _vendorDirs = new Set(COMMON_VENDOR_DIRS);
      for (const fp of ALL_FAMILIES) {
        for (const d of fp.vendorDirs) {
          _vendorDirs.add(d);
        }
      }
    }
    return _vendorDirs;
  }

  /* ─── Cross-cutting: Third-party Path Detection ──── */

  /**
   * 三方库路径正则 — 匹配路径中的 vendor 目录名或已知库名
   *
   * 组成:
   *   1. vendorDirs + 常见 skip 目录 (Pods, Carthage, DerivedData, …)
   *   2. knownLibraries 中所有库名 (首字母大写形式)
   *
   * 用于 Agent 工具层对搜索结果做三方库过滤。
   */
  static get thirdPartyPathRegex(): RegExp {
    if (!_thirdPartyPathRegex) {
      // 1. 目录名部分
      const dirNames = new Set<string>([
        ...LanguageProfiles.vendorDirs,
        // 额外常见三方/构建产物目录
        'Pods',
        'Carthage',
        '.build/checkouts',
        'DerivedData',
        'Submodules',
        'ThirdParty',
        'include',
        'node_modules',
        'build',
      ]);
      const dirPart = [...dirNames].map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

      // 2. 知名库名部分 — 从 knownLibraries 提取，还原首字母大写
      const libKeys = Object.keys(LanguageProfiles.knownLibraries);
      // 取原始 casing：capitalize 首字母
      const libNames = new Set<string>();
      for (const key of libKeys) {
        if (key.length >= 3) {
          libNames.add(key.charAt(0).toUpperCase() + key.slice(1));
        }
      }
      const libPart = [...libNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

      _thirdPartyPathRegex = new RegExp(`(?:^|/)(?:${dirPart})/|(?:^/)(?:${libPart})/`, 'i');
    }
    return _thirdPartyPathRegex;
  }
}
