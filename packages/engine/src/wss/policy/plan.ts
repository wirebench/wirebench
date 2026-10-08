/**
 * Turns a {@link WssPolicy} into an outgoing configuration's entries, and judges a configuration
 * against it. Pure: it reads only the policy, the entries and the endpoint URL.
 */

import { NS } from '../../xml/namespaces.js';
import type {
  WssDigestAlgorithm,
  WssEncryptionEntry,
  WssEntry,
  WssIssuedTokenEntry,
  WssKeyTransportAlgorithm,
  WssSignatureAlgorithm,
  WssSignatureEntry,
  WssSymmetricAlgorithm,
  WssTimestampEntry,
  WssUsernameTokenEntry,
} from '../model.js';
import type { WssPolicy, WssPolicyPart, WssPolicyToken } from './model.js';

/** The algorithms an `sp:AlgorithmSuite` stands for, as far as this build offers them. */
export interface WssSuiteAlgorithms {
  readonly signatureAlgorithm: WssSignatureAlgorithm;
  readonly digestAlgorithm: WssDigestAlgorithm;
  /** Absent for `Basic192*` and `TripleDes*`, whose ciphers are not offered. */
  readonly symmetricAlgorithm?: WssSymmetricAlgorithm;
  readonly keyTransportAlgorithm: WssKeyTransportAlgorithm;
}

const SUITE = /^(Basic256|Basic192|Basic128|TripleDes)(Sha256)?(Rsa15)?$/;

/**
 * The algorithms of a suite named by its `sp:AlgorithmSuite` local name, or `undefined` for a
 * name outside the WS-SecurityPolicy table.
 *
 * @param suite e.g. `Basic256Sha256`
 */
export function suiteAlgorithms(suite: string): WssSuiteAlgorithms | undefined {
  const match = SUITE.exec(suite);
  if (match === null) {
    return undefined;
  }
  const [, cipher, sha256, rsa15] = match;
  const symmetric: WssSymmetricAlgorithm | undefined =
    cipher === 'Basic256' ? 'aes256-cbc' : cipher === 'Basic128' ? 'aes128-cbc' : undefined;
  return {
    signatureAlgorithm: sha256 !== undefined ? 'rsa-sha256' : 'rsa-sha1',
    digestAlgorithm: sha256 !== undefined ? 'sha256' : 'sha1',
    ...(symmetric !== undefined ? { symmetricAlgorithm: symmetric } : {}),
    keyTransportAlgorithm: rsa15 !== undefined ? 'rsa-1_5' : 'rsa-oaep',
  };
}

/** The algorithms a proposal uses: the suite's, or the configuration editor's defaults. */
function algorithmsFor(policy: WssPolicy): WssSuiteAlgorithms & { readonly symmetricAlgorithm: WssSymmetricAlgorithm } {
  const suite = policy.algorithmSuite === undefined ? undefined : suiteAlgorithms(policy.algorithmSuite);
  return {
    signatureAlgorithm: suite?.signatureAlgorithm ?? 'rsa-sha256',
    digestAlgorithm: suite?.digestAlgorithm ?? 'sha256',
    symmetricAlgorithm: suite?.symmetricAlgorithm ?? 'aes256-cbc',
    keyTransportAlgorithm: suite?.keyTransportAlgorithm ?? 'rsa-oaep',
  };
}

/** The `wsu:Timestamp` part a binding with `sp:IncludeTimestamp` signs. */
const TIMESTAMP_PART: WssPolicyPart = { name: 'Timestamp', namespace: NS.WSU };
/** A signed supporting username token, signed under an asymmetric binding. */
const USERNAME_TOKEN_PART: WssPolicyPart = { name: 'UsernameToken', namespace: NS.WSSE };

function isSigned(token: WssPolicyToken): boolean {
  return token.role === 'signed-supporting' || token.role === 'signed-endorsing';
}

/**
 * Every part the policy's signature must cover, in order: the signed parts, the timestamp when
 * the binding includes one, and a signed supporting username token.
 *
 * @param policy the operation's policy
 */
export function requiredSignatureParts(policy: WssPolicy): readonly WssPolicyPart[] {
  const parts = [...policy.signedParts];
  if (policy.includeTimestamp) {
    parts.push(TIMESTAMP_PART);
  }
  if (policy.tokens.some((token) => token.kind === 'username' && isSigned(token))) {
    parts.push(USERNAME_TOKEN_PART);
  }
  return parts;
}

