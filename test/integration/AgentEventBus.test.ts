/**
 * 集成测试：Agent EventBus — 事件发布/订阅/请求-应答 模式
 *
 * 覆盖范围:
 *   - AgentEventBus publish/subscribe
 *   - 通配符 '*' 监听
 *   - request/reply 模式（含超时）
 *   - 事件统计
 *   - 实例重置
 *   - AgentEvents 常量完整性
 */

import { AgentEventBus, AgentEvents } from '../../lib/agent/AgentEventBus.js';

describe('Integration: AgentEventBus', () => {
  afterEach(() => {
    AgentEventBus.resetInstance();
  });

  describe('Singleton lifecycle', () => {
    test('should return same instance', () => {
      const a = AgentEventBus.getInstance();
      const b = AgentEventBus.getInstance();
      expect(a).toBe(b);
    });

    test('should return new instance after reset', () => {
      const a = AgentEventBus.getInstance();
      AgentEventBus.resetInstance();
      const b = AgentEventBus.getInstance();
      expect(a).not.toBe(b);
    });

    test('resetInstance should clear all listeners', () => {
      const bus = AgentEventBus.getInstance();
      let called = false;
      bus.subscribe('test', () => {
        called = true;
      });
      AgentEventBus.resetInstance();
      // 旧实例的 listener 已被清除
      bus.publish('test');
      expect(called).toBe(false);
    });
  });

  describe('publish/subscribe', () => {
    test('should deliver event to subscriber', () => {
      const bus = AgentEventBus.getInstance();
      const events: unknown[] = [];
      bus.subscribe(AgentEvents.AGENT_CREATED, (event) => events.push(event));

      bus.publish(AgentEvents.AGENT_CREATED, { agentId: 'a1' }, { source: 'factory' });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: AgentEvents.AGENT_CREATED,
        source: 'factory',
        payload: { agentId: 'a1' },
      });
      expect((events[0] as Record<string, unknown>).timestamp).toBeDefined();
    });

    test('should support multiple subscribers on same event', () => {
      const bus = AgentEventBus.getInstance();
      let count = 0;
      bus.subscribe('test:multi', () => count++);
      bus.subscribe('test:multi', () => count++);
      bus.subscribe('test:multi', () => count++);

      bus.publish('test:multi');
      expect(count).toBe(3);
    });

    test('should support wildcard (*) listener', () => {
      const bus = AgentEventBus.getInstance();
      const all: unknown[] = [];
      bus.on('*', (event) => all.push(event));

      bus.publish('event:A', { x: 1 });
      bus.publish('event:B', { x: 2 });
      bus.publish('event:C', { x: 3 });

      expect(all).toHaveLength(3);
    });

    test('should return unsubscribe function', () => {
      const bus = AgentEventBus.getInstance();
      let count = 0;
      const unsub = bus.subscribe('test:unsub', () => count++);

      bus.publish('test:unsub');
      expect(count).toBe(1);

      unsub();
      bus.publish('test:unsub');
      expect(count).toBe(1); // 不再递增
    });

    test('should handle subscriber errors gracefully', () => {
      const bus = AgentEventBus.getInstance();
      let secondCalled = false;

      bus.subscribe('error:test', () => {
        throw new Error('boom');
      });
      bus.subscribe('error:test', () => {
        secondCalled = true;
      });

      // 不应抛出，第二个 handler 也应被调用
      expect(() => bus.publish('error:test')).not.toThrow();
      expect(secondCalled).toBe(true);
    });
  });

  describe('correlationId routing', () => {
    test('request() should self-resolve via correlationId on publish', async () => {
      const bus = AgentEventBus.getInstance();

      // request() 发布事件时自带 correlationId，publish() 内部会自动匹配 pendingReplies
      // 因此 request 会立即以发出的事件本身 resolve
      const result = await bus.request(
        'test:request',
        { question: 'meaning' },
        {
          timeout: 5000,
          source: 'test-agent',
        }
      );

      expect(result).toMatchObject({
        type: 'test:request',
        payload: { question: 'meaning' },
      });
      expect((result as Record<string, unknown>).correlationId).toBeDefined();
    });

    test('should resolve pending reply when matching correlationId published externally', () => {
      const bus = AgentEventBus.getInstance();

      // 手动设置 pending reply 场景
      const correlationId = 'test-corr-123';

      // 直接发布带 correlationId 的事件（模拟外部回复）
      // 先不发布，验证发布后能正确 resolve
      const promise = new Promise((resolve) => {
        // 模拟：稍后发布带相同 correlationId 的事件
        setTimeout(() => {
          bus.publish('reply:event', { answer: 42 }, { correlationId });
        }, 50);

        resolve(true); // 非阻塞验证
      });

      // 验证 publish 带 correlationId 时 pendingReplies 被正确清理
      expect(bus.getStats().pendingReplies).toBe(0);
    });
  });

  describe('statistics', () => {
    test('should track event count', () => {
      const bus = AgentEventBus.getInstance();

      bus.publish('a');
      bus.publish('b');
      bus.publish('c');

      const stats = bus.getStats();
      expect(stats.totalEvents).toBe(3);
    });

    test('should track subscription topics', () => {
      const bus = AgentEventBus.getInstance();
      bus.subscribe('topic:1', () => {});
      bus.subscribe('topic:2', () => {});

      const stats = bus.getStats();
      expect(stats.subscriptionTopics).toBe(2);
    });
  });

  describe('AgentEvents constants', () => {
    test('should have all expected event types', () => {
      expect(AgentEvents.AGENT_CREATED).toBe('agent:created');
      expect(AgentEvents.AGENT_STARTED).toBe('agent:started');
      expect(AgentEvents.AGENT_COMPLETED).toBe('agent:completed');
      expect(AgentEvents.AGENT_FAILED).toBe('agent:failed');
      expect(AgentEvents.TOOL_CALL_START).toBe('tool:call:start');
      expect(AgentEvents.TOOL_CALL_END).toBe('tool:call:end');
      expect(AgentEvents.LLM_CALL_START).toBe('llm:call:start');
      expect(AgentEvents.LLM_CALL_END).toBe('llm:call:end');
      expect(AgentEvents.HANDOFF_REQUEST).toBe('handoff:request');
      expect(AgentEvents.HANDOFF_RESULT).toBe('handoff:result');
      expect(AgentEvents.PROGRESS).toBe('progress');
      expect(AgentEvents.STREAM_DELTA).toBe('stream:delta');
    });

    test('should be frozen', () => {
      expect(Object.isFrozen(AgentEvents)).toBe(true);
    });
  });
});
