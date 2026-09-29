// apps/desktop/test/renderer/tokens-section.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TokensSection } from '../../src/renderer/features/preferences/sections/tokens-section.js';
import { useCiTokensStore } from '../../src/renderer/state/ci-tokens.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const SERVER = { url: 'https://wb.example.test', workspaceId: '01K000000000000000000000W1' };
const CI_TOKEN = 'wbs_fake_test_token_000000000000000000000000000';
const SUMMARY = {
  id: '01K000000000000000000000T1',
  name: 'pipeline-main',
  createdBy: 'Ada',
  createdAt: '2026-09-29T10:00:00.000Z',
  lastUsedAt: null,
};
const NIGHTLY = { ...SUMMARY, id: '01K000000000000000000000T2', name: 'nightly' };
const ok = <T,>(value: T) => ({ ok: true as const, value });

const list = vi.fn();
const create = vi.fn();
const revoke = vi.fn();
const writeText = vi.fn();

/** Clicks, then lets the store's IPC promises settle. */
async function clickSettled(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** `null` mounts with no linked server (an explicit `undefined` would take the default). */
function mount(role: 'viewer' | 'editor' | 'admin', server: typeof SERVER | null = SERVER): void {
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({ server: server ?? undefined });
  render(<TokensSection />);
}

beforeEach(() => {
  list.mockReset().mockResolvedValue(ok({ tokens: [SUMMARY] }));
  create.mockReset().mockResolvedValue(ok({ id: NIGHTLY.id, name: 'nightly', token: CI_TOKEN }));
  revoke.mockReset().mockResolvedValue(ok({ revoked: true }));
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  installWirebenchApi({ ciTokens: { list, create, revoke } });
});

afterEach(() => {
  cleanup();
  useCiTokensStore.getState().reset();
  useWebhooksStore.setState({ server: undefined });
  useSyncStore.getState().reset();
});

describe('Preferences → Devices & tokens (callback-assertion §5)', () => {
  it('asks for a server workspace first', () => {
    mount('editor', null);
    expect(screen.getByTestId('tokens-unlinked')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('tells a viewer only editors and admins manage CI tokens', () => {
    mount('viewer');
    expect(screen.getByTestId('tokens-read-only')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('lists, creates a once-visible token, and revokes after a confirm', async () => {
    mount('editor');
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
    expect(list).toHaveBeenCalledWith(SERVER);
    expect(screen.getByTestId('ci-token-row').textContent).toContain('pipeline-main');
    expect(screen.getByTestId('ci-token-row').textContent).toContain('never used');

    expect(screen.getByTestId('ci-token-create').textContent).toBe('Create CI token…');
    fireEvent.click(screen.getByTestId('ci-token-create'));
    expect(screen.getByLabelText('Token name')).toBe(screen.getByTestId('ci-token-name'));
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: '  nightly ' } });
    list.mockResolvedValue(ok({ tokens: [SUMMARY, NIGHTLY] }));
    await clickSettled('ci-token-create-submit');
    expect(create).toHaveBeenCalledWith({ ...SERVER, name: 'nightly' });
    expect(screen.getByTestId<HTMLInputElement>('ci-token-value').value).toBe(CI_TOKEN);
    await clickSettled('ci-token-copy');
    expect(writeText).toHaveBeenCalledWith(CI_TOKEN);
    fireEvent.click(screen.getByTestId('ci-token-done'));
    expect(screen.queryByTestId('ci-token-created')).toBeNull();
    expect(JSON.stringify(useCiTokensStore.getState())).not.toContain(CI_TOKEN);
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId('ci-token-revoke')[0]!);
    list.mockResolvedValue(ok({ tokens: [NIGHTLY] }));
    await clickSettled('ci-token-revoke-confirm');
    expect(revoke).toHaveBeenCalledWith({ ...SERVER, tokenId: SUMMARY.id });
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
  });

  it('drops a new token’s value when the section closes without Done', async () => {
    mount('editor');
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('ci-token-create'));
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: 'nightly' } });
    await clickSettled('ci-token-create-submit');
    expect(screen.getByTestId('ci-token-created')).toBeTruthy();
    cleanup();
    expect(JSON.stringify(useCiTokensStore.getState())).not.toContain(CI_TOKEN);
  });

  it('shows the server’s refusal of a taken name', async () => {
    create.mockResolvedValue({
      ok: false,
      error: { code: 'ci-token-name-taken', message: 'A CI token named "nightly" already exists.' },
    });
    mount('admin');
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('ci-token-create'));
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: 'nightly' } });
    await clickSettled('ci-token-create-submit');
    expect(screen.getByRole('alert').textContent).toBe('A CI token named "nightly" already exists.');
    expect(screen.queryByTestId('ci-token-created')).toBeNull();
  });
});
