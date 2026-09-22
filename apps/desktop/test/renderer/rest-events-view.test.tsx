/**
 * The Events tab of an event-stream response: one row per event, comment and retry in arrival
 * order, a toggle for the muted rows, a filter, a detail with a pretty and a raw form, a window past
 * a thousand rows, and *Copy events as JSON* handing over the Query document.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { eventStreamDocument } from '@wirebench/engine/rest';
import { EventsView } from '../../src/renderer/features/rest-editor/response/events-view.js';
import type { SseRowWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const ROWS: SseRowWire[] = [
  { kind: 'comment', index: 0, at: 5, size: 4, text: 'hi' },
  { kind: 'event', index: 1, at: 1_234, size: 10, event: 'tick', data: '{"n":1}', id: '7', lastEventId: '7' },
  { kind: 'retry', index: 2, at: 1_300, size: 10, ms: 3000 },
  { kind: 'event', index: 3, at: 61_002, size: 5, event: 'message', data: 'plain words', lastEventId: '7' },
];

afterEach(() => {
  cleanup();
});

describe('EventsView', () => {
  it('shows the time, the event chip, the id and a one-line preview', () => {
    render(<EventsView rows={ROWS} />);
    const rows = screen.getAllByTestId('sse-row');
    expect(rows).toHaveLength(4);
    const tick = rows[1]!;
    expect(tick.textContent).toContain('00:01.234');
    expect(within(tick).getByTestId('sse-row-chip').textContent).toBe('tick');
    expect(tick.textContent).toContain('7');
    expect(tick.textContent).toContain('{"n":1}');
    expect(rows[3]!.textContent).toContain('01:01.002');
  });

  it('mutes comment and retry rows, and one toggle hides them', () => {
    render(<EventsView rows={ROWS} />);
    const rows = screen.getAllByTestId('sse-row');
    expect(rows[0]!.getAttribute('data-muted')).toBe('true');
    expect(rows[2]!.getAttribute('data-muted')).toBe('true');
    expect(rows[1]!.getAttribute('data-muted')).toBe('false');

    fireEvent.click(screen.getByLabelText('Comments and retries'));
    expect(screen.getAllByTestId('sse-row')).toHaveLength(2);
  });

  it('narrows by the filter text', () => {
    render(<EventsView rows={ROWS} />);
    fireEvent.change(screen.getByLabelText('Filter events'), { target: { value: 'PLAIN' } });
    const rows = screen.getAllByTestId('sse-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('plain words');
    expect(screen.getByTestId('sse-count').textContent).toBe('1 of 4 rows');
  });

  it('counts the rows let go and left out, not only the kept ones', () => {
    render(<EventsView rows={ROWS} droppedRows={10} omittedRows={5} />);
    expect(screen.getByTestId('sse-count').textContent).toBe('19 rows');
  });

  it('shows a selected JSON event pretty, with a Raw toggle', () => {
    render(<EventsView rows={ROWS} />);
    fireEvent.click(screen.getAllByTestId('sse-row')[1]!);
    const data = screen.getByLabelText<HTMLTextAreaElement>('Event data');
    expect(data.value).toBe('{\n  "n": 1\n}');
    fireEvent.click(screen.getByLabelText('Raw'));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Event data').value).toBe('{"n":1}');
  });

  it('moves the selection with the arrow keys and names it as the active descendant', () => {
    render(<EventsView rows={ROWS} />);
    const list = screen.getByRole('listbox', { name: 'Events' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    const selected = screen.getAllByTestId('sse-row')[1]!;
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(selected.id);
  });

  it('windows the list past a thousand rows', () => {
    const many: SseRowWire[] = Array.from({ length: 1_500 }, (_, index) => ({
      kind: 'event',
      index,
      at: index,
      size: 1,
      event: 'message',
      data: String(index),
      lastEventId: '',
    }));
    render(<EventsView rows={many} />);
    expect(screen.getAllByTestId('sse-row').length).toBeLessThan(200);
  });

  it('copies the events as the Query document', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<EventsView rows={ROWS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy events as JSON' }));
    expect(writeText).toHaveBeenCalledWith(eventStreamDocument(ROWS as Parameters<typeof eventStreamDocument>[0]));
  });
});
