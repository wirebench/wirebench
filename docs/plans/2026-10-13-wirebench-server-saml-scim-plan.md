# Wirebench Server SAML sign-in and SCIM provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enterprise servers sign people in with SAML 2.0 beside local accounts and OIDC. An IdP provisions
and deprovisions users and pushes groups over SCIM 2.0, and a server admin links those groups to teams.

**Architecture:** Everything lives in a new `sso` module (`packages/server/src/sso/`, ruling 11), behind the
new `sso-provisioning` licence feature. SAML reuses the OIDC loopback flow with its own `saml_flows` table.
One file, `identity/saml.ts`, wraps `@node-saml/node-saml` behind a `SamlProvider` interface. SCIM is a
root-level plugin at `/scim/v2` (`registerPublic`), with its own bearer-token hook and its own error shape.
Group links write team memberships through `teams/repo.ts`, recording each one in
`provisioned_memberships`. The desktop gains a SAML button and a Provisioning tab in the team dialog.

**Tech Stack:** TypeScript on Node 24, Fastify 5, Postgres (`pg`), zod 4 (plain, ADR-0009),
`@node-saml/node-saml` 5 (with `xml-crypto` and `@xmldom/xmldom`), React + zustand, Vitest, Playwright.

**Spec:** `docs/specs/2026-10-13-wirebench-server-saml-scim-design.md`.

## Global Constraints

- Nothing outside `identity/saml.ts` imports `@node-saml/node-saml`. No Wirebench code parses a
  `SAMLResponse` or reads the raw XML. Every value comes from the validated profile or the validated
  assertion XML.
- `wantAssertionsSigned: true`, `wantAuthnResponseSigned: false` (node-saml 5 defaults it to `true`, but
  Entra ID signs only the assertion by default; the assertion signature is the one that matters),
  `validateInResponseTo: 'always'`, `audience` set, and clock skew from configuration (default 120 s,
  max 300 s). node-saml 5.1 checks neither `SubjectConfirmationData/@Recipient` nor the response's
  `Destination`, and applies `idpIssuer` to logout messages only, so `saml.ts` checks all three itself. SHA-1 signatures are refused. The ACS body is capped at 256 KiB.
- SP-initiated only. A response without `InResponseTo`, or with another flow's, is refused.
- SAML never creates an account except by accepting an open invitation. SCIM creates accounts.
- SCIM tokens: `wbscim_` + base64url(32 bytes), SHA-256 stored, constant-time compare, shown once. They work
  only under `/scim/v2`, and device tokens never work there.
- Deprovisioning disables. It never deletes. It revokes every device token and announces `sessionEnded`, in
  the same code path as `PATCH /users/:id`.
- SCIM never removes a team member it did not add, never removes anyone whose role is not `member`, never
  changes a role, and never disables the last enabled server admin.
- Every sign-in, refusal and provisioning write records an audit event. `details` never carries XML,
  attributes or token secrets.
- The migration is `sso/0014_saml-scim.sql`. If #343 merges a 0014 first, rename this file to the next free
  number (migrations are contiguous across modules).
- Stay inside `sso/`, `identity/` (only to share linking and sessions), `teams/repo.ts`, the engine's
  `server-api/`, and the desktop's account and team features. `modules.ts` and `context.ts` gain one entry
  each (ruling 11); `serve.ts` is untouched, and `server.ts` only gains redaction keys.
- The renderer imports only **types** from `shared/wire-types.ts` (the CSP trap).
- A new dependency needs `pnpm licenses:third-party`.
- Never name the products that inspired a feature (`pnpm check:banned-terms`). IdP vendor names (Entra ID,
  Okta) are fine: they are what we integrate with.
- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit. One commit per task. No
  `Co-Authored-By` or `Claude-Session` trailer. Commits are made as Mohammed Naami <m.naami@outlook.com>.
- No local Electron e2e windows. e2e runs in CI only.

## Rulings made while planning

1. **`GET /api/v1/auth/saml/info`** (server admin, feature required) answers
   `{ configured, idpEntityId?, entityId, acsUrl, scimBaseUrl }` for the Provisioning tab. The spec's §3.7
   SAML section needs it. `meta` stays public and minimal.
2. **The request ID is ours.** node-saml takes `generateUniqueId`. A `SAML` instance is built per start
   with `() => flow.requestId`, and per ACS with a cache provider that answers only for that flow's
   `requestId`. That ties the response to the flow named by `RelayState`, with no shared in-memory cache.
