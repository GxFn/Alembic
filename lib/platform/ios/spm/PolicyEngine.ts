/**
 * PolicyEngine — SPM 依赖策略引擎
 * 检查循环依赖、反向依赖 (违反分层架构原则)、方针约束
 */

import type { DependencyGraph } from './DependencyGraph.js';

/** 策略检查配置 */
interface PolicyConfig {
  layerOrder?: string[];
}

/** 策略违规记录 */
interface PolicyViolation {
  type: string;
  severity: string;
  message: string;
  nodes?: string[];
  from?: string;
  to?: string;
  fromLayer?: number;
  toLayer?: number;
}

export class PolicyEngine {
  /**
   * 全面策略检查
   * @param {import('./DependencyGraph.js').DependencyGraph} graph
   * @param {{ layerOrder?: string[] }} config - layerOrder 定义分层顺序，低层不应依赖高层
   * @returns {{ passed: boolean, violations: object[] }}
   */
  check(graph: DependencyGraph, config: PolicyConfig = {}) {
    const violations: PolicyViolation[] = [];

    // 1. 检查循环依赖
    const cycles = graph.detectCycles();
    for (const cycle of cycles) {
      violations.push({
        type: 'circular-dependency',
        severity: 'error',
        message: `循环依赖: ${cycle.join(' → ')}`,
        nodes: cycle,
      });
    }

    // 2. 检查反向依赖 (低层依赖高层)
    if (config.layerOrder && config.layerOrder.length > 0) {
      const layerIndex = new Map<string, number>();
      config.layerOrder.forEach((layer: string, idx: number) => {
        layerIndex.set(layer, idx);
      });

      for (const node of graph.getNodes()) {
        const nodeLayer = this.#findLayer(node, layerIndex);
        if (nodeLayer === -1) {
          continue;
        }

        for (const dep of graph.getDependencies(node)) {
          const depLayer = this.#findLayer(dep, layerIndex);
          if (depLayer === -1) {
            continue;
          }

          if (depLayer > nodeLayer) {
            violations.push({
              type: 'downward-dependency',
              severity: 'warning',
              message: `反向依赖: ${node} (L${nodeLayer}) → ${dep} (L${depLayer})，违反分层原则`,
              from: node,
              to: dep,
              fromLayer: nodeLayer,
              toLayer: depLayer,
            });
          }
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }

  /**
   * 单独检查能否添加新依赖
   * @param {import('./DependencyGraph.js').DependencyGraph} graph
   * @param {string} from
   * @param {string} to
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canAddDependency(graph: DependencyGraph, from: string, to: string) {
    // 检查是否会导致循环
    if (graph.isReachable(to, from)) {
      return { allowed: false, reason: `添加 ${from} → ${to} 会导致循环依赖` };
    }
    return { allowed: true };
  }

  // ─── 私有 ─────────────────────────────────────────────

  #findLayer(nodeName: string, layerIndex: Map<string, number>) {
    // 尝试精确匹配或前缀匹配
    for (const [layer, idx] of layerIndex) {
      if (nodeName === layer || nodeName.startsWith(layer)) {
        return idx;
      }
    }
    return -1;
  }
}
