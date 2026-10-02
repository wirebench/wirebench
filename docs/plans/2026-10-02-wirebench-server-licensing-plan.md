# Wirebench Server `licensing` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed, offline-verified license file sets a Wirebench Server's edition (Community, Team, Enterprise), caps Community at five enabled accounts, and gives later modules a feature gate.

**Architecture:** A new `licensing` server module (`packages/server/src/licensing/`) owns a one-row `license` table, pure verification and state functions, and a `LicenseService` placed on `ServerContext`. Identity calls `ctx.license.assertSeatAvailable(tx)` at the four places an enabled account comes into being. The desktop reads and writes the license through three IPC channels and shows a License tab and banners to server admins.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), zod 4 (plain, ADR-0009), `node:crypto` Ed25519, React + zustand in the desktop renderer, Vitest 5, Playwright for e2e.

**Spec:** `docs/specs/2026-10-01-wirebench-server-licensing-design.md`. ADR: `docs/adr/0018-licensing-is-a-product-boundary.md`.

## Global Constraints

- Everything stays Apache-2.0. The key check is a product boundary, not a legal one (ADR-0018).
- Verification is offline: no outbound request, no telemetry, no activation, no timer, no background work.
- Ed25519 through `node:crypto`; no new dependency anywhere.
- License line format: `wbl1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>`.
- Unknown payload keys are refused.
- Editions: `community`, `team`, `enterprise`. Community is the absence of a valid license.
- Free seats: 5 (`COMMUNITY_SEATS`). Grace: 30 days (`GRACE_DAYS`), a product term with no environment variable.
- No environment variable for the license text or the public key. Test keys reach the module only through module options.
- Only `active` and `grace` grant the license's edition. `none`, `expired` and `invalid` are Community.
- A downgrade never disables, deletes or alters a user, a workspace or a commit. The server refuses only the creation or restoration of an enabled account.
- A `kind: reset` invitation never counts against seats.
- Problem codes: `licensing-seat-limit` (409), `licensing-feature-required` (403), `licensing-invalid` (400).
- `GET /api/v1/meta` gains `edition` and nothing else about the license.
- The license text is never logged. Logs carry `licenseId` only.
- Nothing in the desktop is gated. No upsell text in the app.
- The renderer imports only **types** from `shared/wire-types.ts` (an eager value import breaks every e2e through the zod eval probe under the CSP).
- Docs and code never name which product inspired a feature; `pnpm check:banned-terms` enforces it.
- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit. One commit per task. No `Co-Authored-By` or `Claude-Session` trailer. Commits as Mohammed Naami <m.naami@outlook.com>.
- No local Electron e2e windows: e2e runs in CI only.

## Rulings made while planning

Each is a reading of the spec where the spec and the code disagree or the spec is silent.

1. **The signature covers the payload segment's ASCII text**, the bytes literally between the dots. Base64url decoding is lenient, so signing the text keeps one license line equal to one signature.
2. **`features` on a license is a list of strings, filtered to known features** when granted. An older server then ignores a feature a newer signer added, instead of refusing the whole license as malformed. Unknown *keys* are still refused.
3. **`LicenseChanged.actorUserId` is `string | null`.** The command line has no user, as `createInvitation`'s `createdBy` is `null` from the console.
4. **`licensing-feature-required` names the feature in its message**, not in `details`. The host's problem body is `{ code, message }` only (host spec §3.3, `toProblem`), and widening it is out of scope.
5. **Seat checks always take one transaction-scoped advisory lock** (`pg_advisory_xact_lock`) before counting, rather than `select … for update` plus a lock for the empty table. One code path serialises every seat check, whether or not a license row exists.
6. **Team invitations count too.** `createInvitation` is shared by `POST /invitations`, `POST /teams/:id/invitations` and `admin invite`, and the check sits inside it. A team invitation creates an account just as a server invitation does.
7. **Re-enabling counts only when the user is currently disabled.** `PATCH /users/:id` with `disabled: false` on an enabled user creates no seat.
8. **`licensingModule` is not given a capability name.** The desktop shows the License tab to server admins and shows the server's answer, so an older server's `404` reads as an error message on the tab.
9. **Desktop files follow the code, not the spec's paths.** Main uses `src/main/ipc/license.ts` plus `ServerClient` methods, as CI tokens do. The renderer keeps license state in its own `src/renderer/state/license.ts` store, as `ci-tokens.ts` does, because `serverAdmin` lives in the team store, not `state/account.ts`.
10. **The License tab lives in the team dialog's tab strip for server admins.** When the server admin has no team selected, the right pane shows the License tab alone.
11. **The OIDC seat refusal reaches the app as a code only.** The loopback carries `error=licensing-seat-limit`, so the app shows its own fixed text ending "Ask a server admin."
12. **The docs page is `docs-site/src/content/docs/guides/server-licensing.mdx`**, beside `guides/wirebench-server.mdx`. There is no `server/` folder in the docs site.
13. **The command line's announcement reaches nobody**, as for every `admin` command (`identity/cli.ts`). The audit-log plan must record command-line installs and removals itself.
14. **The shared-schema parse before sending happens in main.** The renderer may not import zod values (the CSP trap), so main's `license.install` handler decodes the payload and checks it against the engine's `licensePayloadSchema` before any request. The renderer only checks the line's shape, for instant feedback.

## File map

**Engine (shared wire shapes)**
- Create `packages/engine/src/server-api/licensing.ts`: payload schema, state schema, install request, constants, `LICENSE_TEXT_PATTERN`.
- Modify `packages/engine/src/server-api/meta.ts`: optional `edition`.
- Modify `packages/engine/src/index.ts`: exports.
- Test `packages/engine/test/unit/server-api/licensing.test.ts`.

**Server**
- Create `packages/server/migrations/licensing/0007_licensing.sql`.
- Create `packages/server/src/licensing/`:
  - `format.ts`: `verifyLicense`, pure.
  - `state.ts`: `licenseState`, `grantedFeatures`, pure.
  - `keys.ts`: `PRODUCTION_PUBLIC_KEYS`.
  - `errors.ts`: the three problems.
  - `repo.ts`: the `license` table.
  - `seats.ts`: `countEnabledUsers`, `assertSeatAvailable`.
  - `gate.ts`: `requireFeature`.
  - `service.ts`: `createLicenseService`, `installLicense`, `removeLicense`.
  - `routes.ts`: `GET`, `PUT` and `DELETE /license`.
  - `cli.ts`: `runLicenseCommand`, `describeLicense`.
  - `module.ts`: `licensingModule`.
- Modify `packages/server/src/context.ts`: `LicenseService`, `LicenseChanged`, `permissiveLicense()`, `ServerContext.license`, `ServerHooks.licenseChanged`, `ServerModule.name`.
- Modify `packages/server/src/modules.ts`: register after identity.
- Modify `packages/server/src/serve.ts`: `license: permissiveLicense()`.
- Modify `packages/server/src/routes/meta.ts`: `edition`.
- Modify `packages/server/src/identity/env.ts`: `InvitationEnv.ctx` picks `license`.
- Modify `packages/server/src/identity/invitations.ts`: seat check at create and accept.
- Modify `packages/server/src/identity/linking.ts`: seat check at first OIDC sign-in.
- Modify `packages/server/src/identity/routes/users.ts`: seat check on re-enable.
- Modify `packages/server/src/identity/cli.ts`: license service in the CLI context; dispatch license commands.
- Modify `packages/server/src/args.ts` and `packages/server/src/main.ts`: `admin license …`.
- Test helpers: create `packages/server/test/helpers/licensing.ts`; modify `test/helpers/context.ts`.
- Tests:
  - Create `test/unit/licensing/format.test.ts`, `state.test.ts`, `gate.test.ts` and `cli-describe.test.ts`.
  - Create `test/integration/licensing/routes.test.ts`, `seats.test.ts` and `cli.test.ts`.
  - Modify `test/unit/server.test.ts`, `test/unit/args.test.ts`, `test/integration/identity/oidc.test.ts` and `test/integration/identity/invitations.test.ts`.

**Desktop**
- Modify `apps/desktop/src/shared/wire-types.ts` and `src/shared/ipc.ts`: license wire schemas and channels.
- Modify `apps/desktop/src/main/server-client.ts`: `getLicense`, `installLicense`, `removeLicense`.
- Create `apps/desktop/src/main/ipc/license.ts`; modify `src/main/index.ts`.
- Modify `apps/desktop/src/main/account-service.ts` (loopback message) and `src/renderer/state/account.ts` (sign-in message).
- Create renderer files:
  - `src/renderer/state/license-format.ts`: parse before send, no zod, no `window`.
  - `src/renderer/state/license.ts`: the store.
  - `src/renderer/features/team/license-tab.tsx`.
  - `src/renderer/features/team/license-banner.tsx`.
- Modify `src/renderer/state/team.ts`, `features/team/team-dialog.tsx` and `features/preferences/sections/accounts-section.tsx`.
- Tests:
  - Create `apps/desktop/test/ipc-license.test.ts`, `test/license-format.test.ts`, `test/renderer/license-tab.test.tsx` and `test/renderer/license-banner.test.tsx`.
  - Modify `test/mocks/wirebench-api.ts` and `test/preload-api.test.ts`.
- e2e: modify `e2e/helpers/fake-server.ts`; create `e2e/specs/license.spec.ts`.

**Docs**
- Create `docs-site/src/content/docs/guides/server-licensing.mdx`.
- Modify `docs-site/astro.config.mjs` (sidebar), `site/src/pages/features.astro` (the coverage test requires the link), `packages/server/README.md`, `CHANGELOG.md` and `docs/roadmap.md`.

---

### Task 1: Shared licensing wire shapes in the engine

**Files:**
- Create: `packages/engine/src/server-api/licensing.ts`
- Modify: `packages/engine/src/server-api/meta.ts`
- Modify: `packages/engine/src/index.ts` (beside the `./server-api/ci-tokens.js` export block, near line 1716)
- Test: `packages/engine/test/unit/server-api/licensing.test.ts`

**Interfaces:**
- Produces, all exported from `@wirebench/engine`:
  - Constants: `LICENSE_FORMAT`, `LICENSE_TEXT_PATTERN`, `COMMUNITY_SEATS`, `GRACE_DAYS`, `EDITIONS`, `FEATURES`, `LICENSE_STATUSES` and `LICENSE_TEXT_MAX_LENGTH`.
  - Schemas: `editionSchema`, `featureSchema`, `licensePayloadSchema`, `licenseStateSchema` and `licenseInstallRequestSchema`.
  - Types: `Edition`, `Feature`, `LicenseStatus`, `LicenseInvalidReason`, `LicensePayload`, `LicenseState` and `LicenseInstallRequest`.
- `metaResponseSchema` gains `edition: editionSchema.optional()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/server-api/licensing.test.ts
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_SEATS,
  GRACE_DAYS,
  LICENSE_TEXT_PATTERN,
  licenseInstallRequestSchema,
  licensePayloadSchema,
  licenseStateSchema,
  metaResponseSchema,
} from '../../../src/index.js';

const PAYLOAD = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};

describe('licensing wire shapes (licensing spec §3.1, §3.3)', () => {
  it('fixes the product terms', () => {
    expect(COMMUNITY_SEATS).toBe(5);
    expect(GRACE_DAYS).toBe(30);
  });

  it('accepts the spec payload, with and without features, and unlimited seats', () => {
    expect(licensePayloadSchema.parse(PAYLOAD)).toEqual(PAYLOAD);
    expect(licensePayloadSchema.parse({ ...PAYLOAD, features: ['audit-log'] }).features).toEqual(['audit-log']);
    expect(licensePayloadSchema.parse({ ...PAYLOAD, seats: null }).seats).toBeNull();
  });

  it('keeps a feature name it does not know, so a newer signer does not break an older server', () => {
    expect(licensePayloadSchema.parse({ ...PAYLOAD, features: ['scim'] }).features).toEqual(['scim']);
  });

  it.each([
    ['an unknown key', { ...PAYLOAD, serverId: 'x' }],
    ['community as an edition', { ...PAYLOAD, edition: 'community' }],
    ['zero seats', { ...PAYLOAD, seats: 0 }],
    ['fractional seats', { ...PAYLOAD, seats: 1.5 }],
    ['an id that is not a ULID', { ...PAYLOAD, id: 'license-1' }],
    ['a date that is not ISO 8601', { ...PAYLOAD, expiresAt: 'next year' }],
    ['an empty customer', { ...PAYLOAD, customer: '' }],
  ])('refuses %s', (_name, payload) => {
    expect(licensePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('matches a license line and nothing else', () => {
    expect(LICENSE_TEXT_PATTERN.test('wbl1.eyJh.c2ln')).toBe(true);
    expect(LICENSE_TEXT_PATTERN.test('wbl2.eyJh.c2ln')).toBe(false);
    expect(LICENSE_TEXT_PATTERN.test('wbl1.eyJh')).toBe(false);
    expect(LICENSE_TEXT_PATTERN.test('wbl1.ey Jh.c2ln')).toBe(false);
  });

  it('parses a Community state and a Team state', () => {
    expect(
      licenseStateSchema.parse({
        edition: 'community',
        status: 'none',
        seats: { used: 2, limit: 5 },
        features: [],
      }).seats,
    ).toEqual({ used: 2, limit: 5 });
    expect(
      licenseStateSchema.parse({
        edition: 'team',
        status: 'grace',
        seats: { used: 7, limit: null },
        features: [],
        licenseId: PAYLOAD.id,
        customer: 'Example AG',
        issuedAt: PAYLOAD.issuedAt,
        expiresAt: PAYLOAD.expiresAt,
        graceUntil: '2027-10-01T00:00:00.000Z',
      }).status,
    ).toBe('grace');
  });

  it('bounds the install body', () => {
    expect(licenseInstallRequestSchema.safeParse({ license: '' }).success).toBe(false);
    expect(licenseInstallRequestSchema.safeParse({ license: 'x'.repeat(8193) }).success).toBe(false);
  });

  it('lets /meta carry an edition and still parses an older server without one', () => {
    const meta = {
      name: 'wirebench-server',
      version: '1.0.0',
      apiVersion: 1,
      publicUrl: 'https://wb.test',
      auth: { local: true, oidc: false },
      capabilities: [],
    };
    expect(metaResponseSchema.parse(meta).edition).toBeUndefined();
    expect(metaResponseSchema.parse({ ...meta, edition: 'enterprise' }).edition).toBe('enterprise');
    expect(metaResponseSchema.safeParse({ ...meta, edition: 'gold' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wirebench/engine exec vitest run --root ../.. --project engine-unit packages/engine/test/unit/server-api/licensing.test.ts`
Expected: FAIL, the imports do not exist.

- [ ] **Step 3: Write the schemas**

```ts
// packages/engine/src/server-api/licensing.ts
/**
 * The licensing wire shapes (licensing spec §3.1, §3.3, §3.6). The server verifies and stores a license;
 * the desktop parses a pasted one before sending it and reads the state back. Plain zod only (ADR-0009).
 */
import { z } from 'zod';

export const LICENSE_FORMAT = 'wbl1';
/** `wbl1.<base64url payload>.<base64url signature>`: the shape only; verification is the server's. */
export const LICENSE_TEXT_PATTERN = /^wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Far above any real license line; bounds the body a server admin can send. */
export const LICENSE_TEXT_MAX_LENGTH = 8192;
/** Seats on a server with no license, or a lapsed one. A product term, not a setting. */
export const COMMUNITY_SEATS = 5;
/** Days after `expiresAt` that the license's edition still holds. A product term, not a setting. */
export const GRACE_DAYS = 30;

export const EDITIONS = ['community', 'team', 'enterprise'] as const;
export const editionSchema = z.enum(EDITIONS);
export type Edition = z.infer<typeof editionSchema>;

/** Names a route or module checks. Later modules add `scim`, `policies`, `scheduled-runs`. */
export const FEATURES = ['audit-log'] as const;
export const featureSchema = z.enum(FEATURES);
export type Feature = z.infer<typeof featureSchema>;

export const LICENSE_STATUSES = ['none', 'active', 'grace', 'expired', 'invalid'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];
export type LicenseInvalidReason = 'malformed' | 'bad-signature' | 'not-yet-valid';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * The signed payload. Unknown keys are refused: the format version is what grows the payload.
 * `features` stays a list of strings so that a feature a newer signer names does not make the whole
 * license unreadable to an older server, which grants only the features it knows.
 */
export const licensePayloadSchema = z.strictObject({
  id: z.string().regex(ULID),
  customer: z.string().min(1).max(200),
  edition: z.enum(['team', 'enterprise']),
  seats: z.number().int().positive().nullable(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  features: z.array(z.string().min(1).max(64)).max(64).optional(),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** `GET /license` and the answer to `PUT /license` (§3.3). Fields past `features` are absent with no license. */
export const licenseStateSchema = z.object({
  edition: editionSchema,
  status: z.enum(LICENSE_STATUSES),
  /** `limit: null` is unlimited. */
  seats: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive().nullable() }),
  /** The granted set: empty on Community and Team unless the license lists features. */
  features: z.array(featureSchema),
  licenseId: z.string().optional(),
  customer: z.string().optional(),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  graceUntil: z.string().optional(),
  /** Only with `status: 'invalid'`. */
  reason: z.enum(['malformed', 'bad-signature', 'not-yet-valid']).optional(),
  message: z.string().optional(),
});
export type LicenseState = z.infer<typeof licenseStateSchema>;

export const licenseInstallRequestSchema = z.object({ license: z.string().min(1).max(LICENSE_TEXT_MAX_LENGTH) });
export type LicenseInstallRequest = z.infer<typeof licenseInstallRequestSchema>;
```

