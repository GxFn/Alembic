import type { ContextIndexReader } from "../data/index.js";
import type { ActiveWorkContext, ContextBundle, Recipe } from "../knowledge/index.js";
import {
  ActiveWorkContextBuilder,
  type ActiveWorkContextBuildInput,
  ContextBundleBuilder,
  RuntimeRetrievalPipeline,
} from "../runtime/index.js";
import type { MainlineSearchIndex } from "../search/index.js";
import { type AgentInjectionPlan, AgentInjectionPlanner } from "./AgentInjectionPlanner.js";

export interface KnowledgeInjectionRunnerRequest {
  readonly activeWorkContext: ActiveWorkContextBuildInput;
}

export interface KnowledgeInjectionRunnerResult {
  readonly activeContext: ActiveWorkContext;
  readonly bundle: ContextBundle;
  readonly plan: AgentInjectionPlan;
  readonly markdown: string;
}

export interface KnowledgeInjectionRunnerDependencies {
  readonly activeWorkContextBuilder?: ActiveWorkContextBuilder;
  readonly bundleBuilder?: ContextBundleBuilder;
  readonly searchIndex?: MainlineSearchIndex;
  readonly retrievalPipeline?: RuntimeRetrievalPipeline;
  readonly planner?: AgentInjectionPlanner;
}

/**
 * KnowledgeInjectionRunner 是知识注入主线的薄编排层。
 * 它只把当前开发现场转成 ContextBundle，再转成只读注入计划。
 * 默认富召回路径由传入的 RuntimeRetrievalPipeline/MainlineSearchIndex 注入到 ContextBundleBuilder；
 * 不扫描项目、不写 ContextIndex、不调用 AI、不执行 AgentRuntime。
 */
export class KnowledgeInjectionRunner {
  readonly #activeWorkContextBuilder: ActiveWorkContextBuilder;
  readonly #bundleBuilder: ContextBundleBuilder;
  readonly #retrievalPipeline: RuntimeRetrievalPipeline | undefined;
  readonly #planner: AgentInjectionPlanner;

  constructor(index: ContextIndexReader, dependencies: KnowledgeInjectionRunnerDependencies = {}) {
    this.#activeWorkContextBuilder =
      dependencies.activeWorkContextBuilder ?? new ActiveWorkContextBuilder();
    this.#bundleBuilder =
      dependencies.bundleBuilder ?? createDefaultBundleBuilder(index, dependencies);
    this.#retrievalPipeline =
      dependencies.retrievalPipeline ??
      (dependencies.searchIndex
        ? new RuntimeRetrievalPipeline(index, dependencies.searchIndex)
        : undefined);
    this.#planner = dependencies.planner ?? new AgentInjectionPlanner();
  }

  /** 固定执行“现场归一 -> bundle 召回 -> 注入计划 -> Markdown”这一条只读路径。 */
  async run(request: KnowledgeInjectionRunnerRequest): Promise<KnowledgeInjectionRunnerResult> {
    const activeContext = this.#activeWorkContextBuilder.build(request.activeWorkContext);
    if (!this.#retrievalPipeline) {
      throw new Error("KnowledgeInjectionRunner requires searchIndex or retrievalPipeline.");
    }
    const retrieval = await this.#retrievalPipeline.retrieve(activeContext);
    const bundle = await this.#bundleBuilder.build(retrieval);
    const plan = this.#planner.plan(bundle);

    return {
      activeContext,
      bundle,
      plan,
      markdown: plan.markdown,
    };
  }
}

function createDefaultBundleBuilder(
  index: ContextIndexReader,
  dependencies: KnowledgeInjectionRunnerDependencies,
): ContextBundleBuilder {
  const recipeResolver = createRecipeResolver(index);
  if (dependencies.bundleBuilder) {
    return dependencies.bundleBuilder;
  }
  return new ContextBundleBuilder({
    recipeResolver,
  });
}

function createRecipeResolver(
  index: ContextIndexReader,
): ((recipeIds: readonly string[]) => Promise<readonly Recipe[]>) | undefined {
  const lookup = index as ContextIndexReader & {
    findRecipesByIds?(recipeIds: readonly string[]): Promise<Recipe[]>;
  };
  const findRecipesByIds = lookup.findRecipesByIds?.bind(lookup);
  return findRecipesByIds
    ? (recipeIds: readonly string[]) => findRecipesByIds(recipeIds)
    : undefined;
}
