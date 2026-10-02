# Wirebench: `licensing` — design

Date: 2026-10-01 · Status: design approved by the owner in conversation 2026-10-01 · Module: `licensing`
of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (fourth slice, first module)

- Builds on:
  - `docs/specs/2026-09-24-wirebench-server-host-design.md`: the Fastify + Postgres process, the module
    list, migrations, `/api/v1/meta`, problem bodies.
  - `docs/specs/2026-09-24-wirebench-server-identity-design.md`: server admins, invitations, the OIDC
    first sign-in, `PATCH /users/:id`, the `wirebench-server admin …` command line.
  - `docs/specs/2026-09-24-wirebench-server-teams-access-design.md`: the guards every route runs
    through.
  - `ServerHooks` announcements (`packages/server/src/context.ts`), which the audit log listens to.
- Decisions recorded here (owner, 2026-10-01):
  - **Everything stays Apache-2.0.** The key check is a product boundary, not a legal one; a fork may
    remove it. [ADR-0018](../adr/0018-licensing-is-a-product-boundary.md) records this and its
    consequences.
  - **The boundary is a seat cap plus enterprise features.** Community is the server as shipped today,
    for up to five enabled accounts. Team lifts the cap. Enterprise adds the gated features. Nothing
    already shipped becomes paid.
  - **Expiry is 30 days of grace, then features off.** Data is never locked, no account is disabled,
    sync keeps working.
  - **The check never phones home.** Verification is offline, against a public key compiled into the
    server. The no-telemetry promise holds for the server as it does for the app.

## Assumptions I'm making

1. **One license per server.** A server holds at most one license. Installing another replaces it.
   Several servers in one organisation each need their own file, and nothing in v1 stops one file
   being installed on several servers (§15).
2. **Seats are enabled accounts.** Every user whose `disabled_at` is null counts, server admins
   included. A named seat is what an enterprise buyer expects to count, and it needs no activity
   tracking.
3. **Edition names are Community, Team and Enterprise.** Pricing, terms and the signing tool are outside
   this repository.
4. **The signing key pair is Ed25519 and its private half never enters the repository.** Tests use a
   key pair generated in the test and passed through module options, never through configuration, so an
   environment variable cannot mint an edition.
5. **The desktop surface is the existing server-admin area.** The team dialog already shows server
   admins extra controls; License is a tab there. No new window.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

An operator installs Wirebench Server, invites their team, and reaches the point where the sixth
engineer cannot be invited. They buy a Team license, paste one line into the License tab, and the
invitation goes through. A year later the license expires; for 30 days a banner tells the admins, and
after that the server is Community again with everyone still signed in. An enterprise buyer installs an
Enterprise license and the Audit tab (next module) lights up.

### 1.1 In scope

- The license file format and its offline verification.
- Installing, reading and removing a license over HTTP and from the command line.
- `LicenseState`: edition, status, seats, dates, computed from the stored license and the clock.
- Seat enforcement at the four places an enabled account comes into being.
- A feature gate other modules call, and the problem it answers with.
- The edition in `/api/v1/meta`; the full state for server admins.
- The desktop License tab and the grace and expiry banners.
- A `licenseChanged` announcement.

### 1.2 Not in scope

- Binding a license to a server, so one file cannot serve several servers (§15).
- Any online check, activation, telemetry or usage report.
- Pricing, trials, the signing tool, the commerce site.
- Per-feature keys beyond the explicit `features` list a license may carry.
- Gating anything the desktop does without a server.

## 2. Concept model

- **License**: a signed statement that one customer may run one edition with so many seats until a
  date. Immutable once issued; replaced, never edited.
- **Edition**: `community`, `team` or `enterprise`. Community is the absence of a valid license.
- **Feature**: a name a route or module checks. v1 knows `audit-log`. Later modules add `scim`,
  `policies`, `scheduled-runs`. Team grants no feature; Enterprise grants all of them; an explicit
  `features` list on a license grants exactly those, for one-off deals.
- **Seat**: an enabled account. The limit is 5 for Community, the license's number for Team and
  Enterprise, or unlimited.
- **Status**: `none` (no license stored), `active`, `grace` (past expiry, within 30 days), `expired`
  (past grace) or `invalid` (stored but fails verification, for example after a key rotation). Only
  `active` and `grace` grant the license's edition; the other three are Community.

## 3. Behaviour

### 3.1 The license file

One line of text:

```
wbl1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
```

`wbl1` is the format version. The signature covers the exact payload bytes between the dots, so the
payload is never re-serialised before verification. The payload:

```json
{
  "id": "01J9EXAMPLE0000000000000000",
  "customer": "Example AG",
  "edition": "team",
  "seats": 50,
  "issuedAt": "2026-10-01T00:00:00Z",
  "expiresAt": "2027-10-01T00:00:00Z",
  "features": ["audit-log"]
}
```

