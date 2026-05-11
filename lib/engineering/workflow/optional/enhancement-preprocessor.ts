import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
} from "../../code/types.js";
import type { EngineeringFile } from "../../foundation/types.js";
import type { EngineeringImportFact } from "../../panorama/module-discoverer.js";
import type {
  EngineeringPanoramaRoleProfile,
  EngineeringPanoramaSnapshot,
  EngineeringTechStackItem,
} from "../../panorama/types.js";
import {
  type EngineeringWorkflowEnhancementPackDefinition,
  LEGACY_ENHANCEMENT_PACKS,
} from "./enhancement-catalog.js";
import type {
  EngineeringWorkflowEnhancementPatternCandidate,
  EngineeringWorkflowEnhancementPreprocessInput,
  EngineeringWorkflowEnhancementPreprocessResult,
  EngineeringWorkflowEnhancementSignal,
  EngineeringWorkflowEnhancementSignalSource,
  EngineeringWorkflowGuardRuleFact,
  EngineeringWorkflowOptionalDimension,
} from "./types.js";

const DEFAULT_MIN_CONFIDENCE = 0.45;

export function preprocessEnhancements(
  input: EngineeringWorkflowEnhancementPreprocessInput,
): EngineeringWorkflowEnhancementPreprocessResult {
  const context = buildEnhancementContext(input);
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const matched = LEGACY_ENHANCEMENT_PACKS.map((pack) => resolvePack(pack, context)).filter(
    (result) => result.confidence >= minConfidence,
  );

  const signals = matched.flatMap((pack) => pack.signals);
  const patterns = matched.flatMap((pack) => detectPatternCandidates(pack.definition, context));
  const guardRules = dedupeGuardRules(matched.flatMap((pack) => pack.definition.guardRules));
  const dimensions = dedupeDimensions(matched.flatMap((pack) => pack.definition.dimensions));

  return {
    packs: matched.map((pack) => ({
      id: pack.definition.id,
      displayName: pack.definition.displayName,
      matched: true,
      confidence: pack.confidence,
      signals: pack.signals,
    })),
    signals,
    patterns,
    guardRules,
    dimensions,
    diagnostics:
      matched.length === 0
        ? [
            {
              code: "optional.enhancement.no-match",
              severity: "info",
              message: "No legacy enhancement pack matched the supplied engineering facts.",
              source: "enhancement-preprocessor",
            },
          ]
        : [],
  };
}

interface EnhancementContext {
  readonly languages: ReadonlySet<string>;
  readonly techStackNames: readonly string[];
  readonly importSpecifiers: readonly ImportSignal[];
  readonly files: readonly FileSignal[];
  readonly roles: readonly RoleSignal[];
  readonly astFiles: readonly EngineeringCodeAstFileSummaryInput[];
}

interface ImportSignal {
  readonly specifier: string;
  readonly filePath?: string;
}

interface FileSignal {
  readonly path: string;
  readonly language?: string;
  readonly content?: string;
}

interface RoleSignal {
  readonly module: string;
  readonly role: string;
  readonly confidence: number;
}

interface PackResolution {
  readonly definition: EngineeringWorkflowEnhancementPackDefinition;
  readonly confidence: number;
  readonly signals: readonly EngineeringWorkflowEnhancementSignal[];
}

function buildEnhancementContext(input: EngineeringWorkflowEnhancementPreprocessInput) {
  const files = normalizeFiles(input.files ?? [], input.fileContents ?? {});
  const astFiles = astSummariesFrom(input.astSummaries);
  const importSpecifiers = normalizeImportFacts(input.importFacts ?? [], astFiles);
  const techStackNames = normalizeTechStack(input.techStackItems, input.panoramaSnapshot);
  const roles = normalizeRoles(input.panoramaSnapshot);
  const languages = new Set<string>();

  for (const file of files) {
    const rawLanguage = file.language ?? languageForPath(file.path);
    if (rawLanguage) {
      languages.add(normalizeLanguage(rawLanguage));
    }
  }
  for (const astFile of astFiles) {
    const lang = normalizeLanguage(stringValue(astFile.lang ?? astFile.languageId));
    if (lang) {
      languages.add(lang);
    }
  }
  for (const item of input.techStackItems ?? []) {
    if (item.category === "language") {
      const lang = normalizeLanguage(item.name);
      if (lang) {
        languages.add(lang);
      }
    }
  }
  for (const lang of input.panoramaSnapshot?.techStack.primaryLanguages ?? []) {
    const normalized = normalizeLanguage(lang);
    if (normalized) {
      languages.add(normalized);
    }
  }

  return {
    languages,
    techStackNames,
    importSpecifiers,
    files,
    roles,
    astFiles,
  };
}

