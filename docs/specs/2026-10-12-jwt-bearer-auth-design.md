# Client-signed JWT bearer auth — design

Issue #348 (milestone 5.2, P2, S). Many service APIs expect a JWT the client signs itself. Today a
user has to sign one elsewhere and paste it into a bearer token, which goes stale within minutes.

## 1. Scope

- A new auth type `jwt` for REST, WebSocket and gRPC requests, folders and APIs (anything that
  takes an `AuthConfig` and inherits). SOAP owners and definition fetches do not offer it.
- Signs with HS, RS, ES or PS at 256, 384 or 512 bits (12 algorithms). Signing goes through
  [`jose`](https://github.com/panva/jose), already in the dependency tree.
- HMAC secrets are secret-store references (`secretRef`/`secretEnv`, like every other secret).
  Private keys come from a keystore entry (`wss/keystores.yaml`) and an alias. Nothing secret is
  written into project files.
- A PEM keystore may now hold only a private key (no certificate). Everything that needs a
  certificate (TLS client identity, WS-Security) refuses such an entry with a clear message.
- `iat`, `exp` and `jti` can be generated.
- Sent as a header with a configurable name and prefix (default `Authorization: Bearer <jwt>`) or as
  a query parameter (default `access_token`).
- Works in the app, the CLI and MCP `send`, all through the engine's `authFor`.

Out of scope: EdDSA, JWE, `x5c`/`jwk` header generation, JWT auth on SOAP or definition fetches,
importing JWT auth from other collection formats (they map to their own types today).

## 2. Model

```ts
type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | … | 'PS512';

interface JwtAuth {
  type: 'jwt';
  algorithm: JwtAlgorithm;
  secretRef?: string;   // HS*: the shared secret, UTF-8
  secretEnv?: string;   // CI name: WIREBENCH_SECRET_<name>
  keystoreRef?: string; // RS/ES/PS: keystore entry id
  alias?: string;       // else the keystore's defaultAlias, else its only key
  header?: string;      // extra protected-header fields as a JSON object (kid, typ, …)
  claims: string;       // the payload as a JSON object
  issuedAt: boolean;    // add iat = now
  expiresInSeconds?: number; // add exp = now + N; absent or 0: none
  jwtId: boolean;       // add a random UUID jti
  in: 'header' | 'query';
  name?: string;        // header name (Authorization) or query name (access_token)
  prefix?: string;      // header only; default Bearer, '' sends the bare token
}
```

`alg` always comes from `algorithm`; `typ` defaults to `JWT`. Generated claims overwrite claims of
the same name in `claims`, because the toggle is the more explicit statement.

## 3. Templating

`claims` and `header` are parsed as JSON first, then every **string value** is expanded against
the request's property scopes (`${env.x}`, `${$randomUUID}`, `${secret:x}`…). Expanding values
after parsing means a value holding a quote cannot break the JSON. One exception keeps
NumericDate claims usable: a string that is exactly one `${…}` reference, under `exp`, `nbf` or
`iat`, becomes a number when it expands to an integer. An unresolved reference refuses the send
(`unresolved-properties`), as OAuth2's fields do.

## 4. Signing and reuse

`http/auth/jwt.ts` (engine, shared with #338's `private_key_jwt`):

- `signJwt({ algorithm, key, header, claims })` — `jose.SignJWT`; key is a `KeyObject` (private
  key) or the HMAC secret bytes. A key of the wrong type or curve is `jwt-key-mismatch`.
- `createJwtSource({ now, randomId })` — signs and caches. Owner decision: a token is **reused
  until 30 seconds before its `exp`**, then re-signed. A token with no `exp` is signed on every
  send (nothing tells when it goes stale). The cache key is the algorithm, the key's identity
  (secret ref, or keystore id + alias) and the expanded header and claims — so changing a claim
  or an environment value signs a new token. A server refusing the token (401, gRPC
  UNAUTHENTICATED) drops it, like an OAuth2 token.
- Runs create one source per run (like the OAuth2 source); the app keeps one for its lifetime.

## 5. Placement and masking

New `SendAuth` arm `{ type: 'jwt', token, in, name, prefix }`. `applyAuth` puts it on the header
or query; gRPC puts it in metadata (header placement only). Every host masks the token: the
engine reports it through `onSecretValue`, the app records it for redaction.

## 6. App

- Auth editor: algorithm select; a secret field for HS, a keystore + alias picker for the rest;
  claims and header as JSON text; the three generation toggles with the lifetime; placement,
  name and prefix.
- Header preview (#346): `Authorization: Bearer <signed JWT>` while secrets are hidden; the real
  token when shown.
- Code generation (#337), owner decision: the snippet carries a token **signed at generation
  time**.
- Removing a keystore clears `keystoreRef` from JWT auth that names it, as it already does for
  `sslKeystoreRef`.

## 7. CLI and MCP

No new flags: `authFor` signs. `secrets list` reports the HMAC secret and the keystore password.
The keystore is read from inside the project folder, as for TLS identities.

## 8. Errors

`jwt-claims-invalid`, `jwt-header-invalid` (not a JSON object), `jwt-key-missing` (no keystore or
secret, unknown keystore, alias without a private key), `jwt-key-mismatch`, plus the existing
`secret-missing` and `unresolved-properties`.
