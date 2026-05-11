import type {
  EngineeringCodeCallEdgeQuery,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeCallSite,
  EngineeringCodeCategoryInfo,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeDataFlowQuery,
  EngineeringCodeMethod,
  EngineeringCodePattern,
  EngineeringCodePatternContextFilter,
  EngineeringCodeProtocolInfo,
  EngineeringCodeReference,
} from "../types.js";

export function expandedProtocols(
  protocolNames: Iterable<string>,
  protocols: ReadonlyMap<string, EngineeringCodeProtocolInfo>,
): readonly string[] {
  const expanded = new Set<string>();
  const queue = [...protocolNames];
  while (queue.length > 0) {
    const protocolName = queue.shift();
    if (!protocolName || expanded.has(protocolName)) {
      continue;
    }
    expanded.add(protocolName);
    queue.push(...(protocols.get(protocolName)?.inherits ?? []));
  }
  return [...expanded].sort();
}

export function compareNamed(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name.localeCompare(right.name);
}

export function compareMethod(left: EngineeringCodeMethod, right: EngineeringCodeMethod): number {
  return (
    left.name.localeCompare(right.name) ||
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}

export function compareCategory(
  left: EngineeringCodeCategoryInfo,
  right: EngineeringCodeCategoryInfo,
): number {
  return (
    left.className.localeCompare(right.className) ||
    left.categoryName.localeCompare(right.categoryName) ||
    left.filePath.localeCompare(right.filePath)
  );
}

export function compareCallEdge(
  left: EngineeringCodeCallGraphEdge,
  right: EngineeringCodeCallGraphEdge,
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.caller.localeCompare(right.caller) ||
    left.callee.localeCompare(right.callee)
  );
}

export function compareDataFlowEdge(
  left: EngineeringCodeDataFlowEdge,
  right: EngineeringCodeDataFlowEdge,
): number {
  return (
    (left.filePath ?? "").localeCompare(right.filePath ?? "") ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.flowType.localeCompare(right.flowType)
  );
}

export function compareLineMatch(
  left: { readonly filePath: string; readonly line: number | null },
  right: { readonly filePath: string; readonly line: number | null },
): number {
  return left.filePath.localeCompare(right.filePath) || (left.line ?? 0) - (right.line ?? 0);
}

export function callEdgeMatches(
  edge: EngineeringCodeCallGraphEdge,
  query: EngineeringCodeCallEdgeQuery,
): boolean {
  if (
    query.filePath &&
    edge.filePath !== query.filePath &&
    edge.sourceFilePath !== query.filePath
  ) {
    return false;
  }
  if (query.caller && !stringIncludes(edge.caller, query.caller)) {
    return false;
  }
  if (query.callee && !stringIncludes(edge.callee, query.callee)) {
    return false;
  }
  if (
    query.symbol &&
    !stringIncludes(edge.caller, query.symbol) &&
    !stringIncludes(edge.callee, query.symbol)
  ) {
    return false;
  }
  if (query.className && !edgeTouchesClass(edge, query.className)) {
    return false;
  }
  if (query.methodName && !edgeTouchesMethod(edge, query.methodName)) {
    return false;
  }
  return true;
}

export function dataFlowEdgeMatches(
  edge: EngineeringCodeDataFlowEdge,
  query: EngineeringCodeDataFlowQuery,
): boolean {
  if (query.filePath && edge.filePath !== query.filePath) {
    return false;
  }
  if (query.from && !stringIncludes(edge.from, query.from)) {
    return false;
  }
  if (query.to && !stringIncludes(edge.to, query.to)) {
    return false;
  }
  if (query.source && !stringIncludes(edge.source ?? edge.from, query.source)) {
    return false;
  }
  if (query.sink && !stringIncludes(edge.sink ?? edge.to, query.sink)) {
    return false;
  }
  if (query.flowType && edge.flowType !== query.flowType) {
    return false;
  }
  if (query.direction && edge.direction !== query.direction) {
    return false;
  }
  return true;
}

export function callSiteMatchesTarget(
  callSite: EngineeringCodeCallSite,
  normalizedTarget: string,
): boolean {
  return (
    callSite.callee.toLowerCase().includes(normalizedTarget) ||
    callSiteDisplay(callSite).toLowerCase().includes(normalizedTarget) ||
    (callSite.snippet ?? "").toLowerCase().includes(normalizedTarget)
  );
}

