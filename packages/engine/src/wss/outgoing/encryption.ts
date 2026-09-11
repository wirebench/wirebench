/**
 * XML Encryption (W3C XML-Enc 1.0/1.1) for a WS-Security header, implemented directly on
 * `node:crypto`.
 *
 * The spec-approved `xml-encryption` package was evaluated first and rejected: it does every
 * algorithm this build needs, but it emits one fixed shape — an `xenc:EncryptedData` of
 * `Type="…#Element"` with the `xenc:EncryptedKey` *nested inside its own `ds:KeyInfo`* — with
 * no `Id`, no `Type="…#Content"`, no `xenc:ReferenceList`/`xenc:DataReference`, and no
 * `wsse:SecurityTokenReference` key identifiers. WS-Security needs the opposite arrangement
 * (one `EncryptedKey` in the `wsse:Security` header, referencing the `EncryptedData` blocks it
 * keyed), so adopting it would mean rebuilding its output string and using only its ~40 lines
 * of `node:crypto` calls. Those are written here instead, and no dependency was added.
 *
 * Ciphertext layout, per XML-Enc §5.2 and XML-Enc 1.1 §5.2.4: CBC is `IV(16) ‖ ciphertext`
 * (PKCS#7 padded), GCM is `IV(12) ‖ ciphertext ‖ tag(16)`. Key transport is RSA-OAEP with a
 * SHA-1 digest and MGF1-SHA1 (§5.4.2), or raw PKCS#1 v1.5.
 *
 * Unlike `signEnvelope`, this mutates `doc` in place and never re-serializes it, so elements
 * the caller held stay valid — but `applyOutgoingWss` re-resolves the header anyway, because a
 * *signature* entry earlier in the same configuration may already have swapped the document.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
  publicEncrypt,
} from 'node:crypto';
import type { CipherGCMTypes } from 'node:crypto';
import type { Document, Element, Node } from '@xmldom/xmldom';
import { ExclusiveCanonicalization } from 'xml-crypto';
import { WssError } from '../../errors.js';
import { NS } from '../../xml/namespaces.js';
import { parseXml } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { detectEnvelopeVersion, envelopeNamespace } from '../../soap/envelope.js';
import {
  buildKeyIdentifier,
  certificateBase64,
  issuerDnRfc2253,
  pkiPathBase64,
  serialNumberDecimal,
  subjectKeyIdentifierBase64,
  thumbprintSha1Base64,
  WSS_TOKEN_TYPES,
} from '../key-identifiers.js';
import { childElement, findElement } from '../security-header.js';
import type { Keystore, KeystoreAlias } from '../keystore/model.js';
import type {
  WssContext,
  WssEncryptionEntry,
  WssKeyTransportAlgorithm,
  WssPart,
  WssSymmetricAlgorithm,
} from '../model.js';

/** The XML Encryption 1.1 namespace, where the GCM algorithm identifiers live. */
const XENC11 = 'http://www.w3.org/2009/xmlenc11#';

/** `xenc:EncryptedData` `Type` values. */
const ENCRYPTED_CONTENT_TYPE = `${NS.XENC}Content`;
const ENCRYPTED_ELEMENT_TYPE = `${NS.XENC}Element`;

/** How each offered symmetric algorithm maps onto an OpenSSL cipher and an XML-Enc URI. */
interface SymmetricSpec {
  readonly uri: string;
  readonly cipher: string;
  readonly keyBytes: number;
  readonly ivBytes: number;
  readonly gcm: boolean;
}

const SYMMETRIC_SPECS: Readonly<Record<WssSymmetricAlgorithm, SymmetricSpec>> = {
  'aes128-cbc': { uri: `${NS.XENC}aes128-cbc`, cipher: 'aes-128-cbc', keyBytes: 16, ivBytes: 16, gcm: false },
  'aes256-cbc': { uri: `${NS.XENC}aes256-cbc`, cipher: 'aes-256-cbc', keyBytes: 32, ivBytes: 16, gcm: false },
  'aes128-gcm': { uri: `${XENC11}aes128-gcm`, cipher: 'aes-128-gcm', keyBytes: 16, ivBytes: 12, gcm: true },
  'aes256-gcm': { uri: `${XENC11}aes256-gcm`, cipher: 'aes-256-gcm', keyBytes: 32, ivBytes: 12, gcm: true },
};

