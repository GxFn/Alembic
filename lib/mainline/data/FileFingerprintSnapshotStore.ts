import { createHash } from "node:crypto";
import path from "node:path";
import type { MainlineAtomicFileStore, MainlineZonedPath } from "./JsonStores.js";
import { MainlineJsonDocumentStore } from "./JsonStores.js";

export interface MainlineFileFingerprintInput {
  readonly path: string;
  readonly content?: string | Buffer;
  readonly contentHash?: string;
}

export interface MainlineFileFingerprintSnapshot {
  readonly id: string;
  readonly projectRoot: string;
  readonly files: Record<string, string>;
  readonly createdAt: number;
  readonly metadata?: Record<string, unknown>;
}

export interface MainlineFileFingerprintSnapshotInput {
  readonly id: string;
  readonly projectRoot: string;
  readonly files: readonly MainlineFileFingerprintInput[];
  readonly createdAt: number;
  readonly metadata?: Record<string, unknown>;
  readonly filters?: MainlineFileFingerprintFilters;
}

export interface MainlineFileFingerprintFilters {
  readonly ignoredSegments?: readonly string[];
  readonly ignoredPrefixes?: readonly string[];
  readonly excludeGeneratedProjectFiles?: boolean;
}

export interface MainlineFileFingerprintSnapshotDiff {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
  readonly unchanged: string[];
  readonly changeRatio: number;
}

const DEFAULT_IGNORED_SEGMENTS = [".asd", ".git", "node_modules"] as const;
const DEFAULT_IGNORED_PREFIXES = ["docs-dev/"] as const;
const GENERATED_PROJECT_FILES = new Set([
  "AGENTS.md",
  ".cursorrules",
  ".cursor/rules/alembic.mdc",
  ".vscode/mcp.json",
]);

/**
 * FileFingerprintSnapshotStore 保存文件内容指纹快照。
 * 索引快照边界：调用方传入已枚举文件，本类只做持久化和 diff，不在运行期扫描 Markdown。
 */
export class FileFingerprintSnapshotStore {
  readonly #document: MainlineJsonDocumentStore<MainlineFileFingerprintSnapshot>;

  constructor(target: MainlineZonedPath, fileStore: MainlineAtomicFileStore) {
    this.#document = new MainlineJsonDocumentStore(target, fileStore);
  }

  load(): Promise<MainlineFileFingerprintSnapshot | null> {
    return this.#document.load();
  }

  async save(snapshot: MainlineFileFingerprintSnapshot): Promise<void> {
    await this.#document.save(normalizeSnapshot(snapshot));
  }

  async diffAndSave(
    next: MainlineFileFingerprintSnapshot,
  ): Promise<MainlineFileFingerprintSnapshotDiff> {
    const previous = await this.load();
    const normalizedNext = normalizeSnapshot(next);
    const diff = diffMainlineFileFingerprintSnapshots(previous?.files ?? {}, normalizedNext.files);
    await this.#document.save(normalizedNext);
    return diff;
  }
}

export function createMainlineFileFingerprintSnapshot(
  input: MainlineFileFingerprintSnapshotInput,
): MainlineFileFingerprintSnapshot {
  const files: Record<string, string> = {};
  for (const file of input.files) {
    const relativePath = normalizeFingerprintPath(file.path, input.projectRoot);
    if (isMainlineFingerprintIgnoredPath(relativePath, input.filters)) {
      continue;
    }
    files[relativePath] = file.contentHash ?? computeContentHash(file.content ?? "");
  }

  return normalizeSnapshot({
    id: input.id,
    projectRoot: path.resolve(input.projectRoot),
    files,
    createdAt: input.createdAt,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}

export function diffMainlineFileFingerprintSnapshots(
  previous: Record<string, string>,
  current: Record<string, string>,
): MainlineFileFingerprintSnapshotDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];

  for (const [filePath, contentHash] of Object.entries(current)) {
    if (!(filePath in previous)) {
      added.push(filePath);
    } else if (previous[filePath] !== contentHash) {
      modified.push(filePath);
    } else {
      unchanged.push(filePath);
    }
  }
  for (const filePath of Object.keys(previous)) {
    if (!(filePath in current)) {
      deleted.push(filePath);
    }
  }

  const total = added.length + modified.length + deleted.length + unchanged.length;
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    unchanged: unchanged.sort(),
    changeRatio: total === 0 ? 0 : (added.length + modified.length + deleted.length) / total,
  };
}

export function isMainlineFingerprintIgnoredPath(
  filePath: string,
  filters: MainlineFileFingerprintFilters = {},
): boolean {
  const normalized = normalizePosixPath(filePath);
  const ignoredSegments = filters.ignoredSegments ?? DEFAULT_IGNORED_SEGMENTS;
  const ignoredPrefixes = filters.ignoredPrefixes ?? DEFAULT_IGNORED_PREFIXES;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => ignoredSegments.includes(segment))) {
    return true;
  }
  if (
    ignoredPrefixes.some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
    )
  ) {
    return true;
  }
  return filters.excludeGeneratedProjectFiles !== false && GENERATED_PROJECT_FILES.has(normalized);
}

function normalizeSnapshot(
  snapshot: MainlineFileFingerprintSnapshot,
): MainlineFileFingerprintSnapshot {
  return {
    id: snapshot.id,
    projectRoot: path.resolve(snapshot.projectRoot),
    files: Object.fromEntries(
      Object.entries(snapshot.files)
        .map(([filePath, contentHash]) => [normalizePosixPath(filePath), contentHash] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    createdAt: snapshot.createdAt,
    ...(snapshot.metadata === undefined ? {} : { metadata: { ...snapshot.metadata } }),
  };
}

function normalizeFingerprintPath(filePath: string, projectRoot: string): string {
  const absolute = path.resolve(projectRoot, filePath);
  return normalizePosixPath(path.relative(path.resolve(projectRoot), absolute));
}

function normalizePosixPath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function computeContentHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
