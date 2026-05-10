import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  MainlineGuardCheckEngine,
  type MainlineGuardFile,
  type MainlineGuardRule,
  type MainlineGuardRuleLoadResult,
} from "../../../guard/index.js";
import type { ToolHandler, ToolRuntimeDependencies } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

const SYMBOL_PATTERN =
  /^\s*(?:export\s+)?(?:async\s+)?(?:(class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/;

interface CodeGuardInput {
  readonly files: readonly MainlineGuardFile[];
  readonly maxFindings?: number;
  readonly maxFindingsPerRule?: number;
}

export const codeSearchHandler: ToolHandler = async (invocation, context) => {
  const root = projectRoot(context.dependencies);
  if (!root) {
    return missingProjectRoot(context.descriptor);
  }
  const parsed = parseCodeSearchInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const files = await listFiles(root, ".", 8);
  const matchers = parsed.input.patterns.map((pattern) =>
    parsed.input.regex
      ? { pattern, regex: new RegExp(pattern, "i") }
      : { pattern, text: pattern.toLowerCase() },
  );
  const results: unknown[] = [];

  for (const relativePath of files) {
    if (!matchesGlob(relativePath, parsed.input.glob)) {
      continue;
    }
    const content = await readFile(path.join(root, relativePath), "utf8");
    const lines = content.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      for (const matcher of matchers) {
        const matched =
          "regex" in matcher ? matcher.regex.test(line) : line.toLowerCase().includes(matcher.text);
        if (!matched) {
          continue;
        }
        results.push({
          path: relativePath,
          line: lineIndex + 1,
          pattern: matcher.pattern,
          text: line,
          before: lines.slice(Math.max(0, lineIndex - parsed.input.contextLines), lineIndex),
          after: lines.slice(lineIndex + 1, lineIndex + 1 + parsed.input.contextLines),
        });
        if (results.length >= parsed.input.maxResults) {
          return toolSuccess(context.descriptor, {
            patterns: parsed.input.patterns,
            root,
            count: results.length,
            truncated: true,
            results,
          });
        }
      }
    }
  }

  return toolSuccess(context.descriptor, {
    patterns: parsed.input.patterns,
    root,
    count: results.length,
    truncated: false,
    results,
  });
};

export const codeReadHandler: ToolHandler = async (invocation, context) => {
  const root = projectRoot(context.dependencies);
  if (!root) {
    return missingProjectRoot(context.descriptor);
  }
  const parsed = parseCodeReadInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }
  const resolved = safeProjectPath(root, parsed.input.path);
  if (!resolved.ok) {
    return toolFailure(context.descriptor, "error", resolved.error);
  }

  const content = await readFile(resolved.absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = parsed.input.startLine ?? 1;
  const endLine = parsed.input.endLine ?? lines.length;
  const selected = lines.slice(startLine - 1, endLine);

  return toolSuccess(context.descriptor, {
    path: resolved.relativePath,
    startLine,
    endLine: Math.min(endLine, lines.length),
    totalLines: lines.length,
    content: selected.join("\n"),
  });
};

export const codeOutlineHandler: ToolHandler = async (invocation, context) => {
  const root = projectRoot(context.dependencies);
  if (!root) {
    return missingProjectRoot(context.descriptor);
  }
  const parsed = parseCodeOutlineInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }
  const resolved = safeProjectPath(root, parsed.input.path);
  if (!resolved.ok) {
    return toolFailure(context.descriptor, "error", resolved.error);
  }

  const lines = (await readFile(resolved.absolutePath, "utf8")).split(/\r?\n/);
  const kindSet = parsed.input.kinds ? new Set(parsed.input.kinds) : null;
  const symbols = lines.flatMap((line, index) => {
    const match = line.match(SYMBOL_PATTERN);
    if (!match) {
      return [];
    }
    const kind = match[1] ?? (match[3] ? "function" : match[4] ? "method" : "unknown");
    const name = match[2] ?? match[3] ?? match[4];
    if (!name || (kindSet && !kindSet.has(kind))) {
      return [];
    }
    const depth = leadingSpaces(line);
    if (depth > parsed.input.maxDepth * 2) {
      return [];
    }
    return [{ name, kind, line: index + 1, indent: depth }];
  });

  return toolSuccess(context.descriptor, {
    path: resolved.relativePath,
    symbols,
    count: symbols.length,
  });
};

