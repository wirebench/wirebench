# Wirebench Server: SAML sign-in and SCIM provisioning — design

Issue: #344 · Date: 2026-10-13 · Status: questions answered by the owner on 2026-10-13 · Modules: `identity`
and `teams-access` of `docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Builds on: `docs/specs/2026-09-24-wirebench-server-identity-design.md` (users, device tokens, the OIDC
  loopback flow, the linking rules of §3.3), `docs/specs/2026-09-24-wirebench-server-teams-access-design.md`
  (teams, members, the last-admin rule), the licensing spec (features and seats) and the audit-log spec
  (closed action list, flat `details`).
- Decisions taken with the owner on 2026-10-13:
  1. **Enterprise only.** One new licence feature, `sso-provisioning`, gates SAML sign-in and SCIM. An
     Enterprise licence grants it by default; an explicit feature list may grant it to a Team licence. OIDC
     and local accounts stay in every edition.
  2. **SP-initiated only.** Every SAML response must answer an `AuthnRequest` this server sent, once.
     Unsolicited (IdP-initiated) responses are refused.
  3. **SCIM or invitation creates accounts.** SAML sign-in links to an existing user or consumes an open
     invitation, exactly as OIDC does (identity §3.3). It never creates an account for an unknown person.
  4. **An admin maps IdP groups to teams.** SCIM groups are stored; a server admin links a group to an
     existing team. An unmapped group changes nothing.
  5. **SCIM changes only the memberships it added.** Members of a linked group join the team as `member`.
     Removing them from the group removes only those SCIM added. Hand-added members and every role stay
     with Wirebench.
  6. **Deprovisioning disables and keeps the data.** `active: false` and `DELETE` both do what an admin's
     disable does: sign-in refused, every device token revoked, seat freed, nothing deleted. SCIM re-enables
     with `active: true`.
  7. **Mapping is managed from the API, the CLI and a desktop panel.** A Provisioning tab in the team
     dialog lists groups, their teams and the SCIM tokens.
- Library: **`@node-saml/node-saml`** for the SAML protocol and XML signature checks (§6).

## Assumptions I'm making

1. **One IdP per server, for SAML.** As with OIDC, the server is configured with one identity provider,
   from its metadata. A second IdP is a later issue.
2. **The SAML flow is the OIDC flow with a different middle.** The desktop starts a flow with a PKCE
   challenge and a loopback port; the browser goes to the IdP; the IdP posts back to this server; the
   server links and hands the browser a one-time grant for the loopback; the desktop proves the verifier
   and the grant and gets an ordinary device token. Nothing after sign-in knows it was SAML.
3. **The IdP's email attribute is trusted.** SAML has no `email_verified`. The IdP is pinned by its
   metadata and its signing certificate, both chosen by the server operator, so the email it asserts is
   treated as verified. §6 says what that trust means.
4. **Assertions are signed and not encrypted.** The assertion must carry a valid signature. Encrypted
   assertions are a non-goal: the IdP posts over TLS to this server, and nothing else sees the response.
5. **SCIM sits at the server root, `/scim/v2`, outside `/api/v1`.** It has its own credential (a SCIM
   token), its own error format (RFC 7644 §3.12) and its own media type. Device tokens never work there,
   and SCIM tokens never work anywhere else.
6. **The integration tests use real signed XML.** A test IdP key and certificate are checked in as
   fixtures. The tests sign responses with `xml-crypto`, as an IdP would, then tamper with them. Live
   Entra ID and Okta checks are a manual checklist in the docs, with captured, anonymised responses kept
   as fixtures.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Two things an enterprise IdP expects from a server it is told to trust:

- **SAML 2.0 sign-in** beside local accounts and OIDC. The operator points the server at the IdP's
  metadata. The desktop's Sign in dialog gains a *Continue with <name>* button for it.
- **SCIM 2.0 provisioning.** The IdP creates, updates and deactivates users, and pushes groups and their
  members. A server admin links groups to teams.

Every sign-in, provisioning change and configuration change goes to the audit log.

**Why.** Enterprise buyers require both (issue #344). Offboarding is the point of SCIM: when someone leaves,
the IdP deactivates them, and their Wirebench sessions end within one request.

**Who.** A server operator who sets up SAML once from the IdP's metadata. An IdP administrator who assigns
the Wirebench app to people and groups. A server admin who links groups to teams. Colleagues who just click
*Continue with Company SSO*.

**User stories.**

- As an operator, I set `WIREBENCH_SERVER_SAML_IDP_METADATA` to my IdP's metadata URL and restart. The
  server prints the ACS URL and entity ID to give the IdP, and serves its own metadata at
  `/api/v1/auth/saml/metadata`.
- As a server admin, I create a SCIM token in the Provisioning tab, paste it and the SCIM base URL into the
  IdP, and assign the app to the *QA* group.
- As an IdP administrator, I assign a new hire to the app. A minute later they exist in Wirebench, and
  they sign in with *Continue with Company SSO*.
- As a server admin, I link the IdP group *QA* to the team *QA*. Its members join the team.
- As an IdP administrator, I remove a leaver from the directory. Their Wirebench account is disabled and
  their desktop is signed out on its next request. Their pushes and audit history stay.

**Non-goals.** IdP-initiated sign-in; more than one SAML IdP; encrypted assertions; signed `AuthnRequest`s;
Single Logout; SCIM `/Bulk`, `/Me`, sorting, `filter` beyond `eq` on the listed attributes, and password
changes; mapping a group to a team role other than `member`; creating teams from groups; JIT account
creation (decision 3); a web UI.

## 2. Concept model

- **SAML identity.** `(idp entity ID, NameID)` → user, the SAML twin of an OIDC identity. Linked the first
  time a user signs in with SAML.
- **SAML flow.** A pending sign-in: the desktop's PKCE challenge and loopback port, the `RelayState`
  secret, and the ID of the `AuthnRequest` this server sent. It lives ten minutes and is used once.
- **SCIM token.** A server-wide bearer credential for the IdP: `wbscim_` plus 32 random bytes in base64url,
  stored as a SHA-256 hash, named, revocable, never expiring (an IdP has no way to refresh it). There may be
  several, so one can be rotated without downtime.
- **SCIM user.** A Wirebench user plus the IdP's `externalId`. The SCIM `id` is the Wirebench user ID.
- **SCIM group.** A stored group: `displayName`, `externalId`, members, and at most one linked team.
- **Provisioned membership.** A team membership SCIM added because of a linked group. Only these are ever
  removed by SCIM (decision 5).

## 3. Behaviour

### 3.1 Configuration

| Variable | Meaning |
| --- | --- |
| `WIREBENCH_SERVER_SAML_IDP_METADATA` | `https://` URL or absolute file path of the IdP's metadata XML. Setting it turns SAML on. |
| `WIREBENCH_SERVER_SAML_DISPLAY_NAME` | The button label, default `SSO`; 1–60 characters. |
| `WIREBENCH_SERVER_SAML_EMAIL_ATTRIBUTE` | Attribute name that carries the email. Unset: the first of the `emailaddress` claim URI, `email`, `mail`, then the NameID when its format is `emailAddress`. |
| `WIREBENCH_SERVER_SAML_NAME_ATTRIBUTE` | Attribute for the display name. Unset: the `name` / `displayname` claim URIs, then `displayName`. |
| `WIREBENCH_SERVER_SAML_CLOCK_SKEW_SECONDS` | Allowed skew on `NotBefore` / `NotOnOrAfter`, default 120, range 0–300. |