- `id`: a ULID, unique per issued license; it appears in the audit log and in support conversations.
- `customer`: free text, shown on the License tab and nowhere else.
- `edition`: `team` or `enterprise`.
- `seats`: a positive integer, or `null` for unlimited.
- `issuedAt`, `expiresAt`: ISO 8601 UTC. A license whose `issuedAt` is in the future is `invalid`, with
  a message that names the server clock.
- `features`: optional. When present, exactly these features are granted regardless of edition. When
  absent, the edition decides (§2).

The wire schema (`packages/engine/src/server-api/licensing.ts`, plain zod, ADR-0009) is shared with
the desktop so it can show a parse error before sending. Unknown payload keys are refused: the format
version is what grows the payload.

### 3.2 Verification

`verifyLicense(text, publicKeys, now)` is pure and returns either a `License` or a reason:
`malformed` (not three dot-separated parts, bad base64, payload not matching the schema),
`bad-signature`, `not-yet-valid`. It does not look at expiry: expiry is state, not validity, so a
license that expired yesterday verifies and is reported as `grace`.

The production public key is a constant in `packages/server/src/licensing/keys.ts`. There is one key
in v1. A rotation ships a new server version with both keys and the verifier tries each; licenses signed
by a retired key become `invalid` only when its constant is removed, which the release notes announce a
version ahead.

### 3.3 State

`licenseState(stored, now, seatsUsed)` is pure:

| Stored | Clock | Status | Edition | Seat limit |
| --- | --- | --- | --- | --- |
| nothing | — | `none` | community | 5 |
| fails verification | — | `invalid` | community | 5 |
| verifies | `now < expiresAt` | `active` | the license's | the license's |
| verifies | `expiresAt ≤ now < expiresAt + 30 days` | `grace` | the license's | the license's |
| verifies | `now ≥ expiresAt + 30 days` | `expired` | community | 5 |

The state also carries `seats: { used, limit }`, `expiresAt`, `graceUntil`, `customer`, `licenseId`
and `features` (the granted set). `used` is one count query; the state is computed on demand, not
cached, because every input is either in memory or one cheap query, and a single-instance server has no
cache to keep coherent (ADR-0013).

### 3.4 Seat enforcement

Four places create or restore an enabled account. Each asks `assertSeatAvailable(tx)` inside its
transaction, which counts enabled users and compares with the limit from the current state:

| Where | Module | On refusal |
| --- | --- | --- |
| `POST /invitations` with `kind: invite` | identity | `409 licensing-seat-limit`, so the admin learns before the invitee does |
| `POST /invitations/accept` for `kind: invite` | identity | `409 licensing-seat-limit`; the invitation stays open, so it goes through once a seat frees |
| OIDC callback that creates a user (identity §3.3) | identity | redirect to the loopback with `error=licensing-seat-limit`, as other refusals |
| `PATCH /users/:id` with `disabled: false` | identity | `409 licensing-seat-limit` |

The count happens inside the same transaction as the insert, after `select … for update` on the
single-row `license` table (an empty table is locked through an advisory lock with a fixed key), so
two concurrent acceptances cannot both pass at the last seat. A `kind: reset` invitation never counts:
it changes nothing about who is enabled.

Disabling a user frees a seat at once. A downgrade (expiry, removal, a smaller license) never disables
anyone: a server with 40 enabled users and a Community limit of 5 keeps all 40 working and refuses the
41st. The problem message says how many seats are used and allowed, and which edition would lift it.

### 3.5 The feature gate

```ts
requireFeature(feature: Feature): preHandlerAsyncHookHandler
```

Registered by routes of later modules after their role guard, so an unauthenticated or forbidden
caller gets the role guard's answer, and a permitted caller on a server without the feature gets
`403 licensing-feature-required` with `details: { feature, editions: ['enterprise'] }`. A module that
wants to behave differently rather than refuse (the audit log records regardless, audit-log §3.1)
reads `(await ctx.license.state()).features` directly. The gate reads state at request time, so an
installed license takes effect on the next request, with no restart.

### 3.6 Endpoints (all under `/api/v1`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /license` | server admin | The full `LicenseState` (§3.3). With a stored but invalid license, `status: 'invalid'` and `reason`. |
| `PUT /license` | server admin | `{ license: string }` → `200 LicenseState`. Verifies first: a file that fails verification is **not stored** and answers `400 licensing-invalid` with the reason, so an admin cannot replace a working license with a broken paste. Replaces any stored license. Announces `licenseChanged`. |
| `DELETE /license` | server admin | Removes the stored license; the server is Community on the next request. `204`. Announces `licenseChanged`. |
| `GET /meta` | none | Gains `edition: 'community' \| 'team' \| 'enterprise'`. Nothing else about the license is public. |