export const codeStructureHandler: ToolHandler = async (invocation, context) => {
  const root = projectRoot(context.dependencies);
  if (!root) {
    return missingProjectRoot(context.descriptor);
  }
  const parsed = parseCodeStructureInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }
  const resolved = safeProjectPath(root, parsed.input.directory);
  if (!resolved.ok) {
    return toolFailure(context.descriptor, "error", resolved.error);
  }

  const entries = await buildTree(resolved.absolutePath, resolved.relativePath, parsed.input.depth);
  return toolSuccess(context.descriptor, {
    directory: resolved.relativePath,
    depth: parsed.input.depth,
    entries,
  });
};

export const codeWriteHandler: ToolHandler = (invocation, context) => {
  const input = isRecord(invocation.input) ? invocation.input : {};
  // 中文注释：写文件是 Agent 动作空间的一部分，但实际写入必须走外层
  // write-boundary/policy gate；这里保持声明能力，不在 handler 内落盘。
  return toolFailure(context.descriptor, "policy_required", {
    code: "policy_required",
    message: "code.write is declared but file writes are gated outside lib/agent/tools.",
    details: {
      executesWrites: false,
      ...(typeof input.path === "string" ? { path: input.path } : {}),
    },
  });
};

export const codeGuardHandler: ToolHandler = async (invocation, context) => {
  const parsed = parseCodeGuardInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const loaded = await loadGuardRules(context.dependencies);
  if (!loaded) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "guard_rules_unavailable",
      message: "code.guard requires mainline guard-rule Recipe dependencies.",
    });
  }

  const result = new MainlineGuardCheckEngine({ rules: loaded.rules }).check({
    files: parsed.input.files,
    options: {
      ...(parsed.input.maxFindings ? { maxFindings: parsed.input.maxFindings } : {}),
      ...(parsed.input.maxFindingsPerRule
        ? { maxFindingsPerRule: parsed.input.maxFindingsPerRule }
        : {}),
    },
  });

  return toolSuccess(context.descriptor, {
    summary: result.summary,
    findings: result.findings,
    warnings: [...loaded.warnings, ...result.warnings],
  });
};

async function loadGuardRules(
  dependencies: ToolRuntimeDependencies,
): Promise<MainlineGuardRuleLoadResult | null> {
  if (dependencies.guardRules) {
    return { rules: dependencies.guardRules, warnings: [] };
  }

  const provider = dependencies.guardRuleProvider;
  if (!provider) {
    return null;
  }

  const loaded = typeof provider === "function" ? await provider() : await provider.load();
  if (isGuardRuleArray(loaded)) {
    return { rules: loaded, warnings: [] };
  }
  return loaded;
}

function parseCodeSearchInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly patterns: readonly string[];
        readonly glob?: string;
        readonly maxResults: number;
        readonly contextLines: number;
        readonly regex: boolean;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.search input must be an object." },
    };
  }
  const patterns = optionalStringArray(input.patterns).slice(0, 10);
  if (patterns.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.search patterns cannot be empty." },
    };
  }
  const maxResults = boundedInteger(input.maxResults, 10, 50);
  const contextLines = boundedInteger(input.contextLines, 2, 8);
  if (maxResults === undefined || contextLines === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.search numeric options are invalid." },
    };
  }
  const glob = stringValue(input.glob);
  return {
    ok: true,
    input: {
      patterns,
      ...(glob ? { glob } : {}),
      maxResults,
      contextLines,
      regex: input.regex === true,
    },
  };
}

function parseCodeReadInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly path: string;
        readonly startLine?: number;
        readonly endLine?: number;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.read input must be an object." },
    };
  }
  const targetPath = stringValue(input.path);
  if (!targetPath) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.read path is required." },
    };
  }
  const startLine = boundedInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER);
  const endLine = boundedInteger(input.endLine, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (
    (input.startLine !== undefined && startLine === undefined) ||
    (input.endLine !== undefined && endLine === undefined)
  ) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.read line range is invalid." },
    };
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.read endLine must be >= startLine." },
    };
  }
  return {
    ok: true,
    input: {
      path: targetPath,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    },
  };
}

function parseCodeOutlineInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly path: string;
        readonly kinds?: readonly string[];
        readonly maxDepth: number;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const parsed = parseCodeReadInput(input);
  if (!parsed.ok) {
    return parsed;
  }
  const record = input as Record<string, unknown>;
  const maxDepth = boundedInteger(record.maxDepth, 4, 8);
  if (maxDepth === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.outline maxDepth is invalid." },
    };
  }
  const kinds = optionalStringArray(record.kinds);
  return {
    ok: true,
    input: {
      path: parsed.input.path,
      ...(kinds.length > 0 ? { kinds } : {}),
      maxDepth,
    },
  };
}

function parseCodeStructureInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: { readonly directory: string; readonly depth: number } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (input !== undefined && !isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.structure input must be an object." },
    };
  }
  const record = input ?? {};
  const depth = boundedInteger((record as Record<string, unknown>).depth, 3, 5);
  if (depth === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.structure depth is invalid." },
    };
  }
  return {
    ok: true,
    input: {
      directory: stringValue((record as Record<string, unknown>).directory) ?? ".",
      depth,
    },
  };
}

function parseCodeGuardInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: CodeGuardInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard input must be an object." },
    };
  }

  const files = parseFiles(input.files);
  if (!files) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard files must contain path/content." },
    };
  }

  const maxFindings = boundedInteger(input.maxFindings, 200, 1000);
  const maxFindingsPerRule = boundedInteger(input.maxFindingsPerRule, 20, 100);
  if (maxFindings === undefined || maxFindingsPerRule === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard numeric options are invalid." },
    };
  }

  return {
    ok: true,
    input: {
      files,
      maxFindings,
      maxFindingsPerRule,
    },
  };
}

function parseFiles(value: unknown): MainlineGuardFile[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const files: MainlineGuardFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const pathValue = stringValue(item.path);
    const content = typeof item.content === "string" ? item.content : undefined;
    if (!pathValue || content === undefined) {
      return null;
    }
    const language = stringValue(item.language);
    files.push({
      path: pathValue,
      content,
      ...(language ? { language } : {}),
      ...(typeof item.isTest === "boolean" ? { isTest: item.isTest } : {}),
    });
  }
  return files;
}

async function listFiles(
  projectRoot: string,
  relativeDirectory: string,
  maxDepth: number,
): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }
  const absoluteDirectory = path.join(projectRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      continue;
    }
    const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await listFiles(projectRoot, relativePath, maxDepth - 1)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function buildTree(
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
): Promise<unknown[]> {
  const directoryStat = await stat(absoluteDirectory);
  if (!directoryStat.isDirectory()) {
    return [];
  }
  if (depth <= 0) {
    return [];
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const result: unknown[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      result.push({
        type: "directory",
        path: relativePath,
        children: await buildTree(
          path.join(absoluteDirectory, entry.name),
          relativePath,
          depth - 1,
        ),
      });
    } else if (entry.isFile()) {
      result.push({ type: "file", path: relativePath });
    }
  }
  return result;
}

function safeProjectPath(
  root: string,
  requestedPath: string,
):
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, requestedPath);
  const relativePath = normalizeRelativePath(path.relative(absoluteRoot, absolutePath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return {
      ok: false,
      error: { code: "path_outside_project", message: "Path must stay inside projectRoot." },
    };
  }
  return {
    ok: true,
    absolutePath,
    relativePath: relativePath || ".",
  };
}

function matchesGlob(relativePath: string, glob: string | undefined): boolean {
  if (!glob) {
    return true;
  }
  if (glob.includes("*")) {
    const escaped = glob
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(relativePath);
  }
  return relativePath.endsWith(glob) || relativePath.includes(glob);
}

function projectRoot(dependencies: ToolRuntimeDependencies): string | undefined {
  return stringValue(dependencies.projectRoot);
}

function missingProjectRoot(identity: Parameters<typeof toolFailure>[0]) {
  return toolFailure(identity, "unavailable", {
    code: "project_root_unavailable",
    message: "Code tools require ToolRuntimeDependencies.projectRoot.",
  });
}

function isGuardRuleArray(value: unknown): value is readonly MainlineGuardRule[] {
  return Array.isArray(value);
}

function boundedInteger(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return Math.min(value, max);
}

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).filter(Boolean).join("/");
}

function leadingSpaces(value: string): number {
  return value.length - value.trimStart().length;
}
