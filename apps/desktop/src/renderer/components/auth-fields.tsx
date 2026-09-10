/**
 * The credential fields shared by the endpoints dialog and the interface inspector: type,
 * username, password (through {@link SecretField}, so only a `passwordRef` is ever held here),
 * NTLM domain/workstation and the Basic "preemptive" flag.
 *
 * Every label is prefixed with the level being edited (`Endpoint`, `Interface`), because the
 * request pane's own Auth inspector can be on screen at the same time and two identical
 * accessible names would be ambiguous.
 */

import { useEffect, useRef } from 'react';
import { SecretField } from './secret-field.js';
import type { EndpointAuthWire } from '../../shared/wire-types.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

export interface AuthFieldsProps {
  /** Which level is being edited; prefixes every accessible name. */
  readonly scope: string;
  readonly auth: EndpointAuthWire | undefined;
  /** `null` clears the credentials entirely (the level then configures nothing). */
  readonly onChange: (auth: EndpointAuthWire | null) => void;
}

export function AuthFields({ scope, auth, onChange }: AuthFieldsProps) {
  const type = auth?.type ?? 'none';
  const patch = (next: Partial<EndpointAuthWire>): void => {
    onChange({ ...(auth ?? { type: 'none' }), ...next });
  };
  // Kept current every render (like SecretField's own `commitRef`) so the unmount effect below,
  // registered once, always flushes through the latest `onChange`/`auth` rather than a stale one.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const authRef = useRef(auth);
  authRef.current = auth;
  const flushPassword = useRef<(() => Promise<string | undefined>) | undefined>(undefined);

  useEffect(
    () => () => {
      // A password typed into SecretField but never explicitly saved is still just a local
      // draft there; flush it on unmount so it is stored (and its ref committed) rather than
      // silently dropped.
      void flushPassword.current?.().then((ref) => {
        const current = authRef.current;
        if (ref !== undefined && current !== undefined && ref !== current.passwordRef) {
          onChangeRef.current({ ...current, passwordRef: ref });
        }
      });
    },
    [],
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-xs text-fg-subtle">Authentication</span>
        <select
          aria-label={`${scope} authentication type`}
          className={INPUT_CLASS}
          value={auth === undefined ? 'inherit' : type}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'inherit') {
              onChange(null);
              return;
            }
            patch({ type: value as EndpointAuthWire['type'] });
          }}
        >
          <option value="inherit">Not configured</option>
          <option value="none">None</option>
          <option value="basic">Basic</option>
          <option value="ntlm">NTLM</option>
        </select>
      </label>

      {auth !== undefined && type !== 'none' && (
        <>
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Username</span>
            <input
              aria-label={`${scope} username`}
              className={INPUT_CLASS}
              value={auth.username ?? ''}
              onChange={(event) => {
                patch({ username: event.target.value });
              }}
            />
          </label>

          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Password</span>
            <div className="min-w-0 flex-1">
              <SecretField
                label={`${scope} password`}
                {...(auth.passwordRef !== undefined ? { value: auth.passwordRef } : {})}
                registerFlush={(flush) => {
                  flushPassword.current = flush;
                }}
                onChange={(ref) => {
                  const merged: EndpointAuthWire = {
                    type: auth.type,
                    ...(auth.username !== undefined ? { username: auth.username } : {}),
                    // A conditional spread (not `passwordRef: undefined`) so clearing the
                    // password drops the field entirely rather than setting it to `undefined`.
                    ...(ref !== undefined ? { passwordRef: ref } : {}),
                    ...(auth.domain !== undefined ? { domain: auth.domain } : {}),
                    ...(auth.workstation !== undefined ? { workstation: auth.workstation } : {}),
                    ...(auth.preemptive !== undefined ? { preemptive: auth.preemptive } : {}),
                  };
                  onChange(merged);
                }}
              />
            </div>
          </div>

          {type === 'ntlm' && (
            <label className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-fg-subtle">Domain</span>
              <input
                aria-label={`${scope} domain`}
                className={INPUT_CLASS}
                value={auth.domain ?? ''}
                onChange={(event) => {
                  patch({ domain: event.target.value });
                }}
              />
            </label>
          )}

          {type === 'ntlm' && (
            <label className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-fg-subtle">Workstation</span>
              <input
                aria-label={`${scope} workstation`}
                className={INPUT_CLASS}
                value={auth.workstation ?? ''}
                onChange={(event) => {
                  patch({ workstation: event.target.value });
                }}
              />
            </label>
          )}

          {type === 'basic' && (
            <label className="flex items-center gap-2 text-xs text-fg-default">
              <input
                type="checkbox"
                aria-label={`${scope} preemptive`}
                checked={auth.preemptive !== false}
                onChange={(event) => {
                  patch({ preemptive: event.target.checked });
                }}
              />
              Send credentials preemptively (do not wait for a 401)
            </label>
          )}
        </>
      )}
    </div>
  );
}