The metadata is read at start-up, from a file or over TLS (an `http://` URL is refused unless
`WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL` is set, as for OIDC). The server takes from the
`IDPSSODescriptor`: the `entityID`, the `SingleSignOnService` with the HTTP-Redirect binding, and every
`KeyDescriptor` whose `use` is `signing` or absent. If any of these is missing, or the XML does not parse,
the server does not start (exit 2, like a failed OIDC discovery). Metadata is reloaded on restart only. A
certificate rotation at the IdP means a restart; the docs say so and suggest publishing the new certificate
in metadata before switching (every listed certificate is accepted).

This server as an SP: entity ID `${publicUrl}/api/v1/auth/saml/metadata`, ACS URL
`${publicUrl}/api/v1/auth/saml/acs` (HTTP-POST binding), NameID format `persistent` requested. The
metadata endpoint serves both, unauthenticated, so an IdP can import them. `wirebench-server serve` logs
both at start-up when SAML is on.

`GET /api/v1/meta` gains `auth.saml: boolean` and `auth.samlDisplayName`. Both are set when SAML is
configured, whatever the licence. The licence is checked when a flow starts (§3.2), so the desktop shows
the button and the refusal names the missing feature.

### 3.2 SAML sign-in

1. **`POST /api/v1/auth/saml/start`** — the same body as the OIDC start (`codeChallenge`, `loopbackPort`,
   `device`). It requires the `sso-provisioning` feature (`licensing-feature-required` otherwise) and
   SAML configured (`identity-method-disabled` otherwise). It stores a flow with a new `RelayState`
   secret and a new request ID (`_` + 20 random bytes in hex), builds the `AuthnRequest` with that ID,
   and answers `{ flowId, authorizationUrl, expiresAt }`. The URL is the IdP's SSO URL with
   `SAMLRequest` (deflated, base64) and `RelayState`.
