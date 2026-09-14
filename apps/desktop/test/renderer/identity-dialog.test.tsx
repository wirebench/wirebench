import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdentityDialog } from '../../src/renderer/features/sync/identity-dialog.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('IdentityDialog', () => {
  beforeEach(() => {
    useSyncStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useSyncStore.getState().reset();
  });

  it('is closed until identityNeeded is set', () => {
    installWirebenchApi();
    render(<IdentityDialog />);
    expect(screen.queryByTestId('sync-identity-dialog')).toBeNull();
  });

  it('opens when identityNeeded is set, with a title and named fields', () => {
    installWirebenchApi();
    useSyncStore.setState({ identityNeeded: true });
    render(<IdentityDialog />);

    expect(screen.getByTestId('sync-identity-dialog')).toBeTruthy();
    expect(screen.getByText('Set up your identity')).toBeTruthy();
    expect(screen.getByTestId('sync-identity-name')).toBeTruthy();
    expect(screen.getByTestId('sync-identity-email')).toBeTruthy();
  });

  it('disables submit until both name and email are non-empty, then submits both', async () => {
    const setIdentity = vi.fn().mockResolvedValue({ ok: true, value: { status: undefined } });
    installWirebenchApi({ sync: { setIdentity } });
    useSyncStore.setState({ identityNeeded: true });
    render(<IdentityDialog />);

    const submit = screen.getByTestId('sync-identity-submit');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await userEvent.type(screen.getByTestId('sync-identity-name'), 'Ada Lovelace');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await userEvent.type(screen.getByTestId('sync-identity-email'), 'ada@example.test');
    expect(submit.hasAttribute('disabled')).toBe(false);

    await userEvent.click(submit);
    await waitFor(() => expect(setIdentity).toHaveBeenCalledWith({ name: 'Ada Lovelace', email: 'ada@example.test' }));
  });
});
