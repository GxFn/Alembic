/**
 * @module CallEdgeResolver
 * @description Phase 5: 将调用点 (CallSite) 解析为调用边 (ResolvedEdge)
 *
 * 解析优先级 (4-priority system):
 *   1. this.xxx() — 同类方法调用
 *   2. ImportedType.method() / importedFunc() — import-based 解析
 *   3. localFunc() — 同文件内函数调用
 *   4. globalSearch(name) — 全局唯一匹配 (fallback, 低置信度)
 *
 * 数据流:
 *   SymbolTable + ImportPathResolver + CallSite[] → ResolvedEdge[]
 */

import type { ImportPathResolver } from './ImportPathResolver.js';

export interface ResolvedEdge {
  caller: string;
  callee: string;
  callType: string;
  resolveMethod: string;
  line: number;
  file: string;
  isAwait: boolean;
  argCount: number;
}

interface SymbolDeclaration {
  name: string;
  className?: string;
  kind?: string;
  file: string;
  [key: string]: unknown;
}

interface SymbolTable {
  declarations: Map<string, SymbolDeclaration>;
  fileImports: Map<
    string,
    Array<{ path?: string; symbols?: string[]; alias?: string; toString(): string }>
  >;
  instantiatedClasses?: Set<string>;
  propertyTypes?: Map<string, Map<string, string>>;
}

interface CallSite {
  callee: string;
  callerMethod: string;
  callerClass: string | null;
  callType: string;
  receiver: string | null;
  receiverType: string | null;
  argCount: number;
  line: number;
  isAwait: boolean;
}

interface InheritanceEdge {
  from: string;
  to: string;
  type: string;
}

interface FileDecl {
  name: string;
  qualifiedName: string;
  fqn: string;
}

export class CallEdgeResolver {
  classNames: Set<string>;
  fileIndex: Map<string, FileDecl[]>;
  importResolver: ImportPathResolver;
  inheritanceGraph: InheritanceEdge[];
  instantiatedClasses: Set<string>;
  nameIndex: Map<string, string[]>;
  propertyTypes: Map<string, Map<string, string>>;
  symbolTable: SymbolTable;
  /**
   * @param [inheritanceGraph=[]] 继承图边
   */
  constructor(
    symbolTable: SymbolTable,
    importResolver: ImportPathResolver,
    inheritanceGraph: InheritanceEdge[] = []
  ) {
    this.symbolTable = symbolTable;
    this.importResolver = importResolver;
    this.inheritanceGraph = inheritanceGraph;

    // Phase 5.3: RTA — set of classes that are actually instantiated in the program
    this.instantiatedClasses = symbolTable.instantiatedClasses || new Set();
    // Phase 5.3: DI — property type annotations: className → (fieldName → typeName)
    this.propertyTypes = symbolTable.propertyTypes || new Map();

    // 构建反向索引: symbolName → [fqn1, fqn2, ...]
    this.nameIndex = new Map();
    // 构建文件级索引: file → [{ name, qualifiedName, fqn }] (Issue #14 性能优化)
    /** >>} */
    this.fileIndex = new Map();

    // Phase 5.3: 类名集合索引 (用于 _inferFieldType 优化，避免全表扫描)
    this.classNames = new Set();

    for (const [fqn, decl] of symbolTable.declarations) {
      const names = [decl.name];
      const qualifiedName = decl.className ? `${decl.className}.${decl.name}` : decl.name;
      if (decl.className) {
        names.push(qualifiedName);
      }
      for (const name of names) {
        if (!this.nameIndex.has(name)) {
          this.nameIndex.set(name, []);
        }
        this.nameIndex.get(name)?.push(fqn);
      }
      // 文件级索引
      if (!this.fileIndex.has(decl.file)) {
        this.fileIndex.set(decl.file, []);
      }
      this.fileIndex.get(decl.file)?.push({ name: decl.name, qualifiedName, fqn });

      // Phase 5.3: 收集类名用于快速 DI 推断
      if (decl.kind === 'class') {
        this.classNames.add(decl.name);
      }
    }
  }