In `packages/engine/src/server-api/meta.ts`, import `editionSchema` from `./licensing.js` and add the last field to `metaResponseSchema`:

```ts
  hooks: hooksMetaSchema.optional(),
  /** licensing §3.6: the server's edition, and nothing else about its license. Absent from an older server. */
  edition: editionSchema.optional(),
});
```

In `packages/engine/src/index.ts`, after the `./server-api/ci-tokens.js` type export, add:

```ts
export {
  COMMUNITY_SEATS,
  EDITIONS,
  FEATURES,
  GRACE_DAYS,
  LICENSE_FORMAT,
  LICENSE_STATUSES,
  LICENSE_TEXT_MAX_LENGTH,
  LICENSE_TEXT_PATTERN,
  editionSchema,
  featureSchema,
  licenseInstallRequestSchema,
  licensePayloadSchema,
  licenseStateSchema,
} from './server-api/licensing.js';
export type {
  Edition,
  Feature,
  LicenseInstallRequest,
  LicenseInvalidReason,
  LicensePayload,
  LicenseState,
  LicenseStatus,
} from './server-api/licensing.js';
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @wirebench/engine exec vitest run --root ../.. --project engine-unit packages/engine/test/unit/server-api/licensing.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green. If the engine's public-API snapshot or export-list test fails, add the new names to it; they are intended additions.

```bash
git add packages/engine/src/server-api/licensing.ts packages/engine/src/server-api/meta.ts packages/engine/src/index.ts packages/engine/test/unit/server-api/licensing.test.ts
git commit -m "feat(engine): licensing wire shapes, and an edition in /meta (#197)"
```

### Task 2: Verification and state, pure, with the production key

**Files:**
- Create: `packages/server/src/licensing/format.ts`, `state.ts` and `keys.ts`
- Create: `packages/server/test/helpers/licensing.ts`
- Test: `packages/server/test/unit/licensing/format.test.ts` and `state.test.ts`

**Interfaces:**
- Consumes from Task 1: `licensePayloadSchema`, `LicensePayload`, `LicenseState`, `LicenseInvalidReason`, `Feature`, `FEATURES`, `LICENSE_FORMAT`, `COMMUNITY_SEATS` and `GRACE_DAYS`.
- Produces:
  - `verifyLicense(text: string, publicKeys: readonly KeyObject[], now: Date): Verified`, where `Verified = { ok: true; license: LicensePayload } | { ok: false; reason: LicenseInvalidReason; message: string }`.
  - `licenseState(stored: string | undefined, publicKeys: readonly KeyObject[], now: Date, seatsUsed: number): LicenseState`.
  - `grantedFeatures(license: LicensePayload): Feature[]` and `GRACE_MS: number`.
  - `PRODUCTION_PUBLIC_KEYS: readonly KeyObject[]`.
  - Test helpers: `testKeys(): TestKeys`, `signLicense(payload: object, privateKey: KeyObject): string`, `license(keys: TestKeys, overrides?: Partial<LicensePayload>): string`, and `PAYLOAD: LicensePayload`.

- [ ] **Step 1: Write the test helper**

```ts
// packages/server/test/helpers/licensing.ts
/**
 * Licenses for tests (licensing spec §11): a key pair made in the test and passed to the module through
 * its options, never through configuration, so no environment variable can mint an edition.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { LicensePayload } from '@wirebench/engine';

export interface TestKeys {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export function testKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

/** A Team license for 50 seats, active on the identity harness clock (2026-09-24T12:00Z). */
export const PAYLOAD: LicensePayload = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};

/** Signs any object, valid or not, as the signing tool would: over the payload segment's text. */
export function signLicense(payload: object, privateKey: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return `wbl1.${body}.${signature}`;
}

