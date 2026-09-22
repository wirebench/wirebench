/**
 * The request pane's Auth inspector: how this request authenticates, and — when it defines
 * nothing itself — where the credentials it will actually send come from (its endpoint, or its
 * interface). A password never lives here: {@link SecretField} stores what is typed in the
 * main-process secret store and this component only ever holds the resulting `passwordRef`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SecretField } from '../../../components/secret-field.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProjectStore } from '../../../state/project.js';
import type { AuthConfigWire, EndpointAuthWire, RequestAuthSourceWire } from '../../../../shared/wire-types.js';

/** How long a typed username sits before it becomes a project mutation. */
const COMMIT_DEBOUNCE_MS = 300;

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

export interface AuthInspectorProps {
  readonly requestId: string;
}

/**
 * Narrows a wire auth row to its Basic/NTLM/none shape — what this inspector's form still edits.
 * A request whose own auth is a token scheme (Bearer/API-key/OAuth2) is edited here as if it were
 * unset; offering all six schemes in this inspector is a later task (see the owner-auth design's
 * D5), which replaces this form with `AuthFields`.
 */
function asEndpointAuthWire(auth: AuthConfigWire | undefined): EndpointAuthWire | undefined {
  if (auth === undefined || (auth.type !== 'none' && auth.type !== 'basic' && auth.type !== 'ntlm')) {
    return undefined;
  }
  return {
    type: auth.type,
    ...(auth.username !== undefined ? { username: auth.username } : {}),
    ...(auth.passwordRef !== undefined ? { passwordRef: auth.passwordRef } : {}),
    ...(auth.passwordEnv !== undefined ? { passwordEnv: auth.passwordEnv } : {}),
    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
    ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
    ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
  };
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
  const [username, setUsername] = useState(auth?.username ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The username debounce commits through this ref rather than closing over `patch` directly,
  // so the unmount cleanup below (registered once) always calls the *current* patch/pending
  // value instead of a stale one from whichever render first mounted the timer.
  const pendingUsername = useRef<string | undefined>(undefined);
  const patchRef = useRef<(next: Partial<EndpointAuthWire>) => void>(() => undefined);
  // The password's `secretRef` as last reported by `auth`, so the unmount flush below can tell
  // a fresh ref (something was typed but never saved) from the value SecretField already had.
  const passwordRefSnapshot = useRef<string | undefined>(auth?.passwordRef);
  const flushPassword = useRef<(() => Promise<string | undefined>) | undefined>(undefined);

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

  useEffect(() => {
    setUsername(auth?.username ?? '');
  }, [auth?.username]);

  const patch = useCallback(
    (next: Partial<EndpointAuthWire>): void => {
      const base: EndpointAuthWire = asEndpointAuthWire(auth) ?? { type: 'none' };
      const merged: EndpointAuthWire = { ...base, ...next };
      updateRequestAuth(requestId, merged);
    },
    [auth, requestId, updateRequestAuth],
  );
  patchRef.current = patch;
  passwordRefSnapshot.current = auth?.passwordRef;

  useEffect(
    () => () => {
      // A username edit still sitting in the debounce timer would otherwise vanish silently:
      // cancel the timer and commit it immediately instead of dropping it on the floor.
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        if (pendingUsername.current !== undefined) {
          patchRef.current({ username: pendingUsername.current });
        }
      }
      // A password typed into SecretField but never explicitly saved is still just a local
      // draft there; flush it so it is stored (and its ref committed) rather than lost.
      void flushPassword.current?.().then((ref) => {
        if (ref !== undefined && ref !== passwordRefSnapshot.current) {
          patchRef.current({ passwordRef: ref });
        }
      });
    },
    [],
  );

  if (!exists) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const inherit = auth === undefined;
  const type = auth?.type ?? 'none';

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
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-fg-subtle">Type</span>
            <select
              aria-label="Authentication type"
              className={INPUT_CLASS}
              value={type}
              onChange={(event) => {
                patch({ type: event.target.value as EndpointAuthWire['type'] });
              }}
            >
              <option value="none">None</option>
              <option value="basic">Basic</option>
              <option value="ntlm">NTLM</option>
            </select>
          </label>

          {type !== 'none' && (
            <>
              <label className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-fg-subtle">Username</span>
                <input
                  aria-label="Username"
                  className={INPUT_CLASS}
                  value={username}
                  onChange={(event) => {
                    const next = event.target.value;
                    setUsername(next);
                    pendingUsername.current = next;
                    if (timer.current !== undefined) clearTimeout(timer.current);
                    timer.current = setTimeout(() => {
                      pendingUsername.current = undefined;
                      patch({ username: next });
                    }, COMMIT_DEBOUNCE_MS);
                  }}
                  onBlur={() => {
                    if (timer.current !== undefined) clearTimeout(timer.current);
                    pendingUsername.current = undefined;
                    patch({ username });
                  }}
                />
              </label>
              <p className="pl-26 text-xs text-fg-faint">
                Property expansions such as <code>{'${#Env#user}'}</code> work here.
              </p>

              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-fg-subtle">Password</span>
                <div className="min-w-0 flex-1">
                  <SecretField
                    label="Password"
                    {...(auth?.passwordRef !== undefined ? { value: auth.passwordRef } : {})}
                    registerFlush={(flush) => {
                      flushPassword.current = flush;
                    }}
                    onChange={(ref) => {
                      const base: EndpointAuthWire = asEndpointAuthWire(auth) ?? { type: 'none' };
                      const merged: EndpointAuthWire = {
                        type: base.type,
                        ...(base.username !== undefined ? { username: base.username } : {}),
                        // A conditional spread (not `passwordRef: undefined`) so clearing the
                        // password drops the field entirely rather than setting it to `undefined`.
                        ...(ref !== undefined ? { passwordRef: ref } : {}),
                        ...(base.domain !== undefined ? { domain: base.domain } : {}),
                        ...(base.workstation !== undefined ? { workstation: base.workstation } : {}),
                        ...(base.preemptive !== undefined ? { preemptive: base.preemptive } : {}),
                      };
                      updateRequestAuth(requestId, merged);
                    }}
                  />
                </div>
              </div>

              {type === 'ntlm' && (
                <label className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-fg-subtle">Domain</span>
                  <input
                    aria-label="Domain"
                    className={INPUT_CLASS}
                    value={auth?.domain ?? ''}
                    onChange={(event) => {
                      patch({ domain: event.target.value });
                    }}
                  />
                </label>
              )}

              {type === 'ntlm' && (
                <label className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-fg-subtle">Workstation</span>
                  <input
                    aria-label="Workstation"
                    className={INPUT_CLASS}
                    value={auth?.workstation ?? ''}
                    onChange={(event) => {
                      patch({ workstation: event.target.value });
                    }}
                  />
                </label>
              )}

              {type === 'basic' && (
                <label className="flex items-center gap-2 text-fg-default">
                  <input
                    type="checkbox"
                    data-testid="auth-preemptive"
                    checked={auth?.preemptive !== false}
                    onChange={(event) => {
                      patch({ preemptive: event.target.checked });
                    }}
                  />
                  <span className="text-xs">Send credentials preemptively (do not wait for a 401)</span>
                </label>
              )}
            </>
          )}
        </div>
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
