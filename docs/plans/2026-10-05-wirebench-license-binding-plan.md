# Bind a license to one server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A license may carry `serverId`, and then it verifies only on the server whose database holds that id (issue #203).

**Architecture:**
- The engine's payload and state schemas gain the field, and the engine gains a new invalid reason.
- On the server, the pure functions `verifyLicense` and `licenseState` take the server id.
- A licensing migration mints the id. The module and the admin command line read it once and pass it in.
- The desktop License tab shows the id, with a Copy button.

**Tech Stack:** TypeScript on Node 24, Fastify + Postgres 16, zod 4, Vitest, Electron + React renderer.

**Spec:** `docs/specs/2026-10-05-wirebench-license-binding-design.md`.

## Global Constraints

- **The id:** a lowercase UUID minted by `gen_random_uuid()` in `packages/server/migrations/licensing/0013_server-id.sql`, in table `server_identity(singleton, server_id uuid, created_at)`. Nothing updates or deletes the row.
- **The payload field:** `serverId`, optional, a lowercase UUID. The payload schema stays a `strictObject`.
- **The invalid reason:** `wrong-server`, with exactly this message: `This license was issued for server ${payload}. This server is ${server}. Ask for a license issued for this server.`
- **Check order in `verifyLicense`:**
  1. format;
  2. signature;
  3. JSON and schema;
  4. `expiresAt` after `issuedAt`;
  5. **binding**;
  6. `not-yet-valid`.
