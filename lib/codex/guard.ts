import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  loadGuardRulesFromRecipes,
  MainlineGuardCheckEngine,
  type MainlineGuardCheckOptions,
  type MainlineGuardCheckResult,
  type MainlineGuardFile,
} from "../guard/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { inspectWorkspace, type WorkspaceInspection } from "./workspace.js";

export interface CodexGuardResult {
  readonly status:
    | "completed"
    | "invalid-input"
    | "missing-runtime-snapshot"
    | "no-files"
    | "uninitialized"
    | "unsupported-scope";
  readonly message: string;
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly summary?: MainlineGuardCheckResult["summary"];
  readonly findings?: MainlineGuardCheckResult["findings"];
  readonly warnings?: readonly string[];
}

interface ParsedGuardInput {
  readonly files: readonly ParsedGuardFile[];
  readonly options: MainlineGuardCheckOptions;
}

interface ParsedGuardFile {
  readonly path: string;
  readonly content?: string;
  readonly language?: string;
}

export async function runCodexGuard(args: Record<string, unknown> = {}): Promise<CodexGuardResult> {
  // 中文注释：Guard 可以被 CLI/MCP 显式指定 projectRoot；不指定时才回退到当前进程环境。
  // 这样测试、daemon 和未来多 IDE adapter 不会互相污染工作区选择。
  const workspace = inspectWorkspace(stringValue(args.projectRoot));
  if (!workspace.initialized) {
    return statusResult(workspace, "uninitialized", "Alembic workspace is not initialized.");
  }
  if (!existsSync(path.join(workspace.runtimeDir, "context", "context-index.json"))) {
    return statusResult(
      workspace,
      "missing-runtime-snapshot",
      "Alembic runtime context snapshot is missing. Run bootstrap or rescan first.",
    );
  }

  const parsed = parseGuardInput(args);
  if (parsed.status !== "ok") {
    return statusResult(workspace, parsed.status, parsed.message);
  }

  const files = await materializeFiles(workspace, parsed.input.files);
  if (files.status !== "ok") {
    return statusResult(workspace, files.status, files.message);
  }

  // Guard 只读 dataRoot 里的已编译 Recipe；这里不扫描 Markdown，也不执行 git/shell。
  const persistence = await createMainlineWorkflowPersistence({
    projectRoot: workspace.projectRoot,
    dataRoot: workspace.dataRoot,
    mode: workspace.mode,
  });
  const recipes = persistence.contextIndex.snapshot().recipes;
  const loaded = loadGuardRulesFromRecipes(recipes);
  const result = new MainlineGuardCheckEngine({ rules: loaded.rules }).check({
    files: files.files,
    options: parsed.input.options,
  });
  const warnings =
    loaded.rules.length === 0
      ? [...loaded.warnings, "No active guard-rule Recipes were found in the runtime snapshot."]
      : [...loaded.warnings, ...result.warnings];

  return {
    status: "completed",
    message: "Guard check completed.",
    projectRoot: workspace.projectRoot,
    dataRoot: workspace.dataRoot,
    summary: result.summary,
    findings: result.findings,
    warnings,
  };
}

function parseGuardInput(args: Record<string, unknown>):
  | { readonly status: "ok"; readonly input: ParsedGuardInput }
  | {
      readonly status: "invalid-input" | "no-files" | "unsupported-scope";
      readonly message: string;
    } {
  const options = parseOptions(args);
  if (!options.ok) {
    return { status: "invalid-input", message: options.message };
  }

  const inlineCode = stringValue(args.code);
  if (inlineCode) {
    const filePath = stringValue(args.filePath) ?? stringValue(args.path) ?? "<inline>";
    const language = stringValue(args.language);
    return {
      status: "ok",
      input: {
        files: [
          {
            path: filePath,
            content: inlineCode,
            ...(language ? { language } : {}),
          },
        ],
        options: options.options,
      },
    };
  }

  if (args.files !== undefined) {
    const files = parseFiles(args.files);
    if (!files) {
      return {
        status: "invalid-input",
        message: "alembic_guard files must be path strings or objects with path/content.",
      };
    }
    if (files.length === 0) {
      return { status: "no-files", message: "alembic_guard files cannot be empty." };
    }
    return { status: "ok", input: { files, options: options.options } };
  }

  return {
    status: "unsupported-scope",
    message: "Diff scope is not implemented in the Codex Guard helper yet.",
  };
}

