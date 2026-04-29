/**
 * Compatibility adapter for the external dimension completion workflow.
 *
 * The workflow implementation lives in
 * `#workflows/common-capabilities/agent-execution/external`.
 */

import { envelope } from '#external/mcp/envelope.js';
import {
  type ExternalDimensionCompleteArgs,
  runExternalDimensionCompletionWorkflow,
} from '#workflows/common-capabilities/agent-execution/external/ExternalDimensionCompletionWorkflow.js';
import type { McpContext } from './types.js';

export async function dimensionComplete(ctx: McpContext, args: ExternalDimensionCompleteArgs) {
  return envelope(await runExternalDimensionCompletionWorkflow(ctx, args));
}
