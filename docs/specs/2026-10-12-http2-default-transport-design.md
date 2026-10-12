# HTTP/2 as the default transport — design

Issue #80 · milestone 5.2 · 2026-10-12

## Question

Should REST and SOAP sends offer HTTP/2 by default, and if so, what is the fallback? The issue's
"done when" asks for two things: measure negotiation against the interop fixtures, then decide the
default and the fallback.

## What exists

- **One transport.** REST and SOAP both go through `sendHttp` in `packages/engine/src/http/client.ts`
  on undici 8. Dispatchers come from three places:
  - `getDefaultAgent()`, for a send with no TLS, proxy or bind options;
  - `createDispatcher()`, when a send has TLS, proxy or bind options;
  - `createSingleConnectionDispatcher()`, used by NTLM (`auth/ntlm-transport.ts`) and Kerberos/SPNEGO
    (`auth/kerberos-transport.ts`).
- **A toggle.** The **Offer HTTP/2** preference (`http.allowH2`, default `false`) reaches
  `HttpRequest.allowH2` through `soap/send-input.ts` and `rest/send-input.ts`. A SOAP run override
  can set it too. Its hint says "Off by default".
- **An honest label.** `HttpExchange.httpVersion` is taken from the negotiated ALPN, not from the
  offer. That label reaches several places:
  - the raw view's status line (`raw-capture.ts`);
  - the REST status line;
  - the HTTP Log;
  - the HAR export (`apps/desktop/src/main/har.ts`).
- **gRPC** uses `@grpc/grpc-js`, which always speaks HTTP/2. It is out of scope here.
- **Perf budgets** (`packages/engine/test/perf`) cover parsing and import, not the transport.

## Finding: HTTP/2 is already on, and the toggle does not turn it off

undici 8 changed `allowH2` to default to `true` when the option is absent
(`lib/core/connect.js`: `allowH2 = allowH2 != null ? allowH2 : true`). Wirebench only states the
flag when it is `true`, or on the proxied path (fixed in 2a950fa1). Here is what each dispatcher
offers today:

| Dispatcher                           | Toggle off    | Toggle on |
| ------------------------------------ | ------------- | --------- |
| Default agent (no TLS/proxy options) | **offers h2** | offers h2 |
| `createDispatcher` with TLS options  | **offers h2** | offers h2 |
| `createDispatcher` through a proxy   | 1.1 only      | offers h2 |
| NTLM / Kerberos single connection    | **offers h2** | offers h2 |

Measured against a local `http2.createSecureServer({ allowHTTP1: true })` with `allowH2: false`:
the exchange came back with `httpVersion: '2'`. Against `https://httpbin.org` it was the same for
both the default agent and the single-connection dispatcher. So:

- Users of a direct HTTPS connection already speak HTTP/2 to every server that selects it,
  whatever the preference says. The hint "Off by default" is wrong.
- **NTLM and Kerberos can negotiate HTTP/2, and that is a real bug.** Both schemes authenticate
  the _connection_. HTTP/2 rules that out (RFC 9113 §8.2.3 keeps no connection-specific state), and
  IIS answers a Windows-auth request on h2 with `HTTP_1_1_REQUIRED`. undici has no fallback for that
  error, so the send fails. The comment on `createSingleConnectionDispatcher` assumes it is pinned
  to 1.1; only the proxied branch actually is.

## Measurements

### Negotiation against the interop fixtures and common APIs

The probe offered `h2, http/1.1` in a plain `tls.connect` and recorded the server's pick
(2026-10-12).

| Host                                                                                                            | Picked                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| www.dataaccess.com (NumberConversion)                                                                           | h2                        |
| www.w3schools.com (TempConvert)                                                                                 | h2                        |
| www.dneonline.com (Calculator)                                                                                  | plain HTTP only — no ALPN |
| webservices.oorsprong.org (CountryInfo)                                                                         | plain HTTP only — no ALPN |
| www.crcind.com (soapdemo, absent from the suite)                                                                | no ALPN selected → 1.1    |
| api.github.com, api.stripe.com, www.googleapis.com, httpbin.org, postman-echo.com, jsonplaceholder.typicode.com | h2                        |
| login.microsoftonline.com, graph.microsoft.com                                                                  | no ALPN selected → 1.1    |
| sts.amazonaws.com, s3.amazonaws.com                                                                             | http/1.1                  |

