import type { EngineeringCodeAstFileSummaryInput } from "../EngineeringCodeGraphModel.js";
import {
  arrayRecords,
  extractExportNames,
  filePathForSummary,
  fileSummariesFromAnalysisInput,
  isRecord,
  languageForPath,
  makeFqn,
  normalizeImportRecord,
  normalizePath,
  numberOrNull,
  stringArray,
  stringOrNull,
  stringValue,
} from "./analysisUtils.js";
import type {
  EngineeringCodeAnalysisInput,
  EngineeringCodeInheritanceEdge,
  EngineeringCodeSymbolDeclaration,
  EngineeringCodeSymbolKind,
  EngineeringCodeSymbolTable,
} from "./EngineeringCodeAnalysisTypes.js";

export class SymbolTableBuilder {
  build(input: EngineeringCodeAnalysisInput): EngineeringCodeSymbolTable {
    const declarations = new Map<string, EngineeringCodeSymbolDeclaration>();
    const fileExports = new Map<string, readonly string[]>();
    const fileImports = new Map<string, ReturnType<typeof normalizeImportRecord>[]>();
    const declarationsByName = new Map<string, string[]>();
    const declarationsByFile = new Map<string, string[]>();
    const classNames = new Set<string>();
    const protocolNames = new Set<string>();
    const instantiatedClasses = new Set<string>();
    const propertyTypes = new Map<string, Map<string, string>>();
    const inheritanceEdges: EngineeringCodeInheritanceEdge[] = [];

    for (const summary of fileSummariesFromAnalysisInput(input)) {
      const filePath = normalizePath(filePathForSummary(summary));
      if (!filePath || filePath === "(unknown)") {
        continue;
      }
      const languageId = stringValue(summary.languageId ?? summary.lang, languageForPath(filePath));
      const exportNames = extractExportNames(summary.exports);
      fileExports.set(filePath, exportNames);
      fileImports.set(
        filePath,
        (Array.isArray(summary.imports) ? summary.imports : []).map(normalizeImportRecord),
      );
      addDeclaration({
        declarations,
        declarationsByFile,
        declarationsByName,
        declaration: {
          fqn: makeFqn(filePath, moduleNameForFile(filePath)),
          name: moduleNameForFile(filePath),
          qualifiedName: moduleNameForFile(filePath),
          kind: "module",
          filePath,
          line: null,
          containerName: null,
          className: null,
          isExported: false,
          languageId,
        },
      });
      indexClasses(summary, filePath, languageId, exportNames, {
        declarations,
        declarationsByFile,
        declarationsByName,
        classNames,
        inheritanceEdges,
        propertyTypes,
      });
      indexProtocols(summary, filePath, languageId, exportNames, {
        declarations,
        declarationsByFile,
        declarationsByName,
        protocolNames,
        inheritanceEdges,
      });
      indexCategories(summary, filePath, languageId, {
        declarations,
        declarationsByFile,
        declarationsByName,
        inheritanceEdges,
        propertyTypes,
      });
      indexPropertyTypeFacts(summary, filePath, languageId, {
        declarations,
        declarationsByFile,
        declarationsByName,
        propertyTypes,
      });
      indexTopLevelMethods(summary, filePath, languageId, exportNames, {
        declarations,
        declarationsByFile,
        declarationsByName,
      });
      indexInstantiatedClasses(summary, instantiatedClasses);
    }

    return {
      declarations,
      fileExports,
      fileImports,
      declarationsByName: freezeMapArrays(declarationsByName),
      declarationsByFile: freezeMapArrays(declarationsByFile),
      classNames,
      protocolNames,
      instantiatedClasses,
      propertyTypes,
      inheritanceEdges,
    };
  }

  static build(input: EngineeringCodeAnalysisInput): EngineeringCodeSymbolTable {
    return new SymbolTableBuilder().build(input);
  }
}

interface MutableIndexes {
  declarations: Map<string, EngineeringCodeSymbolDeclaration>;
  declarationsByFile: Map<string, string[]>;
  declarationsByName: Map<string, string[]>;
}

function indexClasses(
  summary: EngineeringCodeAstFileSummaryInput,
  filePath: string,
  languageId: string,
  exportNames: readonly string[],
  indexes: MutableIndexes & {
    classNames: Set<string>;
    inheritanceEdges: EngineeringCodeInheritanceEdge[];
    propertyTypes: Map<string, Map<string, string>>;
  },
): void {
  for (const classRecord of arrayRecords(summary.classes)) {
    const className = stringValue(classRecord.name, "");
    if (!className || className === "Unknown") {
      continue;
    }
    indexes.classNames.add(className);
    const superClass = stringOrNull(classRecord.superClass ?? classRecord.superclass);
    const protocols = stringArray(classRecord.protocols);
    addDeclaration({
      ...indexes,
      declaration: {
        fqn: makeFqn(filePath, className),
        name: className,
        qualifiedName: className,
        kind: symbolKindFromRecord(classRecord, "class"),
        filePath,
        line: numberOrNull(classRecord.line),
        containerName: null,
        className: null,
        isExported: isExported(className, exportNames),
        languageId,
        protocols,
        superClass,
      },
    });
    if (superClass) {
      indexes.inheritanceEdges.push({ from: className, to: superClass, type: "inherits" });
    }
    for (const protocol of protocols) {
      indexes.inheritanceEdges.push({ from: className, to: protocol, type: "conforms" });
    }
    for (const method of arrayRecords(classRecord.methods)) {
      indexMethod(method, filePath, languageId, exportNames, indexes, className);
    }
    for (const prop of arrayRecords(classRecord.properties)) {
      indexProperty(prop, filePath, languageId, indexes, className);
    }
  }
}

