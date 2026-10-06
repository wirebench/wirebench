/**
 * The WS-Trust `RequestSecurityToken` (Issue) an issued-token entry sends: a SOAP envelope with
 * WS-Addressing 1.0 headers, a `wsse:Security` header proving the credential (built by the same
 * builders the message's own header uses), and a `wst:RequestSecurityToken` body.
 */
import { WssError } from '../../errors.js';
import { NS } from '../../xml/namespaces.js';
import { applyOutgoingWss } from '../apply.js';
import { certificateBase64, WSS_TOKEN_TYPES } from '../key-identifiers.js';
import { DEFAULT_WSS_SIGNATURE_PARTS } from '../model.js';
import { KERBEROS_AP_REQ_VALUE_TYPE, SAML_TOKEN_TYPE, TRUST_URIS } from '../saml/uris.js';
import type { WssContext, WssEntry, WssIssuedTokenEntry, WssOutgoingConfig } from '../model.js';

export interface RstInput {
  /** Expanded. */
  readonly stsUrl: string;
  /** Expanded; the request's endpoint when the entry gives none. */
  readonly appliesTo: string;
  /** Expanded. */
  readonly claims?: string;
  readonly ctx: WssContext;
  readonly proofCertPem?: string;
  /** The #40 seam's AP-REQ, for a Kerberos credential (Task 19). */
  readonly kerberosToken?: Uint8Array;
}

export interface BuiltRst {
  readonly xml: string;
  readonly action: string;
  /** The Content-Type header. SOAP 1.2 carries the action in it; SOAP 1.1 uses a SOAPAction header. */
  readonly contentType: string;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function securityEntries(entry: WssIssuedTokenEntry): WssEntry[] {
  const timestamp: WssEntry = { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: true };
  const credential = entry.credential;
  if (credential.kind === 'username') {
    return [
      timestamp,
      {
        kind: 'username-token',
        username: credential.username,
        ...(credential.passwordRef !== undefined ? { passwordRef: credential.passwordRef } : {}),
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
      },
    ];
  }
  if (credential.kind === 'certificate') {
    return [
      timestamp,
      {
        kind: 'signature',
        keystoreRef: credential.keystoreRef,
        ...(credential.alias !== undefined ? { alias: credential.alias } : {}),
        ...(credential.keyPasswordRef !== undefined ? { keyPasswordRef: credential.keyPasswordRef } : {}),
        keyIdentifierType: 'BinarySecurityToken',
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: [...DEFAULT_WSS_SIGNATURE_PARTS],
      },
    ];
  }
  // Kerberos: the AP-REQ goes in as a raw BinarySecurityToken after this Timestamp (buildRst).
  return [timestamp];
}

/**
 * @throws WssError `ws-trust-insecure-transport` for a username credential over `http:`; what the
 * WS-Security builders throw for a missing keystore, alias or secret
 */
export async function buildRst(entry: WssIssuedTokenEntry, input: RstInput): Promise<BuiltRst> {
  if (entry.credential.kind === 'username' && !input.stsUrl.toLowerCase().startsWith('https:')) {
    throw new WssError(
      'ws-trust-insecure-transport',
      'A username and password are only sent to a token service over https.',
      {
        details: { stsUrl: input.stsUrl },
      },
    );
  }
  const trust = TRUST_URIS[entry.trustVersion];
  const envNs = entry.soapVersion === '1.2' ? NS.SOAP12_ENV : NS.SOAP11_ENV;
  const mustUnderstand = entry.soapVersion === '1.2' ? 'true' : '1';
  const ctx = input.ctx;
  const messageId = `urn:uuid:${ctx.uuid()}`;
  const now = ctx.clock();
  const lifetime =
    entry.requestedLifetimeSeconds > 0
      ? `<wst:Lifetime><wsu:Created>${now.toISOString()}</wsu:Created>` +
        `<wsu:Expires>${new Date(now.getTime() + entry.requestedLifetimeSeconds * 1000).toISOString()}</wsu:Expires></wst:Lifetime>`
      : '';
  const useKey =
    entry.keyType === 'public-key' && input.proofCertPem !== undefined
      ? `<wst:UseKey><wsse:BinarySecurityToken ValueType="${WSS_TOKEN_TYPES.X509V3}" EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}">` +
        `${certificateBase64(input.proofCertPem)}</wsse:BinarySecurityToken></wst:UseKey>`
      : '';
  const envelope =
    `<s:Envelope xmlns:s="${envNs}" xmlns:wsa="${NS.WSA_200508}" xmlns:wst="${trust.namespace}"` +
    ` xmlns:wsp="${NS.WSP_2004}" xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}">` +
    `<s:Header><wsa:Action s:mustUnderstand="${mustUnderstand}">${trust.issueAction}</wsa:Action>` +
    `<wsa:MessageID>${messageId}</wsa:MessageID>` +
    `<wsa:ReplyTo><wsa:Address>http://www.w3.org/2005/08/addressing/anonymous</wsa:Address></wsa:ReplyTo>` +
    `<wsa:To s:mustUnderstand="${mustUnderstand}">${esc(input.stsUrl)}</wsa:To></s:Header>` +
    `<s:Body><wst:RequestSecurityToken>` +
    `<wst:TokenType>${SAML_TOKEN_TYPE[entry.tokenType]}</wst:TokenType>` +
    `<wst:RequestType>${trust.requestTypeIssue}</wst:RequestType>` +
    `<wsp:AppliesTo><wsa:EndpointReference><wsa:Address>${esc(input.appliesTo)}</wsa:Address></wsa:EndpointReference></wsp:AppliesTo>` +
    `<wst:KeyType>${trust.keyType[entry.keyType]}</wst:KeyType>${useKey}${lifetime}${input.claims ?? ''}` +
    `</wst:RequestSecurityToken></s:Body></s:Envelope>`;
  const config: WssOutgoingConfig = { id: 'rst', name: 'RST', mustUnderstand: true, entries: securityEntries(entry) };
  let xml = await applyOutgoingWss(envelope, config, ctx);
  if (entry.credential.kind === 'kerberos' && input.kerberosToken !== undefined) {
    const token =
      `<wsse:BinarySecurityToken wsu:Id="Kerberos-${ctx.uuid()}" ValueType="${KERBEROS_AP_REQ_VALUE_TYPE}"` +
      ` EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}">${Buffer.from(input.kerberosToken).toString('base64')}</wsse:BinarySecurityToken>`;
    xml = xml.replace(/(<\/(?:[\w-]+:)?Timestamp>)/, `$1${token}`);
  }
  return {
    xml,
    action: trust.issueAction,
    contentType:
      entry.soapVersion === '1.2'
        ? `application/soap+xml; charset=utf-8; action="${trust.issueAction}"`
        : 'text/xml; charset=utf-8',
  };
}
