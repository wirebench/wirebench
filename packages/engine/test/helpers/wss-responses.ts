/**
 * The WS-Security the test SOAP server puts on its *responses*, so incoming processing has
 * something real to verify: the server signs with its own key and encrypts to the client's
 * certificate, using the same outgoing builders a Wirebench send uses.
 *
 * Test-only. Never import this from production code.
 */

import { applyOutgoingWss } from '../../src/wss/apply.js';
import { loadKeystore } from '../../src/wss/keystore/index.js';
import { createWssContext } from '../../src/wss/model.js';
import { NS } from '../../src/xml/namespaces.js';
import type { Keystore } from '../../src/wss/keystore/model.js';
import type { WssEntry, WssOutgoingConfig } from '../../src/wss/model.js';
import { generateUntrustedCert } from './test-certs.js';

/** The key material the `/wss/*` routes secure their responses with. */
export interface TestWssOptions {
  /** The server's own signing identity — what the client's truststore is expected to accept. */
  readonly serverIdentity: { readonly certPem: string; readonly keyPem: string };
  /** The recipient certificate responses are encrypted to (the client's own). */
  readonly clientCertPem: string;
  /** Overrides the self-signed identity `/wss/untrusted` signs with. */
  readonly untrustedIdentity?: { readonly certPem: string; readonly keyPem: string };
}

/** A one-alias keystore built from PEM text, which is all the builders need. */
function keystoreOf(pems: readonly string[]): Keystore {
  return loadKeystore(Buffer.from(pems.join('\n'), 'utf-8'), { type: 'pem' });
}

const SIGNATURE_PARTS = [
  { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' },
  { name: 'Timestamp', namespace: NS.WSU, encode: 'Content' },
] as const;

const ENCRYPTION_PARTS = [{ name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' }] as const;

/** The timestamp + signature entries, signing with the keystore registered as `signer`. */
function signingEntries(): WssEntry[] {
  return [
    { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
    {
      kind: 'signature',
      keystoreRef: 'signer',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: SIGNATURE_PARTS.map((part) => ({ ...part })),
    },
  ];
}

/** The encryption entry, encrypting to the keystore registered as `recipient`. */
function encryptionEntry(): WssEntry {
  return {
    kind: 'encryption',
    keystoreRef: 'recipient',
    keyIdentifierType: 'BinarySecurityToken',
    symmetricAlgorithm: 'aes256-gcm',
    keyTransportAlgorithm: 'rsa-oaep',
    embedKey: true,
    encryptSymmetricKey: true,
    parts: ENCRYPTION_PARTS.map((part) => ({ ...part })),
  };
}

/** Which of the `/wss/*` routes is being served. */
export type TestWssMode = 'sign' | 'encrypt' | 'sign-encrypt' | 'tampered' | 'untrusted';

/**
 * Tampers with a signed envelope so its signature no longer holds: the `AddResult` value is
 * changed when there is one (a *reference* failure, the interesting case), and otherwise a byte
 * of the `SignatureValue` is flipped.
 */
function tamper(xml: string): string {
  const result = /(<(?:\w+:)?AddResult>)([^<]*)(<\/(?:\w+:)?AddResult>)/.exec(xml);
  if (result?.[2] !== undefined) {
    return xml.replace(result[0], `${result[1] ?? ''}${result[2]}9${result[3] ?? ''}`);
  }
  return xml.replace(
    /(<ds:SignatureValue>)(.)/,
    (_match, open: string, first: string) => `${open}${first === 'A' ? 'B' : 'A'}`,
  );
}

/**
 * Secures `envelopeXml` the way `mode` asks for, with the keys in `options`.
 *
 * @param envelopeXml the response envelope the route would otherwise have sent
 * @param mode which `/wss/*` route is being served
 * @param options the server's signing identity and the client's certificate
 * @returns the secured (or deliberately broken) envelope
 */
export async function secureResponse(envelopeXml: string, mode: TestWssMode, options: TestWssOptions): Promise<string> {
  const untrusted = options.untrustedIdentity ?? generateUntrustedCert();
  const identity = mode === 'untrusted' ? untrusted : options.serverIdentity;
  const signer = keystoreOf([identity.certPem, identity.keyPem]);
  const recipient = keystoreOf([options.clientCertPem]);
  const entries: WssEntry[] =
    mode === 'encrypt'
      ? [encryptionEntry()]
      : mode === 'sign-encrypt'
        ? [...signingEntries(), encryptionEntry()]
        : signingEntries();
  const config: WssOutgoingConfig = {
    id: 'server',
    name: 'Server responses',
    mustUnderstand: false,
    entries,
  };
  const ctx = createWssContext({
    keystores: (ref) => Promise.resolve(ref === 'recipient' ? recipient : signer),
  });
  const secured = await applyOutgoingWss(envelopeXml, config, ctx);
  return mode === 'tampered' ? tamper(secured) : secured;
}