Rate limiting follows identity §3.6 for `PUT`, since it carries a signature check.

### 3.7 Command line

`wirebench-server admin license install <file>`, `wirebench-server admin license show` and
`wirebench-server admin license remove`: the same code as the endpoints, for an operator who installs
from a provisioning script or before anyone is a server admin. `show` prints the state as the License
tab shows it. `install` refuses a file that fails verification with the same reason and exit code 2
(invalid input), matching `admin-invite`.

### 3.8 Desktop

- **License tab** in the team dialog, visible to server admins only. Shows edition, status, customer,
  seats used of limit, expiry and, during grace, the grace end. A text field accepts a pasted license;
  *Choose file…* reads one from disk. A parse failure (the shared schema) shows inline before anything
  is sent; a server refusal shows its message. *Remove license…* confirms first.
- **Banner** on the team dialog and the Accounts preferences section for server admins: during grace,
  "This server's license expired on <date>. Everything keeps working until <graceUntil>."; after
  expiry, "This server is on the Community edition. <n> of 5 seats are in use." Members who are not
  server admins see nothing: a seat refusal reaches them only as the invitation's error.
- The sign-in dialog, when an invitation acceptance is refused for seats, shows the server's message
  and "Ask a server admin." No upsell text in the app.

### 3.9 Announcement

`ServerHooks.licenseChanged: Announcement<LicenseChanged>[]` with
`{ action: 'installed' | 'removed', licenseId?: string, edition?: Edition, actorUserId: string }`. Fired
after the statement that stored or deleted the row. The audit log is its first listener; the live hub
does not listen, since the License tab re-reads on open.

## 4. Data model and storage

### 4.1 Configuration

None. There is deliberately no environment variable for the license text or the public key (assumption
4). `WIREBENCH_SERVER_LICENSE_GRACE_DAYS` does not exist either: grace is 30 days, a product term.

### 4.2 Database (`packages/server/migrations/licensing/0007_licensing.sql`)

```sql
create table license (
  singleton    boolean primary key default true check (singleton),
  text         text not null,
  license_id   text not null,
  installed_by text references users on delete set null,
  installed_at timestamptz not null default now()
);
```

One row at most. The raw text is stored, not the parsed fields, so a later server version re-verifies
with its own keys and schema. `license_id` is denormalised for the audit log and `show`.

### 4.3 Desktop storage

Nothing. The state is read from the server when the tab opens.

## 5. Architecture

### 5.1 Server module

`packages/server/src/licensing/`: `format.ts` (parse and verify, pure), `state.ts` (`licenseState`,
pure), `keys.ts` (the production public key), `seats.ts` (`assertSeatAvailable`), `gate.ts`
(`requireFeature`), `repo.ts`, `routes.ts`, `cli.ts`, `module.ts`. The module registers **right after
identity** in `BUILTIN_MODULES`, so its routes sit behind identity's `onRequest` guard like every
other module's. Identity's handlers read `ctx.license` at request time, not at registration, so the
order of the two does not matter for the service, only for the routes. The host creates
`ctx.license` as a permissive default (unlimited seats, no features) and the module replaces it in
`register()`; a test that registers identity alone keeps the default, so the existing identity suites
do not change. `ServerModule.name` gains `'licensing'`. The service:

```ts
interface LicenseService {
  state(tx?: Querier): Promise<LicenseState>;
  assertSeatAvailable(tx: Querier): Promise<void>;
  requireFeature(feature: Feature): preHandlerAsyncHookHandler;
}
ctx.license: LicenseService
```

### 5.2 Wire schemas shared with the desktop

`packages/engine/src/server-api/licensing.ts`: the payload schema, `LicenseState`, the three problem
codes, and `LICENSE_TEXT_PATTERN`. The renderer imports only types (the renderer wire-types CSP trap:
an eager value import from wire-types breaks every e2e).

### 5.3 Desktop

Main: `LicenseService` methods on the server client (`get`, `install`, `remove`), parsed with the
shared schema. Renderer: `features/team/license-tab.tsx`, banner in `team-dialog.tsx` and
`preferences/sections/accounts-section.tsx`, state in `state/account.ts` beside `serverAdmin`.

## 6. Security

- Ed25519 through `node:crypto`; no dependency. The signature covers the raw payload bytes.
- The server stores the text as given; it never logs it. Logs carry `licenseId` only.
- `PUT /license` is server-admin only and rate-limited; a flood of bad signatures costs one
  verification each and nothing else.
- Verification is offline. No outbound request exists in this module; the host's boundaries test that
  asserts no unexpected egress covers it.
- An `invalid` stored license is reported, not silently treated as absent, so an admin notices a key
  rotation they missed.

## 7. Tech stack

Node `crypto.verify('ed25519', …)`, zod, Fastify, Postgres. Nothing new.

## 8. Commands

