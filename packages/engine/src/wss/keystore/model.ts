/**
 * The shape a client keystore takes once it has been parsed: a flat list of aliases, each with
 * its certificate (and, when the entry carries one, its private key) as PEM text.
 *
 * Deliberately free of any file-system access: the *host* (the desktop main process) reads the
 * bytes after checking the path, and resolves the password out of the secret store. The engine
 * only ever sees bytes plus an optional password, which keeps this module pure and testable and
 * keeps every containment decision in one place.
 */

/** The container formats Wirebench can read a client identity out of. */
export type KeystoreType = 'pkcs12' | 'pem';

/** One entry of a keystore: a certificate, its chain, and — for a client identity — its key. */
export interface KeystoreAlias {
  /** The entry's name: its PKCS#12 `friendlyName`, else the certificate's CN, else `key-N`. */
  readonly alias: string;
  /** The leaf certificate, PEM-encoded. */
  readonly certPem: string;
  /** The private key as an unencrypted PKCS#8 (or PKCS#1) PEM; absent for a trust-only entry. */
  readonly keyPem?: string;
  /** Issuers above the leaf, nearest first. Empty when the keystore carries none. */
  readonly chainPem: readonly string[];
  /** Distinguished name, rendered `CN=…, O=…` in the certificate's own attribute order. */
  readonly subject: string;
  readonly issuer: string;
  /** ISO 8601. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** Serial number as upper-case hex, without a leading sign byte. */
  readonly serial: string;
  /** SHA-256 of the DER certificate, upper-case hex in colon-separated pairs. */
  readonly fingerprintSha256: string;
  readonly hasPrivateKey: boolean;
}

/** A parsed keystore. */
export interface Keystore {
  readonly type: KeystoreType;
  readonly aliases: readonly KeystoreAlias[];
}

/**
 * One `wss/keystores.yaml` entry: where the keystore lives and how to open it. The password
 * itself is never stored here — only a `secretRef` the host resolves through `safeStorage`.
 */
export interface KeystoreDef {
  readonly id: string;
  readonly name: string;
  /** Absolute, or relative to the project root. */
  readonly path: string;
  readonly type: KeystoreType;
  readonly passwordSecretRef?: string;
  /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
  readonly passwordEnv?: string;
  /** The alias a send uses when the request does not name one. */
  readonly defaultAlias?: string;
}

/**
 * The client identity a TLS handshake needs, shaped for `TlsOptions`.
 *
 * Deliberately *only* `cert` and `key`. A keystore says who the client is; it says nothing about
 * whom the client should trust, and Node treats `ca` as a **replacement** trust store — so
 * handing the keystore's own chain over as `ca` would silently drop every public root and break
 * ordinary HTTPS endpoints the moment a client identity was selected. Server trust is configured
 * separately.
 */
export interface TlsClientIdentity {
  /** The leaf certificate with its chain concatenated after it. */
  readonly cert: string;
  readonly key: string;
}

/** Options for `loadKeystore`. */
export interface LoadKeystoreOptions {
  readonly type: KeystoreType;
  /** The PKCS#12 password, or the passphrase of an encrypted PEM key. */
  readonly password?: string;
}

/**
 * The keystore type implied by a file's extension, or `undefined` for anything unrecognised.
 * Used at "Add keystore" time so the registry records a concrete type rather than sniffing on
 * every load.
 *
 * @param path the file name or path to classify
 * @returns `'pkcs12'` for `.p12`/`.pfx`, `'pem'` for `.pem`/`.crt`/`.cer`/`.key`, else `undefined`
 */
export function keystoreTypeForPath(path: string): KeystoreType | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.p12') || lower.endsWith('.pfx')) {
    return 'pkcs12';
  }
  if (lower.endsWith('.pem') || lower.endsWith('.crt') || lower.endsWith('.key') || lower.endsWith('.cer')) {
    return 'pem';
  }
  return undefined;
}