function indexProtocols(
  summary: EngineeringCodeAstFileSummaryInput,
  filePath: string,
  languageId: string,
  exportNames: readonly string[],
  indexes: MutableIndexes & {
    protocolNames: Set<string>;
    inheritanceEdges: EngineeringCodeInheritanceEdge[];
  },
): void {
  for (const protocolRecord of arrayRecords(summary.protocols)) {
    const protocolName = stringValue(protocolRecord.name, "");
    if (!protocolName || protocolName === "Unknown") {
      continue;
    }
    indexes.protocolNames.add(protocolName);
    addDeclaration({
      ...indexes,
      declaration: {
        fqn: makeFqn(filePath, protocolName),
        name: protocolName,
        qualifiedName: protocolName,
        kind: languageId === "typescript" ? "interface" : "protocol",
        filePath,
        line: numberOrNull(protocolRecord.line),
        containerName: null,
        className: null,
        isExported: isExported(protocolName, exportNames),
        languageId,
        protocols: stringArray(protocolRecord.inherits),
      },
    });
    for (const parent of stringArray(protocolRecord.inherits)) {
      indexes.inheritanceEdges.push({ from: protocolName, to: parent, type: "protocol-inherits" });
    }
    for (const method of [
      ...arrayRecords(protocolRecord.requiredMethods ?? protocolRecord.methods),
      ...arrayRecords(protocolRecord.optionalMethods),
    ]) {
      indexMethod(method, filePath, languageId, exportNames, indexes, protocolName, "method");
    }
  }
}

function indexCategories(
  summary: EngineeringCodeAstFileSummaryInput,
  filePath: string,
  languageId: string,
  indexes: MutableIndexes & {
    inheritanceEdges: EngineeringCodeInheritanceEdge[];
    propertyTypes: Map<string, Map<string, string>>;
  },
): void {
  for (const categoryRecord of arrayRecords(summary.categories)) {
    const className = stringValue(categoryRecord.className ?? categoryRecord.name, "");
    if (!className) {
      continue;
    }
    const categoryName = stringValue(categoryRecord.categoryName, "extension");
    const qualifiedName = `${className}(${categoryName})`;
    addDeclaration({
      ...indexes,
      declaration: {
        fqn: makeFqn(filePath, qualifiedName),
        name: categoryName,
        qualifiedName,
        kind: "category",
        filePath,
        line: numberOrNull(categoryRecord.line),
        containerName: className,
        className,
        isExported: false,
        languageId,
        protocols: stringArray(categoryRecord.protocols),
      },
    });
    for (const protocol of stringArray(categoryRecord.protocols)) {
      indexes.inheritanceEdges.push({ from: className, to: protocol, type: "category-conforms" });
    }
    for (const method of arrayRecords(categoryRecord.methods)) {
      indexMethod(method, filePath, languageId, [], indexes, className);
    }
    for (const prop of arrayRecords(categoryRecord.properties)) {
      indexProperty(prop, filePath, languageId, indexes, className);
    }
  }
}

function indexTopLevelMethods(
  summary: EngineeringCodeAstFileSummaryInput,
  filePath: string,
  languageId: string,
  exportNames: readonly string[],
  indexes: MutableIndexes,
): void {
  for (const method of arrayRecords(summary.methods)) {
    const className = stringOrNull(method.className ?? method.containerName);
    indexMethod(method, filePath, languageId, exportNames, indexes, className);
  }
}

