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
import { Button } from './button.js';
import { SecretField } from './secret-field.js';
import { DEFAULT_JWT_AUTH, JwtAuthFields } from './jwt-auth-fields.js';
import { useKerberosAvailability } from '../lib/use-kerberos-availability.js';
import { ipc } from '../state/ipc-client.js';
import { useProjectStore } from '../state/project.js';
import { VariableInput } from './variable-field.js';
import type { SoapOwnerAuthWire } from '../../shared/kinds/soap/wire.js';
import type { AuthConfigWire } from '../../shared/wire-base.js';

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
  { value: 'kerberos', label: 'Kerberos' },
  { value: 'digest', label: 'Digest' },
  { value: 'aws-sigv4', label: 'AWS Signature v4' },
  { value: 'jwt', label: 'JWT (signed here)' },
];

/** Every scheme but Kerberos: what a webhook delivery can be given. */
export const WEBHOOK_AUTH_TYPES: readonly AuthConfigWire['type'][] = TYPES.map((option) => option.value).filter(
  (value) => value !== 'kerberos',
);

/**
 * The schemes a SOAP interface, endpoint or request may hold: every one but a signed JWT, and never
 * *Inherit*.
 *
 * A SOAP owner has nothing above it to inherit from (the project format refuses `inherit` there),
 * so the form offers every other scheme and leaves "configures nothing" to *Not configured*.
 */
export const SOAP_AUTH_TYPES: readonly AuthConfigWire['type'][] = [
  'none',
  'basic',
  'ntlm',
  'bearer',
  'api-key',
  'oauth2',
  'kerberos',
  'digest',
  'aws-sigv4',
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
type SecretSlot =
  | 'passwordRef'
  | 'tokenRef'
  | 'valueRef'
  | 'clientSecretRef'
  | 'accessKeyIdRef'
  | 'secretAccessKeyRef'
  | 'sessionTokenRef'
  | 'secretRef';

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
  /**
   * How the row labels are set. `form` (the default) is the narrow column a request tab or dialog
   * uses; `settings` matches the label column of the settings rows around it (an API's page), so
   * the fields line up with Name and Description above them.
   */
  readonly labels?: 'form' | 'settings';
}

/** The label column for each {@link AuthFieldsProps.labels} layout. */
const LABEL_CLASS = {
  form: 'w-28 shrink-0 text-xs text-fg-subtle',
  settings: 'w-44 shrink-0 truncate text-sm text-fg-muted',
} as const;

type OAuth2Grant = NonNullable<AuthConfigWire['grant']>;
type OAuth2ClientAuth = NonNullable<AuthConfigWire['clientAuth']>;
type AssertionAlg = NonNullable<AuthConfigWire['assertionAlg']>;

/** The algorithms a client secret can sign an assertion with, and those a private key can. */
const HMAC_ALGS: readonly AssertionAlg[] = ['HS256', 'HS384', 'HS512'];
const KEY_ALGS: readonly AssertionAlg[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
];

/** Whether the client authenticates with a keystore rather than its secret. */
function keyBased(clientAuth: OAuth2ClientAuth | undefined): boolean {
  return clientAuth === 'private-key-jwt' || clientAuth === 'tls-client-auth';
}

/**
 * The keystores a configuration may pick, de-duplicated by id across open projects, plus the one it
 * already names when that keystore is gone — so the choice is shown, not silently swapped.
 */
