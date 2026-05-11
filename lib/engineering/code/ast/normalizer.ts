import type { EngineeringCodeAstSummaryInput } from "../types.js";
import type {
  EngineeringCodeAstCallSiteFact,
  EngineeringCodeAstCategoryFact,
  EngineeringCodeAstClassFact,
  EngineeringCodeAstExportFact,
  EngineeringCodeAstFactsFileSummary,
  EngineeringCodeAstFactsProjectSummary,
  EngineeringCodeAstImportFact,
  EngineeringCodeAstLanguageId,
  EngineeringCodeAstMethodFact,
  EngineeringCodeAstMetricsFact,
  EngineeringCodeAstPropertyFact,
  EngineeringCodeAstPropertyTypeFact,
  EngineeringCodeAstProtocolFact,
  EngineeringCodeAstRawInput,
  EngineeringCodeAstReceiverTypeFact,
  EngineeringCodeAstReferenceFact,
  EngineeringCodeAstTextFact,
} from "./facts.js";
import {
  callSitesFromTextFacts,
  callSitesFromTreeSitterNodes,
  dedupeCallSites,
  dedupeImports,
  importsFromTextFacts,
  importsFromTreeSitterNodes,
  inferCallType,
  parseCallSitesFromText,
  parseExportText,
  parseImportText,
} from "./normalizer-text.js";
import {
  arrayRecords,
  asRecord,
  compareByName,
  compareCallSite,
  languageForPath,
  normalizeLanguageId,
  numberOrNull,
  numberValue,
  stringArray,
  stringOrNull,
  stringValue,
} from "./normalizer-utils.js";

export function normalizeEngineeringCodeAstSummary(
  input: EngineeringCodeAstRawInput,
): EngineeringCodeAstFactsProjectSummary {
  return {
    fileSummaries: fileSummariesFromRawInput(input).map(normalizeEngineeringCodeAstFileSummary),
  };
}

export function normalizeEngineeringCodeAstFileSummary(
  rawSummary: unknown,
): EngineeringCodeAstFactsFileSummary {
  const summary = asRecord(rawSummary);
  const sourceText = stringOrNull(summary.source ?? summary.content ?? summary.text);
  const filePath = stringValue(summary.filePath ?? summary.file ?? summary.path, "(unknown)");
  const languageId = normalizeLanguageId(
    stringValue(summary.languageId ?? summary.lang ?? summary.language, languageForPath(filePath)),
  );
  const textFacts = normalizeTextFacts(summary, sourceText, filePath, languageId);
  const propertyTypes = normalizePropertyTypeFacts(
    summary.propertyTypes ?? summary.propertyTypeFacts,
    filePath,
  );
  const receiverTypes = normalizeReceiverTypeFacts(
    summary.receiverTypes ?? summary.receiverTypeFacts,
    filePath,
  );
  const properties = mergePropertyTypeFacts(
    normalizeProperties(summary.properties, filePath),
    propertyTypes,
  );
  const callSites = applyReceiverTypeFacts(
    [
      ...normalizeCallSites(summary.callSites, filePath, languageId),
      ...callSitesFromTextFacts(textFacts, filePath, languageId),
      ...callSitesFromTreeSitterNodes(
        summary.nodes ?? summary.rootNode ?? summary.tree,
        filePath,
        languageId,
      ),
    ],
    receiverTypes,
  );
  const imports = dedupeImports([
    ...normalizeImports(summary.imports ?? summary.importFacts, languageId),
    ...importsFromExports(summary.exports, languageId),
    ...importsFromTextFacts(textFacts, languageId),
    ...importsFromTreeSitterNodes(summary.nodes ?? summary.rootNode ?? summary.tree, languageId),
  ]);

  return {
    ...summary,
    file: filePath,
    filePath,
    path: filePath,
    lang: languageId,
    languageId,
    classes: normalizeClasses(summary.classes, filePath, propertyTypes),
    protocols: normalizeProtocols(summary.protocols, filePath),
    categories: normalizeCategories(summary.categories, filePath),
    methods: normalizeMethods(summary.methods, filePath),
    properties,
    imports,
    importFacts: imports,
    exports: normalizeExports(summary.exports, filePath, languageId),
    callSites: dedupeCallSites(callSites),
    references: normalizeReferences(summary.references, filePath),
    textFacts,
    propertyTypes,
    receiverTypes,
    metrics: normalizeMetrics(summary.metrics, filePath),
  };
}

