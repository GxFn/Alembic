import { Capability } from './Capability.js';

export class ScanProduction extends Capability {
  get name() {
    return 'scan_production';
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名，不以项目名开头)
2. 项目特写风格的正文 (content.markdown ≥200字)
3. 设计原理说明 (content.rationale)
4. 相关文件路径 (reasoning.sources)
5. 正确的 kind (rule / pattern / fact)
6. 完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)

工作流:
1. 识别分析中的知识点
2. read_project_file 获取代码片段 (如需)
3. collect_scan_recipe 逐个提交每个知识点
4. 每个独立模式/发现单独提交 — 不要合并`;
  }

  get tools() {
    return ['knowledge', 'code'];
  }
}
