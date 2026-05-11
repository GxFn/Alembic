import type { EngineeringCodeAstFileSummaryInput } from "../EngineeringCodeGraphModel.js";
import {
  arrayRecords,
  filePathForSummary,
  isRecord,
  normalizePath,
  numberOrNull,
  stringOrNull,
  stringValue,
} from "./analysisUtils.js";
import type { EngineeringCodeNormalizedCallSite } from "./EngineeringCodeAnalysisTypes.js";

const CALL_PATTERN =
  /\b(?:(await)\s+)?(?:(new)\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)/g;

export class CallSiteExtractor {
  extractFile(
    summary: EngineeringCodeAstFileSummaryInput,
  ): readonly EngineeringCodeNormalizedCallSite[] {
    const filePath = normalizePath(filePathForSummary(summary));
    const receiverTypes = receiverTypeFacts((summary as Record<string, unknown>).receiverTypes);
    const normalized = [
      ...this.#fromSummaryCallSites(summary, filePath),
      ...this.#fromTextFacts(summary, filePath),
    ].map((callSite) => withReceiverTypeFact(callSite, receiverTypes));
    const seen = new Set<string>();
    return normalized.filter((callSite) => {
      const key = [
        callSite.filePath,
        callSite.line ?? "",
        callSite.callerClass ?? "",
        callSite.callerMethod,
        callSite.receiver ?? "",
        callSite.callee,
      ].join("\0");
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  static extractFile(
    summary: EngineeringCodeAstFileSummaryInput,
  ): readonly EngineeringCodeNormalizedCallSite[] {
    return new CallSiteExtractor().extractFile(summary);
  }

  #fromSummaryCallSites(
    summary: EngineeringCodeAstFileSummaryInput,
    filePath: string,
  ): EngineeringCodeNormalizedCallSite[] {
    return arrayRecords(summary.callSites).map((record) =>
      normalizeCallSiteRecord(record, filePath, "summary", 0.95),
    );
  }

  #fromTextFacts(
    summary: EngineeringCodeAstFileSummaryInput,
    filePath: string,
  ): EngineeringCodeNormalizedCallSite[] {
    const facts = [
      ...arrayRecords((summary as Record<string, unknown>).textFacts),
      ...arrayRecords((summary as Record<string, unknown>).lightweightFacts),
    ];
    const callSites: EngineeringCodeNormalizedCallSite[] = [];
    for (const fact of facts) {
      const text = stringOrNull(fact.text ?? fact.snippet ?? fact.source);
      if (!text) {
        continue;
      }
      const line = numberOrNull(fact.line ?? fact.startLine);
      const callerClass = stringOrNull(fact.callerClass ?? fact.enclosingClass ?? fact.className);
      const callerMethod = stringValue(
        fact.callerMethod ?? fact.enclosingMethod ?? fact.methodName,
        "(top-level)",
      );
      for (const parsed of parseCallsFromText(text)) {
        callSites.push({
          ...parsed,
          callerMethod,
          callerClass,
          line,
          filePath,
          snippet: text,
          confidence: 0.55,
          origin: "text-fact",
        });
      }
    }
    return callSites;
  }
}

export function normalizeCallSiteRecord(
  record: Record<string, unknown>,
  filePath: string,
  origin: EngineeringCodeNormalizedCallSite["origin"] = "summary",
  confidence = 0.9,
): EngineeringCodeNormalizedCallSite {
  const callee = stringValue(record.callee ?? record.name, "unknown");
  const receiver = stringOrNull(record.receiver);
  return {
    callee,
    callerMethod: stringValue(record.callerMethod ?? record.methodName, "(top-level)"),
    callerClass: stringOrNull(record.callerClass ?? record.className),
    callType: stringValue(record.callType ?? record.kind, inferCallType(callee, receiver)),
    receiver,
    receiverType: stringOrNull(record.receiverType ?? record.type),
    argCount:
      typeof record.argCount === "number"
        ? record.argCount
        : typeof record.argumentCount === "number"
          ? record.argumentCount
          : Array.isArray(record.arguments)
            ? record.arguments.length
            : 0,
    line: numberOrNull(record.line ?? record.startLine),
    isAwait: Boolean(record.isAwait ?? record.await),
    filePath: normalizePath(stringValue(record.filePath ?? record.file, filePath)),
    snippet: stringOrNull(record.snippet ?? record.text),
    confidence,
    origin,
  };
}

export function parseCallsFromText(
  text: string,
): Omit<
  EngineeringCodeNormalizedCallSite,
  "callerMethod" | "callerClass" | "line" | "filePath" | "snippet" | "confidence" | "origin"
>[] {
  const calls: Omit<
    EngineeringCodeNormalizedCallSite,
    "callerMethod" | "callerClass" | "line" | "filePath" | "snippet" | "confidence" | "origin"
  >[] = [];
  for (const match of text.matchAll(CALL_PATTERN)) {
    const expression = match[3] ?? "";
    if (!expression || isNoise(expression)) {
      continue;
    }
    const parts = expression.split(".");
    const callee = parts.at(-1) ?? expression;
    const receiver = parts.length > 1 ? parts.slice(0, -1).join(".") : null;
    const isConstructor = Boolean(match[2]) || (!receiver && /^[A-Z]/.test(callee));
    calls.push({
      callee,
      callType: match[2]
        ? "constructor"
        : receiver === "super" || receiver === "super()"
          ? "super"
          : receiver && /^[A-Z]/.test(receiver)
            ? "static"
            : receiver
              ? "method"
              : isConstructor
                ? "constructor"
                : "function",
      receiver,
      receiverType: isConstructor ? callee : receiver && /^[A-Z]/.test(receiver) ? receiver : null,
      argCount: countArguments(match[4] ?? ""),
      isAwait: Boolean(match[1]),
    });
  }
  return calls;
}

function inferCallType(callee: string, receiver: string | null): string {
  if (receiver === "super" || receiver === "super()") {
    return "super";
  }
  if (receiver) {
    return /^[A-Z]/.test(receiver) ? "static" : "method";
  }
  return /^[A-Z]/.test(callee) ? "constructor" : "function";
}

function countArguments(argsText: string): number {
  const trimmed = argsText.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(",").filter((part) => part.trim()).length;
}

function isNoise(expression: string): boolean {
  const receiver = expression.split(".")[0] ?? expression;
  const callee = expression.split(".").at(-1) ?? expression;
  return (
    ["console", "Math", "JSON", "Object", "Array", "String", "Number", "print"].includes(
      receiver,
    ) ||
    ["log", "warn", "error", "require", "import", "super", "len", "range", "print"].includes(callee)
  );
}

export function isCallSiteLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ("callee" in value || "name" in value);
}

