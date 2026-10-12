# AWS Signature v4 and Digest auth — design

Issue #339 · milestone 5.2 · 2026-10-12

## Problem

APIs behind AWS need requests signed with Signature Version 4. Appliances and older enterprise systems
still answer with an HTTP Digest challenge. Today neither scheme exists: a cURL command with `--digest`
or `--aws-sigv4` imports as Basic or loses its credentials, and nothing else in the app can send one.

## What exists today (confirmed)

- Auth is modelled once (`project/model.ts` `AuthConfig`, `project/schema-parts.ts` `authConfigSchema` and
  `soapOwnerAuthSchema`). Every credential is a `…Ref` into the secret store, with an optional `…Env`
  name for CI. Plaintext value keys are refused by `refuseSecretValues`.
- `secrets/resolve.ts` `resolveAuthConfig` turns refs into a `SendAuth` (`http/auth/send-auth.ts`). The
  desktop, the CLI runner and MCP `send` all resolve through it (`run/send-helpers.ts` `authFor`).
- `http/auth/apply-auth.ts` `applyAuth` puts header and query credentials on the request. Anything
  needing the transport (Basic, NTLM, Kerberos) is handed to `http/auth/apply.ts` `sendWithAuth`, which
  REST (`rest/send.ts`) and SOAP (`soap/send.ts`) both call.
- `AuthSummary` reports what auth did. It crosses to the renderer as `authSummaryWireSchema` and the
  HTTP Log reads it.
