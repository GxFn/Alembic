import { EngineeringLanguageService } from "./service.js";

export type EngineeringModuleRole =
  | "app"
  | "auth"
  | "config"
  | "core"
  | "feature"
  | "model"
  | "networking"
  | "routing"
  | "service"
  | "storage"
  | "test"
  | "ui"
  | "utility";

export type EngineeringLanguageFamily =
  | "apple"
  | "dart"
  | "dotnet"
  | "go"
  | "jvm"
  | "python"
  | "rust"
  | "web";

export interface EngineeringImportPattern {
  readonly regex: RegExp;
  extract(match: RegExpExecArray): readonly string[];
}

export interface EngineeringRolePattern {
  readonly regex: RegExp;
  readonly role: EngineeringModuleRole;
}

interface EngineeringFamilyProfile {
  readonly family: EngineeringLanguageFamily;
  readonly languages: readonly string[];
  readonly importPatterns: readonly EngineeringImportPattern[];
  readonly superclassRoles: Readonly<Record<string, EngineeringModuleRole>>;
  readonly protocolRoles: Readonly<Record<string, EngineeringModuleRole>>;
  readonly importRolePatterns: readonly EngineeringRolePattern[];
  readonly knownLibraries: Readonly<Record<string, string>>;
  readonly artifactSuffixes: readonly string[];
  readonly vendorDirs: readonly string[];
  readonly extraSkipDirs: readonly string[];
}