3. **`linkClaims` gains a `kind: 'oidc' | 'saml'`** and picks the identity table from it. `decideLink` is
   unchanged: SAML passes `emailVerified: true` when an email is present (spec assumption 3).
4. **The disable/enable transition is extracted** from `routes/users.ts` into
   `identity/user-state.ts#setUserDisabled(env, tx, userId, disabled, actor)`, which both the admin PATCH
   and SCIM call. The admin route's behaviour is unchanged, and its existing tests are the guard.
5. **The SCIM error shape is built by a local `scimError(status, scimType?, detail)`.** The host's problem
   format doesn't fit RFC 7644. The SCIM plugin's `setErrorHandler` maps every error in that scope, so a
   stray Wirebench problem never leaks the `/api/v1` shape.
6. **The form body parser is scoped to the ACS route's plugin** (`addContentTypeParser` inside an
   encapsulated register), using `URLSearchParams`. No `@fastify/formbody` dependency.
7. **The SCIM media type parser** (`application/scim+json` → JSON) is registered only inside the SCIM
   plugin.
8. **Provisioned removal is a pure function**, `decideProvisionedRemoval({ remainingRowsForTeam, role })`,
   table-tested. It answers `remove` only for `0` rows and role `member`.
9. **Test IdP material** lives in `packages/server/test/fixtures/saml/`: `idp-key.pem`, `idp-cert.pem`,
   `other-key.pem`, `other-cert.pem` (self-signed RSA 2048, generated once with openssl, valid until 2126,
   test-only and labelled so in a README). `test/support/saml-idp.ts` builds and signs responses with
   `xml-crypto` and has helpers for each tampering case.
10. **Each audit action lands with the task that fires it.** `audit-log/coverage.test.ts` requires every
    entry of `AUDIT_ACTIONS` to be asserted in `test/integration/audit-log/`. So Task 1 adds only the
    actor kind, the target kinds and the action group. Tasks 8, 10, 11 and 12 add their actions, each with
    `test/integration/audit-log/saml-scim.test.ts` cases. `0008_audit-log.sql` limits `actor_kind`, so
    Task 3's migration widens that check to include `scim`.
11. **The work is a module of its own, `sso`, registered last.** Migration versions must be contiguous for
    the modules a server runs, so an identity-only server cannot load a 0014 that names `teams` and
    `audit_events`. Every file this plan places under `src/identity/` for SAML or SCIM lives under
    `src/sso/` instead (`sso/saml.ts`, `sso/saml-metadata.ts`, `sso/repo.ts`, `sso/scim/…`,
    `sso/routes/…`), and the migration is `migrations/sso/0014_saml-scim.sql`. `identity` keeps its
    sessions, linking and guard, and `sso` calls them. `modules.ts` gains `ssoModule()` after
    `auditLogModule()`, and `ServerModule['name']` gains `'sso'`.

## File map

**Engine**
- Modify `packages/engine/src/server-api/licensing.ts`: `FEATURES` += `sso-provisioning`.
- Modify `packages/engine/src/server-api/audit.ts`: actor `scim`, targets `scim-token` and `scim-group`,
  group `scim`, the new actions.
- Modify `packages/engine/src/server-api/meta.ts`: `auth.saml` and `auth.samlDisplayName`.
- Create `packages/engine/src/server-api/saml-scim.ts`: SAML start/complete (aliases of the OIDC shapes),
  SAML info, SCIM token create/list, SCIM group list and link.
- Modify `packages/engine/src/index.ts`: exports.

**Server**
- Create `packages/server/migrations/identity/0014_saml-scim.sql`.
- Modify `packages/server/src/config.ts`: the five `SAML_*` variables.
- Create `identity/saml-metadata.ts`, `identity/saml.ts`, `identity/routes/auth-saml.ts`,
  `identity/user-state.ts`, `identity/scim-tokens.ts`, `identity/routes/scim-tokens.ts`,
  `identity/scim/` (`plugin.ts`, `errors.ts`, `filter.ts`, `patch.ts`, `users.ts`, `groups.ts`,
  `resources.ts`, `discovery.ts`), `identity/provisioning.ts`, `identity/routes/scim-groups.ts`.
