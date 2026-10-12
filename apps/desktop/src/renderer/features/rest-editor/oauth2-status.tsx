/**
 * The OAuth2 token panel: what token this owner holds, and the two buttons that change that.
 *
 * Every call names the *owner* and nothing else. Main reads the configuration from its own model, so
 * the renderer never sends a token endpoint or a client-secret reference back — a channel that
 * accepted either would be a channel for pointing the app at somebody else's issuer with the user's
 * credentials.
 *
 * The access token itself is shown only when the session's show-secrets switch is on, which is the
 * same rule the Raw view and the redaction layer follow (ADR-0004). With it off the panel says a
 * token exists and when it expires, which is all anyone needs to debug a 401.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import type { AuthConfigWire, OAuth2StatusWire } from '../../../shared/wire-base.js';

export interface OAuth2StatusPanelProps {
  /** The API, folder or request whose configuration main should use. */
  readonly ownerId: string;
  /** The grant in force, which decides whether a browser round trip is part of getting a token. */
  readonly grant: AuthConfigWire['grant'];
}

/** How often the status is read again while Get token waits. */
const STATUS_POLL_MS = 1000;

/** How each state reads. */
const STATE_LABEL: Readonly<Record<OAuth2StatusWire['state'], string>> = {
  none: 'No token yet',
  valid: 'Token held',
  expired: 'Token expired',
  pending: 'Waiting for the browser…',
};

/** An expiry as something a person can read, relative to now. */
export function expiryLabel(expiresAt: string | undefined, now: number = Date.now()): string | undefined {
  if (expiresAt === undefined) {
    return undefined;
  }
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return undefined;
  }
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) {
    return 'expired';
  }
  if (seconds < 90) {
    return `expires in ${String(seconds)}s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `expires in ${String(minutes)} min` : `expires in ${String(Math.round(minutes / 60))} h`;
}

/** The panel. */
export function OAuth2StatusPanel({ ownerId, grant }: OAuth2StatusPanelProps) {
  const [status, setStatus] = useState<OAuth2StatusWire | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    const result = await ipc().oauth2.status({ ownerId });
    if (result.ok) {
      setStatus(result.value);
    }
    // A failure here is almost always "this owner does not use OAuth2 any more", which the panel
    // simply stops describing rather than shouting about.
  }, [ownerId]);

  useEffect(() => {
    void read();
  }, [read]);

  // A device sign-in only learns its code after Get token was pressed, and that call answers only
  // once the user has approved it: while it waits, the status is read again so the code appears.
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => void read(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, read]);

  async function onGetToken(): Promise<void> {
    setBusy(true);
    try {
      const result = await ipc().oauth2.fetchToken({ ownerId });
      if (result.ok) {
        setStatus(result.value);
      } else {
        showToast(result.error.message);
        await read();
      }
    } finally {
      setBusy(false);
    }
  }

  async function onClear(): Promise<void> {
    const result = await ipc().oauth2.clearToken({ ownerId });
    if (result.ok) {
      setStatus(result.value);
    }
  }

  async function onCancel(): Promise<void> {
    await ipc().oauth2.cancel({ ownerId });
    await read();
  }

  const expiry = expiryLabel(status?.expiresAt);
  const device = status?.device;
  const stateLabel =
    status?.state === 'pending' && device !== undefined
      ? 'Waiting for approval…'
      : STATE_LABEL[status?.state ?? 'none'];

  function onCopyCode(code: string): void {
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
      },
      () => {
        showToast('Could not copy the code');
      },
    );
  }

  return (
    <div data-testid="oauth2-status" className="mt-1 flex flex-col gap-1 rounded border border-hairline-strong p-2">
      <p className="text-xs text-fg-default">
        <span data-testid="oauth2-state">{stateLabel}</span>
        {expiry !== undefined && <span className="text-fg-subtle"> · {expiry}</span>}
        {status?.scopes !== undefined && status.scopes.length > 0 && (
          <span className="text-fg-subtle"> · {status.scopes.join(' ')}</span>
        )}
      </p>

      {/* Only ever present when the session's show-secrets switch is on: main decides, not this. */}
      {status?.token !== undefined && (
        <p data-testid="oauth2-token" className="truncate font-mono text-xs text-fg-subtle">
          {status.token}
        </p>
      )}

      {/* RFC 8628 §3.3: the code is what the user types, so it is large, monospace and selectable. */}
      {device !== undefined && (
        <div data-testid="oauth2-device" className="flex flex-col gap-1">
          <p className="text-xs text-fg-subtle">
            Enter this code at{' '}
            <code data-testid="oauth2-verification-uri" className="select-all">
              {device.verificationUri}
            </code>{' '}
            — the page was opened in your browser, or use any other device.
          </p>
          <div className="flex items-center gap-2">
            <span
              data-testid="oauth2-user-code"
              className="select-all font-mono text-lg tracking-widest text-fg-default"
            >
              {device.userCode}
            </span>
            <Button variant="secondary" data-testid="oauth2-copy-code" onClick={() => onCopyCode(device.userCode)}>
              {copied ? 'Copied' : 'Copy code'}
            </Button>
          </div>
        </div>
      )}

      {grant === 'authorization-code' && status?.redirectUri !== undefined && (
        <p className="text-xs text-fg-subtle">
          Register this redirect URI with your provider:{' '}
          <code data-testid="oauth2-redirect-uri">{status.redirectUri}</code>
          {/* Without a fixed port the listener takes a free one per flow, which RFC 8252 prefers but
              some providers refuse. Saying where to pin it turns the placeholder into an action. */}
          {status.redirectUri.includes('<random port>') &&
            ' — set a fixed callback port in Settings → REST if your provider needs an exact URI.'}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        {status?.state === 'pending' ? (
          <Button data-testid="oauth2-cancel" onClick={() => void onCancel()}>
            Cancel
          </Button>
        ) : (
          <Button data-testid="oauth2-get-token" disabled={busy} onClick={() => void onGetToken()}>
            {busy ? 'Getting…' : 'Get token'}
          </Button>
        )}
        <Button
          variant="secondary"
          data-testid="oauth2-clear-token"
          disabled={status === undefined || status.state === 'none'}
          onClick={() => void onClear()}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
