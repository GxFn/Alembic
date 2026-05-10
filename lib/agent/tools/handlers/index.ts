import type { ToolHandler, ToolName } from "../types.js";
import {
  codeGuardHandler,
  codeOutlineHandler,
  codeReadHandler,
  codeSearchHandler,
  codeStructureHandler,
  codeWriteHandler,
} from "./code.js";
import { graphOverviewHandler, graphQueryHandler } from "./graph.js";
import {
  knowledgeDetailHandler,
  knowledgeManageHandler,
  knowledgeSearchHandler,
  knowledgeSubmitHandler,
} from "./knowledge.js";
import {
  memoryNoteFindingHandler,
  memoryPreviousEvidenceHandler,
  memoryRecallHandler,
  memorySaveHandler,
} from "./memory.js";
import {
  metaCapabilitiesHandler,
  metaPlanHandler,
  metaReviewHandler,
  metaToolsHandler,
} from "./meta.js";
import { terminalExecuteHandler } from "./terminal.js";

export {
  codeGuardHandler,
  codeOutlineHandler,
  codeReadHandler,
  codeSearchHandler,
  codeStructureHandler,
  codeWriteHandler,
  graphOverviewHandler,
  graphQueryHandler,
  knowledgeDetailHandler,
  knowledgeManageHandler,
  knowledgeSearchHandler,
  knowledgeSubmitHandler,
  memoryNoteFindingHandler,
  memoryPreviousEvidenceHandler,
  memoryRecallHandler,
  memorySaveHandler,
  metaCapabilitiesHandler,
  metaPlanHandler,
  metaReviewHandler,
  metaToolsHandler,
  terminalExecuteHandler,
};

export function createDefaultToolHandlers(): ReadonlyMap<ToolName, ToolHandler> {
  return new Map<ToolName, ToolHandler>([
    ["code.search", codeSearchHandler],
    ["code.read", codeReadHandler],
    ["code.outline", codeOutlineHandler],
    ["code.structure", codeStructureHandler],
    ["code.write", codeWriteHandler],
    ["code.guard", codeGuardHandler],
    ["terminal.execute", terminalExecuteHandler],
    ["knowledge.search", knowledgeSearchHandler],
    ["knowledge.detail", knowledgeDetailHandler],
    ["knowledge.submit", knowledgeSubmitHandler],
    ["knowledge.manage", knowledgeManageHandler],
    ["graph.overview", graphOverviewHandler],
    ["graph.query", graphQueryHandler],
    ["memory.save", memorySaveHandler],
    ["memory.recall", memoryRecallHandler],
    ["memory.note_finding", memoryNoteFindingHandler],
    ["memory.get_previous_evidence", memoryPreviousEvidenceHandler],
    ["meta.capabilities", metaCapabilitiesHandler],
    ["meta.tools", metaToolsHandler],
    ["meta.plan", metaPlanHandler],
    ["meta.review", metaReviewHandler],
  ]);
}