/** True when the policy asks for an XML signature this build can make. */
function wantsSignature(policy: WssPolicy): boolean {
  return policy.binding === 'asymmetric' && requiredSignatureParts(policy).length > 0;
}

function wantsEncryption(policy: WssPolicy): boolean {
  return policy.binding === 'asymmetric' && policy.encryptedParts.length > 0;
}

function tokenInRole(policy: WssPolicy, role: 'initiator' | 'recipient'): WssPolicyToken | undefined {
  return policy.tokens.find((token) => token.kind === 'x509' && token.role === role);
}

/** The Body and the timestamp are covered by content; a header or token as a whole element. */
function encodeOf(part: WssPolicyPart): 'Content' | 'Element' {
  return part.name === 'Body' || part.name === 'Timestamp' ? 'Content' : 'Element';
}

/** A proposal: the entries to store, and what the user still has to do by hand. */
export interface WssPolicyProposal {
  readonly entries: readonly WssEntry[];
  readonly notes: readonly string[];
}

/**
 * The outgoing configuration entries a policy asks for (spec D3). Keystores, usernames and
 * secrets are left empty for the user to pick.
 *
 * @param policy the operation's policy
 */
export function proposeWssEntries(policy: WssPolicy): WssPolicyProposal {
  const entries: WssEntry[] = [];
  const notes: string[] = [];
  const algorithms = algorithmsFor(policy);
  if (policy.algorithmSuite !== undefined) {
    const suite = suiteAlgorithms(policy.algorithmSuite);
    if (suite === undefined) {
      notes.push(`The algorithm suite ${policy.algorithmSuite} is not known; the default algorithms are proposed.`);
    } else if (suite.symmetricAlgorithm === undefined && wantsEncryption(policy)) {
      notes.push(`The ${policy.algorithmSuite} cipher is not offered; AES-256-CBC is proposed instead.`);
    }
  }
  if (policy.includeTimestamp) {
    const timestamp: WssTimestampEntry = { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false };
    entries.push(timestamp);
  }
  for (const token of policy.tokens) {
    if (token.kind === 'username') {
      const digest = token.password === 'digest';
      const entry: WssUsernameTokenEntry = {
        kind: 'username-token',
        username: '',
        passwordType: token.password ?? 'text',
        addNonce: digest,
        addCreated: digest,
      };
      entries.push(entry);
    } else if (token.kind === 'issued') {
      const entry: WssIssuedTokenEntry = {
        kind: 'issued-token',
        stsUrl: token.issuer ?? '',
        soapVersion: policy.soapVersion,
        trustVersion: policy.version === '1.1' ? '2005-02' : '1.3',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'username', username: '' },
        requestedLifetimeSeconds: 0,
      };
      entries.push(entry);
    } else if (token.kind === 'saml') {
      notes.push('The policy asks for a SAML token: add a SAML token or an issued token entry.');
    }
  }
  const secured: WssEntry[] = [];
  if (wantsSignature(policy)) {
    const signature: WssSignatureEntry = {
      kind: 'signature',
      keystoreRef: '',
      keyIdentifierType: tokenInRole(policy, 'initiator')?.reference ?? 'BinarySecurityToken',
      signatureAlgorithm: algorithms.signatureAlgorithm,
      digestAlgorithm: algorithms.digestAlgorithm,
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: requiredSignatureParts(policy).map((part) => ({ ...part, encode: encodeOf(part) })),
    };
    secured.push(signature);
  }
  if (wantsEncryption(policy)) {
    const encryption: WssEncryptionEntry = {
      kind: 'encryption',
      keystoreRef: '',
      keyIdentifierType: tokenInRole(policy, 'recipient')?.reference ?? 'IssuerSerial',
      symmetricAlgorithm: algorithms.symmetricAlgorithm,
      keyTransportAlgorithm: algorithms.keyTransportAlgorithm,
      embedKey: false,
      encryptSymmetricKey: true,
      parts: policy.encryptedParts.map((part) => ({ ...part, encode: encodeOf(part) })),
    };
    secured.push(encryption);
  }
  entries.push(...(policy.encryptBeforeSigning ? secured.reverse() : secured));
  if (secured.length > 0) {
    notes.push('Pick the keystores the signature and encryption use in the configuration.');
  }
  return { entries, notes: [...notes, ...policy.unsupported] };
}