function resolvePack(
  definition: EngineeringWorkflowEnhancementPackDefinition,
  context: EnhancementContext,
): PackResolution {
  const signals: EngineeringWorkflowEnhancementSignal[] = [];

  for (const language of definition.languages) {
    if (context.languages.has(language)) {
      signals.push(signal(definition.id, "tech-stack", language, 0.35, "language match"));
    }
  }

  for (const name of context.techStackNames) {
    if (matchesAnyAlias(name, definition.aliases) || matchesAnyAlias(name, definition.frameworks)) {
      signals.push(signal(definition.id, "tech-stack", name, 0.45, "tech stack match"));
    }
  }

  for (const fact of context.importSpecifiers) {
    if (matchesAnyAlias(fact.specifier, definition.aliases)) {
      signals.push(
        signal(definition.id, "import", fact.specifier, 0.55, "import fact match", fact.filePath),
      );
    }
  }

  for (const file of context.files) {
    if (definition.fileHints.some((hint) => hint.test(file.path))) {
      signals.push(signal(definition.id, "file", file.path, 0.3, "file path match", file.path));
    }
    if (
      typeof file.content === "string" &&
      definition.aliases.some((alias) => contentMentions(file.content ?? "", alias))
    ) {
      signals.push(signal(definition.id, "file", file.path, 0.35, "file content match", file.path));
    }
  }

  for (const role of context.roles) {
    if (definition.roleHints.some((hint) => hint.test(role.role))) {
      signals.push(
        signal(
          definition.id,
          "panorama-role",
          `${role.module}:${role.role}`,
          Math.min(0.35, role.confidence),
          "panorama role match",
        ),
      );
    }
  }

  const languageMatched =
    definition.languages.length === 0 ||
    definition.languages.some((language) => context.languages.has(language));
  const frameworkMatched = signals.some((item) => item.source !== "panorama-role");
  const rawConfidence = signals.reduce((sum, item) => sum + item.confidence, 0);
  const confidence = Math.min(1, rawConfidence * (languageMatched || frameworkMatched ? 1 : 0.55));

  return {
    definition,
    confidence,
    signals: dedupeSignals(signals),
  };
}

function detectPatternCandidates(
  definition: EngineeringWorkflowEnhancementPackDefinition,
  context: EnhancementContext,
): readonly EngineeringWorkflowEnhancementPatternCandidate[] {
  const patterns: EngineeringWorkflowEnhancementPatternCandidate[] = [];
  for (const fact of context.importSpecifiers) {
    if (matchesAnyAlias(fact.specifier, definition.aliases)) {
      patterns.push({
        type: `${definition.id}-ecosystem-usage`,
        packId: definition.id,
        confidence: 0.78,
        source: "import",
        evidence: [fact.specifier],
        ...(fact.filePath === undefined ? {} : { filePath: fact.filePath }),
      });
    }
  }

  for (const astFile of context.astFiles) {
    const filePath = stringValue(astFile.file ?? astFile.path ?? astFile.filePath);
    for (const method of arrayRecords(astFile.methods)) {
      const name = stringValue(method.name);
      if (!name) {
        continue;
      }
      const candidate = methodPattern(definition.id, name);
      if (candidate) {
        const line = numberValue(method.line);
        patterns.push({
          type: candidate,
          packId: definition.id,
          confidence: 0.82,
          source: "ast",
          evidence: [name],
          ...(filePath ? { filePath } : {}),
          ...(line === undefined ? {} : { line }),
        });
      }
    }
    for (const cls of arrayRecords(astFile.classes)) {
      const name = stringValue(cls.name);
      if (!name) {
        continue;
      }
      const candidate = classPattern(definition.id, name, cls);
      if (candidate) {
        const line = numberValue(cls.line);
        patterns.push({
          type: candidate,
          packId: definition.id,
          confidence: 0.8,
          source: "ast",
          evidence: [name],
          ...(filePath ? { filePath } : {}),
          ...(line === undefined ? {} : { line }),
        });
      }
    }
  }

  if (patterns.length === 0) {
    return definition.patternTypes.slice(0, 2).map((type) => ({
      type,
      packId: definition.id,
      confidence: 0.55,
      source: "pack",
      evidence: ["pack matched"],
    }));
  }

  return dedupePatterns(patterns);
}