Every server either picked one of the two offered protocols or ignored ALPN and stayed on 1.1. No
handshake failed because h2 was on offer. Both HTTPS interop services already answer the nightly
suite over h2, since the default agent offers it.

### Latency and multiplexing

The probe ran `sendHttp` over loopback through a TLS `createDispatcher`.

| Server delay | Mode  | Sequential / request | 50 in parallel (total) | Cold connection / request |
| ------------ | ----- | -------------------- | ---------------------- | ------------------------- |
| 20 ms        | "1.1" | 22.2–22.4 ms         | 28–34 ms               | 26.6–27.0 ms              |
| 20 ms        | h2    | 21.8–22.4 ms         | 26–39 ms               | 24.0–27.0 ms              |
| 0 ms         | "1.1" | 1.5 ms               | 6–7 ms                 | 3.9–4.1 ms                |
| 0 ms         | h2    | 1.4–1.5 ms           | 6 ms                   | 3.9–4.4 ms                |

The "1.1" rows were meant to measure HTTP/1.1, but because of the finding above they negotiated
h2 as well. They are effectively h2 against h2, which is the point: today's "off" and "on" cannot
be told apart.

A single workbench send gains nothing measurable from HTTP/2. Multiplexing only helps concurrent
sends to one origin, such as a data-driven run with concurrency. On loopback even that is within
noise.

## Caveats

These hold whichever option is chosen.

- **NTLM, Kerberos/SPNEGO (Negotiate).** These schemes are connection-bound, so they must always
  stay on HTTP/1.1, whatever the preference says.
- **Basic, Digest, OAuth 2, JWT, SigV4, API keys and WS-Security** are per-request. They work over
  h2 unchanged.
- **Client certificates.**
  - A certificate presented in the initial handshake works over h2.
  - Some servers ask for a certificate _mid-connection_ through TLS renegotiation, such as IIS's
    per-path "require client certificate". HTTP/2 forbids renegotiation (RFC 9113 §9.2.1), so
    against such a server the request fails until HTTP/2 is turned off.
- **Proxies.**
  - HTTPS through an HTTP CONNECT proxy negotiates ALPN end-to-end inside the tunnel, so h2
    works. The proxy itself is always reached over HTTP/1.1.
  - A TLS-intercepting corporate proxy terminates TLS and picks its own ALPN, typically 1.1. That
    is a harmless fallback.
  - Plain-HTTP targets never use h2 (no h2c).
- **Header fidelity.** HTTP/2 sends header names in lower case and has no `Connection`,
  `Keep-Alive`, `Transfer-Encoding` or `Upgrade`. The raw view already labels such an exchange
  `HTTP/2`. undici already rejects the last three in a user's headers over 1.1 too, so that is not
  new.
- **SOAP stacks** that speak 1.1 only do not select h2. ALPN keeps them on 1.1.

## Options

1. **HTTP/2 by default with ALPN fallback (recommended).** Make today's behaviour deliberate and
   honest:
   - offer `h2, http/1.1` on every HTTPS send, the proxied path included;
   - always pin NTLM and Kerberos to HTTP/1.1;
   - keep the preference as an opt-out, defaulting to on, with a hint that names the
     client-certificate-renegotiation caveat.

   A stored `allowH2: false` cannot be told apart from the old default. Since that value never
   actually turned h2 off for direct sends, the preference moves to a new key so that every
   existing user keeps the behaviour they had.
2. **Opt-in, per project/preference or per request.** Fix the bug the other way: state
   `allowH2: false` on every dispatcher, so "off" really means 1.1, pin NTLM and Kerberos, and keep
   the default off. This changes what direct-HTTPS users have had since undici 8: they drop back to
   1.1.
3. **Keep HTTP/1.1.** As option 2, and remove the toggle as well.

Option 1 has the smallest behaviour change for users, because it matches what they get today. It
also closes the real NTLM/Kerberos bug, and it costs nothing measurable.
