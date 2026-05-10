import type { GuardFinding } from "./GuardFinding.js";
import type { Recipe } from "./Recipe.js";
import type { RecipeEdge } from "./RecipeEdge.js";
import type { SourceRef } from "./SourceRef.js";

/**
 * ActiveWorkContext 描述当前开发现场。
 * 运行期代码应该从任务文本、活动文件、diff、错误中构造它，然后停止；
 * 它本身不能触发编译期 rescan。
 */
export interface ActiveWorkContext {
  projectRoot: string;
  taskText?: string | undefined;
  files: string[];
  symbols?: string[] | undefined;
  diff?: string | undefined;
  errors?: RuntimeError[] | undefined;
  commandIntent?: string | undefined;
  userFocus?: string | undefined;
}

export interface RuntimeError {
  message: string;
  file?: string | undefined;
  line?: number | undefined;
  stack?: string | undefined;
}

export interface BundleRisk {
  id: string;
  message: string;
  severity: "info" | "warning" | "error";
  recipeIds: string[];
}

export interface BundleAction {
  id: string;
  label: string;
  kind: "read" | "apply" | "guard" | "capture" | "rescan";
  recipeIds: string[];
}

export interface CapturePrompt {
  id: string;
  prompt: string;
  sourceRefIds: string[];
}

/**
 * ContextBundle 是 Alembic 交给 Codex、IDE、Guard 和 dashboard 视图的运行期产物。
 * 它刻意比 wiki 页面更小，但比扁平 search result 更有结构。
 */
export interface ContextBundle {
  id: string;
  activeContext: ActiveWorkContext;
  recipes: Recipe[];
  edges: RecipeEdge[];
  sourceRefs: SourceRef[];
  guardFindings: GuardFinding[];
  risks: BundleRisk[];
  suggestedActions: BundleAction[];
  capturePrompts: CapturePrompt[];
  createdAt: number;
  metadata?: Record<string, unknown> | undefined;
}
