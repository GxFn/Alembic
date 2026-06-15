/**
 * MCP Handler — alembic_panorama
 *
 * The resident panorama route no longer owns project-information collection.
 * Project structure, map, file, and source questions now use ProjectContext-backed
 * routes; governance/staging/enhancement operations must move to their owning
 * workflows instead of sharing this project-information surface.
 */

import { envelope } from '../tool-schema/envelope.js';
import { buildToolUsageProblem } from '../tool-schema/problem.js';
import type { McpContext } from '../tool-schema/types.js';

interface PanoramaArgs {
  operation?: string;
  module?: string;
}

export async function panoramaHandler(_ctx: McpContext, args: PanoramaArgs) {
  const operation = args.operation || 'overview';

  return envelope({
    success: false,
    data: {
      module: args.module ?? null,
      operation,
      projectInformationSource: 'project-context',
      retired: true,
    },
    errorCode: 'RETIRED_PROJECT_INFO_ROUTE',
    message:
      'alembic_panorama is retired as a project-information provider. Use ProjectContext-backed structure, map, module, file-flow, file-symbols, source-slice, or anchor-range routes for project context.',
    problem: buildToolUsageProblem({
      code: 'RETIRED_PROJECT_INFO_ROUTE',
      failingStep: 'panorama-project-information-route',
      nextAction:
        'Route project context requests through ProjectContext-backed tools; route governance, decay, staging, and enhancement actions through their owning workflows.',
      reasonCode: 'capability-mismatch',
      retryable: false,
    }),
    meta: { tool: 'alembic_panorama' },
  });
}