export function license(keys: TestKeys, overrides: Partial<LicensePayload> = {}): string {
  return signLicense({ ...PAYLOAD, ...overrides }, keys.privateKey);
}
```

- [ ] **Step 2: Write the failing format test**

```ts
// packages/server/test/unit/licensing/format.test.ts
import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicense } from '../../../src/licensing/format.js';
import { license, PAYLOAD, signLicense, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');

describe('verifyLicense (licensing spec §3.1, §3.2)', () => {
  it('round-trips a signed payload', () => {
    expect(verifyLicense(license(keys), [keys.publicKey], NOW)).toEqual({ ok: true, license: PAYLOAD });
  });

  it('accepts surrounding whitespace from a paste', () => {
    expect(verifyLicense(`  ${license(keys)}\n`, [keys.publicKey], NOW).ok).toBe(true);
  });

  it('tries every key, so a rotation can ship two', () => {
    expect(verifyLicense(license(keys), [other.publicKey, keys.publicKey], NOW).ok).toBe(true);
  });

  it('does not look at expiry: a license that expired yesterday verifies', () => {
    const expired = license(keys, { expiresAt: '2026-09-23T00:00:00Z' });
    expect(verifyLicense(expired, [keys.publicKey], NOW).ok).toBe(true);
  });

  it.each([
    ['not three parts', 'wbl1.abc'],
    ['another format version', license(keys).replace(/^wbl1/, 'wbl2')],
    ['an empty string', ''],
    ['a character outside base64url', 'wbl1.ab+c.def'],
  ])('is malformed for %s', (_name, text) => {
    expect(verifyLicense(text, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('is malformed when a correctly signed payload is not JSON, not the schema, or expires before it starts', () => {
    const segment = Buffer.from('not json', 'utf8').toString('base64url');
    const notJson = `wbl1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), keys.privateKey).toString('base64url')}`;
    const unknownKey = signLicense({ ...PAYLOAD, serverId: 'abc' }, keys.privateKey);
    const backwards = license(keys, { expiresAt: '2026-08-01T00:00:00Z' });
    for (const text of [notJson, unknownKey, backwards]) {
      expect(verifyLicense(text, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a flipped byte in the payload, a wrong key and a truncated signature', () => {
    const text = license(keys);
    const [format, body, signature] = text.split('.') as [string, string, string];
    const flipped = `${format}.${body.slice(0, -2)}${body.at(-2) === 'A' ? 'B' : 'A'}${body.at(-1)}.${signature}`;
    expect(verifyLicense(flipped, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(text, [other.publicKey], NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(`${format}.${body}.${signature.slice(0, 10)}`, [keys.publicKey], NOW)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is not yet valid when issued after the server clock, and the message names that clock', () => {
    const future = license(keys, { issuedAt: '2026-09-25T00:00:00Z', expiresAt: '2027-09-25T00:00:00Z' });
    const result = verifyLicense(future, [keys.publicKey], NOW);
    expect(result).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(result.ok === false && result.message).toContain('2026-09-24T12:00:00.000Z');
  });
});
```

- [ ] **Step 3: Write the failing state test**

```ts
// packages/server/test/unit/licensing/state.test.ts
import { describe, expect, it } from 'vitest';
import { grantedFeatures, licenseState } from '../../../src/licensing/state.js';
import { license, PAYLOAD, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const at = (iso: string) => new Date(iso);
const state = (stored: string | undefined, now: string, used = 3) =>
  licenseState(stored, [keys.publicKey], at(now), used);

describe('licenseState (licensing spec §3.3)', () => {
  it('is Community with 5 seats and status none when nothing is stored', () => {
    expect(state(undefined, '2026-09-24T12:00:00Z')).toEqual({
      edition: 'community',
      status: 'none',
      seats: { used: 3, limit: 5 },
      features: [],
    });
  });

  it('is Community and invalid, with the reason, when the stored text fails verification', () => {
    const s = licenseState(license(other), [keys.publicKey], at('2026-09-24T12:00:00Z'), 3);
    expect(s).toMatchObject({ edition: 'community', status: 'invalid', reason: 'bad-signature', seats: { limit: 5 } });
    expect(s.message).toBeTypeOf('string');
  });

  it('is the license edition and seats while active', () => {
    expect(state(license(keys), '2026-09-24T12:00:00Z')).toEqual({
      edition: 'team',
      status: 'active',
      seats: { used: 3, limit: 50 },
      features: [],
      licenseId: PAYLOAD.id,
      customer: 'Example AG',
      issuedAt: PAYLOAD.issuedAt,
      expiresAt: PAYLOAD.expiresAt,
      graceUntil: '2027-10-01T00:00:00.000Z',
    });
  });

  it.each([
    ['one millisecond before expiry', '2027-08-31T23:59:59.999Z', 'active', 'team'],
    ['exactly at expiry', '2027-09-01T00:00:00.000Z', 'grace', 'team'],
    ['one millisecond before grace ends', '2027-09-30T23:59:59.999Z', 'grace', 'team'],
    ['exactly when grace ends', '2027-10-01T00:00:00.000Z', 'expired', 'community'],
  ])('%s → %s (%s)', (_name, now, status, edition) => {
    const s = state(license(keys), now);
    expect(s.status).toBe(status);
    expect(s.edition).toBe(edition);
    expect(s.seats.limit).toBe(edition === 'community' ? 5 : 50);
  });

  it('keeps the dates on an expired license so the banner can name them', () => {
    expect(state(license(keys), '2028-01-01T00:00:00Z')).toMatchObject({
      status: 'expired',
      licenseId: PAYLOAD.id,
      expiresAt: PAYLOAD.expiresAt,
      features: [],
    });
  });

  it('reports unlimited seats as a null limit', () => {
    expect(state(license(keys, { seats: null }), '2026-09-24T12:00:00Z').seats).toEqual({ used: 3, limit: null });
  });
});

describe('grantedFeatures (licensing spec §2)', () => {
  it('grants nothing on Team and every known feature on Enterprise', () => {
    expect(grantedFeatures(PAYLOAD)).toEqual([]);
    expect(grantedFeatures({ ...PAYLOAD, edition: 'enterprise' })).toEqual(['audit-log']);
  });

  it('grants exactly an explicit list, whatever the edition, ignoring names it does not know', () => {
    expect(grantedFeatures({ ...PAYLOAD, features: ['audit-log', 'scim'] })).toEqual(['audit-log']);
    expect(grantedFeatures({ ...PAYLOAD, edition: 'enterprise', features: [] })).toEqual([]);
  });
});
```

- [ ] **Step 4: Run both to see them fail**

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-unit packages/server/test/unit/licensing`
Expected: FAIL, the modules do not exist.

- [ ] **Step 5: Write `format.ts` and `state.ts`**

```ts
// packages/server/src/licensing/format.ts
/**
 * Offline license verification (licensing spec §3.1, §3.2). Pure: no clock of its own, no I/O. The
 * signature covers the payload segment's text exactly as received, so nothing is re-serialised, and one
 * license line has exactly one valid signature even though base64url decoding is lenient.
 */
import { verify, type KeyObject } from 'node:crypto';
import {
  LICENSE_FORMAT,
  licensePayloadSchema,
  type LicenseInvalidReason,
  type LicensePayload,
} from '@wirebench/engine';

export type Verified =
  | { readonly ok: true; readonly license: LicensePayload }
  | { readonly ok: false; readonly reason: LicenseInvalidReason; readonly message: string };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

const malformed = (message: string): Verified => ({ ok: false, reason: 'malformed', message });

function signedBy(segment: string, signature: Buffer, publicKeys: readonly KeyObject[]): boolean {
  const data = Buffer.from(segment, 'ascii');
  return publicKeys.some((key) => {
    try {
      return verify(null, data, key, signature);
    } catch {
      return false; // a signature of the wrong length throws on some Node versions
    }
  });
}

/** Expiry is state, not validity (§3.2): a license past `expiresAt` still verifies. */
export function verifyLicense(text: string, publicKeys: readonly KeyObject[], now: Date): Verified {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_FORMAT) {
    return malformed('This is not a Wirebench license. A license is one line that starts with "wbl1.".');
  }
  const [, segment, signature] = parts as [string, string, string];
  if (!SEGMENT.test(segment) || !SEGMENT.test(signature)) {
    return malformed('The license contains characters a license never has. Paste the whole line again.');
  }
  if (!signedBy(segment, Buffer.from(signature, 'base64url'), publicKeys)) {
    return {
      ok: false,
      reason: 'bad-signature',
      message: 'The license signature does not match. It was changed, or it was not issued for Wirebench.',
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return malformed('The license payload is not readable.');
  }
  const parsed = licensePayloadSchema.safeParse(json);
  if (!parsed.success) return malformed('The license payload is not in a form this server understands.');
  const license = parsed.data;
  if (Date.parse(license.expiresAt) <= Date.parse(license.issuedAt)) {
    return malformed('The license expires before it was issued.');
  }
  if (Date.parse(license.issuedAt) > now.getTime()) {
    return {
      ok: false,
      reason: 'not-yet-valid',
      message: `The license was issued at ${license.issuedAt}, which is after this server's clock (${now.toISOString()}). Check the server clock.`,
    };
  }
  return { ok: true, license };
}
```

```ts
// packages/server/src/licensing/state.ts
/**
 * `licenseState` (licensing spec §3.3): what a stored license means right now. Pure and computed on
 * demand, never cached: every input is in memory or one cheap query, and a single-instance server has no
 * cache to keep coherent (ADR-0013).
 */
import type { KeyObject } from 'node:crypto';
import { COMMUNITY_SEATS, FEATURES, GRACE_DAYS, type Feature, type LicensePayload, type LicenseState } from '@wirebench/engine';
import { verifyLicense } from './format.js';

export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/** §2: an explicit list grants exactly those; otherwise Enterprise grants all and Team none. */
export function grantedFeatures(license: LicensePayload): Feature[] {
  if (license.features !== undefined) return FEATURES.filter((feature) => license.features!.includes(feature));
  return license.edition === 'enterprise' ? [...FEATURES] : [];
}

export function licenseState(
  stored: string | undefined,
  publicKeys: readonly KeyObject[],
  now: Date,
  seatsUsed: number,
): LicenseState {
  const community = { edition: 'community' as const, seats: { used: seatsUsed, limit: COMMUNITY_SEATS } };
  if (stored === undefined) return { ...community, status: 'none', features: [] };
  const verified = verifyLicense(stored, publicKeys, now);
  // Reported rather than treated as absent, so an admin notices a key rotation they missed (§6).
  if (!verified.ok) {
    return { ...community, status: 'invalid', features: [], reason: verified.reason, message: verified.message };
  }
  const license = verified.license;
  const expires = Date.parse(license.expiresAt);
  const facts = {
    licenseId: license.id,
    customer: license.customer,
    issuedAt: license.issuedAt,
    expiresAt: license.expiresAt,
    graceUntil: new Date(expires + GRACE_MS).toISOString(),
  };
  if (now.getTime() >= expires + GRACE_MS) return { ...community, status: 'expired', features: [], ...facts };
  return {
    edition: license.edition,
    status: now.getTime() < expires ? 'active' : 'grace',
    seats: { used: seatsUsed, limit: license.seats },
    features: grantedFeatures(license),
    ...facts,
  };
}
```

- [ ] **Step 6: Run both tests to see them pass**

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-unit packages/server/test/unit/licensing`
Expected: PASS.

- [ ] **Step 7: Generate the production key pair and write `keys.ts`**

The private key must never enter the repository. Generate it into the owner's home directory, readable only by the owner, and print only the public half:

```bash
mkdir -p "$HOME/.wirebench-license" && chmod 700 "$HOME/.wirebench-license"
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const path = require("node:path").join(process.env.HOME, ".wirebench-license", "signing-key-1.pem");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
'
```

`flag: "wx"` refuses to overwrite an existing key. If the file already exists, derive the public half from it instead with `node -e 'const c=require("node:crypto");process.stdout.write(c.createPublicKey(require("node:fs").readFileSync(process.env.HOME+"/.wirebench-license/signing-key-1.pem")).export({type:"spki",format:"pem"}))'`. Put the printed PEM into `keys.ts`:

```ts
// packages/server/src/licensing/keys.ts
/**
 * The public keys a license is verified against (licensing spec §3.2). Compiled in on purpose: there is
 * no environment variable for a key, so configuration can never mint an edition. The private half is
 * held offline by the owner and never enters this repository (ADR-0018). A rotation ships a release
 * with both keys; a retired key's constant is removed a version after the release notes announce it.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';

/** Key 1, generated 2026-10-02. */
const KEY_1 = `-----BEGIN PUBLIC KEY-----
<the 44-character base64 line printed by the command above>
-----END PUBLIC KEY-----
`;

export const PRODUCTION_PUBLIC_KEYS: readonly KeyObject[] = [createPublicKey(KEY_1)];
```

The angle-bracketed line is the command's output, pasted. It is not a value to invent.

- [ ] **Step 8: Prove the production key loads**

Add to `format.test.ts`:

```ts
import { PRODUCTION_PUBLIC_KEYS } from '../../../src/licensing/keys.js';

it('ships one Ed25519 production key, which a test key does not satisfy', () => {
  expect(PRODUCTION_PUBLIC_KEYS).toHaveLength(1);
  expect(PRODUCTION_PUBLIC_KEYS[0]!.asymmetricKeyType).toBe('ed25519');
  expect(verifyLicense(license(keys), PRODUCTION_PUBLIC_KEYS, NOW)).toMatchObject({ reason: 'bad-signature' });
});
```

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-unit packages/server/test/unit/licensing`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run `git status` and confirm that no `.pem` file is staged or untracked in the repository. Then run `WIREBENCH_SKIP_PERF=1 pnpm check`.

```bash
git add packages/server/src/licensing/format.ts packages/server/src/licensing/state.ts packages/server/src/licensing/keys.ts packages/server/test/helpers/licensing.ts packages/server/test/unit/licensing
git commit -m "feat(server): offline license verification and state, with the production public key (#197)"
```

### Task 3: The licensing module: table, service, gate, endpoints and `/meta`

**Files:**
- Create: `packages/server/migrations/licensing/0007_licensing.sql`
- Create: `packages/server/src/licensing/errors.ts`, `repo.ts`, `seats.ts`, `gate.ts`, `service.ts`, `routes.ts` and `module.ts`
- Modify: `packages/server/src/context.ts`, `src/modules.ts`, `src/serve.ts` (the `ctx` literal near line 188) and `src/routes/meta.ts`
- Modify: `packages/server/test/helpers/context.ts`, `test/helpers/licensing.ts`, `test/unit/server.test.ts:67-79`, `test/unit/live/module.test.ts:11-18`, `test/integration/hooks/repo.test.ts:33-40` and `test/integration/teams/migration.test.ts:21-28`
- Test: `packages/server/test/unit/licensing/gate.test.ts` and `test/integration/licensing/routes.test.ts`

**Interfaces:**
- Consumes from Task 2: `verifyLicense`, `licenseState`, `PRODUCTION_PUBLIC_KEYS`, and the test helpers.
- Produces in `context.ts`:
  - The `LicenseService` interface: `state(tx?: Querier): Promise<LicenseState>`, `assertSeatAvailable(tx: Querier): Promise<void>` and `requireFeature(feature: Feature): preHandlerAsyncHookHandler`.
  - `LicenseChanged`: `{ action: 'installed' | 'removed'; licenseId?: string; edition?: Edition; actorUserId: string | null }`.
  - `permissiveLicense(): LicenseService`, plus `ServerContext.license` (mutable), `ServerHooks.licenseChanged` and `'licensing'` in `ServerModule.name`.
- Produces in `licensing/`:
  - `createLicenseService(env: { db: Querier; publicKeys: readonly KeyObject[]; now: () => Date }): LicenseService`.
  - `installLicense(env, text: string, actorUserId: string | null): Promise<LicenseChanged>` and `removeLicense(env: { db: Querier }, actorUserId: string | null): Promise<LicenseChanged | undefined>`.
  - `countEnabledUsers(db: Querier): Promise<number>` and `licensingModule(options?: { now?: () => Date; publicKeys?: readonly KeyObject[] }): ServerModule`.
  - Problems: `seatLimit(state: LicenseState)`, `featureRequired(feature: Feature)` and `licenseInvalid(message: string)`.
- Produces in the test helpers: `licensingHarness(keys: TestKeys, options?): Promise<IdentityHarness>`.

- [ ] **Step 1: Context plumbing**

In `packages/server/src/context.ts`:

1. Add the imports `import type { preHandlerAsyncHookHandler } from 'fastify';` and `import type { Edition, Feature, LicenseState } from '@wirebench/engine';`, plus the runtime import `import { requireFeature } from './licensing/gate.js';`. `gate.ts` imports only types from `context.ts`, so there is no runtime cycle.
2. Above `ServerHooks`, add:

```ts
/** A license was installed or removed (licensing spec §3.9); fired after the statement that stored or deleted it. */
export interface LicenseChanged {
  readonly action: 'installed' | 'removed';
  readonly licenseId?: string;
  readonly edition?: Edition;
  /** `null` from the command line, which has no user. */
  readonly actorUserId: string | null;
}

/**
 * The server's license (licensing spec §5.1). Read at request time, never at registration: identity
 * registers before licensing replaces the host's permissive default.
 */
export interface LicenseService {
  /** Computed on demand from the stored row, the clock and one count (§3.3). Pass `tx` inside a transaction. */
  state(tx?: Querier): Promise<LicenseState>;
  /** Inside the caller's transaction: refuses with `licensing-seat-limit` when no seat is free (§3.4). */
  assertSeatAvailable(tx: Querier): Promise<void>;
  /** A preHandler for after a route's role guard: `licensing-feature-required` without the feature (§3.5). */
  requireFeature(feature: Feature): preHandlerAsyncHookHandler;
}

/**
 * What a server without the licensing module has: unlimited seats and no features. Tests that register
 * identity alone keep it, so identity's suites do not depend on licensing.
 */
export function permissiveLicense(): LicenseService {
  const state = (): Promise<LicenseState> =>
    Promise.resolve({ edition: 'community', status: 'none', seats: { used: 0, limit: null }, features: [] });
  return {
    state,
    assertSeatAvailable: () => Promise.resolve(),
    requireFeature: (feature) => requireFeature(feature, state),
  };
}
```

3. Add `readonly licenseChanged: Announcement<LicenseChanged>[];` to `ServerHooks`, and `licenseChanged: [],` to `serverHooks()`. Extend the doc comment's announcement list with `licenseChanged` (licensing spec §3.9).
4. Add the field to `ServerContext`:

```ts
  /** Replaced by the licensing module in `register()`; the one field a module may assign (licensing spec §5.1). */
  license: LicenseService;
```

5. Change `ServerModule.name` to `'identity' | 'licensing' | 'teams-access' | 'server-sync' | 'webhook-capture' | 'ci-tokens' | 'live-updates'`.

Then add `license: permissiveLicense(),` to the `ctx` literal in `src/serve.ts` and to the object `testContext` returns in `test/helpers/context.ts`, before `...rest`. Import `permissiveLicense` in both.

- [ ] **Step 2: Write the gate's failing unit test**

```ts
// packages/server/test/unit/licensing/gate.test.ts
import Fastify from 'fastify';
import type { LicenseState } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { permissiveLicense } from '../../../src/context.js';
import { requireFeature } from '../../../src/licensing/gate.js';
import { toProblem } from '../../../src/problem.js';

const community: LicenseState = { edition: 'community', status: 'none', seats: { used: 1, limit: 5 }, features: [] };

async function probe(state: () => Promise<LicenseState>) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const mapped = toProblem(error);
    return reply.code(mapped.status).send(mapped.body);
  });
  app.get('/probe', { preHandler: requireFeature('audit-log', state) }, () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/probe' });
  await app.close();
  return res;
}

describe('requireFeature (licensing spec §3.5)', () => {
  it('refuses with 403 licensing-feature-required, naming the feature, when it is not granted', async () => {
    const res = await probe(() => Promise.resolve(community));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
    expect(res.json<{ message: string }>().message).toContain('audit-log');
  });

  it('passes when the state grants it', async () => {
    const res = await probe(() => Promise.resolve({ ...community, edition: 'enterprise', features: ['audit-log'] }));
    expect(res.statusCode).toBe(200);
  });

  it('reads the state on every request, so a new license applies with no restart', async () => {
    let features: LicenseState['features'] = [];
    const app = Fastify();
    app.get('/probe', { preHandler: requireFeature('audit-log', () => Promise.resolve({ ...community, features })) }, () => ({}));
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(403);
    features = ['audit-log'];
    expect((await app.inject({ method: 'GET', url: '/probe' })).statusCode).toBe(200);
    await app.close();
  });

  it('the permissive default grants no feature and never refuses a seat', async () => {
    const license = permissiveLicense();
    await expect(license.assertSeatAvailable({} as never)).resolves.toBeUndefined();
    const res = await probe(() => license.state());
    expect(res.statusCode).toBe(403);
  });
});
```

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-unit packages/server/test/unit/licensing/gate.test.ts`
Expected: FAIL, `gate.js` does not exist.

- [ ] **Step 3: Write errors, gate, repo, seats and service**

```ts
// packages/server/src/licensing/errors.ts
/** Every `licensing-*` problem (licensing spec §3.4–§3.6). None ever carries the license text. */
import type { Feature, LicenseState, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

const LABEL = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;

/** Says how many seats are used and allowed, and which edition would lift the limit (§3.4). */
export const seatLimit = (state: LicenseState): WirebenchError =>
  problem(
    'licensing-seat-limit',
    `This server has ${state.seats.used} enabled accounts and its ${LABEL[state.edition]} edition allows ${String(state.seats.limit)}. ` +
      (state.edition === 'community'
        ? 'A Team or Enterprise license lifts the limit, or a server admin can disable an account.'
        : 'A license with more seats lifts the limit, or a server admin can disable an account.'),
    409,
  );

/** The host's problem body is `{ code, message }`, so the feature is named in the message (plan ruling 4). */
export const featureRequired = (feature: Feature): WirebenchError =>
  problem(
    'licensing-feature-required',
    `This needs a license that includes "${feature}", which the Enterprise edition does.`,
    403,
  );

export const licenseInvalid = (message: string): WirebenchError => problem('licensing-invalid', message, 400);
```

```ts
// packages/server/src/licensing/gate.ts
/**
 * The feature gate (licensing spec §3.5). Registered after a route's role guard, so an unauthenticated
 * or forbidden caller hears the guard first. It reads the state at request time: an installed license
 * takes effect on the next request.
 */
import type { preHandlerAsyncHookHandler } from 'fastify';
import type { Feature, LicenseState } from '@wirebench/engine';
import { featureRequired } from './errors.js';

export function requireFeature(feature: Feature, state: () => Promise<LicenseState>): preHandlerAsyncHookHandler {
  return async () => {
    if (!(await state()).features.includes(feature)) throw featureRequired(feature);
  };
}
```

```ts
// packages/server/src/licensing/repo.ts
/** The one-row `license` table (licensing spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { Querier } from '../context.js';

export interface StoredLicenseRow {
  /** The text as installed; re-verified on every read, so a later version applies its own keys and schema. */
  readonly text: string;
  readonly licenseId: string;
  readonly installedBy: string | null;
  readonly installedAt: string;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export async function storedLicense(db: Querier): Promise<StoredLicenseRow | undefined> {
  const raw = (
    await db.query<Raw>(
      `select text, license_id as "licenseId", installed_by as "installedBy", installed_at as "installedAt" from license`,
    )
  ).rows[0];
  if (raw === undefined) return undefined;
  const at = raw['installedAt'];
  return {
    text: text(raw['text']) ?? '',
    licenseId: text(raw['licenseId']) ?? '',
    installedBy: text(raw['installedBy']),
    installedAt: at instanceof Date ? at.toISOString() : (text(at) ?? ''),
  };
}

/** Replaces any stored license (§3.6). */
export async function putLicense(
  db: Querier,
  input: { readonly text: string; readonly licenseId: string; readonly installedBy: string | null; readonly at: Date },
): Promise<void> {
  await db.query(
    `insert into license (singleton, text, license_id, installed_by, installed_at) values (true, $1, $2, $3, $4)
     on conflict (singleton) do update set text = excluded.text, license_id = excluded.license_id,
       installed_by = excluded.installed_by, installed_at = excluded.installed_at`,
    [input.text, input.licenseId, input.installedBy, input.at],
  );
}

/** `false` when nothing was stored. */
export async function deleteLicense(db: Querier): Promise<boolean> {
  return ((await db.query('delete from license')).rowCount ?? 0) > 0;
}
```

```ts
// packages/server/src/licensing/seats.ts
/**
 * Seat enforcement (licensing spec §3.4). A seat is an enabled account: every user whose `disabled_at`
 * is null, server admins included. The check takes one transaction-scoped advisory lock before it
 * counts, so two acceptances racing for the last seat are serialised and the second sees the first's
 * user (plan ruling 5). A downgrade never disables anyone: this only refuses a new or restored account.
 */
import type { LicenseState } from '@wirebench/engine';
import type { Querier } from '../context.js';
import { seatLimit } from './errors.js';

/** A fixed key ("WBL1") that every seat check locks on; released when the caller's transaction ends. */
export const SEAT_LOCK_KEY = 0x57424c31;

export async function countEnabledUsers(db: Querier): Promise<number> {
  const rows = (await db.query<{ count: number }>('select count(*)::int as count from users where disabled_at is null')).rows;
  return Number(rows[0]?.count ?? 0);
}

export async function assertSeatAvailable(tx: Querier, state: (tx: Querier) => Promise<LicenseState>): Promise<void> {
  await tx.query('select pg_advisory_xact_lock($1)', [SEAT_LOCK_KEY]);
  const current = await state(tx);
  if (current.seats.limit !== null && current.seats.used >= current.seats.limit) throw seatLimit(current);
}
```

```ts
// packages/server/src/licensing/service.ts
/**
 * The license service and the two writes (licensing spec §3.6, §3.7, §5.1). The endpoints and the
 * command line both call `installLicense` and `removeLicense`, so they can never disagree.
 */
import type { KeyObject } from 'node:crypto';
import type { LicenseChanged, LicenseService, Querier } from '../context.js';
import { licenseInvalid } from './errors.js';
import { verifyLicense } from './format.js';
import { requireFeature } from './gate.js';
import * as repo from './repo.js';
import { assertSeatAvailable, countEnabledUsers } from './seats.js';
import { licenseState } from './state.js';

export interface LicenseEnv {
  readonly db: Querier;
  readonly publicKeys: readonly KeyObject[];
  readonly now: () => Date;
}

export function createLicenseService(env: LicenseEnv): LicenseService {
  const state = async (tx: Querier = env.db) =>
    licenseState((await repo.storedLicense(tx))?.text, env.publicKeys, env.now(), await countEnabledUsers(tx));
  return {
    state,
    assertSeatAvailable: (tx) => assertSeatAvailable(tx, state),
    requireFeature: (feature) => requireFeature(feature, () => state()),
  };
}

/**
 * Verifies first: a file that fails is not stored, so a broken paste can never replace a working
 * license (§3.6). An expired but genuine license is stored; it is reported as grace or expired.
 */
export async function installLicense(env: LicenseEnv, text: string, actorUserId: string | null): Promise<LicenseChanged> {
  const trimmed = text.trim();
  const verified = verifyLicense(trimmed, env.publicKeys, env.now());
  if (!verified.ok) throw licenseInvalid(verified.message);
  await repo.putLicense(env.db, { text: trimmed, licenseId: verified.license.id, installedBy: actorUserId, at: env.now() });
  return { action: 'installed', licenseId: verified.license.id, edition: verified.license.edition, actorUserId };
}

/** `undefined` when no license was stored: nothing changed, so nothing is announced. */
export async function removeLicense(
  env: { readonly db: Querier },
  actorUserId: string | null,
): Promise<LicenseChanged | undefined> {
  const stored = await repo.storedLicense(env.db);
  if (stored === undefined || !(await repo.deleteLicense(env.db))) return undefined;
  return { action: 'removed', licenseId: stored.licenseId, actorUserId };
}
```

Run the gate test again. Expected: PASS.

- [ ] **Step 4: Write the migration**

```sql
-- packages/server/migrations/licensing/0007_licensing.sql
-- Wirebench Server 0007: the license (licensing spec §4.2). One row at most, enforced by the singleton
-- key. The raw text is stored, not parsed fields, so a later server version re-verifies it with its
-- own keys and schema. license_id is kept beside it for the audit log and `admin license show`.
create table license (
  singleton    boolean primary key default true check (singleton),
  text         text not null,
  license_id   text not null,
  installed_by text references users on delete set null,
  installed_at timestamptz not null default now()
);
```

- [ ] **Step 5: Write the routes and the module**

```ts
// packages/server/src/licensing/routes.ts
/** `GET`, `PUT` and `DELETE /license` (licensing spec §3.6): server admins only. */
import {
  licenseInstallRequestSchema,
  licenseStateSchema,
  type LicenseInstallRequest,
  type LicenseState,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce, type LicenseService, type ServerHooks } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { rateLimit, type RateLimiter } from '../identity/rate-limit.js';
import { jsonSchema } from '../schema.js';
import { installLicense, removeLicense, type LicenseEnv } from './service.js';

export interface LicenseRoutesEnv extends LicenseEnv {
  readonly service: LicenseService;
  readonly hooks: ServerHooks;
  /** PUT carries a signature check, so it is rate-limited as identity's attempts are (§3.6). */
  readonly limiter: RateLimiter;
}

export const licenseRoutes =
  (env: LicenseRoutesEnv) =>
  (app: FastifyInstance): void => {
    const state = jsonSchema(licenseStateSchema);

    app.get(
      '/license',
      { preHandler: requireServerAdmin, schema: { response: { 200: state } } },
      (): Promise<LicenseState> => env.service.state(),
    );

    app.put(
      '/license',
      {
        preHandler: [requireServerAdmin, rateLimit(env, (request) => [`license:${request.caller?.id ?? request.ip}`])],
        schema: { body: jsonSchema(licenseInstallRequestSchema, { io: 'input' }), response: { 200: state } },
      },
      async (request): Promise<LicenseState> => {
        const { license } = request.body as LicenseInstallRequest;
        const changed = await installLicense(env, license, request.caller!.id);
        // The text is never logged; the id is (§6).
        request.log.info({ licenseId: changed.licenseId }, 'license installed');
        announce(env.hooks.licenseChanged, changed, request.log);
        return env.service.state();
      },
    );

    app.delete('/license', { preHandler: requireServerAdmin }, async (request, reply) => {
      const changed = await removeLicense(env, request.caller!.id);
      if (changed !== undefined) {
        request.log.info({ licenseId: changed.licenseId }, 'license removed');
        announce(env.hooks.licenseChanged, changed, request.log);
      }
      return reply.code(204).send();
    });
  };
```

```ts
// packages/server/src/licensing/module.ts
/**
 * The `licensing` ServerModule (licensing spec §5.1). Registered right after identity, so its routes
 * sit behind identity's `onRequest` guard. It replaces the host's permissive `ctx.license`; identity's
 * handlers read `ctx.license` at request time, so the order of the two matters only for routes.
 */
import type { KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { RateLimiter } from '../identity/rate-limit.js';
import { PRODUCTION_PUBLIC_KEYS } from './keys.js';
import { licenseRoutes } from './routes.js';
import { createLicenseService } from './service.js';

export const LICENSING_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/licensing/', import.meta.url));

export interface LicensingOptions {
  /** Injected clock: expiry, grace and `installed_at`. */
  readonly now?: () => Date;
  /** Test keys. Production passes nothing and gets the compiled-in keys; there is no configuration for this. */
  readonly publicKeys?: readonly KeyObject[];
}

export function licensingModule(options: LicensingOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const publicKeys = options.publicKeys ?? PRODUCTION_PUBLIC_KEYS;
  return {
    name: 'licensing',
    migrationsDir: LICENSING_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const service = createLicenseService({ db: ctx.db, publicKeys, now });
      ctx.license = service;
      licenseRoutes({
        db: ctx.db,
        publicKeys,
        now,
        service,
        hooks: ctx.hooks,
        limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
      })(app);
    },
  };
}
```

In `src/modules.ts`, import `licensingModule` and insert `licensingModule(),` right after `identityModule(),`. Add this sentence to the doc comment: "licensing comes right after identity: its routes need identity's guard, and identity's seat checks read `ctx.license` at request time."

In `src/routes/meta.ts`, make the handler async and add the edition:

```ts
    app.get('/meta', { schema: { response: { 200: jsonSchema(metaResponseSchema) } } }, async () => {
      const hooks = ctx.meta.hooks();
      // licensing §3.6: the edition, and nothing else about the license, is public.
      const { edition } = await ctx.license.state();
      return {
        name: SERVER_NAME,
        version: ctx.config.version,
        apiVersion: SERVER_API_VERSION,
        publicUrl: ctx.config.publicUrl,
        auth: ctx.meta.signInMethods(),
        capabilities: ctx.meta.capabilities(),
        ...(hooks !== undefined ? { hooks } : {}),
        edition,
      };
    });
```

Update the existing order assertions:
- In `test/unit/live/module.test.ts`, `test/integration/hooks/repo.test.ts` and `test/integration/teams/migration.test.ts`, insert `'licensing',` after `'identity',` in each expected `BUILTIN_MODULES` list.
- In `test/unit/server.test.ts`, add `edition: 'community',` to the expected `/api/v1/meta` body.

- [ ] **Step 6: Add the harness and write the failing route test**

Append to `packages/server/test/helpers/licensing.ts`:

```ts
import type { ServerModule } from '../../src/context.js';
import { licensingModule } from '../../src/licensing/module.js';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { identityHarness, type IdentityHarness, type TestClock } from './identity.js';

/** Identity, then licensing with the test key, then any `extra` modules, all on the harness clock. */
export function licensingHarness(
  keys: TestKeys,
  options: {
    readonly env?: Record<string, string>;
    readonly provider?: OidcProvider;
    readonly extra?: (clock: TestClock) => readonly ServerModule[];
  } = {},
): Promise<IdentityHarness> {
  return identityHarness({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    modules: (clock) => [
      licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
      ...(options.extra?.(clock) ?? []),
    ],
  });
}
```

Move these imports to the top of the file with the others.

```ts
// packages/server/test/integration/licensing/routes.test.ts
import type { LicenseState } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import type { LicenseChanged, ServerModule } from '../../../src/context.js';
import { requireServerAdmin } from '../../../src/identity/guard.js';
import * as repo from '../../../src/licensing/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, PAYLOAD, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const keys = testKeys();
const other = testKeys();
const DAY = 24 * 60 * 60 * 1000;

/** A route behind the gate, as the audit log will register one (§3.5); the name is only Fastify's label. */
const probe: ServerModule = {
  name: 'gate-probe' as ServerModule['name'],
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
  async register(app, ctx) {
    app.get('/probe', { preHandler: [requireServerAdmin, ctx.license.requireFeature('audit-log')] }, () => ({ ok: true }));
  },
};

let h: IdentityHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setUp(): Promise<{ h: IdentityHarness; admin: SignedInUser; member: SignedInUser; events: LicenseChanged[] }> {
  h = await licensingHarness(keys, { extra: () => [probe] });
  const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
  const member = await signedInUser(h, { email: 'member@example.com' });
  const events: LicenseChanged[] = [];
  h.hooks.licenseChanged.push((event) => events.push(event));
  return { h, admin, member, events };
}

describeDb('the license endpoints (licensing spec §3.6, §13)', () => {
  it('a fresh server is Community with five seats, and /meta says so', async () => {
    const { h, admin } = await setUp();
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toEqual({
      edition: 'community',
      status: 'none',
      seats: { used: 2, limit: 5 },
      features: [],
    });
    expect((await call<{ edition: string }>(h, undefined, 'GET', '/meta')).body.edition).toBe('community');
  });

  it('only a server admin reads, installs or removes', async () => {
    const { h, member } = await setUp();
    expect((await call(h, member, 'GET', '/license')).status).toBe(403);
    expect((await call(h, member, 'PUT', '/license', { license: license(keys) })).status).toBe(403);
    expect((await call(h, member, 'DELETE', '/license')).status).toBe(403);
    expect((await call(h, undefined, 'GET', '/license')).status).toBe(401);
  });

  it('installs a valid license, answers the new state, announces it, and /meta shows only the edition', async () => {
    const { h, admin, events } = await setUp();
    const put = await call<LicenseState>(h, admin, 'PUT', '/license', { license: `${license(keys)}\n` });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ edition: 'team', status: 'active', seats: { used: 2, limit: 50 }, licenseId: PAYLOAD.id });
    expect(events).toEqual([{ action: 'installed', licenseId: PAYLOAD.id, edition: 'team', actorUserId: admin.user.id }]);
    const meta = (await call<Record<string, unknown>>(h, undefined, 'GET', '/meta')).body;
    expect(meta['edition']).toBe('team');
    expect(JSON.stringify(meta)).not.toContain(PAYLOAD.id);
    expect(JSON.stringify(meta)).not.toContain('Example AG');
    expect((await repo.storedLicense(h.db))?.installedBy).toBe(admin.user.id);
  });

  it('refuses an invalid file without touching the stored license', async () => {
    const { h, admin, events } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    events.length = 0;
    for (const bad of [license(other), 'hello', license(keys).replace(/^wbl1/, 'wbl9')]) {
      const res = await call<{ code: string }>(h, admin, 'PUT', '/license', { license: bad });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('licensing-invalid');
    }
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({ edition: 'team', status: 'active' });
    expect(events).toEqual([]);
  });

  it('removes the license; the server is Community on the next request', async () => {
    const { h, admin, events } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body.status).toBe('none');
    expect(events.at(-1)).toEqual({ action: 'removed', licenseId: PAYLOAD.id, actorUserId: admin.user.id });
    events.length = 0;
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    expect(events).toEqual([]); // nothing was stored, so nothing changed
  });

  it('reports a stored license that no longer verifies as invalid, and the server as Community', async () => {
    const { h, admin } = await setUp();
    await repo.putLicense(h.db, { text: license(other), licenseId: PAYLOAD.id, installedBy: null, at: h.clock.now });
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({
      edition: 'community',
      status: 'invalid',
      reason: 'bad-signature',
    });
  });

  it('moves through grace to expired on the clock alone, and nobody is signed out', async () => {
    const { h, admin, member } = await setUp();
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    h.clock.set(new Date(Date.parse(PAYLOAD.expiresAt) + DAY));
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({ edition: 'team', status: 'grace' });
    h.clock.set(new Date(Date.parse(PAYLOAD.expiresAt) + 31 * DAY));
    expect((await call<LicenseState>(h, admin, 'GET', '/license')).body).toMatchObject({
      edition: 'community',
      status: 'expired',
    });
    expect((await call(h, member, 'GET', '/me')).status).toBe(200);
  });

  it('gates a feature: 403 on Community and Team, 200 on Enterprise or an explicit list, 403 again after removal', async () => {
    const { h, admin } = await setUp();
    const probeAs = async () => (await call<{ code?: string }>(h, admin, 'GET', '/probe')).status;
    expect(await probeAs()).toBe(403);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect(await probeAs()).toBe(403);
    await call(h, admin, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(await probeAs()).toBe(200);
    await call(h, admin, 'PUT', '/license', { license: license(keys, { features: ['audit-log'] }) });
    expect(await probeAs()).toBe(200);
    await call(h, admin, 'DELETE', '/license');
    expect(await probeAs()).toBe(403);
  });

  it('answers the role guard before the gate', async () => {
    const { h, member } = await setUp();
    expect((await call<{ code: string }>(h, member, 'GET', '/probe')).body.code).toBe('identity-forbidden');
  });

  it('rate-limits installs per admin', async () => {
    const { h, admin } = await setUp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await call(h, admin, 'PUT', '/license', { license: 'hello' })).status);
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('never logs the license text', async () => {
    const lines: string[] = [];
    const { Writable } = await import('node:stream');
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const { identityHarness } = await import('../../helpers/identity.js');
    const { licensingModule } = await import('../../../src/licensing/module.js');
    h = await identityHarness({
      env: { WIREBENCH_SERVER_LOG_LEVEL: 'info' },
      logStream,
      modules: (clock) => [licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] })],
    });
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    const text = license(keys);
    await call(h, admin, 'PUT', '/license', { license: text });
    const [, segment] = text.split('.');
    expect(lines.join('')).toContain(PAYLOAD.id);
    expect(lines.join('')).not.toContain(segment);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @wirebench/server test`. The integration tests need `WIREBENCH_SERVER_TEST_DATABASE_URL`; start the database with `docker compose -f packages/server/compose.yaml up -d db` and export the URL the README gives.
Expected: PASS, including the edited order and `/meta` assertions.

- [ ] **Step 8: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add packages/server/migrations/licensing packages/server/src/licensing packages/server/src/context.ts packages/server/src/modules.ts packages/server/src/serve.ts packages/server/src/routes/meta.ts packages/server/test
git commit -m "feat(server): the licensing module — license endpoints, feature gate and the edition in /meta (#197)"
```

### Task 4: Seat enforcement at the four entry points

**Files:**
- Modify: `packages/server/src/identity/env.ts` (`InvitationEnv.ctx`)
- Modify: `packages/server/src/identity/invitations.ts` (`createInvitation`, `acceptInvitation`)
- Modify: `packages/server/src/identity/linking.ts` (`LinkRefusal`, the `create` branch of `linkClaims`)
- Modify: `packages/server/src/identity/routes/users.ts` (`PATCH /users/:id`)
- Modify: `packages/server/src/identity/cli.ts` (the CLI's `ctx` gets a real license service)
- Modify: `packages/server/test/integration/identity/invitations.test.ts:215-219` and `test/integration/identity/oidc.test.ts:35-40` (their hand-built `ctx` gains `license`)
- Test: `packages/server/test/integration/licensing/seats.test.ts`

**Interfaces:**
- Consumes from Task 3: `ServerContext.license`, `LicenseService.assertSeatAvailable(tx)`, `createLicenseService`, `permissiveLicense`, `PRODUCTION_PUBLIC_KEYS`, `licensingHarness` and `license`.
- Produces:
  - `LinkRefusal` gains `'licensing-seat-limit'`.
  - `InvitationEnv.ctx` is `Pick<ServerContext, 'db' | 'config' | 'hooks' | 'license'>`.
  - `runAdmin(command, io, options?: { now?: () => Date; publicKeys?: readonly KeyObject[] })`.

- [ ] **Step 1: Write the failing seat test**

```ts
// packages/server/test/integration/licensing/seats.test.ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as identityRepo from '../../../src/identity/repo.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const keys = testKeys();
const PASSWORD = 'correct horse battery staple';
const secretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

let h: IdentityHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A server admin plus `members` more enabled accounts. */
async function withAccounts(members: number): Promise<{ h: IdentityHarness; admin: SignedInUser; users: SignedInUser[] }> {
  h = await licensingHarness(keys);
  const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
  const users: SignedInUser[] = [];
  for (let i = 1; i <= members; i += 1) users.push(await signedInUser(h, { email: `user${i}@example.com` }));
  return { h, admin, users };
}

const accept = (harness: IdentityHarness, url: string, name: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/invitations/accept',
    payload: { secret: secretOf(url), displayName: name, password: PASSWORD, device: { name: 'laptop' } },
  });

describeDb('seats on Community (licensing spec §3.4, §13.1)', () => {
  it('the fifth enabled account gets in; the sixth invitation is refused before the invitee hears of it', async () => {
    const { h, admin } = await withAccounts(3);
    const fifth = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'fifth@example.com' });
    expect(fifth.status).toBe(201);
    expect((await accept(h, fifth.body.url, 'Fifth')).statusCode).toBe(201);
    const sixth = await call<{ code: string; message: string }>(h, admin, 'POST', '/invitations', { email: 'sixth@example.com' });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('licensing-seat-limit');
    expect(sixth.body.message).toContain('5 enabled accounts');
    expect(sixth.body.message).toContain('Community');
  });

  it('a team invitation counts the same way', async () => {
    const { h, admin } = await withAccounts(4);
    // teams-access is not registered here: the shared createInvitation, which a team invitation calls, refuses.
    const { createInvitation } = await import('../../../src/identity/invitations.js');
    const { identitySettings } = await import('../../../src/identity/env.js');
    const { loadConfig } = await import('../../../src/config.js');
    const { createLicenseService } = await import('../../../src/licensing/service.js');
    const config = loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: h.db.url,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: h.dataDir,
      },
      '0.0.0-test',
    );
    const env = {
      ctx: {
        db: h.db,
        config,
        hooks: h.hooks,
        license: createLicenseService({ db: h.db, publicKeys: [keys.publicKey], now: () => h.clock.now }),
      },
      settings: identitySettings(config),
      now: () => h.clock.now,
    };
    let attached = false;
    await expect(
      createInvitation(env, { email: 'team@example.com', serverAdmin: false, createdBy: admin.user.id }, () => {
        attached = true;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: 'licensing-seat-limit' });
    expect(attached).toBe(false);
  });

  it('an acceptance at the limit is refused and the invitation stays open, so it goes through once a seat frees', async () => {
    const { h, admin, users } = await withAccounts(3);
    const invited = await call<{ id: string; url: string }>(h, admin, 'POST', '/invitations', { email: 'late@example.com' });
    await signedInUser(h, { email: 'filler@example.com' }); // the fifth seat goes to someone else first
    const refused = await accept(h, invited.body.url, 'Late');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('licensing-seat-limit');
    expect((await identityRepo.invitationById(h.db, invited.body.id))?.acceptedAt).toBeNull();

    expect((await call(h, admin, 'PATCH', `/users/${users[0]!.user.id}`, { disabled: true })).status).toBe(200);
    expect((await accept(h, invited.body.url, 'Late')).statusCode).toBe(201);
  });

  it('re-enabling an account is refused at the limit; re-saving an enabled one is not', async () => {
    const { h, admin, users } = await withAccounts(4);
    const parked = await signedInUser(h, { email: 'parked@example.com', disabled: true });
    const refused = await call<{ code: string }>(h, admin, 'PATCH', `/users/${parked.user.id}`, { disabled: false });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('licensing-seat-limit');
    expect((await identityRepo.findUserById(h.db, parked.user.id))?.disabledAt).not.toBeNull();
    expect((await call(h, admin, 'PATCH', `/users/${users[0]!.user.id}`, { disabled: false })).status).toBe(200);
  });

  it('a password reset never counts', async () => {
    const { h, admin, users } = await withAccounts(4);
    const reset = await call<{ url: string }>(h, admin, 'POST', `/users/${users[0]!.user.id}/password-reset`);
    expect(reset.status).toBe(201);
    expect((await accept(h, reset.body.url, 'ignored')).statusCode).toBe(201);
  });

  it('over the limit after a downgrade, nobody is disabled and only new accounts are refused', async () => {
    const { h, admin } = await withAccounts(3);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    for (let i = 0; i < 6; i += 1) await signedInUser(h, { email: `extra${i}@example.com` });
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    const users = await identityRepo.listUsers(h.db);
    expect(users.filter((user) => user.disabledAt === null)).toHaveLength(10);
    expect((await call(h, admin, 'GET', '/me')).status).toBe(200);
    expect((await call<{ code: string }>(h, admin, 'POST', '/invitations', { email: 'new@example.com' })).body.code).toBe(
      'licensing-seat-limit',
    );
  });

  it('a Team license lifts the cap on the next request', async () => {
    const { h, admin } = await withAccounts(4);
    expect((await call(h, admin, 'POST', '/invitations', { email: 'sixth@example.com' })).status).toBe(409);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect((await call(h, admin, 'POST', '/invitations', { email: 'sixth@example.com' })).status).toBe(201);
  });

  it('two acceptances racing for the last seat admit exactly one', async () => {
    const { h, admin } = await withAccounts(3);
    const first = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'first@example.com' });
    const second = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'second@example.com' });
    const results = await Promise.all([accept(h, first.body.url, 'First'), accept(h, second.body.url, 'Second')]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const enabled = (await identityRepo.listUsers(h.db)).filter((user) => user.disabledAt === null);
    expect(enabled).toHaveLength(5);
  });
});

