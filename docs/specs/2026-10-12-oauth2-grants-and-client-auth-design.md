# More OAuth 2 grants and client authentication — design

Issue #338 · milestone 5.2 · 2026-10-12

## 1. What exists today

- `packages/engine/src/http/auth/oauth2.ts` is the pure half. It builds the authorization URL and
  the token request for the client-credentials, authorization-code and refresh grants, and it reads
  token responses. `needsRefresh` treats a token as stale 30 s before `expiresAt`.
- `apps/desktop/src/main/oauth2.ts` (`OAuth2Service`) keeps one token cache per session. On each
  send, `accessToken()` returns the cached token, or refreshes it **when it is within 30 s of
  expiry and a refresh token exists**. If the refresh fails, it re-runs client credentials, or
  raises `oauth2-sign-in-required` for authorization code. So the app already refreshes before
  expiry, lazily at send time. Nothing runs on a timer, and this design keeps it that way: a
  background timer would refresh tokens nobody is using.
- `packages/engine/src/run/oauth2-token.ts` is the run's token source. It does client credentials
  only, refuses authorization code, and never uses a refresh token: when a token is about to lapse,
  it simply fetches a new one.
- `clientAuth` is `basic | body`. Keystores (`project.keystores`, loaded by `keystoreFor` in a run
  and by the desktop's keystore loader) already hold PEM keys and certificates by id and alias.

## 2. Model

`OAuth2Auth` gains:

| Field | Type | Used by |
| --- | --- | --- |
| `grant` | adds `'password'`, `'device-code'` | |
| `username` | string, property-expanded | password |
| `passwordRef` / `passwordEnv` | secret ref / CI name | password |
| `deviceAuthorizationUrl` | string, property-expanded | device code |
| `clientAuth` | adds `'client-secret-jwt'`, `'private-key-jwt'`, `'tls-client-auth'` | |
| `clientKeystoreId` | keystore entry id; its default alias, as for TLS | private-key-jwt, tls-client-auth |
| `assertionAlg` | `JwtAlg`, optional | client-secret-jwt, private-key-jwt |
| `refreshTokenEnv` | CI name for `refreshTokenRef` | any grant, in a run |

The schema stays loose, and no secret value is accepted (`refuseSecretValues`). An older build
cannot parse the new enum values, so it reports the file as invalid instead of sending it the
wrong way. Because of that, the format stays at 9, as with #345's additive keys. The generated
JSON schemas are regenerated.

## 3. Engine

### 3.1 JWT signer (shared with #348)

`http/auth/jwt-sign.ts` exports `signJwt({ alg, key, header?, claims })`, which signs with
HS/RS/PS/ES at 256/384/512 using `node:crypto` only. ES signatures use the JOSE form
(`dsaEncoding: 'ieee-p1363'`). The module also exports `defaultAlgFor(keyPem)`: RS256 for an RSA
key, and ES256, ES384 or ES512 for P-256, P-384 or P-521. Any other key is refused. The signer
lives in the engine so that #348 can reuse it.

### 3.2 Client assertion (RFC 7523 §2.2)

`clientAssertion({ config, key, alg?, now, jti })` returns a JWT with `iss = sub = client_id`,
`aud = tokenUrl`, `iat`, `exp = iat + 60`, a random `jti`, and a `kid` header. For a private key,
the `kid` is the certificate's SHA-256 thumbprint, base64url-encoded. The two methods sign with:

- `client-secret-jwt`: HMAC with the client secret, HS256 by default.
- `private-key-jwt`: the keystore alias's private key, with `defaultAlgFor` deciding the algorithm.

`assertionAlg` overrides either default. HS is refused for a private key, and RS/PS/ES are
refused for a secret.

### 3.3 Token request

`buildTokenRequest` gains these grants:

- `password`: `username`, `password` and `scope`.
- `device-code`: `grant_type=urn:ietf:params:oauth:grant-type:device_code` and `device_code`.

The secrets it takes gain `password` and `clientAssertion`. Client authentication then works by
method:

- `basic` / `body`: unchanged.
- `client-secret-jwt` / `private-key-jwt`: `client_id`, `client_assertion_type` and
  `client_assertion` go in the body. No `Authorization` header is sent.
- `tls-client-auth`: `client_id` goes in the body and no secret is sent. The host puts the
  keystore identity on the TLS connection.

### 3.4 Device authorization (RFC 8628)

- `buildDeviceAuthorizationRequest(config, secrets)` POSTs `client_id` and `scope`, using the same
  client authentication as the token request.
- `parseDeviceAuthorizationResponse` returns `{ deviceCode, userCode, verificationUri,
  verificationUriComplete?, expiresAt, intervalMs }`.
- `pollDeviceToken({ send, request, interval, expiresAt, sleep, now, signal })` polls the token
  endpoint until it gets a token. It handles `authorization_pending` by waiting, and `slow_down` by
  adding 5 s to the interval. `access_denied` and `expired_token` end the flow, as an
  `oauth2-token-error` carrying the provider's code. The flow also times out at `expiresAt` with
  `oauth2-timeout`, and an abort raises `oauth2-cancelled`.

### 3.5 Run token source

The cache key now includes the grant, the username and the client auth method. Order per
configuration:

1. A cached token that `needsRefresh` does not flag is used as it is.
2. If a refresh token is known, the refresh grant runs. The token can come from the cached token
   or, the first time, from `refreshTokenRef` (in CI, `WIREBENCH_SECRET_<refreshTokenEnv>`).
3. If the refresh fails, or no refresh token exists, the configured grant runs when it is headless
   (client credentials or password). Authorization code and device code are refused with
   `auth-grant-unsupported`. The message names `refreshTokenEnv`.

Both key-based methods take the keystore's client identity (`cert` + `key` PEM, default alias)
through a new `identityFor(keystoreId)` on the token request context, which a run fills from the
host's `tls.identityFor` or its own `clientIdentityFor`. `private-key-jwt` signs with that key, and
`tls-client-auth` presents it on the token request instead of the request's own identity. `secretNeedsOfAuth` adds the
password, and adds the refresh token for authorization-code and device-code configurations. The
protocol modules add the keystore password need for `clientKeystoreId`.

## 4. Desktop

`OAuth2Service`:

- `fetchToken` runs password like client credentials, which needs no browser.
- `device-code` posts the device authorization request and moves the status to
  `pending` with `{ userCode, verificationUri, verificationUriComplete, expiresAt }`. It then polls.
  `cancel()` aborts the poll. A device-code flow and a browser flow share the single pending slot.
- `accessToken` for device code behaves like authorization code: it refreshes when it can and
  otherwise raises `oauth2-sign-in-required`. Password behaves like client credentials and re-runs
  silently.
- Client assertions and TLS identity come through the same `identityFor(keystoreId)`. A send passes
  it through the token source, and the `oauth2.fetchToken` channel takes it from the project's
  `clientIdentityFor`.

`oauth2.status` gains an optional `device` object. Main opens the verification page itself when the
flow starts, as the authorization-code flow opens the browser, so no new channel is needed. While
Get token waits, the renderer reads the status every second. It shows the user code in large
monospace with a Copy button, the verification URL as selectable text (the code can be entered on
any device), and Cancel. The auth editor gains:

- the two grants;
- Username plus the Password secret field (password grant);
- the Device authorization URL field (device code);
- the four client auth options;
- a Keystore select (private-key-jwt and tls-client-auth);
- the Algorithm select (both JWT methods).

## 5. Import and export

- **Postman `password` grant**: maps to `grant: password`. The username is kept. The password is
  dropped with the usual warning.
- **OpenAPI `flows.password`**: maps to the password grant.
- **OpenAPI 3.2 `deviceAuthorization` flow**: maps to the device-code grant.
- **OpenCollection `password` flow**: maps to the password grant.
- **Exporters**: write the password grant where the target format has one. A device-code or JWT
  client-auth configuration is exported as its nearest form with a warning, or skipped where the
  format has nothing close.

## 6. Out of scope

Token exchange (RFC 8693), the JWT-bearer grant (RFC 7523 §2.1), `self_signed_tls_client_auth`,
DPoP, and refresh on a background timer.

## 7. Tests

- **Engine unit tests**: the signer, verified with `crypto.verify` for each algorithm; the
  assertion claims; each grant's form body; device parsing; and polling with a fake clock.
- **Engine integration test**: a local OAuth server (`test/helpers/test-oauth-server.ts`) that
  serves the password, refresh, client-credentials and device-code grants. It verifies
  client_secret_jwt and private_key_jwt assertions and checks mTLS client certificates. A `wirebench
  run`-level test covers password then refresh, and refresh from the environment for an
  authorization-code configuration.
- **Desktop unit tests**: the device flow states, password, and JWT client auth through
  `OAuth2Service`.
- **Renderer jsdom tests**: the editor fields and the device status panel.
