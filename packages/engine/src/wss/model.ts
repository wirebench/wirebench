/**
 * The WS-Security configuration model: what a project's `wss/outgoing/<id>.yaml` and
 * `wss/incoming/<id>.yaml` describe, plus the {@link WssContext} of injected capabilities
 * every builder takes (so nothing here reads a keystore, a secret, the clock or the entropy
 * pool on its own — the host supplies all four, and tests supply deterministic ones).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Keystore } from './keystore/model.js';

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
 * An XML Signature entry. Task 38 defines the real fields; until then the shape is loose so
 * a config written by a later build survives a load/save round trip through this one.
 */
export interface WssSignatureEntry {
  readonly kind: 'signature';
  readonly [field: string]: unknown;
}

/** An XML Encryption entry. Task 39 defines the real fields; loose for the same reason. */
export interface WssEncryptionEntry {
  readonly kind: 'encryption';
  readonly [field: string]: unknown;
}

/** One element of an outgoing WS-Security configuration, applied in configuration order. */
export type WssEntry = WssTimestampEntry | WssUsernameTokenEntry | WssSignatureEntry | WssEncryptionEntry;

/** Every entry kind, in the order the editor offers them. */
export const WSS_ENTRY_KINDS = ['timestamp', 'username-token', 'signature', 'encryption'] as const;

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

/** One `wss/incoming/<id>.yaml` document. Tasks 39/40 give it teeth. */
export interface WssIncomingConfig {
  readonly id: string;
  readonly name: string;
  /** Keystore holding the private key incoming `xenc:EncryptedKey` blocks are opened with. */
  readonly decryptKeystoreRef?: string;
  /** Keystore holding the certificates incoming signatures are verified against. */
  readonly signatureKeystoreRef?: string;
}

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
  };
}
