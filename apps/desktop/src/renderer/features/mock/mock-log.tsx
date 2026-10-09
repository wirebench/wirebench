/**
 * A running mock's request log (#59): one row per request it answered this session, newest first,
 * with what the contract check found. Selecting a row shows both sides. Everything here arrived from
 * main already masked, and nothing is kept past the session.
 */
import { useState } from 'react';
import type { MockExchangeEventWire } from '../../../shared/wire-types.js';
import { useMockRunsStore } from '../../state/mock-runs.js';

const EMPTY: readonly MockExchangeEventWire[] = [];

function time(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString();
}

function statusClass(status: number): string {
  return status >= 500 ? 'text-status-danger' : status >= 400 ? 'text-status-warning' : 'text-status-success';
}

function Side({ title, side }: { readonly title: string; readonly side: MockExchangeEventWire['request'] }) {
  return (
    <div className="min-w-0 flex-1">
      <h4 className="text-xs font-medium uppercase text-fg-subtle">{title}</h4>
      <ul className="font-mono text-xs text-fg-muted">
        {side.headers.map(([name, value], index) => (
          <li key={`${name}-${String(index)}`} className="truncate">
            {name}: {value}
          </li>
        ))}
      </ul>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-base p-2 font-mono text-xs text-fg-default">
        {side.body === '' ? '(no body)' : side.body}
        {side.truncated ? '\n… (cut short)' : ''}
      </pre>
    </div>
  );
}

export function MockLog({ mockId }: { readonly mockId: string }) {
  const log = useMockRunsStore((state) => state.logs[mockId]) ?? EMPTY;
  const clear = useMockRunsStore((state) => state.clearLog);
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>(undefined);
  const rows = [...log].reverse();
  const selected = log.find((event) => event.seq === selectedSeq);

  return (
    <div data-testid="mock-log" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-subtle">
          {log.length === 0 ? 'No requests yet.' : `${String(log.length)} request(s) this session.`}
        </span>
        <button
          type="button"
          data-testid="mock-log-clear"
          disabled={log.length === 0}
          className="ml-auto text-sm text-accent hover:underline disabled:opacity-40"
          onClick={() => {
            clear(mockId);
            setSelectedSeq(undefined);
          }}
        >
          Clear
        </button>
      </div>
      {rows.length > 0 && (
        <table className="w-full table-fixed text-left text-sm">
          <thead className="text-xs text-fg-subtle">
            <tr>
              <th className="w-24 font-normal">Time</th>
              <th className="w-16 font-normal">Method</th>
              <th className="font-normal">Path</th>
              <th className="font-normal">Operation</th>
              <th className="font-normal">Response</th>
              <th className="w-14 font-normal">Status</th>
              <th className="w-16 font-normal">Time (ms)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((event) => (
              <tr
                key={event.seq}
                data-testid="mock-log-row"
                aria-selected={event.seq === selectedSeq}
                className={`cursor-pointer ${event.seq === selectedSeq ? 'bg-surface-selected' : 'hover:bg-surface-hover'}`}
                onClick={() => setSelectedSeq(event.seq)}
              >
                <td className="truncate text-fg-subtle">{time(event.at)}</td>
                <td className="font-mono text-xs">{event.method}</td>
                <td className="truncate font-mono text-xs" title={event.url}>
                  {event.url}
                </td>
                <td className="truncate">{event.operation ?? '—'}</td>
                <td className="truncate">
                  {event.responseName ?? event.error?.code ?? '—'}
                  {event.problems.length > 0 && (
                    <span data-testid="mock-log-problems" className="ml-1 text-xs text-status-warning">
                      ({String(event.problems.length)} problem{event.problems.length === 1 ? '' : 's'})
                    </span>
                  )}
                </td>
                <td data-testid="mock-log-status" className={`font-mono text-xs ${statusClass(event.status)}`}>
                  {event.status}
                </td>
                <td className="text-fg-subtle">{event.durationMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected !== undefined && (
        <div data-testid="mock-log-detail" className="flex flex-col gap-2 rounded-md border border-hairline p-2">
          {selected.error !== undefined && (
            <p className="text-sm text-status-danger">
              {selected.error.code}: {selected.error.message}
            </p>
          )}
          {selected.problems.length > 0 && (
            <ul className="text-sm text-status-warning">
              {selected.problems.map((problem, index) => (
                <li key={String(index)}>
                  {problem.in !== undefined
                    ? `${problem.in}${problem.name !== undefined ? ` ${problem.name}` : ''}: `
                    : ''}
                  {problem.message}
                </li>
              ))}
            </ul>
          )}
          {selected.log !== undefined && selected.log.length > 0 && (
            <pre className="rounded bg-surface-base p-2 font-mono text-xs text-fg-muted">{selected.log.join('\n')}</pre>
          )}
          <div className="flex gap-3">
            <Side title="Request" side={selected.request} />
            <Side title="Response" side={selected.response} />
          </div>
        </div>
      )}
    </div>
  );
}
