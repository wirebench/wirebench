/**
 * The HTTP Log's column sort: a stable comparator over a copy of the rows, so ties (and no sort at
 * all) keep log order. Failures read as status 0 and size 0, so they lead an ascending sort.
 */
import type { LogEntry, LogSort, SortColumn } from '../../state/exchanges.js';
import { responseSize } from '../request-editor/response-status.js';
import { durationOf, startedAtOf } from './log-filter.js';

function keyOf(entry: LogEntry, column: SortColumn, nameOf: (e: LogEntry) => string): number | string {
  switch (column) {
    case 'time':
      return Date.parse(startedAtOf(entry));
    case 'name':
      return nameOf(entry);
    case 'status':
      if (entry.kind === 'failure') {
        return 0;
      }
      return 'protocol' in entry.exchange ? entry.exchange.status : entry.exchange.http.status;
    case 'duration':
      return durationOf(entry);
    case 'size':
      return entry.kind === 'failure' ? 0 : responseSize(entry.exchange);
  }
}

function compare(left: number | string, right: number | string): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
  }
  return Number(left) - Number(right);
}

export function sortEntries(
  entries: readonly LogEntry[],
  sort: LogSort | undefined,
  nameOf: (e: LogEntry) => string,
): LogEntry[] {
  if (sort === undefined) {
    return [...entries];
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  const keyed = entries.map((entry) => ({ entry, key: keyOf(entry, sort.column, nameOf) }));
  keyed.sort((left, right) => sign * compare(left.key, right.key));
  return keyed.map((item) => item.entry);
}