describeDb('the first OIDC sign-in counts a seat (licensing spec §3.4)', () => {
  let idp: FakeOidcIssuer;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
  });
  afterEach(async () => {
    await idp.close();
  });

  it('redirects to the loopback with licensing-seat-limit and leaves the invitation open', async () => {
    h = await licensingHarness(keys, {
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    for (let i = 1; i <= 3; i += 1) await signedInUser(h, { email: `user${i}@example.com` });
    const invited = await call<{ id: string }>(h, admin, 'POST', '/invitations', { email: 'alice@example.com' });
    expect(invited.status).toBe(201);
    await signedInUser(h, { email: 'filler@example.com' });

    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' });
    const started = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge('v'.repeat(43)), loopbackPort: 49152 },
    });
    const { authorizationUrl } = started.json<{ authorizationUrl: string }>();
    const back = await idp.authorize(authorizationUrl);
    const callback = await h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    expect(callback.statusCode).toBe(302);
    expect(new URL(String(callback.headers['location'])).searchParams.get('error')).toBe('licensing-seat-limit');
    expect((await identityRepo.invitationById(h.db, invited.body.id))?.acceptedAt).toBeNull();
    expect(await identityRepo.findUserByEmail(h.db, 'alice@example.com')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-integration packages/server/test/integration/licensing/seats.test.ts`
Expected: FAIL. The sixth invitation answers 201, and the race admits both.

- [ ] **Step 3: Add the checks**

`src/identity/env.ts`:

```ts
export interface InvitationEnv {
  readonly ctx: Pick<ServerContext, 'db' | 'config' | 'hooks' | 'license'>;
```

`src/identity/invitations.ts`, in `createInvitation`'s transaction, before `insertInvitation`:

```ts
    row = await env.ctx.db.transaction(async (tx) => {
      // licensing §3.4: refused here, so the admin learns before the invitee does. Every caller shares
      // this function: POST /invitations, a team invitation, and `admin invite`.
      await env.ctx.license.assertSeatAvailable(tx);
      await repo.revokeExpiredInvitesOf(tx, lower, now);
```

`acceptInvitation`, in the `invite` branch, right after the `userExists` check:

```ts
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    // licensing §3.4: after the claim, so a refusal rolls the claim back and the invitation stays open.
    // A reset (the branch above) never counts: it changes nothing about who is enabled.
    await env.ctx.license.assertSeatAvailable(tx);
```

`src/identity/linking.ts`:

```ts
import { isWirebenchError } from '@wirebench/engine';

export type LinkRefusal =
  'identity-user-disabled' | 'identity-email-unverified' | 'identity-not-invited' | 'licensing-seat-limit';
```

In the `create` case, call the check after `repo.acceptInvitation` claims the row and before `insertUser`. Wrap the transaction so the refusal becomes a loopback code:

```ts
    case 'create': {
      const email = claims.email!;
      const displayName = claims.name?.trim() || (email.split('@')[0] ?? email);
      let user: repo.UserRow | undefined;
      try {
        // Claim the invitation first, as the local accept does: two concurrent first sign-ins race
        // on that single conditional UPDATE, and the loser creates nothing.
        user = await db.transaction(async (tx) => {
          if (!(await repo.acceptInvitation(tx, decision.invitationId, now))) return undefined;
          // licensing §3.4: a refusal rolls the claim back, so the invitation stays open.
          await env.ctx.license.assertSeatAvailable(tx);
          const created = await repo.insertUser(tx, {
            id: newId(),
            email,
            displayName,
            serverAdmin: decision.serverAdmin,
            at: now,
          });
          await repo.insertOidcIdentity(tx, {
            issuer: claims.issuer,
            subject: claims.subject,
            userId: created.id,
            at: now,
          });
          await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: decision.invitationId, userId: created.id });
          return created;
        });
      } catch (error) {
        if (isWirebenchError(error) && error.code === 'licensing-seat-limit') return { ok: false, code: 'licensing-seat-limit' };
        throw error;
      }
      if (user === undefined) return { ok: false, code: 'identity-not-invited' };
      return { ok: true, user };
    }
```

`src/identity/routes/users.ts`, inside the `PATCH` transaction:

```ts
          } else if (body.disabled === false) {
            // licensing §3.4: only restoring a disabled account takes a seat.
            if (user.disabledAt !== null) await env.ctx.license.assertSeatAvailable(tx);
            await repo.setDisabled(tx, id, null);
          }
```

`src/identity/cli.ts`: import `KeyObject` as a type, plus `createLicenseService` and `PRODUCTION_PUBLIC_KEYS`. Widen `options` and give the CLI context a real service, so `admin invite` refuses at the limit too:

```ts
export async function runAdmin(
  command: AdminCommand,
  io: ServerIo,
  options: { readonly now?: () => Date; readonly publicKeys?: readonly KeyObject[] } = {},
): Promise<number> {
  ...
    const now = options.now ?? (() => new Date());
    env = {
      ctx: {
        db,
        config,
        hooks: serverHooks(),
        license: createLicenseService({ db, publicKeys: options.publicKeys ?? PRODUCTION_PUBLIC_KEYS, now }),
      },
      settings: identitySettings(config),
      now,
    };
```

Add `license: permissiveLicense(),` to the hand-built `ctx` in `test/integration/identity/invitations.test.ts` (near line 216) and in `test/integration/identity/oidc.test.ts`'s `env()` (near line 37). Import `permissiveLicense` from `src/context.js` in both. Those suites test identity alone.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @wirebench/server test`
Expected: PASS, including the unchanged identity and teams suites. In `test/unit/identity/linking.test.ts`, `decideLink` is unchanged, so its table needs no new row.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add packages/server/src/identity packages/server/test/integration/licensing/seats.test.ts packages/server/test/integration/identity
git commit -m "feat(server): seats are counted where an enabled account is made — invite, accept, first OIDC sign-in, re-enable (#197)"
```

### Task 5: `wirebench-server admin license install | show | remove`

**Files:**
- Create: `packages/server/src/licensing/cli.ts`
- Modify: `packages/server/src/args.ts`, `src/main.ts` and `src/identity/cli.ts` (the `switch` in `runAdmin`)
- Test: `packages/server/test/unit/licensing/cli-describe.test.ts`, `test/unit/args.test.ts` and `test/integration/licensing/cli.test.ts`

**Interfaces:**
- Consumes: `installLicense`, `removeLicense`, `LicenseEnv` and `createLicenseService` from Task 3, plus `runAdmin`'s `publicKeys` option from Task 4.
- Produces:
  - Three `ServerCommand` members: `{ command: 'admin-license-install'; file: string }`, `{ command: 'admin-license-show' }` and `{ command: 'admin-license-remove' }`.
  - `describeLicense(state: LicenseState): string`.
  - `runLicenseCommand(command: LicenseCommand, env: LicenseEnv & { license: LicenseService }, io: ServerIo): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/args.test.ts` inside its `describe`:

```ts
  it('parses admin license install, show and remove', () => {
    expect(parseServerArgs(['admin', 'license', 'install', 'team.lic'])).toEqual({
      command: 'admin-license-install',
      file: 'team.lic',
    });
    expect(parseServerArgs(['admin', 'license', 'show'])).toEqual({ command: 'admin-license-show' });
    expect(parseServerArgs(['admin', 'license', 'remove'])).toEqual({ command: 'admin-license-remove' });
    expect(() => parseServerArgs(['admin', 'license', 'install'])).toThrow(/admin license install <file>/);
    expect(() => parseServerArgs(['admin', 'license'])).toThrow(/install <file> \| show \| remove/);
  });
```

```ts
// packages/server/test/unit/licensing/cli-describe.test.ts
import { describe, expect, it } from 'vitest';
import { describeLicense } from '../../../src/licensing/cli.js';

describe('describeLicense (licensing spec §3.7)', () => {
  it('prints a fresh server', () => {
    expect(
      describeLicense({ edition: 'community', status: 'none', seats: { used: 2, limit: 5 }, features: [] }),
    ).toBe('Edition     Community (none)\nSeats       2 of 5\n');
  });

  it('prints a license in grace, with its customer, id, features and grace end', () => {
    expect(
      describeLicense({
        edition: 'enterprise',
        status: 'grace',
        seats: { used: 12, limit: null },
        features: ['audit-log'],
        licenseId: '01J9ZK3V8Q0000000000000000',
        customer: 'Example AG',
        issuedAt: '2026-09-01T00:00:00Z',
        expiresAt: '2027-09-01T00:00:00Z',
        graceUntil: '2027-10-01T00:00:00.000Z',
      }),
    ).toBe(
      [
        'Edition     Enterprise (grace)',
        'Customer    Example AG',
        'License     01J9ZK3V8Q0000000000000000',
        'Seats       12 of unlimited',
        'Expires     2027-09-01T00:00:00Z',
        'Grace until 2027-10-01T00:00:00.000Z',
        'Features    audit-log',
        '',
      ].join('\n'),
    );
  });

  it('prints why a stored license is invalid', () => {
    expect(
      describeLicense({
        edition: 'community',
        status: 'invalid',
        seats: { used: 1, limit: 5 },
        features: [],
        reason: 'bad-signature',
        message: 'The license signature does not match.',
      }),
    ).toContain('Problem     The license signature does not match.\n');
  });
});
```

```ts
// packages/server/test/integration/licensing/cli.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runAdmin } from '../../../src/identity/cli.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { license, PAYLOAD, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');

describeDb('wirebench-server admin license (licensing spec §3.7)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dir: string;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env: env() },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  };
  const options = { now: () => NOW, publicKeys: [keys.publicKey] };
  const file = async (name: string, text: string) => {
    const path = join(dir, name);
    await writeFile(path, text);
    return path;
  };

  beforeEach(async () => {
    db = await testDatabase();
    dir = await mkTempDir();
    expect(await main(['migrate'], io().io)).toBe(0);
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dir);
  });

  it('show, install, show, remove', async () => {
    const before = io();
    expect(await runAdmin({ command: 'admin-license-show' }, before.io, options)).toBe(0);
    expect(before.stdout()).toContain('Community (none)');

    const install = io();
    expect(
      await runAdmin({ command: 'admin-license-install', file: await file('team.lic', `${license(keys)}\n`) }, install.io, options),
    ).toBe(0);
    expect(install.stdout()).toContain('Team (active)');
    expect(install.stdout()).toContain(PAYLOAD.id);

    const removed = io();
    expect(await runAdmin({ command: 'admin-license-remove' }, removed.io, options)).toBe(0);
    expect(removed.stdout()).toBe(`Removed license ${PAYLOAD.id}. This server is on the Community edition.\n`);
    const again = io();
    expect(await runAdmin({ command: 'admin-license-remove' }, again.io, options)).toBe(0);
    expect(again.stdout()).toBe('No license was installed.\n');
  });

  it('refuses a file that fails verification with exit 2 and keeps the stored license', async () => {
    await runAdmin({ command: 'admin-license-install', file: await file('good.lic', license(keys)) }, io().io, options);
    const bad = io();
    expect(await runAdmin({ command: 'admin-license-install', file: await file('bad.lic', license(other)) }, bad.io, options)).toBe(2);
    expect(bad.stderr()).toContain('licensing-invalid: ');
    const show = io();
    await runAdmin({ command: 'admin-license-show' }, show.io, options);
    expect(show.stdout()).toContain('Team (active)');
  });

  it('exits 2 when the file cannot be read', async () => {
    const missing = io();
    expect(await runAdmin({ command: 'admin-license-install', file: join(dir, 'nope.lic') }, missing.io, options)).toBe(2);
    expect(missing.stderr()).toContain('nope.lic');
  });

  it('admin invite is refused at the Community limit, and a Team license installed here lifts it', async () => {
    for (let i = 0; i < 5; i += 1) {
      await identityRepo.insertUser(db, { id: newId(), email: `u${i}@example.com`, displayName: `u${i}`, serverAdmin: false, at: NOW });
    }
    const refused = io();
    expect(await runAdmin({ command: 'admin-invite', email: 'sixth@example.com', serverAdmin: false }, refused.io, options)).toBe(1);
    expect(refused.stderr()).toContain('licensing-seat-limit');
    await runAdmin({ command: 'admin-license-install', file: await file('team.lic', license(keys)) }, io().io, options);
    expect(await runAdmin({ command: 'admin-invite', email: 'sixth@example.com', serverAdmin: false }, io().io, options)).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @wirebench/server exec vitest run --root ../.. --project server-unit packages/server/test/unit/args.test.ts packages/server/test/unit/licensing/cli-describe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Parse the commands**

In `src/args.ts`:

1. Add the three members to `ServerCommand`:

```ts
  | { readonly command: 'admin-license-install'; readonly file: string }
  | { readonly command: 'admin-license-show' }
  | { readonly command: 'admin-license-remove' }
```

2. Add these lines to `HELP_TEXT` after `admin revoke-invitation <id>`:

```
  wirebench-server admin license install <file>
                                    Install a license file (replaces any installed license)
  wirebench-server admin license show
  wirebench-server admin license remove
```

3. Destructure four positionals with `const [word, second, third, fourth] = parsed.positionals;`, and add a case to the `admin` switch:

```ts
        case 'license':
          switch (third) {
            case 'install':
              if (fourth === undefined) throw new UsageError('usage: wirebench-server admin license install <file>');
              return { command: 'admin-license-install', file: fourth };
            case 'show':
              return { command: 'admin-license-show' };
            case 'remove':
              return { command: 'admin-license-remove' };
            default:
              throw new UsageError('usage: wirebench-server admin license install <file> | show | remove');
          }
```

- [ ] **Step 4: Write `licensing/cli.ts`**

```ts
// packages/server/src/licensing/cli.ts
/**
 * `wirebench-server admin license …` (licensing spec §3.7): the endpoints' code, for an operator who
 * installs from a provisioning script or before anyone is a server admin. Its announcement reaches
 * nobody, as every admin command's does (identity/cli.ts builds hooks with no listeners).
 */
import { readFile } from 'node:fs/promises';
import { isWirebenchError, type LicenseState } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import type { LicenseService } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { installLicense, removeLicense, type LicenseEnv } from './service.js';

export type LicenseCommand = Extract<ServerCommand, { command: `admin-license-${string}` }>;

const LABEL = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;

/** What `show` prints, and `install` after it: the License tab's facts, one per line. */
export function describeLicense(state: LicenseState): string {
  const rows: [string, string][] = [['Edition', `${LABEL[state.edition]} (${state.status})`]];
  if (state.customer !== undefined) rows.push(['Customer', state.customer]);
  if (state.licenseId !== undefined) rows.push(['License', state.licenseId]);
  rows.push(['Seats', `${state.seats.used} of ${state.seats.limit ?? 'unlimited'}`]);
  if (state.expiresAt !== undefined) rows.push(['Expires', state.expiresAt]);
  if (state.status === 'grace' && state.graceUntil !== undefined) rows.push(['Grace until', state.graceUntil]);
  if (state.features.length > 0) rows.push(['Features', state.features.join(', ')]);
  if (state.message !== undefined) rows.push(['Problem', state.message]);
  return rows.map(([label, value]) => `${label.padEnd(12)}${value}\n`).join('');
}

export async function runLicenseCommand(
  command: LicenseCommand,
  env: LicenseEnv & { readonly license: LicenseService },
  io: ServerIo,
): Promise<number> {
  switch (command.command) {
    case 'admin-license-show':
      io.stdout.write(describeLicense(await env.license.state()));
      return ExitCode.Ok;
    case 'admin-license-install': {
      let text: string;
      try {
        text = await readFile(command.file, 'utf8');
      } catch (error) {
        io.stderr.write(`cannot read ${command.file}: ${error instanceof Error ? error.message : String(error)}\n`);
        return ExitCode.Config;
      }
      try {
        await installLicense(env, text, null);
      } catch (error) {
        // Invalid input, as a usage error is: exit 2 (§3.7).
        if (isWirebenchError(error) && error.code === 'licensing-invalid') {
          io.stderr.write(`licensing-invalid: ${error.message}\n`);
          return ExitCode.Config;
        }
        throw error;
      }
      io.stdout.write(describeLicense(await env.license.state()));
      return ExitCode.Ok;
    }
    case 'admin-license-remove': {
      const changed = await removeLicense(env, null);
      io.stdout.write(
        changed === undefined
          ? 'No license was installed.\n'
          : `Removed license ${changed.licenseId}. This server is on the Community edition.\n`,
      );
      return ExitCode.Ok;
    }
  }
}
```

- [ ] **Step 5: Dispatch**

In `src/identity/cli.ts`, keep `publicKeys` in a local, `const publicKeys = options.publicKeys ?? PRODUCTION_PUBLIC_KEYS;`, and use it for the service built in Task 4. Then add to `runAdmin`'s `switch`:

```ts
      case 'admin-license-install':
      case 'admin-license-show':
      case 'admin-license-remove':
        return await runLicenseCommand(command, { db, publicKeys, now: env.now, license: env.ctx.license }, io);
```

`await` keeps a throw inside the `try`, so the `finally` closes the pool after the command finishes.

In `src/main.ts`, add the three commands to the case that calls `runAdmin`:

```ts
    case 'admin-invite':
    case 'admin-list-invitations':
    case 'admin-revoke-invitation':
    case 'admin-license-install':
    case 'admin-license-show':
    case 'admin-license-remove':
      return runAdmin(command, io);
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @wirebench/server test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add packages/server/src/args.ts packages/server/src/main.ts packages/server/src/identity/cli.ts packages/server/src/licensing/cli.ts packages/server/test/unit/args.test.ts packages/server/test/unit/licensing/cli-describe.test.ts packages/server/test/integration/licensing/cli.test.ts
git commit -m "feat(server): admin license install, show and remove (#197)"
```

### Task 6: Desktop main: license channels, the server client, and the seat refusal at sign-in

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (append after the CI tokens block near line 6034)
- Modify: `apps/desktop/src/shared/ipc.ts` (a `license` namespace after `ciTokens`, near line 656)
- Modify: `apps/desktop/src/main/server-client.ts` (methods after `revokeCiToken`; imports at the top)
- Create: `apps/desktop/src/main/ipc/license.ts`
- Modify: `apps/desktop/src/main/index.ts` (register after `registerCiTokenChannels`, near line 526)
- Modify: `apps/desktop/src/main/account-service.ts` (`LOOPBACK_MESSAGES`) and `src/renderer/state/account.ts` (`signInErrorMessage`)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts` (beside `ciTokens`) and `test/preload-api.test.ts` (the namespace list)
- Test: `apps/desktop/test/ipc-license.test.ts`, `test/account-service.test.ts` and `test/renderer/account-store.test.ts`

**Interfaces:**
- Consumes: `licenseStateSchema` and `LicenseState` from `@wirebench/engine` (main only).
- Produces:
  - Wire shapes: `licenseStateWireSchema`, `LicenseStateWire`, `licenseRequestWireSchema`, `licenseInstallRequestWireSchema` and `licenseRemoveResponseWireSchema`.
  - Channels: `channels.license.get` takes `{ url }` and returns a `LicenseStateWire`. `channels.license.install` takes `{ url, license }` and returns a `LicenseStateWire`. `channels.license.remove` takes `{ url }` and returns `{ removed: true }`.
  - `ServerClient` methods: `getLicense(url, token)`, `installLicense(url, token, license)` and `removeLicense(url, token)`.
  - The renderer calls `ipc().license.get|install|remove`.

- [ ] **Step 1: Write the failing IPC test**

```ts
// apps/desktop/test/ipc-license.test.ts
// @vitest-environment node
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerLicenseChannels } = await import('../src/main/ipc/license.js');
const { ServerClient } = await import('../src/main/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const STATE = { edition: 'team', status: 'active', seats: { used: 3, limit: 50 }, features: [], licenseId: '01J9ZK3V8Q0000000000000000' };
const PAYLOAD = {
  id: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  edition: 'team',
  seats: 50,
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
};
/** Well-formed but not really signed: main checks the shape and the payload; only the server verifies. */
const LICENSE = `wbl1.${Buffer.from(JSON.stringify(PAYLOAD)).toString('base64url')}.c2lnbmF0dXJl`;

function exchange(status: number, body?: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

let sent: HttpRequest[];

function register(answer: (request: HttpRequest) => HttpExchange, signedIn = true): void {
  sent = [];
  registerLicenseChannels({
    client: new ServerClient({
      send: (request) => {
        sent.push(request);
        return Promise.resolve(answer(request));
      },
    }),
    accounts: { tokenFor: () => Promise.resolve(signedIn ? TOKEN : undefined), markSignedOut: vi.fn() },
  });
}

describe('license.* channels (licensing spec §3.8, §5.3)', () => {
  beforeEach(() => handlers.clear());

  it('reads, installs and removes on /api/v1/license with the account token', async () => {
    register((request) => (request.method === 'DELETE' ? exchange(204) : exchange(200, STATE)));
    expect(await invoke('license.get', { url: SERVER })).toEqual({ ok: true, value: STATE });
    expect(await invoke('license.install', { url: SERVER, license: `${LICENSE}\n` })).toEqual({ ok: true, value: STATE });
    expect(await invoke('license.remove', { url: SERVER })).toEqual({ ok: true, value: { removed: true } });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/license',
      'PUT /api/v1/license',
      'DELETE /api/v1/license',
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe(JSON.stringify({ license: LICENSE }));
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('passes the server’s refusal through with its message', async () => {
    register(() => exchange(400, { code: 'licensing-invalid', message: 'The license signature does not match.' }));
    expect(await invoke('license.install', { url: SERVER, license: LICENSE })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'licensing-invalid', message: 'The license signature does not match.' }),
    });
  });

  it('checks the line and its payload against the shared schema before anything is sent (§3.8)', async () => {
    register(() => exchange(200, STATE));
    const unknownKey = `wbl1.${Buffer.from(JSON.stringify({ ...PAYLOAD, serverId: 'x' })).toString('base64url')}.c2ln`;
    for (const license of ['', 'hello', 'wbl1.a.b', unknownKey]) {
      expect(await invoke('license.install', { url: SERVER, license })).toMatchObject({ ok: false });
    }
    expect(await invoke('license.install', { url: SERVER, license: 'wbl1.a.b' })).toMatchObject({
      ok: false,
      error: { code: 'licensing-invalid' },
    });
    expect(sent).toEqual([]);
  });

  it('asks for a sign-in when signed out', async () => {
    register(() => exchange(200, STATE), false);
    expect(await invoke('license.get', { url: SERVER })).toMatchObject({ ok: false, error: { code: 'account-signed-out' } });
  });
});
```

Run: `pnpm --filter @wirebench/desktop exec vitest run --root ../.. --project desktop apps/desktop/test/ipc-license.test.ts`
Expected: FAIL, `ipc/license.js` does not exist.

- [ ] **Step 2: Wire shapes and channels**

Append to `apps/desktop/src/shared/wire-types.ts`:

```ts
// --- Server license (licensing spec §3.8, §5.3) --------------------------------------------------

/** What `GET /api/v1/license` answers, restated for the bridge; the renderer imports only its type. */
export const licenseStateWireSchema = z.object({
  edition: z.enum(['community', 'team', 'enterprise']),
  status: z.enum(['none', 'active', 'grace', 'expired', 'invalid']),
  seats: z.object({ used: z.number(), limit: z.number().nullable() }),
  features: z.array(z.string()),
  licenseId: z.string().optional(),
  customer: z.string().optional(),
  issuedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  graceUntil: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});
export type LicenseStateWire = z.infer<typeof licenseStateWireSchema>;
export const licenseRequestWireSchema = z.object({ url: z.string() });
export const licenseInstallRequestWireSchema = licenseRequestWireSchema.extend({ license: z.string().min(1).max(8192) });
export const licenseRemoveResponseWireSchema = z.object({ removed: z.literal(true) });
```

In `apps/desktop/src/shared/ipc.ts`, import the four schemas and add after `ciTokens`:

```ts
  /** The server's license (licensing spec §3.8): server admins only; main adds the account's token. */
  license: {
    get: defineChannel('license.get', licenseRequestWireSchema, licenseStateWireSchema),
    install: defineChannel('license.install', licenseInstallRequestWireSchema, licenseStateWireSchema),
    remove: defineChannel('license.remove', licenseRequestWireSchema, licenseRemoveResponseWireSchema),
  },
```

- [ ] **Step 3: Server client methods**

Add `licenseStateSchema` and `type LicenseState` to the `@wirebench/engine` import in `server-client.ts`. Add these methods after `revokeCiToken`:

```ts
  // ---- licensing (licensing spec §3.6): server admins, on their own session ------------------------

  getLicense(url: string, token: string): Promise<LicenseState> {
    return this.call(url, { method: 'GET', path: '/api/v1/license', token, schema: licenseStateSchema });
  }

  /** The server verifies; a refusal arrives as `licensing-invalid` with the reason in its message. */
  installLicense(url: string, token: string, license: string): Promise<LicenseState> {
    return this.call(url, { method: 'PUT', path: '/api/v1/license', token, body: { license }, schema: licenseStateSchema });
  }

  async removeLicense(url: string, token: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: '/api/v1/license', token });
  }
```

- [ ] **Step 4: The channel handlers**

```ts
// apps/desktop/src/main/ipc/license.ts
/** `license.*` (licensing spec §3.8, §5.3): the License tab's calls, on the account's session. */
import { LICENSE_TEXT_PATTERN, licensePayloadSchema, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

/**
 * The shared-schema parse before anything is sent (§3.8, plan ruling 14). Only the shape and the
 * payload are checked here; the signature is the server's to verify.
 */
export function checkLicenseText(input: string): string {
  const text = input.trim();
  const segment = text.split('.')[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    payload = undefined;
  }
  if (!LICENSE_TEXT_PATTERN.test(text) || !licensePayloadSchema.safeParse(payload).success) {
    throw new WirebenchError(
      'licensing-invalid',
      'This is not a Wirebench license, or part of it is missing. Paste the whole line again.',
    );
  }
  return text;
}

export interface LicenseChannelDeps {
  readonly client: Pick<ServerClient, 'getLicense' | 'installLicense' | 'removeLicense'>;
  readonly accounts: TokenSource;
}

export function registerLicenseChannels(deps: LicenseChannelDeps): void {
  const c = deps.client;
  registerHandler(channels.license.get, (r) => withToken(deps, r.url, (url, token) => c.getLicense(url, token)));
  // Async, so a refusal from checkLicenseText becomes the envelope's error rather than a sync throw.
  registerHandler(channels.license.install, async (r) => {
    const license = checkLicenseText(r.license);
    return withToken(deps, r.url, (url, token) => c.installLicense(url, token, license));
  });
  registerHandler(channels.license.remove, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeLicense(url, token);
      return { removed: true as const };
    }),
  );
}
```

In `src/main/index.ts`, import `registerLicenseChannels` and call `registerLicenseChannels({ client: serverClient, accounts: accountService });` after `registerCiTokenChannels(...)`.

In `test/mocks/wirebench-api.ts`, after `ciTokens`, add:

```ts
    license: { get: fail('license.get'), install: fail('license.install'), remove: fail('license.remove') },
```

In `test/preload-api.test.ts`, add `'license',` to the sorted namespace list, between `'keystores'` and `'log'`.

Run the IPC test again. Expected: PASS.

- [ ] **Step 5: The seat refusal at sign-in**

`src/main/account-service.ts`, in `LOOPBACK_MESSAGES`. The loopback carries only the code, so the app supplies the words (plan ruling 11):

```ts
  'licensing-seat-limit': 'This server has no free seat for a new account.',
```

`src/renderer/state/account.ts`, `signInErrorMessage`. The server's own message or the loopback's line comes first, then the one instruction:

```ts
export function signInErrorMessage(error: IpcError): string {
  // licensing §3.8: the server's message, then who can fix it. No other text.
  if (error.code === 'licensing-seat-limit') return `${error.message} Ask a server admin.`;
  return SIGN_IN_MESSAGES[error.code] ?? error.message;
}
```

Add the matching tests. In `test/account-service.test.ts`, inside the OIDC loopback test after the `identity-not-invited` assertion, use a fresh service as that test does for its second flow:

```ts
    const third = fakeLoopback();
    const s3 = service(fakeClient(), fakeSecrets(), third);
    const seats = s3.startOidc({ url: URL_A });
    await vi.waitFor(() => expect(third.start).toHaveBeenCalled());
    third.answer({ flow: 'flow-1', error: 'licensing-seat-limit' });
    await expect(seats).rejects.toMatchObject({
      code: 'licensing-seat-limit',
      message: 'This server has no free seat for a new account.',
    });
```

In `test/renderer/account-store.test.ts`, inside `'maps the codes a sign-in can fail with…'`:

```ts
    expect(signInErrorMessage({ code: 'licensing-seat-limit', message: 'This server has 5 enabled accounts.' })).toBe(
      'This server has 5 enabled accounts. Ask a server admin.',
    );
```

- [ ] **Step 6: Run the desktop tests**

Run: `pnpm --filter @wirebench/desktop test`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add apps/desktop/src/shared apps/desktop/src/main apps/desktop/src/renderer/state/account.ts apps/desktop/test
git commit -m "feat(desktop): license channels, and a seat refusal at sign-in names who can fix it (#197)"
```

### Task 7: Desktop renderer: the License tab and the banners

**Files:**
- Create: `apps/desktop/src/renderer/state/license-format.ts`, `src/renderer/state/license.ts`, `src/renderer/features/team/license-tab.tsx` and `src/renderer/features/team/license-banner.tsx`
- Modify: `apps/desktop/src/renderer/state/team.ts` (`TeamTab`, `refresh`)
- Modify: `apps/desktop/src/renderer/features/team/team-dialog.tsx` and `src/renderer/features/preferences/sections/accounts-section.tsx`
- Test: `apps/desktop/test/license-format.test.ts`, `test/renderer/license-tab.test.tsx` and `test/renderer/license-banner.test.tsx`
- Modify tests: `apps/desktop/test/renderer/team-dialog.test.tsx` and `test/renderer/accounts-section.test.tsx`

**Interfaces:**
- Consumes from Task 6: `ipc().license.get|install|remove`, `LicenseStateWire` (type only) and `ipc().fs.openText`.
- Produces:
  - `licenseLineProblem(input: string): string | undefined` and `bannerText(state: LicenseStateWire): string | undefined`.
  - `useLicenseStore`.
  - Components: `<LicenseTab url={string} />` and `<LicenseBanner url={string} />`.
  - `TeamTab` gains `'license'`.

- [ ] **Step 1: Write the failing pure tests**

```ts
// apps/desktop/test/license-format.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bannerText, licenseLineProblem } from '../src/renderer/state/license-format.js';

describe('licenseLineProblem (licensing spec §3.8)', () => {
  it('accepts a license line, surrounding whitespace included', () => {
    expect(licenseLineProblem('  wbl1.eyJhIjoxfQ.c2ln\n')).toBeUndefined();
  });

  it.each([
    ['', 'Paste a license, or choose a license file.'],
    ['hello', 'This is not a Wirebench license. A license is one line that starts with "wbl1.".'],
    ['wbl1.eyJh', 'This is not a Wirebench license. A license is one line that starts with "wbl1.".'],
  ])('refuses %j', (input, message) => {
    expect(licenseLineProblem(input)).toBe(message);
  });
});

describe('bannerText (licensing spec §3.8)', () => {
  const base = { edition: 'team', seats: { used: 7, limit: 50 }, features: [] } as const;

  it('says when the license expired and until when everything keeps working', () => {
    expect(
      bannerText({ ...base, status: 'grace', expiresAt: '2027-09-01T00:00:00Z', graceUntil: '2027-10-01T00:00:00.000Z' }),
    ).toBe("This server's license expired on 2027-09-01. Everything keeps working until 2027-10-01.");
  });

  it('says the server is Community after expiry, with the seats in use', () => {
    expect(bannerText({ ...base, edition: 'community', status: 'expired', seats: { used: 7, limit: 5 } })).toBe(
      'This server is on the Community edition. 7 of 5 seats are in use.',
    );
  });

  it('says nothing otherwise', () => {
    for (const status of ['none', 'active', 'invalid'] as const) expect(bannerText({ ...base, status })).toBeUndefined();
  });
});
```

Run: `pnpm --filter @wirebench/desktop exec vitest run --root ../.. --project desktop apps/desktop/test/license-format.test.ts`
Expected: FAIL.

- [ ] **Step 2: Write `license-format.ts`**

```ts
// apps/desktop/src/renderer/state/license-format.ts
/**
 * The License tab's pure rules (licensing spec §3.8). Kept apart from the store, which reaches `window`,
 * so the node-side test can import it, and free of zod values (the renderer CSP trap). Main checks the
 * payload against the shared schema before sending (plan ruling 14); this only gives instant feedback.
 */
import type { LicenseStateWire } from '../../shared/wire-types.js';

/** The engine's `LICENSE_TEXT_PATTERN`, restated; `test/license-format.test.ts` pins its behaviour. */
const LICENSE_LINE = /^wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function licenseLineProblem(input: string): string | undefined {
  const text = input.trim();
  if (text.length === 0) return 'Paste a license, or choose a license file.';
  if (!LICENSE_LINE.test(text)) return 'This is not a Wirebench license. A license is one line that starts with "wbl1.".';
  return undefined;
}

const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10);

/** What server admins see on the team dialog and in Accounts; nothing for members, who never get a state. */
export function bannerText(state: LicenseStateWire): string | undefined {
  if (state.status === 'grace') {
    return `This server's license expired on ${day(state.expiresAt)}. Everything keeps working until ${day(state.graceUntil)}.`;
  }
  if (state.status === 'expired') {
    return `This server is on the Community edition. ${state.seats.used} of ${String(state.seats.limit)} seats are in use.`;
  }
  return undefined;
}
```

Run the test. Expected: PASS.

- [ ] **Step 3: Write the store**

```ts
// apps/desktop/src/renderer/state/license.ts
/** The License tab's state (licensing spec §3.8): read from the server when the tab opens, never stored. */
import { create } from 'zustand';
import type { LicenseStateWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

interface LicenseSnapshot {
  readonly state: LicenseStateWire | undefined;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
}

interface LicenseStore extends LicenseSnapshot {
  readonly load: (url: string) => Promise<void>;
  /** Resolves `true` when the server took the license; its new state is then in `state`. */
  readonly install: (url: string, text: string) => Promise<boolean>;
  readonly remove: (url: string) => Promise<void>;
  readonly reset: () => void;
}

const EMPTY: LicenseSnapshot = { state: undefined, loaded: false, busy: false, error: undefined };

/** As in `ci-tokens.ts`: a stale load, or a write that answers after `reset`, is dropped. */
let loads = 0;
let epoch = 0;

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  ...EMPTY,
  load: async (url) => {
    const mine = ++loads;
    const result = await ipc().license.get({ url });
    if (mine !== loads) return;
    set(result.ok ? { state: result.value, loaded: true, error: undefined } : { loaded: true, error: result.error.message });
  },
  install: async (url, text) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().license.install({ url, license: text.trim() });
    if (started !== epoch) return false;
    if (!result.ok) {
      set({ busy: false, error: result.error.message });
      return false;
    }
    set({ busy: false, state: result.value, error: undefined });
    return true;
  },
  remove: async (url) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().license.remove({ url });
    if (started !== epoch) return;
    if (!result.ok) {
      set({ busy: false, error: result.error.message });
      return;
    }
    set({ busy: false });
    await get().load(url);
  },
  reset: () => {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
```

- [ ] **Step 4: Write the failing component tests**

```tsx
// apps/desktop/test/renderer/license-tab.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LicenseTab } from '../../src/renderer/features/team/license-tab.js';
import { useLicenseStore } from '../../src/renderer/state/license.js';
import type { LicenseStateWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const LINE = 'wbl1.eyJhIjoxfQ.c2ln';
const community: LicenseStateWire = { edition: 'community', status: 'none', seats: { used: 3, limit: 5 }, features: [] };
const team: LicenseStateWire = {
  edition: 'team',
  status: 'active',
  seats: { used: 3, limit: 50 },
  features: [],
  licenseId: '01J9ZK3V8Q0000000000000000',
  customer: 'Example AG',
  issuedAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
  graceUntil: '2027-10-01T00:00:00.000Z',
};
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

function install(overrides: Record<string, unknown> = {}) {
  return installWirebenchApi({
    license: { get: ok(community), install: ok(team), remove: ok({ removed: true }), ...overrides },
    fs: { openText: ok({ path: '/tmp/team.lic', text: `${LINE}\n` }) },
  });
}

describe('LicenseTab (licensing spec §3.8)', () => {
  beforeEach(() => useLicenseStore.getState().reset());
  afterEach(() => cleanup());

  it('shows the edition, status and seats of a fresh server', async () => {
    install();
    render(<LicenseTab url={URL_} />);
    expect((await screen.findByTestId('license-edition')).textContent).toContain('Community');
    expect((screen.getByTestId('license-status')).textContent).toContain('No license installed');
    expect((screen.getByTestId('license-seats')).textContent).toContain('3 of 5 seats in use');
    expect(screen.queryByTestId('license-remove')).toBeNull();
  });

  it('refuses a paste that is not a license line before anything is sent', async () => {
    const api = install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('license-install'));
    expect((screen.getByTestId('license-error')).textContent).toContain('not a Wirebench license');
    expect(api.license.install).not.toHaveBeenCalled();
  });

  it('installs a pasted license and shows the new state', async () => {
    const api = install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: `  ${LINE}  ` } });
    fireEvent.click(screen.getByTestId('license-install'));
    await waitFor(() => expect((screen.getByTestId('license-edition')).textContent).toContain('Team'));
    expect(api.license.install).toHaveBeenCalledWith({ url: URL_, license: LINE });
    expect((screen.getByTestId('license-customer')).textContent).toContain('Example AG');
    expect((screen.getByTestId('license-seats')).textContent).toContain('3 of 50 seats in use');
    expect((screen.getByTestId('license-expires')).textContent).toContain('2027-09-01');
    expect((screen.getByTestId('license-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the server’s refusal', async () => {
    install({
      install: vi.fn().mockResolvedValue({ ok: false, error: { code: 'licensing-invalid', message: 'The license signature does not match.' } }),
    });
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.change(screen.getByTestId('license-input'), { target: { value: LINE } });
    fireEvent.click(screen.getByTestId('license-install'));
    expect((await screen.findByTestId('license-error')).textContent).toContain('The license signature does not match.');
  });

  it('reads a license from a file', async () => {
    install();
    render(<LicenseTab url={URL_} />);
    await screen.findByTestId('license-edition');
    fireEvent.click(screen.getByTestId('license-choose-file'));
    await waitFor(() => expect((screen.getByTestId('license-input') as HTMLTextAreaElement).value).toBe(LINE));
  });

  it('removes a license only after confirming', async () => {
    const api = install({ get: ok(team) });
    render(<LicenseTab url={URL_} />);
    fireEvent.click(await screen.findByTestId('license-remove'));
    expect(api.license.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('license-remove-confirm-button'));
    await waitFor(() => expect(api.license.remove).toHaveBeenCalledWith({ url: URL_ }));
  });

  it('explains an invalid stored license', async () => {
    install({
      get: ok({ ...community, status: 'invalid', reason: 'bad-signature', message: 'The license signature does not match.' }),
    });
    render(<LicenseTab url={URL_} />);
    expect((await screen.findByTestId('license-problem')).textContent).toContain('The license signature does not match.');
  });
});
```

```tsx
// apps/desktop/test/renderer/license-banner.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LicenseBanner } from '../../src/renderer/features/team/license-banner.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

describe('LicenseBanner (licensing spec §3.8)', () => {
  afterEach(() => cleanup());

  it('shows the grace banner to whoever can read the license', async () => {
    installWirebenchApi({
      license: {
        get: ok({
          edition: 'team',
          status: 'grace',
          seats: { used: 7, limit: 50 },
          features: [],
          expiresAt: '2027-09-01T00:00:00Z',
          graceUntil: '2027-10-01T00:00:00.000Z',
        }),
      },
    });
    render(<LicenseBanner url="https://wb.test" />);
    expect((await screen.findByTestId('license-banner')).textContent).toContain('Everything keeps working until 2027-10-01.');
  });

  it('shows nothing to a member, whose read is refused', async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, error: { code: 'identity-forbidden', message: 'x' } });
    installWirebenchApi({ license: { get } });
    render(<LicenseBanner url="https://wb.test" />);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('license-banner')).toBeNull();
  });
});
```

Run: `pnpm --filter @wirebench/desktop exec vitest run --root ../.. --project desktop apps/desktop/test/renderer/license-tab.test.tsx apps/desktop/test/renderer/license-banner.test.tsx`
Expected: FAIL, the components do not exist.

- [ ] **Step 5: Write the components**

```tsx
// apps/desktop/src/renderer/features/team/license-banner.tsx
import { useEffect, useState } from 'react';
import { bannerText } from '../../state/license-format.js';
import { ipc } from '../../state/ipc-client.js';

