/**
 * The WebSocket editor's top strip: where the session goes, its state, and the one button that
 * moves it on — **Connect** when there is no session, **Cancel** while the handshake runs,
 * **Disconnect** while it is open.
 *
 * The URL is not edited here: it is the request's path joined to the API's server URL, which an
 * environment may override, so the strip shows the address main resolved and where it came from
 * (the same dry run the gRPC strip's target uses). A close carries a code and a reason; the chevron
 * beside Disconnect opens both, checked the way the protocol checks them — a code a client may
 * send is 1000 or 3000–4999, and a reason is at most 123 bytes, counted as UTF-8 bytes rather than
 * characters because that is what fits in the frame.
 */
import { useState } from 'react';
import { ChevronDown, Plug, Square, Unplug } from 'lucide-react';
import { Button } from '../../components/button.js';
import { TrustInvalidBadge } from '../../components/trust-invalid-badge.js';
import type { WsExchangeState } from '../../state/exchanges.js';
import { isSendableCloseCode, MAX_CLOSE_REASON_BYTES, utf8Length } from './ws-format.js';

export interface WsConnectBarProps {
  /** The URL the session would dial, and where it came from. Absent while unknown. */
  readonly url?: string | undefined;
  readonly urlSource?: string | undefined;
  /** Why the URL could not be resolved, when it could not. */
  readonly urlProblem?: string | undefined;
  readonly status: WsExchangeState['status'] | undefined;
  /** The code the last session closed with, for the `closed 1000` chip. */
  readonly closeCode?: number | undefined;
  readonly trustInvalid?: boolean;
  readonly onConnect: () => void;
  readonly onCancel: () => void;
  readonly onDisconnect: (code: number, reason: string) => void;
  readonly connectShortcut?: string | undefined;
}

const CHIP_TONE: Readonly<Record<string, string>> = {
  connecting: 'text-status-warning',
  open: 'text-status-success',
  closing: 'text-status-warning',
  closed: 'text-fg-subtle',
  failed: 'text-status-danger',
};

/** The words on the state chip, or `undefined` before the first session. */
export function wsStateLabel(status: WsExchangeState['status'] | undefined, closeCode?: number): string | undefined {
  switch (status) {
    case undefined:
    case 'idle':
      return undefined;
    case 'connecting':
    case 'open':
    case 'closing':
      return status;
    case 'closed':
      return closeCode === undefined ? 'closed' : `closed ${String(closeCode)}`;
    case 'error':
      return 'failed';
  }
}

/** The URL, state and Connect / Cancel / Disconnect strip. */
export function WsConnectBar({
  url,
  urlSource,
  urlProblem,
  status,
  closeCode,
  trustInvalid = false,
  onConnect,
  onCancel,
  onDisconnect,
  connectShortcut,
}: WsConnectBarProps) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [codeText, setCodeText] = useState('1000');
  const [reason, setReason] = useState('');

  const code = Number(codeText);
  const codeOk = codeText.trim() !== '' && isSendableCloseCode(code);
  const reasonBytes = utf8Length(reason);
  const reasonOk = reasonBytes <= MAX_CLOSE_REASON_BYTES;
  const label = wsStateLabel(status, closeCode);
  const chipKey = status === 'error' ? 'failed' : (status ?? 'idle');

  const disconnect = (): void => {
    if (!codeOk || !reasonOk) return;
    setOptionsOpen(false);
    onDisconnect(code, reason);
  };

  let action;
  if (status === 'connecting') {
    action = (
      <Button variant="secondary" data-testid="ws-connect" onClick={onCancel} title="Cancel (Esc)">
        <Square size={12} aria-hidden="true" />
        Cancel
      </Button>
    );
  } else if (status === 'open' || status === 'closing') {
    action = (
      <div className="relative flex shrink-0 items-center">
        <Button
          variant="secondary"
          data-testid="ws-connect"
          disabled={status === 'closing' || !codeOk || !reasonOk}
          onClick={disconnect}
          className="rounded-r-none"
        >
          <Unplug size={12} aria-hidden="true" />
          Disconnect
        </Button>
        <Button
          variant="secondary"
          aria-label="Close code and reason"
          aria-expanded={optionsOpen}
          aria-controls="ws-close-options"
          disabled={status === 'closing'}
          onClick={() => {
            setOptionsOpen((was) => !was);
          }}
          className="rounded-l-none border-l-0 px-1"
        >
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
        {optionsOpen && (
          <div
            id="ws-close-options"
            role="group"
            aria-label="Close code and reason"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setOptionsOpen(false);
              }
            }}
            className="absolute top-full right-0 z-20 mt-1 flex w-64 flex-col gap-2 rounded-md border border-hairline-strong bg-surface-overlay p-2 text-xs shadow-lg"
          >
            <label className="flex flex-col gap-0.5 text-fg-muted">
              Code
              <input
                type="number"
                aria-invalid={!codeOk}
                aria-describedby={codeOk ? undefined : 'ws-close-code-problem'}
                value={codeText}
                onChange={(event) => {
                  setCodeText(event.target.value);
                }}
                className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
              />
            </label>
            {!codeOk && (
              <p id="ws-close-code-problem" className="text-status-danger">
                1000, or 3000–4999
              </p>
            )}
            <label className="flex flex-col gap-0.5 text-fg-muted">
              Reason
              <input
                type="text"
                aria-invalid={!reasonOk}
                aria-describedby="ws-close-reason-count"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
                className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
              />
            </label>
            <p id="ws-close-reason-count" className={reasonOk ? 'text-fg-subtle' : 'text-status-danger'}>
              {`${String(reasonBytes)} of ${String(MAX_CLOSE_REASON_BYTES)} bytes`}
            </p>
          </div>
        )}
      </div>
    );
  } else {
    action = (
      <Button
        variant="primary"
        data-testid="ws-connect"
        onClick={onConnect}
        {...(connectShortcut !== undefined ? { title: `Connect (${connectShortcut})` } : {})}
      >
        <Plug size={12} aria-hidden="true" />
        Connect
      </Button>
    );
  }

  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
      <span
        data-testid="ws-url"
        title={urlSource === undefined ? undefined : `From the ${urlSource}`}
        className={`min-w-0 flex-1 truncate font-mono text-sm ${
          urlProblem !== undefined ? 'text-status-danger' : 'text-fg-default'
        }`}
      >
        {urlProblem ?? (url === undefined || url === '' ? 'No URL — set one on the API or the request' : url)}
      </span>
      {urlSource !== undefined && urlProblem === undefined && (
        <span
          data-testid="ws-url-source"
          className="shrink-0 rounded-sm border border-hairline px-1 text-2xs text-fg-subtle"
        >
          {urlSource}
        </span>
      )}
      {trustInvalid && <TrustInvalidBadge compact />}
      {label !== undefined && (
        <span
          role="status"
          data-testid="ws-state"
          className={`shrink-0 font-mono text-xs ${CHIP_TONE[chipKey] ?? 'text-fg-subtle'}`}
        >
          {label}
        </span>
      )}
      {action}
    </div>
  );
}
