/**
 * Class-based engineering enhancement pack wrapper.
 *
 * The first migration batch wraps the existing catalog definitions while
 * preserving the legacy pack method surface for future per-pack subclasses.
 */

export interface EngineeringEnhancementConditions {
  readonly languages: readonly string[];
  readonly frameworks?: readonly string[];
}

export interface AstMethodInfo {
  readonly name: string;
  readonly className?: string | undefined;
  readonly line?: number | undefined;
  readonly paramCount?: number | undefined;
  readonly isAsync?: boolean | undefined;
  readonly isExported?: boolean | undefined;
  readonly isClassMethod?: boolean | undefined;
  readonly decorators?: readonly string[] | undefined;
  readonly annotations?: readonly string[] | undefined;
}

export interface AstClassInfo {
  readonly name: string;
  readonly line?: number | undefined;
  readonly superclass?: string | undefined;
  readonly kind?: string | undefined;
  readonly methods?: readonly string[] | undefined;
  readonly interfaces?: readonly string[] | undefined;
  readonly annotations?: readonly string[] | undefined;
  readonly decorators?: readonly string[] | undefined;
  readonly embeddedTypes?: readonly string[] | undefined;
  readonly fieldCount?: number | undefined;
  readonly derives?: readonly string[] | undefined;
  readonly traitName?: string | undefined;
}

export interface AstProtocolInfo {
  readonly name: string;
  readonly line?: number | undefined;
  readonly methods?: readonly string[] | undefined;
}

export interface AstPatternInfo {
  readonly type: string;
  readonly count?: number | undefined;
  readonly confidence?: number | undefined;
}

export interface AstSummary {
  readonly methods?: readonly AstMethodInfo[];
  readonly classes?: readonly AstClassInfo[];
  readonly imports?: readonly string[];
  readonly protocols?: readonly AstProtocolInfo[];
  readonly patterns?: readonly AstPatternInfo[];
}

export interface DetectedPattern {
  readonly type: string;
  readonly className?: string | undefined;
  readonly methodName?: string | undefined;
  readonly line?: number | undefined;
  readonly confidence: number;
  readonly [key: string]: unknown;
}

export interface ExtraDimension {
  readonly id: string;
  readonly label: string;
  readonly guide: string;
  readonly tierHint?: number | undefined;
  readonly knowledgeTypes: readonly string[];
  readonly skillWorthy?: boolean | undefined;
  readonly dualOutput?: boolean | undefined;
  readonly skillMeta?: {
    readonly name: string;
    readonly description: string;
  };
  readonly conditions?:
    | {
        readonly languages?: readonly string[] | undefined;
        readonly frameworks?: readonly string[] | undefined;
      }
    | undefined;
  readonly source?: string | undefined;
}

export interface GuardRule {
  readonly ruleId: string;
  readonly category: string;
  readonly dimension: string;
  readonly severity: string;
  readonly languages: readonly string[];
  readonly pattern: RegExp;
  readonly message: string;
  readonly source?: string | undefined;
}

export interface EngineeringEnhancementDimensionDefinition {
  readonly id: string;
  readonly label: string;
  readonly guide?: string;
  readonly tierHint?: number;
  readonly knowledgeTypes: readonly string[];
  readonly skillWorthy?: boolean;
  readonly dualOutput?: boolean;
  readonly skillMeta?: {
    readonly name: string;
    readonly description: string;
  };
  readonly conditions?: {
    readonly languages?: readonly string[];
    readonly frameworks?: readonly string[];
  };
  readonly source?: string;
}

export interface EngineeringEnhancementGuardRuleDefinition {
  readonly ruleId: string;
  readonly category: string;
  readonly dimension: string;
  readonly severity: string;
  readonly languages?: readonly string[];
  readonly pattern?: RegExp | string;
  readonly message: string;
  readonly source?: string;
}

export interface EngineeringEnhancementPackDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly languages?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly aliases?: readonly string[];
  readonly dimensions?: readonly EngineeringEnhancementDimensionDefinition[];
  readonly guardRules?: readonly EngineeringEnhancementGuardRuleDefinition[];
  readonly patternTypes?: readonly string[];
  readonly referenceSkillPath?: string | null;
  readonly detectPatterns?: (astSummary: AstSummary) => readonly DetectedPattern[];
  readonly preprocessFile?: (
    content: string,
    ext: string,
  ) => { readonly content: string; readonly lang: string } | null;
}

export class EngineeringEnhancementPack {
  readonly #definition: EngineeringEnhancementPackDefinition;

  constructor(definition: EngineeringEnhancementPackDefinition) {
    this.#definition = definition;
  }

  get id(): string {
    return this.#definition.id;
  }

