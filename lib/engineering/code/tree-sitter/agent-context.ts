import { stringArray, stringValue } from "../ast/normalizer-utils.js";
import type { EngineeringInheritanceEdge } from "./project-summary.js";

export function generateContextForAgent(projectSummary: {
  readonly fileCount?: number;
  readonly classes?: readonly Record<string, unknown>[];
  readonly protocols?: readonly Record<string, unknown>[];
  readonly categories?: readonly Record<string, unknown>[];
  readonly inheritanceGraph?: readonly EngineeringInheritanceEdge[];
  readonly patternStats?: Record<string, { readonly count?: number }>;
  readonly projectMetrics?: Record<string, unknown>;
}): string {
  const classes = projectSummary.classes ?? [];
  const protocols = projectSummary.protocols ?? [];
  const categories = projectSummary.categories ?? [];
  const inheritanceGraph = projectSummary.inheritanceGraph ?? [];
  const patternStats = projectSummary.patternStats ?? {};
  const projectMetrics = projectSummary.projectMetrics ?? {};
  const lines = ["## 项目代码结构分析（AST）", ""];

  lines.push("### 代码规模");
  lines.push(`- 已分析文件: ${projectSummary.fileCount ?? 0}`);
  lines.push(`- 类/结构体: ${classes.length}`);
  lines.push(`- 协议: ${protocols.length}`);
  lines.push(`- Category/Extension: ${categories.length}`);
  lines.push(`- 平均方法数/类: ${formatMetric(projectMetrics.avgMethodsPerClass)}`);
  lines.push(`- 最大嵌套深度: ${formatMetric(projectMetrics.maxNestingDepth)}`);
  lines.push("");

  if (inheritanceGraph.length > 0) {
    lines.push("### 继承关系图");
    lines.push("```");
    lines.push(renderInheritanceTree(inheritanceGraph));
    lines.push("```");
    lines.push("");
  }

  const conformances = classes.filter((entry) => stringArray(entry.protocols).length > 0);
  if (conformances.length > 0) {
    lines.push("### 协议遵循");
    for (const entry of conformances.slice(0, 20)) {
      lines.push(
        `- \`${stringValue(entry.name, "Unknown")}\` -> ${stringArray(entry.protocols)
          .map((protocol) => `\`${protocol}\``)
          .join(", ")}`,
      );
    }
    lines.push("");
  }

  if (categories.length > 0) {
    lines.push("### Category / Extension");
    for (const entry of categories.slice(0, 15)) {
      const className = stringValue(entry.className ?? entry.targetClass, "Unknown");
      const categoryName = stringValue(entry.categoryName ?? entry.name, "extension");
      lines.push(`- \`${className}(${categoryName})\``);
    }
    lines.push("");
  }

  if (Object.keys(patternStats).length > 0) {
    lines.push("### 检测到的设计模式");
    for (const [type, stat] of Object.entries(patternStats)) {
      lines.push(`- **${type}**: ${stat.count ?? 0} 处`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderInheritanceTree(edges: readonly EngineeringInheritanceEdge[]): string {
  const children = new Map<string, string[]>();
  const childNodes = new Set<string>();
  for (const edge of edges) {
    const list = children.get(edge.to) ?? [];
    list.push(edge.from);
    children.set(edge.to, list);
    childNodes.add(edge.from);
  }
  const roots = [...children.keys()].filter((node) => !childNodes.has(node)).sort();
  const lines: string[] = [];
  const visit = (node: string, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}${node}`);
    for (const child of (children.get(node) ?? []).sort()) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  return lines.join("\n");
}

function formatMetric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "0";
}