function keystoreOptions(
  keystores: readonly { readonly id: string; readonly name: string }[],
  selected: string | undefined,
): { readonly value: string; readonly label: string }[] {
  const seen = new Set<string>();
  const options = keystores.flatMap((keystore) => {
    if (seen.has(keystore.id)) return [];
    seen.add(keystore.id);
    return [{ value: keystore.id, label: keystore.name }];
  });
  return selected !== undefined && selected !== '' && !seen.has(selected)
    ? [...options, { value: selected, label: `${selected} (missing)` }]
    : options;
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
  labels = 'form',
}: AuthFieldsProps) {
  const labelClass = LABEL_CLASS[labels];
  const kerberos = useKerberosAvailability();
  const offered = types === undefined ? TYPES : TYPES.filter((option) => types.includes(option.value));
  const type = auth?.type ?? 'none';
  const patch = (next: Partial<AuthConfigWire>): void => {
    onChange({ ...(auth ?? { type: 'none' }), ...next });
  };
  /** Sets an optional OAuth2 field, or drops it entirely when the choice is empty. */
  const patchOptional = (field: 'clientKeystoreId' | 'assertionAlg', value: string): void => {
    const next: Record<string, unknown> = { ...(auth ?? { type: 'none' }) };
    if (value === '') {
      delete next[field];
    } else {
      next[field] = value;
    }
    onChange(next as AuthConfigWire);
  };
  const keystores = useProjectStore((state) => state.keystores);
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
      <span className={labelClass}>{label}</span>
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
      | 'deviceAuthorizationUrl'
      | 'clientId'
      | 'audience'
      | 'spn'
      | 'principal'
      | 'region'
      | 'service',
    label: string,
    placeholder?: string,
  ): ReactNode => (
    <label className="flex items-center gap-2">
      <span className={labelClass}>{label}</span>
      {/* Inside a request editor, `${` completes and a reference is marked and explained (#340). */}
      <VariableInput
        aria-label={`${scope} ${label.toLowerCase()}`}
        className={INPUT_CLASS}
        {...(placeholder !== undefined ? { placeholder } : {})}
        value={auth?.[field] ?? ''}
        onValueChange={(next) => {
          patch({ [field]: next });
        }}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className={labelClass}>Authentication</span>
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
            if (value === 'jwt') {
              onChange(DEFAULT_JWT_AUTH);
              return;
            }
            if (value === 'kerberos') {
              // A fresh Kerberos configuration carries nothing over from another scheme, whatever the
              // platform: a leftover username or password would be refused by the engine off Windows.
              onChange({
                type: 'kerberos',
                ...(auth?.spn !== undefined ? { spn: auth.spn } : {}),
                ...(auth?.principal !== undefined ? { principal: auth.principal } : {}),
              });
              return;
            }
            if (value === 'digest') {
              // Basic's and NTLM's username and password carry over; nothing else of theirs means anything here.
              onChange({
                type: 'digest',
                ...(auth?.username !== undefined ? { username: auth.username } : {}),
                ...(auth?.passwordRef !== undefined ? { passwordRef: auth.passwordRef } : {}),
              });
              return;
            }
            if (value === 'aws-sigv4') {
              // The project format needs a region and a service, so a fresh configuration starts with both empty.
              onChange({ type: 'aws-sigv4', region: '', service: '' });
              return;
            }
            patch({ type: value as AuthConfigWire['type'] });
          }}
        >
          <option value="inherit">{inheritable ? 'Inherit' : 'Not configured'}</option>
          {offered.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.value === 'kerberos' && kerberos?.available === false}
            >
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

      {auth !== undefined && type === 'digest' && (
        <>
          {text('username', 'Username')}
          {secret('passwordRef', 'Password')}
          <p className="text-xs text-fg-subtle">
            Sent after the server&apos;s 401 challenge; later requests to the same server reuse its nonce.
          </p>
        </>
      )}

      {auth !== undefined && type === 'aws-sigv4' && (
        <>
          {text('region', 'Region', 'us-east-1')}
          {text('service', 'Service', 'execute-api')}
          {secret('accessKeyIdRef', 'Access key ID')}
          {secret('secretAccessKeyRef', 'Secret key')}
          {secret('sessionTokenRef', 'Session token')}
          <label className="flex items-center gap-2">
            <span className={labelClass}>Signature</span>
            <select
              aria-label={`${scope} signature placement`}
              className={INPUT_CLASS}
              value={auth.placement ?? 'header'}
              onChange={(event) => {
                const placement = event.target.value === 'query' ? 'query' : 'header';
                const next: Record<string, unknown> = { ...auth, placement };
                if (placement === 'header') delete next['expiresSeconds'];
                onChange(next as AuthConfigWire);
              }}
            >
              <option value="header">Authorization header</option>
              <option value="query">Query string (presigned URL)</option>
            </select>
          </label>
          {auth.placement === 'query' && (
            <label className="flex items-center gap-2">
              <span className={labelClass}>Expires (s)</span>
              <input
                type="number"
                min={1}
                max={604800}
                aria-label={`${scope} presigned URL expiry`}
                className={INPUT_CLASS}
                placeholder="900"
                value={auth.expiresSeconds ?? ''}
                onChange={(event) => {
                  const seconds = Number.parseInt(event.target.value, 10);
                  const next: Record<string, unknown> = { ...auth };
                  if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 604_800) {
                    next['expiresSeconds'] = seconds;
                  } else {
                    delete next['expiresSeconds'];
                  }
                  onChange(next as AuthConfigWire);
                }}
              />
            </label>
          )}
          <p className="text-xs text-fg-subtle">
            Signed as the request goes out, over its headers and body. The Session token is only for temporary
            credentials.
          </p>
        </>
      )}

      {auth !== undefined && type === 'kerberos' && (
        <>
          {kerberos?.available === false && kerberos.reason !== undefined && kerberos.reason !== '' && (
            <p className="text-xs text-fg-subtle">{kerberos.reason}</p>
          )}
          {text('spn', 'SPN', 'HTTP/<host of the request>')}
          <p className="text-xs text-fg-subtle">Leave empty unless the service is registered under another name.</p>
          {kerberos !== undefined && kerberos.platform !== 'win32' && text('principal', 'Principal', 'user@REALM')}
          {kerberos !== undefined &&
            kerberos.platform !== 'win32' &&
            (auth.username !== undefined || auth.passwordRef !== undefined || auth.domain !== undefined) && (
              // An account made on Windows, which this platform cannot use: every send would be refused,
              // and the fields that name it are Windows-only, so say so and offer the way out here.
              <div className="flex items-center gap-2">
                <p className="text-xs text-fg-subtle">
                  This configuration names a Windows account, which macOS and Linux refuse.
                </p>
                <Button
                  onClick={() => {
                    onChange({
                      type: 'kerberos',
                      ...(auth.spn !== undefined ? { spn: auth.spn } : {}),
                      ...(auth.principal !== undefined ? { principal: auth.principal } : {}),
                    });
                  }}
                >
                  Clear account
                </Button>
              </div>
            )}
          {kerberos?.platform === 'win32' && (
            <details open={auth.username !== undefined}>
              <summary className="text-xs">Use another account</summary>
              {text('username', 'Username')}
              {text('domain', 'Domain')}
              {secret('passwordRef', 'Password')}
            </details>
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
            <span className={labelClass}>Send in</span>
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

      {auth !== undefined && type === 'jwt' && (
        <JwtAuthFields
          scope={scope}
          auth={auth}
          onChange={onChange}
          secretRow={secret('secretRef', 'Secret')}
          nameRow={(placeholder) => text('name', 'Name', placeholder)}
        />
      )}

      {auth !== undefined && type === 'oauth2' && (
        <>
          <label className="flex items-center gap-2">
            <span className={labelClass}>Grant</span>
            <select
              aria-label={`${scope} oauth2 grant`}
              className={INPUT_CLASS}
              value={auth.grant ?? 'client-credentials'}
              onChange={(event) => {
                patch({ grant: event.target.value as OAuth2Grant });
              }}
            >
              <option value="client-credentials">Client credentials</option>
              <option value="authorization-code">Authorization code</option>
              <option value="password">Password</option>
              <option value="device-code">Device code</option>
            </select>
          </label>
          {text('tokenUrl', 'Token URL', 'https://issuer.example.com/oauth/token')}
          {auth.grant === 'authorization-code' &&
            text('authorizationUrl', 'Authorize URL', 'https://issuer.example.com/oauth/authorize')}
          {auth.grant === 'device-code' &&
            text('deviceAuthorizationUrl', 'Device authorization URL', 'https://issuer.example.com/oauth/device')}
          {auth.grant === 'password' && (
            <>
              {text('username', 'Username')}
              {secret('passwordRef', 'Password')}
            </>
          )}
          {text('clientId', 'Client ID')}
          {!keyBased(auth.clientAuth) && secret('clientSecretRef', 'Client secret')}
          <label className="flex items-center gap-2">
            <span className={labelClass}>Scopes</span>
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
            <span className={labelClass}>Client auth</span>
            <select
              aria-label={`${scope} client authentication`}
              className={INPUT_CLASS}
              value={auth.clientAuth ?? 'basic'}
              onChange={(event) => {
                patch({ clientAuth: event.target.value as OAuth2ClientAuth });
              }}
            >
              <option value="basic">Basic header</option>
              <option value="body">Request body</option>
              <option value="client-secret-jwt">Signed JWT, client secret</option>
              <option value="private-key-jwt">Signed JWT, private key</option>
              <option value="tls-client-auth">Client certificate (mTLS)</option>
            </select>
          </label>
          {keyBased(auth.clientAuth) && (
            <label className="flex items-center gap-2">
              <span className={labelClass}>Keystore</span>
              <select
                aria-label={`${scope} client keystore`}
                className={INPUT_CLASS}
                value={auth.clientKeystoreId ?? ''}
                onChange={(event) => {
                  patchOptional('clientKeystoreId', event.target.value);
                }}
              >
                <option value="">Choose a keystore…</option>
                {keystoreOptions(keystores, auth.clientKeystoreId).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(auth.clientAuth === 'client-secret-jwt' || auth.clientAuth === 'private-key-jwt') && (
            <label className="flex items-center gap-2">
              <span className={labelClass}>Algorithm</span>
              <select
                aria-label={`${scope} assertion algorithm`}
                className={INPUT_CLASS}
                value={auth.assertionAlg ?? ''}
                onChange={(event) => {
                  patchOptional('assertionAlg', event.target.value);
                }}
              >
                <option value="">Automatic</option>
                {(auth.clientAuth === 'client-secret-jwt' ? HMAC_ALGS : KEY_ALGS).map((alg) => (
                  <option key={alg} value={alg}>
                    {alg}
                  </option>
                ))}
              </select>
            </label>
          )}
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
