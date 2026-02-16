import { jest } from '@jest/globals';

/* ────────────────────────────────────────────
 *  动态导入
 * ──────────────────────────────────────────── */
let ALL_TOOLS;

beforeAll(async () => {
  const toolsMod = await import('../../lib/service/chat/tools.js');
  ALL_TOOLS = toolsMod.ALL_TOOLS || toolsMod.default;
});

/* ────────────────────────────────────────────
 *  Helpers
 * ──────────────────────────────────────────── */
function findTool(name) {
  return ALL_TOOLS.find(t => t.name === name);
}

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
}

/* ────────────────────────────────────────────
 *  Tests: plan_task 工具
 * ──────────────────────────────────────────── */
describe('plan_task tool', () => {
  it('should exist in ALL_TOOLS', () => {
    const tool = findTool('plan_task');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('plan_task');
  });

  it('should require steps and strategy parameters', () => {
    const tool = findTool('plan_task');
    expect(tool.parameters.required).toEqual(['steps', 'strategy']);
  });

  it('should record plan and return confirmation', async () => {
    const tool = findTool('plan_task');
    const result = await tool.handler({
      steps: [
        { id: 1, action: '审视6条信号', tool: 'search_project_code' },
        { id: 2, action: '提交候选', tool: 'submit_knowledge', depends_on: [1] },
      ],
      strategy: '先搜索补充示例再批量提交',
      estimated_iterations: 4,
    }, { logger: makeLogger() });

    expect(result.status).toBe('plan_recorded');
    expect(result.stepCount).toBe(2);
    expect(result.message).toContain('2 步');
    expect(result.message).toContain('4 轮迭代');
  });

  it('should handle missing estimated_iterations gracefully', async () => {
    const tool = findTool('plan_task');
    const result = await tool.handler({
      steps: [{ id: 1, action: '分析' }],
      strategy: '简单分析',
    }, { logger: makeLogger() });

    expect(result.stepCount).toBe(1);
  });
});

/* ────────────────────────────────────────────
 *  Tests: review_my_output 工具
 * ──────────────────────────────────────────── */
describe('review_my_output tool', () => {
  it('should exist in ALL_TOOLS', () => {
    const tool = findTool('review_my_output');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('review_my_output');
  });

  it('should return no_candidates when no submissions', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, { _sessionToolCalls: [] });

    expect(result.status).toBe('no_candidates');
  });

  it('should pass well-formed candidates', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, {
      _sessionToolCalls: [{
        tool: 'submit_knowledge',
        params: {
          title: '[Bootstrap] code-pattern/singleton — 项目特写',
          summary: 'BiliDemo 12个Manager类使用单例, dispatch_once 占 67%, 8个文件',
          code: `# 单例模式 — 项目特写
> 本项目 12 个管理类使用单例, dispatch_once 占 67%

本项目使用 dispatch_once 单例，12 个管理类均采用此模式。标准写法：

\`\`\`objectivec
// (NetworkManager.m:42)
+ (instancetype)shared { static id inst; dispatch_once... }
\`\`\`

入口方法统一命名 sharedInstance，不用 shared 或 defaultManager。
典型使用者包括 NetworkManager、CacheService、ConfigStore。
新代码必须使用 dispatch_once 写法。`,
        },
      }],
    });

    expect(result.status).toBe('all_passed');
    expect(result.checkedCount).toBe(1);
  });

  it('should detect missing 项目特写 suffix', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, {
      _sessionToolCalls: [{
        tool: 'submit_knowledge',
        params: {
          title: '[Bootstrap] code-pattern/singleton',
          summary: 'BiliDemo 12个Manager类使用 dispatch_once',
          code: `# 单例模式\n## 项目约定\n...\n## 生成指南\n你在本项目中...必须...`,
        },
      }],
    });

    expect(result.status).toBe('issues_found');
    expect(result.message).toContain('项目特写');
  });

  it('should detect missing sections', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, {
      _sessionToolCalls: [{
        tool: 'submit_knowledge',
        params: {
          title: '[Bootstrap] code-pattern/singleton — 项目特写',
          summary: 'BiliDemo 用了单例模式',
          code: '# 单例模式 — 项目特写\n一些内容但缺少代码...',
        },
      }],
    });

    expect(result.status).toBe('issues_found');
    expect(result.failedCount).toBe(1);
    // Should detect missing code block and short prose
    expect(result.message).toContain('代码');
  });

  it('should detect summary with vague wording', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, {
      _sessionToolCalls: [{
        tool: 'submit_knowledge',
        params: {
          title: '[Bootstrap] code-pattern/singleton — 项目特写',
          summary: '该项目使用了单例模式来管理全局状态',
          code: `# 单例 — 项目特写\n本项目使用 dispatch_once 单例，统一命名 sharedInstance。\n\n\`\`\`objectivec\n// (Manager.m:10)\n+ (instancetype)sharedInstance { ... }\n\`\`\``,
        },
      }],
    });

    expect(result.status).toBe('issues_found');
    expect(result.message).toContain('泛化措辞');
  });

  it('should handle submit_with_check tool calls too', async () => {
    const tool = findTool('review_my_output');
    const result = await tool.handler({}, {
      _sessionToolCalls: [{
        tool: 'submit_with_check',
        params: {
          title: '[Bootstrap] best-practice/weakSelf — 项目特写',
          summary: 'BiliDemo 28个Block使用weakSelf，覆盖 View/Service/Network 三层',
          code: `# weakSelf — 项目特写\n本项目 28 个 Block 使用 weakSelf，覆盖 View/Service/Network 三层。具体约定 (HomeViewController.m:88)\n\n\`\`\`objectivec\n// (HomeViewController.m:88)\ncode\n\`\`\`\n新代码必须使用 weakSelf 写法。`,
        },
      }],
    });

    expect(result.checkedCount).toBe(1);
  });
});

/* ────────────────────────────────────────────
 *  Tests: ALL_TOOLS 完整性
 * ──────────────────────────────────────────── */
describe('tools registry completeness', () => {
  it('should have 54 tools', () => {
    expect(ALL_TOOLS.length).toBe(54);
  });

  it('should include all three new meta tools', () => {
    const names = ALL_TOOLS.map(t => t.name);
    expect(names).toContain('get_tool_details');
    expect(names).toContain('plan_task');
    expect(names).toContain('review_my_output');
  });

  it('all tools should have name, description, parameters, handler', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});