- Modify `identity/module.ts`, `identity/env.ts`, `identity/linking.ts`, `identity/sessions.ts`,
  `identity/repo.ts`, `identity/routes/users.ts`, `identity/cli.ts`, `args.ts`, `server.ts` (redaction keys).
- Modify `teams/repo.ts` only if a needed query is missing (`membersOfTeam` role read exists).

**Desktop**
- Modify `apps/desktop/src/main/server-client.ts`, `src/main/ipc/account.ts` (SAML start/complete),
  create `src/main/ipc/provisioning.ts`, modify `src/shared/wire-base.ts` / `wire-types.ts` / the preload
  API.
- Modify `src/renderer/features/account/sign-in-dialog.tsx`.
- Create `src/renderer/features/team/provisioning-tab.tsx`, `src/renderer/state/provisioning.ts`; modify
  `team-dialog.tsx` and the team store's `TeamTab`.
- e2e: `apps/desktop/e2e/saml-sign-in.spec.ts`.

**Docs**
- Create `docs-site/src/content/docs/guides/server-saml-scim.mdx`; modify `guides/wirebench-server.mdx`
  (configuration table), `CHANGELOG.md`, `docs/roadmap.md`.

---

### Task 1: Engine wire shapes

- [ ] Tests first (`packages/engine/test/unit/server-api/`): `FEATURES` contains `sso-provisioning`, and
  `grantedFeatures` for an Enterprise licence includes it. The audit enums accept the new actor and
  targets, and `AUDIT_ACTION_GROUPS` has `scim` (actions: ruling 10). `metaResponseSchema` parses with and without `saml`
  (an older server). The new schemas round-trip, refuse unknown keys where the existing ones do, and the
  SCIM token name is limited to 1–64 characters.
- [ ] Implement. Re-export from `index.ts`.
- [ ] Update `licensing/state.test` expectations that list every feature.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`, then commit `feat(engine): wire shapes for SAML sign-in and SCIM`.

### Task 2: Dependency, test IdP fixtures and the signing helper

- [ ] `pnpm --filter @wirebench/server add @node-saml/node-saml` and
  `pnpm --filter @wirebench/server add -D xml-crypto @xmldom/xmldom`. Run `pnpm licenses:third-party` and
  commit its output.
- [ ] Generate the fixture keys and certificates (ruling 9) and add the fixture README.
- [ ] `test/support/saml-idp.ts`: `buildResponse({ inResponseTo, audience, recipient, destination,
  notBefore, notOnOrAfter, nameId, nameIdFormat, attributes, issuer })`, `signAssertion(xml, key, alg)`,
  `signResponse`, and the tampering helpers `alterAttribute`, `wrapSibling`, `wrapInExtensions`,
  `wrapInObject` and `stripAssertionSignature`.
- [ ] A unit test of the helper itself: a signed assertion verifies with `xml-crypto` against the fixture
  certificate and fails against `other-cert.pem`.
- [ ] Check, then commit `test(server): SAML test IdP and response signer`.

### Task 3: Migration and repository

- [ ] `0014_saml-scim.sql` exactly as spec §4.
- [ ] Integration tests (`test/integration/identity/saml-scim-repo.test.ts`): insert and look up a SAML
  identity; insert a flow, look it up by relay state, grant it once (`grant_hash is null`, a second grant is
  refused), claim it once; delete expired flows. SCIM tokens: insert, look up by hash, revoke, the name
  unique among live tokens only, touch. SCIM users: upsert `external_id`. Groups: insert, rename, the name
  unique case-insensitively, members set/add/remove, cascades on user and group delete. Provisioned rows
  cascade when the team membership goes.
- [ ] Repository functions in `identity/repo.ts`, named like their OIDC and CI-token neighbours.
- [ ] `sweepExpired` also deletes expired SAML flows (extend its test).
- [ ] Check, then commit `feat(server): SAML and SCIM tables`.

### Task 4: Configuration and metadata parsing

- [ ] Config tests: each `SAML_*` variable parses and its bounds are enforced. An `http://` metadata URL is
  refused without the insecure flag. The display name defaults to `SSO`. A server with only SAML and local
  auth off is valid, so the "no sign-in method" check counts SAML.
- [ ] `identity/saml-metadata.ts`: `loadIdpMetadata(source, { allowInsecure, fetch })` returns
  `{ entityId, ssoUrl, certificates[] }` for the HTTP-Redirect `SingleSignOnService` and the signing
  `KeyDescriptor`s (no `use`, or `use="signing"`). Unit tests: an Entra-shaped and an Okta-shaped fixture
  (anonymised); no redirect binding; no signing key; an encryption-only key ignored; garbage XML; a DOCTYPE
  is refused.
