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
2. code 批量获取代码片段 (如需)
3. check_duplicate 检查重复风险
4. validate_candidate 做提交前字段校验
5. knowledge 优先提交
6. review_my_output / quality_score 做轻量自检

关键规则:
- 不使用终端工具
- 不做新的代码探索
- 不执行发布、废弃、更新等知识生命周期操作`;
  }

  get tools() {
    return [
      'code',
      'knowledge',
      'check_duplicate',
      'validate_candidate',
      'review_my_output',
      'quality_score',
    ];
  }
}
