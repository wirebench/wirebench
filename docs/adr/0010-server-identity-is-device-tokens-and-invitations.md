# ADR-0010: Server identity is device tokens, invitations and OIDC linking by verified email

Status: accepted · Date: 2026-09-24 · Spec: `docs/specs/2026-09-24-wirebench-server-identity-design.md`

## Context

Wirebench Server (ADR-0009) needs to know who is calling before it can host workspaces, teams and
roles. Teams run their own identity provider, or none; the desktop app is the only client today, but
the CLI runner will follow; the server may sit behind a proxy and be reached from a laptop that is
sometimes offline.

## Decision

- **Opaque device tokens, not JWTs.** A sign-in from one installation mints one `wbs_` token, stored
  hashed, with an idle expiry (30 days) and an absolute one (180 days). Revocation is a row update
  and takes effect on the next request; there is no signing key to rotate and nothing to decode
  client-side.
- **Invitation-only.** No open registration: an admin creates an invitation for an email, the link
  carries a one-time secret, and accepting it creates the user. A password reset is an invitation of
  kind `reset`. The first admin comes from `admin invite` on the server's command line.
- **Two methods, one user.** Local (email + scrypt password) and OIDC (Authorization Code + PKCE via
  `openid-client`), both attached to the same user row. An OIDC login links to an existing user by
  `email_verified` email, creates one only against an open invitation, and refuses everything else.
- **The browser hand-off ends on the app's loopback with a one-time grant, not a token.** The server
  redirects to `http://127.0.0.1:<port>/callback?flow=&grant=`; the app trades the grant plus its PKCE
  verifier for the token over HTTPS. A token never appears in a URL.
- **The desktop keeps the token in the OS keychain and the renderer never sees it.** `accounts.yaml`
  holds a keychain reference; main adds the bearer header.

## Consequences

- One `SELECT` per authenticated request (token hash → user), cached by nothing; fine at this scale
  and simple to reason about. Revocation is immediate.
- The rate limiter and the OIDC flow table are per instance / in the database respectively; a second
  replica shares the flows but not the limiter (ADR-0009's one-replica note still applies).
- Every later module reads `request.caller` and never a header; `requireUser` / `requireServerAdmin`
  are the only gates.
- IdPs that omit `email_verified` cannot link; the refusal names the claim. Scopes are configurable
  per server.

## Alternatives considered

- **JWT access tokens.** Stateless, but revocation needs a denylist anyway, the desktop would have to
  refresh, and a leaked signing key is a disaster. Rejected.
- **Sessions in cookies.** The client is a desktop app and a CLI, not a browser. Rejected.
- **OIDC only.** Small teams and home labs have no IdP. Local accounts stay, behind invitations.
- **Passing the token on the loopback redirect.** Simpler, but a token in a browser history and proxy
  log. The one-time grant plus PKCE costs one extra request. Rejected.
