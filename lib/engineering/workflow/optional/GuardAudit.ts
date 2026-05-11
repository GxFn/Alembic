import { isEngineeringGeneratedArtifact } from "../core/EngineeringWorkflowCore.js";
import type {
  EngineeringWorkflowGuardAuditInput,
  EngineeringWorkflowGuardAuditResult,
  EngineeringWorkflowGuardFile,
  EngineeringWorkflowGuardFinding,
  EngineeringWorkflowGuardRuleFact,
  EngineeringWorkflowOptionalDiagnostic,
} from "./EngineeringWorkflowOptionalTypes.js";

export function runOptionalGuardAudit(
  input: EngineeringWorkflowGuardAuditInput,
): EngineeringWorkflowGuardAuditResult {
  const rules = input.ruleFacts ?? [];
  const callbacks = input.callbacks ?? [];
  const diagnostics: EngineeringWorkflowOptionalDiagnostic[] = [];

  if (rules.length === 0 && callbacks.length === 0) {
    diagnostics.push({
      code: "optional.guard.empty",
      severity: "info",
      message: "Guard audit skipped because no rule facts or callbacks were provided.",
      source: "guard-audit",
    });
  }

  const files = filterGeneratedGuardFiles(input.files, input.generatedArtifactBlacklist ?? []);
  const findings: EngineeringWorkflowGuardFinding[] = [];

  for (const file of files) {
    for (const rule of rules) {
      const finding = evaluateRule(rule, file);
      if (finding) {
        findings.push(finding);
      }
    }
    for (const callback of callbacks) {
      try {
        const callbackResult = callback({ file, ruleFacts: rules });
        if (isFindingArray(callbackResult)) {
          findings.push(...callbackResult);
        } else if (callbackResult) {
          findings.push(callbackResult);
        }
      } catch (error: unknown) {
        diagnostics.push({
          code: "optional.guard.callback-failed",
          severity: "warning",
          message: `Guard callback failed for ${file.relativePath ?? file.path}: ${errorMessage(error)}`,
          source: "guard-audit",
        });
      }
    }
  }

  return {
    rules,
    findings,
    diagnostics,
    summary: {
      fileCount: files.length,
      ruleCount: rules.length,
      callbackCount: callbacks.length,
      totalFindings: findings.length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      infos: findings.filter((finding) => finding.severity === "info").length,
    },
  };
}

export function filterGeneratedGuardFiles(
  files: readonly EngineeringWorkflowGuardFile[],
  generatedArtifactBlacklist: readonly string[] = [],
): readonly EngineeringWorkflowGuardFile[] {
  const generated = new Set(generatedArtifactBlacklist);
  return files.filter((file) => {
    const filePath = file.relativePath ?? file.path;
    return (
      !generated.has(filePath) &&
      !generated.has(file.path) &&
      !isEngineeringGeneratedArtifact(filePath)
    );
  });
}

function evaluateRule(
  rule: EngineeringWorkflowGuardRuleFact,
  file: EngineeringWorkflowGuardFile,
): EngineeringWorkflowGuardFinding | null {
  if (rule.languages && file.language && !rule.languages.includes(file.language)) {
    return null;
  }
  if (!rule.pattern) {
    return null;
  }

  const pattern =
    typeof rule.pattern === "string" ? new RegExp(rule.pattern) : cloneRegExp(rule.pattern);
  const match = pattern.exec(file.content);
  if (!match) {
    return null;
  }

  const evidence = match[0].slice(0, 240);
  return {
    ruleId: rule.ruleId,
    severity: rule.severity,
    message: rule.message,
    filePath: file.relativePath ?? file.path,
    line: lineForIndex(file.content, match.index),
    category: rule.category,
    dimension: rule.dimension,
    source: rule.source ?? "rule-fact",
    evidence,
  };
}

function cloneRegExp(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replaceAll("g", ""));
}

function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFindingArray(
  value:
    | EngineeringWorkflowGuardFinding
    | readonly EngineeringWorkflowGuardFinding[]
    | null
    | undefined,
): value is readonly EngineeringWorkflowGuardFinding[] {
  return Array.isArray(value);
}
