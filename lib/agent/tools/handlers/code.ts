import {
  MainlineGuardCheckEngine,
  type MainlineGuardFile,
  type MainlineGuardRule,
  type MainlineGuardRuleLoadResult,
} from "../../../guard/index.js";
import type { ToolHandler, ToolRuntimeDependencies } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

interface CodeGuardInput {
  readonly files: readonly MainlineGuardFile[];
  readonly maxFindings?: number;
  readonly maxFindingsPerRule?: number;
}

export const codeGuardHandler: ToolHandler = async (invocation, context) => {
  const parsed = parseCodeGuardInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const loaded = await loadGuardRules(context.dependencies);
  if (!loaded) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "guard_rules_unavailable",
      message: "code.guard requires mainline guard-rule Recipe dependencies.",
    });
  }

  const result = new MainlineGuardCheckEngine({ rules: loaded.rules }).check({
    files: parsed.input.files,
    options: {
      ...(parsed.input.maxFindings ? { maxFindings: parsed.input.maxFindings } : {}),
      ...(parsed.input.maxFindingsPerRule
        ? { maxFindingsPerRule: parsed.input.maxFindingsPerRule }
        : {}),
    },
  });

  return toolSuccess(context.descriptor, {
    summary: result.summary,
    findings: result.findings,
    warnings: [...loaded.warnings, ...result.warnings],
  });
};

async function loadGuardRules(
  dependencies: ToolRuntimeDependencies,
): Promise<MainlineGuardRuleLoadResult | null> {
  if (dependencies.guardRules) {
    return { rules: dependencies.guardRules, warnings: [] };
  }

  const provider = dependencies.guardRuleProvider;
  if (!provider) {
    return null;
  }

  const loaded = typeof provider === "function" ? await provider() : await provider.load();
  if (isGuardRuleArray(loaded)) {
    return { rules: loaded, warnings: [] };
  }
  return loaded;
}

function parseCodeGuardInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: CodeGuardInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard input must be an object." },
    };
  }

  const files = parseFiles(input.files);
  if (!files) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard files must contain path/content." },
    };
  }

  const maxFindings = boundedInteger(input.maxFindings, 1, 1000);
  const maxFindingsPerRule = boundedInteger(input.maxFindingsPerRule, 1, 100);
  if (input.maxFindings !== undefined && maxFindings === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "code.guard maxFindings must be an integer." },
    };
  }
  if (input.maxFindingsPerRule !== undefined && maxFindingsPerRule === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "code.guard maxFindingsPerRule must be an integer.",
      },
    };
  }

  return {
    ok: true,
    input: {
      files,
      ...(maxFindings ? { maxFindings } : {}),
      ...(maxFindingsPerRule ? { maxFindingsPerRule } : {}),
    },
  };
}

function parseFiles(value: unknown): MainlineGuardFile[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const files: MainlineGuardFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const path = stringValue(item.path);
    const content = typeof item.content === "string" ? item.content : undefined;
    if (!path || content === undefined) {
      return null;
    }
    const language = stringValue(item.language);
    files.push({
      path,
      content,
      ...(language ? { language } : {}),
      ...(typeof item.isTest === "boolean" ? { isTest: item.isTest } : {}),
    });
  }
  return files;
}

function isGuardRuleArray(value: unknown): value is readonly MainlineGuardRule[] {
  return Array.isArray(value);
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number") {
    return undefined;
  }
  return value >= min && value <= max ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
