import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MainlineGuardCheckEngine,
  type MainlineGuardFile,
  type MainlineGuardRule,
  type MainlineGuardRuleLoadResult,
} from "../../../guard/index.js";
import {
  defaultMainlineLanguageCatalog,
  type MainlineSourceSymbol,
  StructuralMainlineAstParser,
} from "../../../mainline/code/index.js";
import { GuardFindingBuilder } from "../../../mainline/runtime/index.js";
import type { ToolHandler, ToolRuntimeDependencies } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

const IGNORED_DIRECTORIES = new Set([
  ".asd",
  ".build",
  ".cache",
  ".git",
  ".gradle",
  ".next",
  ".swiftpm",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "DerivedData",
  "dist",
  "node_modules",
  "out",
  "Pods",
  "target",
  "venv",
]);

const PROTECTED_WRITE_PATHS = [".git", "node_modules", ".env"];

interface CodeGuardInput {
  readonly files: readonly MainlineGuardFile[];
  readonly maxFindings?: number;
  readonly maxFindingsPerRule?: number;
}

interface SearchMatch {
  readonly file: string;
  readonly line: number;
  readonly content: string;
  readonly pattern: string;
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

  const cacheKey = stableJson(parsed.input);
  const cached = context.dependencies.searchCache?.get(cacheKey);
  if (isSearchPayload(cached)) {
    return toolSuccess(context.descriptor, { ...cached, cached: true });
  }

  const startedAt = Date.now();
  const matches: SearchMatch[] = [];
  let total = 0;
  let engine = "rg";
  for (const pattern of parsed.input.patterns) {
    if (context.dependencies.abortSignal?.aborted) {
      break;
    }
    try {
      const rg = await ripgrepSearch(pattern, root, parsed.input);
      matches.push(...rg.matches);
      total += rg.total;
    } catch {
      engine = "fallback";
      const fallback = await fallbackSearch(pattern, root, parsed.input);
      matches.push(...fallback.matches);
      total += fallback.total;
    }
  }

  const deduped = deduplicateMatches(matches).slice(0, parsed.input.maxResults);
  const payload = {
    engine,
    patterns: parsed.input.patterns,
    count: deduped.length,
    total,
    truncated: total > deduped.length,
    durationMs: Date.now() - startedAt,
    matches: deduped.map(formatSearchMatch),
    text: formatSearchText(deduped, total),
  };
  context.dependencies.searchCache?.set(cacheKey, payload);
  return toolSuccess(context.descriptor, payload);
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

  let content: string;
  try {
    content = await readFile(resolved.absolutePath, "utf8");
  } catch (error) {
    return toolFailure(context.descriptor, "error", {
      code: "file_read_failed",
      message: error instanceof Error ? error.message : "Cannot read file.",
    });
  }

  const lines = content.split(/\r?\n/);
  if (parsed.input.startLine || parsed.input.endLine) {
    const startLine = Math.max(1, parsed.input.startLine ?? 1);
    const endLine = Math.min(lines.length, parsed.input.endLine ?? lines.length);
    const numbered = numberLines(lines.slice(startLine - 1, endLine), startLine);
    return toolSuccess(context.descriptor, {
      path: resolved.relativePath,
      mode: "range",
      startLine,
      endLine,
      totalLines: lines.length,
      content: numbered,
    });
  }

  const delta = context.dependencies.deltaCache?.check(resolved.relativePath, content);
  if (delta?.mode === "unchanged") {
    return toolSuccess(context.descriptor, {
      path: resolved.relativePath,
      mode: "unchanged",
      totalLines: delta.lineCount,
      content: delta.content,
    });
  }
  if (delta?.mode === "delta") {
    return toolSuccess(context.descriptor, {
      path: resolved.relativePath,
      mode: "delta",
      totalLines: delta.lineCount,
      content: delta.content,
    });
  }

  if (lines.length <= 500) {
    return toolSuccess(context.descriptor, {
      path: resolved.relativePath,
      mode: "full",
      totalLines: lines.length,
      content: numberLines(lines, 1),
    });
  }

