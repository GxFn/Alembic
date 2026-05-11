import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeCallSite,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeExport,
  EngineeringCodeMethod,
  EngineeringCodeMetrics,
  EngineeringCodePattern,
  EngineeringCodeProperty,
  EngineeringCodeReference,
} from "../types.js";
import {
  compareCallEdge,
  compareDataFlowEdge,
  compareMethod,
  compareNamed,
} from "./graph-query.js";

export function fileSummariesFrom(
  input: EngineeringCodeAstSummaryInput,
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  const container = input as Exclude<
    EngineeringCodeAstSummaryInput,
    readonly EngineeringCodeAstFileSummaryInput[]
  >;
  return (
    container.fileSummaries ?? container.files ?? container.astProjectSummary?.fileSummaries ?? []
  );
}

export function filePathFor(summary: EngineeringCodeAstFileSummaryInput): string {
  return stringValue(summary.filePath ?? summary.file ?? summary.path, "(unknown)");
}

export function methodsForClass(
  summary: EngineeringCodeAstFileSummaryInput,
  classRecord: Record<string, unknown>,
  className: string,
  fallbackFilePath: string,
): EngineeringCodeMethod[] {
  const inlineMethods = methodArray(classRecord.methods, fallbackFilePath);
  if (inlineMethods.length > 0) {
    return inlineMethods;
  }
  return methodArray(
    arrayRecords(summary.methods).filter(
      (method) => stringValue(method.className, "") === className,
    ),
    fallbackFilePath,
  );
}

export function propertiesForClass(
  summary: EngineeringCodeAstFileSummaryInput,
  classRecord: Record<string, unknown>,
  className: string,
): EngineeringCodeProperty[] {
  const inlineProperties = propertyArray(classRecord.properties);
  if (inlineProperties.length > 0) {
    return inlineProperties;
  }
  return propertyArray(
    arrayRecords(summary.properties).filter(
      (property) => stringValue(property.className, "") === className,
    ),
  );
}

export function methodArray(value: unknown, fallbackFilePath: string): EngineeringCodeMethod[] {
  return arrayRecords(value)
    .map((record) => ({
      name: stringValue(record.name, ""),
      selector: stringValue(record.selector ?? record.name, ""),
      filePath: stringValue(record.filePath ?? record.file, fallbackFilePath),
      line: numberOrNull(record.line),
      isClassMethod: Boolean(record.isClassMethod),
      returnType: stringOrNull(record.returnType),
      paramCount: numberValue(record.paramCount, 0),
      bodyLines: numberValue(record.bodyLines, 0),
      complexity: numberValue(record.complexity, 1),
    }))
    .filter((method) => method.name)
    .sort(compareMethod);
}

export function propertyArray(value: unknown): EngineeringCodeProperty[] {
  return arrayRecords(value)
    .map((record) => ({
      name: stringValue(record.name, ""),
      type: stringOrNull(record.type),
      line: numberOrNull(record.line),
      attributes: stringArray(record.attributes).sort(),
    }))
    .filter((property) => property.name)
    .sort(compareNamed);
}

export function callSiteArray(value: unknown, fallbackFilePath: string): EngineeringCodeCallSite[] {
  return arrayRecords(value)
    .map((record) => ({
      callee: stringValue(record.callee ?? record.name, ""),
      callerMethod: stringValue(record.callerMethod ?? record.methodName, ""),
      callerClass: stringOrNull(record.callerClass ?? record.className),
      callType: stringValue(record.callType ?? record.kind, "call"),
      receiver: stringOrNull(record.receiver),
      receiverType: stringOrNull(record.receiverType),
      argCount: numberValue(record.argCount ?? record.argumentCount, 0),
      line: numberOrNull(record.line),
      isAwait: Boolean(record.isAwait),
      filePath: stringValue(record.filePath ?? record.file, fallbackFilePath),
      snippet: stringOrNull(record.snippet ?? record.text),
    }))
    .filter((callSite) => callSite.callee)
    .sort(compareCallSite);
}

export function referenceArray(
  value: unknown,
  fallbackFilePath: string,
): EngineeringCodeReference[] {
  return arrayRecords(value)
    .map((record) => ({
      name: stringValue(record.name ?? record.identifier ?? record.symbol, ""),
      kind: stringOrNull(record.kind ?? record.type),
      filePath: stringValue(record.filePath ?? record.file, fallbackFilePath),
      line: numberOrNull(record.line),
      context: stringOrNull(record.context ?? record.className ?? record.methodName),
      target: stringOrNull(record.target ?? record.targetName),
      snippet: stringOrNull(record.snippet ?? record.text),
    }))
    .filter((reference) => reference.name)
    .sort(compareReference);
}

export function exportArray(value: unknown, fallbackFilePath: string): EngineeringCodeExport[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      if (typeof item === "string") {
        return {
          name: item,
          kind: null,
          filePath: fallbackFilePath,
          line: null,
          text: item,
        };
      }
      if (!isRecord(item)) {
        return null;
      }
      return {
        name: stringValue(item.name ?? item.text, ""),
        kind: stringOrNull(item.kind ?? item.type),
        filePath: stringValue(item.filePath ?? item.file, fallbackFilePath),
        line: numberOrNull(item.line),
        text: stringOrNull(item.text),
      };
    })
    .filter((item): item is EngineeringCodeExport => Boolean(item?.name))
    .sort(compareExport);
}

