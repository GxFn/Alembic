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

function importsFromTextFacts(
  facts: readonly EngineeringCodeAstTextFact[],
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  return facts.flatMap((fact) => parseImportText(fact.text, fact.languageId ?? languageId));
}

function callSitesFromTextFacts(
  facts: readonly EngineeringCodeAstTextFact[],
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  return facts.flatMap((fact) =>
    parseCallSitesFromText(fact.text, {
      filePath: fact.filePath ?? filePath,
      languageId: fact.languageId ?? languageId,
      callerClass: fact.callerClass ?? null,
      callerMethod: fact.callerMethod ?? "(top-level)",
      line: fact.line ?? null,
    }),
  );
}

function importsFromTreeSitterNodes(
  value: unknown,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  return flattenTreeSitterNodes(value)
    .filter((node) => importLikeNodeTypes.has(node.type))
    .flatMap((node) => parseImportText(node.text, languageId));
}

function callSitesFromTreeSitterNodes(
  value: unknown,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  return flattenTreeSitterNodes(value)
    .filter((node) => callLikeNodeTypes.has(node.type))
    .flatMap((node) => {
      const row = numberOrNull(asRecord(node.startPosition).row);
      return parseCallSitesFromText(node.text, {
        filePath,
        languageId,
        callerClass: null,
        callerMethod: "(top-level)",
        line: row === null ? null : row + 1,
      });
    });
}

function parseImportText(
  text: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const imports: EngineeringCodeAstImportFact[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLanguage = normalizeLanguageId(languageId);

  for (const line of lines) {
    if (["typescript", "javascript", "tsx"].includes(normalizedLanguage)) {
      imports.push(...parseEcmaImport(line));
    } else if (normalizedLanguage === "python") {
      imports.push(...parsePythonImport(line));
    } else if (normalizedLanguage === "swift") {
      imports.push(...parseSwiftImport(line));
    } else if (["objective-c", "objc"].includes(normalizedLanguage)) {
      imports.push(...parseObjCImport(line));
    } else if (["java", "kotlin"].includes(normalizedLanguage)) {
      imports.push(...parseJvmImport(line, normalizedLanguage));
    } else if (normalizedLanguage === "go") {
      imports.push(...parseGoImport(line));
    } else if (normalizedLanguage === "rust") {
      imports.push(...parseRustImport(line));
    } else if (normalizedLanguage === "dart") {
      imports.push(...parseDartImport(line));
    } else {
      imports.push(...parseEcmaImport(line), ...parsePythonImport(line), ...parseSwiftImport(line));
    }
  }

  return dedupeImports(imports);
}

function parseEcmaImport(line: string): EngineeringCodeAstImportFact[] {
  const importFrom = line.match(/^(import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/);
  const bare = line.match(/^import\s+["']([^"']+)["']/);
  const dynamic = line.match(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/);
  if (bare?.[1]) {
    return [{ path: bare[1], kind: "side-effect", symbols: [], alias: null, raw: line }];
  }
  if (dynamic?.[1]) {
    return [{ path: dynamic[1], kind: "dynamic", symbols: [], alias: null, raw: line }];
  }
  if (!importFrom?.[4]) {
    return [];
  }
  const clause = importFrom[3]?.trim() ?? "";
  const symbols = symbolsFromBraceClause(clause);
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)(?:\s*,|$)/);
  const alias = namespace?.[1] ?? (symbols.length === 0 ? defaultImport?.[1] : undefined) ?? null;
  const kind = namespace
    ? "namespace"
    : symbols.length > 0
      ? "named"
      : defaultImport
        ? "default"
        : "side-effect";
  return [
    {
      path: importFrom[4],
      kind,
      symbols: symbols.length > 0 ? symbols : defaultImport?.[1] ? [defaultImport[1]] : [],
      alias,
      isTypeOnly: Boolean(importFrom[2]) || /^type\b/.test(clause),
      isExportOnly: importFrom[1] === "export",
      raw: line,
    },
  ];
}

