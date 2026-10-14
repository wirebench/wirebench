/**
 * The identity provider's metadata (saml-scim spec §3.1): read once at start-up from a file or over TLS,
 * and reduced to the three things sign-in needs. The metadata is operator configuration, not a message
 * from the IdP to verify, so it is parsed, not signature-checked. A DOCTYPE is refused outright, so no
 * entity ever expands.
 */
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
/** Far above any real metadata document; bounds what a misconfigured URL can make the server read. */
const MAX_METADATA_BYTES = 1024 * 1024;

export interface IdpMetadata {
  readonly entityId: string;
  /** The `SingleSignOnService` with the HTTP-Redirect binding. */
  readonly ssoUrl: string;
  /** Every signing certificate, as PEM: all of them are accepted, so a rotation can be published first. */
  readonly certificates: readonly string[];
}

export class MetadataError extends Error {
  override readonly name = 'MetadataError';
}

const children = (parent: Element, ns: string, local: string): Element[] =>
  Array.from(parent.getElementsByTagNameNS(ns, local));

function toPem(base64: string): string {
  const body = base64.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  try {
    new X509Certificate(pem);
  } catch {
    throw new MetadataError('a signing certificate in the metadata does not parse');
  }
  return pem;
}

/** The entity ID, the redirect-binding SSO URL and the signing certificates, or a `MetadataError`. */
export function parseIdpMetadata(xml: string): IdpMetadata {
  if (/<!DOCTYPE/i.test(xml)) throw new MetadataError('the metadata has a DOCTYPE, which is refused');
  const fail = (message: string): never => {
    throw new MetadataError(`the metadata is not well-formed XML: ${message}`);
  };
  const doc = new DOMParser({
    errorHandler: (level: string, message: unknown) => {
      if (level !== 'warning') fail(String(message));
    },
  }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (root === null) throw new MetadataError('the metadata is not well-formed XML');
  const descriptor = children(root, MD, 'IDPSSODescriptor')[0];
  if (descriptor === undefined) throw new MetadataError('the metadata has no IDPSSODescriptor');
  const entity = descriptor.parentNode as Element | null;
  const entityId = entity?.getAttribute('entityID') ?? '';
  if (entityId === '') throw new MetadataError('the metadata has no entityID');
  const sso = children(descriptor, MD, 'SingleSignOnService').find((el) => el.getAttribute('Binding') === REDIRECT);
  const ssoUrl = sso?.getAttribute('Location') ?? '';
  if (ssoUrl === '') throw new MetadataError('the metadata has no SingleSignOnService with the HTTP-Redirect binding');
  try {
    if (new URL(ssoUrl).protocol !== 'https:' && new URL(ssoUrl).protocol !== 'http:') throw new Error();
  } catch {
    throw new MetadataError('the SingleSignOnService location is not a URL');
  }
  const certificates = children(descriptor, MD, 'KeyDescriptor')
    .filter((key) => {
      const use = key.getAttribute('use');
      return use === null || use === '' || use === 'signing';
    })
    .flatMap((key) => children(key, DS, 'X509Certificate'))
    .map((cert) => toPem(cert.textContent ?? ''));
  if (certificates.length === 0) throw new MetadataError('the metadata has no signing certificate');
  return { entityId, ssoUrl, certificates };
}

export interface MetadataSourceOptions {
  /** `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`: an `http://` source, for development only. */
  readonly allowInsecure: boolean;
  readonly fetch?: typeof fetch;
}

/** Reads `source`, an absolute file path or an `https://` URL, and parses it. */
export async function loadIdpMetadata(source: string, options: MetadataSourceOptions): Promise<IdpMetadata> {
  if (isAbsolute(source)) {
    const text = await readFile(source, 'utf8');
    if (text.length > MAX_METADATA_BYTES) throw new MetadataError('the metadata file is larger than 1 MiB');
    return parseIdpMetadata(text);
  }
  const url = new URL(source);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && options.allowInsecure)))
    throw new MetadataError('the metadata URL must be https://');
  const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new MetadataError(`fetching the metadata answered ${String(response.status)}`);
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) throw new MetadataError('the metadata is larger than 1 MiB');
  return parseIdpMetadata(text);
}
