/**
 * Client keystores: the entry point every caller uses. `loadKeystore` dispatches on the
 * container format, `selectAlias` picks the entry a send should present, and
 * `toTlsClientIdentity` shapes it for `TlsOptions`.
 */

import { WssError } from '../../errors.js';
import { loadPem } from './pem.js';
import { loadPkcs12 } from './pkcs12.js';
import type { Keystore, KeystoreAlias, LoadKeystoreOptions, TlsClientIdentity } from './model.js';

export { loadPem } from './pem.js';
export { loadPkcs12 } from './pkcs12.js';
export { keystoreTypeForPath } from './model.js';
export type {
  Keystore,
  KeystoreAlias,
  KeystoreDef,
  KeystoreType,
  LoadKeystoreOptions,
  TlsClientIdentity,
} from './model.js';

/**
 * Parses a keystore out of its raw bytes. The engine never reads the file itself: the host
 * checks the path and resolves the password, so containment and secret handling stay in one
 * place (see the module docs on `model.ts`).
 *
 * @param bytes the keystore file's content
 * @param options the container format and, when needed, the password
 * @returns the parsed keystore
 * @throws WssError `keystore-bad-password` or `keystore-invalid`
 */
export function loadKeystore(bytes: Uint8Array, options: LoadKeystoreOptions): Keystore {
  return options.type === 'pkcs12' ? loadPkcs12(bytes, options.password) : loadPem(bytes, options.password);
}

/**
 * The alias a send should use: the one named, else — when nothing is named — the keystore's
 * only usable entry.
 *
 * `alias` is "the explicit alias, else the registry's `defaultAlias`": the caller collapses
 * those two before calling, because only it knows the registry entry.
 *
 * @param keystore the parsed keystore
 * @param alias the requested alias, or `undefined` to fall back to the only entry
 * @returns the selected alias
 * @throws WssError `keystore-alias-missing` when the name is unknown, or when nothing is named
 * and the keystore holds more (or fewer) than one usable entry
 */
export function selectAlias(keystore: Keystore, alias?: string): KeystoreAlias {
  if (alias !== undefined && alias.length > 0) {
    const found = keystore.aliases.find((candidate) => candidate.alias === alias);
    if (found === undefined) {
      throw new WssError('keystore-alias-missing', `The keystore has no alias "${alias}".`, { details: { alias } });
    }
    return found;
  }
  // "The only one" means the only one that can actually be presented: a keystore that also
  // carries its CA has two entries but only ever one identity.
  const withKey = keystore.aliases.filter((candidate) => candidate.hasPrivateKey);
  const candidates = withKey.length > 0 ? withKey : keystore.aliases;
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only === undefined) {
    throw new WssError(
      'keystore-alias-missing',
      candidates.length === 0
        ? 'The keystore holds no entries.'
        : 'The keystore holds several entries; choose a default alias.',
      { details: { count: candidates.length } },
    );
  }
  return only;
}

/**
 * The client identity for `alias`, shaped for `TlsOptions.cert`/`key`/`ca`: the leaf with its
 * chain concatenated after it (what OpenSSL expects a client to present), and the chain also
 * offered as trust anchors, since a private CA usually signs both ends of the connection.
 *
 * @param keystore the parsed keystore
 * @param alias the alias to present, or `undefined` for the keystore's only identity
 * @returns the PEM material for a TLS handshake
 * @throws WssError `keystore-alias-missing` when the alias cannot be resolved, `keystore-invalid`
 * when the resolved alias carries no private key
 */
export function toTlsClientIdentity(keystore: Keystore, alias?: string): TlsClientIdentity {
  const entry = selectAlias(keystore, alias);
  if (entry.keyPem === undefined) {
    throw new WssError('keystore-invalid', `The keystore alias "${entry.alias}" has no private key.`, {
      details: { alias: entry.alias },
    });
  }
  return {
    cert: [entry.certPem, ...entry.chainPem].join('\n'),
    key: entry.keyPem,
    ...(entry.chainPem.length > 0 ? { ca: [...entry.chainPem] } : {}),
  };
}
