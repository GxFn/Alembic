import type { ToolHandler, ToolName } from "../types.js";
import { graphQueryHandler } from "./graph.js";
import { knowledgeSearchHandler } from "./knowledge.js";
import { metaCapabilitiesHandler } from "./meta.js";
import { terminalExecuteHandler } from "./terminal.js";
import { unavailableToolHandler } from "./unavailable.js";

export {
  graphQueryHandler,
  knowledgeSearchHandler,
  metaCapabilitiesHandler,
  terminalExecuteHandler,
  unavailableToolHandler,
};

export function createDefaultToolHandlers(): ReadonlyMap<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ["code.query", unavailableToolHandler],
    ["terminal.execute", terminalExecuteHandler],
    ["knowledge.search", knowledgeSearchHandler],
    ["graph.query", graphQueryHandler],
    ["memory.query", unavailableToolHandler],
    ["meta.capabilities", metaCapabilitiesHandler],
  ]);
}
