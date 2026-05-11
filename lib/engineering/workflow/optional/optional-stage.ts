import type { EngineeringFile } from "../../foundation/types.js";
import { gateOptionalDimensions } from "./dimension-gating.js";
import { preprocessEnhancements } from "./enhancement-preprocessor.js";
import { runOptionalGuardAudit } from "./guard-audit.js";
import type {
  EngineeringWorkflowGuardFile,
  EngineeringWorkflowOptionalStageInput,
  EngineeringWorkflowOptionalStageResult,
} from "./types.js";

export function runEngineeringWorkflowOptionalStage(
  input: EngineeringWorkflowOptionalStageInput,
): EngineeringWorkflowOptionalStageResult {
  const enhancement = preprocessEnhancements(input);
  const guardFiles =
    input.guardFiles ?? guardFilesFromEngineeringFiles(input.files ?? [], input.fileContents ?? {});
  const guard = runOptionalGuardAudit({
    files: guardFiles,
    ruleFacts: input.guardRuleFacts ?? [],
    callbacks: input.guardCallbacks ?? [],
    ...(input.generatedArtifactBlacklist === undefined
      ? {}
      : { generatedArtifactBlacklist: input.generatedArtifactBlacklist }),
  });
  const enhancementReaudit =
    enhancement.guardRules.length > 0
      ? runOptionalGuardAudit({
          files: guardFiles,
          ruleFacts: [...(input.guardRuleFacts ?? []), ...enhancement.guardRules],
          callbacks: input.guardCallbacks ?? [],
          ...(input.generatedArtifactBlacklist === undefined
            ? {}
            : { generatedArtifactBlacklist: input.generatedArtifactBlacklist }),
        })
      : null;
  const dimensions = gateOptionalDimensions({
    dimensions: [...(input.dimensions ?? []), ...enhancement.dimensions],
    enhancementSignals: enhancement.signals,
    ...(input.panoramaSnapshot === undefined ? {} : { snapshot: input.panoramaSnapshot }),
    ...(input.gaps === undefined ? {} : { gaps: input.gaps }),
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.generatedArtifactBlacklist === undefined
      ? {}
      : { generatedArtifactBlacklist: input.generatedArtifactBlacklist }),
  });

  return {
    enhancement,
    guard,
    enhancementReaudit,
    dimensions,
    diagnostics: [
      ...enhancement.diagnostics,
      ...guard.diagnostics,
      ...(enhancementReaudit?.diagnostics ?? []),
      ...dimensions.diagnostics,
    ],
  };
}

function guardFilesFromEngineeringFiles(
  files: readonly EngineeringFile[],
  fileContents: Readonly<Record<string, string>>,
): readonly EngineeringWorkflowGuardFile[] {
  const guardFiles: EngineeringWorkflowGuardFile[] = [];
  for (const file of files) {
    const filePath = file.relativePath || file.path;
    const content = fileContents[filePath] ?? fileContents[file.path];
    if (content === undefined) {
      continue;
    }
    guardFiles.push({
      path: file.path,
      relativePath: filePath,
      content,
      ...(file.language === undefined ? {} : { language: file.language }),
      ...(file.isTest === undefined ? {} : { isTest: file.isTest }),
    });
  }
  return guardFiles;
}