- `wirebench-server admin license install <file> | show | remove` (§3.7).
- `pnpm --filter @wirebench/server test` covers the module; `WIREBENCH_SKIP_PERF=1 pnpm check` before
  each commit.

## 9. Project structure (new or changed)

```
packages/engine/src/server-api/licensing.ts
packages/server/migrations/licensing/0007_licensing.sql
packages/server/src/licensing/{format,state,keys,seats,gate,repo,routes,cli,module}.ts
packages/server/src/identity/invitations.ts        assertSeatAvailable at create and accept
packages/server/src/identity/linking.ts            assertSeatAvailable at first OIDC sign-in
packages/server/src/identity/routes/users.ts       assertSeatAvailable on re-enable
packages/server/src/context.ts                     LicenseService, licenseChanged
packages/server/src/modules.ts                     licensingModule() after identity
packages/server/src/args.ts                        admin license …
apps/desktop/src/main/server/license.ts
apps/desktop/src/renderer/features/team/license-tab.tsx
apps/desktop/src/renderer/features/team/team-dialog.tsx
apps/desktop/src/renderer/features/preferences/sections/accounts-section.tsx
apps/desktop/src/renderer/state/account.ts
docs/adr/0018-licensing-is-a-product-boundary.md
docs-site/src/content/docs/server/licensing.md
```

## 10. Code style

As the other server modules: pure rules in their own files and table-tested; routes thin; problem codes
prefixed `licensing-`; no `any`; comments say why.

## 11. Testing strategy

- **Pure**: `format.ts` against a test key pair: round trip, each malformed shape, a flipped byte, a
  future `issuedAt`, unknown keys refused. `state.ts`: the table in §3.3 with an injected clock, the
  boundaries at `expiresAt` and `expiresAt + 30d`, `features` overriding edition.
- **Module, fake database**: `PUT` stores a valid file and refuses an invalid one without touching the
  stored row; `DELETE`; `GET /meta` shows only the edition; `GET /license` needs server admin.
- **Seats**: at the limit, each of the four entry points refuses; the fifth of five passes; a disabled
  user frees a seat; a reset invitation never counts; two concurrent acceptances at the last seat
  admit one (a transaction test against a real Postgres in the existing server integration suite).
- **Gate**: a route behind `requireFeature('audit-log')` answers 403 with the feature on Community and
  Team, 200 on Enterprise and on a Team license with `features: ['audit-log']`, 403 again after
  `DELETE /license` with no restart.
- **CLI**: `install`, `show`, `remove` through `runAdmin` with a fake io, exit codes as `admin-invite`.
- **Desktop**: unit tests for the tab's parse-before-send; one e2e in CI only (headless, per the quiet
  local tests rule) that pastes a test license and sees the seat count change.

## 12. Boundaries

- The module never disables, deletes or alters a user, a workspace or a commit.
- No network egress, no timer, no background work.
- Nothing in the desktop is gated: the app without a server has no edition.
- The server never refuses a request for being over the seat limit; it refuses only the creation or
  restoration of an enabled account.

## 13. Success criteria (done when all are true)

1. A fresh server reports `edition: community` and refuses the sixth enabled account at each of the
   four entry points with `licensing-seat-limit`.
2. Installing a Team license from the tab or the command line lifts the cap on the next request.
3. A route behind `requireFeature` answers 403 on Community and Team and passes on Enterprise.
4. Expiry moves through `grace` to `expired` on the clock alone, with no account disabled and sync
   unaffected, and the banners appear for server admins only.
5. An invalid file is refused and the stored license is unchanged.
6. The audit log (next module) records every install and removal through `licenseChanged`.
7. `pnpm check` green, including the banned-terms gate, and the docs-site page explains the three
   editions without naming any other product.

## 14. Migration and compatibility

Migration `0007` adds one table. Existing servers come up as Community with their current users
intact, whatever their count. An older desktop ignores `edition` in `/meta` and sees no License tab; a
seat refusal reaches it as a problem it shows verbatim.

## 15. Risks

- **One file on many servers.** Nothing binds a license to a server. Mitigation deferred: a
  `serverId` in the payload matched against an id the server mints on first boot, with `show`
  printing the id for the order form. Recorded as a follow-up issue, not in v1.
- **Clock skew.** A server with a wrong clock may see `not-yet-valid` or an early grace. The messages
  name the server time so the operator can tell.
- **Key compromise.** A leaked private key means a new server release with a new public key and every
  customer re-issued. Keep the signing tool offline.
- **The fork question.** Covered by ADR-0018: the boundary rests on the product, the trademark and the
  support relationship, not on the code.

## 16. Open questions (bold = proposed default)

- **Free seats stay at 5.** The owner may move the number; it is one constant.
- **A `trial` edition** is not in v1; a time-limited Enterprise license is a trial already.
