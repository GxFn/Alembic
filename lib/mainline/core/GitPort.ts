import { execFile } from "node:child_process";
import type { MainlineFileChangeEvent } from "./FileWatch.js";
import { normalizeMainlinePosixPath } from "./PathIdentity.js";

export type MainlineGitStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface MainlineGitChangedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: MainlineGitStatus;
  readonly staged: boolean;
}

export interface MainlineGitChangeSet {
  readonly files: MainlineGitChangedFile[];
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
}

export interface MainlineGitPort {
  isRepository(projectRoot: string): Promise<boolean>;
  currentBranch(projectRoot: string): Promise<string | null>;
  headSha(projectRoot: string): Promise<string | null>;
  changedFiles(projectRoot: string): Promise<MainlineGitChangedFile[]>;
  changeSet(projectRoot: string): Promise<MainlineGitChangeSet>;
  diff(projectRoot: string, relativePath?: string): Promise<string | null>;
}

export class UnavailableMainlineGit implements MainlineGitPort {
  async isRepository(_projectRoot: string): Promise<boolean> {
    return false;
  }

  async currentBranch(_projectRoot: string): Promise<string | null> {
    return null;
  }

  async headSha(_projectRoot: string): Promise<string | null> {
    return null;
  }

  async changedFiles(_projectRoot: string): Promise<MainlineGitChangedFile[]> {
    return [];
  }

  async changeSet(_projectRoot: string): Promise<MainlineGitChangeSet> {
    return buildMainlineGitChangeSet([]);
  }

  async diff(_projectRoot: string, _relativePath?: string): Promise<string | null> {
    return null;
  }
}

export class GitCliMainlineGit implements MainlineGitPort {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async isRepository(projectRoot: string): Promise<boolean> {
    const output = await this.#git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  }

  async currentBranch(projectRoot: string): Promise<string | null> {
    return nonEmptyOrNull(await this.#git(projectRoot, ["branch", "--show-current"]));
  }

  async headSha(projectRoot: string): Promise<string | null> {
    return nonEmptyOrNull(await this.#git(projectRoot, ["rev-parse", "HEAD"]));
  }

  async changedFiles(projectRoot: string): Promise<MainlineGitChangedFile[]> {
    const [unstaged, staged, untracked] = await Promise.all([
      this.#git(projectRoot, ["diff", "--name-status"]),
      this.#git(projectRoot, ["diff", "--name-status", "--cached"]),
      this.#git(projectRoot, ["ls-files", "--others", "--exclude-standard"]),
    ]);

    return [
      ...parseGitNameStatus(unstaged, false),
      ...parseGitNameStatus(staged, true),
      ...parseGitUntracked(untracked),
    ];
  }

  async changeSet(projectRoot: string): Promise<MainlineGitChangeSet> {
    return buildMainlineGitChangeSet(await this.changedFiles(projectRoot));
  }

  async diff(projectRoot: string, relativePath?: string): Promise<string | null> {
    const args = relativePath
      ? ["diff", "HEAD", "-U0", "--", relativePath]
      : ["diff", "HEAD", "-U0"];
    return nonEmptyOrNull(await this.#git(projectRoot, args));
  }

  async #git(projectRoot: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        "git",
        [...args],
        { cwd: projectRoot, encoding: "utf8", timeout: this.#timeoutMs },
        (error, stdout) => {
          resolve(error ? "" : stdout.trim());
        },
      );
    });
  }
}

export function buildMainlineGitChangeSet(
  files: readonly MainlineGitChangedFile[],
): MainlineGitChangeSet {
  const normalized = dedupeGitChangedFiles(files);
  return {
    files: normalized,
    stagedCount: normalized.filter((file) => file.staged).length,
    unstagedCount: normalized.filter((file) => !file.staged && file.status !== "untracked").length,
    untrackedCount: normalized.filter((file) => file.status === "untracked").length,
  };
}

export function parseGitNameStatus(output: string, staged: boolean): MainlineGitChangedFile[] {
  const files: MainlineGitChangedFile[] = [];
  for (const line of splitGitLines(output)) {
    const parts = line.split("\t");
    const statusCode = parts[0]?.[0];
    if (!statusCode) {
      continue;
    }
    if (statusCode === "R" && parts[1] && parts[2]) {
      files.push({
        status: "renamed",
        oldPath: normalizeGitPath(parts[1]),
        path: normalizeGitPath(parts[2]),
        staged,
      });
      continue;
    }
    const filePath = normalizeGitPath(parts[1] ?? "");
    if (!filePath) {
      continue;
    }
    files.push({
      status: statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : "modified",
      path: filePath,
      staged,
    });
  }
  return files;
}

export function parseGitUntracked(output: string): MainlineGitChangedFile[] {
  return splitGitLines(output)
    .map((filePath) => normalizeGitPath(filePath))
    .filter(Boolean)
    .map((filePath) => ({
      status: "untracked" as const,
      path: filePath,
      staged: false,
    }));
}

export function gitChangedFileToFileEvent(file: MainlineGitChangedFile): MainlineFileChangeEvent {
  return {
    type:
      file.status === "renamed"
        ? "renamed"
        : file.status === "deleted"
          ? "deleted"
          : file.status === "added" || file.status === "untracked"
            ? "created"
            : "modified",
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    source: "git-worktree",
    timestamp: Date.now(),
  };
}

function dedupeGitChangedFiles(files: readonly MainlineGitChangedFile[]): MainlineGitChangedFile[] {
  const byKey = new Map<string, MainlineGitChangedFile>();
  for (const file of files) {
    const key = `${file.staged ? "staged" : "worktree"}:${file.oldPath ?? ""}:${file.path}`;
    byKey.set(key, file);
  }
  return [...byKey.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function splitGitLines(output: string): string[] {
  return (output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeGitPath(filePath: string): string {
  return normalizeMainlinePosixPath(filePath);
}

function nonEmptyOrNull(output: string): string | null {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}