function indexMethod(
  method: Record<string, unknown>,
  filePath: string,
  languageId: string,
  exportNames: readonly string[],
  indexes: MutableIndexes,
  className: string | null,
  forcedKind?: EngineeringCodeSymbolKind,
): void {
  const methodName = stringValue(method.name ?? method.selector, "");
  if (!methodName || methodName === "unknown") {
    return;
  }
  const simpleName = methodName.replace(/\(.*$/, "");
  const qualifiedName = className ? `${className}.${simpleName}` : simpleName;
  addDeclaration({
    ...indexes,
    declaration: {
      fqn: makeFqn(filePath, qualifiedName),
      name: simpleName,
      qualifiedName,
      kind: forcedKind ?? (className ? "method" : "function"),
      filePath,
      line: numberOrNull(method.line ?? method.startLine),
      containerName: className,
      className,
      isExported: !className && isExported(simpleName, exportNames),
      languageId,
      returnType: stringOrNull(method.returnType),
      paramCount: numberOrNull(method.paramCount),
    },
  });
}

function indexProperty(
  property: Record<string, unknown>,
  filePath: string,
  languageId: string,
  indexes: MutableIndexes & { propertyTypes: Map<string, Map<string, string>> },
  className: string,
): void {
  const propertyName = stringValue(property.name, "");
  if (!propertyName) {
    return;
  }
  const typeName = stringOrNull(property.type ?? property.typeAnnotation);
  if (typeName) {
    if (!indexes.propertyTypes.has(className)) {
      indexes.propertyTypes.set(className, new Map());
    }
    indexes.propertyTypes.get(className)?.set(propertyName, typeName);
  }
  addDeclaration({
    ...indexes,
    declaration: {
      fqn: makeFqn(filePath, `${className}.${propertyName}`),
      name: propertyName,
      qualifiedName: `${className}.${propertyName}`,
      kind: "property",
      filePath,
      line: numberOrNull(property.line ?? property.startLine),
      containerName: className,
      className,
      isExported: false,
      languageId,
      returnType: typeName,
    },
  });
}

function indexPropertyTypeFacts(
  summary: EngineeringCodeAstFileSummaryInput,
  filePath: string,
  languageId: string,
  indexes: MutableIndexes & { propertyTypes: Map<string, Map<string, string>> },
): void {
  for (const fact of propertyTypeRecords((summary as Record<string, unknown>).propertyTypes)) {
    const className = stringValue(fact.className ?? fact.containerName, "");
    const propertyName = stringValue(fact.propertyName ?? fact.name, "");
    const typeName = stringValue(fact.type ?? fact.typeName ?? fact.receiverType, "");
    if (!className || !propertyName || !typeName) {
      continue;
    }
    if (!indexes.propertyTypes.has(className)) {
      indexes.propertyTypes.set(className, new Map());
    }
    indexes.propertyTypes.get(className)?.set(propertyName, typeName);
    indexProperty(
      {
        name: propertyName,
        className,
        type: typeName,
        line: fact.line,
        filePath: fact.filePath,
      },
      filePath,
      languageId,
      indexes,
      className,
    );
  }
}

function propertyTypeRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  const facts: Record<string, unknown>[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      const [className, propertyName] = key.split(".");
      if (className && propertyName) {
        facts.push({ className, propertyName, type: item });
      }
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    for (const [propertyName, typeValue] of Object.entries(item)) {
      if (typeof typeValue === "string") {
        facts.push({ className: key, propertyName, type: typeValue });
      }
    }
  }
  return facts;
}

function indexInstantiatedClasses(
  summary: EngineeringCodeAstFileSummaryInput,
  instantiatedClasses: Set<string>,
): void {
  for (const callSite of arrayRecords(summary.callSites)) {
    const callType = stringValue(callSite.callType, "");
    const receiverType = stringOrNull(callSite.receiverType ?? callSite.callee);
    if (callType === "constructor" && receiverType) {
      instantiatedClasses.add(receiverType);
    }
  }
}

function addDeclaration(input: MutableIndexes & { declaration: EngineeringCodeSymbolDeclaration }) {
  input.declarations.set(input.declaration.fqn, input.declaration);
  pushIndex(input.declarationsByFile, input.declaration.filePath, input.declaration.fqn);
  pushIndex(input.declarationsByName, input.declaration.name, input.declaration.fqn);
  pushIndex(input.declarationsByName, input.declaration.qualifiedName, input.declaration.fqn);
}

function pushIndex(index: Map<string, string[]>, key: string, value: string): void {
  const values = index.get(key) ?? [];
  if (!values.includes(value)) {
    values.push(value);
    index.set(key, values);
  }
}

function freezeMapArrays(index: Map<string, string[]>): Map<string, readonly string[]> {
  return new Map([...index.entries()].map(([key, values]) => [key, Object.freeze([...values])]));
}

function isExported(name: string, exportNames: readonly string[]): boolean {
  return exportNames.includes(name) || exportNames.includes("default");
}

function symbolKindFromRecord(
  record: Record<string, unknown>,
  fallback: EngineeringCodeSymbolKind,
): EngineeringCodeSymbolKind {
  const kind = stringValue(record.kind, fallback);
  return ["class", "type", "interface", "protocol"].includes(kind)
    ? (kind as EngineeringCodeSymbolKind)
    : fallback;
}

function moduleNameForFile(filePath: string): string {
  const basename = filePath.split("/").at(-1) ?? filePath;
  return basename.replace(/\.[^.]+$/, "");
}

export default SymbolTableBuilder;
