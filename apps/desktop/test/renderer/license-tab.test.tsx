import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LicenseTab } from '../../src/renderer/features/team/license-tab.js';
import { useLicenseStore } from '../../src/renderer/state/license.js';
import type { LicenseStateWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const LINE = 'wbl1.eyJhIjoxfQ.c2ln';
const community: LicenseStateWire = {
  edition: 'community',
  status: 'none',
  seats: { used: 3, limit: 5 },
  features: [],
};
const team: LicenseStateWire = {
  edition: 'team',
  status: 'active',
  seats: { used: 3, limit: 50 },
  features: [],
  licenseId: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
  graceUntil: '2027-10-01T00:00:00.000Z',
};
const SERVER = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f9b7e14';
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

function install(overrides: Record<string, unknown> = {}) {
  return installWirebenchApi({
    license: { get: ok(community), install: ok(team), remove: ok({ removed: true }), ...overrides },
    fs: { openText: ok({ path: '/tmp/team.lic', text: `${LINE}\n` }) },
  });
}

describe('LicenseTab (licensing spec §3.8)', () => {
  beforeEach(() => useLicenseStore.getState().reset());
  afterEach(() => cleanup());

  it('shows the edition, status and seats of a fresh server', async () => {
    install();
    render(<LicenseTab url={URL_} />);
    expect((await screen.findByTestId('license-edition')).textContent).toContain('Community');
    expect(screen.getByTestId('license-status').textContent).toContain('No license installed');
    expect(screen.getByTestId('license-seats').textContent).toContain('3 of 5 seats in use');
    expect(screen.queryByTestId('license-remove')).toBeNull();
  });

  it('shows the server id first and copies it', async () => {
    install({ get: ok({ ...community, serverId: SERVER }) });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<LicenseTab url={URL_} />);
    expect((await screen.findByTestId('license-server-id')).textContent).toBe(SERVER);
    fireEvent.click(screen.getByTestId('license-copy-server-id'));
    expect(writeText).toHaveBeenCalledWith(SERVER);
  });

  it('hides the server id row when the server sends none', async () => {
    install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    expect(screen.queryByTestId('license-server-id')).toBeNull();
  });

  it('refuses a paste that is not a license line before anything is sent', async () => {
    const api = install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('license-install'));
    expect(screen.getByTestId('license-error').textContent).toContain('not a Wirebench license');
    expect(api.license.install).not.toHaveBeenCalled();
  });

  it('installs a pasted license and shows the new state', async () => {
    const api = install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: `  ${LINE}  ` } });
    fireEvent.click(screen.getByTestId('license-install'));
    await waitFor(() => expect(screen.getByTestId('license-edition').textContent).toContain('Team'));
    expect(api.license.install).toHaveBeenCalledWith({ url: URL_, license: LINE });
    expect(screen.getByTestId('license-customer').textContent).toContain('Example AG');
    expect(screen.getByTestId('license-seats').textContent).toContain('3 of 50 seats in use');
    expect(screen.getByTestId('license-expires').textContent).toContain('2027-09-01');
    expect(screen.getByTestId<HTMLTextAreaElement>('license-input').value).toBe('');
  });

  it('shows the server’s refusal', async () => {
    install({
      install: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'licensing-invalid', message: 'The license signature does not match.' },
      }),
    });
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: LINE } });
    fireEvent.click(screen.getByTestId('license-install'));
    expect((await screen.findByTestId('license-error')).textContent).toContain('The license signature does not match.');
  });

  it('reads a license from a file', async () => {
    install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.click(screen.getByTestId('license-choose-file'));
    await waitFor(() => expect(screen.getByTestId<HTMLTextAreaElement>('license-input').value).toBe(LINE));
  });

  it('removes a license only after confirming', async () => {
    const api = install({ get: ok(team) });
    render(<LicenseTab url={URL_} />);
    fireEvent.click(await screen.findByTestId('license-remove'));
    expect(api.license.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('license-remove-confirm-button'));
    await waitFor(() => expect(api.license.remove).toHaveBeenCalledWith({ url: URL_ }));
  });

  it('explains an invalid stored license', async () => {
    install({
      get: ok({
        ...community,
        status: 'invalid',
        reason: 'bad-signature',
        message: 'The license signature does not match.',
      }),
    });
    render(<LicenseTab url={URL_} />);
    expect((await screen.findByTestId('license-problem')).textContent).toContain(
      'The license signature does not match.',
    );
  });
});