- [ ] `identitySettings` gains `saml: { displayName, emailAttribute?, nameAttribute?, clockSkewMs } | undefined`,
  plus `samlEntityId` and `samlAcsUrl` derived from `publicUrl`.
- [ ] Check, then commit `feat(server): SAML configuration and IdP metadata`.

### Task 5: `SamlProvider` — requests and validation

- [ ] Tests first (`test/unit/identity/saml.test.ts`, real signatures from Task 2):
  - `authorizationUrl({ requestId, relayState })` → the IdP SSO URL with a `SAMLRequest` that inflates to
    an `AuthnRequest` with `ID=requestId`, our `Issuer`, the ACS URL and the persistent NameID policy, plus
    `RelayState`.
  - `validate({ samlResponse, requestId })`. Accepted: a valid signed assertion. Refused, each with its
    reason code: altered attribute; unsigned assertion inside a signed response; signed by the other key;
    sibling wrap; `Extensions` wrap; `Object` wrap; wrong audience; wrong `Recipient`; wrong `Destination`;
    expired; not yet valid; beyond skew; within skew; missing `InResponseTo`; another `InResponseTo`; a
    SHA-1 signature; a `Status` other than Success; a transient NameID (`saml-transient-nameid` at the
    claims step); no email (claims without email).
  - Claims mapping: the configured attribute, each fallback in order, NameID-as-email only for the
    `emailAddress` format.
- [ ] Implement `discoverSaml(settings, metadata)` returning `SamlProvider { entityId, authorizationUrl,
  validate }`. Build a `SAML` instance per call (ruling 2). The post-checks read the validated assertion XML
  (`profile.getAssertionXml()`): `Recipient`, `Destination` and the algorithm allow-list. Errors map to the
  spec §6.1 reason codes.
- [ ] Check, then commit `feat(server): validate SAML responses through node-saml`.

### Task 6: SAML routes and linking

- [ ] Integration tests (`test/integration/identity/auth-saml.test.ts`, a licensed test server with the
  fixture metadata):
  - The happy path end to end: start → `authorizationUrl` → build a signed response for its request ID →
    POST the ACS → `302` to the loopback with a grant → complete with the verifier → device token →
    `GET /me` works. `auth.signed_in` has `method: saml`. A SAML identity is linked.
  - Linking: a known identity; email links an existing user; an open invitation creates a user and applies
    its team invitation; an unknown person is refused `identity-not-invited`; a disabled user is refused;
    the seat limit is reached.
  - Replay: the same `SAMLResponse` posted twice → the second gets the expired page. A response for flow A
    posted with flow B's `RelayState` → refused, and flow B is deleted. Complete twice → `flowInvalid`.
    Complete with the wrong verifier → `flowInvalid`.
  - An unlicensed server → start `403 licensing-feature-required`. SAML not configured → `404`
    `identity-method-disabled`. Oversize body → `413`. Every refusal records `auth.sign_in_failed` with
    its reason and no XML (assert on the stored row).
  - `GET /auth/saml/metadata` serves the SP entity ID and ACS. `GET /meta` has `saml` and its display
    name. `GET /auth/saml/info` is admin-only.
  - The log stream never contains the `SAMLResponse` value.
- [ ] Implement `routes/auth-saml.ts` (ruling 6 for the form parser), `linkClaims(kind)` (ruling 3),
  `signIn(…, 'saml')`, the module wiring (`provider` option for tests, metadata load at register, exit 2
  on failure through `StartupError` as for OIDC), and the redaction keys.
- [ ] Check, then commit `feat(server): SAML sign-in`.

### Task 7: Shared disable transition

- [ ] Move the disable/enable branch of `PATCH /users/:id` into `identity/user-state.ts#setUserDisabled`
  (ruling 4). It returns whether a transition happened, and the caller announces after commit.
- [ ] The existing `users` route tests stay green unchanged. Add unit coverage of `setUserDisabled` for a
  no-op transition (no audit row).
- [ ] Check, then commit `refactor(server): one disable path for admins and provisioning`.

### Task 8: SCIM tokens

