/**
 * The client-signed JWT part of the credential form (#348): the algorithm, the key it signs with, the
 * claims and extra header fields as JSON, the generated claims, and where the token goes.
 *
 * The key is a reference either way: an HMAC secret is a `SecretField` row the parent renders (so it
 * flushes with every other secret), and a private key is a keystore entry and alias, read by main
 * only. The renderer never sees a key.
 */

import type { ReactNode } from 'react';
import { JWT_ALGORITHM_NAMES, type JwtAlgorithmName } from '@shared/jwt-algorithms.js';
import type { AuthConfigWire } from '@shared/wire-base.js';
import { useProjectStore } from '../state/project.js';
import { useKeystoreAliases } from './use-keystore-aliases.js';

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';
const TEXTAREA_CLASS =
  'w-full min-w-0 rounded-md border border-hairline bg-surface-base px-2 py-1 font-mono text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** What a fresh JWT configuration starts from: HS256, a one-claim payload, `iat` and a five-minute `exp`. */
export const DEFAULT_JWT_AUTH: AuthConfigWire = {
  type: 'jwt',
  algorithm: 'HS256',
  claims: '{\n  "sub": ""\n}',
  issuedAt: true,
  expiresInSeconds: 300,
  jwtId: false,
  in: 'header',
};

const FAMILY_LABEL: Readonly<Record<string, string>> = {
  HS: 'HMAC',
  RS: 'RSA',
  ES: 'ECDSA',
  PS: 'RSA-PSS',
};