/** The same table by URI, for the decrypt direction. */
const SYMMETRIC_BY_URI: ReadonlyMap<string, SymmetricSpec> = new Map(
  Object.values(SYMMETRIC_SPECS).map((spec) => [spec.uri, spec]),
);

/** `xenc:EncryptionMethod` URIs for the key transport algorithms. */
const KEY_TRANSPORT_URIS: Readonly<Record<WssKeyTransportAlgorithm, string>> = {
  'rsa-oaep': `${NS.XENC}rsa-oaep-mgf1p`,
  'rsa-1_5': `${NS.XENC}rsa-1_5`,
};

/** The GCM authentication tag length, in bytes (XML-Enc 1.1 fixes it at 128 bits). */
const GCM_TAG_BYTES = 16;

/** The keystore material {@link encryptEnvelope} encrypts *to*; only the certificate is used. */
export interface ResolvedEncryptionKey {
  readonly keystore: Keystore;
  readonly alias: KeystoreAlias;
  /** The actor/role of the `wsse:Security` block the `xenc:EncryptedKey` belongs in. */
  readonly actor?: string;
}

/** What {@link decryptEnvelope} needs to open an envelope. */
export interface DecryptEnvelopeOptions {
  readonly keystore: Keystore;
  /** The alias whose private key unwraps the `xenc:EncryptedKey`. */
  readonly alias: KeystoreAlias;
  /** Passphrase for an encrypted private key PEM. Resolved by the host; never logged. */
  readonly keyPassword?: string;
}

/** The outcome of {@link decryptEnvelope}. */
export interface DecryptEnvelopeResult {
  /** The envelope with every `xenc:EncryptedData` replaced by its plaintext. */
  readonly xml: string;
  /** The plaintext of each decrypted block, in the order the `ReferenceList` named them. */
  readonly decrypted: readonly string[];
}

/**
 * The element a part names. The two SOAP envelope namespaces are treated as one, so a part
 * storing the SOAP 1.1 `Body` namespace also matches a SOAP 1.2 envelope — the same rule
 * `signEnvelope` applies.
 */
function resolvePart(root: Element, part: WssPart, envelopeNs: string): Element | undefined {
  const namespace = part.namespace === NS.SOAP11_ENV || part.namespace === NS.SOAP12_ENV ? envelopeNs : part.namespace;
  return findElement(root, namespace, part.name);
}

/**
 * Exclusive canonical form of one node, with an empty prefix scope — so every namespace the
 * node's subtree visibly uses is declared *inside* the plaintext and a decryptor gets a
 * self-contained, well-formed fragment rather than one that dangles on the envelope's
 * declarations.
 */
function canonicalize(node: Node): string {
  const c14n = new ExclusiveCanonicalization();
  // `processInner` is the per-node entry point `process` itself calls; it is used directly
  // because `Content` encryption has to canonicalize a *list* of children, not one element.
  return c14n.processInner(node, [], '', {}, []);
}

/** The plaintext one part contributes: its children for `Content`, the element itself for `Element`. */
function plaintextOf(element: Element, encode: WssPart['encode']): string {
  if (encode === 'Element') {
    return canonicalize(element);
  }
  let text = '';
  for (let child = element.firstChild; child !== null; child = child.nextSibling) {
    text += canonicalize(child);
  }
  return text;
}

/** Encrypts `plaintext` under `key`, producing the `CipherValue` bytes XML-Enc prescribes. */
function encryptData(spec: SymmetricSpec, key: Buffer, iv: Buffer, plaintext: string): Buffer {
  if (spec.gcm) {
    const cipher = createCipheriv(spec.cipher as CipherGCMTypes, key, iv, { authTagLength: GCM_TAG_BYTES });
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }
  const cipher = createCipheriv(spec.cipher, key, iv);
  return Buffer.concat([iv, cipher.update(plaintext, 'utf8'), cipher.final()]);
}