export function normalizeEngineeringCodeAstSummaryInput(
  input: EngineeringCodeAstRawInput,
): EngineeringCodeAstSummaryInput {
  return normalizeEngineeringCodeAstSummary(input);
}

function fileSummariesFromRawInput(input: EngineeringCodeAstRawInput): readonly unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  const container = asRecord(input);
  if (Array.isArray(container.fileSummaries)) {
    return container.fileSummaries;
  }
  if (Array.isArray(container.files)) {
    return container.files;
  }
  const astProjectSummary = asRecord(container.astProjectSummary);
  if (Array.isArray(astProjectSummary.fileSummaries)) {
    return astProjectSummary.fileSummaries;
  }
  return [input];
}

function normalizeClasses(
  value: unknown,
  filePath: string,
  propertyTypes: readonly EngineeringCodeAstPropertyTypeFact[],
): EngineeringCodeAstClassFact[] {
  return arrayRecords(value)
    .map((record) => {
      const name = stringValue(record.name ?? record.className ?? record.typeName, "");
      const inlineProperties = normalizeProperties(record.properties, filePath);
      return {
        ...record,
        name,
        filePath: stringValue(record.filePath ?? record.file, filePath),
        line: numberOrNull(record.line ?? record.startLine),
        endLine: numberOrNull(record.endLine),
        superClass: stringOrNull(record.superClass ?? record.superclass ?? record.extends),
        superclass: stringOrNull(record.superClass ?? record.superclass ?? record.extends),
        protocols: stringArray(record.protocols ?? record.implements ?? record.conformsTo),
        properties: mergePropertyTypeFacts(
          inlineProperties,
          propertyTypes.filter((fact) => fact.className === name),
        ),
        methods: normalizeMethods(record.methods, filePath).map((method) => ({
          ...method,
          className: method.className ?? name,
        })),
      };
    })
    .filter((record) => record.name)
    .sort(compareByName);
}

function normalizeProtocols(value: unknown, filePath: string): EngineeringCodeAstProtocolFact[] {
  return arrayRecords(value)
    .map((record) => ({
      ...record,
      name: stringValue(record.name ?? record.protocolName ?? record.interfaceName, ""),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      line: numberOrNull(record.line ?? record.startLine),
      inherits: stringArray(record.inherits ?? record.extends),
      requiredMethods: normalizeMethods(record.requiredMethods ?? record.methods, filePath),
      optionalMethods: normalizeMethods(record.optionalMethods, filePath),
      methods: normalizeMethods(record.methods, filePath),
    }))
    .filter((record) => record.name)
    .sort(compareByName);
}

function normalizeCategories(value: unknown, filePath: string): EngineeringCodeAstCategoryFact[] {
  return arrayRecords(value)
    .map((record) => ({
      ...record,
      className: stringValue(record.className ?? record.targetClass ?? record.name, ""),
      categoryName: stringValue(record.categoryName ?? record.extensionName, "extension"),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      line: numberOrNull(record.line ?? record.startLine),
      protocols: stringArray(record.protocols ?? record.implements),
      methods: normalizeMethods(record.methods, filePath),
      properties: normalizeProperties(record.properties, filePath),
    }))
    .filter((record) => record.className)
    .sort((left, right) => left.className.localeCompare(right.className));
}

function normalizeMethods(value: unknown, filePath: string): EngineeringCodeAstMethodFact[] {
  return arrayRecords(value)
    .map((record) => {
      const name = stringValue(record.name ?? record.selector ?? record.methodName, "");
      return {
        ...record,
        name,
        selector: stringValue(record.selector ?? record.name, name),
        className: stringOrNull(record.className ?? record.containerName),
        filePath: stringValue(record.filePath ?? record.file, filePath),
        line: numberOrNull(record.line ?? record.startLine),
        isClassMethod: Boolean(record.isClassMethod ?? record.static),
        returnType: stringOrNull(record.returnType ?? record.type),
        paramCount: numberValue(record.paramCount ?? record.parameterCount, 0),
        bodyLines: numberValue(record.bodyLines ?? record.lines, 0),
        complexity: numberValue(record.complexity, 1),
      };
    })
    .filter((record) => record.name)
    .sort(compareByName);
}

