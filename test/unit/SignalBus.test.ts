import { describe, expect, test, vi } from 'vitest';
import type { Signal, SignalHandler } from '../../lib/infrastructure/signal/SignalBus.js';
import { SignalBus } from '../../lib/infrastructure/signal/SignalBus.js';

/* ════════════════════════════════════════════
 *  SignalBus 单元测试
 * ════════════════════════════════════════════ */

describe('SignalBus', () => {
  function makeSignal(overrides: Partial<Signal> = {}): Signal {
    return {
      type: 'guard',
      source: 'test',
      target: null,
      value: 0.5,
      metadata: {},
      timestamp: Date.now(),
      ...overrides,
    };
  }

  test('emit delivers to exact type subscriber', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('guard', handler);

    const signal = makeSignal();
    bus.emit(signal);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(signal);
  });

  test('emit does not deliver to non-matching subscriber', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('search', handler);

    bus.emit(makeSignal({ type: 'guard' }));

    expect(handler).not.toHaveBeenCalled();
  });

  test('wildcard subscriber receives all signals', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('*', handler);

    bus.emit(makeSignal({ type: 'guard' }));
    bus.emit(makeSignal({ type: 'search' }));
    bus.emit(makeSignal({ type: 'usage' }));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  test('pipe pattern subscribes to multiple types', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('guard|search', handler);

    bus.emit(makeSignal({ type: 'guard' }));
    bus.emit(makeSignal({ type: 'search' }));
    bus.emit(makeSignal({ type: 'usage' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('subscribe returns unsubscribe function', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    const unsub = bus.subscribe('guard', handler);

    bus.emit(makeSignal());
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    bus.emit(makeSignal());
    expect(handler).toHaveBeenCalledOnce(); // no additional call
  });

  test('unsubscribe from pipe pattern removes all registrations', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    const unsub = bus.subscribe('guard|search', handler);

    unsub();
    bus.emit(makeSignal({ type: 'guard' }));
    bus.emit(makeSignal({ type: 'search' }));

    expect(handler).not.toHaveBeenCalled();
  });

  test('handler error does not block other handlers', () => {
    const bus = new SignalBus();
    const badHandler: SignalHandler = () => {
      throw new Error('boom');
    };
    const goodHandler = vi.fn();

    bus.subscribe('guard', badHandler);
    bus.subscribe('guard', goodHandler);

    bus.emit(makeSignal());

    expect(goodHandler).toHaveBeenCalledOnce();
  });

  test('handler error does not block wildcard handlers', () => {
    const bus = new SignalBus();
    const badHandler: SignalHandler = () => {
      throw new Error('boom');
    };
    const wildcardHandler = vi.fn();

    bus.subscribe('guard', badHandler);
    bus.subscribe('*', wildcardHandler);

    bus.emit(makeSignal());

    expect(wildcardHandler).toHaveBeenCalledOnce();
  });

  test('send() creates signal with clamped value and auto-timestamp', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('usage', handler);

    bus.send('usage', 'TestSource', 1.5, { target: 'recipe-1', metadata: { foo: 'bar' } });

    expect(handler).toHaveBeenCalledOnce();
    const signal = handler.mock.calls[0][0] as Signal;
    expect(signal.type).toBe('usage');
    expect(signal.source).toBe('TestSource');
    expect(signal.target).toBe('recipe-1');
    expect(signal.value).toBe(1); // clamped to max 1
    expect(signal.metadata).toEqual({ foo: 'bar' });
    expect(signal.timestamp).toBeGreaterThan(0);
  });

  test('send() clamps negative value to 0', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('guard', handler);

    bus.send('guard', 'test', -0.5);

    const signal = handler.mock.calls[0][0] as Signal;
    expect(signal.value).toBe(0);
  });

  test('emitCount tracks total emissions', () => {
    const bus = new SignalBus();
    expect(bus.emitCount).toBe(0);

    bus.emit(makeSignal());
    bus.emit(makeSignal());
    bus.emit(makeSignal());

    expect(bus.emitCount).toBe(3);
  });

  test('listenerCount reports total across all types', () => {
    const bus = new SignalBus();
    expect(bus.listenerCount).toBe(0);

    bus.subscribe('guard', vi.fn());
    bus.subscribe('search', vi.fn());
    bus.subscribe('*', vi.fn());

    expect(bus.listenerCount).toBe(3);
  });

  test('clear() removes all listeners and resets count', () => {
    const bus = new SignalBus();
    const handler = vi.fn();
    bus.subscribe('guard', handler);
    bus.emit(makeSignal());

    bus.clear();

    expect(bus.emitCount).toBe(0);
    expect(bus.listenerCount).toBe(0);

    bus.emit(makeSignal());
    expect(handler).toHaveBeenCalledOnce(); // from before clear
  });

  test('multiple subscribers on same type all receive signal', () => {
    const bus = new SignalBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();

    bus.subscribe('guard', h1);
    bus.subscribe('guard', h2);
    bus.subscribe('guard', h3);

    bus.emit(makeSignal());

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h3).toHaveBeenCalledOnce();
  });

  test('same handler registered twice is deduplicated via Set', () => {
    const bus = new SignalBus();
    const handler = vi.fn();

    bus.subscribe('guard', handler);
    bus.subscribe('guard', handler);

    bus.emit(makeSignal());

    expect(handler).toHaveBeenCalledOnce();
  });
});
