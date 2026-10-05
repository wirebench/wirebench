/**
 * The WS-Security configuration model: what a project's `wss/outgoing/<id>.yaml` and
 * `wss/incoming/<id>.yaml` describe, plus the {@link WssContext} of injected capabilities
 * every builder takes (so nothing here reads a keystore, a secret, the clock or the entropy
 * pool on its own — the host supplies all four, and tests supply deterministic ones).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { NS } from '../xml/namespaces.js';
import type { Keystore } from '../keystore/model.js';

/** How a `wsse:UsernameToken` carries (or does not carry) its password. */
export type WssPasswordType = 'text' | 'digest' | 'none';

/** A `wsu:Timestamp` header element. */
export interface WssTimestampEntry {
  readonly kind: 'timestamp';
  /** Seconds between `Created` and `Expires`; `0` omits `Expires` entirely. */
  readonly timeToLiveSeconds: number;
  /** Emit `.SSS` fractional seconds rather than whole seconds. */
  readonly millisecondPrecision: boolean;
}

/** A `wsse:UsernameToken` header element. */
export interface WssUsernameTokenEntry {
  readonly kind: 'username-token';
  readonly username: string;
  /** Secret reference; the password itself is resolved by the host, never persisted. */
  readonly passwordRef?: string;
  readonly passwordType: WssPasswordType;
  readonly addNonce: boolean;
  readonly addCreated: boolean;
}

/**
 * One message part a signature covers (or, from Task 39 on, an encryption entry encrypts),
 * named the way the "Parts" table names it: by local name and namespace.
 */
export interface WssPart {
  readonly name: string;
  readonly namespace: string;
  /** `Content` signs/encrypts the element's children, `Element` the element itself. */
  readonly encode: 'Content' | 'Element';
  /** Covers the nearest earlier SAML token through the STR-Transform; see {@link SAML_TOKEN_PART}. */
  readonly token?: true;
}

/** How a signature's `wsse:SecurityTokenReference` points at the signing certificate. */
export type WssKeyIdentifierType =
  'BinarySecurityToken' | 'IssuerSerial' | 'SubjectKeyIdentifier' | 'X509KeyIdentifier' | 'Thumbprint' | 'saml-token';

/** The key identifier forms that name an X.509 certificate; an encryption entry offers only these. */
export type WssX509KeyIdentifierType = Exclude<WssKeyIdentifierType, 'saml-token'>;

/** The RSA signature algorithms this build offers. */
export type WssSignatureAlgorithm = 'rsa-sha256' | 'rsa-sha1';

/** The digest algorithms this build offers, for both `SignedInfo` references and `SignatureMethod`. */
export type WssDigestAlgorithm = 'sha256' | 'sha1';

/**
 * An XML Signature entry: which key signs, how the certificate is referenced, and which parts
 * of the message are covered.
 */
export interface WssSignatureEntry {
  readonly kind: 'signature';
  /** The `wss/keystores.yaml` registry id holding the signing key. */
  readonly keystoreRef: string;
  /** Alias inside that keystore; falls back to the configuration's `defaultAlias`. */
  readonly alias?: string;
  /** Secret reference for the private key's passphrase, when its PEM is encrypted. */
  readonly keyPasswordRef?: string;
  readonly keyIdentifierType: WssKeyIdentifierType;
  readonly signatureAlgorithm: WssSignatureAlgorithm;
  readonly digestAlgorithm: WssDigestAlgorithm;
  /** Only exclusive canonicalization is offered; the field exists so documents stay explicit. */
  readonly canonicalization: 'exc-c14n';
  /** Emit only the leaf certificate (`X509v3`) rather than the whole path (`X509PKIPathv1`). */
  readonly useSingleCertificate: boolean;
  readonly parts: readonly WssPart[];
}