  const outline = await outlineForLargeFile(
    resolved.absolutePath,
    resolved.relativePath,
    content,
    context.dependencies,
  );
  return toolSuccess(context.descriptor, {
    path: resolved.relativePath,
    mode: "outline",
    totalLines: lines.length,
    content: outline,
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

  let content: string;
  try {
    content = await readFile(resolved.absolutePath, "utf8");
  } catch (error) {
    return toolFailure(context.descriptor, "error", {
      code: "file_read_failed",
      message: error instanceof Error ? error.message : "Cannot read file.",
    });
  }

  const outline = await buildAstOutline(
    resolved.relativePath,
    content,
    context.dependencies,
    parsed.input,
  );
  if (!outline) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "outline_unavailable",
      message: `Cannot generate outline for ${resolved.relativePath}.`,
    });
  }
  return toolSuccess(context.descriptor, outline);
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

  try {
    const text = await buildDirectoryTree(
      resolved.absolutePath,
      resolved.relativePath,
      parsed.input.depth,
    );
    return toolSuccess(context.descriptor, {
      directory: resolved.relativePath,
      depth: parsed.input.depth,
      tree: text,
    });
  } catch (error) {
    return toolFailure(context.descriptor, "error", {
      code: "structure_failed",
      message: error instanceof Error ? error.message : "Cannot list directory structure.",
    });
  }
};

export const codeWriteHandler: ToolHandler = async (invocation, context) => {
  const root = projectRoot(context.dependencies);
  if (!root) {
    return missingProjectRoot(context.descriptor);
  }
  const parsed = parseCodeWriteInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }
  const resolved = safeProjectPath(root, parsed.input.path);
  if (!resolved.ok) {
    return toolFailure(context.descriptor, "error", resolved.error);
  }
  if (isProtectedWritePath(resolved.relativePath)) {
    return toolFailure(context.descriptor, "error", {
      code: "write_protected_path",
      message: `${resolved.relativePath} is protected and cannot be written by code.write.`,
    });
  }

  try {
    if (parsed.input.createDirectories) {
      await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    }
    await writeFile(resolved.absolutePath, parsed.input.content, "utf8");
    context.dependencies.deltaCache?.set(
      resolved.relativePath,
      contentHash(parsed.input.content),
      parsed.input.content,
    );
    return toolSuccess(context.descriptor, {
      written: resolved.relativePath,
      bytes: Buffer.byteLength(parsed.input.content),
    });
  } catch (error) {
    return toolFailure(context.descriptor, "error", {
      code: "write_failed",
      message: error instanceof Error ? error.message : "Cannot write file.",
    });
  }
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
  const runtimeFindings = buildRuntimeGuardFindings(result.findings, loaded.rules);

  return toolSuccess(context.descriptor, {
    summary: result.summary,
    findings: result.findings,
    runtimeFindings,
    warnings: [...loaded.warnings, ...result.warnings],
  });
};

function buildRuntimeGuardFindings(
  findings: ReturnType<MainlineGuardCheckEngine["check"]>["findings"],
  rules: readonly MainlineGuardRule[],
) {
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const builder = new GuardFindingBuilder();
  return findings.map((finding) => {
    const rule = ruleById.get(finding.ruleId);
    return builder.build({
      rule: {
        recipeId: finding.ruleRecipeId,
        message: rule?.message ?? finding.message,
        severity: rule?.severity ?? finding.severity,
        ...(rule?.fixSuggestion ? { suggestedFix: rule.fixSuggestion } : {}),
      },
      risk: {
        message: finding.snippet ? `${finding.message}: ${finding.snippet}` : finding.message,
        severity: finding.severity,
        ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
      },
      location: {
        ...(finding.file ? { file: finding.file } : {}),
        ...(finding.line === undefined ? {} : { line: finding.line }),
      },
      feedback: {
        capture: {
          title: `Guard finding for ${finding.ruleRecipeId}`,
          body: finding.message,
        },
        rescan: {
          reason: `Refresh focused evidence for ${finding.ruleRecipeId}`,
        },
      },
      metadata: {
        source: "code.guard",
        ruleId: finding.ruleId,
        language: finding.language,
        column: finding.column,
        category: finding.category,
      },
    });
  });
}

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

