/**
 * @module DataFlowInferrer
 * @description Phase 5: 从调用边推断数据流边 (L0 + L1 粒度)
 *
 * 数据流粒度:
 *   - L0: 模块级 — A 文件 import B 文件 → 数据可能从 B 流向 A
 *   - L1: 函数级 — A.foo() 调用 B.bar(x) → x 从 A 流向 B
 *
 * Phase 5.0 只实现 L0 + L1，L2/L3 (参数级/语句级) 留待 Phase 5.2。
 */

/**
 * @typedef {object} DataFlowEdge
 * @property {string} from 源 FQN
 * @property {string} to 目标 FQN
 * @property {'argument'|'return-value'} flowType
 * @property {'forward'|'backward'} direction
 */

export class DataFlowInferrer {
  /**
   * 从已解析的调用边推断数据流边
   *
   * @param {import('./CallEdgeResolver.js').ResolvedEdge[]} resolvedEdges
   * @returns {DataFlowEdge[]}
   */
  static infer(resolvedEdges) {
    /** @type {DataFlowEdge[]} */
    const dataFlowEdges: any[] = [];

    for (const edge of resolvedEdges) {
      // 仅当调用有参数时生成正向数据流 (参数从 caller 流向 callee)
      if ((edge.argCount || 0) > 0) {
        dataFlowEdges.push({
          from: edge.caller,
          to: edge.callee,
          flowType: 'argument',
          direction: 'forward',
        });
      }

      // 每个调用边还隐含一条反向数据流 (返回值从 callee 流向 caller)
      // Phase 5.0 无法判断是否 void，保守生成但标记低置信度
      dataFlowEdges.push({
        from: edge.callee,
        to: edge.caller,
        flowType: 'return-value',
        direction: 'backward',
        confidence: 0.3,
      });
    }

    return dataFlowEdges;
  }
}

export default DataFlowInferrer;
