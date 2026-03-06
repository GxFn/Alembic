/**
 * @module ImportRecord
 * @description 增强的 Import 记录 - 对外表现类似 string，内部携带结构化元信息。
 *
 * Phase 5: 跨文件调用链分析的基础数据结构。
 *
 * 兼容性保证:
 *   - imp.includes('express')     ✅  (includes 方法代理到 path)
 *   - `${imp}`                     ✅  (toString 返回 path)
 *   - imp.startsWith('./')         ✅  (同上代理)
 *   - JSON.stringify(imp)          ✅  (toJSON 返回 path)
 *   - typeof imp === 'object'      ⚠️  不再是 'string'
 *
 * @example
 *   const rec = new ImportRecord('./UserRepo', { symbols: ['UserRepo'], kind: 'named' });
 *   rec.includes('User');   // true
 *   `${rec}`;               // './UserRepo'
 *   rec.symbols;            // ['UserRepo']
 */

export class ImportRecord {
  /**
   * @param {string} path 导入路径原始字符串
   * @param {object} [meta]
   * @param {string[]} [meta.symbols] 导入的符号名 e.g. ['UserRepo', 'findById'] 或 ['*']
   * @param {string|null} [meta.alias] 导入别名 e.g. import { UserRepo as Repo }
   * @param {'named'|'default'|'namespace'|'side-effect'} [meta.kind] 导入方式
   * @param {boolean} [meta.isTypeOnly] 是否为类型导入 (TypeScript)
   */
  constructor(path, meta = {}) {
    this.path = String(path);
    this.symbols = meta.symbols || [];
    this.alias = meta.alias || null;
    this.kind = meta.kind || 'side-effect';
    this.isTypeOnly = meta.isTypeOnly || false;
  }

  // ── String 兼容性方法 ──

  toString() {
    return this.path;
  }

  includes(s) {
    return this.path.includes(s);
  }

  startsWith(s) {
    return this.path.startsWith(s);
  }

  endsWith(s) {
    return this.path.endsWith(s);
  }

  indexOf(s) {
    return this.path.indexOf(s);
  }

  replace(a, b) {
    return this.path.replace(a, b);
  }

  match(re) {
    return this.path.match(re);
  }

  split(sep) {
    return this.path.split(sep);
  }

  trim() {
    return this.path.trim();
  }

  toJSON() {
    return this.path;
  }

  get length() {
    return this.path.length;
  }

  valueOf() {
    return this.path;
  }

  // ── Phase 5 结构化访问 ──

  /** 是否具有结构化符号信息 */
  get isStructured() {
    return this.symbols.length > 0;
  }

  /**
   * 检查是否导入了指定符号名
   * @param {string} symbolName
   * @returns {boolean}
   */
  hasSymbol(symbolName) {
    return this.symbols.includes(symbolName) || this.symbols.includes('*');
  }
}

export default ImportRecord;
