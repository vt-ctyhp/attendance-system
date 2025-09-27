export type PauseKind = 'break' | 'lunch';
export type PauseAction = 'start' | 'end';

export interface PauseApiPayload {
  kind: PauseKind;
  action: PauseAction;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
}

export interface PauseSnapshot {
  kind: PauseKind;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
}

export interface PauseRecord {
  kind: PauseKind;
  sequence: number;
  startedAt: Date;
  endedAt: Date | null;
  durationMinutes: number | null;
}

export interface PauseState {
  current: PauseRecord | null;
  history: PauseRecord[];
}

const MINUTE_MS = 60_000;

export const computePauseDuration = (
  record: { startedAt: Date; endedAt: Date | null; durationMinutes: number | null },
  now: Date
) => record.durationMinutes ?? Math.max(0, Math.ceil(((record.endedAt ?? now).getTime() - record.startedAt.getTime()) / MINUTE_MS));

const createRecord = (snapshot: PauseSnapshot, now: Date): PauseRecord => ({
  kind: snapshot.kind,
  sequence: snapshot.sequence,
  startedAt: new Date(snapshot.startedAt),
  endedAt: snapshot.endedAt ? new Date(snapshot.endedAt) : null,
  durationMinutes: snapshot.durationMinutes
});

const upsertHistory = (history: PauseRecord[], entry: PauseRecord) => {
  const next = history.filter((item) => !(item.kind === entry.kind && item.sequence === entry.sequence));
  next.push(entry);
  next.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return next;
};

export const applyPauseUpdate = (state: PauseState, payload: PauseApiPayload, now: Date): PauseState => {
  const existingCurrent = state.current;
  const baseRecord: PauseRecord = {
    kind: payload.kind,
    sequence: payload.sequence,
    startedAt: new Date(payload.startedAt),
    endedAt: payload.endedAt ? new Date(payload.endedAt) : null,
    durationMinutes: payload.durationMinutes
  };

  if (payload.action === 'start') {
    if (
      existingCurrent &&
      existingCurrent.kind === baseRecord.kind &&
      existingCurrent.sequence === baseRecord.sequence &&
      existingCurrent.startedAt.getTime() === baseRecord.startedAt.getTime()
    ) {
      return state;
    }
    return {
      current: { ...baseRecord, endedAt: null, durationMinutes: null },
      history: state.history.filter(
        (item) => !(item.kind === baseRecord.kind && item.sequence === baseRecord.sequence)
      )
    };
  }

  const durationMinutes = computePauseDuration(baseRecord, now);
  const updatedHistory = upsertHistory(state.history, {
    ...baseRecord,
    endedAt: baseRecord.endedAt,
    durationMinutes
  });

  const nextCurrent =
    existingCurrent &&
    existingCurrent.kind === baseRecord.kind &&
    existingCurrent.sequence === baseRecord.sequence
      ? null
      : existingCurrent;

  return { current: nextCurrent, history: updatedHistory };
};

export const buildPauseState = (
  snapshot: { current: PauseSnapshot | null; history: PauseSnapshot[] },
  now: Date
): PauseState => {
  const historyRecords = snapshot.history
    .map((entry) => ({
      kind: entry.kind,
      sequence: entry.sequence,
      startedAt: new Date(entry.startedAt),
      endedAt: entry.endedAt ? new Date(entry.endedAt) : null,
      durationMinutes: entry.durationMinutes ?? null
    }))
    .map((entry) => ({
      ...entry,
      durationMinutes: entry.durationMinutes ?? computePauseDuration(entry, now)
    }))
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const currentRecord = snapshot.current ? createRecord(snapshot.current, now) : null;
  const normalizedHistory = currentRecord
    ? historyRecords.filter(
        (item) => !(item.kind === currentRecord.kind && item.sequence === currentRecord.sequence)
      )
    : historyRecords;

  return {
    current: currentRecord,
    history: normalizedHistory
  };
};

export const formatPauseLabel = (record: PauseRecord) =>
  `${record.kind === 'break' ? 'Break' : 'Lunch'} ${record.sequence}`;
