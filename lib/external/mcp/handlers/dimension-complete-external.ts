/**
 * Compatibility adapter for the external dimension completion workflow.
 *
 * The workflow implementation lives in
 * `#workflows/capabilities/execution/external`.
 */

import {
  type ExternalDimensionCompleteArgs,
  runExternalDimensionCompletionWorkflow,
} from '@alembic/core/host-agent-workflows';
import { envelope } from '#external/mcp/envelope.js';
import type { McpContext } from './types.js';

export async function dimensionComplete(ctx: McpContext, args: ExternalDimensionCompleteArgs) {
  return envelope(await runExternalDimensionCompletionWorkflow(ctx, args));
}