async function ripgrepSearch(
  pattern: string,
  cwd: string,
  input: {
    readonly glob?: string;
    readonly maxResults: number;
    readonly contextLines: number;
    readonly regex: boolean;
  },
): Promise<{ readonly matches: SearchMatch[]; readonly total: number }> {
  const args = [
    "--json",
    "--max-count",
    String(input.maxResults),
    ...(input.contextLines > 0 ? ["--context", String(input.contextLines)] : []),
    "--no-heading",
    "--color",
    "never",
  ];
  for (const ignored of IGNORED_DIRECTORIES) {
    args.push("--glob", `!${ignored}`);
  }
  if (input.glob) {
    args.push("--glob", input.glob);
  }
  if (!input.regex) {
    args.push("--fixed-strings");
  }
  args.push("--", pattern, "./");

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseRipgrepJson(Buffer.concat(chunks).toString("utf8"), pattern);
      if (code === 0 || code === 1 || parsed.matches.length > 0) {
        resolve(parsed);
        return;
      }
      reject(new Error(`rg exited with code ${code}`));
    });
  });
}

function parseRipgrepJson(
  output: string,
  pattern: string,
): { readonly matches: SearchMatch[]; readonly total: number } {
  const matches: SearchMatch[] = [];
  let total = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line) as {
        readonly type?: string;
        readonly data?: {
          readonly path?: { readonly text?: string };
          readonly line_number?: number;
          readonly lines?: { readonly text?: string };
          readonly stats?: { readonly matches?: number };
        };
      };
      if (record.type === "match") {
        const file = record.data?.path?.text?.replace(/^\.\//, "") ?? "";
        matches.push({
          file,
          line: record.data?.line_number ?? 0,
          content: (record.data?.lines?.text ?? "").trimEnd(),
          pattern,
        });
        total += 1;
      }
      if (record.type === "summary") {
        total = record.data?.stats?.matches ?? total;
      }
    } catch {
      // ripgrep JSON can include partial lines if the process is interrupted; ignore them.
    }
  }
  return { matches, total };
}

async function fallbackSearch(
  pattern: string,
  root: string,
  input: {
    readonly glob?: string;
    readonly maxResults: number;
    readonly contextLines: number;
    readonly regex: boolean;
  },
): Promise<{ readonly matches: SearchMatch[]; readonly total: number }> {
  let matcher: RegExp;
  try {
    matcher = input.regex ? new RegExp(pattern, "i") : new RegExp(escapeRegex(pattern), "i");
  } catch {
    return { matches: [], total: 0 };
  }

  const files = await listFiles(root, ".", 8);
  const matches: SearchMatch[] = [];
  let total = 0;
  for (const relativePath of files) {
    if (!matchesGlob(relativePath, input.glob) || matches.length >= input.maxResults) {
      continue;
    }
    let content: string;
    try {
      content = await readFile(path.join(root, relativePath), "utf8");
    } catch {
      continue;
    }
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      matcher.lastIndex = 0;
      if (!matcher.test(line)) {
        continue;
      }
      total += 1;
      if (matches.length < input.maxResults) {
        matches.push({ file: relativePath, line: index + 1, content: line.trimEnd(), pattern });
      }
    }
  }
  return { matches, total };
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
  const patterns = [
    ...optionalStringArray(input.patterns),
    ...optionalStringArray(input.pattern),
  ].slice(0, 10);
  if (patterns.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.search patterns cannot be empty." },
    };
  }
  const maxResults = boundedInteger(input.maxResults, 10, 50);
  const contextLines = boundedInteger(input.contextLines, 2, 8, 0);
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

function parseCodeWriteInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly path: string;
        readonly content: string;
        readonly createDirectories: boolean;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.write input must be an object." },
    };
  }
  const targetPath = stringValue(input.path);
  if (!targetPath || typeof input.content !== "string") {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.write requires path and content." },
    };
  }
  return {
    ok: true,
    input: {
      path: targetPath,
      content: input.content,
      createDirectories: input.createDirectories === true,
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

async function buildAstOutline(
  relativePath: string,
  content: string,
  dependencies: ToolRuntimeDependencies,
  options: { readonly kinds?: readonly string[]; readonly maxDepth: number },
) {
  const parser = dependencies.astParser ?? new StructuralMainlineAstParser();
  const parsed = await parser.parse({ path: relativePath, content });
  if (parsed.status !== "parsed") {
    return null;
  }
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const symbols = parsed.symbols
    .filter((symbol) => !kinds || kinds.has(symbol.kind))
    .filter((symbol) => symbolDepth(symbol) <= options.maxDepth)
    .map((symbol) => formatSymbol(symbol));
  const language = defaultMainlineLanguageCatalog.displayName(parsed.languageId);
  const lineCount = content.split(/\r?\n/).length;
  const text = [
    `// ${relativePath} — ${lineCount} lines, ${language}, mainline structural AST`,
    "",
    ...symbols.map((symbol) => symbol.text),
  ].join("\n");
  return {
    path: relativePath,
    languageId: parsed.languageId,
    status: parsed.status,
    count: symbols.length,
    symbols: symbols.map(({ text: _text, ...symbol }) => symbol),
    text,
  };
}

async function outlineForLargeFile(
  absolutePath: string,
  relativePath: string,
  content: string,
  dependencies: ToolRuntimeDependencies,
): Promise<string> {
  try {
    const outline = await buildAstOutline(relativePath, content, dependencies, { maxDepth: 8 });
    if (outline?.text) {
      return `${outline.text}\n\nFile is large. Use startLine/endLine for specific sections.`;
    }
  } catch {
    // Fall back to head/tail preview below.
  }
  const lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
  const head = numberLines(lines.slice(0, 30), 1);
  const tailStart = Math.max(1, lines.length - 14);
  const tail = numberLines(lines.slice(tailStart - 1), tailStart);
  return [
    `// ${relativePath} — ${lines.length} lines, showing head and tail`,
    "",
    head,
    "",
    `... [${Math.max(0, lines.length - 45)} lines omitted] ...`,
    "",
    tail,
  ].join("\n");
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

async function buildDirectoryTree(
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  currentDepth = 0,
): Promise<string> {
  const directoryStat = await stat(absoluteDirectory);
  if (!directoryStat.isDirectory()) {
    return "";
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const lines: string[] = currentDepth === 0 ? [`${relativeDirectory}/`] : [];
  const indent = "  ".repeat(currentDepth + (currentDepth === 0 ? 0 : 1));
  const directories: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") {
      continue;
    }
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        directories.push(entry.name);
      }
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  for (const directory of directories.sort()) {
    lines.push(`${indent}${directory}/`);
    if (currentDepth < depth - 1) {
      const child = await buildDirectoryTree(
        path.join(absoluteDirectory, directory),
        normalizeRelativePath(path.join(relativeDirectory, directory)),
        depth,
        currentDepth + 1,
      );
      if (child) {
        lines.push(child);
      }
    }
  }
  for (const file of files.sort()) {
    lines.push(`${indent}${file}`);
  }
  return lines.join("\n");
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

function isProtectedWritePath(relativePath: string): boolean {
  return PROTECTED_WRITE_PATHS.some(
    (protectedPath) =>
      relativePath === protectedPath ||
      relativePath.startsWith(`${protectedPath}/`) ||
      relativePath.includes(`/${protectedPath}/`),
  );
}

function formatSearchMatch(match: SearchMatch) {
  return {
    file: match.file,
    path: match.file,
    line: match.line,
    content: match.content,
    pattern: match.pattern,
  };
}

function formatSearchText(matches: readonly SearchMatch[], total: number): string {
  return `${total} matches (showing ${matches.length})\n\n${matches
    .map((match) => `${match.file}:${match.line}: ${match.content}`)
    .join("\n")}`;
}

function deduplicateMatches(matches: readonly SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.file}:${match.line}:${match.pattern}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isSearchPayload(
  value: unknown,
): value is Record<string, unknown> & { readonly count: number } {
  return isRecord(value) && typeof value.count === "number" && Array.isArray(value.matches);
}

function numberLines(lines: readonly string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}|${line}`).join("\n");
}

function formatSymbol(symbol: MainlineSourceSymbol) {
  const containerPrefix = symbol.containerName ? `${symbol.containerName}.` : "";
  const line = symbol.startLine ?? 0;
  const text = `${"  ".repeat(symbolDepth(symbol))}${symbol.kind} ${containerPrefix}${symbol.name} [${line}]`;
  return {
    name: symbol.name,
    kind: symbol.kind,
    line,
    containerName: symbol.containerName ?? null,
    isExported: symbol.isExported === true,
    text,
  };
}

function symbolDepth(symbol: MainlineSourceSymbol): number {
  return symbol.containerName ? 1 : 0;
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

function boundedInteger(
  value: unknown,
  fallback: number,
  max: number,
  min = 1,
): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    return undefined;
  }
  return Math.min(value, max);
}

function optionalStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}
