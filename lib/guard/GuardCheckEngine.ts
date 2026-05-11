import { MainlineLanguageCatalog } from "../engineering/code/index.js";
import { computeMainlineContentHash } from "../mainline/core/index.js";
import type {
  MainlineGuardCheckRequest,
  MainlineGuardCheckResult,
  MainlineGuardFile,
  MainlineGuardFinding,
  MainlineGuardRule,
} from "./types.js";

export interface MainlineGuardCheckEngineOptions {
  readonly rules?: readonly MainlineGuardRule[];
  readonly languageCatalog?: MainlineLanguageCatalog;
}

interface CompiledRule {
  readonly rule: MainlineGuardRule;
  readonly pattern: RegExp;
}

export class MainlineGuardCheckEngine {
  readonly #rules: readonly MainlineGuardRule[];
  readonly #languageCatalog: MainlineLanguageCatalog;

  constructor(options: MainlineGuardCheckEngineOptions = {}) {
    this.#rules = options.rules ?? [];
    this.#languageCatalog = options.languageCatalog ?? new MainlineLanguageCatalog();
  }

  check(request: MainlineGuardCheckRequest): MainlineGuardCheckResult {
    const rules = request.rules ?? this.#rules;
    const { compiledRules, warnings } = compileRules(rules);
    const findings: MainlineGuardFinding[] = [];
    const maxFindings = request.options?.maxFindings ?? 200;
    const maxFindingsPerRule = request.options?.maxFindingsPerRule ?? 20;
    const perRuleCounts = new Map<string, number>();

    for (const file of request.files) {
      const language = this.#fileLanguage(file);
      const isTest = file.isTest ?? this.#languageCatalog.isTestFile(file.path, language);

      for (const compiledRule of compiledRules) {
        if (!appliesToFile(compiledRule.rule, language, isTest)) {
          continue;
        }

        const nextFindings = this.#checkFileWithRule(file, language, compiledRule);
        for (const finding of nextFindings) {
          const count = perRuleCounts.get(finding.ruleId) ?? 0;
          if (count >= maxFindingsPerRule) {
            continue;
          }
          findings.push(finding);
          perRuleCounts.set(finding.ruleId, count + 1);
          if (findings.length >= maxFindings) {
            return buildResult(request.files.length, rules.length, findings, warnings);
          }
        }
      }
    }

    return buildResult(request.files.length, rules.length, findings, warnings);
  }

  #checkFileWithRule(
    file: MainlineGuardFile,
    language: string,
    compiledRule: CompiledRule,
  ): MainlineGuardFinding[] {
    const findings: MainlineGuardFinding[] = [];
    const lines = file.content.replace(/\r\n/g, "\n").split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (compiledRule.rule.skipComments && isCommentLine(line, language)) {
        continue;
      }

      compiledRule.pattern.lastIndex = 0;
      const match = compiledRule.pattern.exec(line);
      if (!match) {
        continue;
      }

      findings.push(this.#finding(file, language, compiledRule.rule, line, index, match.index));
    }

    return findings;
  }

  #finding(
    file: MainlineGuardFile,
    language: string,
    rule: MainlineGuardRule,
    line: string,
    lineIndex: number,
    columnIndex: number,
  ): MainlineGuardFinding {
    const lineNumber = lineIndex + 1;
    const column = columnIndex + 1;
    const snippet = line.trim().slice(0, 180);
    const hash = computeMainlineContentHash(
      [rule.ruleRecipeId, rule.id, file.path, lineNumber, column, snippet].join("\n"),
    );

    return {
      id: `guard:${hash}`,
      severity: rule.severity,
      ruleRecipeId: rule.ruleRecipeId,
      ruleId: rule.id,
      message: rule.message,
      file: file.path,
      line: lineNumber,
      column,
      language,
      snippet,
      evidence: [],
      ...(rule.fixSuggestion ? { suggestedFix: rule.fixSuggestion } : {}),
      ...(rule.category ? { category: rule.category } : {}),
      metadata: {
        source: rule.source ?? "recipe",
        pattern: rule.pattern,
        reasoning: {
          whatViolated: rule.id,
          whyItMatters: rule.message,
          suggestedFix: rule.fixSuggestion ?? null,
        },
        ...(rule.dimension ? { dimension: rule.dimension } : {}),
      },
    };
  }

  #fileLanguage(file: MainlineGuardFile): string {
    const explicit = file.language?.trim();
    if (explicit) {
      return this.#languageCatalog.normalize(explicit);
    }
    return this.#languageCatalog.normalize(this.#languageCatalog.inferLanguageId(file.path));
  }
}

function compileRules(rules: readonly MainlineGuardRule[]): {
  readonly compiledRules: readonly CompiledRule[];
  readonly warnings: readonly string[];
} {
  const compiledRules: CompiledRule[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    try {
      // Guard 第一阶段只执行 Recipe 给出的行级正则；这里去掉 g/y，避免跨行状态污染。
      const flags = [
        ...new Set((rule.flags ?? "").split("").filter((flag) => "imsu".includes(flag))),
      ].join("");
      compiledRules.push({ rule, pattern: new RegExp(rule.pattern, flags) });
    } catch (error) {
      warnings.push(
        `guard rule ${rule.id} from recipe ${rule.ruleRecipeId} has invalid pattern: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  return { compiledRules, warnings };
}

function appliesToFile(rule: MainlineGuardRule, language: string, isTest: boolean): boolean {
  if (rule.skipTestFiles && isTest) {
    return false;
  }
  return rule.languages.length === 0 || rule.languages.includes(language);
}

function isCommentLine(line: string, language: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
    return true;
  }
  if (language === "python" || language === "ruby") {
    return trimmed.startsWith("#");
  }
  return false;
}

function buildResult(
  fileCount: number,
  ruleCount: number,
  findings: readonly MainlineGuardFinding[],
  warnings: readonly string[],
): MainlineGuardCheckResult {
  return {
    summary: {
      files: fileCount,
      rules: ruleCount,
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      infos: findings.filter((finding) => finding.severity === "info").length,
    },
    findings,
    warnings,
  };
}
