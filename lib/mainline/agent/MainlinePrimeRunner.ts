import type { ContextIndexReader } from "../data/index.js";
import type { ActiveWorkContext, ContextBundle, Recipe } from "../knowledge/index.js";
import {
  ActiveWorkContextBuilder,
  type ActiveWorkContextBuildInput,
} from "../runtime/ActiveWorkContextBuilder.js";
import { ContextBundleBuilder } from "../runtime/ContextBundleBuilder.js";
import { RuntimeContextLoader } from "../runtime/RuntimeContextLoader.js";
import {
  RuntimeRetrievalPipeline,
  type RuntimeRetrievalResult,
} from "../runtime/RuntimeRetrievalPipeline.js";
import type { MainlineSearchIndex } from "../search/index.js";
import { type AgentInjectionPlan, AgentInjectionPlanner } from "./AgentInjectionPlanner.js";

export interface MainlinePrimeRunnerDependencies {
  readonly contextIndex?: ContextIndexReader;
  readonly searchIndex?: MainlineSearchIndex;
  readonly contextLoader?: RuntimeContextLoader;
  readonly activeContextBuilder?: ActiveWorkContextBuilder;
  readonly bundleBuilder?: ContextBundleBuilder;
  readonly injectionPlanner?: AgentInjectionPlanner;
}

export interface MainlinePrimeRunnerRequest extends ActiveWorkContextBuildInput {
  readonly contextIndex?: ContextIndexReader;
  readonly searchIndex?: MainlineSearchIndex;
  readonly contextLoader?: RuntimeContextLoader;
}

export interface MainlinePrimeRunnerResult {
  readonly activeContext: ActiveWorkContext;
  readonly retrieval: RuntimeRetrievalResult;
  readonly bundle: ContextBundle;
  readonly injection: AgentInjectionPlan;
  readonly markdown: string;
  readonly recipeIds: readonly string[];
  readonly hints: readonly string[];
  readonly searchHitCount: number;
}

export class MainlinePrimeRunner {
  readonly #contextIndex: ContextIndexReader | undefined;
  readonly #searchIndex: MainlineSearchIndex | undefined;
  readonly #contextLoader: RuntimeContextLoader | undefined;
  readonly #activeContextBuilder: ActiveWorkContextBuilder;
  readonly #bundleBuilder: ContextBundleBuilder | undefined;
  readonly #injectionPlanner: AgentInjectionPlanner;

  constructor(dependencies: MainlinePrimeRunnerDependencies = {}) {
    this.#contextIndex = dependencies.contextIndex;
    this.#searchIndex = dependencies.searchIndex;
    this.#contextLoader = dependencies.contextLoader;
    this.#activeContextBuilder =
      dependencies.activeContextBuilder ?? new ActiveWorkContextBuilder();
    this.#bundleBuilder = dependencies.bundleBuilder;
    this.#injectionPlanner = dependencies.injectionPlanner ?? new AgentInjectionPlanner();
  }

  async run(request: MainlinePrimeRunnerRequest): Promise<MainlinePrimeRunnerResult> {
    const loader =
      request.contextLoader ??
      this.#contextLoader ??
      new RuntimeContextLoader({
        contextIndex: request.contextIndex ?? this.#contextIndex,
        searchIndex: request.searchIndex ?? this.#searchIndex,
      });
    const { contextIndex, searchIndex } = await loader.load();

    const activeContext = this.#activeContextBuilder.build(request);
    // 中文注释：prime 只读已编译索引，避免运行期回扫 docs-dev 或旧 Markdown。
    const retrieval = await new RuntimeRetrievalPipeline(contextIndex, searchIndex).retrieve(
      activeContext,
    );
    const bundleBuilder =
      this.#bundleBuilder ??
      new ContextBundleBuilder({
        recipeResolver: createRecipeResolver(contextIndex),
      });
    const bundle = await bundleBuilder.build(retrieval);
    const injection = this.#injectionPlanner.plan(bundle);

    return {
      activeContext,
      retrieval,
      bundle,
      injection,
      markdown: injection.markdown,
      recipeIds: injection.recipeIds,
      hints: retrieval.hints.map((hint) => `${hint.kind}:${hint.sourceRefIds?.join(",") ?? ""}`),
      searchHitCount: retrieval.searchHits.length,
    };
  }
}

function createRecipeResolver(
  contextIndex: ContextIndexReader,
): ((recipeIds: readonly string[]) => Promise<readonly Recipe[]>) | undefined {
  const lookup = contextIndex as ContextIndexReader & {
    findRecipesByIds?(recipeIds: readonly string[]): Promise<Recipe[]>;
  };
  const findRecipesByIds = lookup.findRecipesByIds?.bind(lookup);
  return findRecipesByIds
    ? (recipeIds: readonly string[]) => findRecipesByIds(recipeIds)
    : undefined;
}
