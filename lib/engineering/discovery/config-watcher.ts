import path from "node:path";
import {
  BUILTIN_CUSTOM_CONFIG_PROFILES,
  type CustomConfigProfile,
  CustomConfigProfileRegistry,
} from "./custom-profiles.js";

export type ConfigChangeScope = "full" | "module" | "overlay";
export type ConfigWatcherChangeKind = "added" | "changed" | "removed";

export interface ConfigWatcherFileSnapshot {
  readonly path: string;
  readonly fingerprint: string;
  readonly profileIds?: readonly string[];
  readonly scope?: ConfigChangeScope;
  readonly moduleName?: string;
}

export interface ConfigWatcherChange {
  readonly path: string;
  readonly kind: ConfigWatcherChangeKind;
  readonly previousFingerprint?: string;
  readonly currentFingerprint?: string;
  readonly profileIds: readonly string[];
  readonly scope: ConfigChangeScope;
  readonly moduleName?: string;
}

export interface ConfigWatcherDiff {
  readonly added: readonly ConfigWatcherChange[];
  readonly changed: readonly ConfigWatcherChange[];
  readonly removed: readonly ConfigWatcherChange[];
  readonly rescanProfiles: readonly string[];
  readonly changedFiles: readonly ConfigWatcherChange[];
}

export interface ConfigWatcherOptions {
  readonly profiles?: readonly CustomConfigProfile[];
}

export class ConfigWatcher {
  readonly #profileRegistry: CustomConfigProfileRegistry;

  constructor(options: ConfigWatcherOptions = {}) {
    this.#profileRegistry = new CustomConfigProfileRegistry(
      options.profiles ?? BUILTIN_CUSTOM_CONFIG_PROFILES,
    );
  }

  diff(
    previous: readonly ConfigWatcherFileSnapshot[],
    current: readonly ConfigWatcherFileSnapshot[],
  ): ConfigWatcherDiff {
    return diffConfigSnapshots(previous, current, this.#profileRegistry.list());
  }

  static diff(
    previous: readonly ConfigWatcherFileSnapshot[],
    current: readonly ConfigWatcherFileSnapshot[],
    options: ConfigWatcherOptions = {},
  ): ConfigWatcherDiff {
    return new ConfigWatcher(options).diff(previous, current);
  }
}

export function diffConfigSnapshots(
  previous: readonly ConfigWatcherFileSnapshot[],
  current: readonly ConfigWatcherFileSnapshot[],
  profiles: readonly CustomConfigProfile[] = BUILTIN_CUSTOM_CONFIG_PROFILES,
): ConfigWatcherDiff {
  const previousByPath = snapshotMap(previous);
  const currentByPath = snapshotMap(current);
  const added: ConfigWatcherChange[] = [];
  const changed: ConfigWatcherChange[] = [];
  const removed: ConfigWatcherChange[] = [];

  for (const [filePath, currentFile] of currentByPath) {
    const previousFile = previousByPath.get(filePath);
    if (previousFile === undefined) {
      added.push(toChange(filePath, "added", undefined, currentFile, profiles));
    } else if (previousFile.fingerprint !== currentFile.fingerprint) {
      changed.push(toChange(filePath, "changed", previousFile, currentFile, profiles));
    }
  }

  for (const [filePath, previousFile] of previousByPath) {
    if (!currentByPath.has(filePath)) {
      removed.push(toChange(filePath, "removed", previousFile, undefined, profiles));
    }
  }

  const changedFiles = [...added, ...changed, ...removed].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const rescanProfiles = [...new Set(changedFiles.flatMap((change) => change.profileIds))].sort();

  return {
    added: added.sort(compareChanges),
    changed: changed.sort(compareChanges),
    removed: removed.sort(compareChanges),
    rescanProfiles,
    changedFiles,
  };
}

function snapshotMap(
  files: readonly ConfigWatcherFileSnapshot[],
): Map<string, ConfigWatcherFileSnapshot> {
  return new Map(files.map((file) => [normalizeSnapshotPath(file.path), file]));
}

function toChange(
  filePath: string,
  kind: ConfigWatcherChangeKind,
  previous: ConfigWatcherFileSnapshot | undefined,
  current: ConfigWatcherFileSnapshot | undefined,
  profiles: readonly CustomConfigProfile[],
): ConfigWatcherChange {
  const file = current ?? previous;
  const inferredProfileIds = inferProfileIds(filePath, profiles);
  const profileIds =
    file?.profileIds !== undefined && file.profileIds.length > 0
      ? file.profileIds
      : inferredProfileIds;
  const scope = file?.scope ?? inferChangeScope(filePath, profileIds);
  return {
    path: filePath,
    kind,
    ...(previous?.fingerprint === undefined ? {} : { previousFingerprint: previous.fingerprint }),
    ...(current?.fingerprint === undefined ? {} : { currentFingerprint: current.fingerprint }),
    profileIds,
    scope,
    ...(file?.moduleName === undefined
      ? inferModuleName(filePath, scope)
      : { moduleName: file.moduleName }),
  };
}

function inferProfileIds(
  filePath: string,
  profiles: readonly CustomConfigProfile[],
): readonly string[] {
  const ids = profiles
    .filter((profile) =>
      (profile.watchPatterns ?? profile.markers).some((pattern) =>
        pathMatchesPattern(filePath, pattern),
      ),
    )
    .map((profile) => profile.id);
  return ids.length === 0 ? ["customConfig"] : [...new Set(ids)].sort();
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeSnapshotPath(pattern);
  if (!normalizedPattern.includes("*")) {
    return filePath === normalizedPattern || filePath.endsWith(`/${normalizedPattern}`);
  }
  if (normalizedPattern.startsWith("**/")) {
    const suffix = normalizedPattern.slice(3);
    if (!suffix.includes("*")) {
      return filePath === suffix || filePath.endsWith(`/${suffix}`);
    }
  }
  const escaped = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function inferChangeScope(filePath: string, profileIds: readonly string[]): ConfigChangeScope {
  if (profileIds.includes("easybox")) {
    if (/\.(?:boxspec|podspec)$/i.test(filePath)) {
      return "module";
    }
    if (/\.(?:local|overlay)$/i.test(filePath) || filePath.includes(".local.")) {
      return "overlay";
    }
  }
  if (profileIds.includes("nx-monorepo") && /project\.json$/i.test(filePath)) {
    return "module";
  }
  if (profileIds.includes("cmake-multiproject") && /\/CMakeLists\.txt$/i.test(filePath)) {
    return filePath === "CMakeLists.txt" ? "full" : "module";
  }
  return "full";
}

function inferModuleName(
  filePath: string,
  scope: ConfigChangeScope,
): { readonly moduleName?: string } {
  if (scope !== "module") {
    return {};
  }
  const parts = filePath.split("/");
  const filename = parts.at(-1) ?? "";
  if (/\.(?:boxspec|podspec)$/i.test(filename)) {
    return { moduleName: filename.replace(/\.(?:boxspec|podspec)$/i, "") };
  }
  if (/project\.json$/i.test(filename) || /CMakeLists\.txt$/i.test(filename)) {
    const parent = parts.at(-2);
    return parent === undefined ? {} : { moduleName: parent };
  }
  return {};
}

function normalizeSnapshotPath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function compareChanges(left: ConfigWatcherChange, right: ConfigWatcherChange): number {
  return left.path.localeCompare(right.path);
}