function normalizeProperties(value: unknown, filePath: string): EngineeringCodeAstPropertyFact[] {
  return arrayRecords(value)
    .map((record) => ({
      ...record,
      name: stringValue(record.name ?? record.propertyName, ""),
      className: stringOrNull(record.className ?? record.containerName),
      type: stringOrNull(record.type ?? record.typeAnnotation ?? record.returnType),
      line: numberOrNull(record.line ?? record.startLine),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      attributes: stringArray(record.attributes ?? record.modifiers),
    }))
    .filter((record) => record.name)
    .sort(compareByName);
}

function normalizeImports(
  value: unknown,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const imports: EngineeringCodeAstImportFact[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === "string") {
      imports.push(...parseImportText(item, languageId));
      continue;
    }
    const record = asRecord(item);
    const path = stringValue(
      record.path ?? record.source ?? record.module ?? record.importPath,
      "",
    );
    const text = stringOrNull(record.text ?? record.raw);
    if (!path && text) {
      imports.push(...parseImportText(text, languageId));
      continue;
    }
    if (!path) {
      continue;
    }
    imports.push({
      path,
      kind: stringOrNull(record.kind ?? record.type),
      symbols: stringArray(record.symbols ?? record.names ?? record.imported),
      alias: stringOrNull(record.alias ?? record.localName ?? record.namespace),
      exportedName: stringOrNull(record.exportedName),
      isTypeOnly: Boolean(record.isTypeOnly),
      isExportOnly: Boolean(record.isExportOnly),
      raw: item,
    });
  }
  return imports;
}

function normalizeExports(
  value: unknown,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstExportFact[] {
  const exports: EngineeringCodeAstExportFact[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item === "string") {
      exports.push({ name: item, kind: null, filePath, line: null, text: item });
      continue;
    }
    const record = asRecord(item);
    const text = stringOrNull(record.text ?? record.raw);
    const names = stringArray(record.symbols ?? record.names);
    for (const name of names) {
      exports.push({
        name,
        kind: stringOrNull(record.kind ?? record.type),
        filePath,
        line: numberOrNull(record.line ?? record.startLine),
        text,
        path: stringOrNull(record.path ?? record.source),
        symbols: names,
      });
    }
    const directName = stringOrNull(record.name ?? record.exportedName);
    if (directName) {
      exports.push({
        name: directName,
        kind: stringOrNull(record.kind ?? record.type),
        filePath: stringValue(record.filePath ?? record.file, filePath),
        line: numberOrNull(record.line ?? record.startLine),
        text,
        path: stringOrNull(record.path ?? record.source),
        symbols: names,
      });
      continue;
    }
    if (text) {
      for (const parsed of parseExportText(text, languageId, filePath)) {
        exports.push(parsed);
      }
    }
  }
  return dedupeBy(
    exports,
    (item) => `${item.filePath ?? filePath}\0${item.name}\0${item.path ?? ""}`,
  );
}

function importsFromExports(
  value: unknown,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const imports: EngineeringCodeAstImportFact[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text =
      typeof item === "string" ? item : stringOrNull(asRecord(item).text ?? asRecord(item).raw);
    if (text) {
      imports.push(
        ...parseImportText(text, languageId).map((record) => ({ ...record, isExportOnly: true })),
      );
    }
  }
  return imports;
}

function normalizeCallSites(
  value: unknown,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  return arrayRecords(value)
    .flatMap((record) => normalizeCallSiteRecord(record, filePath, languageId))
    .sort(compareCallSite);
}