- **Visibility:** the id appears only in `GET /license` (admin-only), `admin license show`/`install` and the License tab. Never in the server meta.
- **Renderer imports:** the renderer imports only **types** from `shared/wire-types.ts`. An eager value import breaks every e2e test through the CSP zod probe.
- **No product names:** never name which product inspired a feature (`pnpm check:banned-terms`).
- **Gate:** `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit, with `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`. No local e2e.
- **Commits:** one per task, subject ending `(#203)`, no `Co-Authored-By` or `Claude-Session` trailer, author Mohammed Naami <m.naami@outlook.com>.

## Rulings made while planning

1. **The payload id is checked as lowercase.** The check is a regex, not `z.uuid()`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. An uppercase id is then `malformed` when the signing tool is tested, rather than a surprising `wrong-server` later. Postgres prints `uuid::text` in lowercase.
2. **`LicenseState.serverId` is optional in the engine schema.** The licensing service always sets it. The host's `permissiveLicense()` does not, and neither do older servers. The desktop hides the row when the field is absent.
3. **Migration 0013 goes in the licensing folder, so 0008–0012 must load wherever licensing loads.** Versions are checked for contiguity across modules (`allMigrations` in `serve.ts`).
   - `licensingHarness`, the test helper, adds a migrations-only module for `AUDIT_LOG_MIGRATIONS_DIR` whenever `extra` has no module named `audit-log`.
   - The audit-log tests already pass `auditLogModule` through `extra`.
4. **A missing `server_identity` row is an error, never a re-mint.**
   - `repo.serverId(db)` throws `new Error(MISSING_SERVER_ID)`, where `MISSING_SERVER_ID = 'the server_identity table has no row. It holds the id licenses are bound to; restore it from a backup instead of inserting a new one.'`
   - At `serve`, the error is thrown in the module's `register`, so startup fails.
   - In the admin command line, it reaches the generic error path.
5. **The admin command line reads the id after its pending-migrations check.** Before that check the table may not exist. `runAdmin` builds its license service after the check (Task 2).

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/server-api/licensing.ts` | `serverId` on the payload and state schemas; `'wrong-server'` in `LicenseInvalidReason` |
| `packages/server/src/licensing/format.ts` | `verifyLicense(text, keys, now, serverId)` |
| `packages/server/src/licensing/state.ts` | `licenseState(stored, keys, now, seatsUsed, serverId)` |
| `packages/server/migrations/licensing/0013_server-id.sql` | new |
| `packages/server/src/licensing/repo.ts` | `serverId(db)`, `MISSING_SERVER_ID` |
| `packages/server/src/licensing/service.ts` | `LicenseEnv.serverId` |
| `packages/server/src/licensing/module.ts` | reads the id in `register` |
| `packages/server/src/identity/cli.ts` | reads the id after the pending check |
| `packages/server/src/licensing/cli.ts` | `describeLicense` prints `Server id` first |
| `apps/desktop/src/shared/wire-types.ts` | `serverId` on `licenseStateWireSchema` |
| `apps/desktop/src/renderer/features/team/license-tab.tsx` | the row and *Copy* |
| docs | the guide, the licensing spec's §15, `CHANGELOG.md` |

---

### Task 1: The field, the reason and the pure checks

**Files:**
- Modify: `packages/engine/src/server-api/licensing.ts` (lines 28, 37-45, 49-64).
- Modify: `packages/server/src/licensing/format.ts` and `packages/server/src/licensing/state.ts`.
- Modify `LicenseEnv` and its callers so they compile. Add `serverId: string` to `LicenseEnv` and to `createLicenseService`'s env now, and make every caller pass one:
  - `module.ts` and `identity/cli.ts` pass the placeholder `''` with the comment `// Task 2 reads the minted id`;
  - `test/integration/licensing/seats.test.ts:74` passes a test constant.

  Task 2 replaces both placeholders, and none may survive Task 2.
- Test: `packages/engine/test/unit/server-api/licensing.test.ts`, `packages/server/test/unit/licensing/format.test.ts` and `packages/server/test/unit/licensing/state.test.ts`.

**Interfaces:**
- Produces:
  - `verifyLicense(text: string, publicKeys: readonly KeyObject[], now: Date, serverId: string): Verified`
  - `licenseState(stored: string | undefined, publicKeys: readonly KeyObject[], now: Date, seatsUsed: number, serverId: string): LicenseState`, whose result always includes `serverId`
  - `LicenseEnv { db; publicKeys; now; serverId: string }`
  - `LicenseInvalidReason = 'malformed' | 'bad-signature' | 'not-yet-valid' | 'wrong-server'`

- [ ] **Step 1: Engine tests.** In `licensing.test.ts`, using the file's existing payload fixture under whatever name it has:

```ts
const SERVER = '0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90';
it('accepts a lowercase serverId and its absence', () => {
  expect(licensePayloadSchema.safeParse({ ...PAYLOAD, serverId: SERVER }).success).toBe(true);
  expect(licensePayloadSchema.safeParse(PAYLOAD).success).toBe(true);
});
it.each(['not-a-uuid', SERVER.toUpperCase(), ''])('rejects serverId %j', (serverId) => {
  expect(licensePayloadSchema.safeParse({ ...PAYLOAD, serverId }).success).toBe(false);
});
it('carries serverId on the state', () => {
  const state = { edition: 'community', status: 'none', seats: { used: 0, limit: 5 }, features: [], serverId: SERVER };
  expect(licenseStateSchema.parse(state)).toEqual(state);
});
```

- [ ] **Step 2: Engine change.**

```ts
export type LicenseInvalidReason = 'malformed' | 'bad-signature' | 'not-yet-valid' | 'wrong-server';
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// in licensePayloadSchema, after features:
  /** The only server this license verifies on (license-binding spec §3.2). Absent: any server. */
  serverId: z.string().regex(SERVER_ID).optional(),
// in licenseStateSchema, before licenseId:
  /** The id licenses are bound to. Set by every server that has it; absent from older servers. */
  serverId: z.string().optional(),
```

- [ ] **Step 3: `format.test.ts`.** Every existing call gains a fourth argument, `SERVER`: a module constant with the same UUID as above. Then add:

```ts
describe('the server binding (license-binding spec §3.3)', () => {
  const OTHER = '11111111-2222-4333-8444-555555555555';
  it('verifies a license bound to this server', () => {
    expect(verifyLicense(license(keys, { serverId: SERVER }), [keys.publicKey], NOW, SERVER)).toEqual({
      ok: true,
      license: { ...PAYLOAD, serverId: SERVER },
    });
  });
  it('is wrong-server for another server, naming both ids', () => {
    expect(verifyLicense(license(keys, { serverId: OTHER }), [keys.publicKey], NOW, SERVER)).toEqual({
      ok: false,
      reason: 'wrong-server',
      message: `This license was issued for server ${OTHER}. This server is ${SERVER}. Ask for a license issued for this server.`,
    });
  });
  it('verifies an unbound license on any server', () => {
    expect(verifyLicense(license(keys), [keys.publicKey], NOW, OTHER).ok).toBe(true);
  });
  it('checks the signature before the binding', () => {
    expect(verifyLicense(license(other, { serverId: OTHER }), [keys.publicKey], NOW, SERVER)).toMatchObject({
      reason: 'bad-signature',
    });
  });
  it('checks the binding before the clock', () => {
    const future = license(keys, { serverId: OTHER, issuedAt: '2026-12-01T00:00:00Z', expiresAt: '2027-12-01T00:00:00Z' });
    expect(verifyLicense(future, [keys.publicKey], NOW, SERVER)).toMatchObject({ reason: 'wrong-server' });
  });
});
```

- [ ] **Step 4: `format.ts`.** Add the parameter, and put this check between the `expiresAt` check and the `not-yet-valid` check:

```ts
  if (license.serverId !== undefined && license.serverId !== serverId) {
    return {
      ok: false,
      reason: 'wrong-server',
      message: `This license was issued for server ${license.serverId}. This server is ${serverId}. Ask for a license issued for this server.`,
    };
  }
```

Extend the file's doc comment to mention the binding (license-binding spec §3.3).

- [ ] **Step 5: `state.test.ts`.**
  - Every call passes `SERVER`.
  - Every expected state includes `serverId: SERVER`: `none`, `invalid`, `active`, `grace` and `expired`.
  - Add one test: a license bound to another id gives `status: 'invalid'` and `reason: 'wrong-server'`, with `serverId: SERVER`.

- [ ] **Step 6: `state.ts`.** Add the parameter. Put `serverId` into the `community` base object and into the active/grace return, so every branch has it.

- [ ] **Step 7: Make the callers compile** (`service.ts`, `module.ts`, `identity/cli.ts`, `seats.test.ts`) as listed under Files. `service.ts` passes `env.serverId` to `licenseState`, and `installLicense` passes it to `verifyLicense`.

- [ ] **Step 8: Gate, then commit** `feat(licensing): a license may name the one server it verifies on (#203)`.

### Task 2: Mint the id and wire it through the server

**Files:**
- Create: `packages/server/migrations/licensing/0013_server-id.sql`.
- Modify:
  - `packages/server/src/licensing/repo.ts`, `module.ts` and `cli.ts`;
  - `packages/server/src/identity/cli.ts` (lines 28-67 and 110-115);
  - `packages/server/test/helpers/licensing.ts`.
- Test:
  - `packages/server/test/integration/licensing/routes.test.ts` and `cli.test.ts`;
  - new: `packages/server/test/integration/licensing/server-id.test.ts`;
  - `packages/server/test/unit/licensing/cli-describe.test.ts`.

**Interfaces:**
- Consumes from Task 1: `LicenseEnv.serverId`, `licenseState(..., serverId)` and `verifyLicense(..., serverId)`.
- Produces: `repo.serverId(db: Querier): Promise<string>` and `repo.MISSING_SERVER_ID: string`.

- [ ] **Step 1: The migration.**

```sql
-- packages/server/migrations/licensing/0013_server-id.sql
-- Wirebench Server 0013: the server id a license may be bound to (license-binding spec §3.1, §4).
-- Minted here, once, so it exists before serve or any admin command reads it. Nothing updates or deletes
-- the row; a restore from backup keeps it, so a license follows its server to new hardware.
create table server_identity (
  singleton  boolean primary key default true check (singleton),
  server_id  uuid not null,
  created_at timestamptz not null default now()
);
insert into server_identity (server_id) values (gen_random_uuid());
```

- [ ] **Step 2: The harness stand-in** (Ruling 3). In `test/helpers/licensing.ts`, import `AUDIT_LOG_MIGRATIONS_DIR` and add:

```ts
/** Audit-log's 0008–0012, without its routes: licensing's 0013 cannot load across a gap. */
const auditMigrationsOnly: ServerModule = {
  name: 'audit-log',
  migrationsDir: AUDIT_LOG_MIGRATIONS_DIR,
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
  async register() {},
};
```

- Build the module list from `const extra = options.extra?.(clock) ?? [];`, and append `auditMigrationsOnly` only when `!extra.some((m) => m.name === 'audit-log')`.
- Update the comment above `licensingHarness` to match.
- If the type of `ServerModule['name']` rejects this name, cast it the way `routes.test.ts` casts `'gate-probe'`.
- Check that every test which loads `licensingModule` without the harness still migrates: `grep -rln licensingModule packages/server/test` lists them.

- [ ] **Step 3: The repo.**

```ts
export const MISSING_SERVER_ID =
  'the server_identity table has no row. It holds the id licenses are bound to; restore it from a backup instead of inserting a new one.';

/** The id migration 0013 minted (license-binding spec §3.1). Never re-minted: a missing row is an error. */
export async function serverId(db: Querier): Promise<string> {
  const row = (await db.query<{ id: string }>('select server_id::text as id from server_identity')).rows[0];
  if (row === undefined) throw new Error(MISSING_SERVER_ID);
  return row.id;
}
```

- [ ] **Step 4: `server-id.test.ts`**, with `describeDb` and `licensingHarness`:
  - After start, `server_identity` has exactly one row, and `repo.serverId(h.db)` matches the lowercase UUID regex.
  - Restart over the same schema with `licensingHarness(keys, { db: h.db })`, as the harness doc describes. The id is unchanged.
  - With the row deleted, `repo.serverId` rejects with `MISSING_SERVER_ID`.

- [ ] **Step 5: The module.** In `register`, read `const serverId = await repo.serverId(ctx.db);` and pass it to `createLicenseService` and `licenseRoutes`. `register` now awaits, so drop its `require-await` eslint-disable comment.

- [ ] **Step 6: The admin command line** (Ruling 5). In `runAdmin`:
  - Keep the config/db `try` as it is, without building the license service there.
  - Once the pending-migrations check finds nothing pending, build the service: `const license = createLicenseService({ db, publicKeys, now, serverId: await readServerId(db) });`.
  - Put it into `env.ctx`. The `ctx` object is built in the first `try`, so either assign `license` on it after the check or build `env` after the check, whichever reads more cleanly.
  - The `runLicenseCommand` call passes `serverId` in its env too.
  - No Task 1 placeholder `''` may remain: `grep -rn "Task 2 reads" packages` must find nothing.

- [ ] **Step 7: `describeLicense`.** Print `Server id` first, when present:

```ts
const rows: [string, string][] = [];
if (state.serverId !== undefined) rows.push(['Server id', state.serverId]);
rows.push(['Edition', `${LABEL[state.edition]} (${state.status})`]);
```

In `cli-describe.test.ts`, the existing cases have no `serverId` and stay unchanged. Add one case with `serverId` whose output starts `'Server id   0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90\nEdition     Community (none)\n'`.

- [ ] **Step 8: Route tests** (`routes.test.ts`). Read `const id = await repo.serverId(h.db)`. Then:
  - `GET /license` with no license includes `serverId: id`.
  - `PUT` with `license(keys, { serverId: id })` answers 200 with `status: 'active'`.
  - `PUT` with `license(keys, { serverId: '11111111-2222-4333-8444-555555555555' })` answers the `licensing-invalid` problem, with both ids in its detail. A license installed before it is still stored afterwards: check with `repo.storedLicense`.

- [ ] **Step 9: CLI tests** (`cli.test.ts`):
  - `admin license show` on a fresh database prints a first line matching `/^Server id   [0-9a-f-]{36}\n/`.
  - `admin license install` of a file bound to another id exits 2, and its stderr starts `licensing-invalid: This license was issued for server`.

- [ ] **Step 10: Gate, then commit** `feat(server): mint a server id and refuse a license bound to another server (#203)`.

### Task 3: The License tab shows the id

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (`licenseStateWireSchema`, line 6460) and `apps/desktop/src/renderer/features/team/license-tab.tsx`.
- Test: `apps/desktop/test/renderer/license-tab.test.tsx`. Also any main-process test that parses license state with `licenseStateWireSchema`; check with `grep -rn licenseStateWireSchema apps/desktop/test`.

- [ ] **Step 1: Tests.**
  - With `get` answering `{ ...community, serverId: SERVER }`, `screen.getByTestId('license-server-id')` has the text `SERVER`.
  - Clicking `license-copy-server-id` calls `navigator.clipboard.writeText(SERVER)`. Stub it as `code-panel.test.tsx:82` does.
  - With `community`, which has no `serverId`, `queryByTestId('license-server-id')` is null.
  - If a main-process test parses the wire schema, a state with `serverId` keeps it.

- [ ] **Step 2: Wire schema.** Add `serverId: z.string().optional(),` before `licenseId`.

- [ ] **Step 3: The tab.** Add the row first in the `<dl>`, before *Edition*:

```tsx
{state.serverId !== undefined && (
  <>
    <dt className="text-fg-subtle">Server id</dt>
    <dd className="flex items-center gap-2">
      <span data-testid="license-server-id" className="font-mono text-xs">{state.serverId}</span>
      <Button
        variant="ghost"
        data-testid="license-copy-server-id"
        aria-label="Copy server id"
        onClick={() => void navigator.clipboard.writeText(state.serverId!)}
      >
        Copy
      </Button>
    </dd>
  </>
)}
```

Add a sentence to the component's doc comment: the server id comes first, for the order form (license-binding spec §3.4).

- [ ] **Step 4: Gate, then commit** `feat(desktop): show the server id on the License tab (#203)`.

### Task 4: Docs

**Files:**
- `docs-site/src/content/docs/guides/server-licensing.mdx`:
  - In *Installing a license*, say where to find the server id: `wirebench-server admin license show`, or *Server id* with its *Copy* button on the License tab. Say that it goes on the order form.
  - In *How the check works*, cover:
    - the optional `serverId` field;
    - that a license bound to another server is refused, with a message naming both ids;
    - that a bound license needs Wirebench Server 3.2 or later, because an older server reports it as malformed;
    - that a copy of the database carries the id, so a staging server built from a copy of production runs the production license.
- `docs/specs/2026-10-01-wirebench-server-licensing-design.md`, §15: end the first risk with "Closed by `docs/specs/2026-10-05-wirebench-license-binding-design.md` (#203)."
- `CHANGELOG.md`: one line in the unreleased section, in its existing style. It says that a license can be bound to one server, and that the server id shows in `admin license show` and on the License tab.

- [ ] Run `pnpm check:banned-terms` and the docs build (`pnpm --filter docs-site build`, or whatever script the repo uses for the site). Then gate and commit `docs: binding a license to one server (#203)`.

## After the last task

1. A final review of the range, then one fix wave.
2. `pnpm test:perf`, then push `feat/203-license-binding`.
3. Open a PR that closes #203. The spec commit is in it.
4. Merge with `gh pr merge --merge` only when the owner asks.

## Open questions

None.
