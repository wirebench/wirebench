# Wirebench: binding a license to one server — design

Date: 2026-10-05 · Status: design approved by the owner in conversation 2026-10-05 · Module: `licensing`
(issue #203, epic #199)

- **Builds on:** `docs/specs/2026-10-01-wirebench-server-licensing-design.md`. The parts this uses:
  - the license file (§3.1) and verification (§3.2);
  - state (§3.3);
  - the endpoints (§3.6), the command line (§3.7) and the desktop (§3.8);
  - the first risk in §15, which this closes.
- **Decisions recorded here** (owner, 2026-10-05, popup):
  - **A license names one server at most.** The payload carries one optional `serverId`, not a list. A staging server gets its own license or an unbound one.
  - **The id lives in the database, and a copy of the database carries it.** A restore from backup is the same server on new hardware, so the license follows it. A database copied into a staging server runs the production license too. That is a documented limit, not a defect.
  - **Only server admins see the id.** It is in `GET /license`, `admin license show` and the License tab, like the other license facts. The server meta does not carry it.
  - **The id is a UUID that the migration mints.** It is not a ULID. The id is not a sortable record id, and Postgres can mint a UUID without app code.

## Assumptions I'm making

1. **No online check.** The binding is checked offline against the stored id. The no-telemetry promise holds.
2. **The signing tool stays outside this repository** (ADR-0018). The documentation for the new field is the format section of the *Editions and licenses* guide. The owner adds the field to the tool by hand.
3. **One server is one database.** Several instances on one database share the id, as they share the license.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

Stop one Team or Enterprise file from running on any number of servers. Do it without an online check, and keep every license issued so far valid.

### 1.1 In scope

- A server id, minted once by migration 0013 and kept in the database.
- An optional `serverId` in the license payload, and a new invalid reason, `wrong-server`.
- The id shown to admins in `GET /license`, in `admin license show` and on the desktop License tab.
- The guide and the licensing spec.

### 1.2 Not in scope

- **A list of server ids in one license.**
- **Resetting or changing the id.** No command rewrites it.
- **Telling a copied database apart from the server it came from**, for example by checking the Postgres system identifier. That check would also break the license on every `pg_dump` restore and on a managed-database failover.
- **The id in the server meta**, or anywhere a non-admin can read it.

## 2. Concept model

- **Server id:** a lowercase UUID, for example `0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90`. It is minted once per database and never changes.
- **Bound license:** a license whose payload has `serverId`. It verifies only on the server with that id.
- **Unbound license:** a license without the field. It verifies on any server, as every license issued before this change does.

## 3. Behaviour

### 3.1 Minting the id

- Migration `packages/server/migrations/licensing/0013_server-id.sql` creates the table `server_identity` and inserts its one row with `gen_random_uuid()`. That function is built into Postgres 13 and later; the server runs on Postgres 16.
- "First boot" therefore means "first migrate", and the id exists before anything reads it:
  - `serve` migrates before it starts;
  - `migrate` applies pending migrations;
  - every admin command refuses to run while a migration is pending.
- The id comes from one insert in one migration, so two processes can never mint different ids.
- Nothing updates or deletes the row. A restore from backup brings the same id with it.

### 3.2 The payload

`licensePayloadSchema` gains one optional field:

| Field      | Type           | Meaning                                                       |
| ---------- | -------------- | ------------------------------------------------------------- |
| `serverId` | UUID, optional | The only server this license verifies on. If absent, any server. |

The schema stays a `strictObject`. A server from before this change rejects a bound license as `malformed`. It does not ignore the binding. A bound license therefore needs Wirebench Server 3.2 or later, and the guide says so.

### 3.3 Verification

- `verifyLicense(text, publicKeys, now, serverId)` takes the server's id.
- The checks run in this order:
  1. the format;
  2. the signature;
  3. reading the payload;
  4. `expiresAt` after `issuedAt`;
  5. the binding;
  6. `not-yet-valid`.
- If the payload's `serverId` differs from the server's id, verification fails with the reason `wrong-server`. `LicenseInvalidReason` gains that value. The comparison is exact, since both ids are lowercase.
- The message names both ids: `This license was issued for server <payload id>. This server is <server id>. Ask for a license issued for this server.`
- Without `serverId`, the result is exactly what it is today.
- Install verifies first (§3.6 of the licensing spec). A file for another server is therefore refused with `licensing-invalid` and never replaces a working license. The command line exits 2, as it does for every invalid file.
- A stored license is re-verified on every read. A bound license therefore turns `invalid` if it is ever read on another server, for example when only its row is copied into another database.

### 3.4 State, and where the id shows

- `LicenseState` gains `serverId: string`. It is present in every status, including `none`, so an admin can copy it before buying.
- The license service reads the id once, when the module registers, and keeps it, since the id never changes. The admin command line reads it once per command.
- Where the id shows:
  - **`GET /license`** returns it. The route is already admin-only.
  - **`wirebench-server admin license show`** prints `Server id` as its first line, before `Edition`. `install` prints the same block.
  - **The desktop License tab** shows *Server id* first in its list, with a *Copy* button. The button uses `navigator.clipboard.writeText`, as the CI token copy button does.
- The desktop wire type for license state accepts the field as optional, so the desktop can still connect to an older server that does not send it. The row is hidden there.

### 3.5 What an operator sees

- On a new server, `admin license show` prints `Server id` and `Community (none)`. The id goes on the order form.
- The right file installs as before.
- A file for another server is refused at install: `licensing-invalid: This license was issued for server …. This server is ….`
- A bound file that ends up on another server, through a copied license row, shows *Installed, but not valid* with the same message. That server runs as Community.

## 4. Data model and storage

```sql
-- packages/server/migrations/licensing/0013_server-id.sql
create table server_identity (
  singleton  boolean primary key default true check (singleton),
  server_id  uuid not null,
  created_at timestamptz not null default now()
);
insert into server_identity (server_id) values (gen_random_uuid());
```

The repo reads the id as text: `select server_id::text from server_identity`.

If the row is missing, the server refuses to start and the error names the table. A missing row means someone deleted it by hand. Minting a new id without saying so would invalidate the bound license with no explanation.

## 5. Architecture

- **Engine** (`packages/engine/src/server-api/licensing.ts`): `serverId` on the payload and state schemas, and `'wrong-server'` in `LicenseInvalidReason`.
- **Server licensing module:**
  - `repo.ts` gains `serverId(db)`.
  - `format.ts`: `verifyLicense` takes the id.
  - `state.ts`: `licenseState` takes the id and passes it through.
  - `service.ts`: `LicenseEnv` gains `serverId: string`.
  - `module.ts` reads the id in `register`. `identity/cli.ts` reads it before it builds the license env.
  - `cli.ts`: `describeLicense` prints the id.
- **Desktop:**
  - `shared/wire-types.ts`, with type imports only, as the CSP rule requires.
  - `license-tab.tsx` gets the row and the copy button.
- **No new module, route or capability.**

## 6. Security

- **What the binding stops:** one Team or Enterprise file installed on a second, separately installed server.
- **What it does not stop:**
  - a copy of the whole database;
  - a forged `server_identity` row on another server. Anyone who can write the database can set its id to match a license.

  Like the edition gate as a whole, the binding rests on the signature, the trademark and the support relationship (ADR-0018), not on secrecy.
- **The id is not a secret.** It is shown to admins and printed on order forms. It is kept out of the meta only so that every signed-in user does not get a stable fingerprint of the server.
- **Logs:** the install log line still logs only the license id (§6 of the licensing spec). The `wrong-server` message goes back to the admin who made the request and is not logged.

## 7. Testing

- **Engine unit tests:**
  - the payload accepts a UUID `serverId`, rejects a value that is not a UUID, and accepts the field's absence;
  - the state schema accepts `serverId`.
- **`format.test.ts`:**
  - a matching id verifies;
  - a mismatch gives `wrong-server`, with both ids in the message;
  - with the field absent, a license verifies whatever the server's id;
  - a bad signature on a bound payload still reports `bad-signature`, so the binding is never checked before the signature.
- **`state` unit tests:** `serverId` is present for `none`, `active` and `invalid`.
- **Integration tests (Postgres):**
  - migration 0013 inserts exactly one row holding a UUID, and running the migrations again leaves it unchanged;
  - `GET /license` returns the id;
  - `PUT /license` with a file bound to another id answers `licensing-invalid` and leaves the stored license as it was;
  - a license bound to this server installs and is `active`.
- **CLI tests:**
  - `admin license show` prints `Server id` first;
  - `install` of a file for another server exits 2.
- **Renderer tests:**
  - the License tab shows the id, and *Copy* writes it to the clipboard;
  - for a state with no `serverId`, the row is hidden.

## 8. Docs

- **The *Editions and licenses* guide** (`docs-site/src/content/docs/guides/server-licensing.mdx`) covers:
  - where to find the server id for the order form;
  - the `serverId` field, in the format section;
  - that a bound license needs Wirebench Server 3.2 or later;
  - that a copied database carries the id.
- **The licensing spec, §15:** the first risk is marked closed by this design, with a link to it.
- **`CHANGELOG.md`:** one line.

## 9. Open questions

None.
