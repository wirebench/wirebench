/**
 * Builds the `wsse:UsernameToken` element of an outgoing WS-Security header
 * (WS-Security UsernameToken Profile 1.0).
 */

import { createHash } from 'node:crypto';
import { DOMImplementation } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import type { WssPasswordType } from '../model.js';
import { formatWssDateTime } from './timestamp.js';

/** `Type` attribute values of `wsse:Password`. */
const PROFILE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
/** `EncodingType` of `wsse:Nonce`. */
const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/** Nonce length the profile's examples use, and what every interoperable stack expects. */
const NONCE_BYTES = 16;

/** What {@link buildUsernameToken} needs; the password is already resolved by the host. */
export interface BuildUsernameTokenInput {
  readonly username: string;
  /** The resolved plaintext password; absent is treated as empty. */
  readonly password?: string;
  readonly passwordType: WssPasswordType;
  readonly addNonce: boolean;
  readonly addCreated: boolean;
  readonly clock: () => Date;
  readonly nonce: (bytes: number) => Uint8Array;
  readonly uuid: () => string;
}

/**
 * `Base64(SHA-1(nonce ‖ created ‖ password))`, the profile's `PasswordDigest`.
 *
 * @param nonce the raw nonce bytes (not their Base64 form)
 * @param created the `wsu:Created` text, byte-for-byte as it appears in the token
 * @param password the plaintext password
 * @returns the Base64 digest
 */
export function passwordDigest(nonce: Uint8Array, created: string, password: string): string {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce), Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');
}

/**
 * Builds `<wsse:UsernameToken wsu:Id="UsernameToken-…">` with the username, an optional
 * password (text or digest), and an optional nonce/created pair. `PasswordDigest` forces the
 * nonce and created on, since the digest is not verifiable without them.
 *
 * @param input the credentials, the password type and the injected clock/nonce/uuid
 * @returns a detached element owned by a fresh document
 */
export function buildUsernameToken(input: BuildUsernameTokenInput): Element {
  const digest = input.passwordType === 'digest';
  const withNonce = input.addNonce || digest;
  const withCreated = input.addCreated || digest;
  const nonceBytes = withNonce ? input.nonce(NONCE_BYTES) : undefined;
  const created = withCreated ? formatWssDateTime(input.clock(), false) : undefined;

  const doc = new DOMImplementation().createDocument(null, '', null);
  const token = doc.createElementNS(NS.WSSE, 'wsse:UsernameToken');
  token.setAttributeNS(NS.WSU, 'wsu:Id', `UsernameToken-${input.uuid()}`);

  const append = (namespace: string, name: string, text?: string): Element => {
    const element = doc.createElementNS(namespace, name);
    if (text !== undefined && text !== '') {
      element.appendChild(doc.createTextNode(text));
    }
    token.appendChild(element);
    return element;
  };

  append(NS.WSSE, 'wsse:Username', input.username);

  if (input.passwordType !== 'none') {
    const password = input.password ?? '';
    const value = digest ? passwordDigest(nonceBytes ?? new Uint8Array(), created ?? '', password) : password;
    const element = append(NS.WSSE, 'wsse:Password', value);
    element.setAttribute('Type', `${PROFILE}#${digest ? 'PasswordDigest' : 'PasswordText'}`);
  }

  if (nonceBytes !== undefined) {
    const element = append(NS.WSSE, 'wsse:Nonce', Buffer.from(nonceBytes).toString('base64'));
    element.setAttribute('EncodingType', BASE64_BINARY);
  }
  if (created !== undefined) {
    append(NS.WSU, 'wsu:Created', created);
  }
  return token;
}
