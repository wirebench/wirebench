# Wirebench: the same-host `http://` → `https://` redirect — design

Date: 2026-10-08 · Status: approved · Issue #71.

- Decisions recorded here (owner, 2026-10-08):
  - **Follow it, keep the method and the body.** The upgrade is followed even when Follow Redirects is
    off, and the request is resent as written: same method, same body, same credentials.
  - **Strict shape.** Only the exact upgrade defined in §2 qualifies; anything else behaves as today.
  - **SOAP and REST alike.** The rule lives in the shared HTTP client, so every send gets it.

## 1. Goal

A server that answers `http://host/path` with a redirect to `https://host/path` means "same request,
over TLS". Today a SOAP send does not follow redirects by default, so the user sees the redirect page
and a `not-soap` Problem. With Follow Redirects on, or for REST by default, a `POST` that gets a 301 or
302 becomes a bodyless `GET` and the envelope is lost. Neither is what the server asked for.

## 2. The shape

A redirect response is an **HTTPS upgrade** when all of these hold:

- its status is 301, 302, 307 or 308 (303 means "fetch something else with a `GET`" and is excluded);
- the hop's URL is `http:` on the default port (no port, or `:80`);
- the `Location`, resolved against the hop's URL, is `https:` on the default port (no port, or `:443`);
- the host, the user info, the path and the query are unchanged (the host is compared as the URL parser
  normalises it, so case is ignored). The fragment is ignored: it never reaches the wire.

## 3. Behaviour

- `sendHttp` follows an HTTPS upgrade whatever `followRedirects` says, and keeps the method and body
  whatever the status (the downgrade rule for 301 and 302 does not apply to it).
- The hop is recorded in `redirects[]` with `upgrade: true`. It does not count against `maxRedirects`:
  it can happen at most once per send, because the next hop is already `https:`.
- Credentials go with it. The `Authorization`, `Proxy-Authorization` and hand-set `Cookie` headers are
  kept, though the origin changes (the scheme is part of it): the move is to the same host over a
  stronger channel. The request's own `originCredentials` move with it too: from then on the upgraded
  origin counts as the request's own, so a later hop back to it gets them again. The cookie jar is
  matched per hop as always, so a `Secure` cookie for the host is now sent.
- After the upgrade, every later redirect follows the existing rules, `followRedirects` included: with
  it off, a further redirect is returned as the response.
- NTLM and Kerberos (#266): a challenge from the upgraded hop is answered there. `challengedRequest`
  treats the request's upgraded origin as its own, so the later legs go to the `https:` hop instead of
  failing with `<scheme>-cross-origin`.

## 4. What the user sees

- **SOAP**: a Problem `https-upgrade` on the exchange: "`http://…` redirected to `https://…`; the
  request was resent there with its method and body. Change the endpoint to `https://` to skip the
  redirect."
- **REST**: the upgrade does not set `methodChanged`. The Redirects tab marks the hop.
- **Redirects view** (REST response and the HTTP Log, both protocols): the upgrade hop carries an
  "upgraded to HTTPS" note. The wire schema for a hop gains `upgrade?: true`.

## 5. Not in scope

- Upgrades to a non-default port (`:8080` → `:8443`), changed paths, or cross-host upgrades.
- Rewriting the saved endpoint automatically.
- WSDL and document fetches, which already follow redirects with `GET`.

## 6. Tests

- Engine, `sendHttp` against a local HTTP + HTTPS pair: a POST upgraded with each of 301/302/307/308
  arrives as POST with its body and `Authorization`; with `followRedirects: false`; 303 is not an
  upgrade; a changed path, query, host or port is not an upgrade; the hop is marked `upgrade: true`.
- Unit test for the shape predicate.
- `challengedRequest` accepts the upgraded origin and still refuses any other.
- SOAP send records the `https-upgrade` Problem; REST `methodChanged` stays false.
