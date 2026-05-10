import type { RecipeInjectionCompressedBundle } from "../runtime/RecipeInjectionCompressor.js";

export class AgentContextPresenter {
  render(bundle: RecipeInjectionCompressedBundle): string {
    const lines: string[] = ["# Alembic Prime", ""];

    if (bundle.recipes.length === 0) {
      lines.push("No project Recipes matched this task.", "");
    } else {
      lines.push("## Recipes", "");
      for (const recipe of bundle.recipes) {
        lines.push(`### ${recipe.title}`, "", `- id: ${recipe.id}`);
        pushOptionalLine(lines, "when", recipe.when);
        pushOptionalLine(lines, "do", recipe.do);
        pushOptionalLine(lines, "don't", recipe.dont);
        if (recipe.coreCode) {
          lines.push("", "```ts", recipe.coreCode, "```");
        }
        if (recipe.usageGuide) {
          lines.push("", recipe.usageGuide);
        }
        lines.push("");
      }
    }

    if (bundle.warnings.length > 0) {
      lines.push("## Warnings", "");
      for (const warning of bundle.warnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("");
    }

    // 中文注释：agent 注入层只产出纯 Markdown，不绑定 dashboard 或插件前端。
    return `${lines.join("\n").trimEnd()}\n`;
  }
}

function pushOptionalLine(lines: string[], label: string, value: string | undefined): void {
  if (value) {
    lines.push(`- ${label}: ${value}`);
  }
}
