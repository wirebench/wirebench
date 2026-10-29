/**
 * The desktop's agent in the renderer (hosted edition spec §18.2, §18.5): *Pair this machine…* and Settings →
 * Paired browsers, over the `machineAgent.*` channels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PairMachineDialog } from '../../src/renderer/features/account/pair-machine-dialog.js';
import {
  PAIRED_BROWSER_TRUST_TEXT,
  PairedBrowsersSection,
  parseNames,
} from '../../src/renderer/features/preferences/sections/paired-browsers-section.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string, message = code) => ({ ok: false, error: { code, message } });

const PAIRING = {
  pairingId: '01JBX0000000000000000000AA',
  origin: 'https://wb.example.test',
  email: 'ada@example.test',
  createdAt: '2026-10-29T10:00:00.000Z',
  port: 47615,
  sshOptIn: false,
};

beforeEach(() => {
  showToast.mockReset();
  useUiStore.setState({ pairMachineDialogOpen: false });
});
afterEach(() => {
  cleanup();
});

async function openPairDialog(): Promise<void> {
  render(<PairMachineDialog />);
  act(() => {
    useUiStore.getState().setPairMachineDialogOpen(true);
  });
  await screen.findByTestId('pair-machine-dialog');
}

describe('Pair this machine…', () => {
  it('pairs with the server and code, closes, and says who it paired as', async () => {
    const pair = vi
      .fn()
      .mockResolvedValue(ok({ pairingId: PAIRING.pairingId, origin: PAIRING.origin, email: PAIRING.email }));
    installWirebenchApi({ machineAgent: { pair } });
    await openPairDialog();
    expect(screen.getByTestId('pair-machine-dialog').textContent).toContain(PAIRED_BROWSER_TRUST_TEXT);
    await userEvent.type(screen.getByTestId('pair-machine-url'), 'https://wb.example.test');
    await userEvent.type(screen.getByTestId('pair-machine-code'), 'ABC234');
    await userEvent.click(screen.getByTestId('pair-machine-submit'));
    expect(pair).toHaveBeenCalledWith({ serverUrl: 'https://wb.example.test', code: 'ABC234' });
    await waitFor(() => expect(screen.queryByTestId('pair-machine-dialog')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('Paired as ada@example.test with https://wb.example.test');
  });

  it('shows the server’s refusal of a bad code and stays open', async () => {
    const pair = vi.fn().mockResolvedValue(fail('agent-refused', 'The server refused the pairing code (HTTP 404)'));
    installWirebenchApi({ machineAgent: { pair } });
    await openPairDialog();
    await userEvent.type(screen.getByTestId('pair-machine-url'), 'https://wb.example.test');
    await userEvent.type(screen.getByTestId('pair-machine-code'), 'WRONG1{Enter}');
    expect((await screen.findByTestId('pair-machine-error')).textContent).toBe(
      'The server refused the pairing code (HTTP 404)',
    );
    expect(screen.getByTestId('pair-machine-dialog')).toBeTruthy();
    expect(useUiStore.getState().pairMachineDialogOpen).toBe(true);
  });
});

describe('Settings → Paired browsers', () => {
  it('lists the pairings with the agent’s port, and unpairs here only', async () => {
    const status = vi
      .fn()
      .mockResolvedValue(ok({ port: 47615, pairings: [PAIRING], paired: true, allowedSystemNames: [] }));
    const unpair = vi.fn().mockResolvedValue(ok({ pairings: [], paired: true, allowedSystemNames: [] }));
    installWirebenchApi({ machineAgent: { status, unpair } });
    render(<PairedBrowsersSection />);
    expect((await screen.findByTestId('machine-agent-pairing')).textContent).toContain(
      'https://wb.example.test · ada@example.test',
    );
    expect(screen.getByTestId('machine-agent-status').textContent).toBe('Listening on port 47615');
    await userEvent.click(screen.getByTestId('machine-agent-remove-local'));
    expect(unpair).toHaveBeenCalledWith({ pairingId: PAIRING.pairingId, local: true });
    await waitFor(() => expect(screen.queryByTestId('machine-agent-pairing')).toBeNull());
    expect(screen.getByTestId('machine-agent-status').textContent).toBe('Off: it starts when this machine is paired');
  });

  it('greys the allowlist before the first pairing', async () => {
    const status = vi.fn().mockResolvedValue(ok({ pairings: [], paired: false, allowedSystemNames: [] }));
    installWirebenchApi({ machineAgent: { status } });
    render(<PairedBrowsersSection />);
    await screen.findByTestId('machine-agent-names-note');
    expect(screen.getByTestId<HTMLInputElement>('machine-agent-names').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('machine-agent-names-save').disabled).toBe(true);
  });

  it('round-trips the allowlist', async () => {
    let names: string[] = ['CI_REGION'];
    const current = () => ({
      ok: true as const,
      value: { pairings: [PAIRING], paired: true, allowedSystemNames: names },
    });
    const status = vi.fn(() => Promise.resolve(current()));
    const setAllowedSystemNames = vi.fn((request: { names: string[] }) => {
      names = request.names;
      return Promise.resolve(current());
    });
    installWirebenchApi({ machineAgent: { status, setAllowedSystemNames } });
    render(<PairedBrowsersSection />);
    const input = screen.getByTestId<HTMLInputElement>('machine-agent-names');
    await waitFor(() => expect(input.value).toBe('CI_REGION'));
    await userEvent.clear(input);
    await userEvent.type(input, 'CI_REGION, BUILD_ID');
    await userEvent.click(screen.getByTestId('machine-agent-names-save'));
    expect(setAllowedSystemNames).toHaveBeenCalledWith({ names: ['CI_REGION', 'BUILD_ID'] });
    cleanup();
    render(<PairedBrowsersSection />);
    await waitFor(() =>
      expect(screen.getByTestId<HTMLInputElement>('machine-agent-names').value).toBe('CI_REGION, BUILD_ID'),
    );
  });

  it('splits names on commas, spaces and new lines', () => {
    expect(parseNames(' A_1,B\n C  ,,')).toEqual(['A_1', 'B', 'C']);
  });
});