function parsePythonImport(line: string): EngineeringCodeAstImportFact[] {
  const fromImport = line.match(/^from\s+([\w.]+|\.+[\w.]*)\s+import\s+(.+)$/);
  if (fromImport?.[1] && fromImport[2]) {
    const symbols = fromImport[2]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/i)[0] ?? "")
      .filter(Boolean);
    const alias = fromImport[2].match(/^\w+\s+as\s+(\w+)$/)?.[1] ?? null;
    return [
      {
        path: fromImport[1],
        kind: symbols.includes("*") ? "namespace" : "named",
        symbols,
        alias,
        raw: line,
      },
    ];
  }
  const importLine = line.match(/^import\s+(.+)$/);
  if (!importLine?.[1]) {
    return [];
  }
  return importLine[1].split(",").map((part) => {
    const [pathPart, aliasPart] = part.trim().split(/\s+as\s+/i);
    const path = pathPart ?? "";
    return {
      path,
      kind: "namespace",
      symbols: ["*"],
      alias: aliasPart ?? path.split(".").at(-1) ?? path,
      raw: line,
    };
  });
}

function parseSwiftImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:@testable\s+)?import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
  if (!match?.[1]) {
    return [];
  }
  return [{ path: match[1], kind: "namespace", symbols: ["*"], alias: match[1], raw: line }];
}

function parseObjCImport(line: string): EngineeringCodeAstImportFact[] {
  const importMatch = line.match(/^#(?:import|include)\s+[<"]([^>"]+)[>"]/);
  if (importMatch?.[1]) {
    return [{ path: importMatch[1], kind: "header", symbols: [], alias: null, raw: line }];
  }
  const forward = line.match(/^@class\s+(.+);?$/);
  if (!forward?.[1]) {
    return [];
  }
  return [
    {
      path: "(forward-declaration)",
      kind: "forward-declare",
      symbols: forward[1]
        .replace(/;$/, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      alias: null,
      raw: line,
    },
  ];
}

function parseJvmImport(
  line: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const match = line.match(/^import\s+(static\s+)?([\w.*]+)(?:\s+as\s+(\w+))?;?$/);
  if (!match?.[2]) {
    return [];
  }
  const fullPath = match[2];
  const wildcard = fullPath.endsWith(".*");
  const parts = fullPath.split(".");
  const symbol = wildcard ? "*" : (parts.at(-1) ?? fullPath);
  return [
    {
      path: wildcard ? fullPath.replace(/\.\*$/, "") : parts.slice(0, -1).join(".") || fullPath,
      kind: wildcard ? "namespace" : match[1] ? "static" : "named",
      symbols: [symbol],
      alias: match[3] ?? null,
      raw: `${languageId}:${line}`,
    },
  ];
}

function parseGoImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:import\s+)?(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]$/);
  if (!match?.[2]) {
    return [];
  }
  const aliasToken = match[1] ?? null;
  const path = match[2];
  const alias =
    aliasToken && ![".", "_"].includes(aliasToken) ? aliasToken : (path.split("/").at(-1) ?? path);
  return [
    {
      path,
      kind: aliasToken === "_" ? "side-effect" : aliasToken === "." ? "named" : "namespace",
      symbols: aliasToken === "." ? ["*"] : [],
      alias,
      raw: line,
    },
  ];
}

function parseRustImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:pub\s+)?use\s+(.+?);?$/);
  if (!match?.[1]) {
    return [];
  }
  const body = match[1].replace(/;$/, "");
  const brace = body.match(/^(.*)::\{(.+)\}$/);
  if (brace?.[1] && brace[2]) {
    return [
      {
        path: brace[1],
        kind: "named",
        symbols: brace[2]
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[0] ?? "")
          .filter(Boolean),
        alias: null,
        raw: line,
      },
    ];
  }
  const wildcard = body.endsWith("::*");
  return [
    {
      path: wildcard ? body.replace(/::\*$/, "") : body,
      kind: wildcard ? "namespace" : "named",
      symbols: wildcard ? ["*"] : [body.split("::").at(-1) ?? body],
      alias: body.match(/\s+as\s+(\w+)$/)?.[1] ?? null,
      raw: line,
    },
  ];
}

function parseDartImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(
    /^(import|export)\s+["']([^"']+)["'](?:\s+as\s+(\w+))?(?:\s+show\s+([^;]+))?/,
  );
  if (!match?.[2]) {
    return [];
  }
  const symbols =
    match[4]
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  return [
    {
      path: match[2],
      kind: match[3] ? "namespace" : symbols.length > 0 ? "named" : "namespace",
      symbols: symbols.length > 0 ? symbols : ["*"],
      alias: match[3] ?? null,
      isExportOnly: match[1] === "export",
      raw: line,
    },
  ];
}