/** The parts a new signature entry covers: the SOAP `Body` and the WS-Security `Timestamp`. */
export const DEFAULT_WSS_SIGNATURE_PARTS: readonly WssPart[] = [
  { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' },
  { name: 'Timestamp', namespace: NS.WSU, encode: 'Content' },
];

/** The block ciphers (and modes) this build encrypts message parts with. */
export type WssSymmetricAlgorithm = 'aes128-cbc' | 'aes256-cbc' | 'aes128-gcm' | 'aes256-gcm';

/** How the per-message symmetric key is wrapped for the recipient. */
export type WssKeyTransportAlgorithm = 'rsa-oaep' | 'rsa-1_5';

/**
 * An XML Encryption entry: whose certificate the message is encrypted *to*, how that
 * certificate is referenced, which algorithms are used, and which parts are encrypted.
 *
 * Only the recipient's **certificate** is needed — encryption uses its public key, so the
 * keystore alias this names never has to carry a private key.
 */
export interface WssEncryptionEntry {
  readonly kind: 'encryption';
  /** The `wss/keystores.yaml` registry id holding the recipient's certificate. */
  readonly keystoreRef: string;
  /** Alias inside that keystore; falls back to the configuration's `defaultAlias`. */
  readonly alias?: string;
  readonly keyIdentifierType: WssX509KeyIdentifierType;
  readonly symmetricAlgorithm: WssSymmetricAlgorithm;
  readonly keyTransportAlgorithm: WssKeyTransportAlgorithm;
  /** Embed the recipient certificate as a `wsse:BinarySecurityToken` rather than referencing one. */
  readonly embedKey: boolean;
  /** Wrap the symmetric key in an `xenc:EncryptedKey`; `false` means it is shared out of band. */
  readonly encryptSymmetricKey: boolean;
  readonly parts: readonly WssPart[];
}

/** The parts a new encryption entry covers: the SOAP `Body`'s content. */
export const DEFAULT_WSS_ENCRYPTION_PARTS: readonly WssPart[] = [
  { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' },
];

export type SamlVersion = '1.1' | '2.0';
export type WsTrustVersion = '1.3' | '2005-02';
export type IssuedKeyType = 'bearer' | 'public-key';

/** How the request for a token proves who is asking. */
export type StsCredential =
  | { readonly kind: 'username'; readonly username: string; readonly passwordRef?: string }
  | {
      readonly kind: 'certificate';
      readonly keystoreRef: string;
      readonly alias?: string;
      readonly keyPasswordRef?: string;
    }
  | {
      readonly kind: 'kerberos';
      /** The STS's service principal: `host/sts.corp`, `HTTP@sts.corp` or a bare host (#40 normalises). */
      readonly spn: string;
      readonly principal?: string;
      /** Windows only (#40 §D1). */
      readonly username?: string;
      readonly domain?: string;
      readonly passwordRef?: string;
    };

/** A SAML assertion requested from a security token service over WS-Trust. */
export interface WssIssuedTokenEntry {
  readonly kind: 'issued-token';
  /** STS endpoint URL; `${…}` expands. */
  readonly stsUrl: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly trustVersion: WsTrustVersion;
  /** `wsp:AppliesTo` address; empty means the request's own endpoint. `${…}` expands. */
  readonly appliesTo?: string;
  readonly tokenType: SamlVersion;
  readonly keyType: IssuedKeyType;
  /** For `public-key`: the alias whose certificate goes into `wst:UseKey`; `defaultAlias` when unset. */
  readonly proofKeystoreRef?: string;
  readonly proofAlias?: string;
  readonly credential: StsCredential;
  /** Requested lifetime in seconds; `0` leaves `wst:Lifetime` out. */
  readonly requestedLifetimeSeconds: number;
  /** Raw `wst:Claims` XML, copied in as it is. `${…}` expands. */
  readonly claims?: string;
  /** Client certificate for mutual TLS to the STS. */
  readonly tlsKeystoreRef?: string;
}

export interface SamlAttribute {
  readonly name: string;
  readonly nameFormat?: string;
  readonly values: readonly string[];
}

export type SamlConfirmation = 'bearer' | 'holder-of-key' | 'sender-vouches';

/** The issuer key a form assertion is signed with. */
export interface WssSamlSigning {
  readonly keystoreRef: string;
  readonly alias?: string;
  readonly keyPasswordRef?: string;
  readonly signatureAlgorithm: WssSignatureAlgorithm;
}

/** A self-issued assertion built from fields. */
export interface WssSamlFormEntry {
  readonly kind: 'saml-token';
  readonly source: 'form';
  readonly version: SamlVersion;
  readonly issuer: string;
  readonly subject: string;
  readonly subjectFormat?: string;
  readonly confirmation: SamlConfirmation;
  readonly audience?: string;
  /** Seconds valid from now; `NotBefore` is backdated by {@link SAML_NOT_BEFORE_SKEW_SECONDS}. */
  readonly lifetimeSeconds: number;
  readonly authnContext?: string;
  readonly attributes: readonly SamlAttribute[];
  readonly sign?: WssSamlSigning;
  /** For holder-of-key: the alias whose certificate goes into `SubjectConfirmationData`. */
  readonly proofKeystoreRef?: string;
  readonly proofAlias?: string;
}

/** A self-issued assertion supplied as XML, inline or as a project file. */
export interface WssSamlXmlEntry {
  readonly kind: 'saml-token';
  readonly source: 'xml';
  readonly xml?: string;
  /** Project-relative; read inside the project folder only. */
  readonly file?: string;
  /** Expand `${…}` first; off by default because it would break a signed assertion. */
  readonly expandProperties: boolean;
}

export type WssSamlTokenEntry = WssSamlFormEntry | WssSamlXmlEntry;

/** How far a form assertion's `NotBefore` is backdated, for receivers whose clocks run behind. */
export const SAML_NOT_BEFORE_SKEW_SECONDS = 60;

/** The signature part that covers the nearest earlier SAML token, through the STR-Transform. */
export const SAML_TOKEN_PART: WssPart = { name: 'SamlToken', namespace: '', encode: 'Element', token: true };

/** One element of an outgoing WS-Security configuration, applied in configuration order. */
export type WssEntry =
  | WssTimestampEntry
  | WssUsernameTokenEntry
  | WssSignatureEntry
  | WssEncryptionEntry
  | WssIssuedTokenEntry
  | WssSamlTokenEntry;

/** Every entry kind, in the order the editor offers them. */
export const WSS_ENTRY_KINDS = [
  'timestamp',
  'username-token',
  'signature',
  'encryption',
  'issued-token',
  'saml-token',
] as const;

/** A token an STS issued, as cached: self-contained, never an `Element` (plan amendment 2). */
export interface IssuedToken {
  readonly assertionXml: string;
  /** `ID` (2.0) or `AssertionID` (1.1); absent for an `EncryptedAssertion`. */
  readonly assertionId?: string;
  /** The RSTR's `RequestedAttachedReference` STR, serialised, when it had one. */
  readonly attachedReferenceXml?: string;
  readonly samlVersion: SamlVersion;
  readonly keyType: IssuedKeyType;
  readonly expiresAt?: Date;
  /** The certificate a public-key token is bound to (what `UseKey` sent). */
  readonly proofCertPem?: string;
  /** Where the token came from, for the status line and the verbose line. */
  readonly stsHost: string;
  readonly cacheKey: string;
}

/** The issued-token source, already bound to this send's endpoint, scopes, TLS and proxy. */
export interface BoundIssuedTokens {
  get(entry: WssIssuedTokenEntry): Promise<IssuedToken>;
  /** Only what is cached; never contacts the STS. */
  peek(entry: WssIssuedTokenEntry): IssuedToken | undefined;
}

/** One `wss/outgoing/<id>.yaml` document. */
export interface WssOutgoingConfig {
  readonly id: string;
  readonly name: string;
  /** Keystore alias entries default to when they name none. */
  readonly defaultAlias?: string;
  /** Secret reference username tokens default to when they name none. */
  readonly defaultPasswordRef?: string;
  /** SOAP actor/role the `wsse:Security` header is addressed to. */
  readonly actor?: string;
  /** Set `mustUnderstand` on the `wsse:Security` header. */
  readonly mustUnderstand: boolean;
  readonly entries: readonly WssEntry[];
}

/**
 * One `wss/incoming/<id>.yaml` document: how a *response* is decrypted and how its signatures
 * and timestamp are judged.
 */
export interface WssIncomingConfig {
  readonly id: string;
  readonly name: string;
  /** Keystore holding the private key incoming `xenc:EncryptedKey` blocks are opened with. */
  readonly decryptKeystoreRef?: string;
  /** Alias inside that keystore; the keystore's first (or default) alias when omitted. */
  readonly decryptAlias?: string;
  /** Secret reference for that private key's passphrase, when its PEM is encrypted. */
  readonly decryptKeyPasswordRef?: string;
  /** Truststore: a keystore whose aliases are the certificates (or CAs) incoming signatures are trusted from. */
  readonly signatureKeystoreRef?: string;
  /** Report a failed `signature` action when the response carries no `ds:Signature` at all. */
  readonly requireSignature: boolean;
  /** Report a failed `timestamp` action when the response carries no `wsu:Timestamp`. */
  readonly requireTimestamp: boolean;
  /** Clock skew tolerated on `wsu:Created`/`wsu:Expires`, in seconds. */
  readonly timestampSkewSeconds: number;
  /** Accept a signer that chains to a truststore certificate, not only one stored verbatim. */
  readonly verifyChain: boolean;
}

/** The defaults a new incoming configuration starts from. */
export const DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS = 300;

/**
 * Everything a WS-Security operation needs from the outside world. All five members are
 * injectable: the host wires them to the real keystore loader, the secret store and
 * `node:crypto`; tests wire them to fixtures and a frozen clock.
 */
export interface WssContext {
  /** Resolves a `wss/keystores.yaml` entry id to its parsed keystore. */
  readonly keystores: (ref: string) => Promise<Keystore | undefined>;
  /** Resolves a secret reference to its plaintext. Only ever called inside the host process. */
  readonly secrets: (ref: string) => Promise<string | undefined>;
  readonly clock: () => Date;
  readonly nonce: (bytes: number) => Uint8Array;
  readonly uuid: () => string;
  /** Expands `${…}`; throws `unresolved-properties`. Absent: text is used as written. */
  readonly expand?: (text: string) => string;
  /** Reads a project-relative file inside the project folder; throws `saml-token-file-missing`. */
  readonly projectFile?: (path: string) => Promise<string>;
  /** Issued tokens for this send. Absent: an issued-token entry refuses with `ws-trust-unavailable`. */
  readonly issuedTokens?: BoundIssuedTokens;
}

/**
 * A {@link WssContext} with real defaults: no keystores, no secrets, the system clock and
 * `node:crypto` entropy. Any member given in `overrides` replaces its default.
 *
 * @param overrides the members the caller can actually provide
 * @returns a complete context
 */
export function createWssContext(overrides?: Partial<WssContext>): WssContext {
  return {
    keystores: overrides?.keystores ?? (() => Promise.resolve(undefined)),
    secrets: overrides?.secrets ?? (() => Promise.resolve(undefined)),
    clock: overrides?.clock ?? (() => new Date()),
    nonce: overrides?.nonce ?? ((bytes: number) => new Uint8Array(randomBytes(bytes))),
    uuid: overrides?.uuid ?? (() => randomUUID()),
    ...(overrides?.expand !== undefined ? { expand: overrides.expand } : {}),
    ...(overrides?.projectFile !== undefined ? { projectFile: overrides.projectFile } : {}),
    ...(overrides?.issuedTokens !== undefined ? { issuedTokens: overrides.issuedTokens } : {}),
  };
}
