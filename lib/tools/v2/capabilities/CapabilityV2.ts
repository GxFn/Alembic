/**
 * @module tools/v2/capabilities/CapabilityV2
 *
 * V2 Capability 基类 — 直接继承 V1 Capability，声明式定义场景级工具集。
 * 每个 Capability 声明 allowedTools (tool → action[])，
 * promptFragment 从注册表自动生成。
 */

import { Capability } from '#agent/capabilities/Capability.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { CapabilityV2Def } from '../types.js';

export abstract class CapabilityV2 extends Capability {
  abstract get description(): string;
  abstract get allowedTools(): Record<string, string[]>;

  get tools(): string[] {
    return Object.keys(this.allowedTools);
  }

  get promptFragment(): string {
    return generatePromptFragment(this.allowedTools);
  }

  toDef(): CapabilityV2Def {
    return {
      name: this.name,
      description: this.description,
      promptFragment: this.promptFragment,
      allowedTools: this.allowedTools,
    };
  }
}

function generatePromptFragment(allowedTools: Record<string, string[]>): string {
  const lines: string[] = ['## Available Tools'];

  for (const [tool, actions] of Object.entries(allowedTools)) {
    const spec = TOOL_REGISTRY[tool];
    if (!spec) {
      continue;
    }

    const actionDescriptions = actions
      .map((a) => {
        const action = spec.actions[a];
        return action ? `${a}(${action.summary})` : a;
      })
      .join(', ');

    lines.push(`- **${tool}**: ${actionDescriptions}`);
  }

  return lines.join('\n');
}
