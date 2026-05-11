export interface MainlineBuildMarker {
  readonly file: string;
  readonly ecosystem: string;
  readonly buildTool: string;
}

export interface MainlineLanguageProfileEntry {
  readonly lang: string;
  readonly count: number;
  readonly ratio: number;
}

export interface MainlineLanguageProfile {
  readonly primary: string;
  readonly secondary: string[];
  readonly all: MainlineLanguageProfileEntry[];
  readonly totalFiles: number;
  readonly isMultiLang: boolean;
}

const EXT_TO_LANG: Record<string, string> = Object.freeze({
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".cxx": "cpp",
  ".dart": "dart",
  ".go": "go",
  ".h": "objectivec",
  ".hpp": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".m": "objectivec",
  ".mjs": "javascript",
  ".mm": "objectivec",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".svelte": "javascript",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "javascript",
});

const DISPLAY_NAMES: Record<string, string> = Object.freeze({
  c: "C",
  cpp: "C++",
  csharp: "C#",
  dart: "Dart",
  go: "Go",
  java: "Java",
  javascript: "JavaScript",
  kotlin: "Kotlin",
  objectivec: "Objective-C",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  swift: "Swift",
  typescript: "TypeScript",
  unknown: "Unknown",
});

const LANGUAGE_ALIASES: Record<string, string> = Object.freeze({
  "c#": "csharp",
  "c++": "cpp",
  cs: "csharp",
  cxx: "cpp",
  go: "go",
  golang: "go",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  objc: "objectivec",
  "obj-c": "objectivec",
  "objective-c": "objectivec",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
});

const PROGRAMMING_LANGUAGES = new Set(Object.values(EXT_TO_LANG));
const SOURCE_EXTENSIONS = new Set(Object.keys(EXT_TO_LANG));
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx"]);
const DOCUMENT_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS]);
const SCAN_SKIP_DIRS = new Set([
  ".asd",
  ".build",
  ".cache",
  ".cargo",
  ".dart_tool",
  ".fvm",
  ".git",
  ".gradle",
  ".swiftpm",
  "__pycache__",
  "build",
  "Carthage",
  "DerivedData",
  "dist",
  "node_modules",
  "out",
  "Pods",
  "target",
  "vendor",
  "venv",
  ".venv",
]);

const BUILD_MARKERS: readonly MainlineBuildMarker[] = Object.freeze([
  { file: "Package.swift", ecosystem: "spm", buildTool: "SPM" },
  { file: "Podfile", ecosystem: "spm", buildTool: "CocoaPods" },
  { file: "*.xcodeproj", ecosystem: "xcode", buildTool: "Xcode" },
  { file: "*.xcworkspace", ecosystem: "xcode", buildTool: "Xcode" },
  { file: "yarn.lock", ecosystem: "node", buildTool: "Yarn" },
  { file: "pnpm-lock.yaml", ecosystem: "node", buildTool: "pnpm" },
  { file: "package.json", ecosystem: "node", buildTool: "npm" },
  { file: "pyproject.toml", ecosystem: "python", buildTool: "Poetry" },
  { file: "requirements.txt", ecosystem: "python", buildTool: "pip" },
  { file: "go.mod", ecosystem: "go", buildTool: "Go Modules" },
  { file: "Cargo.toml", ecosystem: "rust", buildTool: "Cargo" },
  { file: "pom.xml", ecosystem: "jvm", buildTool: "Maven" },
  { file: "build.gradle", ecosystem: "jvm", buildTool: "Gradle" },
  { file: "build.gradle.kts", ecosystem: "jvm", buildTool: "Gradle (Kotlin)" },
  { file: "pubspec.yaml", ecosystem: "dart", buildTool: "Flutter" },
  { file: "*.csproj", ecosystem: "dotnet", buildTool: ".NET" },
  { file: "*.sln", ecosystem: "dotnet", buildTool: ".NET" },
  { file: "Gemfile", ecosystem: "ruby", buildTool: "Bundler" },
]);

const TEST_DIR_PATTERN =
  /(?:^|[/\\])(?:tests?|__tests__|spec|__mocks__|testdata|test_driver|integration_test|e2e)[/\\]/;

/**
 * MainlineLanguageCatalog 是语言识别的纯数据目录。
 * 它从旧 LanguageService 中提取稳定表格，避免 compile/runtime 自建零散 langMap。
 */
export class MainlineLanguageCatalog {
  inferLanguageId(path: string): string {
    const extension = extensionOf(path);
    return EXT_TO_LANG[extension] ?? "unknown";
  }

