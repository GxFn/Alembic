import {
  moduleNameForWorkflowPath,
  normalizeWorkflowFilePath,
  toWorkflowPosixPath,
} from "../workflow/cache/EngineeringWorkflowPathUtils.js";
import type {
  EngineeringWorkflowDimensionFileRef,
  EngineeringWorkflowEnhancementPackInfo,
  EngineeringWorkflowEnhancementPatternCandidate,
  EngineeringWorkflowGuardRuleFact,
  EngineeringWorkflowOptionalDimension,
} from "../workflow/optional/EngineeringWorkflowOptionalTypes.js";
import {
  ENGINEERING_PROJECT_SNAPSHOT_VERSION,
  type ProjectSnapshot,
  type ProjectSnapshotDiscoverer,
  type ProjectSnapshotFile,
  type ProjectSnapshotInput,
  type ProjectSnapshotLanguageProfile,
  type ProjectSnapshotLocalPackageModule,
  type ProjectSnapshotTarget,
} from "./ProjectSnapshotTypes.js";

export function buildProjectSnapshot(input: ProjectSnapshotInput): ProjectSnapshot {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const timestamp = input.timestamp ?? timestampFromCreatedAt(createdAt);
  const allFiles = normalizeFiles(input.allFiles, input.projectRoot, input.fileContents ?? {});
  const allTargets = normalizeTargets(input.allTargets, allFiles);
  const targetsSummary =
    input.targetsSummary === undefined
      ? allTargets
      : normalizeTargets(input.targetsSummary, allFiles);
  const language = normalizeLanguage(input, allFiles);
  const optionalStage = input.optionalStage ?? null;
  const optionalResult = optionalStage?.result ?? null;
  const guardAudit = input.guardAudit ?? optionalResult?.guard ?? null;
  const activeDimensions = normalizeTypedArray<EngineeringWorkflowOptionalDimension>(
    input.activeDimensions ?? optionalResult?.dimensions.activeDimensions,
  );
  const enhancementPackInfo = normalizeTypedArray<EngineeringWorkflowEnhancementPackInfo>(
    input.enhancementPackInfo ?? optionalResult?.enhancement.packs,
  );
  const enhancementPatterns = normalizeTypedArray<EngineeringWorkflowEnhancementPatternCandidate>(
    input.enhancementPatterns ?? optionalResult?.enhancement.patterns,
  );
  const enhancementGuardRules = normalizeTypedArray<EngineeringWorkflowGuardRuleFact>(
    input.enhancementGuardRules ?? optionalResult?.enhancement.guardRules,
  );
  const dimensionFileRefs = freezeArray<EngineeringWorkflowDimensionFileRef>(
    input.dimensionFileRefs ?? optionalStage?.dimensionFileRefs ?? [],
  );
  const generatedArtifactBlacklist = freezeArray(input.generatedArtifactBlacklist ?? []);
  const detectedFrameworks = freezeArray(
    uniqueStrings([
      ...stringArray(input.detectedFrameworks),
      ...frameworksFromTargets(allTargets),
      ...frameworksFromPanorama(input.panoramaSnapshot ?? null),
    ]),
  );
  const normalizedLocalPackageModules = normalizeLocalPackageModules(input.localPackageModules);
  const localPackageModules =
    normalizedLocalPackageModules.length > 0
      ? normalizedLocalPackageModules
      : deriveLocalPackageModules(allTargets, allFiles);
  const snapshotId = input.snapshotId ?? input.snapshotRun?.snapshotId ?? null;

  return Object.freeze({
    version: ENGINEERING_PROJECT_SNAPSHOT_VERSION,
    createdAt,
    timestamp,
    projectRoot: input.projectRoot,
    ...(input.sourceTag === undefined ? {} : { sourceTag: input.sourceTag }),
    ...(input.workflowStatus === undefined ? {} : { workflowStatus: input.workflowStatus }),

    allFiles,
    allTargets,
    discoverer: normalizeDiscoverer(input.discoverer),
    truncated: input.truncated ?? false,
    isEmpty: input.isEmpty ?? allFiles.length === 0,

    language,
    langProfile: language,
    codeGraph: input.codeGraph ?? null,
    callGraph: freezeArray(input.callGraph ?? []),
    dataFlow: freezeArray(input.dataFlow ?? []),
    entityGraph: input.entityGraph ?? null,
    panorama: input.panoramaSnapshot ?? null,
    dependencyGraph: input.dependencyGraph ?? null,

    optionalStage,
    guardAudit,
    activeDimensions,
    enhancementPackInfo,
    enhancementPatterns,
    enhancementGuardRules,
    detectedFrameworks,
    dimensionFileRefs,
    generatedArtifactBlacklist,

    targetsSummary,
    localPackageModules,

    phaseReports: freezeArray(input.phaseReports ?? []),
    diagnostics: freezeArray(input.diagnostics ?? []),
    capabilities: input.capabilities ?? null,
    incrementalPlan: input.incrementalPlan ?? null,
    snapshotRun: input.snapshotRun ?? null,
    snapshotId,
  });
}