function methodPattern(packId: string, methodName: string): string | null {
  if (packId === "react" && /^use[A-Z]/.test(methodName)) {
    return "custom-hook";
  }
  if (packId === "react" && /^[A-Z]/.test(methodName)) {
    return "react-component";
  }
  if (packId === "fastapi" && methodName.startsWith("get_")) {
    return "fastapi-dependency";
  }
  if (packId === "rust-web" && /^(get|post|put|delete|handle|list|create)_/.test(methodName)) {
    return "rust-web-handler";
  }
  if (packId === "node-server" && /middleware|handler|controller/i.test(methodName)) {
    return "middleware";
  }
  return null;
}

function classPattern(
  packId: string,
  className: string,
  cls: Record<string, unknown>,
): string | null {
  const lower = className.toLowerCase();
  const superclass = stringValue(cls.superclass ?? cls.superClass);
  if (packId === "fastapi" && /BaseModel|BaseSettings/.test(superclass)) {
    return "pydantic-model";
  }
  if (packId === "node-server" && lower.endsWith("dto")) {
    return "node-dto";
  }
  if (packId === "react" && (lower.includes("provider") || lower.includes("context"))) {
    return "react-context-provider";
  }
  if (packId === "rust-web" && lower.includes("state")) {
    return "rust-web-state";
  }
  return null;
}

function normalizeFiles(
  files: readonly EngineeringFile[],
  fileContents: Readonly<Record<string, string>>,
): readonly FileSignal[] {
  const result: FileSignal[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const filePath = file.relativePath || file.path;
    seen.add(filePath);
    result.push({
      path: filePath,
      ...(file.language === undefined ? {} : { language: file.language }),
      ...(fileContents[filePath] === undefined ? {} : { content: fileContents[filePath] }),
    });
  }
  for (const [filePath, content] of Object.entries(fileContents)) {
    if (!seen.has(filePath)) {
      const language = languageForPath(filePath);
      result.push({
        path: filePath,
        content,
        ...(language === undefined ? {} : { language }),
      });
    }
  }
  return result;
}

function normalizeImportFacts(
  facts: readonly EngineeringImportFact[],
  astFiles: readonly EngineeringCodeAstFileSummaryInput[],
): readonly ImportSignal[] {
  const result: ImportSignal[] = facts.map((fact) => ({
    specifier: fact.specifier,
    filePath: fact.filePath,
  }));
  for (const astFile of astFiles) {
    const filePath = stringValue(astFile.file ?? astFile.path ?? astFile.filePath);
    for (const rawImport of Array.isArray(astFile.imports) ? astFile.imports : []) {
      const record: Record<string, unknown> = isRecord(rawImport) ? rawImport : { path: rawImport };
      const specifier = stringValue(
        record.specifier ?? record.path ?? record.module ?? record.source,
      );
      if (specifier) {
        result.push({
          specifier,
          ...(filePath ? { filePath } : {}),
        });
      }
    }
  }
  const byKey = new Map<string, ImportSignal>();
  for (const fact of result) {
    byKey.set(`${fact.filePath ?? ""}\0${fact.specifier}`, fact);
  }
  return [...byKey.values()];
}

function normalizeTechStack(
  items: readonly EngineeringTechStackItem[] | undefined,
  snapshot: EngineeringPanoramaSnapshot | null | undefined,
): readonly string[] {
  const names = new Set<string>();
  for (const item of items ?? []) {
    names.add(item.name);
  }
  for (const category of snapshot?.techStack.categories ?? []) {
    for (const item of category.items) {
      names.add(item.name);
    }
  }
  for (const dep of snapshot?.externalDeps ?? []) {
    names.add(dep.name);
  }
  return [...names].map((name) => name.toLowerCase());
}

