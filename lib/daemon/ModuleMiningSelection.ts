import { buildCanonicalCoverageLedgerModuleId } from '@alembic/core/host-agent-workflows';
import type { ProjectContextWorkflowFacts } from '../workflows/project-context/ProjectContextWorkflowFacts.js';
import { uniqueStrings } from './DaemonJobWorkflowHelpers.js';
import type { ModuleMiningModule } from './DaemonJobWorkflowTypes.js';

export interface ModuleMiningSelectionBinding {
  dimensions: readonly string[];
  moduleId?: string;
  moduleName?: string;
  modulePath?: string;
  targetRecipes?: number;
}

export interface SelectScopedModuleMiningModulesInput {
  bindings: readonly ModuleMiningSelectionBinding[];
  executionDimensions: readonly string[];
  facts: ProjectContextWorkflowFacts;
  moduleScope?: readonly string[];
}

export function selectScopedModuleMiningModules(
  input: SelectScopedModuleMiningModulesInput
): ModuleMiningModule[] {
  const bindingDimensions = new Map<string, Set<string>>();
  const bindingTargets = new Map<string, Map<string, number>>();
  const moduleBindingKeys = new Set<string>();

  for (const binding of input.bindings) {
    const keys = moduleBindingCandidateKeys(binding);
    for (const key of keys) {
      moduleBindingKeys.add(key);
      const dimensions = bindingDimensions.get(key) ?? new Set<string>();
      for (const dimension of binding.dimensions) {
        // moduleDimensionTargets 是显式 per-module 计划；即使全局 gap 已判定 fully-covered，也不能被执行维度过滤掉。
        dimensions.add(dimension);
        const targetRecipes = nonNegativeNumber(binding.targetRecipes);
        if (targetRecipes !== null) {
          const targets = bindingTargets.get(key) ?? new Map<string, number>();
          targets.set(dimension, Math.max(targets.get(dimension) ?? 0, targetRecipes));
          bindingTargets.set(key, targets);
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
    .flatMap((module): ModuleMiningModule[] => {
      const moduleKeys = projectMapModuleCandidateKeys(module);
      const moduleId = canonicalProjectMapModuleId(module, input.facts.projectRoot);
      if (!moduleId) {
        return [];
      }
      const plannedDimensions = uniqueStrings(
        moduleKeys.flatMap((key) => [...(bindingDimensions.get(key) ?? [])])
      );
      const dimensions =
        plannedDimensions.length > 0 ? plannedDimensions : [...input.executionDimensions];
      const plannedDimensionTargets = buildPlannedDimensionTargets(
        moduleKeys,
        dimensions,
        bindingTargets
      );
      const targetRecipes = Math.max(0, ...Object.values(plannedDimensionTargets));
      return [
        {
          dimensions,
          dimensionIds: dimensions,
          moduleId,
          moduleName: module.moduleName,
          modulePath: module.modulePath,
          ownedFiles: module.ownedFiles,
          ...(Object.keys(plannedDimensionTargets).length > 0 ? { plannedDimensionTargets } : {}),
          plannedDimensions: dimensions,
          role: module.role,
          ...(targetRecipes > 0 ? { targetRecipes } : {}),
        },
      ];
    })
    .filter((module) => module.moduleName.trim().length > 0);
}

function buildPlannedDimensionTargets(
  moduleKeys: readonly string[],
  dimensions: readonly string[],
  bindingTargets: ReadonlyMap<string, ReadonlyMap<string, number>>
): Record<string, number> {
  const targets: Record<string, number> = {};
  for (const dimension of dimensions) {
    for (const key of moduleKeys) {
      const targetRecipes = bindingTargets.get(key)?.get(dimension);
      if (targetRecipes !== undefined) {
        targets[dimension] = Math.max(targets[dimension] ?? 0, targetRecipes);
      }
    }
  }
  return targets;
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
  return uniqueStrings([
    module.moduleId,
    module.moduleName,
    module.modulePath ?? '',
    canonicalProjectMapModuleId(module) ?? '',
  ]);
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function canonicalProjectMapModuleId(
  module: {
    moduleId: string;
    moduleName: string;
    modulePath?: string;
  },
  projectRoot?: string
): string | undefined {
  return buildCanonicalCoverageLedgerModuleId({
    moduleId: module.moduleId,
    moduleName: module.moduleName,
    modulePath: module.modulePath,
    projectRoot,
  });
}