/** The fields of a stored entry the check reads; anything else about an entry is ignored. */
interface Checked {
  readonly kind: string;
  readonly username?: string;
  readonly passwordType?: string;
  readonly keystoreRef?: string;
  readonly signatureAlgorithm?: string;
  readonly digestAlgorithm?: string;
  readonly symmetricAlgorithm?: string;
  readonly keyTransportAlgorithm?: string;
  readonly parts?: readonly WssPolicyPart[];
}

/** One requirement of the policy, met or not. */
export interface WssPolicyCheckResult {
  readonly requirement: string;
  readonly met: boolean;
  /** Why it is unmet; absent when met. */
  readonly reason?: string;
}

export interface WssPolicyCheck {
  /** Every requirement met. */
  readonly satisfied: boolean;
  readonly results: readonly WssPolicyCheckResult[];
}

function result(requirement: string, problems: readonly string[]): WssPolicyCheckResult {
  return problems.length === 0 ? { requirement, met: true } : { requirement, met: false, reason: problems.join(' ') };
}

function missingParts(entry: Checked, required: readonly WssPolicyPart[]): string[] {
  const covered = entry.parts ?? [];
  const missing = required.filter(
    (part) => !covered.some((candidate) => candidate.name === part.name && candidate.namespace === part.namespace),
  );
  return missing.length === 0 ? [] : [`Missing parts: ${missing.map((part) => part.name).join(', ')}.`];
}

function tokenLabel(token: WssPolicyToken): string {
  switch (token.kind) {
    case 'username':
      return `Username token (${token.password ?? 'text'} password)`;
    case 'x509':
      return 'X.509 token';
    case 'issued':
      return 'Issued token';
    case 'saml':
      return 'SAML token';
    case 'kerberos':
      return 'Kerberos token';
    default:
      return `${token.name ?? 'Unknown'} token`;
  }
}

function usernameProblems(entry: Checked | undefined, wanted: string): string[] {
  if (entry === undefined) {
    return ['No username token entry.'];
  }
  return [
    ...((entry.username ?? '').length === 0 ? ['The username is empty.'] : []),
    ...(entry.passwordType === wanted ? [] : [`The password is sent as ${entry.passwordType ?? '?'}, not ${wanted}.`]),
  ];
}

function signatureProblems(policy: WssPolicy, entry: Checked | undefined): string[] {
  if (entry === undefined) {
    return ['No signature entry.'];
  }
  const suite = policy.algorithmSuite === undefined ? undefined : suiteAlgorithms(policy.algorithmSuite);
  const algorithmsDiffer =
    suite !== undefined &&
    (entry.signatureAlgorithm !== suite.signatureAlgorithm || entry.digestAlgorithm !== suite.digestAlgorithm);
  return [
    ...((entry.keystoreRef ?? '').length === 0 ? ['No signing keystore is selected.'] : []),
    ...(algorithmsDiffer
      ? [`${policy.algorithmSuite ?? ''} signs with ${suite.signatureAlgorithm} and ${suite.digestAlgorithm}.`]
      : []),
    ...missingParts(entry, requiredSignatureParts(policy)),
  ];
}

function encryptionProblems(policy: WssPolicy, entry: Checked | undefined): string[] {
  if (entry === undefined) {
    return ['No encryption entry.'];
  }
  const name = policy.algorithmSuite ?? '';
  const suite = policy.algorithmSuite === undefined ? undefined : suiteAlgorithms(policy.algorithmSuite);
  const cipher =
    suite === undefined
      ? []
      : suite.symmetricAlgorithm === undefined
        ? [`The ${name} cipher is not offered.`]
        : entry.symmetricAlgorithm === suite.symmetricAlgorithm
          ? []
          : [`${name} encrypts with ${suite.symmetricAlgorithm}.`];
  return [
    ...((entry.keystoreRef ?? '').length === 0 ? ["No recipient's keystore is selected."] : []),
    ...cipher,
    ...(suite !== undefined && entry.keyTransportAlgorithm !== suite.keyTransportAlgorithm
      ? [`${name} wraps the key with ${suite.keyTransportAlgorithm}.`]
      : []),
    ...missingParts(entry, policy.encryptedParts),
  ];
}

