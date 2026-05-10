import type { GuardFinding, GuardFindingSeverity, Recipe } from "../mainline/knowledge/index.js";

export interface MainlineGuardRule {
  readonly id: string;
  readonly ruleRecipeId: string;
  readonly pattern: string;
  readonly flags?: string;
  readonly message: string;
  readonly severity: GuardFindingSeverity;
  readonly languages: readonly string[];
  readonly category?: string;
  readonly dimension?: string;
  readonly fixSuggestion?: string;
  readonly skipComments?: boolean;
  readonly skipTestFiles?: boolean;
  readonly source?: string;
}

export interface MainlineGuardRuleLoadResult {
  readonly rules: readonly MainlineGuardRule[];
  readonly warnings: readonly string[];
}

export interface MainlineGuardRuleProvider {
  load(): Promise<readonly MainlineGuardRule[] | MainlineGuardRuleLoadResult>;
}

export interface MainlineGuardRecipeProvider {
  load(): Promise<readonly Recipe[]>;
}

export interface MainlineGuardFile {
  readonly path: string;
  readonly content: string;
  readonly language?: string;
  readonly isTest?: boolean;
}

export interface MainlineGuardCheckOptions {
  readonly maxFindings?: number;
  readonly maxFindingsPerRule?: number;
}

export interface MainlineGuardCheckRequest {
  readonly files: readonly MainlineGuardFile[];
  readonly rules?: readonly MainlineGuardRule[];
  readonly options?: MainlineGuardCheckOptions;
}

export interface MainlineGuardFinding extends GuardFinding {
  readonly ruleId: string;
  readonly language: string;
  readonly snippet: string;
  readonly column?: number;
  readonly category?: string;
}

export interface MainlineGuardCheckSummary {
  readonly files: number;
  readonly rules: number;
  readonly findings: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export interface MainlineGuardCheckResult {
  readonly summary: MainlineGuardCheckSummary;
  readonly findings: readonly MainlineGuardFinding[];
  readonly warnings: readonly string[];
}
