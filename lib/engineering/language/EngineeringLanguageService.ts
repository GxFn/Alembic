import path from "node:path";

const EXT_TO_LANG: Readonly<Record<string, string>> = Object.freeze({
  ".c": "c",
  ".cc": "cpp",
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
  ".mm": "objectivec",
  ".mjs": "javascript",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".svelte": "javascript",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "javascript",
});

const LANG_ALIASES: Readonly<Record<string, string>> = Object.freeze({
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
  "objective-c": "objectivec",
  py: "python",
  python3: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
});

const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
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

const SCAN_SKIP_DIRS = Object.freeze(
  new Set([
    ".build",
    ".cache",
    ".cargo",
    ".dart_tool",
    ".fvm",
    ".git",
    ".gradle",
    ".swiftpm",
    ".venv",
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
  ]),
);

/**
 * EngineeringLanguageService 是 lib/engineering 的底层语言规范化入口。
 * 中文说明：工程模块内不要再散落 ext/lang map，统一从这里取语言、扩展名和跳过目录。
 */
export class EngineeringLanguageService {
  static readonly sourceExts: ReadonlySet<string> = new Set(Object.keys(EXT_TO_LANG));
  static readonly knownLangs: ReadonlySet<string> = new Set(Object.values(EXT_TO_LANG));
  static readonly scanSkipDirs: ReadonlySet<string> = SCAN_SKIP_DIRS;

  static inferLang(filePath: string): string {
    return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? "unknown";
  }

  static normalize(langId: string | null | undefined): string {
    if (!langId) {
      return "unknown";
    }
    const lower = langId.trim().toLowerCase();
    return LANG_ALIASES[lower] ?? lower;
  }

  static displayName(langId: string): string {
    const normalized = EngineeringLanguageService.normalize(langId);
    return DISPLAY_NAMES[normalized] ?? normalized;
  }

  static isTestFile(filePath: string): boolean {
    return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(filePath);
  }
}
