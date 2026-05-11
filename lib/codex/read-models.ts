import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { MAINLINE_PROJECT_INTELLIGENCE_READ_MODEL_PATH } from "../mainline/graph/index.js";
import type { WorkspaceInspection } from "./workspace.js";

export const CODEX_CONTEXT_INDEX_READ_MODEL_PATH = "context/context-index.json";
export const CODEX_SEARCH_INDEX_READ_MODEL_PATH = "context/search-index.json";
export const CODEX_VECTOR_INDEX_READ_MODEL_PATH = "context/vector-index.json";

export interface CodexReadModelPaths {
  readonly contextSnapshotPath: string;
  readonly projectIntelligencePath: string;
  readonly searchSnapshotPath: string;
  readonly vectorSnapshotPath: string;
}

export interface CodexRuntimeReadiness {
  readonly initialized: boolean;
  readonly contextReady: boolean;
  readonly searchReady: boolean;
  readonly vectorReady: boolean;
  readonly projectIntelligenceReady: boolean;
}

/**
 * Codex public tools 只读 dataRoot/runtime 下的 mainline read models。
 * 这里不导入 lib/agent/tools，也不复用 internal Agent tool 的执行 envelope。
 */
export function codexReadModelPaths(workspace: WorkspaceInspection): CodexReadModelPaths {
  return {
    contextSnapshotPath: join(workspace.runtimeDir, CODEX_CONTEXT_INDEX_READ_MODEL_PATH),
    projectIntelligencePath: join(
      workspace.runtimeDir,
      MAINLINE_PROJECT_INTELLIGENCE_READ_MODEL_PATH,
    ),
    searchSnapshotPath: join(workspace.runtimeDir, CODEX_SEARCH_INDEX_READ_MODEL_PATH),
    vectorSnapshotPath: join(workspace.runtimeDir, CODEX_VECTOR_INDEX_READ_MODEL_PATH),
  };
}

export function inspectCodexRuntimeReadiness(
  workspace: WorkspaceInspection,
): CodexRuntimeReadiness {
  const paths = codexReadModelPaths(workspace);
  return {
    initialized: workspace.initialized,
    contextReady: existsSync(paths.contextSnapshotPath),
    searchReady: existsSync(paths.searchSnapshotPath),
    vectorReady: existsSync(paths.vectorSnapshotPath),
    projectIntelligenceReady: existsSync(paths.projectIntelligencePath),
  };
}

export async function readCodexJsonModel<T>(
  filePath: string,
  label: string,
  warnings: string[],
): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    warnings.push(`${label}_unreadable`);
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