  normalize(languageId: string): string {
    const lower = languageId.toLowerCase().trim();
    if (PROGRAMMING_LANGUAGES.has(lower)) {
      return lower;
    }
    return LANGUAGE_ALIASES[lower] ?? lower ?? "unknown";
  }

  displayName(languageId: string): string {
    return DISPLAY_NAMES[this.normalize(languageId)] ?? languageId;
  }

  isSourceFile(path: string): boolean {
    return SOURCE_EXTENSIONS.has(extensionOf(path));
  }

  isMarkdownFile(path: string): boolean {
    return MARKDOWN_EXTENSIONS.has(extensionOf(path));
  }

  isDocumentFile(path: string): boolean {
    return DOCUMENT_EXTENSIONS.has(extensionOf(path));
  }

  isTestFile(path: string, languageId = this.inferLanguageId(path)): boolean {
    const name = path.split(/[/\\]/).pop() ?? "";
    switch (this.normalize(languageId)) {
      case "dart":
        return name.endsWith("_test.dart") || TEST_DIR_PATTERN.test(path);
      case "go":
        return name.endsWith("_test.go") || TEST_DIR_PATTERN.test(path);
      case "java":
      case "kotlin":
        return /Tests?\.(java|kt)$/.test(name) || TEST_DIR_PATTERN.test(path);
      case "javascript":
      case "typescript":
        return /\.(test|spec)\.(cjs|js|jsx|mjs|ts|tsx)$/.test(name) || TEST_DIR_PATTERN.test(path);
      case "python":
        return name.startsWith("test_") || name.endsWith("_test.py") || TEST_DIR_PATTERN.test(path);
      case "ruby":
        return (
          /_(spec|test)\.rb$/.test(name) || name.startsWith("test_") || TEST_DIR_PATTERN.test(path)
        );
      case "rust":
        return name.endsWith("_test.rs") || name.startsWith("test_") || TEST_DIR_PATTERN.test(path);
      case "swift":
        return /Tests?\.swift$/.test(name) || TEST_DIR_PATTERN.test(path);
      default:
        return TEST_DIR_PATTERN.test(path);
    }
  }

  sourceExtensions(): string[] {
    return [...SOURCE_EXTENSIONS].sort();
  }

  documentExtensions(): string[] {
    return [...DOCUMENT_EXTENSIONS].sort();
  }

  scanSkipDirs(): string[] {
    return [...SCAN_SKIP_DIRS].sort();
  }

  buildMarkers(): MainlineBuildMarker[] {
    return BUILD_MARKERS.map((marker) => ({ ...marker }));
  }

  matchBuildMarkers(entryNames: readonly string[]): MainlineBuildMarker[] {
    const nameSet = new Set(entryNames);
    const seenEcosystems = new Set<string>();
    const matches: MainlineBuildMarker[] = [];

    for (const marker of BUILD_MARKERS) {
      if (seenEcosystems.has(marker.ecosystem)) {
        continue;
      }
      const matched = marker.file.startsWith("*")
        ? entryNames.some((entry) => entry.endsWith(marker.file.slice(1)))
        : nameSet.has(marker.file);
      if (matched) {
        matches.push({ ...marker });
        seenEcosystems.add(marker.ecosystem);
      }
    }

    return matches;
  }

  detectProfile(
    languageCounts: Record<string, number>,
    secondaryThreshold = 0.1,
  ): MainlineLanguageProfile {
    const totalFiles = Object.values(languageCounts).reduce((sum, count) => sum + count, 0);
    if (totalFiles === 0) {
      return {
        primary: "unknown",
        secondary: [],
        all: [],
        totalFiles: 0,
        isMultiLang: false,
      };
    }

    const all = Object.entries(languageCounts)
      .map(([lang, count]) => ({
        lang: this.normalize(lang),
        count,
        ratio: count / totalFiles,
      }))
      .filter((entry) => PROGRAMMING_LANGUAGES.has(entry.lang))
      .sort((left, right) => right.count - left.count);

    const primary = all[0]?.lang ?? "unknown";
    const secondary = all
      .slice(1)
      .filter((entry) => entry.ratio >= secondaryThreshold)
      .map((entry) => entry.lang);

    return {
      primary,
      secondary,
      all,
      totalFiles,
      isMultiLang: secondary.length > 0,
    };
  }
}

export const defaultMainlineLanguageCatalog = new MainlineLanguageCatalog();

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index >= 0 ? path.slice(index).toLowerCase() : "";
}
