import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MainlinePrimeRunner,
  type MainlinePrimeRunnerRequest,
} from "../mainline/agent/MainlinePrimeRunner.js";
import type { ActiveWorkContext, RuntimeError } from "../mainline/knowledge/index.js";
import {
  InMemoryMainlineSearchIndex,
  type MainlineSearchDocument,
  type MainlineSearchIndex,
} from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { inspectWorkspace } from "./workspace.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface CodexPrimeCompletedResult {
  readonly status: "completed";
  readonly markdown: string;
  readonly recipeIds: readonly string[];
  readonly searchHitCount: number;
  readonly hints: readonly string[];
  readonly activeContext: CodexPrimeActiveContextSummary;
  readonly dataRoot: string;
  readonly projectRoot: string;
}

export interface CodexPrimeUnavailableResult {
  readonly status: "uninitialized" | "missing-runtime-snapshot" | "error";
  readonly message: string;
  readonly markdown: "";
  readonly recipeIds: readonly [];
  readonly searchHitCount: 0;
  readonly hints: readonly string[];
  readonly activeContext: CodexPrimeActiveContextSummary;
  readonly dataRoot: string;
  readonly projectRoot: string;
}

export type CodexPrimeResult = CodexPrimeCompletedResult | CodexPrimeUnavailableResult;

export interface CodexPrimeActiveContextSummary {
  readonly projectRoot: string;
  readonly taskText?: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly hasDiff: boolean;
  readonly errorCount: number;
  readonly commandIntent?: string;
  readonly userFocus?: string;
}

interface SanitizedCodexPrimeInput {
  readonly projectRoot?: string;
  readonly taskText?: string;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly diff?: string;
  readonly errors: readonly RuntimeError[];
  readonly commandIntent?: string;
  readonly userFocus?: string;
  readonly limit: number;
}

/**
 * Codex prime 是 MCP 层的只读运行期入口：只恢复 dataRoot 内已编译索引，
 * 避免回扫 Markdown、启动 daemon 或触发 bootstrap/rescan 这类长任务。
 */
export async function runCodexPrime(args: Record<string, unknown> = {}): Promise<CodexPrimeResult> {
  const input = sanitizeCodexPrimeInput(args);
  const workspace = inspectWorkspace(input.projectRoot);
  const activeContext = activeContextFromInput(workspace.projectRoot, input);
  const activeSummary = summarizeActiveContext(activeContext);

  if (!workspace.initialized) {
    return unavailable(
      "uninitialized",
      "Alembic workspace is not initialized.",
      workspace,
      ["run_alembic_init_first"],
      activeSummary,
    );
  }

  const contextSnapshotPath = join(workspace.runtimeDir, "context", "context-index.json");
  const searchSnapshotPath = join(workspace.runtimeDir, "context", "search-index.json");
  if (!existsSync(contextSnapshotPath) || !existsSync(searchSnapshotPath)) {
    return unavailable(
      "missing-runtime-snapshot",
      "Alembic runtime snapshots are missing. Run bootstrap or rescan before prime.",
      workspace,
      ["run_bootstrap_or_rescan_first"],
      activeSummary,
    );
  }

  try {
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
    });
    const searchIndex = restoreReadOnlySearchIndex(persistence.searchIndex.snapshot(), input.limit);
    const result = await new MainlinePrimeRunner({
      contextIndex: persistence.contextIndex,
      searchIndex,
    }).run(activeContext);

    return {
      status: "completed",
      markdown: result.markdown,
      recipeIds: result.recipeIds,
      searchHitCount: result.searchHitCount,
      hints: result.hints,
      activeContext: summarizeActiveContext(result.activeContext),
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
    };
  } catch (error) {
    return unavailable(
      "error",
      error instanceof Error ? error.message : "Codex prime failed.",
      workspace,
      ["prime_failed"],
      activeSummary,
    );
  }
}