export default CallSiteExtractor;

interface ReceiverTypeFact {
  readonly receiver: string;
  readonly receiverType: string;
  readonly callerClass: string | null;
  readonly callerMethod: string | null;
  readonly filePath: string | null;
}

function withReceiverTypeFact(
  callSite: EngineeringCodeNormalizedCallSite,
  facts: readonly ReceiverTypeFact[],
): EngineeringCodeNormalizedCallSite {
  if (callSite.receiverType || !callSite.receiver) {
    return callSite;
  }
  const match = facts.find(
    (fact) =>
      fact.receiver === callSite.receiver &&
      (!fact.filePath || fact.filePath === callSite.filePath) &&
      (!fact.callerClass || fact.callerClass === callSite.callerClass) &&
      (!fact.callerMethod || fact.callerMethod === callSite.callerMethod),
  );
  return match ? { ...callSite, receiverType: match.receiverType } : callSite;
}

function receiverTypeFacts(value: unknown): ReceiverTypeFact[] {
  if (Array.isArray(value)) {
    return arrayRecords(value)
      .map((record) => ({
        receiver: stringValue(record.receiver ?? record.name, ""),
        receiverType: stringValue(record.receiverType ?? record.type ?? record.typeName, ""),
        callerClass: stringOrNull(record.callerClass ?? record.className),
        callerMethod: stringOrNull(record.callerMethod ?? record.methodName),
        filePath: stringOrNull(record.filePath ?? record.file),
      }))
      .filter((fact) => fact.receiver && fact.receiverType);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, receiverType]) => ({
      receiver: key.split(".").at(-1) ?? key,
      receiverType,
      callerClass: null,
      callerMethod: null,
      filePath: null,
    }));
}