export function patternArray(value: unknown, fallbackFilePath: string): EngineeringCodePattern[] {
  return arrayRecords(value)
    .map((record) => ({
      type: stringValue(record.type ?? record.name, ""),
      className: stringOrNull(record.className),
      methodName: stringOrNull(record.methodName),
      propertyName: stringOrNull(record.propertyName),
      isWeakRef: typeof record.isWeakRef === "boolean" ? record.isWeakRef : null,
      line: numberOrNull(record.line),
      confidence: numberOrNull(record.confidence),
      filePath: stringValue(record.filePath ?? record.file, fallbackFilePath),
      context: stringOrNull(record.context ?? record.className ?? record.methodName),
      snippet: stringOrNull(record.snippet ?? record.text),
    }))
    .filter((pattern) => pattern.type)
    .sort(comparePattern);
}

export function metricsForSummary(
  value: unknown,
  fallbackFilePath: string,
): EngineeringCodeMetrics | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    methodCount: numberValue(value.methodCount, 0),
    avgBodyLines: numberValue(value.avgBodyLines, 0),
    maxComplexity: numberValue(value.maxComplexity, 0),
    maxNestingDepth: numberValue(value.maxNestingDepth, 0),
    longMethods: methodArray(value.longMethods, fallbackFilePath),
    complexMethods: methodArray(value.complexMethods, fallbackFilePath),
  };
}

export function callGraphEdgeArray(
  value: unknown,
  fallbackFilePath: string,
): EngineeringCodeCallGraphEdge[] {
  return arrayRecords(value)
    .map((record) => ({
      caller: stringValue(record.caller, ""),
      callee: stringValue(record.callee, ""),
      callType: stringValue(record.callType, "call"),
      resolveMethod: stringValue(record.resolveMethod, "summary"),
      line: numberOrNull(record.line),
      filePath: stringValue(record.filePath ?? record.file, fallbackFilePath),
      isAwait: Boolean(record.isAwait),
      argCount: numberValue(record.argCount, 0),
      sourceFilePath: stringOrNull(record.sourceFilePath ?? record.file),
      targetFilePath: stringOrNull(record.targetFilePath ?? record.targetFile),
    }))
    .filter((edge) => edge.caller && edge.callee)
    .sort(compareCallEdge);
}

export function dataFlowEdgeArray(
  value: unknown,
  fallbackFilePath: string | null,
): EngineeringCodeDataFlowEdge[] {
  return arrayRecords(value)
    .map((record) => ({
      from: stringValue(record.from ?? record.source, ""),
      to: stringValue(record.to ?? record.sink, ""),
      flowType: stringValue(record.flowType ?? record.type, "unknown"),
      direction: stringValue(record.direction, "unknown"),
      confidence: numberOrNull(record.confidence),
      filePath: stringOrNull(record.filePath ?? record.file) ?? fallbackFilePath,
      line: numberOrNull(record.line),
      source: stringOrNull(record.source),
      sink: stringOrNull(record.sink),
    }))
    .filter((edge) => edge.from && edge.to)
    .sort(compareDataFlowEdge);
}

export function callSiteToEdge(callSite: EngineeringCodeCallSite): EngineeringCodeCallGraphEdge {
  const caller = `${callSite.filePath}::${callSite.callerClass ? `${callSite.callerClass}.` : ""}${
    callSite.callerMethod || "(unknown)"
  }`;
  const callee = callSite.receiverType
    ? `${callSite.receiverType}.${callSite.callee}`
    : callSite.receiver
      ? `${callSite.receiver}.${callSite.callee}`
      : callSite.callee;
  return {
    caller,
    callee,
    callType: callSite.callType,
    resolveMethod: "summary-callsite",
    line: callSite.line,
    filePath: callSite.filePath,
    isAwait: callSite.isAwait,
    argCount: callSite.argCount,
    sourceFilePath: callSite.filePath,
    targetFilePath: null,
  };
}

export function argumentDataFlowEdge(
  edge: EngineeringCodeCallGraphEdge,
): EngineeringCodeDataFlowEdge {
  return {
    from: edge.caller,
    to: edge.callee,
    flowType: "argument",
    direction: "forward",
    confidence: 0.7,
    filePath: edge.filePath,
    line: edge.line,
    source: edge.caller,
    sink: edge.callee,
  };
}

export function returnValueDataFlowEdge(
  edge: EngineeringCodeCallGraphEdge,
): EngineeringCodeDataFlowEdge {
  return {
    from: edge.callee,
    to: edge.caller,
    flowType: "return-value",
    direction: "backward",
    confidence: 0.3,
    filePath: edge.filePath,
    line: edge.line,
    source: edge.callee,
    sink: edge.caller,
  };
}

export function categoryDisplayName(record: Record<string, unknown>): string {
  const className = stringValue(record.className ?? record.name, "");
  const categoryName = stringValue(record.categoryName, "extension");
  return className ? `${className}(${categoryName})` : "";
}

export function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareCallSite(left: EngineeringCodeCallSite, right: EngineeringCodeCallSite): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.callee.localeCompare(right.callee)
  );
}

function compareReference(left: EngineeringCodeReference, right: EngineeringCodeReference): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.name.localeCompare(right.name)
  );
}

function compareExport(left: EngineeringCodeExport, right: EngineeringCodeExport): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.name.localeCompare(right.name)
  );
}

function comparePattern(left: EngineeringCodePattern, right: EngineeringCodePattern): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.type.localeCompare(right.type)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