function normalizeRoles(
  snapshot: EngineeringPanoramaSnapshot | null | undefined,
): readonly RoleSignal[] {
  const roles: RoleSignal[] = [];
  for (const role of snapshot?.roles ?? []) {
    roles.push(roleSignal(role));
  }
  for (const module of snapshot?.modules ?? []) {
    roles.push({
      module: module.name,
      role: module.role,
      confidence: module.roleConfidence,
    });
  }
  return roles;
}

function roleSignal(role: EngineeringPanoramaRoleProfile): RoleSignal {
  return {
    module: role.module,
    role: role.role,
    confidence: role.confidence,
  };
}

function signal(
  packId: string,
  source: EngineeringWorkflowEnhancementSignalSource,
  value: string,
  confidence: number,
  reason: string,
  filePath?: string,
): EngineeringWorkflowEnhancementSignal {
  return {
    packId,
    source,
    value,
    confidence,
    reason,
    ...(filePath === undefined ? {} : { filePath }),
  };
}

function matchesAnyAlias(value: string, aliases: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

function contentMentions(content: string, alias: string): boolean {
  return content.toLowerCase().includes(alias.toLowerCase());
}

function astSummariesFrom(
  input: EngineeringCodeAstSummaryInput | undefined,
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    return input;
  }
  const container = input as Exclude<
    EngineeringCodeAstSummaryInput,
    readonly EngineeringCodeAstFileSummaryInput[]
  >;
  return (
    container.fileSummaries ?? container.files ?? container.astProjectSummary?.fileSummaries ?? []
  );
}

function dedupeSignals(
  signals: readonly EngineeringWorkflowEnhancementSignal[],
): readonly EngineeringWorkflowEnhancementSignal[] {
  const byKey = new Map<string, EngineeringWorkflowEnhancementSignal>();
  for (const signalItem of signals) {
    byKey.set(
      `${signalItem.packId}\0${signalItem.source}\0${signalItem.value}\0${signalItem.filePath ?? ""}`,
      signalItem,
    );
  }
  return [...byKey.values()];
}

function dedupePatterns(
  patterns: readonly EngineeringWorkflowEnhancementPatternCandidate[],
): readonly EngineeringWorkflowEnhancementPatternCandidate[] {
  const byKey = new Map<string, EngineeringWorkflowEnhancementPatternCandidate>();
  for (const pattern of patterns) {
    byKey.set(
      `${pattern.packId}\0${pattern.type}\0${pattern.filePath ?? ""}\0${pattern.line ?? ""}`,
      pattern,
    );
  }
  return [...byKey.values()];
}

function dedupeGuardRules(
  rules: readonly EngineeringWorkflowGuardRuleFact[],
): readonly EngineeringWorkflowGuardRuleFact[] {
  return [...new Map(rules.map((ruleItem) => [ruleItem.ruleId, ruleItem])).values()];
}

function dedupeDimensions(
  dimensions: readonly EngineeringWorkflowOptionalDimension[],
): readonly EngineeringWorkflowOptionalDimension[] {
  return [
    ...new Map(dimensions.map((dimensionItem) => [dimensionItem.id, dimensionItem])).values(),
  ];
}

function normalizeLanguage(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "ts" || lower === "tsx") {
    return "typescript";
  }
  if (lower === "js" || lower === "jsx" || lower === "node") {
    return "javascript";
  }
  if (lower === "py") {
    return "python";
  }
  if (lower === "rs") {
    return "rust";
  }
  return lower;
}

function languageForPath(filePath: string): string | undefined {
  if (/\.(ts|tsx|mts|cts)$/.test(filePath)) {
    return "typescript";
  }
  if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) {
    return "javascript";
  }
  if (/\.py$/.test(filePath)) {
    return "python";
  }
  if (/\.rs$/.test(filePath)) {
    return "rust";
  }
  if (/\.go$/.test(filePath)) {
    return "go";
  }
  if (/\.kt$/.test(filePath)) {
    return "kotlin";
  }
  if (/\.java$/.test(filePath)) {
    return "java";
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function arrayRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
