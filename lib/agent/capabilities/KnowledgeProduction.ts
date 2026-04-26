import { Capability } from './Capability.js';

export class KnowledgeProduction extends Capability {
  get name() {
    return 'knowledge_production';
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名，不以项目名开头)
2. 项目特写风格的正文 (content.markdown)
3. 相关文件路径
4. 正确的 kind (rule / pattern / fact)
5. 完整的 Cursor 交付字段

工作流:
1. 识别分析中的知识点
2. read_project_file 批量获取代码片段 (如需)
3. submit_knowledge 或 submit_with_check 提交
4. 提交优先于完美 — 文件读取失败时用已有信息直接提交`;
  }

  get tools() {
    return ['submit_knowledge', 'submit_with_check', 'read_project_file'];
  }
}