- [ ] Integration tests: create (`201`, the token matches `^wbscim_`, the hash is stored and never the
  token), list without secrets, revoke, a revoked token fails at once, a duplicate live name is `409`, the
  routes are admin-only and feature-gated, and the audit rows.
- [ ] CLI tests: `admin scim-token create|list|revoke`. Create prints the token once. The CLI refuses
  without the licence feature.
- [ ] Implement `scim-tokens.ts` (mint, hash, verify), `routes/scim-tokens.ts`, and the CLI wiring in
  `args.ts` / `identity/cli.ts`.
- [ ] Check, then commit `feat(server): SCIM tokens`.

### Task 9: The SCIM plugin, authentication and discovery

- [ ] Integration tests: `/scim/v2/ServiceProviderConfig` with a valid token → `200` in
  `application/scim+json`. No token, a bad token, a revoked token or a device token → `401` in the SCIM
  error shape. A SCIM token on `/api/v1/me` and `/api/v1/workspaces` → `401`. An unlicensed server → `403`
  in the SCIM shape. Failed attempts are rate-limited and audited at most once a minute per IP. The
  `authorization` header never appears in the log stream. `last_used_at` is touched at most once a minute.
- [ ] Implement `scim/plugin.ts` (registered from `registerPublic` under prefix `/scim/v2`, rulings 5
  and 7), `scim/errors.ts`, and `scim/discovery.ts` (ServiceProviderConfig, ResourceTypes, Schemas).
- [ ] Check, then commit `feat(server): SCIM endpoint, authentication and discovery`.

### Task 10: SCIM users

- [ ] Unit tests: the filter parser (`userName eq "a@b"`, `externalId eq "x"`,
  `emails[type eq "work"].value eq "a@b"`, quoting and escapes; `co`, `and`, `or` and `pr` →
  `invalidFilter`). The PATCH applier: Entra's `replace` without a path and with `"active": "False"`;
  Okta's `replace` with `{ active: false }`; `add` of `externalId`; `remove` of `displayName` falls back to
  the email's local part; an unknown path → `invalidPath`.
- [ ] Integration tests, replaying captured sequences:
  - Entra: `GET ?filter=userName eq` (empty) → `POST` → `PATCH` (displayName) → `PATCH active False` → the
    user's device token now `401`s and their live socket closes → `PATCH active True` (seat checked) →
    `DELETE` → `GET` still finds them inactive.
  - Okta: `GET ?filter` → `POST` → `PUT` → `PUT active false`.
  - `POST` on an existing email → `409 uniqueness`. `POST` at the seat limit → `403`. `POST` with an open
    invitation → the invitation is accepted and the team joined. `POST active:false` takes no seat. The last
    enabled server admin can't be deactivated → `409 mutability`. Pagination with `startIndex`/`count`.
  - Audit rows for each write carry the actor `scim` and the token ID, and `user.updated` lists only field
    names.
- [ ] Implement `scim/filter.ts`, `scim/patch.ts`, `scim/resources.ts` (Wirebench user ⇄ SCIM user), and
  `scim/users.ts`, with deactivation through `setUserDisabled`.
- [ ] Check, then commit `feat(server): SCIM users`.

### Task 11: SCIM groups

- [ ] Integration tests: create with members; unknown member → `400 invalidValue`; `GET` with
  `filter=displayName eq` and `excludedAttributes=members`; `PATCH` members add, members remove by
  `members[value eq "id"]`, members remove with a value list (Okta), `displayName` replace; `PUT` replaces
  the members; `DELETE`; a duplicate `displayName` → `409 uniqueness`; and the audit rows. No team changes
  yet: groups are unlinked.
- [ ] Implement `scim/groups.ts`. Every member change goes through one `setGroupMembers(tx, groupId,
  added[], removed[])` that Task 12 hooks into.
- [ ] Check, then commit `feat(server): SCIM groups`.

### Task 12: Group → team links and provisioned memberships

- [ ] Unit: `decideProvisionedRemoval` table (ruling 8).
- [ ] Integration tests:
  - Link → enabled group members not on the team join as `member` with provisioned rows; someone already
    on the team stays and gets no row; disabled members are skipped.
  - Linked group gains a member → they join. Loses one → removed, and their workspace grants in the team go.
  - Two groups linked to one team: losing one group keeps the membership.
  - Promoted to team admin by hand → never removed by SCIM.
  - Hand-removing a provisioned member drops their rows.
  - Unlink → SCIM-added members removed, hand-added stay. Group `DELETE` → same. Team deleted → the link
    clears (`on delete set null`).
  - `accessChanged` announced for every membership SCIM changes. `team.member_added`/`removed` audit rows
    have `via: scim`. `scim.group_linked`/`unlinked` rows.
  - API: `GET /scim-groups`, `PUT`/`DELETE /scim-groups/:id/team`, admin-only and feature-gated, unknown
    team → `404`. CLI `admin scim-group list|link|unlink`.
