import type { ServerConfig } from '../config.js';
import type { ServerContext } from '../context.js';
import type { RateLimiter } from '../identity/rate-limit.js';
import type { SamlClaimSettings, SamlProvider } from './saml.js';

/** The URLs an IdP is given (saml-scim spec §3.1, §3.5), derived from the public URL alone. */
export interface SsoUrls {
  /** This server's SAML entity ID, which is also where its SP metadata is served. */
  readonly entityId: string;
  readonly acsUrl: string;
  /** Where the IdP posts a sign-in the browser client started (hosted spec §17.2). */
  readonly browserAcsUrl: string;
  readonly scimBaseUrl: string;
}

export function ssoUrls(publicUrl: string): SsoUrls {
  return {
    entityId: `${publicUrl}/api/v1/auth/saml/metadata`,
    acsUrl: `${publicUrl}/api/v1/auth/saml/acs`,
    browserAcsUrl: `${publicUrl}/api/v1/auth/saml/browser-acs`,
    scimBaseUrl: `${publicUrl}/scim/v2`,
  };
}

/** The §3.1 knobs, derived once from the configuration; `undefined` when SAML is not configured. */
export interface SamlSettings {
  readonly metadataSource: string;
  readonly displayName: string;
  readonly clockSkewMs: number;
  /** The attribute carrying the email; unset reads the usual names (spec §3.3). */
  readonly emailAttribute?: string;
  readonly nameAttribute?: string;
}

export function samlSettings(config: ServerConfig): SamlSettings | undefined {
  if (config.samlIdpMetadata === undefined) return undefined;
  return {
    metadataSource: config.samlIdpMetadata,
    displayName: config.samlDisplayName,
    clockSkewMs: config.samlClockSkewSeconds * 1000,
    ...(config.samlEmailAttribute !== undefined ? { emailAttribute: config.samlEmailAttribute } : {}),
    ...(config.samlNameAttribute !== undefined ? { nameAttribute: config.samlNameAttribute } : {}),
  };
}

/** What the `sso` routes share: the context, the clock, the limiter, the URLs, and SAML when configured. */
export interface SsoEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
  readonly limiter: RateLimiter;
  readonly urls: SsoUrls;
  readonly saml: { readonly provider: SamlProvider; readonly claims: SamlClaimSettings } | undefined;
}