function normalizeFiles(
  raw: unknown,
  projectRoot: string,
  fileContents: Readonly<Record<string, string>>,
): readonly ProjectSnapshotFile[] {
  if (!Array.isArray(raw)) {
    return Object.freeze([]);
  }

  const files: ProjectSnapshotFile[] = [];
  for (const item of raw) {
    const file = normalizeFile(item, projectRoot, fileContents);
    if (file.relativePath) {
      files.push(file);
    }
  }
  return Object.freeze(files);
}

function normalizeFile(
  raw: unknown,
  projectRoot: string,
  fileContents: Readonly<Record<string, string>>,
): ProjectSnapshotFile {
  if (typeof raw === "string") {
    const relativePath = toWorkflowPosixPath(raw);
    return Object.freeze({
      name: basename(relativePath),
      path: relativePath,
      relativePath,
      language: "unknown",
      moduleName: moduleNameForWorkflowPath(relativePath),
    });
  }

  const record = isRecord(raw) ? raw : {};
  const rawPath = stringValue(record.path);
  const rawRelativePath = stringValue(record.relativePath);
  const pathInput: { path?: string; relativePath?: string } = {};
  if (rawPath !== undefined) {
    pathInput.path = rawPath;
  }
  if (rawRelativePath !== undefined) {
    pathInput.relativePath = rawRelativePath;
  }
  const relativePath = normalizeWorkflowFilePath(pathInput, projectRoot);
  const path = toWorkflowPosixPath(rawPath ?? relativePath);
  const content =
    stringValue(record.content) ?? fileContents[relativePath] ?? fileContents[path] ?? undefined;
  const totalLines = numberValue(record.totalLines) ?? lineCount(content);
  const targetName = nonEmptyString(record.targetName);
  const moduleName = nonEmptyString(record.moduleName) ?? moduleNameForWorkflowPath(relativePath);
  const isTest = booleanValue(record.isTest);

  return Object.freeze({
    name: nonEmptyString(record.name) ?? basename(relativePath || path),
    path,
    relativePath,
    language: nonEmptyString(record.language) ?? "unknown",
    ...(targetName === undefined ? {} : { targetName }),
    ...(moduleName === undefined ? {} : { moduleName }),
    ...(isTest === undefined ? {} : { isTest }),
    ...(content === undefined ? {} : { content }),
    ...(totalLines === undefined ? {} : { totalLines }),
  });
}

function normalizeTargets(
  raw: unknown,
  files: readonly ProjectSnapshotFile[],
): readonly ProjectSnapshotTarget[] {
  if (!Array.isArray(raw)) {
    return Object.freeze([]);
  }

  const targets: ProjectSnapshotTarget[] = [];
  for (const item of raw) {
    const target = normalizeTarget(item, files);
    if (target.name) {
      targets.push(target);
    }
  }
  return Object.freeze(targets);
}