function parseExportText(
  text: string,
  languageId: EngineeringCodeAstLanguageId | string,
  filePath: string,
): EngineeringCodeAstExportFact[] {
  const exports: EngineeringCodeAstExportFact[] = [];
  if (["typescript", "javascript", "tsx"].includes(normalizeLanguageId(languageId))) {
    const declaration = text.match(
      /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration?.[1]) {
      exports.push({ name: declaration[1], kind: "declaration", filePath, line: null, text });
    }
    const named = text.match(/export\s*\{([^}]+)\}/);
    if (named?.[1]) {
      for (const name of symbolsFromBraceClause(`{${named[1]}}`)) {
        exports.push({ name, kind: "named", filePath, line: null, text });
      }
    }
    if (text.includes("export default")) {
      exports.push({ name: "default", kind: "default", filePath, line: null, text });
    }
  }
  return exports;
}

function parseCallSitesFromText(
  text: string,
  context: {
    readonly filePath: string;
    readonly languageId: string;
    readonly callerClass: string | null;
    readonly callerMethod: string;
    readonly line: number | null;
  },
): EngineeringCodeAstCallSiteFact[] {
  if (["objective-c", "objc"].includes(normalizeLanguageId(context.languageId))) {
    return parseObjCCallSites(text, context);
  }
  const calls: EngineeringCodeAstCallSiteFact[] = [];
  const pattern =
    /\b(?:(await)\s+)?(?:(new)\s+)?([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)/g;
  for (const match of text.matchAll(pattern)) {
    const expression = match[3] ?? "";
    if (!expression || isCallNoise(expression)) {
      continue;
    }
    const separator = expression.includes("::") ? "::" : ".";
    const parts = expression.split(separator);
    const callee = parts.at(-1) ?? expression;
    const receiver = parts.length > 1 ? parts.slice(0, -1).join(separator) : null;
    const isConstructor = Boolean(match[2]) || (!receiver && /^[A-Z]/.test(callee));
    calls.push({
      callee,
      callerMethod: context.callerMethod,
      callerClass: context.callerClass,
      callType: match[2]
        ? "constructor"
        : receiver === "super"
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
      line: context.line,
      isAwait: Boolean(match[1]),
      filePath: context.filePath,
      snippet: text,
      languageId: context.languageId,
    });
  }
  return calls;
}

function parseObjCCallSites(
  text: string,
  context: {
    readonly filePath: string;
    readonly languageId: string;
    readonly callerClass: string | null;
    readonly callerMethod: string;
    readonly line: number | null;
  },
): EngineeringCodeAstCallSiteFact[] {
  const calls: EngineeringCodeAstCallSiteFact[] = [];
  for (const match of text.matchAll(/\[([A-Za-z_]\w*)\s+([A-Za-z_]\w*:?)((?:\s+[^\]]*)?)\]/g)) {
    const receiver = match[1] ?? "";
    const selectorHead = (match[2] ?? "").replace(/:$/, "");
    if (!receiver || !selectorHead) {
      continue;
    }
    const selectorTail = match[3] ?? "";
    calls.push({
      callee: selectorHead,
      callerMethod: context.callerMethod,
      callerClass: context.callerClass,
      callType: receiver === "super" ? "super" : /^[A-Z]/.test(receiver) ? "static" : "method",
      receiver,
      receiverType: /^[A-Z]/.test(receiver) ? receiver : null,
      argCount: Math.max(
        0,
        (selectorTail.match(/:/g) ?? []).length + (match[2]?.includes(":") ? 1 : 0),
      ),
      line: context.line,
      isAwait: false,
      filePath: context.filePath,
      snippet: text,
      languageId: context.languageId,
    });
  }
  return calls;
}

function symbolsFromBraceClause(clause: string): string[] {
  const match = clause.match(/\{([^}]+)\}/);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/i)
          .at(-1) ?? "",
    )
    .filter(Boolean);
}