function normalizeCallSiteRecord(
  record: Record<string, unknown>,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  const text = stringOrNull(record.text ?? record.snippet ?? record.source);
  const callee = stringValue(record.callee ?? record.name ?? record.methodName, "");
  if (!callee && text) {
    return parseCallSitesFromText(text, {
      filePath,
      languageId,
      callerClass: stringOrNull(record.callerClass ?? record.className ?? record.enclosingClass),
      callerMethod: stringValue(
        record.callerMethod ?? record.enclosingMethod ?? record.scope ?? record.functionName,
        "(top-level)",
      ),
      line: numberOrNull(record.line ?? record.startLine),
    });
  }
  if (!callee) {
    return [];
  }
  const receiver = stringOrNull(record.receiver ?? record.object ?? record.target);
  return [
    {
      callee,
      callerMethod: stringValue(record.callerMethod ?? record.enclosingMethod, "(top-level)"),
      callerClass: stringOrNull(record.callerClass ?? record.className ?? record.enclosingClass),
      callType: stringValue(record.callType ?? record.kind, inferCallType(callee, receiver)),
      receiver,
      receiverType: stringOrNull(record.receiverType ?? record.type ?? record.targetType),
      argCount: numberValue(
        record.argCount ?? record.argumentCount,
        Array.isArray(record.arguments) ? record.arguments.length : 0,
      ),
      line: numberOrNull(record.line ?? record.startLine),
      isAwait: Boolean(record.isAwait ?? record.await),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      snippet: text,
      languageId,
    },
  ];
}

function normalizeReferences(value: unknown, filePath: string): EngineeringCodeAstReferenceFact[] {
  return arrayRecords(value)
    .map((record) => ({
      ...record,
      name: stringValue(record.name ?? record.identifier ?? record.symbol, ""),
      kind: stringOrNull(record.kind ?? record.type),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      line: numberOrNull(record.line ?? record.startLine),
      context: stringOrNull(record.context ?? record.className ?? record.methodName),
      target: stringOrNull(record.target ?? record.targetName),
      snippet: stringOrNull(record.snippet ?? record.text),
    }))
    .filter((record) => record.name)
    .sort(compareByName);
}

