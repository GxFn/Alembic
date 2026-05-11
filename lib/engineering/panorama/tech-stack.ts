import type { EngineeringDependencyGraph, EngineeringFile } from "../foundation/types.js";
import { normalizeEngineeringDependencyNode } from "../foundation/types.js";
import { EngineeringLanguageProfiles } from "../language/profiles.js";
import { EngineeringLanguageService } from "../language/service.js";
import type { EngineeringImportFact } from "./module-discoverer.js";
import type {
  EngineeringPanoramaExternalDependencyProfile,
  EngineeringPanoramaModuleDetail,
  EngineeringTechStackItem,
  EngineeringTechStackProfile,
} from "./types.js";

export interface EngineeringTechStackProfilerInput {
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly externalDeps: readonly EngineeringPanoramaExternalDependencyProfile[];
  readonly modules: readonly EngineeringPanoramaModuleDetail[];
  readonly importFacts?: readonly EngineeringImportFact[];
}

interface MutableFact {
  readonly name: string;
  readonly category: EngineeringTechStackItem["category"];
  readonly source: Set<string>;
  count: number;
  fanIn: number;
  readonly dependedBy: Set<string>;
  readonly modules: Set<string>;
  confidence: number;
  version: string | undefined;
}

const HOTSPOT_THRESHOLD = 3;
const CATEGORY_ORDER: readonly EngineeringTechStackItem["category"][] = [
  "language",
  "framework",
  "library",
  "runtime",
  "storage",
  "test",
  "devops",
  "other",
];

const RUNTIME_BY_LANGUAGE: Readonly<Record<string, string>> = {
  csharp: ".NET",
  dart: "Dart VM",
  go: "Go runtime",
  java: "JVM",
  javascript: "Node.js",
  kotlin: "JVM",
  objectivec: "Apple runtime",
  python: "Python runtime",
  rust: "Rust runtime",
  swift: "Apple runtime",
  typescript: "Node.js",
};

const PACKAGE_FILE_FACTS: readonly {
  readonly pattern: RegExp;
  readonly name: string;
  readonly category: EngineeringTechStackItem["category"];
}[] = [
  { pattern: /(^|\/)package\.json$/i, name: "npm", category: "devops" },
  {
    pattern: /(^|\/)(vite|webpack|rollup|next)\.config\.[cm]?[jt]s$/i,
    name: "web build",
    category: "devops",
  },
  { pattern: /(^|\/)Podfile$/i, name: "CocoaPods", category: "devops" },
  { pattern: /(^|\/)Package\.swift$/i, name: "Swift Package Manager", category: "devops" },
  {
    pattern: /(^|\/)(build\.gradle|build\.gradle\.kts|pom\.xml)$/i,
    name: "JVM build",
    category: "devops",
  },
  {
    pattern: /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/i,
    name: "Python packaging",
    category: "devops",
  },
  { pattern: /(^|\/)Cargo\.toml$/i, name: "Cargo", category: "devops" },
  { pattern: /(^|\/)go\.mod$/i, name: "Go modules", category: "devops" },
  { pattern: /(^|\/)Dockerfile$/i, name: "Docker", category: "devops" },
  {
    pattern: /(^|\/)(docker-compose|compose)\.ya?ml$/i,
    name: "Docker Compose",
    category: "devops",
  },
];