- The Headers preview (#346, `rest/header-preview.ts`), the cURL export (`rest/curl.ts` `restToCurl`),
  code generation (`rest/codegen.ts`) and cURL import (`fromRestCurl`) each handle auth themselves.
- gRPC and WebSocket build their own auth headers and refuse schemes they cannot carry
  (`grpc/send.ts`, `ws/call.ts`).
- Project format 9 is not released yet: 5.0.0 shipped format 8.

## Decisions (owner, 2026-10-12)

1. **Credentials come from the secret store only.** Access key id, secret access key and session token
   are secret refs, each with an `…Env` name for CI. AWS profile files and `AWS_*` variables are a
   follow-up.
2. **The body is always hashed with SHA-256.** `X-Amz-Content-Sha256` is sent when the service is
   `s3`. There is no unsigned-payload option. The one exception is a presigned S3 URL: S3 defines that
   form with `UNSIGNED-PAYLOAD`, since the URL is used without a known body.
3. **The Digest nonce is remembered per origin for the session.** After a 401, later sends to that
   origin go out with the `Authorization` header already on and `nc` counted up. A 401 that is `stale`,
   or names a new nonce, is answered once with the new challenge. (The issue said "per connection".
   The owner chose per origin, which also saves the extra round trip on every send.)
4. **Digest supports MD5, SHA-256 and their `-sess` forms with `qop=auth`, plus the legacy form with
   no `qop` (RFC 2069).** A challenge that offers only `auth-int` fails with a clear error. Both schemes
   are offered on REST and SOAP owners. gRPC and WebSocket refuse them by name.

## Design

### Model and format

```ts
interface AwsSigV4Auth {
  type: 'aws-sigv4';
  region: string;            // property expansion applies
  service: string;           // e.g. execute-api, s3, lambda
  accessKeyIdRef?: string;  accessKeyIdEnv?: string;
  secretAccessKeyRef?: string; secretAccessKeyEnv?: string;
  sessionTokenRef?: string; sessionTokenEnv?: string;   // optional, for temporary credentials
  placement?: 'header' | 'query';  // default header; query = presigned URL
  expiresSeconds?: number;          // query only; 1..604800, default 900
}
interface DigestAuth { type: 'digest'; username?: string; passwordRef?: string; passwordEnv?: string }
```

- Both join `AuthConfig`, `authConfigSchema` and `soapOwnerAuthSchema`, wrapped in `refuseSecretValues`.
  `secretAccessKey`, `accessKeyId` and `sessionToken` are added to the refused plaintext keys.
- No format bump: the arms ride on the unreleased format 9, and its CHANGELOG entry names them.
- `secretNeedsOfAuth` lists all three SigV4 refs and the Digest password, so `secrets list` and
  `WIREBENCH_SECRET_*` work in CI. `missingSecretRef` reports a missing access key id or secret key.

### Engine

- `http/auth/sigv4.ts` is pure. `signSigV4(request, credentials, { now, placement, expiresSeconds })`
  returns the headers to add (or the presigned URL), the canonical request and the string to sign.
  - Canonical URI: each segment is percent-encoded per RFC 3986, so it is encoded twice for every
    service but `s3`. S3 paths are encoded once and not normalized, as AWS specifies.
  - Canonical query: names and values are decoded, then re-encoded (unreserved characters kept), then
    sorted by name and then by value.
  - Signed headers: `host`, `content-type`, `content-md5` when present, `range` and every `x-amz-*`
    header. Values are trimmed and runs of spaces collapsed. `User-Agent`, `Connection` and the like
    are left out, because proxies and the transport may change them.
  - Signing key: the HMAC chain `AWS4` + secret → date → region → service → `aws4_request`.
- `SendAuth` gains `{ type: 'aws-sigv4', region, service, accessKeyId, secretAccessKey, sessionToken?,
  placement, expiresSeconds }` and `{ type: 'digest', username, password }`. `applyAuth` hands both to
  the transport.
- `sendWithAuth` handles both:
  - SigV4 signs the final request (URL, method, merged headers, encoded body) at send time with
    `options.now`. A header placement adds `Authorization`, `X-Amz-Date`, `X-Amz-Security-Token` and
    `X-Amz-Content-Sha256` (s3). A query placement rewrites the URL. A typed `Authorization` still wins,
    and then nothing is signed.
  - Digest uses `http/auth/digest.ts` (pure): it parses the challenge, picks the strongest algorithm the
    server offers (SHA-256 before MD5), computes the response and formats the header. A per-origin
    `DigestNonceCache` holds `{ realm, nonce, opaque, algorithm, qop, nc }`. The module keeps one
    instance per process (the desktop session, or one CLI run), and tests inject their own. The flow:
    1. If a cached nonce exists, send with it (`nc` + 1). Otherwise send bare.
    2. On a 401 with a Digest challenge: retry once if this attempt was bare, or if the challenge is
       `stale=true`, or if it names a different nonce. The retry shares the timeout budget, as Basic's
       does. Then cache the challenge.
    3. Any other 401 is the result.
- `AuthSummary.scheme` gains both schemes. It also gets `signature?: { canonicalRequest, stringToSign }`
  for SigV4, which the HTTP Log shows.
- gRPC and WebSocket refuse `aws-sigv4` and `digest` with their `…-auth-unsupported` error. Signing a
  WebSocket handshake for API Gateway is a follow-up.
- Masking: the access key id and the session token are reported as secret values (the run's
  `onSecretValue` and the desktop's `recordAuthValues`), so they are masked wherever they echo.
  `X-Amz-Signature`, `X-Amz-Credential` and `X-Amz-Security-Token` join the sensitive query parameters,
  and `X-Amz-Security-Token` joins the sensitive headers. The Digest password never goes on the wire.

### Header preview, cURL export, code generation

- Preview: SigV4 rows are computed for real with the current time (source `auth`). With Show secrets
  off, the signature is computed from stand-in credentials and its value is masked. Digest shows a
  `handshake` row with the value `Digest`.
- cURL export: `--digest --user user:pass`. For a SigV4 header placement:
  `--aws-sigv4 aws:amz:<region>:<service> --user <key>:<secret>`, plus `-H 'x-amz-security-token: …'`
  when there is a session token. A query placement is noted rather than exported, because curl cannot
  presign. Secrets are masked as for Basic.
- Code generation in the other ten languages notes both schemes as not included, as it does for NTLM.
- SOAP's cURL export notes them too.

### cURL import

- `--digest` with `-u user:pass` becomes Digest. The password goes to the store.
- `--aws-sigv4 <provider1[:provider2[:region[:service]]]>` with `-u key:secret` becomes `aws-sigv4`.
  When region or service are missing, they are inferred from an `*.amazonaws.com` host
  (`<service>.<region>.amazonaws.com`). If inference fails they are left empty and a problem says so.
  An `x-amz-security-token` header moves out of the headers into the session-token secret.

### Desktop

- `authConfigWireSchema` gains the new fields. `AuthFields` offers *AWS Signature v4* (region, service,
  access key id, secret access key, session token, placement, expiry) and *Digest* (username, password),
  on REST and SOAP owners.
- The HTTP Log detail's Headers tab shows *Canonical request* and *String to sign* when the row has a
  signature, masked like the headers.

## Out of scope (follow-ups)

AWS profiles and environment variables; unsigned payload; `qop=auth-int`; `userhash`; SigV4A; signing
a WebSocket handshake; mapping SigV4 and Digest in the collection importers.

## Testing

- SigV4: the AWS SigV4 test suite vectors (`get-vanilla`, `post-vanilla`, `get-vanilla-query-order-key-case`,
  `get-vanilla-query-unreserved`, `post-x-www-form-urlencoded`, `get-header-value-trim`, `get-utf8`,
  `post-header-key-sort`, `post-sts-header-before`). The canonical request, the string to sign and the
  `Authorization` must match byte for byte. Also the S3 documentation's presigned-URL example.
- Digest: the RFC 7616 §3.9.1 examples (MD5 and SHA-256), the RFC 2617 §3.5 example, the legacy no-qop
  form and the `-sess` forms.
- Integration: a local server that verifies Digest (including stale, nonce reuse and `nc` counting up
  across sends) and checks a SigV4 signature, on REST and SOAP. A CLI run and MCP `send` with
  `WIREBENCH_SECRET_*` values. cURL import and export round-trips. The renderer form and the HTTP Log
  detail.