/**
 * The grace and expiry banner (licensing spec §3.8). It reads the license itself, so it works in the
 * team dialog and once per server in Accounts. A member's read is refused, so a member sees nothing.
 */
export function LicenseBanner({ url }: { readonly url: string }) {
  const [text, setText] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setText(undefined);
    void ipc()
      .license.get({ url })
      .then((result) => {
        if (live && result.ok) setText(bannerText(result.value));
      });
    return () => {
      live = false;
    };
  }, [url]);
  if (text === undefined) return null;
  return (
    <p data-testid="license-banner" role="status" className="mt-2 rounded-sm bg-surface-hover px-2 py-1 text-xs text-fg-default">
      {text}
    </p>
  );
}
```

```tsx
// apps/desktop/src/renderer/features/team/license-tab.tsx
import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { ipc } from '../../state/ipc-client.js';
import { licenseLineProblem } from '../../state/license-format.js';
import { useLicenseStore } from '../../state/license.js';
import { INPUT_CLASS } from './roles.js';

const EDITION = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;
const STATUS = {
  none: 'No license installed',
  active: 'Active',
  grace: 'Expired, in its grace period',
  expired: 'Expired',
  invalid: 'Installed, but not valid',
} as const;

/**
 * The License tab (licensing spec §3.8), for server admins. Edition, status, customer, seats and dates;
 * a pasted or chosen license; *Remove license…* behind a confirmation. No other text.
 */