function normalizeTarget(
  raw: unknown,
  files: readonly ProjectSnapshotFile[],
): ProjectSnapshotTarget {
  if (typeof raw === "string") {
    return Object.freeze({ name: raw });
  }

  const record = isRecord(raw) ? raw : {};
  const metadata = copyRecord(record.metadata);
  const name = nonEmptyString(record.name) ?? nonEmptyString(record.id) ?? "";
  const matchedFileCount = files.filter((file) => file.targetName === name).length;
  const fileCount =
    numberValue(record.fileCount) ?? (matchedFileCount > 0 ? matchedFileCount : undefined);
  const framework = stringOrNull(record.framework);
  const isLocalPackage =
    booleanValue(record.isLocalPackage) ?? booleanValue(metadata?.isLocalPackage);
  const packageName = nonEmptyString(record.packageName) ?? nonEmptyString(metadata?.packageName);
  const inferredRole =
    nonEmptyString(record.inferredRole) ?? nonEmptyString(metadata?.inferredRole);
  const targetPath = nonEmptyString(record.path);
  const type = nonEmptyString(record.type);
  const language = nonEmptyString(record.language);

  return Object.freeze({
    name,
    ...(targetPath === undefined ? {} : { path: targetPath }),
    ...(type === undefined ? {} : { type }),
    ...(language === undefined ? {} : { language }),
    ...(framework === undefined ? {} : { framework }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(inferredRole === undefined ? {} : { inferredRole }),
    ...(fileCount === undefined ? {} : { fileCount }),
    ...(isLocalPackage === undefined ? {} : { isLocalPackage }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function normalizeDiscoverer(raw: unknown): ProjectSnapshotDiscoverer {
  if (!isRecord(raw)) {
    return Object.freeze({ id: "unknown", displayName: "Unknown" });
  }
  return Object.freeze({
    id: nonEmptyString(raw.id) ?? "unknown",
    displayName: nonEmptyString(raw.displayName) ?? nonEmptyString(raw.name) ?? "Unknown",
  });
}

function normalizeLanguage(
  input: ProjectSnapshotInput,
  files: readonly ProjectSnapshotFile[],
): ProjectSnapshotLanguageProfile {
  const stats = normalizeStats(
    input.langStats ?? input.language?.stats ?? countLanguageStats(files),
  );
  const primaryLang =
    nonEmptyString(input.primaryLang) ??
    nonEmptyString(input.language?.primaryLang) ??
    mostCommonLanguage(stats) ??
    "unknown";
  const secondary =
    input.language?.secondary === undefined
      ? Object.keys(stats).filter((language) => language !== primaryLang)
      : stringArray(input.language.secondary);
  const isMultiLang =
    input.language?.isMultiLang === undefined ? secondary.length > 0 : input.language.isMultiLang;

  return Object.freeze({
    primaryLang,
    stats: Object.freeze({ ...stats }),
    secondary: freezeArray(secondary),
    isMultiLang,
  });
}

function normalizeStats(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) {
    return {};
  }

  const stats: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const count = numberValue(value);
    if (count !== undefined) {
      stats[key] = count;
    }
  }
  return stats;
}

function countLanguageStats(files: readonly ProjectSnapshotFile[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const file of files) {
    stats[file.language] = (stats[file.language] ?? 0) + 1;
  }
  return stats;
}

function mostCommonLanguage(stats: Readonly<Record<string, number>>): string | undefined {
  return Object.entries(stats).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0]?.[0];
}

function normalizeLocalPackageModules(raw: unknown): readonly ProjectSnapshotLocalPackageModule[] {
  if (!Array.isArray(raw)) {
    return Object.freeze([]);
  }

  const modules: ProjectSnapshotLocalPackageModule[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const name = nonEmptyString(item.name);
    const packageName = nonEmptyString(item.packageName);
    if (!name || !packageName) {
      continue;
    }
    const inferredRole = nonEmptyString(item.inferredRole);
    modules.push(
      Object.freeze({
        name,
        packageName,
        fileCount: numberValue(item.fileCount) ?? 0,
        ...(inferredRole === undefined ? {} : { inferredRole }),
        keyFiles: freezeArray(stringArray(item.keyFiles)),
      }),
    );
  }
  return Object.freeze(modules);
}

function deriveLocalPackageModules(
  targets: readonly ProjectSnapshotTarget[],
  files: readonly ProjectSnapshotFile[],
): readonly ProjectSnapshotLocalPackageModule[] {
  const modules: ProjectSnapshotLocalPackageModule[] = [];
  for (const target of targets) {
    if (target.isLocalPackage !== true && target.packageName === undefined) {
      continue;
    }
    const targetFiles = files
      .filter((file) => file.targetName === target.name)
      .map((file) => file.relativePath);
    modules.push(
      Object.freeze({
        name: target.name,
        packageName: target.packageName ?? target.name,
        fileCount: target.fileCount ?? targetFiles.length,
        ...(target.inferredRole === undefined ? {} : { inferredRole: target.inferredRole }),
        keyFiles: freezeArray(targetFiles.slice(0, 5)),
      }),
    );
  }
  return Object.freeze(modules);
}

function normalizeTypedArray<T>(raw: unknown): readonly T[] {
  return Array.isArray(raw) ? freezeArray(raw as readonly T[]) : Object.freeze([]);
}

function frameworksFromTargets(targets: readonly ProjectSnapshotTarget[]): readonly string[] {
  return targets.flatMap((target) => (target.framework ? [target.framework] : []));
}

function frameworksFromPanorama(
  panorama: ProjectSnapshotInput["panoramaSnapshot"],
): readonly string[] {
  return (
    panorama?.techStack.categories.flatMap((category) =>
      category.items.filter((item) => item.category === "framework").map((item) => item.name),
    ) ?? []
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function stringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((value) => {
    const normalized = nonEmptyString(value);
    return normalized === undefined ? [] : [normalized];
  });
}

function timestampFromCreatedAt(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function lineCount(content: string | undefined): number | undefined {
  if (content === undefined) {
    return undefined;
  }
  return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
}

function basename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function copyRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? Object.freeze({ ...value }) : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return nonEmptyString(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}