const FAMILY_PROFILES = [
  {
    family: "apple",
    languages: ["swift", "objectivec"],
    importPatterns: [
      { regex: /^#import\s+<([^/]+)\//, extract: (match) => [capture(match, 1)] },
      { regex: /^@import\s+([A-Za-z_]\w*)(?:\.\w+)*\s*;/, extract: (match) => [capture(match, 1)] },
      { regex: /^import\s+([A-Za-z_]\w+)\s*$/, extract: (match) => [capture(match, 1)] },
    ],
    superclassRoles: {
      NSObject: "core",
      NSManagedObject: "storage",
      UIApplication: "app",
      UICollectionViewCell: "ui",
      UINavigationController: "routing",
      UITableViewCell: "ui",
      UITabBarController: "routing",
      UIView: "ui",
      UIViewController: "ui",
    },
    protocolRoles: {
      Codable: "model",
      Decodable: "model",
      Encodable: "model",
      UIApplicationDelegate: "app",
      UICollectionViewDataSource: "ui",
      UISceneDelegate: "app",
      UITableViewDataSource: "ui",
      UITableViewDelegate: "ui",
      URLSessionDelegate: "networking",
      UIWindowSceneDelegate: "app",
    },
    importRolePatterns: [
      { regex: /alamofire|urlsession|afnetworking|moya/i, role: "networking" },
      { regex: /\buikit\b|swiftui|rx.*cocoa|snapkit|masonry/i, role: "ui" },
      { regex: /realm|coredata|fmdb|grdb/i, role: "storage" },
      { regex: /xctest/i, role: "test" },
    ],
    knownLibraries: {
      afnetworking: "Networking",
      alamofire: "Networking",
      coredata: "Storage",
      masonry: "UI",
      moya: "Networking",
      realm: "Storage",
      snapkit: "UI",
      swiftui: "UI",
      uikit: "UI",
    },
    artifactSuffixes: [".xcodeproj", ".xcworkspace", ".framework"],
    vendorDirs: ["Pods", "Carthage"],
    extraSkipDirs: [".build", ".swiftpm", "DerivedData"],
  },
  {
    family: "web",
    languages: ["javascript", "typescript"],
    importPatterns: [
      { regex: /^import\s+.*?from\s+['"]([^./'"@][^'"]*?)['"]/, extract: packageRoot },
      { regex: /^import\s+['"]([^./'"@][^'"]*?)['"]/, extract: packageRoot },
      { regex: /require\(\s*['"]([^./'"@][^'"]*?)['"]\s*\)/, extract: packageRoot },
    ],
    superclassRoles: {
      Component: "ui",
      Controller: "service",
      Module: "app",
      PureComponent: "ui",
    },
    protocolRoles: {
      CanActivate: "routing",
      NestMiddleware: "service",
      OnDestroy: "ui",
      OnInit: "ui",
    },
    importRolePatterns: [
      { regex: /axios|fetch|got|superagent/i, role: "networking" },
      { regex: /react|angular|vue|svelte|next|nuxt/i, role: "ui" },
      { regex: /typeorm|prisma|sequelize|mongoose|knex/i, role: "storage" },
      { regex: /jest|mocha|vitest|cypress|playwright/i, role: "test" },
      { regex: /express|fastify|nestjs|koa/i, role: "routing" },
    ],
    knownLibraries: {
      angular: "UI",
      axios: "Networking",
      cypress: "Testing",
      express: "Server",
      fastify: "Server",
      jest: "Testing",
      next: "UI",
      playwright: "Testing",
      prisma: "Storage",
      react: "UI",
      sequelize: "Storage",
      svelte: "UI",
      typeorm: "Storage",
      vue: "UI",
    },
    artifactSuffixes: ["package.json", "vite.config.ts", "next.config.js"],
    vendorDirs: ["node_modules"],
    extraSkipDirs: ["dist", "out", ".next", ".turbo"],
  },
  {
    family: "python",
    languages: ["python"],
    importPatterns: [
      { regex: /^(?:from|import)\s+([A-Za-z_]\w*)/, extract: (match) => [capture(match, 1)] },
    ],
    superclassRoles: {
      APIView: "service",
      BaseModel: "model",
      Model: "model",
      TestCase: "test",
      ViewSet: "service",
    },
    protocolRoles: {},
    importRolePatterns: [
      { regex: /requests|aiohttp|httpx|urllib/i, role: "networking" },
      { regex: /sqlalchemy|django\.db|peewee|tortoise/i, role: "storage" },
      { regex: /pytest|unittest/i, role: "test" },
    ],
    knownLibraries: {
      django: "Server",
      fastapi: "Server",
      httpx: "Networking",
      pytest: "Testing",
      requests: "Networking",
      sqlalchemy: "Storage",
    },
    artifactSuffixes: ["pyproject.toml", "requirements.txt", "setup.py"],
    vendorDirs: [".venv", "venv"],
    extraSkipDirs: ["__pycache__", ".pytest_cache"],
  },
  {
    family: "jvm",
    languages: ["java", "kotlin"],
    importPatterns: [
      {
        regex: /^import\s+(?:static\s+)?([\w.]+)/,
        extract: (match) =>
          capture(match, 1)
            .split(".")
            .filter(
              (segment) =>
                !["android", "androidx", "java", "javax", "kotlin", "kotlinx"].includes(segment),
            ),
      },
    ],
    superclassRoles: {
      Activity: "ui",
      AndroidViewModel: "ui",
      Application: "app",
      AppCompatActivity: "ui",
      BroadcastReceiver: "service",
      ContentProvider: "storage",
      Fragment: "ui",
      IntentService: "service",
      Service: "service",
      View: "ui",
      ViewModel: "ui",
    },
    protocolRoles: {
      Adapter: "ui",
      Callable: "core",
      OnClickListener: "ui",
      Parcelable: "model",
      Repository: "storage",
      Runnable: "core",
      Serializable: "model",
    },
    importRolePatterns: [
      { regex: /retrofit|okhttp|volley/i, role: "networking" },
      { regex: /android\.widget|compose|recyclerview/i, role: "ui" },
      { regex: /room|hibernate|greendao/i, role: "storage" },
      { regex: /junit|espresso|mockito/i, role: "test" },
    ],
    knownLibraries: {
      espresso: "Testing",
      hibernate: "Storage",
      junit: "Testing",
      okhttp: "Networking",
      retrofit: "Networking",
      room: "Storage",
    },
    artifactSuffixes: ["pom.xml", "build.gradle", "build.gradle.kts"],
    vendorDirs: [".gradle"],
    extraSkipDirs: [".gradle", "build"],
  },
  {
    family: "dart",
    languages: ["dart"],
    importPatterns: [
      { regex: /^import\s+['"]package:([^/'"]+)/, extract: (match) => [capture(match, 1)] },
    ],
    superclassRoles: {
      Bloc: "service",
      ChangeNotifier: "service",
      Cubit: "service",
      State: "ui",
      StatefulWidget: "ui",
      StatelessWidget: "ui",
    },
    protocolRoles: { Widget: "ui" },
    importRolePatterns: [
      { regex: /\bdio\b|http_client/i, role: "networking" },
      { regex: /flutter|cupertino|material/i, role: "ui" },
      { regex: /sqflite|hive|objectbox/i, role: "storage" },
      { regex: /flutter_test/i, role: "test" },
    ],
    knownLibraries: { dio: "Networking", flutter: "UI", hive: "Storage" },
    artifactSuffixes: ["pubspec.yaml", "melos.yaml"],
    vendorDirs: [],
    extraSkipDirs: [".dart_tool", ".fvm"],
  },
  {
    family: "go",
    languages: ["go"],
    importPatterns: [
      {
        regex: /^import\s+["`]([^"`]+)["`]/,
        extract: (match) => [capture(match, 1).split("/")[0] ?? ""],
      },
    ],
    superclassRoles: {},
    protocolRoles: {},
    importRolePatterns: [
      { regex: /gin|echo|fiber|grpc/i, role: "routing" },
      { regex: /gorm|sqlx|database/i, role: "storage" },
      { regex: /testing|testify/i, role: "test" },
    ],
    knownLibraries: {
      echo: "Server",
      fiber: "Server",
      gin: "Server",
      gorm: "Storage",
      grpc: "RPC",
    },
    artifactSuffixes: ["go.mod"],
    vendorDirs: ["vendor"],
    extraSkipDirs: [],
  },
  {
    family: "rust",
    languages: ["rust"],
    importPatterns: [{ regex: /^use\s+([a-zA-Z_]\w*)::/, extract: (match) => [capture(match, 1)] }],
    superclassRoles: {},
    protocolRoles: { Future: "service", Serialize: "model" },
    importRolePatterns: [
      { regex: /tokio|actix|axum|rocket/i, role: "service" },
      { regex: /serde|sqlx|diesel/i, role: "storage" },
      { regex: /criterion/i, role: "test" },
    ],
    knownLibraries: {
      actix: "Server",
      axum: "Server",
      diesel: "Storage",
      serde: "Serialization",
      tokio: "Runtime",
    },
    artifactSuffixes: ["Cargo.toml"],
    vendorDirs: ["target"],
    extraSkipDirs: ["target", ".cargo"],
  },
  {
    family: "dotnet",
    languages: ["csharp"],
    importPatterns: [
      { regex: /^using\s+([\w.]+);/, extract: (match) => [capture(match, 1).split(".")[0] ?? ""] },
    ],
    superclassRoles: { Controller: "service", DbContext: "storage", PageModel: "ui" },
    protocolRoles: {},
    importRolePatterns: [
      { regex: /entityframework|dapper/i, role: "storage" },
      { regex: /aspnetcore|mvc/i, role: "routing" },
      { regex: /xunit|nunit|mstest/i, role: "test" },
    ],
    knownLibraries: {
      aspnetcore: "Server",
      dapper: "Storage",
      entityframework: "Storage",
      xunit: "Testing",
    },
    artifactSuffixes: [".csproj", ".sln"],
    vendorDirs: ["bin", "obj"],
    extraSkipDirs: ["bin", "obj"],
  },
] as const satisfies readonly EngineeringFamilyProfile[];

const FAMILY_BY_ID: ReadonlyMap<EngineeringLanguageFamily, EngineeringFamilyProfile> = new Map(
  FAMILY_PROFILES.map((profile) => [profile.family, profile]),
);
const FAMILY_BY_LANGUAGE: ReadonlyMap<string, EngineeringLanguageFamily> = new Map(
  FAMILY_PROFILES.flatMap((profile) =>
    profile.languages.map((language) => [language, profile.family] as const),
  ),
);

const CONFIG_LAYER_TO_ROLE: Readonly<Record<string, EngineeringModuleRole>> = {
  accessories: "feature",
  accessory: "feature",
  app: "app",
  application: "app",
  basic: "core",
  basics: "core",
  component: "feature",
  components: "feature",
  core: "core",
  foundation: "core",
  model: "model",
  network: "networking",
  networking: "networking",
  service: "service",
  services: "service",
  storage: "storage",
  test: "test",
  tests: "test",
  ui: "ui",
  underlays: "feature",
  vendor: "utility",
  vendors: "utility",
};

const UNIVERSAL_ROLE_PATTERNS: readonly EngineeringRolePattern[] = [
  { regex: /auth|oauth|jwt|login/i, role: "auth" },
  { regex: /config|settings|environment/i, role: "config" },
  { regex: /router|route|navigation/i, role: "routing" },
];

const COMMON_VENDOR_DIRS = ["vendor", "third_party", "ThirdParty", "Submodules"];

/**
 * EngineeringLanguageProfiles 是 legacy LanguageProfiles 在新 lib/engineering 底层的主动归位。
 * 中文说明：上层 Panorama、ModuleDiscoverer、TechStack 不再自己维护语言族常量。
 */
export class EngineeringLanguageProfiles {
  static allFamilies(): EngineeringLanguageFamily[] {
    return FAMILY_PROFILES.map((profile) => profile.family);
  }

  static familyOf(langId: string): EngineeringLanguageFamily | undefined {
    return FAMILY_BY_LANGUAGE.get(EngineeringLanguageService.normalize(langId));
  }

  static resolveFamilies(primaryLang: string | null | undefined): EngineeringLanguageFamily[] {
    if (!primaryLang) {
      return EngineeringLanguageProfiles.allFamilies();
    }
    const family = EngineeringLanguageProfiles.familyOf(primaryLang);
    return family ? [family] : EngineeringLanguageProfiles.allFamilies();
  }

  static resolveFamiliesForLanguages(languages: readonly string[]): EngineeringLanguageFamily[] {
    const families = new Set<EngineeringLanguageFamily>();
    for (const language of languages) {
      const family = EngineeringLanguageProfiles.familyOf(language);
      if (family) {
        families.add(family);
      }
    }
    return families.size > 0 ? [...families].sort() : EngineeringLanguageProfiles.allFamilies();
  }

  static get importPatterns(): readonly EngineeringImportPattern[] {
    return FAMILY_PROFILES.flatMap((profile) => profile.importPatterns);
  }

  static get sourceExts(): ReadonlySet<string> {
    return EngineeringLanguageService.sourceExts;
  }

  static superclassRoles(
    families: readonly EngineeringLanguageFamily[],
  ): Readonly<Record<string, EngineeringModuleRole>> {
    return mergeRoleMaps(families, "superclassRoles");
  }

  static protocolRoles(
    families: readonly EngineeringLanguageFamily[],
  ): Readonly<Record<string, EngineeringModuleRole>> {
    return mergeRoleMaps(families, "protocolRoles");
  }

  static importRolePatterns(
    families: readonly EngineeringLanguageFamily[],
  ): readonly EngineeringRolePattern[] {
    const patterns: EngineeringRolePattern[] = [];
    for (const family of families) {
      patterns.push(...(FAMILY_BY_ID.get(family)?.importRolePatterns ?? []));
    }
    patterns.push(...UNIVERSAL_ROLE_PATTERNS);
    return patterns;
  }

  static roleForConfigLayer(
    layerName: string | null | undefined,
  ): EngineeringModuleRole | undefined {
    return layerName ? CONFIG_LAYER_TO_ROLE[layerName.toLowerCase()] : undefined;
  }

  static normalizeRoleAlias(role: string): EngineeringModuleRole {
    switch (role) {
      case "agent-orchestration":
        return "service";
      case "data":
        return "model";
      case "documentation":
        return "utility";
      case "interface":
        return "ui";
      case "operations":
        return "config";
      default:
        return isEngineeringModuleRole(role) ? role : "core";
    }
  }

  static get knownLibraries(): Readonly<Record<string, string>> {
    return Object.freeze(
      Object.assign({}, ...FAMILY_PROFILES.map((profile) => profile.knownLibraries)),
    ) as Readonly<Record<string, string>>;
  }

  static get keywordCategories(): ReadonlyArray<readonly [RegExp, string]> {
    return [
      [/test|mock|spec/i, "Testing"],
      [/http|net|api|grpc|socket/i, "Networking"],
      [/db|sql|storage|cache/i, "Storage"],
      [/ui|view|component|widget/i, "UI"],
    ];
  }

  static get skipDirs(): ReadonlySet<string> {
    const dirs = new Set(EngineeringLanguageService.scanSkipDirs);
    for (const profile of FAMILY_PROFILES) {
      for (const dir of profile.extraSkipDirs) {
        dirs.add(dir);
      }
    }
    dirs.add(".asd");
    return dirs;
  }

  static get artifactSuffixes(): readonly string[] {
    return [...new Set(FAMILY_PROFILES.flatMap((profile) => profile.artifactSuffixes))].sort();
  }

  static get vendorDirs(): ReadonlySet<string> {
    return new Set([
      ...COMMON_VENDOR_DIRS,
      ...FAMILY_PROFILES.flatMap((profile) => profile.vendorDirs),
    ]);
  }

  static get thirdPartyPathRegex(): RegExp {
    const dirPart = [...EngineeringLanguageProfiles.vendorDirs]
      .map((dir) => escapeRegex(dir))
      .join("|");
    const knownPart = Object.keys(EngineeringLanguageProfiles.knownLibraries)
      .filter((name) => name.length >= 3)
      .map(escapeRegex)
      .join("|");
    return new RegExp(`(?:^|/)(?:${dirPart})(?:/|$)|(?:^|/)(?:${knownPart})(?:/|$)`, "i");
  }

  static get baseClassExclusions(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const profile of FAMILY_PROFILES) {
      for (const name of Object.keys(profile.superclassRoles)) {
        names.add(name);
      }
      for (const name of Object.keys(profile.protocolRoles)) {
        names.add(name);
      }
    }
    for (const name of ["Object", "Any", "NSObject", "Component", "React.Component"]) {
      names.add(name);
    }
    return names;
  }

  static get validCodeLanguages(): ReadonlySet<string> {
    return new Set([
      ...EngineeringLanguageService.knownLangs,
      "bash",
      "css",
      "graphql",
      "html",
      "json",
      "markdown",
      "md",
      "scss",
      "shell",
      "sql",
      "toml",
      "yaml",
      "yml",
      "zsh",
    ]);
  }
}

function mergeRoleMaps(
  families: readonly EngineeringLanguageFamily[],
  key: "superclassRoles" | "protocolRoles",
): Readonly<Record<string, EngineeringModuleRole>> {
  return Object.freeze(
    Object.assign({}, ...families.map((family) => FAMILY_BY_ID.get(family)?.[key] ?? {})),
  ) as Readonly<Record<string, EngineeringModuleRole>>;
}

function capture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function packageRoot(match: RegExpExecArray): readonly string[] {
  const specifier = capture(match, 1);
  if (!specifier) {
    return [];
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? [`${parts[0]}/${parts[1]}`] : [specifier];
  }
  return [specifier.split("/")[0] ?? specifier];
}

function isEngineeringModuleRole(role: string): role is EngineeringModuleRole {
  return [
    "app",
    "auth",
    "config",
    "core",
    "feature",
    "model",
    "networking",
    "routing",
    "service",
    "storage",
    "test",
    "ui",
    "utility",
  ].includes(role);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