- [ ] Implement `identity/provisioning.ts` (link, unlink, apply member deltas), `routes/scim-groups.ts`, the
  CLI, and the hook from `setGroupMembers`.
- [ ] Check, then commit `feat(server): link SCIM groups to teams`.

### Task 13: Desktop main — SAML sign-in and provisioning channels

- [ ] Tests (main unit, with a fake server): `account.startSaml` runs the loopback flow against the
  `saml/start` and `saml/complete` paths and stores the token like OIDC. `provisioning.*` channels call
  the server client: `info`, `tokens.list|create|revoke`, `groups.list|link|unlink`. A
  `licensing-feature-required` problem surfaces as its code.
- [ ] Implement in `server-client.ts`, `ipc/account.ts` (share the OIDC loopback code by path; no copy),
  `ipc/provisioning.ts`, the preload API and the wire-type re-exports.
- [ ] Check, then commit `feat(desktop): SAML sign-in and provisioning channels`.

### Task 14: Desktop renderer — SAML button

- [ ] Component tests: the button shows with `meta.auth.saml` and uses `samlDisplayName`; it is absent
  otherwise; it runs `startSaml` with the cancel state shared with OIDC; refusals show their messages
  (`identity-not-invited`, `licensing-feature-required`, `identity-saml-no-email`, and the SAML reason
  codes collapsed to one "The identity provider's response was not accepted." line).
- [ ] Implement in `sign-in-dialog.tsx`.
- [ ] Check, then commit `feat(desktop): Continue with SSO`.

### Task 15: Desktop renderer — Provisioning tab

- [ ] Component tests: the tab appears for server admins only. Unlicensed → the Enterprise note. The SCIM
  section shows the base URL with copy. Create shows the token once and clears it on close. Revoke
  confirms. The SAML section shows configured/not and the copyable URLs. The groups list shows member
  counts and a team picker; changing it links, *Not linked* unlinks, and errors show inline. Refresh
  reloads.
- [ ] Implement `state/provisioning.ts`, `provisioning-tab.tsx`, and the `TeamTab` + `team-dialog.tsx`
  wiring, following `license-tab.tsx` for layout and loading states.
- [ ] Check, then commit `feat(desktop): Provisioning tab`.

### Task 16: e2e (CI only)

- [ ] `saml-sign-in.spec.ts`: a licensed server with the fixture IdP metadata. The test plays the IdP: it
  reads the `authorizationUrl` from the browser hand-off hook the OIDC e2e uses, signs a response for its
  request ID, posts it to the ACS, and asserts the app shows the signed-in account. Then it opens Team →
  Provisioning, creates a SCIM token, and sees it listed.
- [ ] Do not run locally. Push and let CI run it.
- [ ] Commit `test(e2e): SAML sign-in and the Provisioning tab`.

### Task 17: Docs, changelog, roadmap

- [ ] `guides/server-saml-scim.mdx`: configuration, what to give the IdP (entity ID, ACS, SCIM base URL,
  token), Entra ID and Okta setup steps, attribute mapping, group links and what SCIM may change,
  deprovisioning, certificate rotation (restart), the email-trust note, and the manual release checklist.
- [ ] The configuration table in `wirebench-server.mdx`; the `CHANGELOG.md` `[Unreleased]` entry; the
  roadmap line for #344.
- [ ] `pnpm check:banned-terms` is part of `pnpm check`.
- [ ] Check, then commit `docs: SAML sign-in and SCIM provisioning`.

## After the last task

- Open the implementation PR with "Closes #344", move #344 to In review, and turn on Auto-fix.
- `pnpm test:perf` unskipped before the push.
- File follow-ups: several SAML IdPs; metadata reload on a timer; encrypted assertions; opt-in JIT
  creation; a manual Entra ID / Okta run before the next release.

## Open questions for the owner

None. All seven product questions were answered on 2026-10-13 (spec header).
