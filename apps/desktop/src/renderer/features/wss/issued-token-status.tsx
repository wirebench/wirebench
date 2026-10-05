/**
 * The cached issued token of one issued-token entry: whether the session holds one, until when, and
 * the two buttons that change that. Every call names the entry (and the request it is fetched for),
 * never the token service: main reads the entry from its own model, so the renderer cannot point a
 * fetch at another service with the user's credentials.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import type { IssuedTokenStatusWire } from '../../../shared/wire-types.js';

export interface IssuedTokenStatusProps {
  readonly projectId: string;
  readonly configId: string;
  readonly entryIndex: number;
  /**
   * The request whose send this token is for. Given, status and fetch use that request's cache key,
   * so the line agrees with what its send holds; absent, main picks the first request that selects
   * the configuration.
   */
  readonly requestId?: string | undefined;
}

/** `Valid until 14:32 · SAML 2.0 · bearer`, `Expired` or `No token cached`. */
export function statusLine(status: IssuedTokenStatusWire | undefined): string {
  if (status === undefined || status.state === 'none') {
    return 'No token cached';
  }
  if (status.state === 'expired') {
    return 'Expired';
  }
  const at = status.expiresAt === undefined ? Number.NaN : Date.parse(status.expiresAt);
  const until = Number.isNaN(at)
    ? undefined
    : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [
    until === undefined ? 'Valid' : `Valid until ${until}`,
    status.samlVersion === undefined ? undefined : `SAML ${status.samlVersion}`,
    status.keyType,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}

export function IssuedTokenStatus({ projectId, configId, entryIndex, requestId }: IssuedTokenStatusProps) {
  const [status, setStatus] = useState<IssuedTokenStatusWire | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const locator = {
    projectId,
    configId,
    entryIndex,
    ...(requestId !== undefined ? { requestId } : {}),
  };
  const key = `${projectId}\u0000${configId}\u0000${String(entryIndex)}\u0000${requestId ?? ''}`;

  const read = useCallback(async (): Promise<void> => {
    const result = await ipc().issuedTokens.status({
      projectId,
      configId,
      entryIndex,
      ...(requestId !== undefined ? { requestId } : {}),
    });
    if (result.ok) {
      setStatus(result.value);
    }
    // A failure is "this entry is not saved yet" or "the request does not select it": the line
    // stays at its last answer rather than shouting about an editor state.
  }, [projectId, configId, entryIndex, requestId]);

  useEffect(() => {
    void read();
    // `key` stands for the locator's parts, which `read` already depends on.
  }, [read, key]);

  async function onFetch(): Promise<void> {
    setBusy(true);
    try {
      const result = await ipc().issuedTokens.fetch(locator);
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
    const result = await ipc().issuedTokens.clear(locator);
    if (result.ok) {
      setStatus(result.value);
    }
  }

  return (
    <div
      data-testid="issued-token-status"
      className="mt-1 flex flex-col gap-1 rounded border border-hairline-strong p-2"
    >
      <p className="text-xs text-fg-default">
        <span data-testid="issued-token-state">{statusLine(status)}</span>
        {status?.stsHost !== undefined && <span className="text-fg-subtle"> · {status.stsHost}</span>}
      </p>
      {status?.lastError !== undefined && (
        <p data-testid="issued-token-error" className="text-xs text-status-danger">
          {status.lastError} See the STS row in the HTTP Log.
        </p>
      )}
      {status?.assertion !== undefined && (
        <p data-testid="issued-token-assertion" className="truncate font-mono text-xs text-fg-subtle">
          {status.assertion}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <Button data-testid="issued-token-fetch" disabled={busy} onClick={() => void onFetch()}>
          {busy ? 'Fetching…' : 'Fetch now'}
        </Button>
        <Button
          variant="secondary"
          data-testid="issued-token-clear"
          disabled={status === undefined || status.state === 'none'}
          onClick={() => void onClear()}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