export class EngineeringTechStackProfiler {
  profile(input: EngineeringTechStackProfilerInput): EngineeringTechStackProfile {
    const facts = new Map<string, MutableFact>();
    const fileToModule = buildFileToModule(input.modules);

    for (const [language, count] of countLanguages(input.files)) {
      addFact(facts, {
        name: EngineeringLanguageService.displayName(language),
        category: "language",
        source: "files",
        count,
        confidence: 0.95,
      });
      const runtime = RUNTIME_BY_LANGUAGE[language];
      if (runtime) {
        addFact(facts, {
          name: runtime,
          category: "runtime",
          source: "language-runtime",
          count,
          confidence: 0.7,
        });
      }
    }

    for (const file of input.files) {
      for (const packageFact of PACKAGE_FILE_FACTS) {
        if (packageFact.pattern.test(file.relativePath || file.path)) {
          addFact(facts, {
            name: packageFact.name,
            category: packageFact.category,
            source: "package-file",
            count: 1,
            confidence: 0.8,
          });
        }
      }
    }

    for (const dependency of input.externalDeps) {
      addFact(facts, {
        name: dependency.name,
        category: classifyDependency(dependency.name),
        source: dependency.source ?? "external-dependency",
        count: dependency.dependedBy.length || dependency.fanIn || 1,
        fanIn: dependency.fanIn,
        dependedBy: dependency.dependedBy,
        modules: dependency.dependedBy,
        confidence: 0.85,
        version: dependency.version,
      });
    }

    for (const node of input.dependencyGraph.nodes) {
      const normalized = normalizeEngineeringDependencyNode(node);
      if (
        normalized.type !== "external" &&
        normalized.type !== "remote" &&
        normalized.indirect !== true
      ) {
        continue;
      }
      addFact(facts, {
        name: normalized.label ?? normalized.id,
        category: classifyDependency(normalized.label ?? normalized.id),
        source: "dependency-graph",
        count: 1,
        confidence: 0.75,
        version: typeof normalized.version === "string" ? normalized.version : undefined,
      });
    }

    for (const fact of input.importFacts ?? []) {
      if (isLocalImport(fact.specifier, input.modules)) {
        continue;
      }
      const moduleName = fileToModule.get(fact.filePath);
      addFact(facts, {
        name: packageRoot(fact.specifier),
        category: classifyDependency(fact.specifier),
        source: "import",
        count: 1,
        fanIn: moduleName ? 1 : 0,
        dependedBy: moduleName ? [moduleName] : [],
        modules: moduleName ? [moduleName] : [],
        confidence: 0.7,
      });
    }

    for (const module of input.modules) {
      const roleCategory = categoryForRole(module.role);
      if (!roleCategory) {
        continue;
      }
      addFact(facts, {
        name: `${module.role} role signal`,
        category: roleCategory,
        source: "role-signal",
        count: module.sourceFileCount,
        modules: [module.name],
        confidence: Math.max(0.3, module.roleConfidence),
      });
    }

    const items = [...facts.values()].map(toItem);
    const categories = CATEGORY_ORDER.map((category) => ({
      name: category,
      items: items
        .filter((item) => item.category === category)
        .sort(
          (left, right) =>
            right.fanIn - left.fanIn ||
            right.count - left.count ||
            left.name.localeCompare(right.name),
        ),
    })).filter((category) => category.items.length > 0);

    const hotspots = items
      .filter((item) => item.fanIn >= HOTSPOT_THRESHOLD || item.count >= HOTSPOT_THRESHOLD)
      .map((item) => ({
        name: item.name,
        category: item.category,
        fanIn: item.fanIn,
        dependedBy: item.dependedBy,
        reason:
          item.fanIn >= HOTSPOT_THRESHOLD
            ? "depended on by several modules"
            : "appears frequently across files or role signals",
      }))
      .sort((left, right) => right.fanIn - left.fanIn || left.name.localeCompare(right.name));

    return {
      categories,
      hotspots,
      totalExternalDeps: input.externalDeps.length,
      totalFacts: items.length,
      primaryLanguages:
        categories
          .find((category) => category.name === "language")
          ?.items.slice(0, 3)
          .map((item) => item.name) ?? [],
    };
  }
}

function addFact(
  facts: Map<string, MutableFact>,
  input: {
    readonly name: string;
    readonly category: EngineeringTechStackItem["category"];
    readonly source: string;
    readonly count: number;
    readonly fanIn?: number;
    readonly dependedBy?: readonly string[];
    readonly modules?: readonly string[];
    readonly confidence: number;
    readonly version?: string | undefined;
  },
): void {
  const name = cleanName(input.name);
  if (!name) {
    return;
  }
  const key = `${input.category}\u0000${name.toLowerCase()}`;
  const current = facts.get(key) ?? {
    name,
    category: input.category,
    source: new Set<string>(),
    count: 0,
    fanIn: 0,
    dependedBy: new Set<string>(),
    modules: new Set<string>(),
    confidence: 0,
    version: undefined,
  };
  current.source.add(input.source);
  current.count += input.count;
  current.fanIn = Math.max(current.fanIn, input.fanIn ?? 0);
  current.confidence = Math.max(current.confidence, input.confidence);
  current.version ??= input.version;
  for (const moduleName of input.dependedBy ?? []) {
    current.dependedBy.add(moduleName);
  }
  for (const moduleName of input.modules ?? []) {
    current.modules.add(moduleName);
  }
  facts.set(key, current);
}

