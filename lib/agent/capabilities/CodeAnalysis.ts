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
| 全局扫描 | get_project_overview + list_project_structure + 既有 panorama 上下文 |
| 结构化探索 | query_code_graph / query_call_graph / search_project_code 批量搜索 |
| 深度验证 | read_project_file / analyze_code 阅读关键实现 |
| 输出总结 | 停止工具调用，输出分析 |

关键规则:
- 批量搜索: search_project_code({ patterns: [...] })
- 批量读文件: read_project_file({ filePaths: [...] })
- 不要重复搜索相同关键词
- 调用关系优先用 query_call_graph，不要用文本搜索猜测调用链
- 输出时包含具体文件路径和代码位置`;
  }

  get tools() {
    return [
      'get_project_overview',
      'get_class_hierarchy',
      'get_class_info',
      'get_protocol_info',
      'get_method_overrides',
      'get_category_map',
      'search_project_code',
      'read_project_file',
      'list_project_structure',
      'get_file_summary',
      'semantic_search_code',
      'query_code_graph',
      'query_call_graph',
      'get_previous_analysis',
      'note_finding',
      'get_previous_evidence',
      'analyze_code',
    ];
  }
}
