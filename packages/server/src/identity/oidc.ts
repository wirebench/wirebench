import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkEgress, checkedLookup, type EgressPolicy } from '@wirebench/engine';
import * as client from 'openid-client';

/** The bound on one request to the IdP. */
export const OIDC_TIMEOUT_MS = 15_000;
/** Far above any discovery document, key set or token response. */
export const OIDC_MAX_RESPONSE_BYTES = 1024 * 1024;

/** What the routes see of the identity provider; `openid-client` is wrapped behind it (spec §15). */
export interface OidcClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

export interface OidcProvider {
  readonly issuer: string;
  /** `codeChallenge` (S256) is the browser flow's PKCE; the desktop's PKCE runs between it and this server. */
  authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly redirectUri: string;
    readonly codeChallenge?: string;
  }): string;
  /** Exchanges the code in `callbackUrl` and verifies the ID token; rejects when the IdP refuses. */
  exchange(input: {
    readonly callbackUrl: URL;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier?: string;
  }): Promise<OidcClaims>;
}

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`: an `http://` issuer, for the in-test one only. */
  readonly allowInsecure: boolean;
  /**
   * Every request to the IdP under this egress rule (spec §17.5): a tenant's provider in hosted mode, where private
   * ranges are denied. Unset, the platform's `fetch` (the operator's own provider, self-hosted).
   */
  readonly egress?: EgressPolicy | 'unchecked';
}

/**
 * Discovery at start-up (§4.1) and the two operations the routes need. `openid-client` performs
 * discovery over TLS, validates the ID token's signature against the issuer's JWKS and checks
 * `iss`, `aud`, `exp`, `nonce` and `state`; the configured issuer is pinned by construction
 * (§6). Nothing outside this file names the library (§15).
 */
export async function discoverOidc(settings: OidcSettings): Promise<OidcProvider> {
  const config = await client.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret, undefined, {
    ...(settings.allowInsecure ? { execute: [client.allowInsecureRequests] } : {}),
    // Assigned to the configuration too, so the key set and the token endpoint go the same way.
    ...(settings.egress !== undefined ? { [client.customFetch]: egressFetch(settings.egress) } : {}),
  });
  const issuer = config.serverMetadata().issuer;
  return {
    issuer,
    authorizationUrl: ({ state, nonce, redirectUri, codeChallenge }) =>
      client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: settings.scopes.join(' '),
        state,
        nonce,
        ...(codeChallenge !== undefined ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
      }).href,
    exchange: async ({ callbackUrl, state, nonce, codeVerifier }) => {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
        ...(codeVerifier !== undefined ? { pkceCodeVerifier: codeVerifier } : {}),
      });
      const claims = tokens.claims();
      if (claims === undefined) throw new Error('the token response carried no ID token');
      return {
        issuer: claims.iss,
        subject: claims.sub,
        ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
        ...(typeof claims.email_verified === 'boolean' ? { emailVerified: claims.email_verified } : {}),
        ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      };
    },
  };
}

/**
 * A `fetch` for the IdP's endpoints under the egress rule (hosted edition spec §17.5, §22.12): every connection the
 * client opens (discovery, the keys, the token endpoint) resolves through `checkedLookup`, and a literal address is
 * checked as it is, so a tenant's issuer cannot point the server at its own network. Redirects are answered as they
 * are (`openid-client` asks for `manual`), never followed. `'unchecked'` is for tests whose fake issuer listens on
 * loopback, which the rule always refuses.
 */
export function egressFetch(policy: EgressPolicy | 'unchecked'): client.CustomFetch {
  return (input, options) => {
    const url = new URL(input);
    const checked = policy === 'unchecked' ? undefined : policy;
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (checked !== undefined && isIP(host) !== 0) {
      try {
        checkEgress(url.hostname, host, checked);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('egress refused'));
      }
    }
    const body =
      options.body === undefined || options.body === null
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : options.body instanceof URLSearchParams
            ? options.body.toString()
            : undefined;
    return new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: options.method,
          headers: { ...options.headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) },
          agent: false,
          timeout: OIDC_TIMEOUT_MS,
          ...(checked !== undefined ? { lookup: checkedLookup(checked) } : {}),
          ...(options.signal !== undefined && options.signal !== null ? { signal: options.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > OIDC_MAX_RESPONSE_BYTES) {
              req.destroy(new Error('the identity provider answered more than 1 MiB'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) for (const one of value) headers.append(name, one);
              else if (value !== undefined) headers.set(name, value);
            }
            const status = res.statusCode ?? 502;
            const nobody = status === 204 || status === 304;
            resolve(new Response(nobody ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('the identity provider did not answer in time')));
      req.on('error', reject);
      req.end(body);
    });
  };
}
