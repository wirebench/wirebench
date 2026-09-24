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
