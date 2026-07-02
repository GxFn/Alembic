import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanSelectionProjection } from '@alembic/core/plans';
import type { DimensionDef } from '@alembic/core/types';
import { describe, expect, test } from 'vitest';
import { resolveColdStartWorkflowDimensionSelection } from '../../lib/recipe-pipeline/generate/ColdStartWorkflow.js';

const dimensions: DimensionDef[] = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'code-patterns', label: 'Code Patterns' },
  { id: 'project-profile', label: 'Project Profile' },
  { id: 'agent-guidelines', label: 'Agent Guidelines' },
] as DimensionDef[];

function projection(
  executionDimensions: string[],
  budget: PlanSelectionProjection['budget'] = {
    contentMaxLines: 60,
    maxFiles: 200,
    totalRecipeBudget: 7,
  }
): PlanSelectionProjection {
  return {
    budget,
    executionDimensions,
    moduleScope: ['lib/api'],
  };
}

describe('coldStart plan-driven dimension selection', () => {
  test('uses plan executionDimensions instead of the full base dimension set', () => {
    const result = resolveColdStartWorkflowDimensionSelection({
      planSelectionProjection: projection(['architecture', 'code-patterns']),
      projectContextDimensions: dimensions,
    });

    expect(result.dimensions.map((dimension) => dimension.id)).toEqual([
      'architecture',
      'code-patterns',
    ]);
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions).not.toHaveLength(dimensions.length);
    expect(result.selectionSummary).toMatchObject({
      selectedDimensionIds: ['architecture', 'code-patterns'],
      source: 'plan',
      unknownRequestedDimensionIds: [],
    });
  });

  test('lets explicit daemon dimensions bypass the plan selection', () => {
    const result = resolveColdStartWorkflowDimensionSelection({
      intentDimensionIds: ['project-profile'],
      planSelectionProjection: projection(['architecture', 'code-patterns']),
      projectContextDimensions: dimensions,
    });

    expect(result.dimensions.map((dimension) => dimension.id)).toEqual(['project-profile']);
    expect(result.selectionSummary).toMatchObject({
      selectedDimensionIds: ['project-profile'],
      source: 'explicit',
    });
  });

  test('aborts plan-driven coldStart when no executable dimension remains', () => {
    expect(() =>
      resolveColdStartWorkflowDimensionSelection({
        planSelectionProjection: projection([]),
        projectContextDimensions: dimensions,
      })
    ).toThrow('Plan gate selected no executable dimensions for coldStart');

    expect(() =>
      resolveColdStartWorkflowDimensionSelection({
        planSelectionProjection: projection(['unknown-only']),
        projectContextDimensions: dimensions,
      })
    ).toThrow('Plan gate selected no known ProjectContext dimensions for coldStart');
  });

  test('keeps analyst token budget computation separate from plan scale metadata', async () => {
    const runtimeBuilderSource = await readFile(
      join(process.cwd(), 'lib/recipe-pipeline/generate/execution/DimensionRuntimeBuilder.ts'),
      'utf8'
    );
    const coldStartSource = await readFile(
      join(process.cwd(), 'lib/recipe-pipeline/generate/ColdStartWorkflow.ts'),
      'utf8'
    );

    expect(runtimeBuilderSource).toContain('computeAnalystBudget(');
    expect(coldStartSource).toContain('planSelectionProjection');
    expect(coldStartSource).not.toContain('computeAnalystBudget');
  });
});
