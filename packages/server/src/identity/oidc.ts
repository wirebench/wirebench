import * as client from 'openid-client';

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
  authorizationUrl(input: { readonly state: string; readonly nonce: string; readonly redirectUri: string }): string;
  /** Exchanges the code in `callbackUrl` and verifies the ID token; rejects when the IdP refuses. */
  exchange(input: { readonly callbackUrl: URL; readonly state: string; readonly nonce: string }): Promise<OidcClaims>;
}

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL`: an `http://` issuer, for the in-test one only. */
  readonly allowInsecure: boolean;
}

/**
 * Discovery at start-up (§4.1) and the two operations the routes need. `openid-client` performs
 * discovery over TLS, validates the ID token's signature against the issuer's JWKS and checks
 * `iss`, `aud`, `exp`, `nonce` and `state`; the configured issuer is pinned by construction
 * (§6). Nothing outside this file names the library (§15).
 */
export async function discoverOidc(settings: OidcSettings): Promise<OidcProvider> {
  const config = await client.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret,
    undefined,
    settings.allowInsecure ? { execute: [client.allowInsecureRequests] } : {},
  );
  const issuer = config.serverMetadata().issuer;
  return {
    issuer,
    authorizationUrl: ({ state, nonce, redirectUri }) =>
      client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: settings.scopes.join(' '),
        state,
        nonce,
      }).href,
    exchange: async ({ callbackUrl, state, nonce }) => {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
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
