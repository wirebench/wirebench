# ADR-0024: HTTP/2 is offered by default, and connection-bound auth is pinned to HTTP/1.1

- Status: accepted
- Date: 2026-10-12
- Context: issue #80; `docs/specs/2026-10-12-http2-default-transport-design.md`.

## Context

REST and SOAP sends go through one undici-based transport. A preference, **Offer HTTP/2**
(`http.allowH2`), was meant to make HTTP/2 opt-in. Only the proxied path ever stated the flag.
undici 8 offers `h2` when `allowH2` is unstated, so with the preference off:

- every direct HTTPS send already offered HTTP/2;
- so did the single-connection dispatcher used by NTLM and Kerberos.

Those two schemes authenticate the connection, which HTTP/2 has no room for. IIS answers such a
request with `HTTP_1_1_REQUIRED`, and undici does not retry on that error.

The measurements in the spec showed:

- every server either picked one of the two offered protocols or ignored ALPN and stayed on
  HTTP/1.1, and no handshake failed;
- no measurable latency difference on a single send.

## Decision

- **HTTP/2 is offered by default, and ALPN is the fallback.** Every HTTPS handshake offers
  `h2, http/1.1`, the proxied tunnel included. The server picks, so a stack that speaks only
  HTTP/1.1 stays on it. Plain HTTP is always HTTP/1.1: there is no h2c.
- **Every dispatcher states `allowH2`.** The transport never relies on undici's default, which has
  changed between majors. `HttpRequest.allowH2` unset means "offer h2", and `false` pins the send to
  HTTP/1.1.
- **NTLM and Kerberos are always HTTP/1.1**, whatever the send's own setting says.
- **The preference moves to `http.offerH2`, default `true`.** Every saved preferences file carried
  `allowH2: false`, written by the old default, and that value never turned HTTP/2 off for a direct
  send. Reading it as "off" would have moved users from the HTTP/2 they actually had to HTTP/1.1. So
  the old key is dropped, not migrated.
- **The exchange label stays honest.** `httpVersion` comes from the negotiated ALPN, so the raw
  view, the HTTP Log and the HAR export say what was actually spoken.

## Consequences

- A server that asks for a client certificate mid-connection, through TLS renegotiation (IIS
  per-path client certificates), cannot do so over HTTP/2. The user turns **Offer HTTP/2** off for
  it, and the preference hint says so.
- A user who had deliberately turned **Offer HTTP/2** on keeps HTTP/2. A user who had it off, by
  default, also keeps the HTTP/2 they had on direct sends, and now gets it through a proxy too.
- The command line and the MCP server read no preferences, so they offer HTTP/2 as well.
- gRPC is unaffected: it always speaks HTTP/2, through its own client.
