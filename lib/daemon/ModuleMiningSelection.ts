import type { ProjectContextWorkflowFacts } from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import { uniqueStrings } from './DaemonJobWorkflowHelpers.js';
import type { ModuleMiningModule } from './DaemonJobWorkflowTypes.js';

export interface ModuleMiningSelectionBinding {
  dimensions: readonly string[];
  moduleId?: string;
  moduleName?: string;
  modulePath?: string;
}

export interface SelectProjectIndexModuleMiningModulesInput {
  bindings: readonly ModuleMiningSelectionBinding[];
  executionDimensions: readonly string[];
  facts: ProjectContextWorkflowFacts;
  moduleScope?: readonly string[];
}

export function selectProjectIndexModuleMiningModules(
  input: SelectProjectIndexModuleMiningModulesInput
): ModuleMiningModule[] {
  const bindingDimensions = new Map<string, Set<string>>();
  const moduleBindingKeys = new Set<string>();
  const executionDimensions = new Set(input.executionDimensions);

  for (const binding of input.bindings) {
    const keys = moduleBindingCandidateKeys(binding);
    for (const key of keys) {
      moduleBindingKeys.add(key);
      const dimensions = bindingDimensions.get(key) ?? new Set<string>();
      for (const dimension of binding.dimensions) {
        if (executionDimensions.has(dimension)) {
          dimensions.add(dimension);
        }
      }
      bindingDimensions.set(key, dimensions);
    }
  }

  const scopedModules = new Set(input.moduleScope ?? []);
  return input.facts.projectMapModules
    .filter((module) => {
      const moduleKeys = projectMapModuleCandidateKeys(module);
      const matchesModuleBinding =
        moduleBindingKeys.size === 0 || moduleKeys.some((key) => moduleBindingKeys.has(key));
      const matchesModuleScope =
        scopedModules.size === 0 || moduleKeys.some((key) => scopedModules.has(key));
      return matchesModuleBinding && matchesModuleScope;
    })
    .map((module): ModuleMiningModule => {
      const moduleKeys = projectMapModuleCandidateKeys(module);
      const plannedDimensions = uniqueStrings(
        moduleKeys.flatMap((key) => [...(bindingDimensions.get(key) ?? [])])
      );
      const dimensions =
        plannedDimensions.length > 0 ? plannedDimensions : [...input.executionDimensions];
      return {
        dimensions,
        dimensionIds: dimensions,
        moduleId: module.moduleId,
        moduleName: module.moduleName,
        modulePath: module.modulePath,
        ownedFiles: module.ownedFiles,
        plannedDimensions: dimensions,
        role: module.role,
      };
    })
    .filter((module) => module.moduleName.trim().length > 0);
}

function moduleBindingCandidateKeys(binding: ModuleMiningSelectionBinding): string[] {
  return uniqueStrings([
    binding.moduleId ?? '',
    binding.moduleName ?? '',
    binding.modulePath ?? '',
    moduleNameFromBinding(binding),
  ]);
}

function moduleNameFromBinding(binding: ModuleMiningSelectionBinding): string {
  return (
    binding.moduleName ||
    binding.modulePath?.split('/').filter(Boolean).at(-1) ||
    binding.moduleId ||
    ''
  );
}

function projectMapModuleCandidateKeys(module: {
  moduleId: string;
  moduleName: string;
  modulePath?: string;
}): string[] {
  return uniqueStrings([module.moduleId, module.moduleName, module.modulePath ?? '']);
}
