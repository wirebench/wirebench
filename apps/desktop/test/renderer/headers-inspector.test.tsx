import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeadersInspector } from '../../src/renderer/features/request-editor/inspectors/headers-inspector.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { HeaderEntryWire } from '../../src/shared/wire-types.js';

const updateRequest = vi.fn();

function renderInspector(): void {
  render(<HeadersInspector requestId="req-1" />);
}

function install(headers: readonly HeaderEntryWire[]): void {
  useProjectStore.setState({
    requests: { 'req-1': makeDraft({ headers: [...headers] }) },
    updateRequest,
  } as never);
}

describe('HeadersInspector (request)', () => {
  beforeEach(() => {
    updateRequest.mockClear();
    useProblemsStore.setState({ items: [] });
    install([{ name: 'X-Trace', value: 'abc' }]);
  });

  afterEach(() => {
    cleanup();
  });

  it('invites a first header when the request has none', () => {
    install([]);
    renderInspector();
    expect(screen.getByText(/No custom headers/i)).toBeDefined();
  });

  it('adds a header, appending it to the ordered list', async () => {
    renderInspector();

    await userEvent.type(screen.getByLabelText('New header name'), 'X-Extra');
    await userEvent.type(screen.getByLabelText('New header value'), 'yes');
    await userEvent.click(screen.getByRole('button', { name: 'Add header' }));

    expect(updateRequest).toHaveBeenCalledWith('req-1', {
      headers: [
        { name: 'X-Trace', value: 'abc' },
        { name: 'X-Extra', value: 'yes' },
      ],
    });
  });

  it('commits an inline value edit on Enter and reverts it on Escape', async () => {
    renderInspector();
    const value = screen.getByLabelText<HTMLInputElement>('Value of header 1');

    await userEvent.clear(value);
    await userEvent.type(value, 'zzz{Enter}');
    expect(updateRequest).toHaveBeenCalledWith('req-1', { headers: [{ name: 'X-Trace', value: 'zzz' }] });

    updateRequest.mockClear();
    await userEvent.clear(value);
    await userEvent.type(value, 'nope{Escape}');
    expect(value.value).toBe('abc');
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it('commits a name edit on blur', async () => {
    renderInspector();
    const name = screen.getByLabelText('Name of header 1');

    await userEvent.clear(name);
    await userEvent.type(name, 'X-Renamed');
    await userEvent.tab();

    expect(updateRequest).toHaveBeenCalledWith('req-1', { headers: [{ name: 'X-Renamed', value: 'abc' }] });
  });

  it('trims a name edit before committing, same as adding a new header', async () => {
    renderInspector();
    const name = screen.getByLabelText<HTMLInputElement>('Name of header 1');

    await userEvent.clear(name);
    await userEvent.type(name, '  X-Padded  {Enter}');

    expect(updateRequest).toHaveBeenCalledWith('req-1', { headers: [{ name: 'X-Padded', value: 'abc' }] });
  });

  it('rejects an empty or whitespace-only name on inline commit, reverting to the previous name', async () => {
    renderInspector();
    const name = screen.getByLabelText<HTMLInputElement>('Name of header 1');

    await userEvent.clear(name);
    await userEvent.type(name, '{Enter}');
    expect(name.value).toBe('X-Trace');
    expect(updateRequest).not.toHaveBeenCalled();

    await userEvent.clear(name);
    await userEvent.type(name, '   ');
    await userEvent.tab();
    expect(name.value).toBe('X-Trace');
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it('removes a header by index, keeping the duplicate that shares its name', async () => {
    install([
      { name: 'Accept', value: 'a' },
      { name: 'Accept', value: 'b' },
    ]);
    renderInspector();

    await userEvent.click(screen.getByRole('button', { name: 'Remove header 1 (Accept)' }));

    expect(updateRequest).toHaveBeenCalledWith('req-1', { headers: [{ name: 'Accept', value: 'b' }] });
  });

  it('keeps duplicate names and their order when rendering', () => {
    install([
      { name: 'Accept', value: 'a' },
      { name: 'Accept', value: 'b' },
    ]);
    renderInspector();

    expect(screen.getByLabelText<HTMLInputElement>('Value of header 1').value).toBe('a');
    expect(screen.getByLabelText<HTMLInputElement>('Value of header 2').value).toBe('b');
  });

  it('reorders with the up/down buttons', async () => {
    install([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    renderInspector();

    await userEvent.click(screen.getByRole('button', { name: 'Move header 2 (B) up' }));

    expect(updateRequest).toHaveBeenCalledWith('req-1', {
      headers: [
        { name: 'B', value: '2' },
        { name: 'A', value: '1' },
      ],
    });
  });

  it('cannot move the first header up nor the last one down', () => {
    install([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    renderInspector();

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move header 1 (A) up' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move header 2 (B) down' }).disabled).toBe(true);
  });

  it('warns that a header overrides one the app computes, case-insensitively', () => {
    install([
      { name: 'content-TYPE', value: 'text/plain' },
      { name: 'X-Trace', value: 'abc' },
    ]);
    renderInspector();

    expect(screen.getAllByText(/overrides the default/i)).toHaveLength(1);
  });

  it('shows this request’s unresolved expansions next to the header they sit in', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:req-1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'expansion-missing', message: 'Unresolved property ${#Project#nope} in header "X-Trace"' },
        },
      ],
    });
    renderInspector();

    expect(screen.getByText(/\$\{#Project#nope\}/)).toBeDefined();
  });
});