/** True when `text` is blank or a JSON object, which is what the engine signs. */
function isJsonObject(text: string | undefined): boolean {
  if (text === undefined || text.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export interface JwtAuthFieldsProps {
  readonly scope: string;
  readonly auth: AuthConfigWire;
  readonly onChange: (auth: AuthConfigWire) => void;
  /** The HMAC secret's row, rendered by the parent so it flushes with the form's other secrets. */
  readonly secretRow: ReactNode;
  /** The placement name's row, rendered as the parent renders its other text rows. */
  readonly nameRow: (placeholder: string) => ReactNode;
}

/** The JWT fields. */
export function JwtAuthFields({ scope, auth, onChange, secretRow, nameRow }: JwtAuthFieldsProps) {
  const keystores = useProjectStore((state) => state.keystores);
  const aliases = useKeystoreAliases(auth.keystoreRef ?? '');
  const algorithm = auth.algorithm ?? 'HS256';
  const hmac = algorithm.startsWith('HS');
  const placement = auth.in ?? 'header';
  const prefix = auth.prefix ?? 'Bearer';
  /** A copy of the configuration without `keys`, so nothing that no longer applies is written. */
  const without = (...keys: (keyof AuthConfigWire)[]): AuthConfigWire => {
    const next: Record<string, unknown> = { ...auth };
    for (const key of keys) delete next[key];
    return next as AuthConfigWire;
  };
  const named = auth.name !== undefined && auth.name !== '' ? auth.name : undefined;
  const shown =
    placement === 'query'
      ? `?${named ?? 'access_token'}=<JWT>`
      : `${named ?? 'Authorization'}: ${prefix === '' ? '' : `${prefix} `}<JWT>`;

  return (
    <>
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-xs text-fg-subtle">Algorithm</span>
        <select
          aria-label={`${scope} JWT algorithm`}
          className={INPUT_CLASS}
          value={algorithm}
          onChange={(event) => {
            const next = event.target.value as JwtAlgorithmName;
            const nextHmac = next.startsWith('HS');
            // Switching between a secret and a private key drops the one that no longer signs.
            const dropped: (keyof AuthConfigWire)[] =
              nextHmac === hmac ? [] : nextHmac ? ['keystoreRef', 'alias'] : ['secretRef'];
            onChange({ ...without(...dropped), algorithm: next });
          }}
        >
          {JWT_ALGORITHM_NAMES.map((name) => (
            <option key={name} value={name}>
              {`${name} (${FAMILY_LABEL[name.slice(0, 2)] ?? ''})`}
            </option>
          ))}
        </select>
      </label>

      {hmac ? (
        secretRow
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-fg-subtle">Signing key</span>
            <select
              aria-label={`${scope} signing key`}
              className={INPUT_CLASS}
              value={auth.keystoreRef ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                onChange(value === '' ? without('keystoreRef', 'alias') : { ...without('alias'), keystoreRef: value });
              }}
            >
              <option value="">Choose a keystore…</option>
              {keystores.map((keystore) => (
                <option key={keystore.id} value={keystore.id}>
                  {keystore.name}
                </option>
              ))}
            </select>
          </label>
          {auth.keystoreRef !== undefined && (
            <label className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-fg-subtle">Key alias</span>
              <select
                aria-label={`${scope} signing key alias`}
                className={INPUT_CLASS}
                value={auth.alias ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  onChange(value === '' ? without('alias') : { ...auth, alias: value });
                }}
              >
                <option value="">Default</option>
                {aliases
                  .filter((alias) => alias.hasPrivateKey)
                  .map((alias) => (
                    <option key={alias.alias} value={alias.alias}>
                      {alias.alias}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <p className="text-xs text-fg-subtle">
            Add the private key under Keystores; a PEM file holding only the key is enough.
          </p>
        </>
      )}

      <label className="flex items-start gap-2">
        <span className="w-28 shrink-0 pt-1 text-xs text-fg-subtle">Claims</span>
        <textarea
          aria-label={`${scope} JWT claims`}
          className={TEXTAREA_CLASS}
          rows={5}
          spellCheck={false}
          placeholder={'{\n  "iss": "${clientId}",\n  "sub": "service"\n}'}
          value={auth.claims ?? ''}
          onChange={(event) => {
            onChange({ ...auth, claims: event.target.value });
          }}
        />
      </label>
      {!isJsonObject(auth.claims) && <p className="text-xs text-danger">The claims must be a JSON object.</p>}

      <label className="flex items-start gap-2">
        <span className="w-28 shrink-0 pt-1 text-xs text-fg-subtle">Header</span>
        <textarea
          aria-label={`${scope} JWT header`}
          className={TEXTAREA_CLASS}
          rows={2}
          spellCheck={false}
          placeholder={'{ "kid": "key-1" }'}
          value={auth.header ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            onChange(value === '' ? without('header') : { ...auth, header: value });
          }}
        />
      </label>
      {!isJsonObject(auth.header) && <p className="text-xs text-danger">The header must be a JSON object.</p>}
      <p className="text-xs text-fg-subtle">
        String values may use <code>{'${…}'}</code> properties; <code>alg</code> comes from the algorithm.
      </p>

      <label className="flex items-center gap-2 text-xs text-fg-default">
        <input
          type="checkbox"
          aria-label={`${scope} JWT issued at`}
          checked={auth.issuedAt !== false}
          onChange={(event) => {
            onChange({ ...auth, issuedAt: event.target.checked });
          }}
        />
        Add <code>iat</code> (issued now)
      </label>
      <label className="flex items-center gap-2 text-xs text-fg-default">
        <span>
          Add <code>exp</code>, seconds after issue
        </span>
        <input
          type="number"
          min={0}
          aria-label={`${scope} JWT lifetime in seconds`}
          className="h-row w-24 rounded-md border border-hairline bg-surface-base px-2 text-sm"
          placeholder="none"
          value={auth.expiresInSeconds ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            const seconds = Number(value);
            onChange(
              value === '' || !Number.isInteger(seconds) || seconds <= 0
                ? without('expiresInSeconds')
                : { ...auth, expiresInSeconds: seconds },
            );
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-fg-default">
        <input
          type="checkbox"
          aria-label={`${scope} JWT id`}
          checked={auth.jwtId === true}
          onChange={(event) => {
            onChange({ ...auth, jwtId: event.target.checked });
          }}
        />
        Add a random <code>jti</code>
      </label>

      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-xs text-fg-subtle">Send in</span>
        <select
          aria-label={`${scope} JWT location`}
          className={INPUT_CLASS}
          value={placement}
          onChange={(event) => {
            onChange({ ...without('name', 'prefix'), in: event.target.value as 'header' | 'query' });
          }}
        >
          <option value="header">Header</option>
          <option value="query">Query parameter</option>
        </select>
      </label>
      {nameRow(placement === 'query' ? 'access_token' : 'Authorization')}
      {placement === 'header' && (
        <label className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-fg-subtle">Prefix</span>
          {/* Shown filled in with the default, so clearing it reads as what it does: a bare token. */}
          <input
            aria-label={`${scope} JWT prefix`}
            className={INPUT_CLASS}
            value={prefix}
            onChange={(event) => {
              const value = event.target.value;
              onChange(value === 'Bearer' ? without('prefix') : { ...auth, prefix: value });
            }}
          />
        </label>
      )}
      <p className="text-xs text-fg-subtle">
        Sent as <code>{shown}</code>, signed again shortly before it expires.
      </p>
    </>
  );
}