function flattenTreeSitterNodes(value: unknown): readonly TreeSitterLikeNode[] {
  const nodes: TreeSitterLikeNode[] = [];
  const queue = Array.isArray(value) ? [...value] : [value];
  while (queue.length > 0) {
    const item = queue.shift();
    const record = asRecord(item);
    const type = stringOrNull(record.type);
    const text = stringOrNull(record.text);
    if (type && text) {
      nodes.push({ type, text, startPosition: asRecord(record.startPosition) });
    }
    queue.push(...arrayRecords(record.namedChildren), ...arrayRecords(record.children));
  }
  return nodes;
}

interface TreeSitterLikeNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: Record<string, unknown>;
}

const importLikeNodeTypes = new Set([
  "import_statement",
  "export_statement",
  "import_declaration",
  "import_from_statement",
  "import_spec",
  "import_header",
  "import_directive",
  "use_declaration",
  "use_item",
  "library_import",
  "import_or_export",
]);

const callLikeNodeTypes = new Set([
  "call_expression",
  "new_expression",
  "method_invocation",
  "object_creation_expression",
  "method_call_expression",
  "function_expression_invocation",
  "selector_expression",
  "call",
]);

function dedupeImports(
  imports: readonly EngineeringCodeAstImportFact[],
): EngineeringCodeAstImportFact[] {
  return dedupeBy(
    imports.filter((item) => item.path),
    (item) =>
      [
        item.path,
        item.kind ?? "",
        item.alias ?? "",
        item.symbols.join(","),
        item.isExportOnly ? "export" : "",
      ].join("\0"),
  );
}

function dedupeCallSites(
  callSites: readonly EngineeringCodeAstCallSiteFact[],
): EngineeringCodeAstCallSiteFact[] {
  return dedupeBy(callSites, (item) =>
    [
      item.filePath,
      item.line ?? "",
      item.callerClass ?? "",
      item.callerMethod,
      item.receiver ?? "",
      item.callee,
      item.argCount,
    ].join("\0"),
  ).sort(compareCallSite);
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

function inferCallType(callee: string, receiver: string | null): string {
  if (receiver === "super") {
    return "super";
  }
  if (receiver) {
    return /^[A-Z]/.test(receiver) ? "static" : "method";
  }
  return /^[A-Z]/.test(callee) ? "constructor" : "function";
}

function countArguments(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(",").filter((part) => part.trim()).length;
}

function isCallNoise(expression: string): boolean {
  const receiver = expression.split(/[.:]/)[0] ?? expression;
  const callee = expression.split(/[.:]/).at(-1) ?? expression;
  return (
    ["console", "Math", "JSON", "Object", "Array", "String", "Number", "print"].includes(
      receiver,
    ) || ["log", "warn", "error", "require", "import", "len", "range", "print"].includes(callee)
  );
}

function normalizeLanguageId(value: unknown): EngineeringCodeAstLanguageId | string {
  const language = stringValue(value, "unknown").toLowerCase();
  if (["ts", "typescript"].includes(language)) return "typescript";
  if (["js", "javascript"].includes(language)) return "javascript";
  if (["tsx"].includes(language)) return "tsx";
  if (["swift"].includes(language)) return "swift";
  if (["objectivec", "objective-c", "objc", "obj-c"].includes(language)) return "objective-c";
  if (["py", "python"].includes(language)) return "python";
  if (["java"].includes(language)) return "java";
  if (["kt", "kotlin"].includes(language)) return "kotlin";
  if (["go", "golang"].includes(language)) return "go";
  if (["rs", "rust"].includes(language)) return "rust";
  if (["dart"].includes(language)) return "dart";
  return language || "unknown";
}

function languageForPath(filePath: string): EngineeringCodeAstLanguageId {
  const ext = filePath.split(".").at(-1)?.toLowerCase();
  if (ext === "ts") return "typescript";
  if (ext === "tsx") return "tsx";
  if (["js", "jsx", "mjs", "cjs"].includes(ext ?? "")) return "javascript";
  if (ext === "swift") return "swift";
  if (["m", "mm", "h"].includes(ext ?? "")) return "objective-c";
  if (ext === "py") return "python";
  if (ext === "java") return "java";
  if (ext === "kt") return "kotlin";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "dart") return "dart";
  return "unknown";
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item, "")).filter(Boolean) : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

function compareCallSite(
  left: EngineeringCodeAstCallSiteFact,
  right: EngineeringCodeAstCallSiteFact,
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.callee.localeCompare(right.callee)
  );
}
