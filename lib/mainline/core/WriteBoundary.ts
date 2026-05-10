import path from "node:path";
import { MainlineWriteBoundaryError } from "./Errors.js";
import type { MainlineWorkspacePaths } from "./WorkspacePaths.js";

export type MainlineWriteZone = "project" | "data" | "global";

export interface MainlineZonedPath<Zone extends MainlineWriteZone = MainlineWriteZone> {
  readonly zone: Zone;
  readonly absolute: string;
  readonly relative: string;
}

export interface MainlineWriteBoundaryOptions {
  readonly workspacePaths: MainlineWorkspacePaths;
  readonly globalRoot?: string;
  readonly projectWritablePrefixes?: readonly string[];
  readonly projectWritableFiles?: readonly string[];
}

const DEFAULT_PROJECT_WRITABLE_PREFIXES = [".cursor", ".vscode", ".github"];
const DEFAULT_PROJECT_WRITABLE_FILES = [".gitignore", ".env"];

/**
 * MainlineWriteBoundary 是新主线的三区写入边界。
 * 它只做纯路径归属和项目写入范围判断，不导入旧 PathGuard 单例。
 */
export class MainlineWriteBoundary {
  readonly #workspacePaths: MainlineWorkspacePaths;
  readonly #globalRoot: string;
  readonly #projectWritablePrefixes: readonly string[];
  readonly #projectWritableFiles: readonly string[];

  constructor(options: MainlineWriteBoundaryOptions) {
    this.#workspacePaths = options.workspacePaths;
    this.#globalRoot = path.resolve(
      options.globalRoot ?? process.env.HOME ?? process.env.USERPROFILE ?? ".",
      ".asd",
    );
    this.#projectWritablePrefixes =
      options.projectWritablePrefixes ?? DEFAULT_PROJECT_WRITABLE_PREFIXES;
    this.#projectWritableFiles = options.projectWritableFiles ?? DEFAULT_PROJECT_WRITABLE_FILES;
  }

  project(relativePath: string): MainlineZonedPath<"project"> {
    const target = resolveInside(this.#workspacePaths.projectRoot, relativePath, "project");
    this.#assertProjectWritable(target.relative);
    return target;
  }

  data(relativePath: string): MainlineZonedPath<"data"> {
    return resolveInside(this.#workspacePaths.dataRoot, relativePath, "data");
  }

  runtime(relativePath: string): MainlineZonedPath<"data"> {
    return this.data(path.join(".asd", relativePath));
  }

  knowledge(relativePath: string): MainlineZonedPath<"data"> {
    return this.data(path.join("Alembic", relativePath));
  }

  global(relativePath: string): MainlineZonedPath<"global"> {
    return resolveInside(this.#globalRoot, relativePath, "global");
  }

  assert(target: MainlineZonedPath): void {
    const base = this.#baseForZone(target.zone);
    if (!isUnder(target.absolute, base)) {
      throw new MainlineWriteBoundaryError("Mainline write path escaped zone.", {
        zone: target.zone,
        target: target.absolute,
        base,
      });
    }
    if (target.zone === "project") {
      this.#assertProjectWritable(target.relative);
    }
  }

  #baseForZone(zone: MainlineWriteZone): string {
    switch (zone) {
      case "project":
        return this.#workspacePaths.projectRoot;
      case "data":
        return this.#workspacePaths.dataRoot;
      case "global":
        return this.#globalRoot;
    }
  }

  #assertProjectWritable(relativePath: string): void {
    const firstSegment = relativePath.split(path.sep)[0];
    if (this.#projectWritableFiles.includes(relativePath)) {
      return;
    }
    if (firstSegment !== undefined && this.#projectWritablePrefixes.includes(firstSegment)) {
      return;
    }
    throw new MainlineWriteBoundaryError("Project write is outside the mainline writable scope.", {
      relativePath,
      allowedPrefixes: this.#projectWritablePrefixes,
      allowedFiles: this.#projectWritableFiles,
    });
  }
}

function resolveInside<Zone extends MainlineWriteZone>(
  base: string,
  relativePath: string,
  zone: Zone,
): MainlineZonedPath<Zone> {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new MainlineWriteBoundaryError("Mainline write path must be relative.", {
      zone,
      relativePath,
    });
  }

  const absolute = path.resolve(base, relativePath);
  const normalizedBase = path.resolve(base);
  // 先 resolve 再做段边界判断，避免 `../`、符号化 `.`，以及 `/root2` 伪装成 `/root` 子路径。
  if (!isUnder(absolute, normalizedBase)) {
    throw new MainlineWriteBoundaryError("Mainline write path escaped zone.", {
      zone,
      relativePath,
      base: normalizedBase,
      absolute,
    });
  }

  return {
    zone,
    absolute,
    relative: path.relative(normalizedBase, absolute),
  };
}

function isUnder(target: string, base: string): boolean {
  const normalizedTarget = path.resolve(target);
  const normalizedBase = path.resolve(base);
  // 必须带 path.sep 做前缀判断，否则 `/tmp/app2` 会被误判为 `/tmp/app` 内部。
  return (
    normalizedTarget === normalizedBase ||
    normalizedTarget.startsWith(`${normalizedBase}${path.sep}`)
  );
}
