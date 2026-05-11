import type { EngineeringCodeAstMethodFact, EngineeringCodeAstMetricsFact } from "../ast/index.js";
import type { TreeSitterNode } from "./types.js";

const ECMA_BRANCH_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "switch_statement",
  "case_clause",
  "catch_clause",
  "ternary_expression",
  "conditional_expression",
]);

const PYTHON_BRANCH_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "elif_clause",
  "except_clause",
  "with_statement",
  "conditional_expression",
  "list_comprehension",
]);

const ECMA_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "switch_statement",
]);

const PYTHON_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "with_statement",
  "try_statement",
]);

export function estimateComplexity(
  node: TreeSitterNode,
  languageFamily: "ecma" | "python",
): number {
  let complexity = 1;
  const branchTypes = languageFamily === "python" ? PYTHON_BRANCH_TYPES : ECMA_BRANCH_TYPES;

  function walk(current: TreeSitterNode): void {
    if (branchTypes.has(current.type)) {
      complexity++;
    }
    if (current.type === "binary_expression") {
      const op = current.children?.find((child) => child.text === "&&" || child.text === "||");
      if (op) {
        complexity++;
      }
    }
    if (current.type === "boolean_operator") {
      complexity++;
    }
    for (let index = 0; index < current.namedChildCount; index++) {
      const child = current.namedChild(index);
      if (child) {
        walk(child);
      }
    }
  }

  walk(node);
  return complexity;
}

export function maxNesting(
  node: TreeSitterNode,
  depth: number,
  languageFamily: "ecma" | "python",
): number {
  const nestingTypes = languageFamily === "python" ? PYTHON_NESTING_TYPES : ECMA_NESTING_TYPES;
  let max = depth;
  const nextDepth = nestingTypes.has(node.type) ? depth + 1 : depth;

  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }
    const childMax = maxNesting(child, nextDepth, languageFamily);
    if (childMax > max) {
      max = childMax;
    }
  }

  return max;
}

export function computeMetrics(
  methods: readonly EngineeringCodeAstMethodFact[],
): EngineeringCodeAstMetricsFact {
  const definitions = methods.filter(
    (method) => (method as unknown as Record<string, unknown>).kind === "definition",
  );
  const totalBodyLines = definitions.reduce((sum, method) => sum + (method.bodyLines ?? 0), 0);

  return {
    methodCount: definitions.length,
    avgBodyLines: definitions.length > 0 ? totalBodyLines / definitions.length : 0,
    maxComplexity:
      definitions.length > 0 ? Math.max(...definitions.map((method) => method.complexity ?? 1)) : 0,
    maxNestingDepth:
      definitions.length > 0
        ? Math.max(
            ...definitions.map((method) =>
              Number((method as unknown as Record<string, unknown>).nestingDepth ?? 0),
            ),
          )
        : 0,
    longMethods: definitions.filter((method) => (method.bodyLines ?? 0) > 50),
    complexMethods: definitions.filter((method) => (method.complexity ?? 1) > 10),
  };
}
