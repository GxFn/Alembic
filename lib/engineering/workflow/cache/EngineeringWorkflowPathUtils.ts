import { createHash } from "node:crypto";
import path from "node:path";
import type {
  EngineeringWorkflowFileFingerprint,
  EngineeringWorkflowFileInput,
  EngineeringWorkflowSnapshotDiagnostic,
} from "./EngineeringWorkflowCacheTypes.js";

const GENERATED_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "copilot-instructions.md"]);

export function computeEngineeringWorkflowContentHash(content: string): string {
  return createHash("sha256")
    .update(content || "")
    .digest("hex")
    .substring(0, 16);
}

export function toWorkflowPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

export function normalizeWorkflowProjectRoot(projectRoot: string): string {
  return toWorkflowPosixPath(path.resolve(projectRoot));
}

export function normalizeWorkflowFilePath(
  file: Pick<EngineeringWorkflowFileInput, "path" | "relativePath">,
  projectRoot: string,
): string {
  const rawPath = typeof file.path === "string" ? file.path : "";
  if (rawPath) {
    const relative = path.isAbsolute(rawPath) ? path.relative(projectRoot, rawPath) : rawPath;
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return toWorkflowPosixPath(relative);
    }
  }
  return toWorkflowPosixPath(file.relativePath || rawPath);
}

export function isEngineeringWorkflowGeneratedArtifact(filePath: string): boolean {
  const normalized = `/${toWorkflowPosixPath(filePath)}`;
  const basename = normalized.split("/").pop() || "";
  return (
    GENERATED_BASENAMES.has(basename) ||
    normalized.includes("/.cursor/") ||
    normalized.endsWith("/.github/copilot-instructions.md") ||
    basename.endsWith(".mdc")
  );
}

export function moduleNameForWorkflowPath(filePath: string): string {
  const segments = toWorkflowPosixPath(filePath).split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "(root)";
  }
  const first = segments[0] || "(root)";
  const second = segments[1];
  if (second && ["apps", "packages"].includes(first)) {
    return `${first}/${second}`;
  }
  if (second && !second.includes(".") && ["app", "lib", "src"].includes(first)) {
    return `${first}/${second}`;
  }
  return first;
}

export function buildWorkflowFileFingerprints(
  files: readonly EngineeringWorkflowFileInput[],
  projectRoot: string,
): {
  readonly fingerprints: Record<string, EngineeringWorkflowFileFingerprint>;
  readonly generatedSkipped: readonly string[];
  readonly diagnostics: readonly EngineeringWorkflowSnapshotDiagnostic[];
} {
  const fingerprints: Record<string, EngineeringWorkflowFileFingerprint> = {};
  const generatedSkipped: string[] = [];

  for (const file of files) {
    const normalizedPath = normalizeWorkflowFilePath(file, projectRoot);
    if (!normalizedPath) {
      continue;
    }
    if (file.isGenerated === true || isEngineeringWorkflowGeneratedArtifact(normalizedPath)) {
      generatedSkipped.push(normalizedPath);
      continue;
    }

    const fingerprint: EngineeringWorkflowFileFingerprint = {
      path: normalizedPath,
      hash: computeEngineeringWorkflowContentHash(file.content || ""),
      moduleName: file.moduleName || moduleNameForWorkflowPath(normalizedPath),
    };
    if (file.targetName) {
      fingerprints[normalizedPath] = { ...fingerprint, targetName: file.targetName };
    } else {
      fingerprints[normalizedPath] = fingerprint;
    }
  }

  const diagnostics: EngineeringWorkflowSnapshotDiagnostic[] =
    generatedSkipped.length > 0
      ? [
          {
            code: "generated_artifact_skipped",
            severity: "info",
            message: `Skipped ${generatedSkipped.length} generated workflow artifact(s)`,
            paths: generatedSkipped,
          },
        ]
      : [];

  return { fingerprints, generatedSkipped, diagnostics };
}

export interface ReconciledWorkflowSnapshotFiles {
  readonly files: Record<string, EngineeringWorkflowFileFingerprint>;
  readonly remapped: Readonly<Record<string, string>>;
  readonly ambiguous: readonly string[];
}

export function reconcileWorkflowSnapshotFiles(
  snapshotFiles: Readonly<Record<string, EngineeringWorkflowFileFingerprint>>,
  currentPaths: Iterable<string>,
): ReconciledWorkflowSnapshotFiles {
  const current = [...currentPaths].map(toWorkflowPosixPath);
  const currentSet = new Set(current);
  const files: Record<string, EngineeringWorkflowFileFingerprint> = {};
  const remapped: Record<string, string> = {};
  const ambiguous: string[] = [];

  for (const [rawPath, fingerprint] of Object.entries(snapshotFiles)) {
    const oldPath = toWorkflowPosixPath(rawPath);
    if (currentSet.has(oldPath)) {
      files[oldPath] = { ...fingerprint, path: oldPath };
      continue;
    }

    const suffix = `/${oldPath}`;
    const candidates = current.filter((candidate) => candidate.endsWith(suffix));
    if (candidates.length === 1) {
      const nextPath = candidates[0];
      if (nextPath) {
        files[nextPath] = { ...fingerprint, path: nextPath };
        remapped[oldPath] = nextPath;
      }
      continue;
    }

    files[oldPath] = { ...fingerprint, path: oldPath };
    if (candidates.length > 1) {
      ambiguous.push(oldPath);
    }
  }

  return { files, remapped, ambiguous };
}

export function isSameWorkflowSnapshotPath(left: string, right: string): boolean {
  const a = toWorkflowPosixPath(left);
  const b = toWorkflowPosixPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
