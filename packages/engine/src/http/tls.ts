/**
 * TLS peer inspection: turns a live `tls.TLSSocket` into the serialisable
 * {@link SslInfo} the SSL Info inspector renders. Kept apart from `timings.ts`
 * so the certificate walk can be unit-tested against a plain object, with no
 * sockets and no network.
 */

/** How far up the issuer chain we walk before giving up, as a defence against pathological chains. */
const MAX_CHAIN_DEPTH = 16;

/**
 * The subset of Node's `tls.PeerCertificate` this module reads. Declared
 * structurally (rather than importing `node:tls`) so tests can hand in a plain
 * object and so a Node version that drops an optional field still type-checks.
 */
export interface PeerCertificateLike {
  readonly subject?: Readonly<Record<string, string | readonly string[]>> | undefined;
  readonly issuer?: Readonly<Record<string, string | readonly string[]>> | undefined;
  /** OpenSSL's `DNS:a, IP Address:1.2.3.4` rendering of the subjectAltName extension. */
  readonly subjectaltname?: string | undefined;
  readonly valid_from?: string | undefined;
  readonly valid_to?: string | undefined;
  readonly serialNumber?: string | undefined;
  readonly fingerprint256?: string | undefined;
  readonly ca?: boolean | undefined;
  readonly issuerCertificate?: PeerCertificateLike | undefined;
}

/** The subset of `tls.TLSSocket` this module reads; every accessor is optional but `getPeerCertificate`. */
export interface TlsSocketLike {
  getPeerCertificate(detailed?: boolean): PeerCertificateLike | undefined | null;
  /** The *local* certificate, i.e. the client identity this side presented (Node >= 11.4). */
  getCertificate?: () => PeerCertificateLike | undefined | null;
  getProtocol?: () => string | null | undefined;
  getCipher?: () => { readonly name?: string | undefined } | undefined;
  readonly authorized?: boolean | undefined;
  readonly authorizationError?: Error | string | null | undefined;
  /** `false` when the client sent no SNI. */
  readonly servername?: string | false | null | undefined;
  /** `false` when no protocol was negotiated. */
  readonly alpnProtocol?: string | false | null | undefined;
}

/** One certificate of the peer's chain, flattened to strings so it can cross IPC unchanged. */
export interface PeerCert {
  /** Distinguished name, rendered `CN=…, O=…` in the certificate's own attribute order. */
  readonly subject: string;
  readonly issuer: string;
  /** ISO 8601, or the certificate's own `valid_from` text when it cannot be parsed. */
  readonly validFrom: string;
  readonly validTo: string;
  readonly serialNumber?: string;
  /** SAN entries with OpenSSL's `DNS:` / `IP Address:` type prefix stripped. */
  readonly sans: readonly string[];
  /** SHA-256 fingerprint as 64 lower-case hex characters (OpenSSL's colons removed). */
  readonly fingerprint256: string;
  readonly isCA?: boolean;
}

/** Everything known about the TLS connection one exchange travelled over. */
export interface SslInfo {
  /** e.g. `TLSv1.3`. */
  readonly protocol?: string;
  /** Cipher suite name, e.g. `TLS_AES_256_GCM_SHA384`. */
  readonly cipher?: string;
  /** Whether the peer chain verified against the trust store in use. */
  readonly authorized?: boolean;
  /** OpenSSL's reason the chain did not verify, e.g. `SELF_SIGNED_CERT_IN_CHAIN`. */
  readonly authorizationError?: string;
  /** The SNI name sent on the handshake. */
  readonly servername?: string;
  /** Leaf first, then each issuer up to (and including) the root the peer presented. */
  readonly peerChain: readonly PeerCert[];
  /** Negotiated ALPN protocol, e.g. `http/1.1`. */
  readonly alpn?: string;
  /** The client identity this side presented, when a keystore supplied one. */
  readonly clientCertificate?: { readonly subject: string; readonly issuer: string };
}

/** Renders a Node DN object (`{ CN: 'x', OU: ['a','b'] }`) as `CN=x, OU=a, OU=b`. */
function renderDn(dn: Readonly<Record<string, string | readonly string[]>> | undefined): string {
  if (dn === undefined) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(dn)) {
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${key}=${item}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join(', ');
}

/** `DNS:localhost, IP Address:127.0.0.1` → `['localhost', '127.0.0.1']`. */
function parseSans(subjectAltName: string | undefined): string[] {
  if (subjectAltName === undefined || subjectAltName.length === 0) return [];
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return colon === -1 ? entry : entry.slice(colon + 1).trim();
    });
}

