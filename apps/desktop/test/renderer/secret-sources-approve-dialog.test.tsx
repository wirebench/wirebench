/** The approval dialog: what the shared mapping would let requests read, and the hash it was shown. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecretSourcesApproveDialog } from '../../src/renderer/features/secret-sources/approve-dialog.js';
import { openSecretSourcesApproval } from '../../src/renderer/features/secret-sources/actions.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { SecretSourcesState } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const HASH = 'a'.repeat(64);
const UNTRUSTED: SecretSourcesState = {
  open: true,
  entries: [
    { name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: false },
    { name: 'pw', origin: 'local', kind: 'keychain', fields: { service: 'only-local' }, overridden: false },
    { name: 'bad', origin: 'shared', kind: 'invalid', fields: {}, reason: 'unknown field "extra"', overridden: false },
  ],
  hash: HASH,
  trusted: false,
  changes: [
    { name: 'db', change: 'changed' },
    { name: 'old', change: 'removed' },
  ],
};

const get = vi.fn();
const approve = vi.fn();

function open(): void {
  act(() => {
    openSecretSourcesApproval();
  });
}

beforeEach(() => {
  get.mockReset().mockResolvedValue({ ok: true, value: UNTRUSTED });
  approve.mockReset();
  installWirebenchApi({ secretSources: { get, approve } });
  useUiStore.setState({ secretSourcesApproval: false });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ secretSourcesApproval: false });
});

describe('SecretSourcesApproveDialog', () => {
  it('lists the shared entries with their changes and approves the hash it showed', async () => {
    approve.mockResolvedValue({ ok: true, value: { ...UNTRUSTED, trusted: true, changes: [] } });
    render(<SecretSourcesApproveDialog />);
    open();
    expect(await screen.findByText('changed')).toBeTruthy();
    expect(screen.getByText('removed')).toBeTruthy();
    expect(screen.getByText('old')).toBeTruthy();
    expect(screen.getByText('kv/app')).toBeTruthy();
    // A local entry is not what is being approved; an invalid shared one is shown with its reason.
    expect(screen.queryByText('only-local')).toBeNull();
    expect(screen.getByText('Invalid: unknown field "extra"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve.mock.calls).toEqual([[{ hash: HASH }]]));
    await waitFor(() => expect(useUiStore.getState().secretSourcesApproval).toBe(false));
  });

  it('reloads and says so when the mapping changed under the review', async () => {
    approve.mockResolvedValue({ ok: false, error: { code: 'secret-source-approval-stale', message: 'stale' } });
    render(<SecretSourcesApproveDialog />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The shared secret sources changed while you were reviewing them.')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().secretSourcesApproval).toBe(true);
  });

  it('shows another approval error as it is', async () => {
    approve.mockResolvedValue({ ok: false, error: { code: 'x', message: 'disk full' } });
    render(<SecretSourcesApproveDialog />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('disk full')).toBeTruthy();
  });

  it('cannot approve when there is no shared mapping', async () => {
    get.mockResolvedValue({ ok: true, value: { open: true, entries: [], trusted: true, changes: [] } });
    render(<SecretSourcesApproveDialog />);
    open();
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Approve' })).disabled).toBe(true);
  });

  it('cancels without approving', async () => {
    render(<SecretSourcesApproveDialog />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(approve).not.toHaveBeenCalled();
    expect(useUiStore.getState().secretSourcesApproval).toBe(false);
  });
});
