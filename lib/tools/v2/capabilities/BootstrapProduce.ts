/**
 * 冷启动.生产 — Agent 将分析结果转化为知识候选。
 */

import { CapabilityV2 } from './CapabilityV2.js';

export class BootstrapProduce extends CapabilityV2 {
  get name() {
    return 'knowledge_production';
  }
  get description() {
    return 'Knowledge production: submit, validate, review candidates';
  }

  get allowedTools() {
    return {
      code: ['read'],
      knowledge: ['submit'],
      memory: ['recall'],
      meta: ['review'],
    };
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名)
2. 项目特写风格的正文 (content.markdown ≥200字)
3. 设计原理说明 (content.rationale)
4. 正确的 kind (rule / pattern / fact)
5. 完整的 Cursor 交付字段 (trigger, whenClause, doClause)

工作流:
1. memory.recall 获取分析阶段的发现
2. code.read 获取需要的代码片段
3. knowledge.submit 逐个提交知识候选 (内含自动查重)
4. meta.review 最后做轻量自检

关键规则:
- 不使用终端工具
- 不做新的代码探索
- 每个独立模式/发现单独提交

${super.promptFragment}`;
  }
}
