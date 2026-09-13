/**
 * The OAuth2 token panel.
 *
 * The properties worth pinning: every call names the owner and nothing else (so no caller can point
 * the app at another issuer with the user's client secret), the access token appears only when main
 * chose to include it, and the redirect URI is shown for the grant that actually needs it registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OAuth2StatusPanel, expiryLabel } from '../../src/renderer/features/rest-editor/oauth2-status.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const status = vi.fn();
const fetchToken = vi.fn();
const clearToken = vi.fn();
const cancel = vi.fn();

const NONE = { state: 'none' as const, redirectUri: 'http://127.0.0.1:51789/callback' };

beforeEach(() => {
  status.mockReset().mockResolvedValue({ ok: true, value: NONE });
  fetchToken.mockReset();
  clearToken.mockReset();
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  installWirebenchApi({ oauth2: { status, fetchToken, clearToken, cancel } });
});

afterEach(() => {
  cleanup();
});

describe('expiryLabel', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('reads as seconds, minutes or hours, whichever a person would say', () => {
    expect(expiryLabel('2026-01-01T00:00:45.000Z', now)).toBe('expires in 45s');
    expect(expiryLabel('2026-01-01T00:10:00.000Z', now)).toBe('expires in 10 min');
    expect(expiryLabel('2026-01-01T03:00:00.000Z', now)).toBe('expires in 3 h');
  });

  it('says expired rather than counting backwards, and nothing at all without an expiry', () => {
    expect(expiryLabel('2025-12-31T23:00:00.000Z', now)).toBe('expired');
    expect(expiryLabel(undefined, now)).toBeUndefined();
    expect(expiryLabel('not a date', now)).toBeUndefined();
  });
});

describe('OAuth2StatusPanel', () => {
  it('asks for the owner’s status on mount, and nothing else', async () => {
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);

    await waitFor(() => {
      expect(status).toHaveBeenCalledWith({ ownerId: 'api-1' });
    });
    expect(screen.getByTestId('oauth2-state').textContent).toBe('No token yet');
  });

  it('gets a token by naming the owner, and shows what came back', async () => {
    fetchToken.mockResolvedValue({
      ok: true,
      value: {
        state: 'valid',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['read'],
        redirectUri: NONE.redirectUri,
      },
    });
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);

    await userEvent.click(screen.getByTestId('oauth2-get-token'));

    expect(fetchToken).toHaveBeenCalledWith({ ownerId: 'api-1' });
    await waitFor(() => {
      expect(screen.getByTestId('oauth2-state').textContent).toBe('Token held');
    });
    expect(screen.getByText(/expires in 60 min/)).toBeTruthy();
    expect(screen.getByText(/read/)).toBeTruthy();
  });

  it('says a token is held without showing it, while show-secrets is off', async () => {
    status.mockResolvedValue({ ok: true, value: { ...NONE, state: 'valid' } });
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);

    await waitFor(() => {
      expect(screen.getByTestId('oauth2-state').textContent).toBe('Token held');
    });
    // Main sent no token, so there is nothing here to leak.
    expect(screen.queryByTestId('oauth2-token')).toBeNull();
  });

  it('shows the token itself when main included it, which it does only under show-secrets', async () => {
    status.mockResolvedValue({ ok: true, value: { ...NONE, state: 'valid', token: 'at-1234' } });
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);

    await waitFor(() => {
      expect(screen.getByTestId('oauth2-token').textContent).toBe('at-1234');
    });
  });

  it('shows the redirect URI only for the grant that needs one registered', async () => {
    const { rerender } = render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);
    await waitFor(() => {
      expect(screen.getByTestId('oauth2-state')).toBeTruthy();
    });
    expect(screen.queryByTestId('oauth2-redirect-uri')).toBeNull();

    rerender(<OAuth2StatusPanel ownerId="api-1" grant="authorization-code" />);
    await waitFor(() => {
      expect(screen.getByTestId('oauth2-redirect-uri').textContent).toBe(NONE.redirectUri);
    });
  });

  it('clears a token it holds, and cannot clear one it does not', async () => {
    status.mockResolvedValue({ ok: true, value: { ...NONE, state: 'valid' } });
    clearToken.mockResolvedValue({ ok: true, value: NONE });
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('oauth2-clear-token').disabled).toBe(false);
    });
    await userEvent.click(screen.getByTestId('oauth2-clear-token'));

    expect(clearToken).toHaveBeenCalledWith({ ownerId: 'api-1' });
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('oauth2-clear-token').disabled).toBe(true);
    });
  });

  it('offers Cancel while a browser round trip is pending', async () => {
    status.mockResolvedValue({ ok: true, value: { ...NONE, state: 'pending' } });
    render(<OAuth2StatusPanel ownerId="api-1" grant="authorization-code" />);

    await waitFor(() => {
      expect(screen.getByTestId('oauth2-state').textContent).toBe('Waiting for the browser…');
    });
    expect(screen.queryByTestId('oauth2-get-token')).toBeNull();

    await userEvent.click(screen.getByTestId('oauth2-cancel'));
    expect(cancel).toHaveBeenCalledWith({ ownerId: 'api-1' });
  });

  it('shows no token after a failed grant, and re-reads what the owner actually holds', async () => {
    fetchToken.mockResolvedValue({ ok: false, error: { code: 'oauth2-token-failed', message: 'invalid_client' } });
    render(<OAuth2StatusPanel ownerId="api-1" grant="client-credentials" />);
    await waitFor(() => {
      expect(status).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByTestId('oauth2-get-token'));

    // The message reaches the user as a toast; what matters here is that nothing was invented.
    await waitFor(() => {
      expect(status).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('oauth2-state').textContent).toBe('No token yet');
    expect(screen.queryByTestId('oauth2-token')).toBeNull();
  });
});
