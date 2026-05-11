import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
} from "../../code/types.js";
import {
  type EnhancementPack,
  type ExtraDimension,
  type GuardRule,
  getEngineeringEnhancementRegistry,
} from "../../enhancement/index.js";
import { getEngineeringEnhancementPackMatcher } from "../../enhancement/matchers.js";
import type { EngineeringFile } from "../../foundation/types.js";
import type { EngineeringImportFact } from "../../panorama/module-discoverer.js";
import type {
  EngineeringPanoramaRoleProfile,
  EngineeringPanoramaSnapshot,
  EngineeringTechStackItem,
} from "../../panorama/types.js";
import { detectPatternCandidates, importsForAstFile } from "./enhancement-ast.js";
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
  const registry = getEngineeringEnhancementRegistry();
  const matched = registry
    .all()
    .map((pack) => resolvePack(pack, context))
    .filter((result) => result.confidence >= minConfidence);

  const signals = matched.flatMap((pack) => pack.signals);
  const patterns = dedupePatterns(
    matched.flatMap((pack) => detectPatternCandidates(pack.pack, context)),
  );
  const guardRules = dedupeGuardRules(
    matched.flatMap((pack) => pack.pack.getGuardRules().map((rule) => toGuardRuleFact(rule))),
  );
  const dimensions = dedupeDimensions(
    matched.flatMap((pack) =>
      pack.pack.getExtraDimensions().map((dimension) => toOptionalDimension(dimension, pack.pack)),
    ),
  );

  return {
    packs: matched.map((pack) => ({
      id: pack.pack.id,
      displayName: pack.pack.displayName,
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
              message: "No enhancement pack matched the supplied engineering facts.",
              source: "enhancement-preprocessor",
            },
          ]
        : [],
  };
}

interface EnhancementContext {
  readonly languages: ReadonlySet<string>;
  readonly frameworks: ReadonlySet<string>;
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
  readonly pack: EnhancementPack;
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
  const frameworks = new Set<string>();

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
    const name = normalizeToken(item.name);
    if (item.category === "language") {
      const lang = normalizeLanguage(item.name);
      if (lang) {
        languages.add(lang);
      }
    } else {
      frameworks.add(name);
    }
  }
  for (const lang of input.panoramaSnapshot?.techStack.primaryLanguages ?? []) {
    const normalized = normalizeLanguage(lang);
    if (normalized) {
      languages.add(normalized);
    }
  }
  for (const category of input.panoramaSnapshot?.techStack.categories ?? []) {
    for (const item of category.items) {
      if (category.name.toLowerCase() === "language") {
        const lang = normalizeLanguage(item.name);
        if (lang) {
          languages.add(lang);
        }
      } else {
        frameworks.add(normalizeToken(item.name));
      }
    }
  }
  for (const name of techStackNames) {
    frameworks.add(normalizeToken(name));
  }

  return {
    languages,
    frameworks,
    techStackNames,
    importSpecifiers,
    files,
    roles,
    astFiles,
  };
}

