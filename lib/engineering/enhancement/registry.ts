import type {
  AstSummary,
  DetectedPattern,
  EngineeringEnhancementConditions,
  EnhancementPack,
  ExtraDimension,
  GuardRule,
  PreprocessedEnhancementFile,
} from "./pack.js";

export class EngineeringEnhancementRegistry {
  readonly #packs: EnhancementPack[] = [];

  register(pack: EnhancementPack): this {
    const existingIndex = this.#packs.findIndex((candidate) => candidate.id === pack.id);
    if (existingIndex === -1) {
      this.#packs.push(pack);
      return this;
    }
    this.#packs[existingIndex] = pack;
    return this;
  }

  /** 根据语言和框架筛选适用的增强包。 */
  resolve(primaryLang: string, detectedFrameworks: readonly string[] = []): EnhancementPack[] {
    return this.#packs.filter((pack) =>
      matchesEngineeringEnhancementConditions(pack.conditions, primaryLang, detectedFrameworks),
    );
  }

  get(id: string): EnhancementPack | undefined {
    return this.#packs.find((pack) => pack.id === id);
  }

  all(): EnhancementPack[] {
    return [...this.#packs];
  }

  getExtraDimensions(
    primaryLang: string,
    detectedFrameworks: readonly string[] = [],
  ): ExtraDimension[] {
    return dedupeById(
      this.resolve(primaryLang, detectedFrameworks).flatMap((pack) => pack.getExtraDimensions()),
    );
  }

  getGuardRules(primaryLang: string, detectedFrameworks: readonly string[] = []): GuardRule[] {
    return dedupeRules(
      this.resolve(primaryLang, detectedFrameworks).flatMap((pack) => pack.getGuardRules()),
    );
  }

  detectPatterns(
    astSummary: AstSummary,
    primaryLang: string,
    detectedFrameworks: readonly string[] = [],
  ): DetectedPattern[] {
    return dedupePatterns(
      this.resolve(primaryLang, detectedFrameworks).flatMap((pack) =>
        pack.detectPatterns(astSummary),
      ),
    );
  }

  preprocessFile(
    content: string,
    ext: string,
    primaryLang: string,
    detectedFrameworks: readonly string[] = [],
  ): (PreprocessedEnhancementFile & { readonly packId: string }) | null {
    for (const pack of this.resolve(primaryLang, detectedFrameworks)) {
      const result = pack.preprocessFile(content, ext);
      if (result) {
        return { ...result, packId: pack.id };
      }
    }
    return null;
  }
}

export function matchesEngineeringEnhancementConditions(
  conditions: EngineeringEnhancementConditions,
  primaryLang: string,
  detectedFrameworks: readonly string[] = [],
): boolean {
  const normalizedLang = normalizeLanguage(primaryLang);
  const normalizedFrameworks = new Set(detectedFrameworks.map(normalizeToken));
  const languageMatch =
    conditions.languages.length === 0 ||
    conditions.languages.some((language) => normalizeLanguage(language) === normalizedLang);
  const frameworkMatch =
    !conditions.frameworks ||
    conditions.frameworks.length === 0 ||
    conditions.frameworks.some((framework) => normalizedFrameworks.has(normalizeToken(framework)));
  return languageMatch && frameworkMatch;
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

function dedupeById(dimensions: readonly ExtraDimension[]): ExtraDimension[] {
  return [...new Map(dimensions.map((dimension) => [dimension.id, dimension])).values()];
}

function dedupeRules(rules: readonly GuardRule[]): GuardRule[] {
  return [...new Map(rules.map((rule) => [rule.ruleId, rule])).values()];
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

export { EngineeringEnhancementRegistry as EnhancementRegistry };