2. The browser signs in at the IdP, which posts `SAMLResponse` and `RelayState` to
   **`POST /api/v1/auth/saml/acs`** (form-encoded, unauthenticated, rate-limited per IP like the OIDC
   callback).
3. The ACS looks up the flow by `RelayState`. An unknown, expired or already-granted flow gets the same
   "expired or already completed" page as OIDC. Otherwise it validates the response (§6.1). On any failure
   it deletes the flow, records `auth.sign_in_failed` (`method: saml`, a `reason` code, never the XML), and
   redirects to the loopback with `error`.
4. On success the claims `{ issuer: entityID, subject: NameID, email, name }` go through the linking rules
   (§3.3). A refusal redirects with its code. Success marks the flow granted and redirects to the
   loopback with a one-time grant, as OIDC does.
5. **`POST /api/v1/auth/saml/complete`** — the same body and checks as the OIDC complete (grant hash,
   PKCE verifier, single use, user not disabled), then `signIn(…, 'saml', …)`. That writes
   `auth.signed_in` with `method: saml`.

### 3.3 Linking

The identity §3.3 rules, with a SAML identity instead of an OIDC one and the email treated as verified
(assumption 3):

1. A known `(entityID, NameID)` signs in its user; a disabled user is refused (`identity-user-disabled`).
2. Otherwise an enabled user with the same email is linked and signed in.
3. Otherwise an open invitation for the email is accepted, which creates the user, takes a seat and
   applies any team invitation (the same transaction as the OIDC `create`).
4. Otherwise `identity-not-invited`.

An assertion without a usable email is refused at step 2 (`identity-saml-no-email`), unless step 1 matched.
A transient NameID (format `transient`) never links: it is refused with `identity-saml-transient-nameid`,
because it would create a new identity on every sign-in.

### 3.4 SCIM tokens

- `POST /api/v1/scim-tokens` `{ name }` → `201 { id, name, token, createdAt }`. The token appears in this
  response only. `GET /api/v1/scim-tokens` lists them without the secret, with `lastUsedAt`.
  `DELETE /api/v1/scim-tokens/:id` revokes. Server admin only, and the feature is required.
- CLI: `wirebench-server admin scim-token create <name>` (prints the token once),
  `… scim-token list`, `… scim-token revoke <id>`.
