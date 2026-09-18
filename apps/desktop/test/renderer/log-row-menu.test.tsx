import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { RestRequestWire } from '../../src/shared/wire-types.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('HTTP Log row menu', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useExchangesStore.setState({ log: [], filter: EMPTY_FILTER });
  });
  afterEach(cleanup);

  it('right-click opens the menu; Copy as cURL asks main and copies the command', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: "curl 'https://h/x'" } });
    installWirebenchApi({ log: { curl } });
    useExchangesStore.setState({ log: [logExchange(makeRestExchange())] });
    render(<HttpLog />);
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getAllByTestId('http-log-row')[0]! });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy as cURL (POSIX)' }));
    const [request] = curl.mock.calls[0] as [{ shell: string; entry: { kind: string } }];
    expect(request.shell).toBe('posix');
    expect(request.entry.kind).toBe('exchange');
    expect(writeText).toHaveBeenCalledWith("curl 'https://h/x'");
  });

  it('Shift+F10 on the selected row opens the menu; response actions are disabled for a failure', async () => {
    installWirebenchApi();
    useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure() }] });
    render(<HttpLog />);
    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    screen.getByLabelText('HTTP log').focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const item = await screen.findByRole('menuitem', { name: 'Copy response body' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('No response');
  });

  it('the ⋯ button in the detail header opens the same menu; Copy URL copies in the renderer', async () => {
    installWirebenchApi();
    useExchangesStore.setState({ log: [logExchange(makeRestExchange())] });
    render(<HttpLog />);
    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(makeRestExchange().http.request.url);
  });

  it('Resend sends the saved request and appends the returned exchange as a new row', async () => {
    const fresh = makeRestExchange({ sendId: 'fresh' });
    const resend = vi.fn().mockResolvedValue({ ok: true, value: { protocol: 'rest', exchange: fresh } });
    installWirebenchApi({ log: { resend } });
    useProjectStore.setState({ restRequests: { 'rest-1': { id: 'rest-1', name: 'Echo' } as RestRequestWire } });
    useExchangesStore.setState({ log: [logExchange(makeRestExchange(), 'rest-1')] });
    render(<HttpLog />);
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getAllByTestId('http-log-row')[0]! });
    const item = await screen.findByRole('menuitem', { name: 'Resend' });
    expect(item.getAttribute('title')).toBe('Sends the saved request as it is now');
    await userEvent.click(item);
    expect(resend).toHaveBeenCalledWith({ protocol: 'rest', requestId: 'rest-1' });
    expect(screen.getAllByTestId('http-log-row')).toHaveLength(2);
  });
});