function toItem(fact: MutableFact): EngineeringTechStackItem {
  return {
    name: fact.name,
    category: fact.category,
    source: [...fact.source].sort().join("+"),
    count: fact.count,
    fanIn: fact.fanIn || fact.dependedBy.size,
    dependedBy: [...fact.dependedBy].sort(),
    modules: [...fact.modules].sort(),
    confidence: round(fact.confidence),
    ...(fact.version !== undefined ? { version: fact.version } : {}),
  };
}

function countLanguages(files: readonly EngineeringFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = EngineeringLanguageService.normalize(
      file.language || EngineeringLanguageService.inferLang(file.relativePath || file.path),
    );
    if (
      language === "unknown" ||
      language === "markdown" ||
      language === "md" ||
      language === "json" ||
      language === "yaml" ||
      language === "yml" ||
      language === "toml"
    ) {
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

function classifyDependency(name: string): EngineeringTechStackItem["category"] {
  const normalized = cleanName(name)
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[-_./]/g, "");
  const knownCategory = EngineeringLanguageProfiles.knownLibraries[normalized];
  if (knownCategory) {
    return mapLegacyCategory(knownCategory);
  }
  for (const [pattern, category] of EngineeringLanguageProfiles.keywordCategories) {
    if (pattern.test(name)) {
      return mapLegacyCategory(category);
    }
  }
  if (
    /react|vue|angular|svelte|swiftui|uikit|flutter|django|fastapi|express|next|nuxt|gin|axum/i.test(
      name,
    )
  ) {
    return "framework";
  }
  if (/jest|vitest|pytest|xctest|junit|playwright|cypress|mockito/i.test(name)) {
    return "test";
  }
  if (
    /realm|coredata|sqlite|postgres|mysql|redis|mongo|prisma|typeorm|sequelize|sqlx|diesel/i.test(
      name,
    )
  ) {
    return "storage";
  }
  if (/node|tokio|jvm|deno|bun|runtime/i.test(name)) {
    return "runtime";
  }
  if (
    /docker|gradle|maven|npm|pnpm|yarn|webpack|vite|rollup|xcodebuild|tuist|fastlane|cocoapods/i.test(
      name,
    )
  ) {
    return "devops";
  }
  return "library";
}

function mapLegacyCategory(category: string): EngineeringTechStackItem["category"] {
  switch (category.toLowerCase()) {
    case "server":
    case "ui":
      return "framework";
    case "networking":
    case "rpc":
    case "serialization":
      return "library";
    case "runtime":
      return "runtime";
    case "storage":
      return "storage";
    case "testing":
      return "test";
    default:
      return "library";
  }
}

function categoryForRole(role: string): EngineeringTechStackItem["category"] | null {
  if (role === "ui" || role === "routing" || role === "app") {
    return "framework";
  }
  if (role === "networking" || role === "service" || role === "auth") {
    return "library";
  }
  if (role === "storage" || role === "model") {
    return "storage";
  }
  if (role === "test") {
    return "test";
  }
  if (role === "config") {
    return "devops";
  }
  return null;
}

function buildFileToModule(
  modules: readonly EngineeringPanoramaModuleDetail[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const module of modules) {
    for (const file of module.files) {
      result.set(file, module.name);
    }
  }
  return result;
}

function isLocalImport(
  specifier: string,
  modules: readonly EngineeringPanoramaModuleDetail[],
): boolean {
  const root = packageRoot(specifier);
  return modules.some((module) => module.name === root || module.name === specifier);
}

function packageRoot(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

function cleanName(name: string): string {
  return name.trim().replace(/^BDMV|^BDP|^FMT|^BD|^MTL|^Bai|^Ali|^TX|^TT/, "");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