- Audit: `scim.token_created`, `scim.token_revoked`.

### 3.5 SCIM endpoints

Base URL `${publicUrl}/scim/v2`. Every request needs `Authorization: Bearer wbscim_…` matching a live
token, and the licence feature. Otherwise the answer is `401`, or `403` without the feature, in the SCIM
error shape. Requests and responses use `application/scim+json` (`application/json` is accepted too).

| Endpoint | Behaviour |
| --- | --- |
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Static documents: patch yes, bulk no, filter yes (max 200), sort no, etag no, change-password no, OAuth bearer auth. |
| `GET /Users?filter=…&startIndex&count` | `userName eq`, `externalId eq`, `emails[type eq "work"].value eq`, or no filter. Case-insensitive on `userName`. Default `count` 100, max 200. |
| `GET /Users/:id` | The user as a SCIM resource: `userName` = email, `name.formatted`, `displayName`, `emails` (one, primary), `active` = not disabled, `externalId`, `meta`. |
| `POST /Users` | Creates a user from `userName` (must be an email). An existing email → `409 uniqueness`. Takes a seat (`403` with a seat-limit detail when full). An open invitation for the email is accepted by the creation, so its team invitation applies. `active: false` creates the user disabled, which takes no seat. |
| `PUT /Users/:id` | Replaces `userName`/email, `displayName`, `externalId`, `active`. |
| `PATCH /Users/:id` | `add` / `replace` / `remove` on the same attributes, with or without `path`. Accepts the string booleans `"True"`/`"False"` that some IdPs send for `active`. |
| `DELETE /Users/:id` | Same as `active: false` (decision 6). Answers `204`, and a later `GET` still finds the user, inactive. |
| `GET /Groups?filter=displayName eq …` / `externalId eq` | Stored groups. `excludedAttributes=members` honoured. |
| `GET /Groups/:id`, `POST`, `PUT`, `PATCH`, `DELETE` | Store the group and its members. Members are SCIM user IDs. An unknown member ID → `400 invalidValue`. `PATCH` supports `members` add/remove, including the `members[value eq "…"]` path form, and `displayName` replace. `DELETE` removes the group and, if it was linked, its provisioned memberships. |

Deactivating a user (`active` true → false) does what the admin disable does: set `disabled_at`, revoke
every device token, announce `sessionEnded` so live sockets close, and record `user.disabled`.
Reactivating checks a seat and records `user.enabled`. Every write records its audit event with the actor
`{ kind: 'scim', tokenId }`: `user.created` (`method: scim`), `user.updated` (changed field names only),
`user.disabled`, `user.enabled`, `scim.group_created`, `scim.group_updated`, `scim.group_deleted`, and
`team.member_added` / `team.member_removed` for provisioned memberships (`details.via: scim`).

The server admin who is the last enabled server admin cannot be deactivated through SCIM:
`409 mutability` with a detail. An IdP must never lock every admin out.

### 3.6 Group → team links

- `GET /api/v1/scim-groups` → groups with member counts and the linked team.
  `PUT /api/v1/scim-groups/:id/team` `{ teamId }` links (one team per group; a team may have several
  groups). `DELETE /api/v1/scim-groups/:id/team` unlinks. Server admin only, feature required.
- CLI: `wirebench-server admin scim-group list`, `… scim-group link <group> <team>`,
  `… scim-group unlink <group>`.
- Linking applies at once: every enabled member of the group who is not on the team joins as `member`, and
  each join is recorded as provisioned (`provisioned_memberships`, keyed by team, user and group). A person
  already on the team is left alone and not recorded.
- When a linked group gains a member, they join the same way. When it loses one, or the group is unlinked
  or deleted, that person's provisioned row for this group is removed. Their team membership is removed
  only when no provisioned row is left for the team **and** their role is still `member`. Someone an admin
  promoted is theirs now; the last-admin rule could never be hit by SCIM, because SCIM removes only
  members.