function normalizeTextFacts(
  summary: Record<string, unknown>,
  sourceText: string | null,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstTextFact[] {
  const facts = [...arrayRecords(summary.textFacts), ...arrayRecords(summary.lightweightFacts)].map(
    (record) => ({
      text: stringValue(record.text ?? record.snippet ?? record.source, ""),
      filePath: stringValue(record.filePath ?? record.file, filePath),
      line: numberOrNull(record.line ?? record.startLine),
      callerClass: stringOrNull(record.callerClass ?? record.className ?? record.enclosingClass),
      callerMethod: stringOrNull(
        record.callerMethod ?? record.methodName ?? record.enclosingMethod,
      ),
      languageId: stringValue(record.languageId ?? record.lang, languageId),
      kind: stringOrNull(record.kind ?? record.type),
    }),
  );
  if (sourceText) {
    facts.push({
      text: sourceText,
      filePath,
      line: 1,
      callerClass: null,
      callerMethod: null,
      languageId,
      kind: "source",
    });
  }
  return facts.filter((fact) => fact.text);
}

function normalizePropertyTypeFacts(
  value: unknown,
  filePath: string,
): EngineeringCodeAstPropertyTypeFact[] {
  const facts: EngineeringCodeAstPropertyTypeFact[] = [];
  for (const record of arrayRecords(value)) {
    const className = stringValue(record.className ?? record.containerName, "");
    const propertyName = stringValue(record.propertyName ?? record.name, "");
    const type = stringValue(record.type ?? record.typeName ?? record.receiverType, "");
    if (className && propertyName && type) {
      facts.push({
        className,
        propertyName,
        type,
        filePath: stringValue(record.filePath ?? record.file, filePath),
        line: numberOrNull(record.line ?? record.startLine),
        source: stringOrNull(record.source ?? record.snippet),
      });
    }
  }
  const map = asRecord(value);
  for (const [key, item] of Object.entries(map)) {
    if (Array.isArray(value)) {
      break;
    }
    if (typeof item === "string") {
      const [className, propertyName] = key.split(".");
      if (className && propertyName) {
        facts.push({ className, propertyName, type: item, filePath });
      }
      continue;
    }
    for (const [propertyName, typeValue] of Object.entries(asRecord(item))) {
      if (typeof typeValue === "string") {
        facts.push({ className: key, propertyName, type: typeValue, filePath });
      }
    }
  }
  return dedupeBy(facts, (fact) => `${fact.className}\0${fact.propertyName}\0${fact.type}`);
}

function normalizeReceiverTypeFacts(
  value: unknown,
  filePath: string,
): EngineeringCodeAstReceiverTypeFact[] {
  const facts: EngineeringCodeAstReceiverTypeFact[] = [];
  for (const record of arrayRecords(value)) {
    const receiver = stringValue(record.receiver ?? record.name, "");
    const receiverType = stringValue(record.receiverType ?? record.type ?? record.typeName, "");
    if (receiver && receiverType) {
      facts.push({
        receiver,
        receiverType,
        callerClass: stringOrNull(record.callerClass ?? record.className),
        callerMethod: stringOrNull(record.callerMethod ?? record.methodName),
        filePath: stringValue(record.filePath ?? record.file, filePath),
        line: numberOrNull(record.line ?? record.startLine),
        source: stringOrNull(record.source ?? record.snippet),
      });
    }
  }
  const map = asRecord(value);
  for (const [key, item] of Object.entries(map)) {
    if (Array.isArray(value)) {
      break;
    }
    if (typeof item === "string") {
      const parts = key.split(".");
      const receiver = parts.at(-1);
      if (receiver) {
        facts.push({ receiver, receiverType: item, filePath });
      }
    }
  }
  return dedupeBy(facts, (fact) =>
    [
      fact.filePath ?? "",
      fact.callerClass ?? "",
      fact.callerMethod ?? "",
      fact.receiver,
      fact.receiverType,
    ].join("\0"),
  );
}

function mergePropertyTypeFacts(
  properties: readonly EngineeringCodeAstPropertyFact[],
  propertyTypes: readonly EngineeringCodeAstPropertyTypeFact[],
): EngineeringCodeAstPropertyFact[] {
  const merged = [...properties];
  for (const fact of propertyTypes) {
    const existingIndex = merged.findIndex(
      (property) => property.className === fact.className && property.name === fact.propertyName,
    );
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      if (!existing) {
        continue;
      }
      merged[existingIndex] = {
        ...existing,
        type: existing.type ?? fact.type,
        line: existing.line ?? fact.line ?? null,
      };
    } else {
      merged.push({
        name: fact.propertyName,
        className: fact.className,
        type: fact.type,
        line: fact.line ?? null,
        attributes: [],
      });
    }
  }
  return dedupeBy(merged, (property) => `${property.className ?? ""}\0${property.name}`);
}

function applyReceiverTypeFacts(
  callSites: readonly EngineeringCodeAstCallSiteFact[],
  receiverTypes: readonly EngineeringCodeAstReceiverTypeFact[],
): EngineeringCodeAstCallSiteFact[] {
  return callSites.map((callSite) => {
    if (callSite.receiverType || !callSite.receiver) {
      return callSite;
    }
    const match = receiverTypes.find(
      (fact) =>
        fact.receiver === callSite.receiver &&
        (!fact.filePath || fact.filePath === callSite.filePath) &&
        (!fact.callerClass || fact.callerClass === callSite.callerClass) &&
        (!fact.callerMethod || fact.callerMethod === callSite.callerMethod),
    );
    return match ? { ...callSite, receiverType: match.receiverType } : callSite;
  });
}

function normalizeMetrics(value: unknown, filePath: string): EngineeringCodeAstMetricsFact | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    methodCount: numberValue(record.methodCount, 0),
    avgBodyLines: numberValue(record.avgBodyLines, 0),
    maxComplexity: numberValue(record.maxComplexity, 0),
    maxNestingDepth: numberValue(record.maxNestingDepth, 0),
    longMethods: normalizeMethods(record.longMethods, filePath),
    complexMethods: normalizeMethods(record.complexMethods, filePath),
  };
}

function dedupeBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
