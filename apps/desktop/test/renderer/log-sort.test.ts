import { describe, expect, it } from 'vitest';
import { sortEntries } from '../../src/renderer/features/console/log-sort.js';
import { sendIdOf, type LogEntry } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

const at = (id: string, status: number, durationMs: number, startedAt: string): LogEntry => {
  const e = makeRestExchange({ sendId: id, durationMs });
  return logExchange({ ...e, http: { ...e.http, status, timings: { ...e.http.timings, startedAt } } });
};
const a = at('a', 500, 30, '2026-09-18T10:00:02.000Z');
const b = at('b', 200, 10, '2026-09-18T10:00:01.000Z');
const f: LogEntry = {
  kind: 'failure',
  failure: makeFailure({ sendId: 'f', durationMs: 20, startedAt: '2026-09-18T10:00:03.000Z' }),
};
const ids = (xs: readonly LogEntry[]) => xs.map(sendIdOf);
const name = () => 'x';

describe('sortEntries', () => {
  it('no sort keeps log order', () => {
    expect(ids(sortEntries([a, b, f], undefined, name))).toEqual(['a', 'b', 'f']);
  });
  it('time asc and desc', () => {
    expect(ids(sortEntries([a, b, f], { column: 'time', direction: 'asc' }, name))).toEqual(['b', 'a', 'f']);
    expect(ids(sortEntries([a, b, f], { column: 'time', direction: 'desc' }, name))).toEqual(['f', 'a', 'b']);
  });
  it('status puts failures first ascending', () => {
    expect(ids(sortEntries([a, b, f], { column: 'status', direction: 'asc' }, name))).toEqual(['f', 'b', 'a']);
  });
  it('duration desc', () => {
    expect(ids(sortEntries([a, b, f], { column: 'duration', direction: 'desc' }, name))).toEqual(['a', 'f', 'b']);
  });
  it('size puts failures first ascending', () => {
    expect(ids(sortEntries([a, f], { column: 'size', direction: 'asc' }, name))).toEqual(['f', 'a']);
  });
  it('ties are stable', () => {
    expect(ids(sortEntries([a, b, f], { column: 'name', direction: 'asc' }, name))).toEqual(['a', 'b', 'f']);
  });
});
