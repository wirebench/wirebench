/**
 * The credential form, for every scheme and every owner that can hold one.
 *
 * One component rather than one per protocol: a SOAP endpoint, a SOAP interface, a REST API, a REST
 * folder and a REST request all configure the same {@link AuthConfigWire}, so they get the same
 * fields, in the same order, with the same rules about what is a secret. A scheme whose fields lived
 * in two places would drift, and the one that drifted would be the one holding a token.
 *
 * Every secret is a {@link SecretField}: what the user types is stored through `secrets.set` and only
 * a `secretRef` ever reaches this component's state or the project file (ADR-0004). Each field
 * registers a flush, so a value typed but never explicitly saved is committed when the form goes
 * away rather than silently dropped.
 *
 * Every label is prefixed with the level being edited (`Endpoint`, `Request`, `API`), because two of
 * these forms can be on screen at once and two identical accessible names would be ambiguous.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SecretField } from './secret-field.js';
import { ipc } from '../state/ipc-client.js';
import type { AuthConfigWire, SoapOwnerAuthWire } from '../../shared/wire-types.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** Every scheme, in the order the form offers them. */
const TYPES: readonly { readonly value: AuthConfigWire['type']; readonly label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic' },
  { value: 'ntlm', label: 'NTLM' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api-key', label: 'API key' },
  { value: 'oauth2', label: 'OAuth2' },
];

/**
 * The schemes a SOAP interface, endpoint or request may hold: all six, but never *Inherit*.
 *
 * A SOAP owner has nothing above it to inherit from (the project format refuses `inherit` there),
 * so the form offers every real scheme and leaves "configures nothing" to *Not configured*.
 */
export const SOAP_AUTH_TYPES: readonly AuthConfigWire['type'][] = [
  'none',
  'basic',
  'ntlm',
  'bearer',
  'api-key',
  'oauth2',
];

/**
 * What the form produced, narrowed to what a SOAP owner can persist.
 *
 * A SOAP site passes {@link SOAP_AUTH_TYPES}, so the form never produces `inherit` there; should it
 * ever, clearing the credentials is the direction that cannot write a shape the schema would refuse.
 */
export function asSoapAuth(auth: AuthConfigWire | null): SoapOwnerAuthWire | null {
  return auth === null || auth.type === 'inherit' ? null : auth;
}

/** Which secret field is which, so each can register its own flush. */
type SecretSlot = 'passwordRef' | 'tokenRef' | 'valueRef' | 'clientSecretRef';

export interface AuthFieldsProps {
  /** Which level is being edited; prefixes every accessible name. */
  readonly scope: string;
  readonly auth: AuthConfigWire | undefined;
  /**
   * Offer *Inherit* as a type. True for a REST request or folder, which have something above them to
   * inherit from; false for an interface or endpoint, which have not.
   */
  readonly inheritable?: boolean;
  /**
   * The schemes this owner may be given, when it cannot hold all of them.
   *
   * A SOAP interface, endpoint or request cannot inherit, so it passes {@link SOAP_AUTH_TYPES}. The restriction is on the *offer* rather than on what
   * is saved: a form that offered Bearer and then dropped it would lose a token silently.
   */
  readonly types?: readonly AuthConfigWire['type'][];
  /** `null` clears the credentials entirely (the level then configures nothing, or inherits). */
  readonly onChange: (auth: AuthConfigWire | null) => void;
  /** Rendered under the OAuth2 fields — the token status panel, which needs an owner id. */
  readonly oauth2Status?: ReactNode;
  /**
   * Offer Basic's *Send credentials preemptively* box. Default true; a definition fetch is always
   * preemptive, so its form leaves the box out rather than show one that changes nothing.
   */
  readonly preemptiveOption?: boolean;
  /**
   * Receives a flush the owner awaits before submitting: every secret typed but not yet saved is
   * stored, and the flush answers the configuration with the fresh references. Called again with
   * `undefined` on unmount.
   */
  readonly registerFlush?: (flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => void;
  /** Store every secret typed under a new reference rather than over the one shown; see `SecretField`. */
  readonly newSecretRefs?: boolean;
}

/** The form. */
export function AuthFields({
  scope,
  auth,
  inheritable = false,
  types,
  onChange,
  oauth2Status,
  preemptiveOption = true,
  registerFlush,
  newSecretRefs = false,
}: AuthFieldsProps) {
  const offered = types === undefined ? TYPES : TYPES.filter((option) => types.includes(option.value));
  const type = auth?.type ?? 'none';
  const patch = (next: Partial<AuthConfigWire>): void => {
    onChange({ ...(auth ?? { type: 'none' }), ...next });
  };
  // Kept current every render (as SecretField's own `commitRef` is) so the unmount effect below,
  // registered once, always flushes through the latest `onChange`/`auth` rather than a stale one.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const authRef = useRef(auth);
  authRef.current = auth;
  const flushes = useRef(new Map<SecretSlot, () => Promise<string | undefined>>());
  // *Remember the refresh token* reserves a keychain slot, which is an IPC round trip and a project
  // edit away. The box tracks the user's intent so it answers the click at once and reconciles with
  // the stored reference afterwards — a checkbox that lags a click reads as broken.
  const [remember, setRemember] = useState(auth?.refreshTokenRef !== undefined);
  const storedRemember = auth?.refreshTokenRef !== undefined;
  const lastStored = useRef(storedRemember);
  if (lastStored.current !== storedRemember) {
    // The model changed underneath (a different owner, an undo, a reload): follow it.
    lastStored.current = storedRemember;
    setRemember(storedRemember);
  }

  useEffect(
    () => () => {
      // A secret typed into a SecretField but never explicitly saved is still only a local draft
      // there; flush every one on unmount so it is stored (and its ref committed) rather than lost.
      for (const [slot, flush] of flushes.current) {
        void flush().then((ref) => {
          const current = authRef.current;
          if (ref !== undefined && current !== undefined && ref !== current[slot]) {
            onChangeRef.current({ ...current, [slot]: ref });
          }
        });
      }
    },
    [],
  );

  useEffect(() => {
    registerFlush?.(async () => {
      let current = authRef.current;
      for (const [slot, flush] of flushes.current) {
        const ref = await flush();
        if (ref !== undefined && current !== undefined && ref !== current[slot]) {
          current = { ...current, [slot]: ref };
        }
      }
      return current;
    });
    return () => {
      registerFlush?.(undefined);
    };
  }, [registerFlush]);

  /** One secret row, wired to the slot it writes. */
  const secret = (slot: SecretSlot, label: string): ReactNode => (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-fg-subtle">{label}</span>
      <div className="min-w-0 flex-1">
        <SecretField
          label={`${scope} ${label.toLowerCase()}`}
          {...(auth?.[slot] !== undefined ? { value: auth[slot] } : {})}
          newRef={newSecretRefs}
          registerFlush={(flush) => {
            if (flush === undefined) {
              flushes.current.delete(slot);
            } else {
              flushes.current.set(slot, flush);
            }
          }}
          onChange={(ref) => {
            // A conditional rebuild (not `[slot]: undefined`) so clearing a secret drops the field
            // entirely rather than writing an explicit `undefined` into the project file.
            const next: Record<string, unknown> = { ...(auth ?? { type: 'none' }) };
            if (ref === undefined) {
              delete next[slot];
            } else {
              next[slot] = ref;
            }
            onChange(next as AuthConfigWire);
          }}
        />
      </div>
    </div>
  );

  /** One plain text row. */
  const text = (
    field:
      | 'username'
      | 'domain'
      | 'workstation'
      | 'scheme'
      | 'name'
      | 'tokenUrl'
      | 'authorizationUrl'
      | 'clientId'
      | 'audience',
    label: string,
    placeholder?: string,
  ): ReactNode => (
    <label className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-fg-subtle">{label}</span>
      <input
        aria-label={`${scope} ${label.toLowerCase()}`}
        className={INPUT_CLASS}
        {...(placeholder !== undefined ? { placeholder } : {})}
        value={auth?.[field] ?? ''}
        onChange={(event) => {
          patch({ [field]: event.target.value });
        }}
      />
    </label>
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
              onChange(inheritable ? { type: 'inherit' } : null);
              return;
            }
            if (value === 'oauth2') {
              // OAuth2's required fields have no sensible empty value, so a fresh configuration
              // starts from the same defaults the engine's `DEFAULT_OAUTH2_AUTH` describes.
              onChange({
                type: 'oauth2',
                grant: 'client-credentials',
                tokenUrl: '',
                clientId: '',
                scopes: [],
                clientAuth: 'basic',
                pkce: true,
              });
              return;
            }
            if (value === 'api-key') {
              onChange({ type: 'api-key', name: '', in: 'header' });
              return;
            }
            patch({ type: value as AuthConfigWire['type'] });
          }}
        >
          <option value="inherit">{inheritable ? 'Inherit' : 'Not configured'}</option>
          {offered.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {auth !== undefined && (type === 'basic' || type === 'ntlm') && (
        <>
          {text('username', 'Username')}
          {secret('passwordRef', 'Password')}
          {type === 'ntlm' && text('domain', 'Domain')}
          {type === 'ntlm' && text('workstation', 'Workstation')}
          {type === 'basic' && preemptiveOption && (
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

      {auth !== undefined && type === 'bearer' && (
        <>
          {secret('tokenRef', 'Token')}
          {text('scheme', 'Scheme', 'Bearer')}
          <p className="text-xs text-fg-subtle">
            Sent as <code>Authorization: {auth.scheme ?? 'Bearer'} &lt;token&gt;</code>.
          </p>
        </>
      )}

      {auth !== undefined && type === 'api-key' && (
        <>
          {text('name', 'Name', 'X-Api-Key')}
          {secret('valueRef', 'Value')}
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Send in</span>
            <select
              aria-label={`${scope} api key location`}
              className={INPUT_CLASS}
              value={auth.in ?? 'header'}
              onChange={(event) => {
                patch({ in: event.target.value as 'header' | 'query' });
              }}
            >
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </label>
        </>
      )}

      {auth !== undefined && type === 'oauth2' && (
        <>
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Grant</span>
            <select
              aria-label={`${scope} oauth2 grant`}
              className={INPUT_CLASS}
              value={auth.grant ?? 'client-credentials'}
              onChange={(event) => {
                patch({ grant: event.target.value as 'client-credentials' | 'authorization-code' });
              }}
            >
              <option value="client-credentials">Client credentials</option>
              <option value="authorization-code">Authorization code</option>
            </select>
          </label>
          {text('tokenUrl', 'Token URL', 'https://issuer.example.com/oauth/token')}
          {auth.grant === 'authorization-code' &&
            text('authorizationUrl', 'Authorize URL', 'https://issuer.example.com/oauth/authorize')}
          {text('clientId', 'Client ID')}
          {secret('clientSecretRef', 'Client secret')}
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Scopes</span>
            <input
              aria-label={`${scope} scopes`}
              className={INPUT_CLASS}
              placeholder="read write"
              // Space-separated, which is how a token request carries them (RFC 6749 §3.3).
              value={(auth.scopes ?? []).join(' ')}
              onChange={(event) => {
                patch({ scopes: event.target.value.split(/\s+/).filter((scope) => scope.length > 0) });
              }}
            />
          </label>
          {text('audience', 'Audience')}
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Client auth</span>
            <select
              aria-label={`${scope} client authentication`}
              className={INPUT_CLASS}
              value={auth.clientAuth ?? 'basic'}
              onChange={(event) => {
                patch({ clientAuth: event.target.value as 'basic' | 'body' });
              }}
            >
              <option value="basic">Basic header</option>
              <option value="body">Request body</option>
            </select>
          </label>
          {auth.grant === 'authorization-code' && (
            <label className="flex items-center gap-2 text-xs text-fg-default">
              <input
                type="checkbox"
                aria-label={`${scope} pkce`}
                checked={auth.pkce !== false}
                onChange={(event) => {
                  patch({ pkce: event.target.checked });
                }}
              />
              Use PKCE (RFC 7636)
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-fg-default">
            <input
              type="checkbox"
              aria-label={`${scope} remember refresh token`}
              data-testid="auth-remember-refresh"
              checked={remember}
              onChange={(event) => {
                const next = event.target.checked;
                setRemember(next);
                void rememberRefreshToken(next, auth, onChange);
              }}
            />
            Remember the refresh token, so a new session does not sign in again
          </label>
          {oauth2Status}
        </>
      )}
    </div>
  );
}

/**
 * Turns *Remember the refresh token* on or off.
 *
 * On reserves a keychain slot with an empty value and records its reference; main replaces that
 * value when a grant actually returns a refresh token. Reserving up front is what lets main store
 * one without the project file having to change at the moment a token arrives — and an empty slot is
 * an honest representation of "remembered, not yet obtained".
 */
async function rememberRefreshToken(
  remember: boolean,
  auth: AuthConfigWire,
  onChange: (auth: AuthConfigWire | null) => void,
): Promise<void> {
  if (!remember) {
    const ref = auth.refreshTokenRef;
    const next: Record<string, unknown> = { ...auth };
    delete next.refreshTokenRef;
    onChange(next as AuthConfigWire);
    if (ref !== undefined) {
      await ipc().secrets.delete({ ref });
    }
    return;
  }
  if (auth.refreshTokenRef !== undefined) {
    return;
  }
  const result = await ipc().secrets.set({ value: '', label: 'OAuth2 refresh token' });
  if (result.ok) {
    onChange({ ...auth, refreshTokenRef: result.value.ref });
  }
}
