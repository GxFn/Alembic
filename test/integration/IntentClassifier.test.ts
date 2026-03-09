/**
 * 集成测试：IntentClassifier — 自然语言意图分类
 *
 * 覆盖范围:
 *   - 系统操作规则匹配 (SYSTEM)
 *   - IDE 编程强信号匹配 (IDE_AGENT)
 *   - Bot 知识管理信号匹配 (BOT_AGENT)
 *   - 弱信号 & 无匹配 fallback
 *   - 空消息边界情况
 *   - LLM 降级场景（无 AI provider）
 */

import { Intent, IntentClassifier } from '../../lib/agent/IntentClassifier.js';

describe('Integration: IntentClassifier', () => {
  let classifier: IntentClassifier;

  beforeAll(() => {
    // 不注入 AI provider → 只使用规则分类
    classifier = new IntentClassifier();
  });

  describe('Intent constants', () => {
    test('should have all intent types', () => {
      expect(Intent.BOT_AGENT).toBe('bot_agent');
      expect(Intent.IDE_AGENT).toBe('ide_agent');
      expect(Intent.SYSTEM).toBe('system');
    });

    test('should be frozen', () => {
      expect(Object.isFrozen(Intent)).toBe(true);
    });
  });

  describe('System intent (rule-based, zero latency)', () => {
    const systemCases = [
      ['状态', 'status'],
      ['服务状态怎么样', 'status'],
      ['截图', 'screen'],
      ['screenshot', 'screen'],
      ['帮助', 'help'],
      ['help', 'help'],
      ['队列', 'queue'],
      ['取消', 'cancel'],
      ['cancel', 'cancel'],
      ['清理历史', 'clear'],
      ['ping', 'ping'],
      ['测试连通', 'ping'],
    ];

    test.each(systemCases)('"%%s" → SYSTEM (%%s)', async (text: string, expectedAction: string) => {
      const result = await classifier.classify(text);
      expect(result.intent).toBe(Intent.SYSTEM);
      expect(result.confidence).toBe(1);
      expect(result.method).toBe('rule');
      expect((result as Record<string, unknown>).action).toBe(expectedAction);
    });
  });

  describe('IDE Agent intent (programming signals)', () => {
    const ideCases = [
      '帮我修改 src/auth.ts 把 JWT 改成 OAuth2',
      '写一个 React 组件来显示用户列表',
      '修复这个 bug，报错 TypeError',
      '重构 components/Header.tsx 里的代码',
      '实现一个新的 API endpoint',
      'run npm test 看看结果',
      'git commit -m "fix: auth bug"',
      '把 src/utils/format.js 里的函数优化一下',
      '调试一下 login.py 的问题',
      'review代码看看写得怎么样',
    ];

    test.each(ideCases)('"%%s" → IDE_AGENT', async (text: string) => {
      const result = await classifier.classify(text);
      expect(result.intent).toBe(Intent.IDE_AGENT);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result.method).toBe('rule');
    });
  });

  describe('Bot Agent intent (knowledge management)', () => {
    const botCases = [
      '搜索知识库里关于用户认证的内容',
      '帮我查找项目里的 recipe',
      '解释一下这段代码的架构',
      '分析一下项目结构',
      '总结一下 auth 模块的功能',
      '翻译这段文档',
      '你觉得应该用什么设计模式',
      '帮我创建一个 guard 规则',
      '搜索知识 candidate 相关的',
    ];

    test.each(botCases)('"%%s" → BOT_AGENT', async (text: string) => {
      const result = await classifier.classify(text);
      expect(result.intent).toBe(Intent.BOT_AGENT);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('Edge cases', () => {
    test('empty string → BOT_AGENT with confidence 1', async () => {
      const result = await classifier.classify('');
      expect(result.intent).toBe(Intent.BOT_AGENT);
      expect(result.confidence).toBe(1);
      expect(result.reasoning).toContain('空');
    });

    test('whitespace only → BOT_AGENT', async () => {
      const result = await classifier.classify('   ');
      expect(result.intent).toBe(Intent.BOT_AGENT);
      expect(result.confidence).toBe(1);
    });

    test('ambiguous message → still classifies', async () => {
      const result = await classifier.classify('可以帮我看看吗');
      expect(result.intent).toBeDefined();
      expect([Intent.BOT_AGENT, Intent.IDE_AGENT]).toContain(result.intent);
    });

    test('no AI provider → falls back to rule or default', async () => {
      const noAiClassifier = new IntentClassifier({ aiProvider: null });
      const result = await noAiClassifier.classify('做一些复杂的任务不确定该给谁');
      expect(result.intent).toBeDefined();
      // 应该是某种 fallback
      expect(result.method).toMatch(/^(rule|fallback)$/);
    });
  });

  describe('Classification structure', () => {
    test('should return complete classification result', async () => {
      const result = await classifier.classify('状态');
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reasoning');
      expect(result).toHaveProperty('method');
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
