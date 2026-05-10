import type { ToolHandler } from "../types.js";
import { toolFailure } from "../types.js";

export const unavailableToolHandler: ToolHandler = (_invocation, context) =>
  toolFailure(context.descriptor, "unavailable", {
    code: "capability_unavailable",
    message: context.descriptor.availability.reason ?? "Tool capability is unavailable.",
  });