export function LicenseTab({ url }: { readonly url: string }) {
  const { state, error, busy, load, install, remove } = useLicenseStore();
  const [text, setText] = useState('');
  const [local, setLocal] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void load(url);
    return () => {
      useLicenseStore.getState().reset();
    };
  }, [url, load]);

  const submit = async (): Promise<void> => {
    const problem = licenseLineProblem(text);
    setLocal(problem);
    if (problem !== undefined) return;
    if (await install(url, text)) setText('');
  };

  const chooseFile = async (): Promise<void> => {
    const result = await ipc().fs.openText({ filters: [{ name: 'Wirebench license', extensions: ['lic', 'txt'] }] });
    if (result.ok && result.value.text !== undefined) {
      setText(result.value.text.trim());
      setLocal(undefined);
    }
  };

  const shown = local ?? error;
  return (
    <div data-testid="license-tab" className="flex flex-col gap-3 text-sm">
      {state !== undefined && (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
          <dt className="text-fg-subtle">Edition</dt>
          <dd data-testid="license-edition">{EDITION[state.edition]}</dd>
          <dt className="text-fg-subtle">Status</dt>
          <dd data-testid="license-status">{STATUS[state.status]}</dd>
          {state.customer !== undefined && (
            <>
              <dt className="text-fg-subtle">Customer</dt>
              <dd data-testid="license-customer">{state.customer}</dd>
            </>
          )}
          <dt className="text-fg-subtle">Seats</dt>
          <dd data-testid="license-seats">
            {state.seats.used} of {state.seats.limit ?? 'unlimited'} seats in use
          </dd>
          {state.expiresAt !== undefined && (
            <>
              <dt className="text-fg-subtle">Expires</dt>
              <dd data-testid="license-expires">{state.expiresAt.slice(0, 10)}</dd>
            </>
          )}
          {state.status === 'grace' && state.graceUntil !== undefined && (
            <>
              <dt className="text-fg-subtle">Works until</dt>
              <dd data-testid="license-grace-until">{state.graceUntil.slice(0, 10)}</dd>
            </>
          )}
          {state.message !== undefined && (
            <>
              <dt className="text-fg-subtle">Problem</dt>
              <dd data-testid="license-problem">{state.message}</dd>
            </>
          )}
        </dl>
      )}
      <textarea
        data-testid="license-input"
        aria-label="License"
        rows={3}
        spellCheck={false}
        className={`${INPUT_CLASS} font-mono text-xs`}
        placeholder="wbl1.…"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setLocal(undefined);
        }}
      />
      {shown !== undefined && (
        <p data-testid="license-error" role="alert" className="text-xs text-status-danger">
          {shown}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" data-testid="license-install" disabled={busy} onClick={() => void submit()}>
          Install license
        </Button>
        <Button data-testid="license-choose-file" onClick={() => void chooseFile()}>
          Choose file…
        </Button>
        {state?.licenseId !== undefined && (
          <Button
            variant="ghost"
            data-testid="license-remove"
            disabled={busy}
            onClick={() => {
              setConfirmRemove(true);
            }}
          >
            Remove license…
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the license?"
        description="The server goes back to the Community edition on the next request. Nobody is signed out and nothing is deleted."
        confirmLabel="Remove license"
        destructive
        testId="license-remove-confirm"
        confirmTestId="license-remove-confirm-button"
        onConfirm={() => {
          void remove(url);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 6: Put the tab and the banners in place**

`src/renderer/state/team.ts`:

```ts
export type TeamTab = 'members' | 'workspaces' | 'invitations' | 'license';
```

In `refresh`, right after the `set({ teams: …, serverAdmin: …, … })` call:

```ts
      // The License tab is a server admin's (licensing §3.8).
      if (!list.serverAdmin && get().tab === 'license') set({ tab: 'members' });
```

`features/team/team-dialog.tsx`: import `LicenseBanner` and `LicenseTab`, then make three edits.

1. Replace the `tabs` constant:

```tsx
  const licenseTab: TabItem<TeamTab>[] = store.serverAdmin ? [{ id: 'license', label: 'License' }] : [];
  // A server admin with no team selected still has the License tab (plan ruling 10).
  const tabs: TabItem<TeamTab>[] =
    team === undefined
      ? licenseTab
      : [
          { id: 'members', label: 'Members' },
          { id: 'workspaces', label: 'Workspaces' },
          ...(isAdmin ? [{ id: 'invitations' as const, label: 'Invitations' }] : []),
          ...licenseTab,
        ];
  const activeTab: TeamTab = team === undefined ? 'license' : store.tab;
```

2. Right after the `<div className="flex items-center gap-3">…</div>` title row, add:

```tsx
          {store.serverAdmin && url !== undefined && <LicenseBanner url={url} />}
```

3. Replace `{team !== undefined && (` and its whole right-hand pane with:

```tsx
              {(team !== undefined || store.serverAdmin) && (
                <div className="flex min-w-0 flex-1 flex-col">
                  {team !== undefined && (
                    <div className="flex items-center gap-2">
                      <input
                        data-testid="team-name"
                        aria-label="Team name"
                        readOnly={!isAdmin}
                        className={`${INPUT_CLASS} flex-1 text-md font-medium`}
                        value={name}
                        onChange={(event) => {
                          setName(event.target.value);
                        }}
                        onBlur={submitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitRename();
                        }}
                      />
                      {store.serverAdmin && (
                        <Button
                          variant="ghost"
                          data-testid="team-delete"
                          onClick={() => {
                            setConfirmDelete(true);
                          }}
                        >
                          Delete team
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="mt-2 border-b border-hairline">
                    <Tabs label="Team" items={tabs} active={activeTab} onSelect={store.setTab} />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto pt-3">
                    {activeTab === 'members' && <MembersTab />}
                    {activeTab === 'workspaces' && <WorkspacesTab />}
                    {activeTab === 'invitations' && isAdmin && <InvitationsTab />}
                    {activeTab === 'license' && store.serverAdmin && url !== undefined && <LicenseTab url={url} />}
                  </div>
                </div>
              )}
```

`features/preferences/sections/accounts-section.tsx`: import `LicenseBanner` and render it under each signed-in row's text, inside the `min-w-0 flex-1` div after the subtitle line:

```tsx
                  {!server.signedOut && <LicenseBanner url={server.url} />}
```

Add the matching cases to the existing suites:

In `test/renderer/team-dialog.test.tsx`, using the file's `install(myRole, overrides, serverAdmin)`:

```tsx
  it('shows a License tab to a server admin only', async () => {
    // A server admin who is a plain member of this team still gets the License tab.
    install('member', {}, true);
    render(<TeamDialog />);
    expect(await screen.findByRole('tab', { name: 'License' })).not.toBeNull();
    cleanup();
    install('admin', {}, false);
    render(<TeamDialog />);
    await screen.findByTestId('team-name');
    expect(screen.queryByRole('tab', { name: 'License' })).toBeNull();
  });
```

The suite's `beforeEach` already opens the dialog on `URL_` with the account signed in. `Tabs` renders each item with `role="tab"`.

In `test/renderer/accounts-section.test.tsx`:

```tsx
  it('shows the expiry banner under a server whose license has lapsed', async () => {
    installWirebenchApi({
      license: {
        get: vi.fn().mockResolvedValue({
          ok: true,
          value: { edition: 'community', status: 'expired', seats: { used: 7, limit: 5 }, features: [] },
        }),
      },
    });
    useAccountStore.setState({ servers: [account('https://one.test')] });
    render(<AccountsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect((await screen.findByTestId('license-banner')).textContent).toContain('7 of 5 seats are in use');
  });
```

- [ ] **Step 7: Run the desktop tests**

Run: `pnpm --filter @wirebench/desktop test`
Expected: PASS, the existing team dialog and accounts suites included. Their default `license.get` is the mock's `fail`, so no banner appears.

- [ ] **Step 8: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add apps/desktop/src/renderer apps/desktop/test
git commit -m "feat(desktop): the License tab and the grace and expiry banners, for server admins (#197)"
```

### Task 8: One end-to-end path, in CI only

**Files:**
- Modify: `e2e/helpers/fake-server.ts` (license state, three routes, `edition` in `/meta`)
- Create: `e2e/specs/license.spec.ts`

**Interfaces:**
- Consumes from Tasks 6 and 7: the License tab test ids `license-edition`, `license-seats`, `license-input`, `license-install` and `license-banner`.
- Produces: the fake server answers `GET`, `PUT` and `DELETE /api/v1/license` for a server admin, with no signature check. The desktop never verifies signatures, so the fake needs none.

- [ ] **Step 1: Teach the fake server licenses**

In `startFakeServer`, after `const tokens: string[] = [];`, add:

```ts
  /** The installed license's payload; the fake checks shape only, as the desktop does (licensing §3.8). */
  let installedLicense:
    | { id: string; customer: string; edition: 'team' | 'enterprise'; seats: number | null; issuedAt: string; expiresAt: string }
    | undefined;
  const licenseState = () =>
    installedLicense === undefined
      ? { edition: 'community', status: 'none', seats: { used: users.size, limit: 5 }, features: [] }
      : {
          edition: installedLicense.edition,
          status: 'active',
          seats: { used: users.size, limit: installedLicense.seats },
          features: [],
          licenseId: installedLicense.id,
          customer: installedLicense.customer,
          issuedAt: installedLicense.issuedAt,
          expiresAt: installedLicense.expiresAt,
        };
```

In the `/api/v1/meta` answer, add `edition: installedLicense?.edition ?? 'community',`.

After the `/api/v1/me` handler, add:

```ts
      if (path.pathname === '/api/v1/license') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        if (users.get(email.toLowerCase())?.serverAdmin !== true) return problem(response, 403, 'identity-forbidden');
        if (request.method === 'GET') return send(response, 200, licenseState());
        if (request.method === 'PUT') {
          const body = (await readJson(request)) as { license: string };
          const segment = body.license.split('.')[1] ?? '';
          try {
            installedLicense = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as typeof installedLicense;
          } catch {
            return problem(response, 400, 'licensing-invalid');
          }
          return send(response, 200, licenseState());
        }
        if (request.method === 'DELETE') {
          installedLicense = undefined;
          return send(response, 204);
        }
      }
```

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/license.spec.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };

/** Well-formed, so main's shared-schema check passes; the fake does not verify signatures. */
const LICENSE = `wbl1.${Buffer.from(
  JSON.stringify({
    id: '01J9ZK3V8Q0000000000000000',
    customer: 'Example AG',
    edition: 'team',
    seats: 50,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2099-09-01T00:00:00Z',
  }),
).toString('base64url')}.c2lnbmF0dXJl`;

test.describe('server license (licensing spec §3.8)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-license-'));
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('a server admin with no team pastes a Team license and the seat limit lifts', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT, ALICE, BOB] });
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await signIn(page, server.url, ROOT);

    await runCommand(page, 'Account: Manage teams');
    const dialog = page.getByTestId('team-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('tab', { name: 'License' })).toBeVisible();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Community');
    await expect(dialog.getByTestId('license-seats')).toHaveText('3 of 5 seats in use');

    await dialog.getByTestId('license-input').fill(LICENSE);
    await dialog.getByTestId('license-install').click();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Team');
    await expect(dialog.getByTestId('license-seats')).toHaveText('3 of 50 seats in use');
    await expect(dialog.getByTestId('license-input')).toHaveValue('');
    expect(server.requests.some((r) => r.method === 'PUT' && r.path === '/api/v1/license')).toBe(true);
  });
});
```

`FakeServer.requests` (`e2e/helpers/fake-server.ts:1207`) records every request the fake answered.

- [ ] **Step 3: Type-check, and leave the run to CI**

Run: `tsc --noEmit -p e2e/tsconfig.json` (part of `pnpm typecheck`). Expected: no errors.

Do not run Electron e2e locally: no windows while the owner works. CI runs `pnpm build && pnpm test:e2e` on all three platforms.

- [ ] **Step 4: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add e2e/helpers/fake-server.ts e2e/specs/license.spec.ts
git commit -m "test(e2e): a server admin installs a Team license from the License tab (#197)"
```

### Task 9: Docs, changelog and roadmap

**Files:**
- Create: `docs-site/src/content/docs/guides/server-licensing.mdx`
- Modify: `docs-site/astro.config.mjs` (sidebar, after `Wirebench Server`)
- Modify: `site/src/docs-links.ts` (`serverLicensing`) and `site/src/pages/features.astro` (the *Teams and Wirebench Server* section's links)
- Modify: `packages/server/README.md` (a *License* section after *Accounts*)
- Modify: `CHANGELOG.md` (Unreleased → Added) and `docs/roadmap.md` (item 18's status)

- [ ] **Step 1: The guide**

```mdx
---
title: Editions and licenses
description: What Community, Team and Enterprise mean on Wirebench Server, how seats are counted, and how a server admin installs, reads or removes a license.
---

import { Aside, Steps } from '@astrojs/starlight/components';

Wirebench Server runs as one of three editions. The code is the same for all three, under the same
Apache-2.0 license. A license file tells a server which edition it is.

| Edition    | Seats                     | Enterprise features |
| ---------- | ------------------------- | ------------------- |
| Community  | 5                         | No                  |
| Team       | The number on the license | No                  |
| Enterprise | The number on the license | Yes                 |

A server with no license is Community. Everything the server did before licenses existed stays in
Community: sign-in, teams, shared workspaces, live updates, webhooks and CI tokens.

## Seats

A seat is an enabled account, server admins included. A disabled account frees its seat at once.

The server checks seats only when an account would become enabled:

- when a server admin or a team admin creates an invitation;
- when someone accepts an invitation, with a password or through the identity provider;
- when a server admin enables a disabled account.

A password reset never counts. When no seat is free, the server refuses with a message that says how
many seats are in use and how many the edition allows. An invitation refused at acceptance stays
open, so it goes through once a seat frees.

The server never disables anyone to get under a limit. A server with more enabled accounts than its
edition allows keeps every one of them working, and refuses only the next new account.

## Installing a license

A license is one line of text that starts with `wbl1.`.

<Steps>

1. Sign in as a server admin and choose **Account: Manage teams**.
2. Open the **License** tab. It shows the edition, the seats in use and, with a license, its customer and
   expiry date.
3. Paste the license line, or click **Choose file…**, then click **Install license**.

</Steps>

The new edition applies from the next request, with no restart. Installing a license replaces the one
before it. A license that fails its check is not stored, so a bad paste never replaces a working
license.

From the server's console, the same three actions are commands:

```bash
wirebench-server admin license install team.lic
wirebench-server admin license show
wirebench-server admin license remove
```

`install` exits with code 2 when the file fails its check, and prints the reason.

## Expiry

When a license passes its expiry date, it has 30 days of grace. The edition holds during grace, and
server admins see a banner with the date it ends. After grace the server is Community again. Nobody is
signed out, no workspace is locked, and sync keeps working.

## How the check works

The license is signed. The server checks the signature against a public key built into the server, so
the check works offline. The server never contacts anyone about its license and sends no usage report.

A stored license can stop passing the check. One cause is a server clock set before the license's issue
date. Another is a server version that no longer carries the key the license was signed with. The
License tab then shows *Installed, but not valid* with the reason, and the server runs as Community.

<Aside>
`GET /api/v1/meta` reports the edition and nothing else about the license. The full state is at
`GET /api/v1/license`, for server admins only.
</Aside>

## Related

- [Wirebench Server](/wirebench/docs/guides/wirebench-server/) — running the server, accounts and sign-in.
- [Shared workspaces](/wirebench/docs/guides/shared-workspaces/) — what a team shares on the server.
```

- [ ] **Step 2: Link it everywhere the gates look**

- `docs-site/astro.config.mjs`: add `{ label: 'Editions and licenses', slug: 'guides/server-licensing' },` after the `Wirebench Server` entry.
- `site/src/docs-links.ts`: add `serverLicensing: 'guides/server-licensing',` after `wirebenchServer`.
- `site/src/pages/features.astro`, in the *Teams and Wirebench Server* section's `links`, add `{ label: 'Editions and licenses', slug: DOCS_LINKS.serverLicensing },` after *Run Wirebench Server*. `site/test/features-coverage.test.ts` fails without it.
- In `docs-site/src/content/docs/guides/wirebench-server.mdx`, add to its *Related* list (line 257), in that list's style: `- [Editions and licenses](/wirebench/docs/guides/server-licensing/) — seats, editions and installing a license.`

- [ ] **Step 3: README, changelog and roadmap**

`packages/server/README.md`, a new section after *Accounts*:

```markdown
## License

A server with no license is the Community edition: everything it does today, for up to five enabled
accounts. A license file sets the Team or Enterprise edition. It is checked offline against a public key
built into the server; nothing is sent anywhere. Install it from the app's License tab, or here:

    docker compose -f packages/server/compose.yaml exec server node /app/dist/bin.js admin license install /path/in/container/team.lic

`admin license show` prints the edition, seats and expiry; `admin license remove` returns the server to
Community. An expired license keeps its edition for 30 days, then the server is Community again, with
nobody signed out and nothing locked. See the docs site's *Editions and licenses* guide.
```

`CHANGELOG.md`, under `## [Unreleased]` → `### Added`, after the Wirebench Server entries:

```markdown
- **Server editions and licenses.** Wirebench Server runs as Community, Team or Enterprise. A server with
  no license is Community, with five seats, and keeps everything it did before. A signed license file,
  checked offline and installed from the new License tab or with `wirebench-server admin license install`,
  raises the seats and turns on enterprise features. An expired license has 30 days of grace, and a lapse
  never disables an account or locks data. See
  [Editions and licenses](https://wirebench.github.io/wirebench/docs/guides/server-licensing/).
```

`docs/roadmap.md`, item 18's status cell: change `specs approved 2026-10-01` to `licensing built (#197); audit log next (#198)`.

- [ ] **Step 4: Check the docs**

Run: `pnpm check:banned-terms && pnpm check:doc-paths && pnpm check:docs-images && pnpm docs:build && pnpm exec vitest run --project site`.
Expected: green. The page names no other product.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 pnpm check`

```bash
git add docs-site site packages/server/README.md CHANGELOG.md docs/roadmap.md
git commit -m "docs: editions and licenses — the guide, the server README, the changelog (#197)"
```

---

## After the last task

- Push the branch and open the PR against `main`. Its body states the rulings above, and that the
  production signing key lives at `~/.wirebench-license/signing-key-1.pem` on the machine that ran
  Task 2. The PR body carries no generated-by footer.
- `pnpm test:perf` unskipped before the push (repository gate).
- Open the follow-up issue the spec's §15 records: binding a license to one server, through a `serverId`
  in the payload matched against an id the server mints on first boot. Label it `audience: enterprise`,
  `area: server`, `priority: P3`, and link it from #199.
- The audit-log plan picks up from here. It needs `ctx.license.state()` for its read gate,
  `licenseChanged` as its first listener, and its own handling for command-line installs (ruling 13).

## Open questions for the owner

Each has a default the plan already follows.

1. **Where the signing key is generated.** By default, Task 2 generates it on the machine that runs the plan, into `~/.wirebench-license/`, readable only by its owner. To hold it somewhere else, such as an offline machine or a hardware token, generate it there and give the executor only the public PEM.
2. **Free seats stay at 5** (spec §16). The number is one constant, `COMMUNITY_SEATS`.
3. **Team invitations count against seats** (ruling 6). The alternative is counting only server invitations, which would let a team admin exceed the cap.