function parseFiles(value: unknown): ParsedGuardFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const files: ParsedGuardFile[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const filePath = stringValue(item);
      if (!filePath) {
        return null;
      }
      files.push({ path: filePath });
      continue;
    }
    if (!isRecord(item)) {
      return null;
    }
    const filePath = stringValue(item.path);
    if (!filePath) {
      return null;
    }
    const content = typeof item.content === "string" ? item.content : undefined;
    const language = stringValue(item.language);
    files.push({
      path: filePath,
      ...(content !== undefined ? { content } : {}),
      ...(language ? { language } : {}),
    });
  }
  return files;
}

async function materializeFiles(
  workspace: WorkspaceInspection,
  files: readonly ParsedGuardFile[],
): Promise<
  | { readonly status: "ok"; readonly files: readonly MainlineGuardFile[] }
  | { readonly status: "invalid-input"; readonly message: string }
> {
  const materialized: MainlineGuardFile[] = [];
  for (const file of files) {
    const resolved = await resolveProjectFile(workspace.projectRoot, file.path, {
      mustExist: file.content === undefined,
    });
    if (!resolved.ok) {
      return { status: "invalid-input", message: resolved.message };
    }

    const content = file.content ?? (await fs.readFile(resolved.absolutePath, "utf8"));
    materialized.push({
      path: resolved.relativePath,
      content,
      ...(file.language ? { language: file.language } : {}),
    });
  }
  return { status: "ok", files: materialized };
}

async function resolveProjectFile(
  projectRoot: string,
  filePath: string,
  options: { readonly mustExist: boolean },
): Promise<
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly message: string }
> {
  if (filePath === "<inline>") {
    return { ok: true, absolutePath: path.join(projectRoot, filePath), relativePath: filePath };
  }

  const root = await fs.realpath(projectRoot);
  const lexicalAbsolute = path.resolve(root, filePath);
  if (!isWithin(root, lexicalAbsolute)) {
    return { ok: false, message: `Guard file path is outside projectRoot: ${filePath}` };
  }

  let absolutePath = lexicalAbsolute;
  if (options.mustExist) {
    try {
      absolutePath = await fs.realpath(lexicalAbsolute);
    } catch (error) {
      return {
        ok: false,
        message: `Guard file cannot be read: ${filePath} (${
          error instanceof Error ? error.message : "unknown error"
        })`,
      };
    }
    if (!isWithin(root, absolutePath)) {
      return { ok: false, message: `Guard file path is outside projectRoot: ${filePath}` };
    }
  }

  return {
    ok: true,
    absolutePath,
    relativePath: toPosixPath(path.relative(root, absolutePath || lexicalAbsolute)),
  };
}

function parseOptions(
  args: Record<string, unknown>,
):
  | { readonly ok: true; readonly options: MainlineGuardCheckOptions }
  | { readonly ok: false; readonly message: string } {
  const nestedOptions = isRecord(args.options) ? args.options : {};
  const maxFindings = boundedInteger(args.maxFindings ?? nestedOptions.maxFindings, 1, 1000);
  const maxFindingsPerRule = boundedInteger(
    args.maxFindingsPerRule ?? nestedOptions.maxFindingsPerRule,
    1,
    100,
  );
  if ((args.maxFindings ?? nestedOptions.maxFindings) !== undefined && maxFindings === undefined) {
    return { ok: false, message: "alembic_guard maxFindings must be an integer from 1 to 1000." };
  }
  if (
    (args.maxFindingsPerRule ?? nestedOptions.maxFindingsPerRule) !== undefined &&
    maxFindingsPerRule === undefined
  ) {
    return {
      ok: false,
      message: "alembic_guard maxFindingsPerRule must be an integer from 1 to 100.",
    };
  }
  return {
    ok: true,
    options: {
      ...(maxFindings ? { maxFindings } : {}),
      ...(maxFindingsPerRule ? { maxFindingsPerRule } : {}),
    },
  };
}

function statusResult(
  workspace: WorkspaceInspection,
  status: CodexGuardResult["status"],
  message: string,
): CodexGuardResult {
  return {
    status,
    message,
    projectRoot: workspace.projectRoot,
    dataRoot: workspace.dataRoot,
  };
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