  get conditions(): EngineeringEnhancementConditions {
    return {
      languages: [...(this.#definition.languages ?? [])],
      ...(this.#definition.frameworks === undefined
        ? {}
        : { frameworks: [...this.#definition.frameworks] }),
    };
  }

  get displayName(): string {
    return this.#definition.displayName || this.id;
  }

  get aliases(): readonly string[] {
    return [...(this.#definition.aliases ?? [])];
  }

  get patternTypes(): readonly string[] {
    return [...(this.#definition.patternTypes ?? [])];
  }

  getExtraDimensions(): ExtraDimension[] {
    return (this.#definition.dimensions ?? []).map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      guide: dimension.guide ?? dimension.label,
      ...(dimension.tierHint === undefined ? {} : { tierHint: dimension.tierHint }),
      knowledgeTypes: [...dimension.knowledgeTypes],
      ...(dimension.skillWorthy === undefined ? {} : { skillWorthy: dimension.skillWorthy }),
      ...(dimension.dualOutput === undefined ? {} : { dualOutput: dimension.dualOutput }),
      ...(dimension.skillMeta === undefined ? {} : { skillMeta: { ...dimension.skillMeta } }),
      ...(dimension.conditions === undefined
        ? {}
        : {
            conditions: {
              ...(dimension.conditions.languages === undefined
                ? {}
                : { languages: [...dimension.conditions.languages] }),
              ...(dimension.conditions.frameworks === undefined
                ? {}
                : { frameworks: [...dimension.conditions.frameworks] }),
            },
          }),
      ...(dimension.source === undefined ? {} : { source: dimension.source }),
    }));
  }

  getGuardRules(): GuardRule[] {
    return (this.#definition.guardRules ?? []).map((rule) => ({
      ruleId: rule.ruleId,
      category: rule.category,
      dimension: rule.dimension,
      severity: rule.severity,
      languages: [...(rule.languages ?? [])],
      pattern: normalizePattern(rule.pattern),
      message: rule.message,
      ...(rule.source === undefined ? {} : { source: rule.source }),
    }));
  }

  detectPatterns(astSummary: AstSummary): DetectedPattern[] {
    const customDetector = this.#definition.detectPatterns;
    if (customDetector) {
      return [...customDetector(astSummary)];
    }
    return detectPatternsFromSummary(this, astSummary);
  }

  preprocessFile(
    content: string,
    ext: string,
  ): { readonly content: string; readonly lang: string } | null {
    const customPreprocessor = this.#definition.preprocessFile;
    if (customPreprocessor) {
      return customPreprocessor(content, ext);
    }
    if (this.id === "vue") {
      return preprocessVueFile(content, ext);
    }
    return null;
  }

  getReferenceSkillPath(): string | null {
    return this.#definition.referenceSkillPath ?? null;
  }
}

function detectPatternsFromSummary(
  pack: EngineeringEnhancementPack,
  astSummary: AstSummary,
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (const pattern of astSummary.patterns ?? []) {
    if (
      pattern.type &&
      (pack.patternTypes.length === 0 || pack.patternTypes.includes(pattern.type))
    ) {
      patterns.push({
        type: pattern.type,
        confidence: pattern.confidence ?? 0.7,
        ...(pattern.count === undefined ? {} : { count: pattern.count }),
      });
    }
  }

  for (const method of astSummary.methods ?? []) {
    const candidate = methodPattern(pack.id, method.name);
    if (candidate) {
      patterns.push({
        type: candidate,
        methodName: method.name,
        line: method.line,
        confidence: 0.82,
      });
    }
  }

  for (const cls of astSummary.classes ?? []) {
    const candidate = classPattern(pack.id, cls);
    if (candidate) {
      patterns.push({
        type: candidate,
        className: cls.name,
        line: cls.line,
        confidence: 0.8,
      });
    }
  }

  const importHits = (astSummary.imports ?? []).filter((specifier) =>
    pack.aliases.some((alias) => specifier.toLowerCase().includes(alias.toLowerCase())),
  );
  if (importHits.length > 0) {
    patterns.push({
      type: `${pack.id}-ecosystem-usage`,
      importCount: importHits.length,
      confidence: 0.85,
    });
  }

  if (patterns.length === 0) {
    return pack.patternTypes.slice(0, 2).map((type) => ({
      type,
      confidence: 0.55,
      source: "pack",
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
  if (packId === "vue" && /^use[A-Z]/.test(methodName)) {
    return "vue-composable";
  }
  if (packId === "vue" && /^use\w+Store$/.test(methodName)) {
    return "vue-pinia-store";
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
  if (packId === "go-web" && /handler|middleware|router/i.test(methodName)) {
    return "go-handler-method";
  }
  return null;
}

function classPattern(packId: string, cls: AstClassInfo): string | null {
  const lower = cls.name.toLowerCase();
  const superclass = cls.superclass ?? "";
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
  if (packId === "spring" && cls.annotations?.some((annotation) => /Controller/.test(annotation))) {
    return "spring-rest-controller";
  }
  if (packId === "django" && /Model|Serializer|View/.test(superclass)) {
    return lower.includes("serializer") ? "drf-serializer" : "django-model";
  }
  return null;
}

function preprocessVueFile(
  content: string,
  ext: string,
): { readonly content: string; readonly lang: string } | null {
  if (ext !== ".vue") {
    return null;
  }

  const setupMatch = content.match(
    /<script\s+setup(?:\s+lang=["'](ts|typescript)["'])?\s*>([\s\S]*?)<\/script>/i,
  );
  const setupContent = setupMatch?.[2];
  const setupLang = setupMatch?.[1];
  if (setupContent !== undefined) {
    return { content: setupContent, lang: setupLang ? "typescript" : "javascript" };
  }

  const scriptMatch = content.match(
    /<script(?:\s+lang=["'](ts|typescript)["'])?\s*>([\s\S]*?)<\/script>/i,
  );
  const scriptContent = scriptMatch?.[2];
  const scriptLang = scriptMatch?.[1];
  if (scriptContent !== undefined) {
    return { content: scriptContent, lang: scriptLang ? "typescript" : "javascript" };
  }

  return null;
}

function normalizePattern(pattern: RegExp | string | undefined): RegExp {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  if (typeof pattern === "string") {
    return new RegExp(escapeRegExp(pattern));
  }
  return /$a/;
}

function dedupePatterns(patterns: readonly DetectedPattern[]): DetectedPattern[] {
  return [
    ...new Map(
      patterns.map((pattern) => [
        `${pattern.type}\0${String(pattern.methodName ?? "")}\0${String(pattern.className ?? "")}`,
        pattern,
      ]),
    ).values(),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
