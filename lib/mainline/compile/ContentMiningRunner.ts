import type { RecipeMarkdownFileIndex } from "../data/index.js";
import type { Recipe } from "../knowledge/index.js";
import type { CompileArtifactWriter } from "./CompileArtifactWriter.js";
import {
  ContentMiningPipeline,
  type ContentMiningPipelineArtifacts,
} from "./ContentMiningPipeline.js";
import {
  IncrementalEvidenceCompiler,
  type IncrementalEvidenceCompilerRequest,
} from "./IncrementalEvidenceCompiler.js";

export interface ContentMiningRunnerRequest {
  readonly evidenceRequest: IncrementalEvidenceCompilerRequest;
  readonly recipes?: readonly Recipe[];
  readonly recipeFiles?: readonly RecipeMarkdownFileIndex[];
  readonly reportId?: string;
  readonly generatedAt?: number;
}

export interface ContentMiningRunnerDependencies {
  readonly evidenceCompiler?: IncrementalEvidenceCompiler;
  readonly pipeline?: ContentMiningPipeline;
}

/**
 * ContentMiningRunner 是内容挖掘的编译期编排层。
 * 中文注释：它固定串起“增量证据编译 -> 内容挖掘 -> artifact 写入”，
 * 上层不再绕过 EvidencePackage 直接把 changedFiles/sourceRefs 塞进 ContextIndex。
 */
export class ContentMiningRunner {
  readonly #writer: CompileArtifactWriter;
  readonly #evidenceCompiler: IncrementalEvidenceCompiler;
  readonly #pipeline: ContentMiningPipeline;

  constructor(writer: CompileArtifactWriter, dependencies: ContentMiningRunnerDependencies = {}) {
    this.#writer = writer;
    this.#evidenceCompiler = dependencies.evidenceCompiler ?? new IncrementalEvidenceCompiler();
    this.#pipeline = dependencies.pipeline ?? new ContentMiningPipeline();
  }

  async compileAndWrite(
    request: ContentMiningRunnerRequest,
  ): Promise<ContentMiningPipelineArtifacts> {
    const evidencePackage = await this.#evidenceCompiler.compile(request.evidenceRequest);
    const artifacts = this.#pipeline.compile({
      evidencePackage,
      ...(request.recipes ? { recipes: request.recipes } : {}),
      ...(request.recipeFiles ? { recipeFiles: request.recipeFiles } : {}),
      ...(request.reportId ? { reportId: request.reportId } : {}),
      ...(request.generatedAt !== undefined ? { generatedAt: request.generatedAt } : {}),
    });

    await artifacts.writeWith(this.#writer);
    return artifacts;
  }
}