- Removing a person from a team, by hand or by SCIM, deletes their workspace grants in that team, as
  teams-access §3 already does. An admin removing a provisioned member by hand also drops the provisioned
  rows. If the group still lists them, the next change to that group adds them back, and the docs say to
  remove them at the IdP instead.
- Audit: `scim.group_linked`, `scim.group_unlinked`.

### 3.7 Desktop

- **Sign in dialog:** a *Continue with <samlDisplayName>* button when `meta.auth.saml`. It runs the same
  loopback flow as OIDC through `account.startSaml`. The main process differs from OIDC only in the start
  and complete paths.
- **Team dialog → Provisioning tab** (server admins, shown when the licence has the feature; otherwise a
  short "Enterprise feature" note like the Audit tab's):
  - *SCIM:* the base URL with a copy button; the tokens, with name, created and last-used times; Create
    (the token is shown once, in a copy field); Revoke, with confirmation.
  - *SAML:* read-only: configured or not, IdP entity ID, and this server's ACS URL and entity ID, each
    copyable. They come from `GET /api/v1/auth/saml/info` (server admin, feature required).
  - *Groups:* each group with its member count and a team picker. *Not linked* unlinks. The list refreshes
    when the tab opens and on a Refresh button.

## 4. Data

Migration `identity/0014_saml-scim.sql` (the number is global; if another module lands 0014 first, this
file is renumbered):

```sql
create table saml_identities (
  entity_id text not null,
  name_id   text not null,
  user_id   text not null references users on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (entity_id, name_id)
);
create index saml_identities_user_id on saml_identities (user_id);

create table saml_flows (
  id             text primary key,
  request_id     text not null unique,
  code_challenge text not null,
  loopback_port  integer not null,
  device_name    text not null,
  relay_state    text not null unique,
  grant_hash     text unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  user_id        text
);

create table scim_tokens (
  id           text primary key,
  name         text not null check (char_length(name) between 1 and 64),
  token_hash   text not null unique,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create unique index scim_tokens_name_lower on scim_tokens (lower(name)) where revoked_at is null;

create table scim_users (
  user_id     text primary key references users on delete cascade,
  external_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table scim_groups (
  id           text primary key,
  display_name text not null,
  external_id  text,
  team_id      text references teams on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index scim_groups_display_name_lower on scim_groups (lower(display_name));

create table scim_group_members (
  group_id text not null references scim_groups on delete cascade,
  user_id  text not null references users on delete cascade,
  primary key (group_id, user_id)
);
create index scim_group_members_user_id on scim_group_members (user_id);

create table provisioned_memberships (
  team_id  text not null,
  user_id  text not null,
  group_id text not null references scim_groups on delete cascade,
  primary key (team_id, user_id, group_id),
  foreign key (team_id, user_id) references team_members on delete cascade
);
```

The migration lives in `identity/` although it references `teams`: teams-access's 0003 runs earlier in the
global order, and the SCIM code that writes `provisioned_memberships` calls teams-access's repository
functions rather than writing `team_members` itself. The daily identity sweep also deletes expired
`saml_flows`.

Engine wire types: `FEATURES` gains `sso-provisioning`. Audit gains the actor kind `scim`, the target kinds
`scim-token` and `scim-group`, the action group `scim`, and the actions `user.updated`,
`scim.token_created`, `scim.token_revoked`, `scim.group_created`, `scim.group_updated`,
`scim.group_deleted`, `scim.group_linked`, `scim.group_unlinked`. The meta schema gains `auth.saml` and
`auth.samlDisplayName`. New request/response schemas cover the SAML start/complete (reusing the OIDC
shapes), SCIM tokens and SCIM group links. The SCIM resources themselves are server-only zod schemas: the
desktop never speaks SCIM.

## 5. Interfaces between modules

- `identity` owns SAML, SCIM tokens and SCIM users. SCIM groups and provisioned memberships call
  `teams-access`'s repository (`insertMember`, `deleteMember`, `deleteGrantsInTeam`, `memberRole`) and
  announce `accessChanged`, so live sockets re-check access as they do for a hand-made change.
- SCIM routes register through `registerPublic` (the server root) with their own `onRequest` hook. The
  `/api/v1` guard is untouched: a `wbscim_` token does not match the device-token pattern, so the guard
  treats it as no header, and every `/api/v1` route answers `401`.
- No change to `modules.ts` or the bootstrap: everything is inside `identityModule()`. The parallel
  scheduled-runs work (#343) is unaffected apart from the migration number.

## 6. Security

### 6.1 Validating a SAML response

`@node-saml/node-saml` performs the protocol checks. It is the maintained successor of `passport-saml`, used
by most Node SAML deployments, and built on `xml-crypto` (≥ 6.0.1, which has the 2025 signature-bypass
fixes) and `@xmldom/xmldom`. Hand-rolling XML canonicalisation and signature checks is how SAML
implementations get broken, so nothing in Wirebench parses a `SAMLResponse` itself. `samlify` was
considered: it is maintained too, but its default validator is pluggable and easy to leave unset, it pulls
in a schema validator we would need to choose, and it has a smaller install base. As with `openid-client`,
one file (`identity/saml.ts`) imports the library, behind a `SamlProvider` interface.

Configuration of each request's validator, and what it guarantees:

| Threat | Defence |
| --- | --- |
| Forged or altered assertion | `wantAssertionsSigned: true`, `idpCert` = the metadata's signing certificates only. A response whose assertion is unsigned, signed by another key, or altered after signing is refused. A signed `Response` around an unsigned assertion is not enough. |
| XML signature wrapping (a second, unsigned assertion beside the signed one) | node-saml validates the signature's `Reference` and reads the profile from the signed node only. Wirebench reads nothing from the raw XML: every value comes from the validated profile and `getAssertionXml()` of the validated assertion. Tests feed the classic wrapping variants (assertion moved into `Extensions`, sibling assertion, nested `Object`) and expect refusal. |
| Wrong audience | `audience` = our entity ID; an `AudienceRestriction` naming anyone else is refused. |
| Wrong recipient or destination | After validation, `SubjectConfirmationData/@Recipient` in the validated assertion, and the response's `Destination` when present, must equal the ACS URL exactly. |
| Replay of a captured response | `validateInResponseTo: 'always'`. The cache provider answers only for the request ID of the flow named by `RelayState`, so the response must answer this flow's own request. The flow is granted with a conditional update (`grant_hash is null`), so a second post of the same response finds it used. A response without `InResponseTo` (IdP-initiated) is refused (decision 2). |
| Login CSRF / response injection into another user's flow | The `RelayState` secret is minted per flow and only the desktop that started it knows the PKCE verifier. A response posted to someone else's flow fails the `InResponseTo` check, and its grant would be useless without the verifier. |
| Expired or not-yet-valid assertion | `NotBefore` / `NotOnOrAfter` on `Conditions` and `SubjectConfirmationData`, with `acceptedClockSkewMs` from configuration (default 120 s, max 300 s). The flow's own ten-minute life bounds it too. |
| Weak algorithms | Outgoing requests use SHA-256. A response signed with SHA-1 is refused: after validation, the `SignatureMethod` and `DigestMethod` of the validated signature are checked against an allow-list (RSA-SHA256/384/512, ECDSA-SHA256/384/512). |
| XML parser abuse (XXE, entity expansion) | `@xmldom/xmldom` does not resolve external entities or DTDs. The ACS refuses bodies over 256 KiB before parsing. |
| Metadata tampering | Metadata comes from operator configuration: a local file, or TLS to the IdP. It is not re-fetched while running, so a request can't swap certificates. |
| Account takeover through the email | An assertion's email can link to an existing user (§3.3 step 2), as a verified OIDC email can. Whoever controls the IdP controls those emails. That is the trust an operator gives by configuring the IdP, and the docs say so. Server admins can see the SAML identities on the user list. |

Every refusal maps to a reason code in `auth.sign_in_failed` (`saml-signature`, `saml-audience`,
`saml-recipient`, `saml-expired`, `saml-in-response-to`, `saml-algorithm`, `saml-malformed`,
`saml-status`). The log line has the flow ID and the library's message, never the XML or the attributes.

### 6.2 SCIM tokens

- 32 random bytes, prefixed `wbscim_` so a leaked one is recognisable. Only the SHA-256 hash is stored. It
  is looked up by hash and compared in constant time, like device tokens.
- Shown once, at creation, in the API response, the CLI output or the desktop's copy field. Never logged:
  the request logger already redacts `authorization`, and a test asserts it for `/scim/v2`. `SAMLResponse` and `RelayState` join the logger's secret keys.
- Revocation takes effect on the next request. `last_used_at` is touched at most once a minute.
- Failed SCIM authentication is rate-limited per IP with the identity limiter, and recorded as
  `auth.sign_in_failed` with `method: scim`, at most once a minute per IP.
- A SCIM token reaches only `/scim/v2`. It cannot read workspaces, the audit log or anything under
  `/api/v1`, and a device token cannot call SCIM. This is tested in both directions.
- What a SCIM token can do is still powerful: create and disable users, and change linked teams' members.
  It can't grant server admin, change roles, touch workspaces, or disable the last admin.

### 6.3 Deprovisioning

Disable, not delete (decision 6). A disabled user's tokens are revoked in the same transaction, and
`sessionEnded` closes their live sockets, so the next request from their desktop gets `401` /
`identity-user-disabled`. The seat is freed. Their SAML and OIDC identities stay, so reactivation signs
them back into the same account. Their provisioned memberships stay too, so reactivation restores access.
Data a disabled user created (workspaces, pushes, secrets they shared, audit rows) is untouched.

## 7. Testing

- **Unit:** metadata parsing (good, missing SSO binding, no signing cert, garbage); the claims mapping
  (attribute fallbacks, transient NameID); the SCIM filter parser (`eq` forms, refusing others with
  `400 invalidFilter`); the PATCH op applier (Entra and Okta shapes, string booleans, path filters);
  `decideProvisionedRemoval`.
- **Integration (Postgres, `server-integration`):** a signed response from the fixture IdP key signs in.
  Then the negative set: altered attribute after signing, unsigned assertion in a signed response, signed
  by another key, three wrapping variants, wrong audience, wrong recipient, wrong destination, expired,
  not yet valid, beyond skew, missing `InResponseTo`, `InResponseTo` of another flow, the same response
  posted twice, SHA-1 signature, oversize body, unlicensed server. SCIM: the full user lifecycle as Entra
  sends it and as Okta sends it, from captured request sequences; deactivation revoking tokens and the
  next device-token request failing; seat limit; last-admin refusal; group link/unlink and the provisioned
  removal rules; token isolation both ways; audit events for each.
- **Desktop:** unit tests for the Provisioning tab and the SAML button. The e2e (CI) signs in with SAML
  against the in-test fixture IdP, as the OIDC e2e does with its in-test issuer.
- **Manual:** `docs-site/src/content/docs/guides/server-saml-scim.mdx` has the Entra ID and Okta setup steps and a checklist (sign-in,
  user create, deactivate, group push), run against real tenants before release.

## 8. Rollout

Feature-gated and off until configured. No change for servers without the metadata variable or without the
licence feature. Docs: a new `docs-site/src/content/docs/guides/server-saml-scim.mdx`, plus a configuration table entry and the CHANGELOG.

## 9. Open questions

None blocking. Later issues: more than one SAML IdP; reloading metadata on a timer; encrypted assertions;
JIT creation as an opt-in setting.