  /**
   * 解析一个文件中的所有调用点为边
   *
   * @param callSites 来自某个文件的所有调用点
   * @param callerFile 调用者文件路径 (相对)
   */
  resolveFile(callSites: CallSite[], callerFile: string): ResolvedEdge[] {
    const edges: ResolvedEdge[] = [];
    const fileImports = this.symbolTable.fileImports.get(callerFile) || [];

    // 构建局部 import 映射: symbolName → { file, namespace }
    const importedSymbols = this._buildImportMap(fileImports, callerFile);

    // 去重集合: "caller→callee@line" 防止同一调用点产生重复边
    const seen = new Set();

    for (const cs of callSites) {
      const resolved = this._resolveCallSite(cs, callerFile, importedSymbols);
      if (resolved) {
        const key = `${resolved.caller}→${resolved.callee}@${resolved.line}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(resolved);
        }
      }
    }

    return edges;
  }

  /** 构建局部 import 映射 */
  _buildImportMap(
    fileImports: Array<{ path?: string; symbols?: string[]; alias?: string; toString(): string }>,
    callerFile: string
  ): Map<string, { file: string; namespace: boolean }> {
    /** >} */
    const importedSymbols = new Map();

    for (const imp of fileImports) {
      const targetFile = this.importResolver.resolve(imp.path || String(imp), callerFile);
      if (!targetFile) {
        continue; // 外部依赖, 跳过
      }

      if (imp.symbols && imp.symbols.length > 0) {
        for (const sym of imp.symbols) {
          if (sym === '*' && imp.alias) {
            importedSymbols.set(imp.alias, { file: targetFile, namespace: true });
          } else if (sym !== '*') {
            // named/default: symbols 已包含本地名 (alias baked-in), 直接使用
            importedSymbols.set(sym, { file: targetFile, namespace: false });
          }
        }
      } else {
        // 无结构化信息时，使用路径最后一段作为 namespace hint
        const pathParts = String(imp).split('/');
        const lastPart = pathParts[pathParts.length - 1]?.replace(/\.\w+$/, '');
        if (lastPart) {
          importedSymbols.set(lastPart, { file: targetFile, namespace: true });
        }
      }
    }

    return importedSymbols;
  }

  /** 解析单个调用点 */
  _resolveCallSite(
    cs: CallSite,
    callerFile: string,
    importedSymbols: Map<string, { file: string; namespace: boolean }>
  ): ResolvedEdge | null {
    const callerFqn = `${callerFile}::${cs.callerClass ? `${cs.callerClass}.` : ''}${cs.callerMethod}`;

    // Priority 0: super.xxx() — 父类方法调用 (CHA 解析，禁止 fallthrough 防止自引用边)
    if (cs.callType === 'super' || cs.receiver === 'super' || cs.receiver === 'super()') {
      if (cs.callerClass && cs.callee && cs.callee !== 'super') {
        const chaResult = this._resolveByCHA(cs.callee, cs.callerClass);
        if (chaResult) {
          return this._makeEdge(callerFqn, chaResult, 'cha', cs, callerFile);
        }
      }
      // CHA 无法解析时不 fallthrough (避免 local search 匹配到自己产生 self-edge)
      return null;
    }

    // Priority 1: this.xxx() / self.xxx() — 同类方法调用
    if (cs.receiver === 'this' || cs.receiver === 'self') {
      if (cs.callerClass) {
        const candidates = this._findInFile(`${cs.callerClass}.${cs.callee}`, callerFile);
        if (candidates.length > 0) {
          return this._makeEdge(callerFqn, candidates[0], 'direct', cs, callerFile);
        }
        // CHA fallback: 在继承链上查找方法
        const chaResult = this._resolveByCHA(cs.callee, cs.callerClass);
        if (chaResult) {
          return this._makeEdge(callerFqn, chaResult, 'cha', cs, callerFile);
        }
      }
    }

    // Priority 1.5: this.field.method() — DI 注入字段方法调用
    if (cs.receiver && (cs.receiver.startsWith('this.') || cs.receiver.startsWith('self.'))) {
      const fieldName = cs.receiver.split('.').slice(1).join('.');

      // Phase 5.3: First try explicit type annotation from property declarations (DI-aware)
      if (cs.callerClass) {
        const classProps = this.propertyTypes.get(cs.callerClass);
        if (classProps) {
          const fieldType = classProps.get(fieldName);
          if (fieldType) {
            const typeCandidates = this.nameIndex.get(`${fieldType}.${cs.callee}`) || [];
            if (typeCandidates.length > 0) {
              return this._makeEdge(callerFqn, typeCandidates[0], 'direct', cs, callerFile);
            }
          }
        }
      }

      // 尝试从 receiverType 解析 (可能 extractCallSites 已推断)
      if (cs.receiverType) {
        const typeCandidates = this.nameIndex.get(`${cs.receiverType}.${cs.callee}`) || [];
        if (typeCandidates.length > 0) {
          return this._makeEdge(callerFqn, typeCandidates[0], 'direct', cs, callerFile);
        }
      }
      // 尝试通过命名约定推断: userRepo → UserRepo, userService → UserService
      const inferredType = this._inferFieldType(fieldName);
      if (inferredType) {
        const typeCandidates = this.nameIndex.get(`${inferredType}.${cs.callee}`) || [];
        if (typeCandidates.length > 0) {
          return this._makeEdge(callerFqn, typeCandidates[0], 'inferred', cs, callerFile);
        }
      }
    }

    // Priority 2: Import-based 解析
    const importInfo = importedSymbols.get(cs.receiver || cs.callee);
    if (importInfo) {
      const targetFile = importInfo.file;

      if (importInfo.namespace && cs.receiver) {
        // namespace import: M.foo() → 在 targetFile 中查找 foo
        const candidates = this._findInFile(cs.callee, targetFile);
        if (candidates.length > 0) {
          return this._makeEdge(callerFqn, candidates[0], 'direct', cs, callerFile);
        }
      } else {
        // named import: 查找 import 的符号
        const lookupName = cs.receiver ? `${cs.receiver}.${cs.callee}` : cs.callee;
        let candidates = this._findInFile(lookupName, targetFile);
        if (candidates.length === 0 && cs.receiver) {
          // 可能 import 的是类名，方法是类的方法
          candidates = this._findInFile(`${cs.receiver}.${cs.callee}`, targetFile);
        }
        if (candidates.length === 0 && !cs.receiver) {
          // 可能是函数名
          candidates = this._findInFile(cs.callee, targetFile);
        }
        if (candidates.length > 0) {
          return this._makeEdge(callerFqn, candidates[0], 'direct', cs, callerFile);
        }
      }
    }

    // Priority 2.5: Implicit this — OOP 语言中 bare method() 即 this.method()
    // 在 Dart/Java/Kotlin/Swift 等语言中, 类内调用 method() 等价于 this.method()
    // 先查同类方法, 再 CHA 查父类方法
    if (!cs.receiver && cs.callerClass && cs.callType !== 'constructor') {
      // 2.5a: 同类方法 (精确匹配 Class.method)
      const implicitThisCandidates = this._findInFile(
        `${cs.callerClass}.${cs.callee}`,
        callerFile
      ).filter((fqn: string) => fqn !== callerFqn);
      if (implicitThisCandidates.length > 0) {
        return this._makeEdge(callerFqn, implicitThisCandidates[0], 'direct', cs, callerFile);
      }
      // 2.5b: CHA 查父类 (继承链上的方法)
      const chaImplicit = this._resolveByCHA(cs.callee, cs.callerClass);
      if (chaImplicit) {
        return this._makeEdge(callerFqn, chaImplicit, 'cha', cs, callerFile);
      }
    }

    // Priority 3: 同文件内的函数调用
    // 过滤 callerFqn 防止同名方法重载(overload)产生假自引用边
    const localCandidates = this._findInFile(cs.callee, callerFile).filter(
      (fqn: string) => fqn !== callerFqn
    );
    if (localCandidates.length > 0) {
      return this._makeEdge(callerFqn, localCandidates[0], 'direct', cs, callerFile);
    }
    // 也尝试 Class.method 格式
    if (cs.receiver && !importedSymbols.has(cs.receiver)) {
      const qualifiedLocal = this._findInFile(`${cs.receiver}.${cs.callee}`, callerFile).filter(
        (fqn: string) => fqn !== callerFqn
      );
      if (qualifiedLocal.length > 0) {
        return this._makeEdge(callerFqn, qualifiedLocal[0], 'direct', cs, callerFile);
      }
    }

    // Priority 4: 全局搜索 (唯一匹配才采用)
    // 过滤 callerFqn 防止全局唯一命名碰撞自己
    const globalCandidates = (this.nameIndex.get(cs.callee) || []).filter(
      (fqn: string) => fqn !== callerFqn
    );
    if (globalCandidates.length === 1) {
      return this._makeEdge(callerFqn, globalCandidates[0], 'inferred', cs, callerFile);
    }

    // Phase 5.3 RTA: 多个全局候选 → 用实例化集合过滤
    if (globalCandidates.length > 1 && this.instantiatedClasses.size > 0) {
      const rtaFiltered = globalCandidates.filter((fqn: string) => {
        if (fqn === callerFqn) {
          return false; // 排除自己
        }
        const decl = this.symbolTable.declarations.get(fqn);
        if (!decl) {
          return false;
        }
        // 非类方法 (顶层函数) 不做 RTA 过滤
        if (!decl.className) {
          return true;
        }
        // 类方法 → 仅保留实际实例化的类
        return this.instantiatedClasses.has(decl.className);
      });
      if (rtaFiltered.length === 1) {
        return this._makeEdge(callerFqn, rtaFiltered[0], 'rta', cs, callerFile);
      }
    }

    // 无法解析 → 不创建边 (宁缺勿滥)
    return null;
  }

  /**
   * CHA (Class Hierarchy Analysis): 沿继承链向上搜索方法
   *
   * 使用 BFS 遍历 inheritanceGraph，从 className 向上搜索直到找到
   * 定义了 methodName 的祖先类。只跟踪 'inherits' 类型的边。
   *
   * @param methodName 被调用的方法名
   * @param className 起始类名
   * @returns 找到的 FQN 或 null
   */
  _resolveByCHA(methodName: string, className: string): string | null {
    if (!this.inheritanceGraph || this.inheritanceGraph.length === 0) {
      return null;
    }

    // BFS 向上遍历继承链 (最多 10 层防止循环)
    const visited = new Set([className]);
    const queue = [className];
    const MAX_DEPTH = 10;
    let depth = 0;

    while (queue.length > 0 && depth < MAX_DEPTH) {
      depth++;
      const nextQueue: string[] = [];
      for (const current of queue) {
        // 查找 current 的所有父类 (inherits 和 conforms 类型的边)
        for (const edge of this.inheritanceGraph) {
          if (edge.from === current && !visited.has(edge.to)) {
            visited.add(edge.to);

            // 在全局符号表中查找 ParentClass.methodName
            const qualifiedName = `${edge.to}.${methodName}`;
            const candidates = this.nameIndex.get(qualifiedName) || [];
            if (candidates.length > 0) {
              return candidates[0];
            }

            nextQueue.push(edge.to);
          }
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
    }

    return null;
  }

  /**
   * 从字段名推断类型（DI/IoC 命名约定推断）
   *
   * 常见模式:
   *   - userRepo → UserRepo
   *   - userRepository → UserRepository
   *   - userService → UserService
   *   - _userRepo → UserRepo (Java/Kotlin private field)
   *
   * 只在符号表中存在匹配类时返回
   */
  _inferFieldType(fieldName: string): string | null {
    // 去除前导下划线
    const cleaned = fieldName.replace(/^_+/, '');
    if (!cleaned) {
      return null;
    }

    // camelCase → PascalCase
    const pascalCase = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

    // Phase 5.3: 使用 classNames Set 快速查找 (O(1) 替代 O(n) 全表扫描)
    return this.classNames.has(pascalCase) ? pascalCase : null;
  }

  /**
   * 在指定文件中查找声明 (使用 fileIndex 优化，避免全表扫描)
   * @param name 符号名 (可以是 "ClassName.methodName" 或 "functionName")
   * @returns 匹配的 FQN 列表
   */
  _findInFile(name: string, file: string): string[] {
    const fileDecls = this.fileIndex.get(file);
    if (!fileDecls) {
      return [];
    }
    return fileDecls
      .filter((d: FileDecl) => d.name === name || d.qualifiedName === name)
      .map((d: FileDecl) => d.fqn);
  }

  /** 构建 ResolvedEdge */
  _makeEdge(
    callerFqn: string,
    calleeFqn: string,
    resolveMethod: string,
    cs: CallSite,
    callerFile: string
  ): ResolvedEdge {
    return {
      caller: callerFqn,
      callee: calleeFqn,
      callType: cs.callType,
      resolveMethod,
      line: cs.line,
      file: callerFile,
      isAwait: cs.isAwait,
      argCount: cs.argCount || 0,
    };
  }
}

export default CallEdgeResolver;
