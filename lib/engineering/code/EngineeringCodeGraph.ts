import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallEdgeQuery,
  EngineeringCodeCallExpressionMatch,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeCallSite,
  EngineeringCodeCategoryInfo,
  EngineeringCodeClassInfo,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeDataFlowQuery,
  EngineeringCodeExport,
  EngineeringCodeFileSymbols,
  EngineeringCodeGraphOverview,
  EngineeringCodeGraphReader,
  EngineeringCodeGraphSnapshot,
  EngineeringCodeMethod,
  EngineeringCodeMetrics,
  EngineeringCodePattern,
  EngineeringCodePatternContextFilter,
  EngineeringCodePatternContextMatch,
  EngineeringCodeProperty,
  EngineeringCodeProtocolConformanceResult,
  EngineeringCodeProtocolInfo,
  EngineeringCodeReference,
} from "./EngineeringCodeGraphModel.js";

export class EngineeringCodeGraph implements EngineeringCodeGraphReader {
  readonly #classes = new Map<string, EngineeringCodeClassInfo>();
  readonly #protocols = new Map<string, EngineeringCodeProtocolInfo>();
  readonly #categories = new Map<string, EngineeringCodeCategoryInfo[]>();
  readonly #files = new Map<string, EngineeringCodeFileSymbols>();
  readonly #methodsByClass = new Map<string, EngineeringCodeMethod[]>();
  readonly #inheritance = new Map<string, string>();
  readonly #conformance = new Map<string, Set<string>>();
  readonly #callGraphEdges: EngineeringCodeCallGraphEdge[] = [];
  readonly #dataFlowEdges: EngineeringCodeDataFlowEdge[] = [];
  #overview: EngineeringCodeGraphOverview | null = null;

  static fromAstSummary(input: EngineeringCodeAstSummaryInput): EngineeringCodeGraph {
    const graph = new EngineeringCodeGraph();
    for (const summary of fileSummariesFrom(input)) {
      graph.#indexFileSummary(summary);
    }
    graph.#indexProjectEdges(input);
    graph.#buildReverseIndices();
    return graph;
  }

  static fromJSON(snapshot: EngineeringCodeGraphSnapshot): EngineeringCodeGraph {
    const graph = new EngineeringCodeGraph();
    for (const file of snapshot.files ?? []) {
      graph.#files.set(file.path, file);
    }
    for (const classInfo of snapshot.classes ?? []) {
      graph.#classes.set(classInfo.name, classInfo);
      graph.#methodsByClass.set(classInfo.name, [...classInfo.methods]);
      graph.#conformance.set(classInfo.name, new Set(classInfo.protocols));
      if (classInfo.superClass) {
        graph.#inheritance.set(classInfo.name, classInfo.superClass);
      }
    }
    for (const protocol of snapshot.protocols ?? []) {
      graph.#protocols.set(protocol.name, protocol);
    }
    for (const category of snapshot.categories ?? []) {
      graph.#appendCategory(category);
      if (category.protocols.length > 0) {
        graph.#addConformances(category.className, category.protocols);
      }
    }
    graph.#callGraphEdges.push(...(snapshot.callGraphEdges ?? []));
    graph.#dataFlowEdges.push(...(snapshot.dataFlowEdges ?? []));
    graph.#buildReverseIndices();
    graph.#overview = snapshot.overview ?? null;
    return graph;
  }

  getClassInfo(className: string): EngineeringCodeClassInfo | null {
    return this.#classes.get(className) ?? null;
  }

  getProtocolInfo(protocolName: string): EngineeringCodeProtocolInfo | null {
    return this.#protocols.get(protocolName) ?? null;
  }

