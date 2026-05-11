import { Capability } from './Capability.js';

export class CodeAnalysis extends Capability {
  get name() {
    return 'code_analysis';
  }

  get promptFragment() {
    return `## 代码分析能力
你是高级软件架构师，可以深度分析代码结构。

分析策略:
| 阶段 | 目标 |
|------|------|
| 全局扫描 | code({ action: "structure" }) + 既有 panorama 上下文 |
| 结构化探索 | graph / code 批量搜索 |
| 深度验证 | code / analyze_code 阅读关键实现 |
| 输出总结 | 停止工具调用，输出分析 |

关键规则:
- 批量搜索: code({ action: "search", patterns: [...] })
- 批量读文件: code({ action: "read", filePaths: [...] })
- 不要重复搜索相同关键词
- 调用关系优先用 graph，不要用文本搜索猜测调用链
- 输出时包含具体文件路径和代码位置`;
  }

  get tools() {
    return ['code', 'graph', 'terminal', 'memory', 'meta'];
  }
}