function resolvePack(pack: EnhancementPack, context: EnhancementContext): PackResolution {
  const matcher = getEngineeringEnhancementPackMatcher(pack.id);
  const signals: EngineeringWorkflowEnhancementSignal[] = [];
  const conditions = pack.conditions;

  for (const language of conditions.languages) {
    if (context.languages.has(normalizeLanguage(language))) {
      signals.push(signal(pack.id, "tech-stack", language, 0.35, "language match"));
    }
  }

  for (const framework of conditions.frameworks ?? []) {
    if (context.frameworks.has(normalizeToken(framework))) {
      signals.push(signal(pack.id, "tech-stack", framework, 0.45, "framework match"));
    }
  }

  for (const name of context.techStackNames) {
    if (
      matchesAnyAlias(name, matcher.aliases) ||
      matchesAnyAlias(name, conditions.frameworks ?? [])
    ) {
      signals.push(signal(pack.id, "tech-stack", name, 0.45, "tech stack match"));
    }
  }

  for (const fact of context.importSpecifiers) {
    if (matchesAnyAlias(fact.specifier, matcher.aliases)) {
      signals.push(
        signal(pack.id, "import", fact.specifier, 0.55, "import fact match", fact.filePath),
      );
    }
  }

  for (const file of context.files) {
    if (matcher.fileHints.some((hint) => hint.test(file.path))) {
      signals.push(signal(pack.id, "file", file.path, 0.3, "file path match", file.path));
    }
    if (
      typeof file.content === "string" &&
      matcher.aliases.some((alias) => contentMentions(file.content ?? "", alias))
    ) {
      signals.push(signal(pack.id, "file", file.path, 0.35, "file content match", file.path));
    }
    const preprocessed = pack.preprocessFile(file.content ?? "", extensionForPath(file.path));
    if (preprocessed) {
      signals.push(
        signal(pack.id, "file", file.path, 0.45, "pack preprocessor accepted file", file.path),
      );
    }
  }

  for (const role of context.roles) {
    if (matcher.roleHints.some((hint) => hint.test(role.role))) {
      signals.push(
        signal(
          pack.id,
          "panorama-role",
          `${role.module}:${role.role}`,
          Math.min(0.35, role.confidence),
          "panorama role match",
        ),
      );
    }
  }

  const languageMatched =
    conditions.languages.length === 0 ||
    conditions.languages.some((language) => context.languages.has(normalizeLanguage(language)));
  const frameworkMatched =
    !conditions.frameworks ||
    conditions.frameworks.length === 0 ||
    conditions.frameworks.some((framework) => context.frameworks.has(normalizeToken(framework))) ||
    signals.some((item) => item.source !== "panorama-role" && item.source !== "tech-stack");
  const rawConfidence = signals.reduce((sum, item) => sum + item.confidence, 0);
  const confidence = Math.min(1, rawConfidence * (languageMatched || frameworkMatched ? 1 : 0.55));

  return {
    pack,
    confidence,
    signals: dedupeSignals(signals),
  };
}

function toGuardRuleFact(rule: GuardRule): EngineeringWorkflowGuardRuleFact {
  return {
    ruleId: rule.ruleId,
    category: rule.category,
    dimension: rule.dimension,
    severity: normalizeSeverity(rule.severity),
    languages: [...rule.languages],
    pattern: rule.pattern,
    message: rule.message,
    source: rule.source ?? "enhancement-pack",
  };
}

function normalizeSeverity(value: string): EngineeringWorkflowGuardRuleFact["severity"] {
  if (value === "error" || value === "warning" || value === "info") {
    return value;
  }
  return "warning";
}

function toOptionalDimension(
  dimension: ExtraDimension,
  pack: EnhancementPack,
): EngineeringWorkflowOptionalDimension {
  return {
    id: dimension.id,
    label: dimension.label,
    guide: dimension.guide,
    knowledgeTypes: [...dimension.knowledgeTypes],
    ...(dimension.tierHint === undefined ? {} : { tierHint: dimension.tierHint }),
    ...(dimension.skillWorthy === undefined ? {} : { skillWorthy: dimension.skillWorthy }),
    ...(dimension.dualOutput === undefined ? {} : { dualOutput: dimension.dualOutput }),
    ...(dimension.skillMeta === undefined ? {} : { skillMeta: { ...dimension.skillMeta } }),
    conditions: {
      languages: [...pack.conditions.languages],
      ...(pack.conditions.frameworks === undefined
        ? {}
        : { frameworks: [...pack.conditions.frameworks] }),
    },
    source: dimension.source ?? pack.id,
  };
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
      language: file.language,
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
    for (const specifier of importsForAstFile(astFile)) {
      result.push({
        specifier,
        ...(filePath ? { filePath } : {}),
      });
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
  const lower = normalizeToken(value);
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

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
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

function extensionForPath(filePath: string): string {
  const match = filePath.match(/\.[^./]+$/);
  return match?.[0] ?? "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
