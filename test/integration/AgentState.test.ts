/**
 * 集成测试：AgentState — 类型安全状态机
 *
 * 覆盖范围:
 *   - 默认状态转移 (idle → planning → executing → reflecting → completed)
 *   - 通配符转移 (* → aborted / * → failed)
 *   - Guard 条件阻断
 *   - 自定义 action
 *   - 事件发射（transition / phase:*）
 *   - 状态历史 & 序列化/反序列化
 *   - 终态检测
 *   - data update
 */

import { AgentPhase, AgentState } from '../../lib/agent/AgentState.js';

describe('Integration: AgentState', () => {
  describe('Default transitions', () => {
    test('should start at IDLE', () => {
      const state = new AgentState();
      expect(state.phase).toBe(AgentPhase.IDLE);
    });

    test('should follow happy path: idle → planning → executing → reflecting → completed', () => {
      const state = new AgentState();
      expect(state.send('start')).toBe(true);
      expect(state.phase).toBe(AgentPhase.PLANNING);

      expect(state.send('plan_ready')).toBe(true);
      expect(state.phase).toBe(AgentPhase.EXECUTING);

      expect(state.send('step_done')).toBe(true);
      expect(state.phase).toBe(AgentPhase.REFLECTING);

      expect(state.send('finish')).toBe(true);
      expect(state.phase).toBe(AgentPhase.COMPLETED);
    });

    test('should allow executing → completed directly', () => {
      const state = new AgentState({ initialPhase: AgentPhase.EXECUTING });
      expect(state.send('finish')).toBe(true);
      expect(state.phase).toBe(AgentPhase.COMPLETED);
    });

    test('should allow reflecting → executing via continue', () => {
      const state = new AgentState({ initialPhase: AgentPhase.REFLECTING });
      expect(state.send('continue')).toBe(true);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });

    test('should handle waiting_input flow', () => {
      const state = new AgentState({ initialPhase: AgentPhase.EXECUTING });
      expect(state.send('need_input')).toBe(true);
      expect(state.phase).toBe(AgentPhase.WAITING_INPUT);

      expect(state.send('input_received')).toBe(true);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });

    test('should handle handoff flow', () => {
      const state = new AgentState({ initialPhase: AgentPhase.EXECUTING });
      expect(state.send('handoff')).toBe(true);
      expect(state.phase).toBe(AgentPhase.HANDOFF);

      expect(state.send('handoff_done')).toBe(true);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });
  });

  describe('Wildcard transitions', () => {
    test('should abort from any state', () => {
      for (const phase of [
        AgentPhase.IDLE,
        AgentPhase.PLANNING,
        AgentPhase.EXECUTING,
        AgentPhase.REFLECTING,
      ]) {
        const state = new AgentState({ initialPhase: phase });
        expect(state.send('abort')).toBe(true);
        expect(state.phase).toBe(AgentPhase.ABORTED);
      }
    });

    test('should error from any state', () => {
      for (const phase of [AgentPhase.IDLE, AgentPhase.PLANNING, AgentPhase.EXECUTING]) {
        const state = new AgentState({ initialPhase: phase });
        expect(state.send('error', { reason: 'test' })).toBe(true);
        expect(state.phase).toBe(AgentPhase.FAILED);
        expect(state.data.reason).toBe('test');
      }
    });
  });

  describe('Invalid transitions', () => {
    test('should reject invalid event', () => {
      const state = new AgentState();
      expect(state.send('plan_ready')).toBe(false); // idle → plan_ready 无效
      expect(state.phase).toBe(AgentPhase.IDLE);
    });

    test('should reject non-existent event', () => {
      const state = new AgentState();
      expect(state.send('fly_to_moon')).toBe(false);
    });
  });

  describe('Terminal states', () => {
    test('should detect terminal states', () => {
      expect(new AgentState({ initialPhase: AgentPhase.COMPLETED }).isTerminal).toBe(true);
      expect(new AgentState({ initialPhase: AgentPhase.FAILED }).isTerminal).toBe(true);
      expect(new AgentState({ initialPhase: AgentPhase.ABORTED }).isTerminal).toBe(true);
    });

    test('should detect non-terminal states', () => {
      expect(new AgentState({ initialPhase: AgentPhase.IDLE }).isTerminal).toBe(false);
      expect(new AgentState({ initialPhase: AgentPhase.EXECUTING }).isTerminal).toBe(false);
    });
  });

  describe('Data management', () => {
    test('should carry payload through transitions', () => {
      const state = new AgentState({ initialData: { count: 0 } });
      state.send('start', { count: 1, task: 'analyze' });
      expect(state.data).toMatchObject({ count: 1, task: 'analyze' });
    });

    test('should merge data on update', () => {
      const state = new AgentState({ initialData: { x: 1, y: 2 } });
      state.update({ y: 3, z: 4 });
      expect(state.data).toEqual({ x: 1, y: 3, z: 4 });
    });
  });

  describe('Custom transitions with guards', () => {
    test('should block transition when guard returns false', () => {
      const state = new AgentState({
        transitions: [
          {
            from: AgentPhase.PLANNING,
            to: AgentPhase.EXECUTING,
            event: 'conditional_start',
            guard: (data) => (data.ready as boolean) === true,
          },
        ],
        initialPhase: AgentPhase.PLANNING,
        initialData: { ready: false },
      });

      expect(state.send('conditional_start')).toBe(false);
      expect(state.phase).toBe(AgentPhase.PLANNING);

      state.update({ ready: true });
      expect(state.send('conditional_start')).toBe(true);
      expect(state.phase).toBe(AgentPhase.EXECUTING);
    });

    test('should execute action on transition', () => {
      let actionData: unknown = null;
      const state = new AgentState({
        transitions: [
          {
            from: AgentPhase.EXECUTING,
            to: AgentPhase.REFLECTING,
            event: 'step_with_action',
            action: (data, payload) => {
              actionData = { ...data, ...payload };
            },
          },
        ],
        initialPhase: AgentPhase.EXECUTING,
      });

      state.send('step_with_action', { result: 'ok' });
      expect(state.phase).toBe(AgentPhase.REFLECTING);
      expect(actionData).toMatchObject({ result: 'ok' });
    });
  });

  describe('Event emission', () => {
    test('should emit transition event', () => {
      const state = new AgentState();
      const events: unknown[] = [];
      state.on('transition', (e) => events.push(e));

      state.send('start');

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        from: AgentPhase.IDLE,
        to: AgentPhase.PLANNING,
        event: 'start',
      });
    });

    test('should emit phase-specific event', () => {
      const state = new AgentState();
      let planningEntered = false;
      state.on(`phase:${AgentPhase.PLANNING}`, () => {
        planningEntered = true;
      });

      state.send('start');
      expect(planningEntered).toBe(true);
    });

    test('should emit update event', () => {
      const state = new AgentState();
      const updates: unknown[] = [];
      state.on('update', (e) => updates.push(e));

      state.update({ key: 'value' });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ phase: AgentPhase.IDLE, patch: { key: 'value' } });
    });
  });

  describe('availableEvents', () => {
    test('should return valid events from IDLE', () => {
      const state = new AgentState();
      const events = state.availableEvents();
      expect(events).toContain('start');
      expect(events).toContain('abort');
      expect(events).toContain('error');
    });

    test('should return valid events from EXECUTING', () => {
      const state = new AgentState({ initialPhase: AgentPhase.EXECUTING });
      const events = state.availableEvents();
      expect(events).toContain('step_done');
      expect(events).toContain('finish');
      expect(events).toContain('need_input');
      expect(events).toContain('handoff');
      expect(events).toContain('abort');
    });
  });

  describe('History & serialization', () => {
    test('should record full transition history', () => {
      const state = new AgentState();
      state.send('start');
      state.send('plan_ready');
      state.send('step_done');
      state.send('finish');

      const history = state.history;
      expect(history.length).toBeGreaterThanOrEqual(5); // initial + 4 transitions
      expect(history[0].phase).toBe(AgentPhase.IDLE);
      expect(history[history.length - 1].phase).toBe(AgentPhase.COMPLETED);
    });

    test('should serialize to JSON', () => {
      const state = new AgentState({ initialData: { task: 'test' } });
      state.send('start');

      const json = state.toJSON();
      expect(json.phase).toBe(AgentPhase.PLANNING);
      expect(json.data.task).toBe('test');
      expect(json.history).toBeDefined();
    });

    test('should restore from JSON snapshot', () => {
      const original = new AgentState({ initialData: { counter: 5 } });
      original.send('start');
      original.send('plan_ready', { counter: 6 });

      const snapshot = original.toJSON();
      const restored = AgentState.fromJSON(snapshot);

      expect(restored.phase).toBe(AgentPhase.EXECUTING);
      expect(restored.data.counter).toBe(6);
    });

    test('should support disabling history', () => {
      const state = new AgentState({ keepHistory: false });
      state.send('start');
      state.send('plan_ready');
      expect(state.history).toHaveLength(0);
    });
  });

  describe('AgentPhase constants', () => {
    test('should be frozen', () => {
      expect(Object.isFrozen(AgentPhase)).toBe(true);
    });

    test('should have all expected phases', () => {
      expect(AgentPhase.IDLE).toBe('idle');
      expect(AgentPhase.PLANNING).toBe('planning');
      expect(AgentPhase.EXECUTING).toBe('executing');
      expect(AgentPhase.REFLECTING).toBe('reflecting');
      expect(AgentPhase.WAITING_INPUT).toBe('waiting_input');
      expect(AgentPhase.HANDOFF).toBe('handoff');
      expect(AgentPhase.COMPLETED).toBe('completed');
      expect(AgentPhase.FAILED).toBe('failed');
      expect(AgentPhase.ABORTED).toBe('aborted');
    });
  });
});