  getInheritanceChain(className: string): readonly string[] {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current: string | null = className;
    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      current = this.#inheritance.get(current) ?? null;
    }
    return chain;
  }

  getSubclasses(className: string): readonly string[] {
    return [...this.#inheritance.entries()]
      .filter(([, parent]) => parent === className)
      .map(([child]) => child)
      .sort();
  }

  getAllDescendants(className: string): readonly string[] {
    const descendants: string[] = [];
    const queue = [...this.getSubclasses(className)];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      descendants.push(current);
      queue.push(...this.getSubclasses(current));
    }
    return descendants.sort();
  }

  getCategoryExtensions(className: string): readonly EngineeringCodeCategoryInfo[] {
    return [...(this.#categories.get(className) ?? [])].sort(compareCategory);
  }

  getMethodOverrides(
    className: string,
    methodName: string,
  ): readonly { readonly className: string; readonly method: EngineeringCodeMethod }[] {
    return this.getAllDescendants(className)
      .flatMap((descendant) =>
        this.getClassMethods(descendant)
          .filter((method) => method.name === methodName || method.selector === methodName)
          .map((method) => ({ className: descendant, method })),
      )
      .sort((left, right) => left.className.localeCompare(right.className));
  }

  getClassMethods(className: string): readonly EngineeringCodeMethod[] {
    const classMethods = this.#methodsByClass.get(className) ?? [];
    const categoryMethods = (this.#categories.get(className) ?? []).flatMap(
      (category) => category.methods,
    );
    return [...classMethods, ...categoryMethods].sort(compareMethod);
  }

  getFileSymbols(relativePath: string): EngineeringCodeFileSymbols | null {
    return this.#files.get(relativePath) ?? null;
  }

  getAllFilePaths(): readonly string[] {
    return [...this.#files.keys()].sort();
  }

  searchClasses(query: string, limit = 20): readonly string[] {
    const normalized = query.trim().toLowerCase();
    return [...this.#classes.keys()]
      .filter((name) => !normalized || name.toLowerCase().includes(normalized))
      .sort()
      .slice(0, limit);
  }

  getOverview(): EngineeringCodeGraphOverview {
    if (this.#overview) {
      return this.#overview;
    }

    const classesPerModule: Record<string, number> = {};
    const topLevelModules = new Set<string>();
    const entryPoints: string[] = [];
    for (const [filePath, symbols] of this.#files) {
      const moduleName = firstPathSegment(filePath);
      topLevelModules.add(moduleName);
      classesPerModule[moduleName] = (classesPerModule[moduleName] ?? 0) + symbols.classes.length;
      if (isEntryPoint(filePath)) {
        entryPoints.push(filePath);
      }
    }

    this.#overview = {
      totalFiles: this.#files.size,
      totalClasses: this.#classes.size,
      totalProtocols: this.#protocols.size,
      totalCategories: [...this.#categories.values()].reduce((sum, items) => sum + items.length, 0),
      totalMethods: this.#countMethods(),
      topLevelModules: [...topLevelModules].sort(),
      entryPoints: entryPoints.sort(),
      classesPerModule,
    };
    return this.#overview;
  }

  getAllClassNames(): readonly string[] {
    return [...this.#classes.keys()].sort();
  }

  getAllProtocolNames(): readonly string[] {
    return [...this.#protocols.keys()].sort();
  }

  upsertFileSummary(summary: EngineeringCodeAstFileSummaryInput): "added" | "updated" | "ignored" {
    const filePath = filePathFor(summary);
    if (!filePath || filePath === "(unknown)") {
      return "ignored";
    }
    const result = this.#files.has(filePath) ? "updated" : "added";
    this.#removeFileIndexes(filePath);
    this.#indexFileSummary(summary);
    this.#buildReverseIndices();
    return result;
  }

  deleteFileSummary(relativePath: string): boolean {
    if (!relativePath || !this.#files.has(relativePath)) {
      return false;
    }
    this.#removeFileIndexes(relativePath);
    this.#buildReverseIndices();
    return true;
  }

  incrementalUpdate(
    changedSummaries: EngineeringCodeAstSummaryInput = [],
    deletedPaths: readonly string[] = [],
  ): { readonly added: number; readonly updated: number; readonly deleted: number } {
    let added = 0;
    let updated = 0;
    let deleted = 0;

    for (const deletedPath of deletedPaths) {
      if (this.#files.has(deletedPath)) {
        this.#removeFileIndexes(deletedPath);
        deleted++;
      }
    }

    for (const summary of fileSummariesFrom(changedSummaries)) {
      const filePath = filePathFor(summary);
      if (!filePath || filePath === "(unknown)") {
        continue;
      }
      const isUpdate = this.#files.has(filePath);
      this.#removeFileIndexes(filePath);
      this.#indexFileSummary(summary);
      isUpdate ? updated++ : added++;
    }
    this.#indexProjectEdges(changedSummaries);

    if (added + updated + deleted > 0) {
      this.#buildReverseIndices();
    }

    return { added, updated, deleted };
  }

  getCallGraphEdges(
    query: EngineeringCodeCallEdgeQuery = {},
  ): readonly EngineeringCodeCallGraphEdge[] {
    return this.#callGraphEdges
      .filter((edge) => callEdgeMatches(edge, query))
      .sort(compareCallEdge);
  }

  getCallEdgesByFile(filePath: string): readonly EngineeringCodeCallGraphEdge[] {
    return this.getCallGraphEdges({ filePath });
  }

  getCallEdgesForSymbol(symbol: string): readonly EngineeringCodeCallGraphEdge[] {
    return this.getCallGraphEdges({ symbol });
  }

  getCallEdgesForClass(className: string): readonly EngineeringCodeCallGraphEdge[] {
    return this.getCallGraphEdges({ className });
  }

  getCallEdgesForMethod(
    classNameOrMethod: string,
    methodName?: string,
  ): readonly EngineeringCodeCallGraphEdge[] {
    return this.getCallGraphEdges(
      methodName ? { className: classNameOrMethod, methodName } : { methodName: classNameOrMethod },
    );
  }

  getDataFlowEdges(
    query: EngineeringCodeDataFlowQuery = {},
  ): readonly EngineeringCodeDataFlowEdge[] {
    return this.#dataFlowEdges
      .filter((edge) => dataFlowEdgeMatches(edge, query))
      .sort(compareDataFlowEdge);
  }

  findCallExpressions(
    targetCallee: string,
    options: { readonly filePath?: string; readonly className?: string } = {},
  ): readonly EngineeringCodeCallExpressionMatch[] {
    const normalized = targetCallee.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const matches: EngineeringCodeCallExpressionMatch[] = [];
    for (const file of this.#files.values()) {
      if (options.filePath && file.path !== options.filePath) {
        continue;
      }
      for (const callSite of file.callSites) {
        if (options.className && callSite.callerClass !== options.className) {
          continue;
        }
        if (!callSiteMatchesTarget(callSite, normalized)) {
          continue;
        }
        matches.push({
          filePath: file.path,
          line: callSite.line,
          snippet: callSite.snippet ?? callSiteDisplay(callSite),
          enclosingClass: callSite.callerClass,
          callSite,
        });
      }
    }
    return matches.sort(compareLineMatch);
  }

  findPatternInContext(
    pattern: string,
    contextFilter: EngineeringCodePatternContextFilter = {},
  ): readonly EngineeringCodePatternContextMatch[] {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const results: EngineeringCodePatternContextMatch[] = [];
    for (const file of this.#files.values()) {
      const candidates = [...file.patterns, ...file.references, ...file.callSites];
      for (const candidate of candidates) {
        if (!recordTextMatches(candidate, normalized)) {
          continue;
        }
        const context = contextForPatternCandidate(candidate);
        if (!contextMatchesFilter(context, contextFilter)) {
          continue;
        }
        results.push({
          filePath: file.path,
          line: "line" in candidate ? candidate.line : null,
          snippet: snippetForPatternCandidate(candidate),
          context,
          pattern: candidate,
        });
      }
    }
    return results.sort(compareLineMatch);
  }

  checkProtocolConformance(
    className: string,
    protocolName: string,
  ): EngineeringCodeProtocolConformanceResult {
    const classInfo = this.#classes.get(className);
    if (!classInfo || !protocolName) {
      return {
        conforms: false,
        classFound: Boolean(classInfo),
        classDeclLine: classInfo?.line ?? null,
        direct: false,
        viaCategory: false,
        viaInheritedProtocol: false,
      };
    }

    const direct = classInfo.protocols.includes(protocolName);
    const categoryProtocols = (this.#categories.get(className) ?? []).flatMap(
      (category) => category.protocols,
    );
    const viaCategory = categoryProtocols.includes(protocolName);
    const expanded = expandedProtocols(
      [...classInfo.protocols, ...categoryProtocols],
      this.#protocols,
    );
    const viaInheritedProtocol = !direct && !viaCategory && expanded.includes(protocolName);

    return {
      conforms: direct || viaCategory || viaInheritedProtocol,
      classFound: true,
      classDeclLine: classInfo.line,
      direct,
      viaCategory,
      viaInheritedProtocol,
    };
  }

  toJSON(): EngineeringCodeGraphSnapshot {
    return {
      classes: [...this.#classes.values()].sort(compareNamed),
      protocols: [...this.#protocols.values()].sort(compareNamed),
      categories: [...this.#categories.values()].flat().sort(compareCategory),
      files: [...this.#files.values()].sort((left, right) => left.path.localeCompare(right.path)),
      callGraphEdges: [...this.#callGraphEdges].sort(compareCallEdge),
      dataFlowEdges: [...this.#dataFlowEdges].sort(compareDataFlowEdge),
      overview: this.getOverview(),
    };
  }

  #indexFileSummary(summary: EngineeringCodeAstFileSummaryInput): void {
    const filePath = filePathFor(summary);
    const classes = arrayRecords(summary.classes);
    const protocols = arrayRecords(summary.protocols);
    const categories = arrayRecords(summary.categories);
    const fileSymbols: EngineeringCodeFileSymbols = {
      path: filePath,
      languageId: stringValue(summary.languageId ?? summary.lang, "unknown"),
      classes: classes
        .map((record) => stringValue(record.name, ""))
        .filter(Boolean)
        .sort(),
      protocols: protocols
        .map((record) => stringValue(record.name, ""))
        .filter(Boolean)
        .sort(),
      categories: categories.map(categoryDisplayName).filter(Boolean).sort(),
      imports: [...(Array.isArray(summary.imports) ? summary.imports : [])],
      exports: exportArray(summary.exports, filePath),
      callSites: callSiteArray(summary.callSites, filePath),
      references: referenceArray(summary.references, filePath),
      patterns: patternArray(summary.patterns, filePath),
      metrics: metricsForSummary(summary.metrics, filePath),
    };

    for (const classRecord of classes) {
      const name = stringValue(classRecord.name, "");
      if (!name) {
        continue;
      }
      const methods = methodsForClass(summary, classRecord, name, filePath);
      const classInfo: EngineeringCodeClassInfo = {
        name,
        filePath: stringValue(classRecord.filePath ?? classRecord.file, filePath),
        line: numberOrNull(classRecord.line),
        endLine: numberOrNull(classRecord.endLine),
        superClass: stringOrNull(classRecord.superClass ?? classRecord.superclass),
        protocols: stringArray(classRecord.protocols).sort(),
        properties: propertiesForClass(summary, classRecord, name),
        methods,
        imports: [
          ...(Array.isArray(classRecord.imports) ? classRecord.imports : fileSymbols.imports),
        ],
      };
      this.#classes.set(name, classInfo);
      this.#methodsByClass.set(name, methods);
      this.#addConformances(name, classInfo.protocols);
      if (classInfo.superClass) {
        this.#inheritance.set(name, classInfo.superClass);
      }
    }

    for (const protocolRecord of protocols) {
      const name = stringValue(protocolRecord.name, "");
      if (!name) {
        continue;
      }
      this.#protocols.set(name, {
        name,
        filePath: stringValue(protocolRecord.filePath ?? protocolRecord.file, filePath),
        line: numberOrNull(protocolRecord.line),
        inherits: stringArray(protocolRecord.inherits).sort(),
        requiredMethods: methodArray(
          protocolRecord.requiredMethods ?? protocolRecord.methods,
          filePath,
        ),
        optionalMethods: methodArray(protocolRecord.optionalMethods, filePath),
        conformers: [],
      });
    }

    for (const categoryRecord of categories) {
      const className = stringValue(categoryRecord.className ?? categoryRecord.name, "");
      if (!className) {
        continue;
      }
      const categoryInfo: EngineeringCodeCategoryInfo = {
        className,
        categoryName: stringValue(categoryRecord.categoryName, "extension"),
        filePath: stringValue(categoryRecord.filePath ?? categoryRecord.file, filePath),
        line: numberOrNull(categoryRecord.line),
        methods: methodArray(categoryRecord.methods, filePath),
        properties: propertyArray(categoryRecord.properties),
        protocols: stringArray(categoryRecord.protocols).sort(),
      };
      this.#appendCategory(categoryInfo);
      this.#addConformances(className, categoryInfo.protocols);
    }

    this.#files.set(filePath, fileSymbols);
    this.#appendEdgesForFile(filePath, summary);
  }

  #indexProjectEdges(input: EngineeringCodeAstSummaryInput): void {
    if (Array.isArray(input)) {
      return;
    }
    const container = input as Exclude<
      EngineeringCodeAstSummaryInput,
      readonly EngineeringCodeAstFileSummaryInput[]
    >;
    for (const edge of callGraphEdgeArray(
      container.callGraphEdges ?? container.callEdges,
      "(project)",
    )) {
      this.#appendCallGraphEdge(edge);
    }
    for (const edge of dataFlowEdgeArray(container.dataFlowEdges, null)) {
      this.#appendDataFlowEdge(edge);
    }
  }

  #appendEdgesForFile(filePath: string, summary: EngineeringCodeAstFileSummaryInput): void {
    const explicitCallEdges = callGraphEdgeArray(
      summary.callGraphEdges ?? summary.callEdges,
      filePath,
    );
    for (const edge of explicitCallEdges) {
      this.#appendCallGraphEdge(edge);
    }

    for (const edge of dataFlowEdgeArray(summary.dataFlowEdges, filePath)) {
      this.#appendDataFlowEdge(edge);
    }

    if (explicitCallEdges.length > 0 || arrayRecords(summary.dataFlowEdges).length > 0) {
      return;
    }
    for (const callSite of callSiteArray(summary.callSites, filePath)) {
      this.#appendCallGraphEdge(callSiteToEdge(callSite));
    }
  }

  #appendCallGraphEdge(edge: EngineeringCodeCallGraphEdge): void {
    const key = callEdgeKey(edge);
    if (this.#callGraphEdges.some((existing) => callEdgeKey(existing) === key)) {
      return;
    }
    this.#callGraphEdges.push(edge);
    if (edge.argCount > 0) {
      this.#appendDataFlowEdge(argumentDataFlowEdge(edge));
    }
    this.#appendDataFlowEdge(returnValueDataFlowEdge(edge));
  }

  #appendDataFlowEdge(edge: EngineeringCodeDataFlowEdge): void {
    const key = dataFlowEdgeKey(edge);
    if (this.#dataFlowEdges.some((existing) => dataFlowEdgeKey(existing) === key)) {
      return;
    }
    this.#dataFlowEdges.push(edge);
  }

  #removeFileIndexes(filePath: string): void {
    if (!this.#files.has(filePath)) {
      return;
    }

    this.#files.delete(filePath);

    for (const [className, classInfo] of [...this.#classes.entries()]) {
      if (classInfo.filePath === filePath) {
        this.#classes.delete(className);
      }
    }
    for (const [protocolName, protocol] of [...this.#protocols.entries()]) {
      if (protocol.filePath === filePath) {
        this.#protocols.delete(protocolName);
      }
    }
    for (const [className, categories] of [...this.#categories.entries()]) {
      const remaining = categories.filter((category) => category.filePath !== filePath);
      if (remaining.length > 0) {
        this.#categories.set(className, remaining);
      } else {
        this.#categories.delete(className);
      }
    }

    removeInPlace(
      this.#callGraphEdges,
      (edge) =>
        edge.filePath === filePath ||
        edge.sourceFilePath === filePath ||
        edge.targetFilePath === filePath,
    );
    removeInPlace(
      this.#dataFlowEdges,
      (edge) =>
        edge.filePath === filePath ||
        stringIncludes(edge.from, filePath) ||
        stringIncludes(edge.to, filePath) ||
        stringIncludes(edge.source ?? "", filePath) ||
        stringIncludes(edge.sink ?? "", filePath),
    );
    this.#overview = null;
  }

  #appendCategory(category: EngineeringCodeCategoryInfo): void {
    this.#categories.set(category.className, [
      ...(this.#categories.get(category.className) ?? []),
      category,
    ]);
  }

  #addConformances(className: string, protocolNames: readonly string[]): void {
    if (protocolNames.length === 0) {
      return;
    }
    const conformances = this.#conformance.get(className) ?? new Set<string>();
    for (const protocolName of protocolNames) {
      conformances.add(protocolName);
    }
    this.#conformance.set(className, conformances);
  }

  #buildReverseIndices(): void {
    this.#inheritance.clear();
    this.#conformance.clear();
    this.#methodsByClass.clear();

    for (const classInfo of this.#classes.values()) {
      this.#methodsByClass.set(classInfo.name, [...classInfo.methods]);
      if (classInfo.superClass) {
        this.#inheritance.set(classInfo.name, classInfo.superClass);
      }
      this.#addConformances(classInfo.name, classInfo.protocols);
    }
    for (const category of [...this.#categories.values()].flat()) {
      this.#addConformances(category.className, category.protocols);
    }

    for (const protocol of this.#protocols.values()) {
      this.#protocols.set(protocol.name, { ...protocol, conformers: [] });
    }
    for (const [className, protocolNames] of this.#conformance) {
      for (const protocolName of expandedProtocols(protocolNames, this.#protocols)) {
        const protocol = this.#protocols.get(protocolName);
        if (!protocol || protocol.conformers.includes(className)) {
          continue;
        }
        this.#protocols.set(protocolName, {
          ...protocol,
          conformers: [...protocol.conformers, className].sort(),
        });
      }
    }
    this.#overview = null;
  }

  #countMethods(): number {
    const classMethods = [...this.#methodsByClass.values()].reduce(
      (sum, methods) => sum + methods.length,
      0,
    );
    const categoryMethods = [...this.#categories.values()]
      .flat()
      .reduce((sum, category) => sum + category.methods.length, 0);
    const protocolMethods = [...this.#protocols.values()].reduce(
      (sum, protocol) => sum + protocol.requiredMethods.length + protocol.optionalMethods.length,
      0,
    );
    return classMethods + categoryMethods + protocolMethods;
  }
}

function fileSummariesFrom(
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

function methodsForClass(
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

function propertiesForClass(
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

function methodArray(value: unknown, fallbackFilePath: string): EngineeringCodeMethod[] {
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

function propertyArray(value: unknown): EngineeringCodeProperty[] {
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

function callSiteArray(value: unknown, fallbackFilePath: string): EngineeringCodeCallSite[] {
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

function referenceArray(value: unknown, fallbackFilePath: string): EngineeringCodeReference[] {
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

function exportArray(value: unknown, fallbackFilePath: string): EngineeringCodeExport[] {
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

function patternArray(value: unknown, fallbackFilePath: string): EngineeringCodePattern[] {
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

function metricsForSummary(
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

function callGraphEdgeArray(
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

function dataFlowEdgeArray(
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

function callSiteToEdge(callSite: EngineeringCodeCallSite): EngineeringCodeCallGraphEdge {
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

function argumentDataFlowEdge(edge: EngineeringCodeCallGraphEdge): EngineeringCodeDataFlowEdge {
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

function returnValueDataFlowEdge(edge: EngineeringCodeCallGraphEdge): EngineeringCodeDataFlowEdge {
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

function expandedProtocols(
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

function categoryDisplayName(record: Record<string, unknown>): string {
  const className = stringValue(record.className ?? record.name, "");
  const categoryName = stringValue(record.categoryName, "extension");
  return className ? `${className}(${categoryName})` : "";
}

function filePathFor(summary: EngineeringCodeAstFileSummaryInput): string {
  return stringValue(summary.filePath ?? summary.file ?? summary.path, "(unknown)");
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareNamed(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

function compareMethod(left: EngineeringCodeMethod, right: EngineeringCodeMethod): number {
  return (
    left.name.localeCompare(right.name) ||
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}

function compareCategory(
  left: EngineeringCodeCategoryInfo,
  right: EngineeringCodeCategoryInfo,
): number {
  return (
    left.className.localeCompare(right.className) ||
    left.categoryName.localeCompare(right.categoryName) ||
    left.filePath.localeCompare(right.filePath)
  );
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

function compareCallEdge(
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

function compareDataFlowEdge(
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

function compareLineMatch(
  left: { readonly filePath: string; readonly line: number | null },
  right: { readonly filePath: string; readonly line: number | null },
): number {
  return left.filePath.localeCompare(right.filePath) || (left.line ?? 0) - (right.line ?? 0);
}

function callEdgeMatches(
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

function dataFlowEdgeMatches(
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

function callSiteMatchesTarget(
  callSite: EngineeringCodeCallSite,
  normalizedTarget: string,
): boolean {
  return (
    callSite.callee.toLowerCase().includes(normalizedTarget) ||
    callSiteDisplay(callSite).toLowerCase().includes(normalizedTarget) ||
    (callSite.snippet ?? "").toLowerCase().includes(normalizedTarget)
  );
}

function callSiteDisplay(callSite: EngineeringCodeCallSite): string {
  const receiver = callSite.receiver ?? callSite.receiverType;
  return receiver ? `${receiver}.${callSite.callee}` : callSite.callee;
}

function recordTextMatches(value: unknown, normalizedPattern: string): boolean {
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

function contextForPatternCandidate(
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

function contextMatchesFilter(
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

function snippetForPatternCandidate(
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

function callEdgeKey(edge: EngineeringCodeCallGraphEdge): string {
  return `${edge.filePath}:${edge.line ?? ""}:${edge.caller}->${edge.callee}:${edge.callType}`;
}

function dataFlowEdgeKey(edge: EngineeringCodeDataFlowEdge): string {
  return `${edge.filePath ?? ""}:${edge.line ?? ""}:${edge.from}->${edge.to}:${edge.flowType}:${edge.direction}`;
}

function symbolTail(symbol: string): string {
  const withoutFile = symbol.includes("::") ? (symbol.split("::").pop() ?? symbol) : symbol;
  return withoutFile.includes(".") ? (withoutFile.split(".").pop() ?? withoutFile) : withoutFile;
}

function stringIncludes(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function removeInPlace<T>(items: T[], predicate: (item: T) => boolean): void {
  let writeIndex = 0;
  for (const item of items) {
    if (!predicate(item)) {
      items[writeIndex] = item;
      writeIndex++;
    }
  }
  items.length = writeIndex;
}

function firstPathSegment(filePath: string): string {
  return filePath.includes("/") ? (filePath.split("/")[0] ?? "(root)") : "(root)";
}

function isEntryPoint(filePath: string): boolean {
  return /^(AppDelegate|SceneDelegate|main|index|app)\.(m|mm|swift|ts|tsx|js|jsx|go|py)$/.test(
    filePath.split("/").pop() ?? filePath,
  );
}