/**
 * Judges a request's outgoing configuration (and its endpoint) against a policy (spec D5).
 *
 * @param policy the operation's policy
 * @param entries the selected configuration's entries, in order; empty when none is selected
 * @param endpoint the URL the request is sent to, when known
 */
export function checkWssPolicy(
  policy: WssPolicy,
  entries: readonly { readonly kind: string }[],
  endpoint: string | undefined,
): WssPolicyCheck {
  const list = entries as readonly Checked[];
  const results: WssPolicyCheckResult[] = [];
  if (policy.requiresTls) {
    const https = endpoint !== undefined && /^https:\/\//i.test(endpoint.trim());
    results.push(result('HTTPS endpoint', https ? [] : ['The endpoint does not use https://.']));
  }
  if (policy.includeTimestamp) {
    results.push(result('Timestamp', list.some((entry) => entry.kind === 'timestamp') ? [] : ['No timestamp entry.']));
  }
  for (const token of policy.tokens) {
    if (token.kind === 'username') {
      const entry = list.find((candidate) => candidate.kind === 'username-token');
      results.push(result(tokenLabel(token), usernameProblems(entry, token.password ?? 'text')));
    } else if (token.kind === 'issued' || token.kind === 'saml') {
      const present = list.some((entry) => entry.kind === 'issued-token' || entry.kind === 'saml-token');
      results.push(result(tokenLabel(token), present ? [] : ['No issued or SAML token entry.']));
    } else if (token.kind === 'kerberos' || token.kind === 'other') {
      results.push(result(tokenLabel(token), ['This token is not offered.']));
    }
  }
  const signatureIndex = list.findIndex((entry) => entry.kind === 'signature');
  const encryptionIndex = list.findIndex((entry) => entry.kind === 'encryption');
  if (wantsSignature(policy)) {
    results.push(result('Signature', signatureProblems(policy, list[signatureIndex])));
  }
  if (wantsEncryption(policy)) {
    results.push(result('Encryption', encryptionProblems(policy, list[encryptionIndex])));
  }
  if (wantsSignature(policy) && wantsEncryption(policy) && signatureIndex >= 0 && encryptionIndex >= 0) {
    const encryptFirst = encryptionIndex < signatureIndex;
    results.push(
      policy.encryptBeforeSigning
        ? result('Encrypt before signing', encryptFirst ? [] : ['The signature entry comes before the encryption.'])
        : result('Sign before encrypting', encryptFirst ? ['The encryption entry comes before the signature.'] : []),
    );
  }
  for (const text of policy.unsupported) {
    results.push({ requirement: 'Not offered', met: false, reason: text });
  }
  return { satisfied: results.every((entry) => entry.met), results };
}

/** One line of a policy's summary, as the inspector lists it. */
export interface WssPolicyLine {
  readonly label: string;
  readonly value: string;
}

/**
 * The policy as a few labelled lines: tokens, signed and encrypted parts, algorithm suite, TLS.
 *
 * @param policy the operation's policy
 */
export function describeWssPolicy(policy: WssPolicy): readonly WssPolicyLine[] {
  const tokens = policy.tokens.map((token) => {
    const base = tokenLabel(token);
    if (token.kind === 'x509') {
      return `${base} (${token.role}, ${token.reference ?? 'BinarySecurityToken'})`;
    }
    return token.kind === 'issued' && token.issuer !== undefined ? `${base} from ${token.issuer}` : base;
  });
  const signed = policy.binding === 'asymmetric' ? requiredSignatureParts(policy) : policy.signedParts;
  const names = (parts: readonly WssPolicyPart[]): string =>
    parts.length > 0 ? parts.map((part) => part.name).join(', ') : 'Nothing';
  return [
    { label: 'Tokens', value: tokens.length > 0 ? tokens.join('; ') : 'None' },
    { label: 'Signed', value: names(signed) },
    { label: 'Encrypted', value: names(policy.encryptedParts) },
    { label: 'Algorithm suite', value: policy.algorithmSuite ?? 'Not stated' },
    { label: 'TLS', value: policy.requiresTls ? 'Required' : 'Not required' },
    ...(policy.includeTimestamp ? [{ label: 'Timestamp', value: 'Included' }] : []),
  ];
}
