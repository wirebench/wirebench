/**
 * The Headers tab's Generated section: it lists what main says the send adds, and its two controls
 * edit the request — the switch its `omitHeaders`, Override its typed headers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GeneratedHeaders } from '../../src/renderer/features/rest-editor/generated-headers.js';
import type { RestHeaderRowWire, RestRequestPatchWire } from '../../src/shared/kinds/rest/wire.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restRequestWire } from '../helpers/wire-defaults.js';

const ROWS: RestHeaderRowWire[] = [
  { name: 'User-Agent', value: 'Wirebench/5', source: 'preference', state: 'sent' },
  { name: 'Accept', value: '*/*', source: 'preference', state: 'omitted' },
  { name: 'Authorization', value: 'Bearer <redacted>', source: 'auth', state: 'sent', masked: true },
  { name: 'Content-Type', value: 'application/json', source: 'body', state: 'overridden' },
  { name: 'Content-Type', value: 'text/plain', source: 'typed', state: 'sent' },
  { name: 'Host', value: 'api.test', source: 'transport', state: 'sent' },
];

const restHeaders = vi.fn();

function mount(overrides: Parameters<typeof restRequestWire>[0] = {}): ReturnType<typeof vi.fn> {
  const onChange = vi.fn<(patch: RestRequestPatchWire) => void>();
  render(<GeneratedHeaders request={restRequestWire(overrides)} onChange={onChange} />);
  return onChange;
}

/** The row of the section whose name and source are these. */
async function rowOf(name: string): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId('rest-generated-header');
  const found = rows.find(
    (row) => row.textContent?.startsWith(name) === true || within(row).queryByText(name) !== null,
  );
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
}

describe('GeneratedHeaders', () => {
  beforeEach(() => {
    restHeaders.mockReset().mockResolvedValue({ ok: true, value: { headers: ROWS, notes: ['A note.'] } });
    installWirebenchApi({ request: { restHeaders } });
  });

  afterEach(() => {
    cleanup();
  });

  it('lists every generated header with its source, leaving the typed ones to the table above', async () => {
    mount();
    const rows = await screen.findAllByTestId('rest-generated-header');
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual([
      'sent',
      'omitted',
      'sent',
      'overridden',
      'sent',
    ]);
    expect(rows[0]?.textContent).toContain('Preferences');
    expect(rows[4]?.textContent).toContain('Connection');
    expect(screen.getByText('A note.')).toBeTruthy();
    await waitFor(() => {
      expect(restHeaders).toHaveBeenCalledWith({ requestId: 'rest-1' });
    });
  });

  it('switches a header off into omitHeaders, and back on out of it', async () => {
    const onChange = mount({ settings: { timeoutMs: 5, omitHeaders: ['Accept'] } });
    fireEvent.click(within(await rowOf('User-Agent')).getByRole('checkbox', { name: 'Send User-Agent' }));
    expect(onChange).toHaveBeenLastCalledWith({ settings: { timeoutMs: 5, omitHeaders: ['Accept', 'User-Agent'] } });

    fireEvent.click(within(await rowOf('Accept')).getByRole('checkbox', { name: 'Send Accept' }));
    expect(onChange).toHaveBeenLastCalledWith({ settings: { timeoutMs: 5 } });
  });

  it('overrides a header with a typed one, empty when its value was masked', async () => {
    const existing = { name: 'X-Trace', value: '1', enabled: true };
    const onChange = mount({ headers: [existing] });
    fireEvent.click(await screen.findByRole('button', { name: 'Override User-Agent' }));
    expect(onChange).toHaveBeenLastCalledWith({
      headers: [existing, { name: 'User-Agent', value: 'Wirebench/5', enabled: true }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Override Authorization' }));
    expect(onChange).toHaveBeenLastCalledWith({
      headers: [existing, { name: 'Authorization', value: '', enabled: true }],
    });
  });

  it('offers no switch or override on what the connection adds, or on a header already replaced', async () => {
    mount();
    const host = await rowOf('Host');
    expect(within(host).queryByRole('checkbox')).toBeNull();
    expect(host.textContent).toContain('Set by the connection');
    expect(screen.queryByRole('button', { name: 'Override Content-Type' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Send Content-Type' })).toHaveProperty('disabled', true);
  });
});