function sanitizeCodexPrimeInput(args: Record<string, unknown>): SanitizedCodexPrimeInput {
  const limit = clampLimit(args.limit);
  const projectRoot = stringValue(args.projectRoot);
  const taskText = stringValue(args.task) ?? stringValue(args.prompt);
  const diff = stringValue(args.diff);
  const commandIntent = stringValue(args.commandIntent);
  const userFocus = stringValue(args.userFocus);
  return {
    ...(projectRoot ? { projectRoot } : {}),
    ...(taskText ? { taskText } : {}),
    files: stringList(args.files).slice(0, limit),
    symbols: stringList(args.symbols).slice(0, limit),
    ...(diff ? { diff } : {}),
    errors: [...errorList(args.errors), ...errorList(args.diagnostics)].slice(0, limit),
    ...(commandIntent ? { commandIntent } : {}),
    ...(userFocus ? { userFocus } : {}),
    limit,
  };
}

function activeContextFromInput(
  projectRoot: string,
  input: SanitizedCodexPrimeInput,
): MainlinePrimeRunnerRequest {
  return {
    projectRoot,
    ...(input.taskText ? { taskText: input.taskText } : {}),
    files: input.files,
    symbols: input.symbols,
    ...(input.diff ? { diff: input.diff } : {}),
    errors: input.errors,
    ...(input.commandIntent ? { commandIntent: input.commandIntent } : {}),
    ...(input.userFocus ? { userFocus: input.userFocus } : {}),
  };
}

function summarizeActiveContext(
  activeContext: ActiveWorkContext | MainlinePrimeRunnerRequest,
): CodexPrimeActiveContextSummary {
  return {
    projectRoot: activeContext.projectRoot,
    ...(activeContext.taskText ? { taskText: activeContext.taskText } : {}),
    files: activeContext.files ?? [],
    symbols: activeContext.symbols ?? [],
    hasDiff: Boolean(activeContext.diff),
    errorCount: activeContext.errors?.length ?? 0,
    ...(activeContext.commandIntent ? { commandIntent: activeContext.commandIntent } : {}),
    ...(activeContext.userFocus ? { userFocus: activeContext.userFocus } : {}),
  };
}

function restoreReadOnlySearchIndex(
  documents: readonly MainlineSearchDocument[],
  limit: number,
): MainlineSearchIndex {
  const searchIndex = new InMemoryMainlineSearchIndex();
  searchIndex.upsert(documents);
  return {
    search: (query) =>
      searchIndex.search({ ...query, limit: Math.min(query.limit ?? limit, limit) }),
    snapshot: () => searchIndex.snapshot(),
    upsert: () => undefined,
    remove: () => undefined,
  };
}

function unavailable(
  status: CodexPrimeUnavailableResult["status"],
  message: string,
  workspace: { readonly dataRoot: string; readonly projectRoot: string },
  hints: readonly string[],
  activeContext: CodexPrimeActiveContextSummary,
): CodexPrimeUnavailableResult {
  return {
    status,
    message,
    markdown: "",
    recipeIds: [],
    searchHitCount: 0,
    hints,
    activeContext,
    dataRoot: workspace.dataRoot,
    projectRoot: workspace.projectRoot,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(stringValue).filter((entry): entry is string => Boolean(entry)))];
}

function errorList(value: unknown): RuntimeError[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const message = entry.trim();
      return message ? [{ message }] : [];
    }
    if (!isRecord(entry)) {
      return [];
    }
    const message = stringValue(entry.message) ?? stringValue(entry.text);
    if (!message) {
      return [];
    }
    const file = stringValue(entry.file);
    const line = numberValue(entry.line);
    const stack = stringValue(entry.stack);
    const error: RuntimeError = {
      message,
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(stack ? { stack } : {}),
    };
    return [error];
  });
}

function clampLimit(value: unknown): number {
  const number = numberValue(value);
  if (!number) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(number)));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
