import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const connect = vi.fn();
const trustHostKey = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect, trustHostKey } }) }));
import { TrustDialog } from '../../src/renderer/features/ssh/trust-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const BASE = {
  hostId: 'a',
  size: { cols: 80, rows: 24 },
  host: 'h:22',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:new',
};

beforeEach(() => {
  connect.mockReset().mockResolvedValue({ ok: true, value: { sessionId: 's1' } });
  trustHostKey.mockReset().mockResolvedValue({ ok: true, value: {} });
  useHostsStore.setState({ sessions: {}, trustPrompt: null });
});
afterEach(cleanup);

it('renders nothing without a prompt', () => {
  render(<TrustDialog />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('a first-seen key shows its fingerprint and trusts on click', async () => {
  useHostsStore.setState({ trustPrompt: BASE });
  render(<TrustDialog />);
  expect(screen.getByText('SHA256:new')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
  expect(trustHostKey).toHaveBeenCalledWith({
    host: 'h:22',
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:new',
    replace: false,
  });
  expect(connect).toHaveBeenCalledTimes(1);
});

it('a changed key shows both fingerprints and needs the checkbox before it replaces', async () => {
  useHostsStore.setState({ trustPrompt: { ...BASE, previous: 'SHA256:old' } });
  render(<TrustDialog />);
  expect(screen.getByText(/has changed/)).toBeDefined();
  expect(screen.getByText('SHA256:new')).toBeDefined();
  expect(screen.getByText('SHA256:old')).toBeDefined();
  const replace = screen.getByRole<HTMLButtonElement>('button', { name: 'Replace key and connect' });
  expect(replace.disabled).toBe(true);
  await userEvent.click(screen.getByRole('checkbox', { name: 'I understand the key changed' }));
  expect(replace.disabled).toBe(false);
  await userEvent.click(replace);
  expect(trustHostKey).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
});

it('Cancel dismisses the prompt without trusting', async () => {
  useHostsStore.setState({ trustPrompt: BASE });
  render(<TrustDialog />);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(useHostsStore.getState().trustPrompt).toBeNull();
  expect(trustHostKey).not.toHaveBeenCalled();
});

it('a new key has no checkbox and confirms with replace false', async () => {
  useHostsStore.setState({ trustPrompt: BASE });
  render(<TrustDialog />);
  expect(screen.queryByRole('checkbox')).toBeNull();
  const trust = screen.getByRole<HTMLButtonElement>('button', { name: 'Trust and connect' });
  expect(trust.disabled).toBe(false);
  await userEvent.click(trust);
  expect(trustHostKey).toHaveBeenCalledWith(expect.objectContaining({ replace: false }));
});

it('a replacement prompt starts with the checkbox unticked', async () => {
  useHostsStore.setState({ trustPrompt: { ...BASE, previous: 'SHA256:old' } });
  render(<TrustDialog />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'I understand the key changed' }));
  act(() => {
    useHostsStore.setState({ trustPrompt: { ...BASE, fingerprint: 'SHA256:newer', previous: 'SHA256:old' } });
  });
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'I understand the key changed' }).checked).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Replace key and connect' }).disabled).toBe(true);
});
