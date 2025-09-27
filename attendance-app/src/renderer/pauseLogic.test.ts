import { describe, expect, it } from 'vitest';
import {
  applyPauseUpdate,
  buildPauseState,
  computePauseDuration,
  type PauseApiPayload,
  type PauseState
} from './pauseLogic';

describe('pauseLogic', () => {
  it('creates a current pause on start', () => {
    const initial: PauseState = { current: null, history: [] };
    const payload: PauseApiPayload = {
      kind: 'break',
      action: 'start',
      sequence: 1,
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: null,
      durationMinutes: null
    };

    const updated = applyPauseUpdate(initial, payload, new Date('2025-01-01T00:02:00.000Z'));
    expect(updated.current).not.toBeNull();
    expect(updated.current?.kind).toBe('break');
    expect(updated.current?.sequence).toBe(1);
    expect(updated.history).toHaveLength(0);
  });

  it('ignores duplicate start events for the same pause', () => {
    const initial: PauseState = {
      current: {
        kind: 'break',
        sequence: 1,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
        endedAt: null,
        durationMinutes: null
      },
      history: []
    };

    const payload: PauseApiPayload = {
      kind: 'break',
      action: 'start',
      sequence: 1,
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: null,
      durationMinutes: null
    };

    const updated = applyPauseUpdate(initial, payload, new Date('2025-01-01T00:03:00.000Z'));
    expect(updated.current).toEqual(initial.current);
    expect(updated.history).toEqual([]);
  });

  it('records pause history on end and rounds duration up to the next minute', () => {
    const startState: PauseState = {
      current: {
        kind: 'break',
        sequence: 2,
        startedAt: new Date('2025-01-01T10:00:00.000Z'),
        endedAt: null,
        durationMinutes: null
      },
      history: []
    };

    const endPayload: PauseApiPayload = {
      kind: 'break',
      action: 'end',
      sequence: 2,
      startedAt: '2025-01-01T10:00:00.000Z',
      endedAt: '2025-01-01T10:04:20.000Z',
      durationMinutes: null
    };

    const updated = applyPauseUpdate(startState, endPayload, new Date('2025-01-01T10:05:00.000Z'));
    expect(updated.current).toBeNull();
    expect(updated.history).toHaveLength(1);
    const record = updated.history[0];
    expect(record.kind).toBe('break');
    expect(record.sequence).toBe(2);
    expect(record.durationMinutes).toBe(5); // ceiling(4m20s) = 5
  });

  it('builds pause state from snapshots and excludes current from history', () => {
    const pauseState = buildPauseState(
      {
        current: {
          kind: 'lunch',
          sequence: 1,
          startedAt: '2025-01-02T12:00:00.000Z',
          endedAt: null,
          durationMinutes: null
        },
        history: [
          {
            kind: 'break',
            sequence: 1,
            startedAt: '2025-01-02T09:00:00.000Z',
            endedAt: '2025-01-02T09:10:00.000Z',
            durationMinutes: 10
          }
        ]
      },
      new Date('2025-01-02T12:05:00.000Z')
    );

    expect(pauseState.current).not.toBeNull();
    expect(pauseState.current?.kind).toBe('lunch');
    expect(pauseState.history).toHaveLength(1);
    expect(pauseState.history[0].sequence).toBe(1);
    expect(pauseState.history[0].durationMinutes).toBe(10);
  });

  it('computes duration from now when not persisted', () => {
    const record = {
      startedAt: new Date('2025-01-01T08:00:00.000Z'),
      endedAt: null,
      durationMinutes: null
    };
    const minutes = computePauseDuration(record, new Date('2025-01-01T08:02:30.000Z'));
    expect(minutes).toBe(3);
  });
});