/** ISO 8601 when the certificate's date text parses, the original text when it does not. */
function toIsoDate(text: string | undefined): string {
  if (text === undefined || text.length === 0) return '';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

/** OpenSSL prints `AB:CD:…`; the UI wants a copyable 64-character hex string. */
function normalizeFingerprint(fingerprint: string | undefined): string {
  return (fingerprint ?? '').replace(/:/g, '').toLowerCase();
}

/** True when Node returned the empty object it uses for "this socket has no peer certificate". */
function isEmptyCertificate(cert: PeerCertificateLike | undefined | null): boolean {
  return cert === undefined || cert === null || Object.keys(cert).length === 0;
}

function toPeerCert(cert: PeerCertificateLike): PeerCert {
  return {
    subject: renderDn(cert.subject),
    issuer: renderDn(cert.issuer),
    validFrom: toIsoDate(cert.valid_from),
    validTo: toIsoDate(cert.valid_to),
    ...(cert.serialNumber !== undefined ? { serialNumber: cert.serialNumber } : {}),
    sans: parseSans(cert.subjectaltname),
    fingerprint256: normalizeFingerprint(cert.fingerprint256),
    ...(cert.ca !== undefined ? { isCA: cert.ca } : {}),
  };
}

/**
 * Walks `issuerCertificate` from the leaf upwards. Node makes a self-signed
 * root point at itself, so identity is the natural stop; a `Set` guards against
 * a cross-signed pair that would otherwise loop forever, and `MAX_CHAIN_DEPTH`
 * against anything stranger than that.
 */
function walkChain(leaf: PeerCertificateLike): PeerCert[] {
  const chain: PeerCert[] = [];
  const seen = new Set<PeerCertificateLike>();
  let current: PeerCertificateLike | undefined = leaf;
  while (current !== undefined && !seen.has(current) && chain.length < MAX_CHAIN_DEPTH) {
    seen.add(current);
    chain.push(toPeerCert(current));
    const issuer: PeerCertificateLike | undefined = current.issuerCertificate;
    current = issuer === null ? undefined : issuer;
  }
  return chain;
}

/** The authorization failure as a plain string; Node hands back an `Error` on modern versions. */
function toAuthorizationError(error: Error | string | null | undefined): string | undefined {
  if (error === null || error === undefined) return undefined;
  const message = typeof error === 'string' ? error : error.message;
  return message.length > 0 ? message : undefined;
}

/**
 * Snapshots everything the SSL Info inspector shows about one TLS connection:
 * negotiated protocol/cipher/ALPN, whether the peer chain verified, and the
 * chain itself walked from the leaf to the root the peer presented.
 *
 * Pure and synchronous — safe to call from a diagnostics-channel subscriber.
 *
 * @param socket a connected `tls.TLSSocket` (only the accessors in {@link TlsSocketLike} are used)
 * @returns the serialisable snapshot; `peerChain` is empty when the socket has no peer certificate
 */
export function captureSslInfo(socket: TlsSocketLike): SslInfo {
  const leaf = socket.getPeerCertificate(true);
  const protocol = socket.getProtocol?.() ?? undefined;
  const cipher = socket.getCipher?.()?.name;
  const servername = typeof socket.servername === 'string' ? socket.servername : undefined;
  const alpn = typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : undefined;
  const authorizationError = toAuthorizationError(socket.authorizationError);
  const local = socket.getCertificate?.();
  // The SSL inspector shows this so "did my keystore actually get used?" is answerable without
  // reading the server's logs; only the DNs are kept, never any key material.
  const clientCertificate = isEmptyCertificate(local)
    ? undefined
    : {
        subject: renderDn((local as PeerCertificateLike).subject),
        issuer: renderDn((local as PeerCertificateLike).issuer),
      };

  return {
    ...(protocol !== null && protocol !== undefined ? { protocol } : {}),
    ...(cipher !== undefined ? { cipher } : {}),
    ...(socket.authorized !== undefined ? { authorized: socket.authorized } : {}),
    ...(authorizationError !== undefined ? { authorizationError } : {}),
    ...(servername !== undefined ? { servername } : {}),
    peerChain: isEmptyCertificate(leaf) ? [] : walkChain(leaf as PeerCertificateLike),
    ...(alpn !== undefined ? { alpn } : {}),
    ...(clientCertificate !== undefined ? { clientCertificate } : {}),
  };
}

/**
 * Per-socket cache of {@link captureSslInfo}. A keep-alive connection carries
 * many exchanges but only ever one handshake, so the chain walk runs once per
 * socket; the `WeakMap` keeps nothing alive after the socket is collected.
 */
const bySocket = new WeakMap<TlsSocketLike, SslInfo>();

/**
 * {@link captureSslInfo}, memoised per socket. Use this on the hot path
 * (every request that goes out on a connection), not just on a fresh connect.
 *
 * @param socket the socket the request was written to
 * @returns the cached or freshly captured snapshot
 */
export function sslInfoForSocket(socket: TlsSocketLike): SslInfo {
  const cached = bySocket.get(socket);
  if (cached !== undefined) return cached;
  const info = captureSslInfo(socket);
  bySocket.set(socket, info);
  return info;
}