/** The inverse of {@link encryptData}; throws whatever OpenSSL throws, for the caller to wrap. */
function decryptData(spec: SymmetricSpec, key: Buffer, cipherValue: Buffer): string {
  const iv = cipherValue.subarray(0, spec.ivBytes);
  if (spec.gcm) {
    const tagAt = cipherValue.length - GCM_TAG_BYTES;
    const decipher = createDecipheriv(spec.cipher as CipherGCMTypes, key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAuthTag(cipherValue.subarray(tagAt));
    return Buffer.concat([decipher.update(cipherValue.subarray(spec.ivBytes, tagAt)), decipher.final()]).toString(
      'utf8',
    );
  }
  const decipher = createDecipheriv(spec.cipher, key, iv);
  return Buffer.concat([decipher.update(cipherValue.subarray(spec.ivBytes)), decipher.final()]).toString('utf8');
}

/** Wraps the symmetric key for the recipient's public key. */
function wrapKey(algorithm: WssKeyTransportAlgorithm, certPem: string, key: Buffer): Buffer {
  if (algorithm === 'rsa-1_5') {
    return publicEncrypt({ key: certPem, padding: constants.RSA_PKCS1_PADDING }, key);
  }
  // SHA-1 digest with MGF1-SHA1 is what `#rsa-oaep-mgf1p` means, and what every WS-Security
  // stack in the field interoperates on; Node derives MGF1's hash from `oaepHash`.
  return publicEncrypt({ key: certPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, key);
}

/** Creates an element in `namespace` with `qualifiedName`, appending `children` in order. */
function element(doc: Document, namespace: string, qualifiedName: string, children: readonly Node[] = []): Element {
  const created = doc.createElementNS(namespace, qualifiedName);
  for (const child of children) {
    created.appendChild(child);
  }
  return created;
}

/** Parses an XML *string* (the key-identifier builders emit strings) into `doc`. */
function importXml(doc: Document, xml: string): Element | undefined {
  const parsed = parseXml(xml, { location: 'envelope' }).documentElement;
  return parsed === null ? undefined : doc.importNode(parsed, true);
}

/** The `ds:KeyInfo` an `xenc:EncryptedData` carries: an STR to the EncryptedKey, or a KeyName. */
function dataKeyInfo(doc: Document, entry: WssEncryptionEntry, keyId: string, aliasName: string): Element {
  const keyInfo = element(doc, NS.DS, 'ds:KeyInfo');
  if (!entry.encryptSymmetricKey) {
    // No EncryptedKey exists to point at: the symmetric key is shared out of band, so the
    // recipient is told only *which* key by name. The name is the keystore alias.
    const keyName = element(doc, NS.DS, 'ds:KeyName');
    keyName.appendChild(doc.createTextNode(aliasName));
    keyInfo.appendChild(keyName);
    return keyInfo;
  }
  const str = element(doc, NS.WSSE, 'wsse:SecurityTokenReference');
  const reference = element(doc, NS.WSSE, 'wsse:Reference');
  reference.setAttribute('URI', `#${keyId}`);
  str.appendChild(reference);
  keyInfo.appendChild(str);
  return keyInfo;
}

/** Builds the `<xenc:EncryptedData>` for one encrypted part. */
function encryptedData(
  doc: Document,
  entry: WssEncryptionEntry,
  spec: SymmetricSpec,
  id: string,
  keyId: string,
  aliasName: string,
  encode: WssPart['encode'],
  cipherValue: Buffer,
): Element {
  const data = element(doc, NS.XENC, 'xenc:EncryptedData');
  data.setAttribute('Id', id);
  data.setAttribute('Type', encode === 'Element' ? ENCRYPTED_ELEMENT_TYPE : ENCRYPTED_CONTENT_TYPE);
  const method = element(doc, NS.XENC, 'xenc:EncryptionMethod');
  method.setAttribute('Algorithm', spec.uri);
  data.appendChild(method);
  data.appendChild(dataKeyInfo(doc, entry, keyId, aliasName));
  const value = element(doc, NS.XENC, 'xenc:CipherValue');
  value.appendChild(doc.createTextNode(cipherValue.toString('base64')));
  data.appendChild(element(doc, NS.XENC, 'xenc:CipherData', [value]));
  return data;
}

/** An existing `wsse:BinarySecurityToken` in `security` that carries a `wsu:Id`. */
function existingBinarySecurityToken(security: Element): string | undefined {
  for (let node = security.firstChild; node !== null; node = node.nextSibling) {
    const candidate = node as Element;
    if (
      candidate.nodeType === 1 &&
      candidate.namespaceURI === NS.WSSE &&
      candidate.localName === 'BinarySecurityToken'
    ) {
      const id = candidate.getAttributeNS(NS.WSU, 'Id');
      if (id !== null && id !== '') {
        return id;
      }
    }
  }
  return undefined;
}

/**
 * Encrypts the parts `entry` names and, when `entry.encryptSymmetricKey`, appends one
 * `<xenc:EncryptedKey>` to the `wsse:Security` block addressed to `resolved.actor`.
 *
 * The `EncryptedKey` is *appended*, so its position in the header matches the entry's position
 * in the configuration: `[encryption, signature]` puts it before the `ds:Signature` (which
 * therefore covers it), `[signature, encryption]` puts it after.
 *
 * @param doc the envelope, already carrying its `wsse:Security` header
 * @param entry the encryption configuration
 * @param resolved the keystore alias whose certificate the message is encrypted to
 * @param ctx the injected entropy/uuid capabilities
 * @throws WssError `wss-not-an-envelope`, `wss-part-missing`, `wss-ski-missing`
 */
export function encryptEnvelope(
  doc: Document,
  entry: WssEncryptionEntry,
  resolved: ResolvedEncryptionKey,
  ctx: WssContext,
): void {
  const root = doc.documentElement;
  const version = detectEnvelopeVersion(doc);
  if (root === null || version === undefined) {
    throw new WssError('wss-not-an-envelope', 'WS-Security can only be applied to a SOAP envelope.');
  }
  const envelopeNs = envelopeNamespace(version);
  const header = childElement(root, envelopeNs, 'Header');
  const security = header === undefined ? undefined : findElement(header, NS.WSSE, 'Security');
  if (security === undefined) {
    throw new WssError('wss-not-an-envelope', 'The envelope has no wsse:Security header to encrypt into.');
  }

  const spec = SYMMETRIC_SPECS[entry.symmetricAlgorithm];
  const key = Buffer.from(ctx.nonce(spec.keyBytes));
  const keyId = `EK-${ctx.uuid()}`;

  // Every part is resolved (and so every `wss-part-missing` raised) before anything is
  // replaced, so a misconfigured entry never leaves the envelope half-encrypted.
  const targets: { readonly element: Element; readonly part: WssPart }[] = [];
  for (const part of entry.parts) {
    const target = resolvePart(root, part, envelopeNs);
    if (target === undefined) {
      throw new WssError('wss-part-missing', `The message has no "${part.name}" element to encrypt.`, {
        details: { name: part.name, namespace: part.namespace },
      });
    }
    targets.push({ element: target, part });
  }

  const dataIds: string[] = [];
  for (const { element: target, part } of targets) {
    const plaintext = plaintextOf(target, part.encode);
    const iv = Buffer.from(ctx.nonce(spec.ivBytes));
    const id = `ED-${ctx.uuid()}`;
    dataIds.push(id);
    const data = encryptedData(
      doc,
      entry,
      spec,
      id,
      keyId,
      resolved.alias.alias,
      part.encode,
      encryptData(spec, key, iv, plaintext),
    );
    if (part.encode === 'Element') {
      target.parentNode?.replaceChild(data, target);
    } else {
      while (target.firstChild !== null) {
        target.removeChild(target.firstChild);
      }
      target.appendChild(data);
    }
  }

  if (!entry.encryptSymmetricKey) {
    return;
  }

  const tokenId = `X509-${ctx.uuid()}`;
  const keyIdentifier = buildKeyIdentifier(entry.keyIdentifierType, {
    certPem: resolved.alias.certPem,
    chainPem: resolved.alias.chainPem,
    useSingleCertificate: true,
    tokenId,
  });
  let keyInfoXml = keyIdentifier.keyInfoXml;
  if (keyIdentifier.binarySecurityTokenXml !== undefined) {
    const reuse = entry.embedKey ? undefined : existingBinarySecurityToken(security);
    if (reuse === undefined) {
      // Nothing to point at (no BST is in the header yet), so the certificate is embedded
      // anyway rather than emitting a reference that resolves to nothing.
      const token = importXml(doc, keyIdentifier.binarySecurityTokenXml);
      if (token !== undefined) {
        security.appendChild(token);
      }
    } else {
      keyInfoXml = keyIdentifier.keyInfoXml.replace(`URI="#${tokenId}"`, `URI="#${reuse}"`);
    }
  }

  const encryptedKey = element(doc, NS.XENC, 'xenc:EncryptedKey');
  encryptedKey.setAttribute('Id', keyId);
  const method = element(doc, NS.XENC, 'xenc:EncryptionMethod');
  method.setAttribute('Algorithm', KEY_TRANSPORT_URIS[entry.keyTransportAlgorithm]);
  if (entry.keyTransportAlgorithm === 'rsa-oaep') {
    const digest = element(doc, NS.DS, 'ds:DigestMethod');
    digest.setAttribute('Algorithm', `${NS.DS}sha1`);
    method.appendChild(digest);
  }
  encryptedKey.appendChild(method);
  const keyInfo = element(doc, NS.DS, 'ds:KeyInfo');
  const identifier = importXml(doc, keyInfoXml);
  if (identifier !== undefined) {
    keyInfo.appendChild(identifier);
  }
  encryptedKey.appendChild(keyInfo);
  const cipherValue = element(doc, NS.XENC, 'xenc:CipherValue');
  cipherValue.appendChild(
    doc.createTextNode(wrapKey(entry.keyTransportAlgorithm, resolved.alias.certPem, key).toString('base64')),
  );
  encryptedKey.appendChild(element(doc, NS.XENC, 'xenc:CipherData', [cipherValue]));
  const referenceList = element(doc, NS.XENC, 'xenc:ReferenceList');
  for (const id of dataIds) {
    const reference = element(doc, NS.XENC, 'xenc:DataReference');
    reference.setAttribute('URI', `#${id}`);
    referenceList.appendChild(reference);
  }
  encryptedKey.appendChild(referenceList);
  security.appendChild(encryptedKey);
}

/** Every descendant-or-self of `root` in `namespace` with local name `localName`, in document order. */
function findAll(root: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  const walk = (node: Element): void => {
    if (node.namespaceURI === namespace && node.localName === localName) {
      found.push(node);
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        walk(child as Element);
      }
    }
  };
  walk(root);
  return found;
}

/** The element under `root` whose `Id` (in any namespace, or none) is `id`. */
function elementById(root: Element, id: string): Element | undefined {
  const walk = (node: Element): Element | undefined => {
    const attributes = node.attributes;
    for (let i = 0; i < attributes.length; i += 1) {
      const attribute = attributes.item(i);
      if (attribute !== null && attribute.localName === 'Id' && attribute.value === id) {
        return node;
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        const found = walk(child as Element);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(root);
}

/** Base64 with every whitespace character removed, so line-wrapped PEM-ish content compares. */
function compactBase64(value: string): string {
  return value.replace(/\s+/g, '');
}

/** The text content of `element`, whitespace-compacted. */
function textOf(element: Element | undefined): string {
  return element === undefined ? '' : compactBase64(element.textContent ?? '');
}

/**
 * Whether the `ds:KeyInfo` of an `xenc:EncryptedKey` names `certPem`, in any of the five X.509
 * token profile forms. A form whose value cannot be computed for this certificate (a missing
 * Subject Key Identifier, say) simply does not match rather than throwing — the caller falls
 * back to trying the decryption itself.
 */
function keyInfoNamesCertificate(root: Element, keyInfo: Element | undefined, certPem: string): boolean {
  if (keyInfo === undefined) {
    return false;
  }
  const identifier = findElement(keyInfo, NS.WSSE, 'KeyIdentifier');
  if (identifier !== undefined) {
    const valueType = identifier.getAttribute('ValueType') ?? '';
    const value = textOf(identifier);
    try {
      if (valueType === WSS_TOKEN_TYPES.THUMBPRINT_SHA1) {
        return value === thumbprintSha1Base64(certPem);
      }
      if (valueType === WSS_TOKEN_TYPES.X509_SUBJECT_KEY_IDENTIFIER) {
        return value === subjectKeyIdentifierBase64(certPem);
      }
      return value === certificateBase64(certPem);
    } catch {
      return false;
    }
  }
  const issuerSerial = findElement(keyInfo, NS.DS, 'X509IssuerSerial');
  if (issuerSerial !== undefined) {
    const issuer = childElement(issuerSerial, NS.DS, 'X509IssuerName')?.textContent ?? '';
    const serial = childElement(issuerSerial, NS.DS, 'X509SerialNumber')?.textContent ?? '';
    return issuer.trim() === issuerDnRfc2253(certPem) && serial.trim() === serialNumberDecimal(certPem);
  }
  const reference = findElement(keyInfo, NS.WSSE, 'Reference');
  if (reference !== undefined) {
    const uri = reference.getAttribute('URI') ?? '';
    const token = uri.startsWith('#') ? elementById(root, uri.slice(1)) : undefined;
    const value = textOf(token);
    return value === certificateBase64(certPem) || value === pkiPathBase64([certPem]);
  }
  return false;
}

/** The private key of `alias`, decrypted with `keyPassword` when its PEM needs one. */
function privateKeyOf(options: DecryptEnvelopeOptions): ReturnType<typeof createPrivateKey> {
  const keyPem = options.alias.keyPem;
  if (keyPem === undefined || keyPem === '') {
    throw new WssError(
      'wss-decryption-key-missing',
      `Keystore alias "${options.alias.alias}" has no private key to decrypt with.`,
    );
  }
  try {
    return createPrivateKey(keyPem);
  } catch (cause) {
    if (options.keyPassword === undefined) {
      throw new WssError('wss-decryption-key-missing', 'The decryption key could not be read.', { cause });
    }
    try {
      return createPrivateKey({ key: keyPem, passphrase: options.keyPassword });
    } catch (innerCause) {
      throw new WssError('wss-decryption-key-missing', 'The decryption key could not be decrypted.', {
        cause: innerCause,
      });
    }
  }
}

/** Unwraps an `xenc:EncryptedKey`'s `CipherValue` with `privateKey`. */
function unwrapKey(algorithm: string, privateKey: ReturnType<typeof createPrivateKey>, wrapped: Buffer): Buffer {
  if (algorithm === KEY_TRANSPORT_URIS['rsa-1_5']) {
    return privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, wrapped);
  }
  if (algorithm === KEY_TRANSPORT_URIS['rsa-oaep'] || algorithm === `${XENC11}rsa-oaep`) {
    return privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, wrapped);
  }
  throw new WssError('wss-algorithm-unsupported', `Unsupported key transport algorithm "${algorithm}".`, {
    details: { algorithm },
  });
}

/** The `xenc:EncryptedData` blocks one `EncryptedKey` keyed, by its `ReferenceList`. */
function referencedData(root: Element, encryptedKey: Element): Element[] {
  const list = childElement(encryptedKey, NS.XENC, 'ReferenceList');
  if (list === undefined) {
    return findAll(root, NS.XENC, 'EncryptedData');
  }
  const found: Element[] = [];
  for (let node = list.firstChild; node !== null; node = node.nextSibling) {
    const reference = node as Element;
    if (reference.nodeType !== 1 || reference.localName !== 'DataReference') {
      continue;
    }
    const uri = reference.getAttribute('URI') ?? '';
    const data = uri.startsWith('#') ? elementById(root, uri.slice(1)) : undefined;
    if (data !== undefined) {
      found.push(data);
    }
  }
  return found;
}

/** Replaces `data` with the nodes `plaintext` parses to, restoring what encryption removed. */
function restore(doc: Document, data: Element, plaintext: string): void {
  const parent = data.parentNode;
  if (parent === null) {
    return;
  }
  let fragment;
  try {
    fragment = parseXml(`<wb-decrypted>${plaintext}</wb-decrypted>`, { location: 'envelope' }).documentElement;
  } catch (cause) {
    throw new WssError('wss-decrypt-failed', 'The decrypted content is not well-formed XML.', { cause });
  }
  if (fragment === null) {
    throw new WssError('wss-decrypt-failed', 'The decrypted content is not well-formed XML.');
  }
  while (fragment.firstChild !== null) {
    const child = fragment.firstChild;
    fragment.removeChild(child);
    parent.insertBefore(doc.importNode(child, true), data);
  }
  parent.removeChild(data);
}

/**
 * Decrypts every `xenc:EncryptedData` in `xml` that `alias`'s private key can open, restoring
 * the original `Content`/`Element` in place and removing the consumed `xenc:EncryptedKey` from
 * the `wsse:Security` header.
 *
 * The `EncryptedKey` whose `ds:KeyInfo` names `alias`'s certificate is preferred; when none
 * does (a key identifier form this build cannot compute, say), every `EncryptedKey` is tried
 * and the first one that unwraps wins. A key that does not fit fails closed.
 *
 * @param xml the encrypted envelope
 * @param options the keystore alias to decrypt with
 * @returns the restored envelope and the plaintext of each decrypted block
 * @throws WssError `wss-decrypt-failed`, `wss-algorithm-unsupported`, `wss-decryption-key-missing`
 */
export function decryptEnvelope(xml: string, options: DecryptEnvelopeOptions): DecryptEnvelopeResult {
  const doc = parseXml(xml, { location: 'envelope' });
  const root = doc.documentElement;
  if (root === null) {
    throw new WssError('wss-decrypt-failed', 'The document to decrypt is empty.');
  }
  const encryptedKeys = findAll(root, NS.XENC, 'EncryptedKey');
  if (encryptedKeys.length === 0) {
    throw new WssError('wss-decrypt-failed', 'The document carries no xenc:EncryptedKey to open.');
  }
  const named = encryptedKeys.filter((key) =>
    keyInfoNamesCertificate(root, childElement(key, NS.DS, 'KeyInfo'), options.alias.certPem),
  );
  const candidates = named.length > 0 ? named : encryptedKeys;
  const privateKey = privateKeyOf(options);

  const decrypted: string[] = [];
  let opened = 0;
  let lastCause: unknown;
  for (const encryptedKey of candidates) {
    const method = childElement(encryptedKey, NS.XENC, 'EncryptionMethod');
    const algorithm = method?.getAttribute('Algorithm') ?? '';
    const cipherValue = childElement(
      childElement(encryptedKey, NS.XENC, 'CipherData') ?? encryptedKey,
      NS.XENC,
      'CipherValue',
    );
    let key: Buffer;
    try {
      key = unwrapKey(algorithm, privateKey, Buffer.from(textOf(cipherValue), 'base64'));
    } catch (cause) {
      if (cause instanceof WssError) {
        throw cause;
      }
      lastCause = cause;
      continue;
    }
    for (const data of referencedData(root, encryptedKey)) {
      const dataAlgorithm = childElement(data, NS.XENC, 'EncryptionMethod')?.getAttribute('Algorithm') ?? '';
      const spec = SYMMETRIC_BY_URI.get(dataAlgorithm);
      if (spec === undefined) {
        throw new WssError('wss-algorithm-unsupported', `Unsupported encryption algorithm "${dataAlgorithm}".`, {
          details: { algorithm: dataAlgorithm },
        });
      }
      const value = childElement(childElement(data, NS.XENC, 'CipherData') ?? data, NS.XENC, 'CipherValue');
      let plaintext: string;
      try {
        plaintext = decryptData(spec, key, Buffer.from(textOf(value), 'base64'));
      } catch (cause) {
        throw new WssError('wss-decrypt-failed', 'An xenc:EncryptedData block could not be decrypted.', { cause });
      }
      restore(doc, data, plaintext);
      decrypted.push(plaintext);
    }
    encryptedKey.parentNode?.removeChild(encryptedKey);
    opened += 1;
  }
  if (opened === 0) {
    throw new WssError('wss-decrypt-failed', 'No xenc:EncryptedKey in the document could be opened with this key.', {
      ...(lastCause !== undefined ? { cause: lastCause } : {}),
    });
  }
  return { xml: serializeXml(doc), decrypted };
}
