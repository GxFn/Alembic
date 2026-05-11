import type {
  AstSummary,
  DetectedPattern,
  EngineeringEnhancementConditions,
  EngineeringEnhancementPackDefinition,
  ExtraDimension,
  GuardRule,
} from "./EngineeringEnhancementPack.js";
import { EngineeringEnhancementPack } from "./EngineeringEnhancementPack.js";

export class EngineeringEnhancementRegistry {
  readonly #packs: EngineeringEnhancementPack[] = [];

  register(pack: EngineeringEnhancementPack): this {
    const existingIndex = this.#packs.findIndex((candidate) => candidate.id === pack.id);
    if (existingIndex === -1) {
      this.#packs.push(pack);
      return this;
    }
    this.#packs[existingIndex] = pack;
    return this;
  }

  registerDefinition(definition: EngineeringEnhancementPackDefinition): this {
    return this.register(new EngineeringEnhancementPack(definition));
  }

  resolve(
    primaryLang: string,
    detectedFrameworks: readonly string[] = [],
  ): EngineeringEnhancementPack[] {
    const normalizedLang = normalizeToken(primaryLang);
    const normalizedFrameworks = new Set(detectedFrameworks.map(normalizeToken));

    return this.#packs.filter((pack) => {
      const conditions = pack.conditions;
      const languageMatch =
        conditions.languages.length === 0 ||
        conditions.languages.some((language) => normalizeToken(language) === normalizedLang);
      const frameworkMatch =
        !conditions.frameworks ||
        conditions.frameworks.length === 0 ||
        conditions.frameworks.some((framework) =>
          normalizedFrameworks.has(normalizeToken(framework)),
        );
      return languageMatch && frameworkMatch;
    });
  }

  get(id: string): EngineeringEnhancementPack | undefined {
    return this.#packs.find((pack) => pack.id === id);
  }

  all(): EngineeringEnhancementPack[] {
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
  ): { readonly content: string; readonly lang: string; readonly packId: string } | null {
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
  const registry = new EngineeringEnhancementRegistry();
  registry.register(
    new EngineeringEnhancementPack({
      id: "candidate",
      displayName: "Candidate",
      languages: conditions.languages,
      ...(conditions.frameworks === undefined ? {} : { frameworks: conditions.frameworks }),
    }),
  );
  return registry.resolve(primaryLang, detectedFrameworks).length > 0;
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
