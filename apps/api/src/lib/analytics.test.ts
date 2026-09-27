/**
 * Emitter behaviour (decision D112).
 *
 * The contract itself is tested in `@jambu/shared-types`. What matters here is
 * that measurement can never damage the thing being measured: P14 requires
 * analytics to be fail-open and non-blocking, and "analytics failure never
 * breaks the care loop" is an acceptance criterion, not a nicety.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalyticsEvent } from '@jambu/shared-types';

import { __resetAnalytics, emit, setAnalyticsSink } from './analytics.js';

const AT = '2026-09-21T09:40:00Z';
const USER = '11111111-1111-4111-8111-111111111111';

const RESUMED: AnalyticsEvent = { event: 'jambu_resumed', occurredAt: AT, userId: USER };

afterEach(() => {
  __resetAnalytics();
  vi.restoreAllMocks();
});

describe('absent provider (decision D112)', () => {
  it('is a safe no-op when nothing is installed', () => {
    // The default state of production today: no provider is configured, and
    // that must be silence rather than an error.
    expect(() => emit(RESUMED)).not.toThrow();
  });

  it('stops emitting once the sink is removed', () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => void seen.push(event));
    emit(RESUMED);
    setAnalyticsSink(null);
    emit(RESUMED);
    expect(seen).toHaveLength(1);
  });
});

describe('fail-open (P14 acceptance)', () => {
  it('survives a sink that throws synchronously', () => {
    setAnalyticsSink(() => {
      throw new Error('provider exploded');
    });
    expect(() => emit(RESUMED)).not.toThrow();
  });

  it('survives a sink that rejects asynchronously', async () => {
    setAnalyticsSink(() => Promise.reject(new Error('network down')));
    expect(() => emit(RESUMED)).not.toThrow();
    // An unhandled rejection would surface on the next turn of the loop.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('survives a sink that is not a function', () => {
    setAnalyticsSink('nonsense' as unknown as () => void);
    expect(() => emit(RESUMED)).not.toThrow();
  });

  it('never breaks the caller, whatever the sink does', () => {
    setAnalyticsSink(() => {
      throw new Error('boom');
    });
    // Stands in for a care-loop operation with an emit in the middle.
    const careLoop = (): string => {
      emit(RESUMED);
      return 'decision made';
    };
    expect(careLoop()).toBe('decision made');
  });
});

describe('non-blocking (P14 acceptance)', () => {
  it('returns void, so a caller cannot await it', () => {
    setAnalyticsSink(() => undefined);
    expect(emit(RESUMED)).toBeUndefined();
  });

  it('does not wait for a slow sink', async () => {
    let settled = false;
    setAnalyticsSink(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve();
          }, 50);
        }),
    );

    emit(RESUMED);
    // Control returned before the sink finished: that is the whole property.
    expect(settled).toBe(false);
  });

  it('returns before a synchronous sink has any chance to block the result', () => {
    const order: string[] = [];
    setAnalyticsSink(() => void order.push('sink'));
    emit(RESUMED);
    order.push('caller continued');
    expect(order).toEqual(['sink', 'caller continued']);
  });
});

describe('privacy fails closed (ARCHITECTURE.md §10)', () => {
  it('drops a payload carrying a forbidden value rather than sending it', () => {
    const seen: unknown[] = [];
    setAnalyticsSink((event) => void seen.push(event));

    emit({
      event: 'jambu_resumed',
      occurredAt: AT,
      userId: 'someone@example.com',
    } as unknown as AnalyticsEvent);

    // Dropping telemetry is harmless; leaking an email is not.
    expect(seen).toEqual([]);
  });

  it('drops a payload carrying a field outside the contract', () => {
    const seen: unknown[] = [];
    setAnalyticsSink((event) => void seen.push(event));
    emit({ ...RESUMED, domain: 'notion.so' } as unknown as AnalyticsEvent);
    expect(seen).toEqual([]);
  });

  it('still delivers a clean payload', () => {
    const seen: AnalyticsEvent[] = [];
    setAnalyticsSink((event) => void seen.push(event));
    emit(RESUMED);
    expect(seen).toEqual([RESUMED]);
  });
});