export function callSiteDisplay(callSite: EngineeringCodeCallSite): string {
  const receiver = callSite.receiver ?? callSite.receiverType;
  return receiver ? `${receiver}.${callSite.callee}` : callSite.callee;
}

export function recordTextMatches(value: unknown, normalizedPattern: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const searchable = [
    value.type,
    value.name,
    value.callee,
    value.receiver,
    value.receiverType,
    value.className,
    value.callerClass,
    value.methodName,
    value.callerMethod,
    value.propertyName,
    value.context,
    value.snippet,
    value.text,
    value.target,
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  return searchable.includes(normalizedPattern);
}

export function contextForPatternCandidate(
  value: EngineeringCodePattern | EngineeringCodeReference | EngineeringCodeCallSite,
): string | null {
  if ("context" in value && value.context) {
    return value.context;
  }
  if ("callerMethod" in value && value.callerMethod) {
    return value.callerMethod;
  }
  if ("methodName" in value && value.methodName) {
    return value.methodName;
  }
  if ("callerClass" in value && value.callerClass) {
    return value.callerClass;
  }
  if ("className" in value && value.className) {
    return value.className;
  }
  return null;
}

export function contextMatchesFilter(
  context: string | null,
  filter: EngineeringCodePatternContextFilter,
): boolean {
  if (filter.forbiddenContext) {
    return context === filter.forbiddenContext;
  }
  if (filter.requiredContext) {
    return context !== filter.requiredContext;
  }
  return true;
}

export function snippetForPatternCandidate(
  value: EngineeringCodePattern | EngineeringCodeReference | EngineeringCodeCallSite,
): string {
  if ("snippet" in value && value.snippet) {
    return value.snippet;
  }
  if ("callee" in value) {
    return callSiteDisplay(value);
  }
  if ("name" in value) {
    return value.name;
  }
  return "type" in value ? value.type : "";
}

export function callEdgeKey(edge: EngineeringCodeCallGraphEdge): string {
  return `${edge.filePath}:${edge.line ?? ""}:${edge.caller}->${edge.callee}:${edge.callType}`;
}

export function dataFlowEdgeKey(edge: EngineeringCodeDataFlowEdge): string {
  return `${edge.filePath ?? ""}:${edge.line ?? ""}:${edge.from}->${edge.to}:${edge.flowType}:${edge.direction}`;
}

export function removeInPlace<T>(items: T[], predicate: (item: T) => boolean): void {
  let writeIndex = 0;
  for (const item of items) {
    if (!predicate(item)) {
      items[writeIndex] = item;
      writeIndex++;
    }
  }
  items.length = writeIndex;
}

export function firstPathSegment(filePath: string): string {
  return filePath.includes("/") ? (filePath.split("/")[0] ?? "(root)") : "(root)";
}

export function isEntryPoint(filePath: string): boolean {
  return /^(AppDelegate|SceneDelegate|main|index|app)\.(m|mm|swift|ts|tsx|js|jsx|go|py)$/.test(
    filePath.split("/").pop() ?? filePath,
  );
}

function edgeTouchesClass(edge: EngineeringCodeCallGraphEdge, className: string): boolean {
  return (
    stringIncludes(edge.caller, `${className}.`) ||
    stringIncludes(edge.callee, `${className}.`) ||
    stringIncludes(edge.caller, className) ||
    stringIncludes(edge.callee, className)
  );
}

function edgeTouchesMethod(edge: EngineeringCodeCallGraphEdge, methodName: string): boolean {
  const normalized = methodName.toLowerCase();
  return (
    symbolTail(edge.caller).toLowerCase() === normalized ||
    symbolTail(edge.callee).toLowerCase() === normalized
  );
}

function symbolTail(symbol: string): string {
  const withoutFile = symbol.includes("::") ? (symbol.split("::").pop() ?? symbol) : symbol;
  return withoutFile.includes(".") ? (withoutFile.split(".").pop() ?? withoutFile) : withoutFile;
}

export function stringIncludes(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
