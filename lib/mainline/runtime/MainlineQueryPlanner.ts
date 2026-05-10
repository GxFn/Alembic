import { uniqueMainlinePosixPaths } from "../core/index.js";
import type { ActiveWorkContext, RuntimeError } from "../knowledge/index.js";

export type MainlineQueryVariantKind = "intent" | "path" | "symbol" | "diagnostic";

export interface MainlineQueryVariant {
  readonly kind: MainlineQueryVariantKind;
  readonly text?: string;
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
}

export interface MainlineQueryPlan {
  readonly variants: MainlineQueryVariant[];
}

/**
 * MainlineQueryPlanner 只生成稀疏检索查询变体。
 * 它不调用 AI，也不把运行期检索退回到旧 SearchEngine。
 */
export class MainlineQueryPlanner {
  plan(context: ActiveWorkContext): MainlineQueryPlan {
    const variants: MainlineQueryVariant[] = [];
    const intentText = [context.taskText, context.commandIntent, context.userFocus]
      .filter(Boolean)
      .join("\n");
    if (intentText) {
      variants.push({ kind: "intent", text: intentText });
    }
    if (context.files.length > 0) {
      variants.push({ kind: "path", paths: uniqueMainlinePosixPaths(context.files) });
    }
    if ((context.symbols?.length ?? 0) > 0) {
      variants.push({ kind: "symbol", symbols: [...new Set(context.symbols)] });
    }
    const diagnostics = diagnosticText(context.errors ?? []);
    if (diagnostics) {
      variants.push({ kind: "diagnostic", text: diagnostics });
    }
    return { variants };
  }
}

function diagnosticText(errors: readonly RuntimeError[]): string {
  return errors
    .map((error) => [error.file, error.line, error.message].filter(Boolean).join(":"))
    .join("\n");
}
