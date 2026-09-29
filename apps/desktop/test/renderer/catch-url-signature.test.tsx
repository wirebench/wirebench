// apps/desktop/test/renderer/catch-url-signature.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatchUrlSettingsDialog } from '../../src/renderer/features/webhooks/catch-url-settings-dialog.js';
import {
  signatureFormOf,
  signatureProblemOf,
  signatureRequestOf,
} from '../../src/renderer/features/webhooks/catch-url-signature.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CatchUrlWire } from '../../src/shared/wire-types.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HMAC = { kind: 'hmac' as const, algorithm: 'sha256' as const, encoding: 'hex' as const, header: 'X-Signature' };
const PLAIN: CatchUrlWire = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6H001',
  workspaceId: SERVER.workspaceId,
  name: 'Signed',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  signature: null,
  rejectUnverified: false,
  signatureAvailable: true,
};
const SIGNED: CatchUrlWire = {
  ...PLAIN,
  signature: { scheme: HMAC, secret: { set: true, hint: 'i789' } },
  rejectUnverified: true,
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp(role: 'viewer' | 'editor', hook: CatchUrlWire) {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [hook] })),
      update: vi.fn().mockResolvedValue(ok({ hook })),
    },
  });
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [hook],
    loaded: true,
  });
  render(<CatchUrlSettingsDialog />);
  act(() => useWebhooksDialogs.getState().openSettings(hook.id));
  return api;
}

afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false });
  useSyncStore.getState().reset();
  useEditorsStore.getState().reset();
});

describe('the Signature form (§4)', () => {
  it('sends nothing when nothing changed, a new secret only when typed, and null to clear', () => {
    const form = signatureFormOf(SIGNED);
    expect(signatureRequestOf(form, SIGNED)).toEqual({});
    expect(signatureRequestOf({ ...form, secret: 'abc123def456ghi789' }, SIGNED)).toEqual({
      signature: { scheme: HMAC, secret: 'abc123def456ghi789' },
    });
    expect(signatureRequestOf({ ...form, scheme: { kind: 'standard', toleranceSec: 300 } }, SIGNED)).toEqual({
      signature: { scheme: { kind: 'standard', toleranceSec: 300 } },
    });
    expect(signatureRequestOf({ ...form, scheme: null }, SIGNED)).toEqual({ signature: null });
    expect(signatureRequestOf({ ...form, rejectUnverified: false }, SIGNED)).toEqual({ rejectUnverified: false });
  });

  it('asks for a secret when none is stored, and bounds it', () => {
    const form = { ...signatureFormOf(PLAIN), scheme: HMAC };
    expect(signatureProblemOf(form, PLAIN)).toBe('Enter the secret the sender signs with.');
    expect(signatureProblemOf({ ...form, secret: 'x'.repeat(513) }, PLAIN)).toBe(
      'The secret is at most 512 characters.',
    );
    expect(signatureProblemOf({ ...form, secret: 'abc123def456ghi789' }, PLAIN)).toBeUndefined();
    expect(signatureProblemOf({ ...form, scheme: { ...HMAC, header: 'X Sig' }, secret: 'a' }, PLAIN)).toBe(
      'The header name has a character a header name cannot have.',
    );
  });
});

describe('the Signature section in the settings dialog (§4)', () => {
  it('sets a scheme and a secret as an editor', async () => {
    const api = setUp('editor', PLAIN);
    fireEvent.change(screen.getByTestId('catch-url-signature-scheme'), { target: { value: 'hmac' } });
    fireEvent.change(screen.getByTestId('catch-url-signature-secret'), { target: { value: 'abc123def456ghi789' } });
    fireEvent.click(screen.getByTestId('catch-url-reject-unverified'));
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          signature: { scheme: HMAC, secret: 'abc123def456ghi789' },
          rejectUnverified: true,
        }),
      ),
    );
  });

  it('shows only that a secret is set, and replaces it on request', () => {
    setUp('editor', SIGNED);
    expect(screen.getByTestId('catch-url-signature-secret-set').textContent).toBe('● set …i789');
    expect(screen.queryByTestId('catch-url-signature-secret')).toBeNull();
    fireEvent.click(screen.getByTestId('catch-url-signature-replace'));
    expect(screen.getByTestId('catch-url-signature-secret')).toBeTruthy();
  });

  it('is read only for a viewer, with no hint', () => {
    setUp('viewer', { ...SIGNED, signature: { scheme: HMAC, secret: { set: true, hint: null } } });
    expect(screen.getByTestId<HTMLSelectElement>('catch-url-signature-scheme').disabled).toBe(true);
    expect(screen.getByTestId('catch-url-signature-secret-set').textContent).toBe('● set');
    expect(screen.getByTestId('catch-url-signature-scheme')).toBeTruthy();
    expect(screen.queryByTestId('catch-url-signature-replace')).toBeNull();
  });

  it('treats a stored scheme that no longer parses (signature null) as None without crashing', () => {
    setUp('editor', { ...PLAIN, signature: null, rejectUnverified: false });
    expect(screen.getByTestId<HTMLSelectElement>('catch-url-signature-scheme').value).toBe('none');
    expect(screen.queryByTestId('catch-url-signature-secret-set')).toBeNull();
    expect(screen.queryByTestId('catch-url-signature-secret')).toBeNull();
  });

  it('sends nothing for the signature when only the name changed', async () => {
    const api = setUp('editor', SIGNED);
    fireEvent.change(screen.getByTestId('catch-url-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() => expect(api.hooks.update).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.hooks.update).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.name).toBe('Renamed');
    expect('signature' in sent).toBe(false);
    expect('rejectUnverified' in sent).toBe(false);
  });

  it('says why when the server has no key, and is absent on a server without the module', () => {
    setUp('editor', { ...PLAIN, signatureAvailable: false });
    expect(screen.getByTestId('catch-url-signature-unavailable').textContent).toContain(
      'WIREBENCH_SERVER_HOOKS_SECRET_KEY',
    );
    expect(screen.getByTestId<HTMLSelectElement>('catch-url-signature-scheme').disabled).toBe(true);
    cleanup();
    const older: CatchUrlWire = { ...PLAIN };
    delete older.signature;
    delete older.rejectUnverified;
    delete older.signatureAvailable;
    setUp('editor', older);
    expect(screen.getByTestId('catch-url-settings')).toBeTruthy();
    expect(screen.getByTestId('catch-url-name')).toBeTruthy();
    expect(screen.queryByTestId('catch-url-signature')).toBeNull();
  });
});
