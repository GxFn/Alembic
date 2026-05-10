import type { ToolHandler } from "../types.js";
import { isRecord, toolFailure } from "../types.js";

export const terminalExecuteHandler: ToolHandler = (invocation, context) => {
  const command = isRecord(invocation.input) ? stringValue(invocation.input.command) : undefined;
  return toolFailure(context.descriptor, "policy_required", {
    code: "policy_required",
    message: "terminal.execute is declared but command execution is gated outside lib/tools.",
    details: {
      executesCommands: false,
      ...(command ? { commandPreview: command.slice(0, 120) } : {}),
    },
  });
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
