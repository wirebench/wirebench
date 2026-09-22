/**
 * The request pane's Auth inspector: how this request authenticates, and — when it defines
 * nothing itself — where the credentials it will actually send come from (its endpoint, or its
 * interface).
 *
 * The request's own credentials are the shared {@link AuthFields} form, offering every scheme a SOAP
 * owner can hold ({@link SOAP_AUTH_TYPES}). One form rather than an inspector-specific one because a
 * narrower copy is how a Bearer request came to open as Basic and lose its token on the first edit:
 * a form must be able to show whatever the request already holds. No secret lives here — each is a
 * `secretRef` into the main-process store.
 */

import { useEffect, useState } from 'react';
import { AuthFields, asSoapAuth, SOAP_AUTH_TYPES } from '../../../components/auth-fields.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import { OAuth2StatusPanel } from '../../rest-editor/oauth2-status.js';
import type { RequestAuthSourceWire } from '../../../../shared/wire-types.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

export interface AuthInspectorProps {
  readonly requestId: string;
}

/** Human sentence for the level the effective credentials come from. */
function sourceLabel(auth: RequestAuthSourceWire): string {
  switch (auth.source) {
    case 'endpoint':
      return `Using endpoint '${auth.endpointName ?? ''}' credentials (${auth.authMode ?? 'override'})`;
    case 'interface':
      return 'Using the interface credentials';
    case 'request':
      return 'Using this request’s own credentials';
    case 'folder':
      return 'Using the folder’s credentials';
    case 'api':
      return 'Using the API’s credentials';
    case 'none':
      return 'No credentials are configured for this request.';
  }
}

export function AuthInspector({ requestId }: AuthInspectorProps) {
  const auth = useProjectStore((state) => state.requests[requestId]?.auth);
  const exists = useProjectStore((state) => state.requests[requestId] !== undefined);
  const updateRequestAuth = useProjectStore((state) => state.updateRequestAuth);
  const [effective, setEffective] = useState<RequestAuthSourceWire | undefined>(undefined);

  // The inherited-source line comes from the main process's preflight, which is the one place
  // that knows the endpoint/interface fallbacks — and it answers without any secret in it.
  useEffect(() => {
    let cancelled = false;
    void ipc()
      .request.preflight({ requestId })
      .then((result) => {
        if (!cancelled && result.ok) {
          setEffective(result.value.auth);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, auth]);

  if (!exists) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const inherit = auth === undefined;

  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <label className="flex items-center gap-2 text-fg-default">
        <input
          type="checkbox"
          data-testid="auth-inherit"
          checked={inherit}
          onChange={(event) => {
            updateRequestAuth(requestId, event.target.checked ? null : { type: 'basic', preemptive: true });
          }}
        />
        Use endpoint/interface default
      </label>

      {inherit ? (
        <p className="text-xs text-fg-subtle" data-testid="auth-effective">
          {effective !== undefined ? sourceLabel(effective) : 'Resolving credentials…'}
        </p>
      ) : (
        <>
          <AuthFields
            scope="Request"
            types={SOAP_AUTH_TYPES}
            auth={auth}
            oauth2Status={
              auth.type === 'oauth2' ? <OAuth2StatusPanel ownerId={requestId} grant={auth.grant} /> : undefined
            }
            onChange={(next) => {
              updateRequestAuth(requestId, asSoapAuth(next));
            }}
          />
          {(auth.type === 'basic' || auth.type === 'ntlm') && (
            <p className="text-xs text-fg-faint">
              Property expansions such as <code>{'${#Env#user}'}</code> work in the username.
            </p>
          )}
        </>
      )}

      <WssSelectors requestId={requestId} />
    </div>
  );
}

/**
 * The request's WS-Security configuration selectors. Choosing one here means "apply it at send
 * time": the saved envelope is untouched, and the header is built (with the real password,
 * resolved in main) on its way to the wire. The editor actions in the request context menu are
 * the other half — they bake a header into the envelope *text* instead.
 *
 * A ref the registry no longer has stays selectable in either list, so it is visible rather
 * than silently reset to "none" the moment the request is opened.
 */
function WssSelectors({ requestId }: { readonly requestId: string }) {
  const outgoingRef = useProjectStore((state) => state.requests[requestId]?.wssOutgoingRef);
  const incomingRef = useProjectStore((state) => state.requests[requestId]?.wssIncomingRef);
  const configs = useProjectStore((state) => state.wssOutgoing);
  const incomingConfigs = useProjectStore((state) => state.wssIncoming);
  // Written through, not staged: main resolves a request's WS-Security configuration from its
  // own model when it secures the envelope at send time, so a reference left sitting in a draft
  // would simply not be there — the request would go out unsecured with no sign of why.
  const updateRequest = useProjectStore((state) => state.updateRequest);

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-hairline pt-2">
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-xs text-fg-subtle">Outgoing WSS</span>
        <select
          aria-label="Outgoing WSS"
          data-testid="request-wss-outgoing"
          className={INPUT_CLASS}
          value={outgoingRef ?? ''}
          onChange={(event) => {
            updateRequest(requestId, { wssOutgoingRef: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">—</option>
          {configs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name}
            </option>
          ))}
          {/* A ref the registry no longer has stays selectable, so it is visible rather than
              silently reset to "none" the moment the request is opened. */}
          {outgoingRef !== undefined && !configs.some((config) => config.id === outgoingRef) && (
            <option value={outgoingRef}>{`${outgoingRef} (missing)`}</option>
          )}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-xs text-fg-subtle">Incoming WSS</span>
        <select
          aria-label="Incoming WSS"
          data-testid="request-wss-incoming"
          className={INPUT_CLASS}
          value={incomingRef ?? ''}
          onChange={(event) => {
            updateRequest(requestId, { wssIncomingRef: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">—</option>
          {incomingConfigs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name}
            </option>
          ))}
          {incomingRef !== undefined && !incomingConfigs.some((config) => config.id === incomingRef) && (
            <option value={incomingRef}>{`${incomingRef} (missing)`}</option>
          )}
        </select>
      </label>
    </div>
  );
}
