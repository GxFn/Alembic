import type {
  EngineeringCodeAnalysisTier,
  EngineeringCodeImportRecord,
  EngineeringCodeNormalizedCallSite,
  EngineeringCodeResolvedCallEdge,
  EngineeringCodeSymbolDeclaration,
  EngineeringCodeSymbolTable,
} from "./EngineeringCodeAnalysisTypes.js";
import type { ImportPathResolver } from "./ImportPathResolver.js";

export class CallEdgeResolver {
  readonly #symbolTable: EngineeringCodeSymbolTable;
  readonly #importResolver: ImportPathResolver;

  constructor(symbolTable: EngineeringCodeSymbolTable, importResolver: ImportPathResolver) {
    this.#symbolTable = symbolTable;
    this.#importResolver = importResolver;
  }

  resolveFile(
    callSites: readonly EngineeringCodeNormalizedCallSite[],
    callerFile: string,
  ): readonly EngineeringCodeResolvedCallEdge[] {
    const imports = this.#buildImportMap(
      this.#symbolTable.fileImports.get(callerFile) ?? [],
      callerFile,
    );
    const edges: EngineeringCodeResolvedCallEdge[] = [];
    const seen = new Set<string>();
    for (const callSite of callSites) {
      const edge = this.#resolveCallSite(callSite, callerFile, imports);
      const key = `${edge.caller}\0${edge.callee}\0${edge.filePath}\0${edge.line ?? ""}\0${edge.tier}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(edge);
      }
    }
    return edges;
  }

  #resolveCallSite(
    callSite: EngineeringCodeNormalizedCallSite,
    callerFile: string,
    imports: Map<string, ImportBinding>,
  ): EngineeringCodeResolvedCallEdge {
    const caller = `${callerFile}::${callSite.callerClass ? `${callSite.callerClass}.` : ""}${callSite.callerMethod}`;

    if ((callSite.receiver === "this" || callSite.receiver === "self") && callSite.callerClass) {
      const exact = this.#findMethodForType(callSite.callerClass, callSite.callee, false);
      if (exact) {
        return this.#makeEdge(
          caller,
          exact.declaration,
          exact.tier,
          callSite,
          callerFile,
          exact.confidence,
        );
      }
    }

    if ((callSite.receiver === "super" || callSite.callType === "super") && callSite.callerClass) {
      const inherited = this.#findInheritedMethod(callSite.callerClass, callSite.callee);
      if (inherited) {
        return this.#makeEdge(caller, inherited, "inheritance", callSite, callerFile, 0.78);
      }
    }

    const receiverFieldType = this.#receiverFieldType(callSite);
    if (receiverFieldType) {
      const fieldTarget = this.#findMethodForType(receiverFieldType, callSite.callee, true);
      if (fieldTarget) {
        return this.#makeEdge(
          caller,
          fieldTarget.declaration,
          fieldTarget.tier,
          callSite,
          callerFile,
          fieldTarget.confidence,
        );
      }
    }

    if (callSite.receiverType) {
      const typedTarget = this.#findMethodForType(callSite.receiverType, callSite.callee, true);
      if (typedTarget) {
        return this.#makeEdge(
          caller,
          typedTarget.declaration,
          typedTarget.tier,
          callSite,
          callerFile,
          typedTarget.confidence,
        );
      }
    }

    const imported = imports.get(callSite.receiver ?? callSite.callee);
    if (imported?.resolvedPath) {
      const importTarget = this.#resolveImportedCall(imported, callSite);
      if (importTarget) {
        return this.#makeEdge(caller, importTarget, "import", callSite, callerFile, 0.86);
      }
    }

    if (!callSite.receiver && callSite.callerClass && callSite.callType !== "constructor") {
      const implicitThis = this.#findMethodForType(callSite.callerClass, callSite.callee, false);
      if (implicitThis && implicitThis.declaration.fqn !== caller) {
        return this.#makeEdge(
          caller,
          implicitThis.declaration,
          implicitThis.tier,
          callSite,
          callerFile,
          implicitThis.confidence,
        );
      }
    }

    const localTarget = this.#findInFile(
      callSite.receiver ? `${callSite.receiver}.${callSite.callee}` : callSite.callee,
      callerFile,
    ).find((declaration) => declaration.fqn !== caller);
    if (localTarget) {
      return this.#makeEdge(caller, localTarget, "direct", callSite, callerFile, 0.9);
    }

    const global = this.#lookup(callSite.callee).filter(
      (declaration) => declaration.fqn !== caller,
    );
    const onlyGlobal = global.length === 1 ? global[0] : undefined;
    if (onlyGlobal) {
      return this.#makeEdge(caller, onlyGlobal, "inferred", callSite, callerFile, 0.5);
    }

    const rta = this.#filterInstantiated(global);
    const onlyRta = rta.length === 1 ? rta[0] : undefined;
    if (onlyRta) {
      return this.#makeEdge(caller, onlyRta, "rta", callSite, callerFile, 0.62);
    }

    return this.#makeUnresolvedEdge(
      caller,
      callSite,
      callerFile,
      global.length > 1
        ? "ambiguous global candidates"
        : "no local, import, inheritance, or protocol target",
    );
  }

  #buildImportMap(
    imports: readonly EngineeringCodeImportRecord[],
    callerFile: string,
  ): Map<string, ImportBinding> {
    const bindings = new Map<string, ImportBinding>();
    for (const imp of imports) {
      const resolution = this.#importResolver.resolve(imp.path, callerFile);
      if (resolution.status !== "resolved") {
        bindings.set(imp.alias ?? imp.path, {
          importRecord: imp,
          resolvedPath: null,
          namespace: false,
        });
        continue;
      }
      if (imp.symbols.length > 0) {
        for (const symbol of imp.symbols) {
          if (symbol === "*" && imp.alias) {
            bindings.set(imp.alias, {
              importRecord: imp,
              resolvedPath: resolution.resolvedPath,
              namespace: true,
            });
          } else {
            bindings.set(imp.alias ?? symbol, {
              importRecord: imp,
              resolvedPath: resolution.resolvedPath,
              namespace: false,
            });
          }
        }
      } else {
        const stem =
          imp.alias ??
          imp.path
            .split("/")
            .at(-1)
            ?.replace(/\.[^.]+$/, "");
        if (stem) {
          bindings.set(stem, {
            importRecord: imp,
            resolvedPath: resolution.resolvedPath,
            namespace: true,
          });
        }
      }
    }
    return bindings;
  }

  #resolveImportedCall(
    binding: ImportBinding,
    callSite: EngineeringCodeNormalizedCallSite,
  ): EngineeringCodeSymbolDeclaration | null {
    if (!binding.resolvedPath) {
      return null;
    }
    const lookupName =
      binding.namespace && callSite.receiver
        ? callSite.callee
        : callSite.receiver
          ? `${callSite.receiver}.${callSite.callee}`
          : callSite.callee;
    return this.#findInFile(lookupName, binding.resolvedPath)[0] ?? null;
  }

  #findMethodForType(
    typeName: string,
    methodName: string,
    allowOverride: boolean,
  ): {
    readonly declaration: EngineeringCodeSymbolDeclaration;
    readonly tier: EngineeringCodeAnalysisTier;
    readonly confidence: number;
  } | null {
    if (this.#symbolTable.protocolNames.has(typeName)) {
      const protocolTarget = this.#findProtocolConformerMethod(typeName, methodName);
      if (protocolTarget) {
        return { declaration: protocolTarget, tier: "protocol", confidence: 0.68 };
      }
    }

    if (allowOverride) {
      const overrideTarget = this.#findInstantiatedOverride(typeName, methodName);
      if (overrideTarget) {
        return { declaration: overrideTarget, tier: "override", confidence: 0.72 };
      }
    }

    const exact = this.#lookup(`${typeName}.${methodName}`)[0];
    if (exact) {
      return { declaration: exact, tier: "class-method", confidence: 0.9 };
    }
    const inherited = this.#findInheritedMethod(typeName, methodName);
    return inherited ? { declaration: inherited, tier: "inheritance", confidence: 0.76 } : null;
  }

  #findInheritedMethod(
    className: string,
    methodName: string,
  ): EngineeringCodeSymbolDeclaration | null {
    const visited = new Set([className]);
    const queue = [className];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const edge of this.#symbolTable.inheritanceEdges) {
        if (edge.from !== current || edge.type !== "inherits" || visited.has(edge.to)) {
          continue;
        }
        visited.add(edge.to);
        const candidate = this.#lookup(`${edge.to}.${methodName}`)[0];
        if (candidate) {
          return candidate;
        }
        queue.push(edge.to);
      }
    }
    return null;
  }

  #findInstantiatedOverride(
    typeName: string,
    methodName: string,
  ): EngineeringCodeSymbolDeclaration | null {
    for (const descendant of this.#descendantsOf(typeName)) {
      if (
        this.#symbolTable.instantiatedClasses.size > 0 &&
        !this.#symbolTable.instantiatedClasses.has(descendant)
      ) {
        continue;
      }
      const candidate = this.#lookup(`${descendant}.${methodName}`)[0];
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  #findProtocolConformerMethod(
    protocolName: string,
    methodName: string,
  ): EngineeringCodeSymbolDeclaration | null {
    const conformers = this.#symbolTable.inheritanceEdges
      .filter(
        (edge) => ["conforms", "category-conforms"].includes(edge.type) && edge.to === protocolName,
      )
      .map((edge) => edge.from);
    const instantiated = conformers.filter((name) =>
      this.#symbolTable.instantiatedClasses.has(name),
    );
    for (const className of instantiated.length > 0 ? instantiated : conformers) {
      const candidate = this.#lookup(`${className}.${methodName}`)[0];
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  #descendantsOf(className: string): string[] {
    const descendants: string[] = [];
    const queue = [className];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      for (const edge of this.#symbolTable.inheritanceEdges) {
        if (edge.type !== "inherits" || edge.to !== current || visited.has(edge.from)) {
          continue;
        }
        visited.add(edge.from);
        descendants.push(edge.from);
        queue.push(edge.from);
      }
    }
    return descendants;
  }

  #receiverFieldType(callSite: EngineeringCodeNormalizedCallSite): string | null {
    if (!callSite.callerClass || !callSite.receiver) {
      return null;
    }
    if (!callSite.receiver.startsWith("this.") && !callSite.receiver.startsWith("self.")) {
      return null;
    }
    const fieldName = callSite.receiver.split(".").slice(1).join(".");
    const explicit = this.#symbolTable.propertyTypes.get(callSite.callerClass)?.get(fieldName);
    if (explicit) {
      return explicit;
    }
    const inferred = fieldName.replace(/^_+/, "");
    const first = inferred[0];
    const pascal = first ? first.toUpperCase() + inferred.slice(1) : "";
    return this.#symbolTable.classNames.has(pascal) ? pascal : null;
  }

  #findInFile(name: string, filePath: string): EngineeringCodeSymbolDeclaration[] {
    return (this.#symbolTable.declarationsByFile.get(filePath) ?? [])
      .map((fqn) => this.#symbolTable.declarations.get(fqn))
      .filter((declaration): declaration is EngineeringCodeSymbolDeclaration =>
        Boolean(declaration && (declaration.name === name || declaration.qualifiedName === name)),
      );
  }

  #lookup(name: string): EngineeringCodeSymbolDeclaration[] {
    return (this.#symbolTable.declarationsByName.get(name) ?? [])
      .map((fqn) => this.#symbolTable.declarations.get(fqn))
      .filter((declaration): declaration is EngineeringCodeSymbolDeclaration =>
        Boolean(declaration),
      );
  }

  #filterInstantiated(
    declarations: readonly EngineeringCodeSymbolDeclaration[],
  ): EngineeringCodeSymbolDeclaration[] {
    if (this.#symbolTable.instantiatedClasses.size === 0) {
      return [];
    }
    return declarations.filter(
      (declaration) =>
        !declaration.className || this.#symbolTable.instantiatedClasses.has(declaration.className),
    );
  }

  #makeEdge(
    caller: string,
    target: EngineeringCodeSymbolDeclaration,
    tier: EngineeringCodeAnalysisTier,
    callSite: EngineeringCodeNormalizedCallSite,
    callerFile: string,
    confidence: number,
  ): EngineeringCodeResolvedCallEdge {
    return {
      caller,
      callee: target.fqn,
      callType: callSite.callType,
      resolveMethod: tier,
      line: callSite.line,
      filePath: callerFile,
      isAwait: callSite.isAwait,
      argCount: callSite.argCount,
      sourceFilePath: callerFile,
      targetFilePath: target.filePath,
      confidence: Math.min(confidence, callSite.confidence),
      tier,
      targetSymbolKind: target.kind,
    };
  }

  #makeUnresolvedEdge(
    caller: string,
    callSite: EngineeringCodeNormalizedCallSite,
    callerFile: string,
    reason: string,
  ): EngineeringCodeResolvedCallEdge {
    return {
      caller,
      callee: `${callSite.receiver ? `${callSite.receiver}.` : ""}${callSite.callee}`,
      callType: callSite.callType,
      resolveMethod: "unresolved",
      line: callSite.line,
      filePath: callerFile,
      isAwait: callSite.isAwait,
      argCount: callSite.argCount,
      sourceFilePath: callerFile,
      targetFilePath: null,
      confidence: 0.15,
      tier: "unresolved",
      targetSymbolKind: "unknown",
      unresolvedReason: reason,
    };
  }
}

interface ImportBinding {
  readonly importRecord: EngineeringCodeImportRecord;
  readonly resolvedPath: string | null;
  readonly namespace: boolean;
}

export default CallEdgeResolver;
