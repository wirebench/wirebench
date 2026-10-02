# Wirebench Server `audit-log` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every action a Wirebench Server performs on someone's behalf is recorded as an immutable event, committed with the action, on every edition; server admins on Enterprise read and export the log, from the desktop and from the box.

**Architecture:** A new `audit-log` server module (`packages/server/src/audit-log/`) owns an append-only `audit_events` table, an in-transaction `ServerHooks.audit` hook that the other modules call through `recordAudit(ctx.hooks, tx, event)`, keyset-paged reads, a streamed newline-delimited JSON export behind `ctx.license.requireFeature('audit-log')`, and retention by age. Every existing module gains fire sites beside the statements they describe. The desktop reads the log through two IPC channels and shows an Audit tab to server admins.

**Tech Stack:** TypeScript on Node 24, Fastify (a `Readable` reply for the export), Postgres (`pg`), zod 4 (plain, ADR-0009), `ulidx` ids, React + zustand in the desktop renderer, Vitest 5, Playwright for e2e.

**Spec:** `docs/specs/2026-10-01-wirebench-server-audit-log-design.md`. Builds on `docs/specs/2026-10-01-wirebench-server-licensing-design.md` and its plan `docs/plans/2026-10-02-wirebench-server-licensing-plan.md` (branch `feat/licensing`, PR #204), whose code this plan cites by path.

## Global Constraints

- Events are recorded on every edition. Only `GET /api/v1/audit` and `GET /api/v1/audit/export` need the `audit-log` feature.
- An event commits with the action it describes: the hook runs inside the caller's transaction and is awaited; a hook throw fails the action (spec §3.1). The two exceptions are rulings 4 and 5 below.
- `details` never carries a secret, a token, a password hash or a request or response body. Its values are strings, numbers, booleans, `null` or arrays of the first three, and the serialised object is bounded at 4 KiB (`AUDIT_LIMITS.maxDetailsBytes`).
- No route updates or deletes an event. There is no `POST /audit`. The desktop never originates an event.
- Retention by age only: `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, integer 30–3650, default 365.
- Action names are a closed list (`AUDIT_ACTIONS`) referenced through the enum, never as string literals at a fire site.
- Problem codes stay the host's `{ code, message }`. New: `audit-cursor-invalid` (400).
- `GET /audit` is newest first, default page 50, maximum 200; the cursor is opaque. `GET /audit/export` is oldest first, `application/x-ndjson`, one event per line, read in batches of 1000 behind a keyset cursor, never inside a long transaction.
- The renderer imports only **types** from `shared/wire-types.ts` and nothing from the `@wirebench/engine` main entry (ESLint `no-restricted-imports`; an eager zod value import breaks every e2e under the CSP).
- Docs and code never name which product inspired a feature; `pnpm check:banned-terms` enforces it.
- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit. One commit per task. No `Co-Authored-By` or `Claude-Session` trailer. Commits as Mohammed Naami <m.naami@outlook.com>.
- No local Electron e2e windows: e2e runs in CI only.
- Server route and fire-site tests run against real Postgres (`WIREBENCH_SERVER_TEST_DATABASE_URL`; locally `docker compose -f packages/server/compose.yaml up -d db`, then `postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`). `describeDb` skips them when the variable is unset, so run them before each commit with the database up.

## Rulings made while planning

Each is a reading of the spec where the spec and the code disagree or the spec is silent. Task 11 appends them to the spec as *Revisions after planning*.

1. **CI tokens are a separate request field.** The CI guard sets `request.ciCaller` (`ci-tokens/principal.ts:22-27`), not `request.caller`, and CI tokens reach only four read routes (`CI_ROUTES`). `auditSource(request)` reads `request.caller` first, then `request.ciCaller`; no write today can have a `ci-token` actor, but the shape is in the schema for when one can.
2. **The admin command line pushes the audit hook itself.** `identity/cli.ts` builds `hooks: serverHooks()`, every list empty, and never calls `announce`. `runAdmin` pushes `auditHook(now)` onto `hooks.audit`, and the license commands call `recordAudit` directly for `license.installed` and `license.removed`, with the `system` actor.
3. **Functions without a request take an `AuditSource`.** `createInvitation`, `createPasswordReset`, `revokeOpenInvitation`, `acceptInvitation`, `linkClaims` and `addInvitedMember` have no request in scope. Each gains a `source: AuditSource` argument (`{ actor, ip?, userAgent? }`) that routes build with `auditSource(request)` and the command line passes as `SYSTEM_SOURCE`.
4. **A push has no database transaction to join.** `appendCommits` is git plumbing inside `repos.withLock`; the ref has moved before any SQL could run. `workspace.pushed` and the `secret.*` events are written on `ctx.db` right after `appendCommits` returns and before `headMoved` is announced. A failed insert there is logged at warn and does not fail the push, because the client's commits are already on main and a failure answer would make it push them again. This is the one place "commits with the action" cannot hold, and the spec gets the sentence.
5. **`license.*` arrive after the commit**, as the spec says (§3.2): the audit module listens to `licenseChanged`, looks the actor up by id, and writes on `ctx.db`. IP and user agent are absent there.
6. **The server does not parse team-secrets files, so `secret.*` events come from paths.** In a push, a change under `team-secrets/values/` is `secret.shared` when the file did not exist at the push's parent and `secret.rotated` when it did (`store.hasFile`); a change under `team-secrets/access/` or `team-secrets/keys/` is `secret.access_changed`; the key-request route's commit is `secret.access_changed` with `details.keyId`. Details carry counts and the paths' leaf names, never contents. One event per kind per push.
7. **Previous values come from a read before the write, in a transaction.** Team rename, workspace rename and default-role change, workspace delete and team delete become transactions that read the row first. `deleteGrant` and `revokeCiToken` gain `returning` clauses so the removed role and the revoked token's name are known, and so a delete that removed nothing records nothing.
8. **`issueToken` returns the token id.** It becomes `Promise<{ response: SignInResponse; tokenId: string }>`; its three callers send `.response`. `auth.signed_in` carries `tokenId` and `device`.
9. **`PATCH /users/:id` records only real transitions.** The handler writes even when nothing changes; the events fire only when `body.serverAdmin !== user.serverAdmin` or the disabled state flips, and the no-op writes go.
10. **A reset acceptance is `auth.password_changed` with `details.via: 'reset'`**, since it replaces the credential and revokes every token. The spec listed only `/me/password`.
11. **`team.created` is one event**, with `details.name`; the creator's admin membership is implied and not a second `team.member_added`.
12. **The cursor is `base64url("<at ISO>|<id>")`.** The page's `next` is present when the page is full. A cursor that does not decode is `400 audit-cursor-invalid`.
13. **The export is a Node `Readable` from an async generator.** Fastify streams it; each batch is one keyset query on `ctx.db`; the `audit.exported` row is written when the generator reaches its end, so a client that disconnects mid-stream leaves no record of an export that did not finish, and no open transaction.
14. **The capture sweeper is reused.** `CaptureSweeper` gains optional `deleteBefore` and `label` deps (defaults keep the hooks module unchanged); the audit module constructs it with `deleteAuditEventsBefore`. No second sweeper class.
15. **The Audit tab is reachable with no team selected.** `team-dialog.tsx:56` forces `license` when there is no team; it becomes `store.tab === 'audit' ? 'audit' : 'license'`.
16. **The desktop export streams through the engine's `sendHttp` stream hook**, not `ServerClient.call`, which buffers and expects JSON. Main picks the file with `pickSaveFile` and writes chunks as they arrive. The renderer never sees a path.
17. **The v1 filter bar offers a time-range preset, an action group and, when a team is selected, that team's workspaces.** Actor, team and target filters exist on the API and the command line, not in the tab.
18. **Desktop files follow the code, not the spec's paths.** Main: `src/main/ipc/audit.ts` plus `ServerClient` methods. Renderer: `src/renderer/state/audit.ts` and `features/team/audit-tab.tsx`, `audit-filter-bar.tsx`, `audit-detail.tsx`.
19. **The docs page is `docs-site/src/content/docs/guides/server-audit-log.mdx`**, beside `server-licensing.mdx`.
20. **`AUDIT_ACTIONS` drops nothing from the spec and adds nothing.** `team.renamed` has a route (`PATCH /teams/:teamId`), so it stays.

## File map

New:

- `packages/engine/src/server-api/audit.ts` — actions, actor and target kinds, event, query, page and export-query schemas, `AUDIT_LIMITS`.
- `packages/server/migrations/audit-log/0008_audit-log.sql`
- `packages/server/src/audit-log/hook.ts` — `auditHook(now)`: mints the id, bounds `details`, inserts.
- `packages/server/src/audit-log/repo.ts` — insert, filtered keyset list (both directions), delete-before.
- `packages/server/src/audit-log/cursor.ts` — encode and decode.
- `packages/server/src/audit-log/errors.ts`
- `packages/server/src/audit-log/routes.ts` — `GET /audit`, `GET /audit/export`, `exportLines`.
- `packages/server/src/audit-log/license-listener.ts`
- `packages/server/src/audit-log/secrets.ts` — pure: `secret.*` events from a push's changes (ruling 6).
- `packages/server/src/audit-log/cli.ts` — `admin audit export`.
- `packages/server/src/audit-log/module.ts`
- `apps/desktop/src/main/ipc/audit.ts`
- `apps/desktop/src/renderer/state/audit.ts`
- `apps/desktop/src/renderer/state/audit-format.ts` — pure labels and range presets, zod-free.
- `apps/desktop/src/renderer/features/team/audit-tab.tsx`, `audit-filter-bar.tsx`, `audit-detail.tsx`
- `e2e/specs/audit.spec.ts`
- `docs-site/src/content/docs/guides/server-audit-log.mdx`

Modified:

- `packages/engine/src/index.ts` — export the audit file.
- `packages/server/src/context.ts` — `AuditActorInput`, `AuditSource`, `AuditInput`, `AuditHook`, `ServerHooks.audit`, `recordAudit`, `auditSource`, `SYSTEM_SOURCE`, `ANONYMOUS_SOURCE`, `ServerModule.name`.
- `packages/server/src/config.ts` — `auditMaxAgeDays`.
- `packages/server/src/modules.ts` — `auditLogModule()` last.
- `packages/server/src/hooks/sweep.ts` — `deleteBefore` and `label` deps.
- `packages/server/src/args.ts`, `src/main.ts`, `src/identity/cli.ts`, `src/licensing/cli.ts` — the audit hook on the command line, `admin audit export`, license recording.
- `packages/server/src/identity/sessions.ts`, `invitations.ts`, `linking.ts`, `routes/auth-local.ts`, `routes/auth-oidc.ts`, `routes/me.ts`, `routes/users.ts`, `routes/invitations.ts` — fire sites.
- `packages/server/src/teams/repo.ts`, `routes/teams.ts`, `routes/members.ts`, `routes/workspaces.ts`, `routes/access.ts`, `routes/invitations.ts`, `module.ts` — fire sites.
- `packages/server/src/sync/routes/commits.ts`, `routes/key-requests.ts` — fire sites.
- `packages/server/src/hooks/routes/manage.ts` — fire sites.
- `packages/server/src/ci-tokens/repo.ts`, `routes.ts`, `module.ts` — fire sites, `hooks` in the env.
- `packages/server/test/helpers/context.ts` — a recording audit hook.
- `apps/desktop/src/shared/wire-types.ts`, `shared/ipc.ts`, `main/server-client.ts`, `main/index.ts`, `renderer/state/team.ts`, `renderer/features/team/team-dialog.tsx`, `test/mocks/wirebench-api.ts`, `test/preload-api.test.ts`
- `e2e/helpers/fake-server.ts`
- `docs-site/astro.config.mjs`, `docs-site/src/content/docs/guides/wirebench-server.mdx`, `site/src/docs-links.ts`, `site/src/pages/features.astro`, `packages/server/README.md`, `CHANGELOG.md`, `docs/roadmap.md`, `docs/specs/2026-10-01-wirebench-server-audit-log-design.md`

---

### Task 1: Shared audit wire shapes in the engine

**Files:**
- Create: `packages/engine/src/server-api/audit.ts`
- Modify: `packages/engine/src/index.ts` (after the licensing export blocks, before `ACCOUNTS_FILE_VERSION`)
- Test: `packages/engine/test/server-api/audit.test.ts`

**Interfaces:**
- Produces: `AUDIT_ACTIONS`, `auditActionSchema`, `AuditAction`; `AUDIT_ACTION_GROUPS`, `AuditActionGroup`; `AUDIT_ACTOR_KINDS`, `AuditActorKind`; `AUDIT_TARGET_KINDS`, `AuditTargetKind`; `AUDIT_LIMITS`; `auditDetailsSchema`, `AuditDetails`; `auditActorSchema`, `AuditActor`; `auditEventSchema`, `AuditEvent`; `auditQuerySchema`, `AuditQuery`; `auditExportQuerySchema`, `AuditExportQuery`; `auditPageSchema`, `AuditPage`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/server-api/audit.test.ts
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_LIMITS, auditEventSchema, auditPageSchema, auditQuerySchema } from '../../src/index.js';

const EVENT = {
  id: '01J9ZK3V8Q0000000000000001',
  at: '2026-10-01T12:34:56.789Z',
  actor: { kind: 'user', userId: '01J9ZK3V8Q00000000000000AA', email: 'a@example.com', tokenId: '01J9ZK3V8Q00000000000000BB' },
  action: 'workspace.grant_set',
  target: { kind: 'user', id: '01J9ZK3V8Q00000000000000CC' },
  workspaceId: '01J9ZK3V8Q00000000000000DD',
  teamId: '01J9ZK3V8Q00000000000000EE',
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0 (darwin)',
  details: { role: 'editor' },
};

describe('audit wire shapes (audit-log spec §3.4, §5.2)', () => {
  it('lists every action the spec names, dotted <area>.<verb>, no duplicates', () => {
    for (const action of ['auth.signed_in', 'workspace.pushed', 'secret.rotated', 'hook.signature_cleared', 'license.removed', 'audit.exported']) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS).toHaveLength(40);
  });

  it('parses an event and refuses an unknown action or a nested details value', () => {
    expect(auditEventSchema.parse(EVENT)).toEqual(EVENT);
    expect(auditEventSchema.safeParse({ ...EVENT, action: 'workspace.exploded' }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...EVENT, details: { nested: { a: 1 } } }).success).toBe(false);
    const sparse = auditEventSchema.parse({ ...EVENT, actor: { kind: 'system' }, target: { kind: 'server', id: null }, workspaceId: null, teamId: null, ip: null, userAgent: null });
    expect(sparse.ip).toBeNull();
  });

  it('bounds the page and accepts an action or a group prefix', () => {
    expect(auditQuerySchema.parse({}).limit).toBeUndefined();
    expect(auditQuerySchema.safeParse({ limit: AUDIT_LIMITS.maxPageSize + 1 }).success).toBe(false);
    expect(auditQuerySchema.parse({ action: 'workspace.' }).action).toBe('workspace.');
    expect(auditQuerySchema.parse({ action: 'workspace.pushed' }).action).toBe('workspace.pushed');
    expect(auditQuerySchema.safeParse({ action: 'Workspace' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });

  it('a page is events plus an optional cursor', () => {
    expect(auditPageSchema.parse({ events: [EVENT] }).next).toBeUndefined();
    expect(auditPageSchema.parse({ events: [], next: 'abc' }).next).toBe('abc');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/engine/test/server-api/audit.test.ts`
Expected: FAIL, `AUDIT_ACTIONS` is not exported.

- [ ] **Step 3: Write the schemas**

```ts
// packages/engine/src/server-api/audit.ts
/**
 * The audit-log wire shapes (audit-log spec §2, §3.4, §5.2). The server writes events and serves
 * them; the desktop reads pages and streams the export. Plain zod only (ADR-0009).
 *
 * `details` is flat on purpose: a fire site names fields, never spreads a body, and nothing nested
 * can smuggle a payload in (§6).
 */
import { z } from 'zod';

/** §3.2, a closed list: a fire site references the enum, never a literal. */
export const AUDIT_ACTIONS = [
  'auth.signed_in',
  'auth.sign_in_failed',
  'auth.signed_out',
  'auth.password_changed',
  'user.invited',
  'user.invitation_revoked',
  'user.created',
  'user.disabled',
  'user.enabled',
  'user.admin_granted',
  'user.admin_revoked',
  'user.password_reset_issued',
  'team.created',
  'team.renamed',
  'team.deleted',
  'team.member_added',
  'team.member_removed',
  'team.member_role_changed',
  'workspace.created',
  'workspace.deleted',
  'workspace.renamed',
  'workspace.default_role_changed',
  'workspace.grant_set',
  'workspace.grant_removed',
  'workspace.pushed',
  'secret.shared',
  'secret.rotated',
  'secret.access_changed',
  'hook.created',
  'hook.changed',
  'hook.rotated',
  'hook.deleted',
  'hook.cleared',
  'hook.signature_set',
  'hook.signature_cleared',
  'ci_token.created',
  'ci_token.revoked',
  'license.installed',
  'license.removed',
  'audit.exported',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

/** The part before the dot, for the desktop's action-group filter. */
export const AUDIT_ACTION_GROUPS = ['auth', 'user', 'team', 'workspace', 'secret', 'hook', 'ci_token', 'license', 'audit'] as const;
export type AuditActionGroup = (typeof AUDIT_ACTION_GROUPS)[number];

export const AUDIT_ACTOR_KINDS = ['user', 'ci-token', 'system', 'anonymous'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_TARGET_KINDS = ['server', 'user', 'invitation', 'team', 'workspace', 'hook', 'ci-token', 'license'] as const;
export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

export const AUDIT_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 200,
  /** Rows per keyset query behind the export stream (§3.4). */
  exportBatch: 1000,
  /** `details`, serialised; a larger object is cut down with `_truncated: true` (§4.2). */
  maxDetailsBytes: 4096,
  maxUserAgentLength: 512,
  /** `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` (§4.1). */
  maxAgeDays: { min: 30, max: 3650, default: 365 },
} as const;

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const auditDetailsSchema = z.record(z.string().min(1).max(64), z.union([scalar, z.null(), z.array(scalar).max(64)]));
export type AuditDetails = z.infer<typeof auditDetailsSchema>;

/** `email` is the user's email at the time of the event, copied into the row (§3.4). */
export const auditActorSchema = z.object({
  kind: z.enum(AUDIT_ACTOR_KINDS),
  userId: z.string().optional(),
  email: z.string().optional(),
  tokenId: z.string().optional(),
  /** A CI token's workspace (plan ruling 1). */
  workspaceId: z.string().optional(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  actor: auditActorSchema,
  action: auditActionSchema,
  target: z.object({ kind: z.enum(AUDIT_TARGET_KINDS), id: z.string().nullable() }),
  workspaceId: z.string().nullable(),
  teamId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: auditDetailsSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** `GET /audit` (§3.4). `action` is exact, or a group prefix ending in a dot. `to` is exclusive. */
export const auditQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  action: z.string().regex(/^[a-z_]+\.([a-z_]+)?$/, 'an action, or a group followed by a dot').optional(),
  actorUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
  targetKind: z.enum(AUDIT_TARGET_KINDS).optional(),
  targetId: z.string().optional(),
  /** Opaque; from the previous page's `next`. */
  after: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(AUDIT_LIMITS.maxPageSize).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** `GET /audit/export` and `admin audit export`: the same filters, no paging. */
export const auditExportQuerySchema = auditQuerySchema.omit({ after: true, limit: true });
export type AuditExportQuery = z.infer<typeof auditExportQuerySchema>;

export const auditPageSchema = z.object({ events: z.array(auditEventSchema), next: z.string().optional() });
export type AuditPage = z.infer<typeof auditPageSchema>;
```

In `packages/engine/src/index.ts`, right after the licensing `export type { … } from './server-api/licensing.js';` block (line 1742 on `feat/licensing`):

```ts
export {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_LIMITS,
  AUDIT_TARGET_KINDS,
  auditActionSchema,
  auditActorSchema,
  auditDetailsSchema,
  auditEventSchema,
  auditExportQuerySchema,
  auditPageSchema,
  auditQuerySchema,
} from './server-api/audit.js';
export type {
  AuditAction,
  AuditActionGroup,
  AuditActor,
  AuditActorKind,
  AuditDetails,
  AuditEvent,
  AuditExportQuery,
  AuditPage,
  AuditQuery,
  AuditTargetKind,
} from './server-api/audit.js';
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm exec vitest run packages/engine/test/server-api/audit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/engine/src/server-api/audit.ts packages/engine/src/index.ts packages/engine/test/server-api/audit.test.ts
git commit -m "feat(engine): audit-log wire shapes — actions, events, queries and pages (#198)"
```

---

### Task 2: Context plumbing, the table, the hook and the repo

**Files:**
- Modify: `packages/server/src/context.ts`
- Create: `packages/server/migrations/audit-log/0008_audit-log.sql`
- Create: `packages/server/src/audit-log/hook.ts`, `repo.ts`, `cursor.ts`, `errors.ts`
- Modify: `packages/server/test/helpers/context.ts`
- Test: `packages/server/test/unit/audit-log/hook.test.ts`, `test/unit/audit-log/cursor.test.ts`, `test/integration/audit-log/repo.test.ts`

**Interfaces:**
- Consumes: Task 1's types; `Querier`, `ServerHooks`, `serverHooks()` from `context.ts`; `newId()` from `identity/tokens.ts`; `problem()` from `problem.ts`; `Caller` (`identity/guard.ts`) and `CiCaller` (`ci-tokens/principal.ts`) on the Fastify request.
- Produces (in `context.ts`): `AuditActorInput`, `AuditSource`, `AuditInput`, `AuditHook`, `ServerHooks.audit`, `recordAudit(hooks, tx, event)`, `auditSource(request)`, `SYSTEM_SOURCE`, `ANONYMOUS_SOURCE`. In the module: `auditHook(now): AuditHook`, `boundDetails(details)`, `insertAuditEvent`, `AuditFilter`, `listAuditEvents(db, filter, page)`, `listAuditEventsAscending(db, filter, after, limit)`, `deleteAuditEventsBefore(db, cutoff, limit)`, `Cursor`, `encodeCursor`, `decodeCursor`, `cursorInvalid()`. In the test helpers: `recordingAudit(hooks): AuditInput[]`.

- [ ] **Step 1: Context plumbing**

In `packages/server/src/context.ts`:

1. Extend the Fastify type import to `import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';` and add `import type { AuditAction, AuditDetails, AuditTargetKind } from '@wirebench/engine';`.
2. Above `ServerHooks`, add:

```ts
/** Who did it (audit-log spec §2, plan ruling 1). `email` is copied at event time, so a renamed account still reads. */
export type AuditActorInput =
  | { readonly kind: 'user'; readonly userId: string; readonly email: string; readonly tokenId?: string }
  | { readonly kind: 'ci-token'; readonly tokenId: string; readonly workspaceId: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'anonymous' };

/** The request facts a fire site has; a function without a request receives one of these (plan ruling 3). */
export interface AuditSource {
  readonly actor: AuditActorInput;
  readonly ip?: string;
  readonly userAgent?: string;
}

/** One event before it has an id and a time (audit-log spec §3.1). `details` is flat; the hook bounds it. */
export interface AuditInput extends AuditSource {
  readonly action: AuditAction;
  readonly target: { readonly kind: AuditTargetKind; readonly id?: string };
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly details?: AuditDetails;
}

/** Runs inside the caller's transaction and is awaited (R1): a throw fails the action. */
export type AuditHook = (tx: Querier, event: AuditInput) => Promise<void>;

export const SYSTEM_SOURCE: AuditSource = { actor: { kind: 'system' } };
export const ANONYMOUS_SOURCE: AuditSource = { actor: { kind: 'anonymous' } };
```

3. Add `readonly audit: AuditHook[];` to `ServerHooks` and `audit: [],` to `serverHooks()`. In the doc comment's **Hooks** sentence, name both: "`invitationAccepted` (teams-access §3.4) and `audit` (audit-log §3.1) run inside the caller's transaction and are awaited."
4. Below `runInvitationAccepted`, add:

```ts
/** Records one event through every audit hook, in order, inside `tx`; the first throw propagates (audit-log §3.1). */
export async function recordAudit(hooks: ServerHooks, tx: Querier, event: AuditInput): Promise<void> {
  for (const hook of hooks.audit) await hook(tx, event);
}

/**
 * The actor and request facts for a fire site in a route (plan ruling 1): a signed-in user first, then
 * a CI token, then anonymous. `request.ip` honours `trustProxy`; the user agent is bounded, never parsed.
 */
export function auditSource(request: FastifyRequest): AuditSource {
  const header = request.headers['user-agent'];
  const userAgent = typeof header === 'string' ? header.slice(0, 512) : undefined;
  const base = { ip: request.ip, ...(userAgent !== undefined ? { userAgent } : {}) };
  if (request.caller !== undefined) {
    const { id, email, tokenId } = request.caller;
    return { ...base, actor: { kind: 'user', userId: id, email, tokenId } };
  }
  if (request.ciCaller !== undefined) {
    return { ...base, actor: { kind: 'ci-token', tokenId: request.ciCaller.tokenId, workspaceId: request.ciCaller.workspaceId } };
  }
  return { ...base, actor: { kind: 'anonymous' } };
}
```

`request.caller` and `request.ciCaller` are Fastify request augmentations declared in `identity/guard.ts` and `ci-tokens/principal.ts`. If `tsc` reports them unknown in `context.ts`, add `import type {} from './identity/guard.js';` and `import type {} from './ci-tokens/principal.js';` beside the other type imports (type-only, so no runtime cycle).

5. Change `ServerModule.name` to `'identity' | 'licensing' | 'teams-access' | 'server-sync' | 'webhook-capture' | 'ci-tokens' | 'live-updates' | 'audit-log'`.

In `packages/server/test/helpers/context.ts`, add the recorder every fire-site test uses:

```ts
import type { AuditInput, ServerHooks } from '../../src/context.js';

/** Pushes a hook that keeps every event; `events` is what a test asserts on. */
export function recordingAudit(hooks: ServerHooks): AuditInput[] {
  const events: AuditInput[] = [];
  hooks.audit.push((_tx, event) => {
    events.push(event);
    return Promise.resolve();
  });
  return events;
}
```

- [ ] **Step 2: Write the failing cursor and hook unit tests**

```ts
// packages/server/test/unit/audit-log/cursor.test.ts
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/audit-log/cursor.js';

describe('audit cursor (plan ruling 12)', () => {
  const cursor = { at: '2026-10-01T12:34:56.789Z', id: '01J9ZK3V8Q0000000000000001' };
  it('round-trips and is opaque base64url', () => {
    const text = encodeCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(text)).toEqual(cursor);
  });
  it('refuses junk, a missing separator, a bad date and a bad id', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    for (const bad of ['', '!!!', b64('nodash'), b64('yesterday|01J9ZK3V8Q0000000000000001'), b64('2026-10-01T12:34:56.789Z|short'), b64('a|b|c')]) {
      expect(() => decodeCursor(bad)).toThrow(/cursor/);
    }
  });
});
```

```ts
// packages/server/test/unit/audit-log/hook.test.ts
import { describe, expect, it } from 'vitest';
import { auditHook, boundDetails } from '../../../src/audit-log/hook.js';
import type { Querier } from '../../../src/context.js';

function capturing(): { db: Querier; statements: { text: string; params: readonly unknown[] }[] } {
  const statements: { text: string; params: readonly unknown[] }[] = [];
  return {
    statements,
    db: {
      query: (text, params = []) => {
        statements.push({ text, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    },
  };
}

describe('auditHook (audit-log spec §3.1, §4.2)', () => {
  it('inserts one row with a ULID, the clock, and the actor flattened', async () => {
    const { db, statements } = capturing();
    const now = new Date('2026-10-01T12:00:00Z');
    await auditHook(() => now)(db, {
      actor: { kind: 'user', userId: 'U1', email: 'a@example.com', tokenId: 'T1' },
      ip: '203.0.113.7',
      userAgent: 'Wirebench/3.1.0',
      action: 'team.created',
      target: { kind: 'team', id: 'TEAM1' },
      teamId: 'TEAM1',
      details: { name: 'Payments' },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toMatch(/insert into audit_events/);
    const p = statements[0]!.params;
    expect(p[0]).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(p[1]).toEqual(now);
    expect(p.slice(2, 6)).toEqual(['user', 'U1', 'a@example.com', 'T1']);
    expect(p[6]).toBe('team.created');
    expect(p.slice(7, 11)).toEqual(['team', 'TEAM1', null, 'TEAM1']);
    expect(p.slice(11, 13)).toEqual(['203.0.113.7', 'Wirebench/3.1.0']);
    expect(JSON.parse(p[13] as string)).toEqual({ name: 'Payments' });
    expect(p[14]).toBeNull();
  });

  it('a system actor has no ids, an absent ip is null, no details is {}', async () => {
    const { db, statements } = capturing();
    await auditHook(() => new Date())(db, { actor: { kind: 'system' }, action: 'audit.exported', target: { kind: 'server' } });
    const p = statements[0]!.params;
    expect(p.slice(2, 6)).toEqual(['system', null, null, null]);
    expect(p[8]).toBeNull();
    expect(p[11]).toBeNull();
    expect(p[13]).toBe('{}');
  });

  it('a CI token actor carries its token and workspace', async () => {
    const { db, statements } = capturing();
    await auditHook(() => new Date())(db, { actor: { kind: 'ci-token', tokenId: 'CT1', workspaceId: 'W1' }, action: 'hook.cleared', target: { kind: 'hook', id: 'H1' }, workspaceId: 'W1' });
    const p = statements[0]!.params;
    expect(p.slice(2, 6)).toEqual(['ci-token', null, null, 'CT1']);
    expect(p[14]).toBe('W1');
  });

  it('bounds details at 4 KiB and marks the truncation', () => {
    const bounded = boundDetails({ note: 'x'.repeat(5000), kept: 'yes' });
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(4096);
    expect(bounded['_truncated']).toBe(true);
    expect(bounded['kept']).toBe('yes');
    expect(boundDetails({ a: 1 })).toEqual({ a: 1 });
    expect(boundDetails(undefined)).toEqual({});
  });

  it('a failing insert rejects, so the action rolls back with it', async () => {
    const db: Querier = { query: () => Promise.reject(new Error('connection lost')) };
    await expect(auditHook(() => new Date())(db, { actor: { kind: 'anonymous' }, action: 'auth.sign_in_failed', target: { kind: 'server' } })).rejects.toThrow('connection lost');
  });
});
```

- [ ] **Step 3: Run both to see them fail**

Run: `pnpm exec vitest run packages/server/test/unit/audit-log/`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write errors, cursor, hook, repo and the migration**

```ts
// packages/server/src/audit-log/errors.ts
/** Every `audit-*` problem (audit-log spec §3.4). */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const cursorInvalid = (): WirebenchError =>
  problem('audit-cursor-invalid', 'The page cursor is not one this server issued. Start from the first page.', 400);
```

```ts
// packages/server/src/audit-log/cursor.ts
/**
 * The opaque page cursor (plan ruling 12): `base64url("<at ISO>|<id>")`. `(at, id)` is the table's
 * order, so a page continues exactly after the last row the client saw, whatever arrived meanwhile.
 */
import { cursorInvalid } from './errors.js';

export interface Cursor {
  readonly at: string;
  readonly id: string;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(text: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw cursorInvalid();
  const parts = Buffer.from(text, 'base64url').toString('utf8').split('|');
  const [at, id] = parts;
  if (parts.length !== 2 || at === undefined || id === undefined) throw cursorInvalid();
  if (Number.isNaN(Date.parse(at)) || !ULID.test(id)) throw cursorInvalid();
  return { at, id };
}
```

```ts
// packages/server/src/audit-log/hook.ts
/**
 * The hook every fire site reaches through `recordAudit` (audit-log spec §3.1): one insert, inside the
 * caller's transaction, awaited. It mints the id and reads the clock, so a fire site states only what
 * happened. `details` is bounded (§4.2) and never built from a body (§6).
 */
import { AUDIT_LIMITS, type AuditDetails } from '@wirebench/engine';
import type { AuditHook, AuditInput, Querier } from '../context.js';
import { newId } from '../identity/tokens.js';
import { insertAuditEvent } from './repo.js';

const size = (value: AuditDetails): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * At or under `maxDetailsBytes` serialised. Over it, `_truncated: true` is set and the longest values
 * are cut (strings shortened, then whole keys dropped) until it fits. Deterministic, so a test can
 * assert the shape.
 */
export function boundDetails(details: AuditDetails | undefined): AuditDetails {
  if (details === undefined) return {};
  if (size(details) <= AUDIT_LIMITS.maxDetailsBytes) return details;
  const cut: Record<string, AuditDetails[string]> = { ...details, _truncated: true };
  const byLength = () =>
    Object.entries(cut)
      .filter(([key]) => key !== '_truncated')
      .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
  for (let guard = 0; size(cut) > AUDIT_LIMITS.maxDetailsBytes && guard < 1000; guard++) {
    const [longest] = byLength();
    if (longest === undefined) break;
    const [key, value] = longest;
    const over = size(cut) - AUDIT_LIMITS.maxDetailsBytes;
    if (typeof value === 'string' && value.length > over + 1) cut[key] = `${value.slice(0, value.length - over - 1)}…`;
    else delete cut[key];
  }
  return cut;
}

export function auditHook(now: () => Date): AuditHook {
  return (tx: Querier, event: AuditInput) =>
    insertAuditEvent(tx, { ...event, id: newId(), at: now(), details: boundDetails(event.details) });
}
```

```ts
// packages/server/src/audit-log/repo.ts
/** The append-only `audit_events` table (audit-log spec §4.2). Raw SQL over `Querier`, like every module's repo. */
import type { AuditDetails, AuditEvent, AuditTargetKind } from '@wirebench/engine';
import type { AuditInput, Querier } from '../context.js';
import type { Cursor } from './cursor.js';

export interface AuditRowInput extends AuditInput {
  readonly id: string;
  readonly at: Date;
  readonly details: AuditDetails;
}

const COLUMNS =
  'id, at, actor_kind as "actorKind", actor_user_id as "actorUserId", actor_email as "actorEmail", actor_token_id as "actorTokenId", ' +
  'actor_workspace_id as "actorWorkspaceId", action, target_kind as "targetKind", target_id as "targetId", workspace_id as "workspaceId", ' +
  'team_id as "teamId", host(ip) as ip, user_agent as "userAgent", details';

export async function insertAuditEvent(db: Querier, row: AuditRowInput): Promise<void> {
  const actor = row.actor;
  await db.query(
    `insert into audit_events (id, at, actor_kind, actor_user_id, actor_email, actor_token_id, action, target_kind, target_id,
       workspace_id, team_id, ip, user_agent, details, actor_workspace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [
      row.id,
      row.at,
      actor.kind,
      actor.kind === 'user' ? actor.userId : null,
      actor.kind === 'user' ? actor.email : null,
      actor.kind === 'user' ? (actor.tokenId ?? null) : actor.kind === 'ci-token' ? actor.tokenId : null,
      row.action,
      row.target.kind,
      row.target.id ?? null,
      row.workspaceId ?? null,
      row.teamId ?? null,
      row.ip ?? null,
      row.userAgent ?? null,
      JSON.stringify(row.details),
      actor.kind === 'ci-token' ? actor.workspaceId : null,
    ],
  );
}

export interface AuditFilter {
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
  /** Exact, or a group prefix ending in a dot. */
  readonly action?: string;
  readonly actorUserId?: string;
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly targetKind?: AuditTargetKind;
  readonly targetId?: string;
}

function where(filter: AuditFilter, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace('?', `$${String(params.length)}`));
  };
  if (filter.from !== undefined) add('at >= ?', filter.from);
  if (filter.to !== undefined) add('at < ?', filter.to);
  if (filter.action !== undefined) {
    // The query schema allows only [a-z_.], so the prefix needs no LIKE escaping.
    if (filter.action.endsWith('.')) add('action like ?', `${filter.action}%`);
    else add('action = ?', filter.action);
  }
  if (filter.actorUserId !== undefined) add('actor_user_id = ?', filter.actorUserId);
  if (filter.workspaceId !== undefined) add('workspace_id = ?', filter.workspaceId);
  if (filter.teamId !== undefined) add('team_id = ?', filter.teamId);
  if (filter.targetKind !== undefined) add('target_kind = ?', filter.targetKind);
  if (filter.targetId !== undefined) add('target_id = ?', filter.targetId);
  return clauses;
}

type Raw = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const opt = (value: unknown): string | undefined => text(value) ?? undefined;

function toEvent(raw: Raw): AuditEvent {
  const kind = text(raw['actorKind']) as AuditEvent['actor']['kind'];
  const actor: AuditEvent['actor'] =
    kind === 'user'
      ? { kind, userId: opt(raw['actorUserId']), email: opt(raw['actorEmail']), tokenId: opt(raw['actorTokenId']) }
      : kind === 'ci-token'
        ? { kind, tokenId: opt(raw['actorTokenId']), workspaceId: opt(raw['actorWorkspaceId']) }
        : { kind };
  const at = raw['at'];
  const details = raw['details'];
  return {
    id: text(raw['id']) ?? '',
    at: at instanceof Date ? at.toISOString() : (text(at) ?? ''),
    actor,
    action: text(raw['action']) as AuditEvent['action'],
    target: { kind: text(raw['targetKind']) as AuditTargetKind, id: text(raw['targetId']) },
    workspaceId: text(raw['workspaceId']),
    teamId: text(raw['teamId']),
    ip: text(raw['ip']),
    userAgent: text(raw['userAgent']),
    details: (typeof details === 'object' && details !== null ? details : {}) as AuditDetails,
  };
}

function select(filter: AuditFilter, after: Cursor | undefined, limit: number, direction: 'desc' | 'asc'): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses = where(filter, params);
  if (after !== undefined) {
    params.push(new Date(after.at), after.id);
    clauses.push(`(at, id) ${direction === 'desc' ? '<' : '>'} ($${String(params.length - 1)}, $${String(params.length)})`);
  }
  params.push(limit);
  const whereSql = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  return { sql: `select ${COLUMNS} from audit_events ${whereSql} order by at ${direction}, id ${direction} limit $${String(params.length)}`, params };
}

/** Newest first; `after` continues below the cursor's row (§3.4). */
export async function listAuditEvents(db: Querier, filter: AuditFilter, page: { readonly after?: Cursor; readonly limit: number }): Promise<AuditEvent[]> {
  const { sql, params } = select(filter, page.after, page.limit, 'desc');
  return (await db.query<Raw>(sql, params)).rows.map(toEvent);
}

/** Oldest first, for the export (§3.4): `after` is the last row of the previous batch. */
export async function listAuditEventsAscending(db: Querier, filter: AuditFilter, after: Cursor | undefined, limit: number): Promise<AuditEvent[]> {
  const { sql, params } = select(filter, after, limit, 'asc');
  return (await db.query<Raw>(sql, params)).rows.map(toEvent);
}

/** Retention (§3.3): at most `limit` rows older than `cutoff`, oldest first; returns how many went. */
export async function deleteAuditEventsBefore(db: Querier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query('delete from audit_events where id in (select id from audit_events where at < $1 order by at, id limit $2)', [cutoff, limit]);
  return result.rowCount ?? 0;
}
```

```sql
-- packages/server/migrations/audit-log/0008_audit-log.sql
-- Wirebench Server 0008: the audit log (audit-log spec §4.2). Append-only by the absence of routes:
-- nothing updates or deletes a row except retention. No foreign keys: an event outlives the user,
-- workspace or hook it names. (at, id) is the order and the page cursor; id is a ULID minted at insert.
create table audit_events (
  id                 text primary key,
  at                 timestamptz not null default now(),
  actor_kind         text not null check (actor_kind in ('user', 'ci-token', 'system', 'anonymous')),
  actor_user_id      text,
  actor_email        text,
  actor_token_id     text,
  actor_workspace_id text,
  action             text not null,
  target_kind        text not null,
  target_id          text,
  workspace_id       text,
  team_id            text,
  ip                 inet,
  user_agent         text,
  details            jsonb not null default '{}'::jsonb
);
create index audit_events_at on audit_events (at desc, id desc);
create index audit_events_workspace_at on audit_events (workspace_id, at desc) where workspace_id is not null;
create index audit_events_actor_at on audit_events (actor_user_id, at desc) where actor_user_id is not null;
create index audit_events_action_at on audit_events (action, at desc);
```

- [ ] **Step 5: Run the unit tests to see them pass**

Run: `pnpm exec vitest run packages/server/test/unit/audit-log/`
Expected: PASS, 7 tests.

- [ ] **Step 6: Write the repo integration test**

The integration suites apply migrations through the harnesses (`identityHarness` and friends run `allMigrations(modules)`). This test needs only the audit table, so it applies the file directly with the migration runner the harness uses (`packages/server/src/db/migrate.ts`; read its exported name, `applyMigrations` or similar, and the shape `allMigrations` returns in `serve.ts`).

```ts
// packages/server/test/integration/audit-log/repo.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../../src/audit-log/cursor.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { deleteAuditEventsBefore, listAuditEvents, listAuditEventsAscending } from '../../../src/audit-log/repo.js';
import { AUDIT_LOG_MIGRATIONS_DIR } from '../../../src/audit-log/module.js'; // Task 3 creates it; until then inline the path
import type { Database } from '../../../src/context.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { applyMigrationsFrom } from '../../helpers/migrations.js'; // see the note above this block

describeDb('audit_events repo (audit-log spec §3.4, §4.2)', () => {
  let t: TestDatabase;
  let db: Database;
  let tick = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => new Date((tick += 1000));
  const record = auditHook(clock);

  beforeAll(async () => {
    t = await testDatabase();
    db = t.db;
    await applyMigrationsFrom(db, ['migrations/0001_init.sql', AUDIT_LOG_MIGRATIONS_DIR]);
    for (let i = 0; i < 7; i++) {
      await record(db, {
        actor: i % 2 === 0 ? { kind: 'user', userId: 'U1', email: 'a@example.com' } : { kind: 'system' },
        ip: i % 2 === 0 ? '203.0.113.7' : undefined,
        action: i < 4 ? 'workspace.pushed' : 'team.created',
        target: { kind: i < 4 ? 'workspace' : 'team', id: `T${String(i)}` },
        ...(i < 4 ? { workspaceId: 'W1' } : { teamId: 'TEAM1' }),
        details: { n: i },
      });
    }
  });
  afterAll(() => t.close());

  it('pages newest first through an opaque cursor, no row twice and none missing', async () => {
    const first = await listAuditEvents(db, {}, { limit: 3 });
    expect(first.map((e) => e.details['n'])).toEqual([6, 5, 4]);
    const cursor = decodeCursor(encodeCursor({ at: first[2]!.at, id: first[2]!.id }));
    const second = await listAuditEvents(db, {}, { after: cursor, limit: 3 });
    expect(second.map((e) => e.details['n'])).toEqual([3, 2, 1]);
    const third = await listAuditEvents(db, {}, { after: { at: second[2]!.at, id: second[2]!.id }, limit: 3 });
    expect(third.map((e) => e.details['n'])).toEqual([0]);
  });

  it('filters by prefix, exact action, actor, workspace, team, target and a half-open time range', async () => {
    expect(await listAuditEvents(db, { action: 'workspace.' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { action: 'team.created' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(db, { actorUserId: 'U1' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { workspaceId: 'W1', targetKind: 'workspace' }, { limit: 50 })).toHaveLength(4);
    expect(await listAuditEvents(db, { teamId: 'TEAM1' }, { limit: 50 })).toHaveLength(3);
    expect(await listAuditEvents(db, { targetId: 'T5' }, { limit: 50 })).toHaveLength(1);
    const all = await listAuditEventsAscending(db, {}, undefined, 50);
    const range = await listAuditEvents(db, { from: new Date(all[2]!.at), to: new Date(all[5]!.at) }, { limit: 50 });
    expect(range.map((e) => e.details['n'])).toEqual([4, 3, 2]);
  });

  it('ascends in batches for the export', async () => {
    const a = await listAuditEventsAscending(db, {}, undefined, 4);
    expect(a.map((e) => e.details['n'])).toEqual([0, 1, 2, 3]);
    const b = await listAuditEventsAscending(db, {}, { at: a[3]!.at, id: a[3]!.id }, 4);
    expect(b.map((e) => e.details['n'])).toEqual([4, 5, 6]);
  });

  it('a user actor round-trips with email and ip; a system actor has neither', async () => {
    const [user, sys] = await listAuditEventsAscending(db, { action: 'workspace.pushed' }, undefined, 2);
    expect(user!.actor).toEqual({ kind: 'user', userId: 'U1', email: 'a@example.com', tokenId: undefined });
    expect(user!.ip).toBe('203.0.113.7');
    expect(sys!.actor).toEqual({ kind: 'system' });
    expect(sys!.ip).toBeNull();
  });

  it('deletes before a cutoff in bounded batches, oldest first', async () => {
    const all = await listAuditEventsAscending(db, {}, undefined, 50);
    const cutoff = new Date(all[3]!.at);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(2);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(1);
    expect(await deleteAuditEventsBefore(db, cutoff, 2)).toBe(0);
    expect((await listAuditEventsAscending(db, {}, undefined, 50)).map((e) => e.details['n'])).toEqual([3, 4, 5, 6]);
  });
});
```

If no helper applies a list of migration sources, write `test/helpers/migrations.ts` with `applyMigrationsFrom(db, sources: string[])` on top of `db/migrate.ts`'s runner (ten lines), and inline `AUDIT_LOG_MIGRATIONS_DIR` as `fileURLToPath(new URL('../../../migrations/audit-log/', import.meta.url))` until Task 3 exports it.

- [ ] **Step 7: Run the integration test**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/repo.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src/context.ts packages/server/migrations/audit-log packages/server/src/audit-log packages/server/test
git commit -m "feat(server): the audit_events table, the in-transaction audit hook and the keyset repo (#198)"
```

---

### Task 3: The `audit-log` module: routes, export stream, retention, license listener

**Files:**
- Create: `packages/server/src/audit-log/routes.ts`, `license-listener.ts`, `module.ts`
- Modify: `packages/server/src/hooks/sweep.ts` (ruling 14), `packages/server/src/config.ts`, `packages/server/src/modules.ts`, `packages/server/src/live/module.ts` (export `realTimer` if it is not)
- Modify (generated): `packages/server/README.md` and `docs-site/src/content/docs/guides/wirebench-server.mdx` config tables, via `pnpm docs:server-config`
- Test: `packages/server/test/unit/hooks/sweep.test.ts` (one case), `packages/server/test/unit/config.test.ts` (one case), `packages/server/test/integration/audit-log/routes.test.ts`

**Interfaces:**
- Consumes: Task 2; `ctx.license.requireFeature('audit-log')`; `requireServerAdmin` (`identity/guard.ts`); `jsonSchema` (`schema.ts`); `CaptureSweeper` (`hooks/sweep.ts`), `SetTimer` (`hooks/env.ts`), `realTimer` (`live/module.ts`); `findUserById` (`identity/repo.ts`); `LicenseChanged` (`context.ts`).
- Produces: `auditLogModule(options?: { now?; setTimer? }): ServerModule`; `AUDIT_LOG_MIGRATIONS_DIR`; `auditRoutes(env)`; `filterOf(query): AuditFilter`; `exportLines(db, filter, onEnd): AsyncGenerator<string>`; `exportedEvent(source, query, count): AuditInput`; `licenseListener(env)`.

- [ ] **Step 1: Generalise the sweeper**

In `packages/server/src/hooks/sweep.ts`, add to `SweeperDeps`:

```ts
  /** What to delete (audit-log plan ruling 14); captures by default. */
  readonly deleteBefore?: (db: Querier, cutoff: Date, limit: number) => Promise<number>;
  /** The warn line's subject; `capture sweep` by default. */
  readonly label?: string;
```

In `tick()`, log `` `${this.deps.label ?? 'capture sweep'} failed` ``; in `sweep()`, call `(this.deps.deleteBefore ?? deleteCapturesBefore)(this.deps.db, cutoff, batch)`. Add to `test/unit/hooks/sweep.test.ts`, using that file's own `fakeDb`, `timers` and logger fakes:

```ts
it('deletes through an injected function in batches', async () => {
  const limits: number[] = [];
  const t = timers();
  const sweeper = new CaptureSweeper({
    db: fakeDb([]), maxAgeDays: 1, now: () => new Date(), setTimer: t.setTimer, log: fakeLog(), batchSize: 2, label: 'audit sweep',
    deleteBefore: (_db, _cutoff, limit) => { limits.push(limit); return Promise.resolve(limits.length === 1 ? 2 : 0); },
  });
  expect(await sweeper.runOnce()).toBe(2);
  expect(limits).toEqual([2, 2]);
  await sweeper.stop();
});
```

- [ ] **Step 2: Configuration**

In `packages/server/src/config.ts`, after `hooksMaxAgeDays` in the input schema: `auditMaxAgeDays: integerText(30, 3650, '365'),`. In `CONFIG_VARIABLES`, after the last hooks row:

```ts
  {
    env: 'WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS',
    key: 'auditMaxAgeDays',
    required: false,
    defaultText: '365',
    secret: false,
    description: 'Audit events older than this many days are deleted (30–3650).',
  },
```

Run `pnpm docs:server-config` (no `--check`) to regenerate the two tables. In `test/unit/config.test.ts`, beside the hooks cases: default `365`, `'29'` refused, `'3650'` accepted.

- [ ] **Step 3: Write the failing routes test**

```ts
// packages/server/test/integration/audit-log/routes.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

describeDb('GET /audit and /audit/export (audit-log spec §3.4)', () => {
  const keys = testKeys();
  let h: Awaited<ReturnType<typeof licensingHarness>>;
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let member: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    h = await licensingHarness(keys, { extra: (clock) => [auditLogModule({ now: () => clock.now })] });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    member = await signedInUser(h, { email: 'm@example.com' });
  });
  afterAll(() => h.close());

  it('Community: an admin is refused with licensing-feature-required', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/audit', headers: admin.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
  });

  it('a member hears identity-forbidden before the feature is checked', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/audit', headers: member.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'identity-forbidden' });
  });

  it('Enterprise: pages newest first with a cursor, filters by prefix, refuses a bad cursor', async () => {
    const put = await h.app.inject({ method: 'PUT', url: '/api/v1/license', headers: admin.headers, payload: { license: license(keys, { edition: 'enterprise' }) } });
    expect(put.statusCode).toBe(200);
    const page = await h.app.inject({ method: 'GET', url: '/api/v1/audit?limit=1', headers: admin.headers });
    expect(page.statusCode).toBe(200);
    const body = page.json<{ events: { action: string; actor: { email?: string } }[]; next?: string }>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.action).toBe('license.installed');
    expect(body.events[0]!.actor.email).toBe('root@example.com');
    expect(body.next).toBeTypeOf('string');
    const rest = await h.app.inject({ method: 'GET', url: `/api/v1/audit?limit=200&after=${encodeURIComponent(body.next!)}`, headers: admin.headers });
    expect(rest.statusCode).toBe(200);
    expect(rest.json<{ next?: string }>().next).toBeUndefined();
    const only = await h.app.inject({ method: 'GET', url: '/api/v1/audit?action=license.', headers: admin.headers });
    for (const e of only.json<{ events: { action: string }[] }>().events) expect(e.action.startsWith('license.')).toBe(true);
    const bad = await h.app.inject({ method: 'GET', url: '/api/v1/audit?after=!!!', headers: admin.headers });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'audit-cursor-invalid' });
  });

  it('exports oldest first as NDJSON and records the export with the admin as actor', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/audit/export', headers: admin.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    const lines = res.body.trimEnd().split('\n').map((line) => JSON.parse(line) as { at: string });
    expect(lines.length).toBeGreaterThan(0);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.at >= lines[i - 1]!.at).toBe(true);
    const after = await h.app.inject({ method: 'GET', url: '/api/v1/audit?action=audit.exported', headers: admin.headers });
    const exported = after.json<{ events: { details: Record<string, unknown>; actor: { email?: string } }[] }>().events[0]!;
    expect(exported.details['count']).toBe(lines.length);
    expect(exported.actor.email).toBe('root@example.com');
  });

  it('license removal is recorded by the listener, after the commit, with the admin as actor', async () => {
    await h.app.inject({ method: 'DELETE', url: '/api/v1/license', headers: admin.headers });
    await new Promise((resolve) => setTimeout(resolve, 50)); // the listener writes after the announce
    const rows = await h.db.query<{ action: string; actor_email: string }>(`select action, actor_email from audit_events where action = 'license.removed'`);
    expect(rows.rows).toEqual([{ action: 'license.removed', actor_email: 'root@example.com' }]);
  });
});
```

`licensingHarness(keys, { extra })` is on `feat/licensing` (`test/helpers/licensing.ts`): `extra: (clock) => ServerModule[]`, appended after its own modules. If its signature differs, adapt the call, not the harness. The sign-in rows that make the export non-empty come from Task 4; before that, `license.installed` alone keeps `lines.length > 0`.

- [ ] **Step 4: Run it to see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/routes.test.ts`
Expected: FAIL, `auditLogModule` not found.

- [ ] **Step 5: Write the routes, the listener and the module**

```ts
// packages/server/src/audit-log/routes.ts
/**
 * `GET /audit` and `GET /audit/export` (audit-log spec §3.4): server admins, then the feature gate,
 * so a member hears `identity-forbidden` and an admin on Community hears `licensing-feature-required`.
 * The export is a `Readable` over an async generator (plan ruling 13): one keyset query per batch on
 * the pool, no transaction held, and the `audit.exported` row written only when the stream ends.
 */
import { Readable } from 'node:stream';
import {
  AUDIT_LIMITS,
  auditExportQuerySchema,
  auditPageSchema,
  auditQuerySchema,
  type AuditExportQuery,
  type AuditPage,
  type AuditQuery,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource, recordAudit, type AuditInput, type AuditSource, type LicenseService, type Querier, type ServerHooks } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { jsonSchema } from '../schema.js';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';
import { listAuditEvents, listAuditEventsAscending, type AuditFilter } from './repo.js';

export interface AuditRoutesEnv {
  readonly db: Querier;
  readonly hooks: ServerHooks;
  readonly license: LicenseService;
}

export function filterOf(query: AuditExportQuery): AuditFilter {
  return {
    ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
    ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
    ...(query.action !== undefined ? { action: query.action } : {}),
    ...(query.actorUserId !== undefined ? { actorUserId: query.actorUserId } : {}),
    ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
    ...(query.teamId !== undefined ? { teamId: query.teamId } : {}),
    ...(query.targetKind !== undefined ? { targetKind: query.targetKind } : {}),
    ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
  };
}

/**
 * One NDJSON line per event, oldest first, `exportBatch` rows a query. Shared with the command line
 * (§3.5). `onEnd(count)` runs after the last line and never when the consumer stops early.
 */
export async function* exportLines(db: Querier, filter: AuditFilter, onEnd: (count: number) => Promise<void>): AsyncGenerator<string, void, undefined> {
  let after: Cursor | undefined;
  let count = 0;
  for (;;) {
    const batch = await listAuditEventsAscending(db, filter, after, AUDIT_LIMITS.exportBatch);
    for (const event of batch) {
      count += 1;
      yield `${JSON.stringify(event)}\n`;
    }
    const last = batch[batch.length - 1];
    if (last === undefined || batch.length < AUDIT_LIMITS.exportBatch) break;
    after = { at: last.at, id: last.id };
  }
  await onEnd(count);
}

export function exportedEvent(source: AuditSource, query: AuditExportQuery, count: number): AuditInput {
  return {
    ...source,
    action: 'audit.exported',
    target: { kind: 'server' },
    details: { from: query.from ?? null, to: query.to ?? null, action: query.action ?? null, count },
  };
}

export const auditRoutes =
  (env: AuditRoutesEnv) =>
  (app: FastifyInstance): void => {
    const guards = [requireServerAdmin, env.license.requireFeature('audit-log')];

    app.get(
      '/audit',
      { preHandler: guards, schema: { querystring: jsonSchema(auditQuerySchema, { io: 'input' }), response: { 200: jsonSchema(auditPageSchema) } } },
      async (request): Promise<AuditPage> => {
        const query = request.query as AuditQuery;
        const limit = query.limit ?? AUDIT_LIMITS.defaultPageSize;
        const after = query.after !== undefined ? decodeCursor(query.after) : undefined;
        const events = await listAuditEvents(env.db, filterOf(query), { after, limit });
        const last = events[events.length - 1];
        return events.length === limit && last !== undefined ? { events, next: encodeCursor({ at: last.at, id: last.id }) } : { events };
      },
    );

    app.get(
      '/audit/export',
      { preHandler: guards, schema: { querystring: jsonSchema(auditExportQuerySchema, { io: 'input' }) } },
      (request, reply) => {
        const query = request.query as AuditExportQuery;
        const source = auditSource(request);
        const lines = exportLines(env.db, filterOf(query), (count) => recordAudit(env.hooks, env.db, exportedEvent(source, query, count)));
        return reply.header('content-type', 'application/x-ndjson; charset=utf-8').send(Readable.from(lines));
      },
    );
  };
```

```ts
// packages/server/src/audit-log/license-listener.ts
/**
 * `license.installed` and `license.removed` (audit-log spec §3.2, plan ruling 5): the one kind written
 * after the commit, from the `licenseChanged` announcement. The actor is looked up by id. The command
 * line never announces (ruling 2) and records its own installs.
 */
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, type AuditActorInput, type LicenseChanged, type Querier, type ServerHooks } from '../context.js';
import { findUserById } from '../identity/repo.js';

export function licenseListener(env: { readonly db: Querier; readonly hooks: ServerHooks; readonly log: FastifyBaseLogger }): (event: LicenseChanged) => void {
  return (event) => {
    void (async () => {
      const user = event.actorUserId === null ? undefined : await findUserById(env.db, event.actorUserId);
      const actor: AuditActorInput = user === undefined ? { kind: 'system' } : { kind: 'user', userId: user.id, email: user.email };
      await recordAudit(env.hooks, env.db, {
        actor,
        action: event.action === 'installed' ? 'license.installed' : 'license.removed',
        target: { kind: 'license', ...(event.licenseId !== undefined ? { id: event.licenseId } : {}) },
        details: { edition: event.edition ?? null },
      });
    })().catch((error: unknown) => env.log.warn({ err: error }, 'audit: license change not recorded'));
  };
}
```

```ts
// packages/server/src/audit-log/module.ts
/**
 * The `audit-log` ServerModule (audit-log spec §5.1). Registered last: its routes need identity's guard
 * and `ctx.license`. Its hook is found at call time by every fire site, so for recording the order
 * does not matter. Recording is on for every edition; reading is gated (§3.1).
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { CaptureSweeper } from '../hooks/sweep.js';
import { realTimer } from '../live/module.js';
import { auditHook } from './hook.js';
import { licenseListener } from './license-listener.js';
import { deleteAuditEventsBefore } from './repo.js';
import { auditRoutes } from './routes.js';

export const AUDIT_LOG_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/audit-log/', import.meta.url));

export interface AuditLogOptions {
  readonly now?: () => Date;
  readonly setTimer?: SetTimer;
}

export function auditLogModule(options: AuditLogOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'audit-log',
    migrationsDir: AUDIT_LOG_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.hooks.audit.push(auditHook(now));
      ctx.hooks.licenseChanged.push(licenseListener({ db: ctx.db, hooks: ctx.hooks, log: ctx.log }));
      ctx.meta.addCapability('audit-log');
      auditRoutes({ db: ctx.db, hooks: ctx.hooks, license: ctx.license })(app);
      const sweeper = new CaptureSweeper({
        db: ctx.db,
        maxAgeDays: ctx.config.auditMaxAgeDays,
        now,
        setTimer,
        log: ctx.log,
        deleteBefore: deleteAuditEventsBefore,
        label: 'audit sweep',
      });
      sweeper.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a batch under way finishes.
      app.addHook('onClose', () => sweeper.stop());
    },
  };
}
```

If `realTimer` is module-private in `live/module.ts`, export it (it is a `setTimeout` plus `unref`). In `packages/server/src/modules.ts`, import `auditLogModule` and append `auditLogModule()` after `liveModule()`, with one sentence in the block comment: "audit-log comes last: its routes sit behind identity's guard and read `ctx.license`; its hook is found at call time, so fire sites in earlier modules reach it."

- [ ] **Step 6: Run the tests to see them pass**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/ && pnpm exec vitest run packages/server/test/unit/hooks/sweep.test.ts packages/server/test/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check` (includes `pnpm docs:server-config --check`; Step 2 regenerated the tables).

```bash
git add packages/server/src packages/server/test packages/server/README.md docs-site/src/content/docs/guides/wirebench-server.mdx
git commit -m "feat(server): the audit-log module — paged reads, NDJSON export, retention and the license listener (#198)"
```

---

### Task 4: Fire sites in identity

**Files:**
- Modify: `packages/server/src/identity/sessions.ts` (ruling 8), `invitations.ts`, `linking.ts`, `routes/auth-local.ts`, `routes/auth-oidc.ts`, `routes/me.ts`, `routes/users.ts`, `routes/invitations.ts`, `cli.ts` (call sites only; the hook itself is Task 7), `packages/server/src/teams/routes/invitations.ts` (the `createInvitation` and `revokeOpenInvitation` callers)
- Test: `packages/server/test/integration/audit-log/identity-events.test.ts`; two cases in `test/integration/identity/oidc.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `auditSource`, `SYSTEM_SOURCE`, `ANONYMOUS_SOURCE`, `AuditSource` from `context.ts`; `recordingAudit` from the test helpers.
- Produces: `issueToken(env, user, deviceName): Promise<{ response: SignInResponse; tokenId: string }>`; `CreateInvitationInput.source: AuditSource`; `createPasswordReset(env, user, createdBy, source)`; `revokeOpenInvitation(env, id, source)`; `acceptInvitation(env, input, source)`; `linkClaims(env, claims, source)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/audit-log/identity-events.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { identityHarness, signedInUser } from '../../helpers/identity.js';

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;
const PASSWORD = 'correct horse battery';

describeDb('identity fire sites (audit-log spec §3.2)', () => {
  let h: Awaited<ReturnType<typeof identityHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    h = await identityHarness({ modules: (clock) => [auditLogModule({ now: () => clock.now })] });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', password: PASSWORD, serverAdmin: true });
  });
  afterAll(() => h.close());

  it('a local sign-in records user, device, token and user agent; a wrong password records anonymous with the email', async () => {
    const ok = await h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'Root@example.com', password: PASSWORD, device: { name: 'laptop' } }, headers: { 'user-agent': 'Wirebench/3.1.0 (test)' } });
    expect(ok.statusCode).toBe(201);
    const signedIn = last(events, 'auth.signed_in');
    expect(signedIn.actor).toMatchObject({ kind: 'user', email: 'root@example.com' });
    expect(signedIn.details).toMatchObject({ method: 'local', device: 'laptop' });
    expect(signedIn.details!['tokenId']).toBeTypeOf('string');
    expect(signedIn.userAgent).toBe('Wirebench/3.1.0 (test)');

    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'root@example.com', password: 'nope', device: { name: 'laptop' } } });
    expect(bad.statusCode).toBe(401);
    const failed = last(events, 'auth.sign_in_failed');
    expect(failed.actor).toEqual({ kind: 'anonymous' });
    expect(failed.details).toMatchObject({ method: 'local', reason: 'identity-invalid-credentials', emailLower: 'root@example.com' });
  });

  it('invite, revoke, re-invite, accept: the acceptance records user.created then auth.signed_in', async () => {
    const invited = await h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers: admin.headers, payload: { email: 'New@Example.com' } });
    expect(invited.statusCode).toBe(201);
    const { id } = invited.json<{ id: string }>();
    expect(last(events, 'user.invited')).toMatchObject({ target: { kind: 'invitation', id }, details: { emailLower: 'new@example.com', serverAdmin: false }, actor: { kind: 'user', email: 'root@example.com' } });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers });
    expect(last(events, 'user.invitation_revoked')).toMatchObject({ target: { kind: 'invitation', id }, details: { emailLower: 'new@example.com' } });

    const again = await h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers: admin.headers, payload: { email: 'new@example.com' } });
    const secret = again.json<{ url: string }>().url.split('/').at(-1)!;
    const before = events.length;
    const accepted = await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload: { secret, displayName: 'New', password: PASSWORD, device: { name: 'phone' } } });
    expect(accepted.statusCode).toBe(201);
    expect(events.slice(before).map((e) => e.action)).toEqual(['user.created', 'auth.signed_in']);
    expect(events[before]!.details).toMatchObject({ method: 'local', emailLower: 'new@example.com' });
    expect(events[before]!.actor).toMatchObject({ kind: 'user', email: 'new@example.com' });
    expect(events[before + 1]!.details).toMatchObject({ method: 'local', device: 'phone' });
  });

  it('a rolled-back acceptance leaves no row (the real hook, not the recorder)', async () => {
    const invited = await h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers: admin.headers, payload: { email: 'rollback@example.com' } });
    const secret = invited.json<{ url: string }>().url.split('/').at(-1)!;
    h.hooks.invitationAccepted.push(() => Promise.reject(new Error('boom')));
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload: { secret, displayName: 'R', password: PASSWORD, device: { name: 'x' } } });
    h.hooks.invitationAccepted.pop();
    expect(res.statusCode).toBe(500);
    const rows = await h.db.query(`select 1 from audit_events where action = 'user.created' and details->>'emailLower' = 'rollback@example.com'`);
    expect(rows.rowCount).toBe(0);
  });

  it('disable, enable, admin grant and revoke record only real transitions', async () => {
    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    const target = users.json<{ id: string; email: string }[]>().find((u) => u.email === 'new@example.com')!;
    const before = events.length;
    await h.app.inject({ method: 'PATCH', url: `/api/v1/users/${target.id}`, headers: admin.headers, payload: { disabled: false } });
    expect(events.length).toBe(before);
    await h.app.inject({ method: 'PATCH', url: `/api/v1/users/${target.id}`, headers: admin.headers, payload: { disabled: true, serverAdmin: true } });
    expect(events.slice(before).map((e) => e.action).sort()).toEqual(['user.admin_granted', 'user.disabled']);
    await h.app.inject({ method: 'PATCH', url: `/api/v1/users/${target.id}`, headers: admin.headers, payload: { disabled: false, serverAdmin: false } });
    expect(events.slice(-2).map((e) => e.action).sort()).toEqual(['user.admin_revoked', 'user.enabled']);
    for (const e of events.slice(before)) expect(e.target).toEqual({ kind: 'user', id: target.id });
  });

  it('password reset issued, password changed, sign-out and device revoke', async () => {
    const users = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    const target = users.json<{ id: string; email: string }[]>().find((u) => u.email === 'new@example.com')!;
    await h.app.inject({ method: 'POST', url: `/api/v1/users/${target.id}/password-reset`, headers: admin.headers });
    expect(last(events, 'user.password_reset_issued')).toMatchObject({ target: { kind: 'user', id: target.id } });

    const other = await signedInUser(h, { email: 'o@example.com', password: PASSWORD });
    await h.app.inject({ method: 'POST', url: '/api/v1/me/password', headers: other.headers, payload: { currentPassword: PASSWORD, newPassword: 'another horse battery' } });
    expect(last(events, 'auth.password_changed')).toMatchObject({ actor: { kind: 'user', email: 'o@example.com' }, details: { via: 'self' } });
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: other.headers });
    expect(last(events, 'auth.signed_out')).toMatchObject({ actor: { kind: 'user', email: 'o@example.com' }, details: { tokenId: other.tokenId } });
  });
});
```

In `test/integration/identity/oidc.test.ts`, add two cases with `const events = recordingAudit(h.hooks)`: the first sign-in of an invited user yields `user.created` with `details.method === 'oidc'` followed by `auth.signed_in` with `method: 'oidc'`; a callback for an email with no invitation yields `auth.sign_in_failed` with `details.reason === 'identity-not-invited'` and `details.emailLower` set.

- [ ] **Step 2: Run it to see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/identity-events.test.ts`
Expected: FAIL, the recorder sees no events.

- [ ] **Step 3: `issueToken` returns the token id (ruling 8)**

In `identity/sessions.ts`:

```ts
export async function issueToken(env: IdentityEnv, user: repo.UserRow, deviceName: string): Promise<{ response: SignInResponse; tokenId: string }> {
  const { token, hash } = mintToken();
  const id = newId();
  const device = deviceName.trim().slice(0, MAX_DEVICE_NAME_LENGTH) || 'device';
  await repo.insertToken(env.ctx.db, { id, userId: user.id, tokenHash: hash, deviceName: device, at: env.now() });
  return { response: { token, user: publicUser(user) }, tokenId: id };
}

/** The `auth.signed_in` event every sign-in path records (audit-log §3.2), once the token exists. */
export function signedInEvent(source: AuditSource, user: repo.UserRow, method: 'local' | 'oidc', device: string, tokenId: string): AuditInput {
  return {
    ...source,
    actor: { kind: 'user', userId: user.id, email: user.email, tokenId },
    action: 'auth.signed_in',
    target: { kind: 'user', id: user.id },
    details: { method, device: device.trim().slice(0, MAX_DEVICE_NAME_LENGTH), tokenId },
  };
}
```

Import `AuditInput, AuditSource` as types from `../context.js`.

- [ ] **Step 4: The fire sites**

`routes/auth-local.ts`, the sign-in handler. Import `ANONYMOUS_SOURCE, auditSource, recordAudit` from `../../context.js` and `signedInEvent` from `../sessions.js`:

```ts
      const source = auditSource(request);
      const failed = (reason: string) =>
        recordAudit(env.ctx.hooks, env.ctx.db, {
          ...ANONYMOUS_SOURCE,
          ip: source.ip,
          ...(source.userAgent !== undefined ? { userAgent: source.userAgent } : {}),
          action: 'auth.sign_in_failed',
          target: { kind: 'server' },
          details: { method: 'local', reason, emailLower: emailLower(body.email) },
        });
      if (user === undefined || credential === undefined || !verdict.ok) {
        await failed('identity-invalid-credentials');
        throw invalidCredentials();
      }
      if (user.disabledAt !== null) {
        await failed('identity-user-disabled');
        throw userDisabled();
      }
      if (verdict.rehash) await repo.upsertCredential(env.ctx.db, user.id, await hashPassword(body.password), env.now());
      const issued = await issueToken(env, user, body.device.name);
      await recordAudit(env.ctx.hooks, env.ctx.db, signedInEvent(source, user, 'local', body.device.name, issued.tokenId));
      return reply.code(201).send(issued.response);
```

The sign-out handler, after `revokeToken`:

```ts
      await recordAudit(env.ctx.hooks, env.ctx.db, {
        ...auditSource(request),
        action: 'auth.signed_out',
        target: { kind: 'user', id: request.caller!.id },
        details: { tokenId: request.caller!.tokenId },
      });
```

`routes/auth-oidc.ts`. In the callback, define once:

```ts
      const refused = (reason: string, email?: string) =>
        recordAudit(env.ctx.hooks, env.ctx.db, {
          ...ANONYMOUS_SOURCE,
          ip: request.ip,
          action: 'auth.sign_in_failed',
          target: { kind: 'server' },
          details: { method: 'oidc', reason, emailLower: email?.toLowerCase() ?? null },
        });
```

and `await refused(...)` before each of the four redirects: the IdP's refusal (`'identity-oidc-refused'`), a failed exchange (`'identity-oidc-failed'`), an issuer mismatch (`'identity-oidc-failed'`, `claims.email`), and `linkClaims`'s refusal (`linked.code`, `claims.email`). `linkClaims(env, claims)` becomes `linkClaims(env, claims, auditSource(request))`. In `/auth/oidc/complete`:

```ts
      const issued = await issueToken(env, user, flow.deviceName);
      await recordAudit(env.ctx.hooks, env.ctx.db, signedInEvent(auditSource(request), user, 'oidc', flow.deviceName, issued.tokenId));
      return reply.code(201).send(issued.response);
```

`linking.ts`: `export async function linkClaims(env: IdentityEnv, claims: OidcClaims, source: AuditSource)`. In the create transaction, after `runInvitationAccepted`:

```ts
      await recordAudit(env.ctx.hooks, tx, {
        ...source,
        actor: { kind: 'user', userId: created.id, email: created.email },
        action: 'user.created',
        target: { kind: 'user', id: created.id },
        details: { method: 'oidc', invitationId: decision.invitationId, emailLower: created.emailLower },
      });
```

`invitations.ts`:

- `CreateInvitationInput` gains `readonly source: AuditSource;`. In `createInvitation`'s transaction, after `attach`:

```ts
      await recordAudit(env.ctx.hooks, tx, {
        ...input.source,
        action: 'user.invited',
        target: { kind: 'invitation', id: inserted.id },
        details: { emailLower: lower, serverAdmin: input.serverAdmin },
      });
```

- `createPasswordReset(env, user, createdBy, source: AuditSource)`: inside its transaction, after `insertInvitation` (capture the row in a `const` first), record `user.password_reset_issued` with `target: { kind: 'user', id: user.id }`, `details: { invitationId: row.id }`.
- `revokeOpenInvitation(env, id, source: AuditSource)`: after `revokeInvitation`, record `user.invitation_revoked` with `target: { kind: 'invitation', id }`, `details: { emailLower: row.emailLower }`, on `env.ctx.db`.
- `acceptInvitation(env, input, source: AuditSource)`: in the transaction's `invite` branch after `runInvitationAccepted`, record `user.created` with the created user as actor and `details: { method: 'local', invitationId: invitation.id, emailLower: invitation.emailLower }`; in the `reset` branch after the credential is replaced and tokens revoked, record `auth.password_changed` with the user as actor and `details: { via: 'reset' }` (ruling 10). After the transaction: `const issued = await issueToken(env, user, input.device.name); await recordAudit(env.ctx.hooks, env.ctx.db, signedInEvent(source, user, 'local', input.device.name, issued.tokenId)); return issued.response;`.

`routes/invitations.ts`: `source: auditSource(request)` in the `createInvitation` input; `revokeOpenInvitation(env, id, auditSource(request))`; `acceptInvitation(env, body, auditSource(request))`.

`routes/me.ts`, `POST /me/password`, in the transaction after `revokeTokensOfUser`:

```ts
        await recordAudit(env.ctx.hooks, tx, { ...auditSource(request), action: 'auth.password_changed', target: { kind: 'user', id: caller.id }, details: { via: 'self' } });
```

`DELETE /me/devices/:id`, after `revokeToken`: record `auth.signed_out` with `target: { kind: 'user', id: caller.id }`, `details: { tokenId: id }`.

`routes/users.ts`, `PATCH /users/:id` (ruling 9), the transaction body becomes:

```ts
        const source = auditSource(request);
        const event = (action: 'user.disabled' | 'user.enabled' | 'user.admin_granted' | 'user.admin_revoked') =>
          recordAudit(env.ctx.hooks, tx, { ...source, action, target: { kind: 'user', id } });
        if (body.serverAdmin !== undefined && body.serverAdmin !== user.serverAdmin) {
          await repo.setServerAdmin(tx, id, body.serverAdmin);
          await event(body.serverAdmin ? 'user.admin_granted' : 'user.admin_revoked');
        }
        if (body.disabled === true && user.disabledAt === null) {
          await repo.setDisabled(tx, id, now);
          await repo.revokeTokensOfUser(tx, id, now); // disabling revokes every token (§3.1)
          await event('user.disabled');
        } else if (body.disabled === false && user.disabledAt !== null) {
          await env.ctx.license.assertSeatAvailable(tx);
          await repo.setDisabled(tx, id, null);
          await event('user.enabled');
        }
```

The response is unchanged. `POST /users/:id/password-reset` passes `auditSource(request)` as the fourth argument.

`identity/cli.ts`: `createInvitation(env, { …, source: SYSTEM_SOURCE })`, `revokeOpenInvitation(env, id, SYSTEM_SOURCE)`. `teams/routes/invitations.ts`: the team invitation passes `source: auditSource(request)` and its revoke passes `auditSource(request)`.

- [ ] **Step 5: Run the identity suites**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/identity packages/server/test/integration/audit-log packages/server/test/integration/licensing`
Expected: PASS. The existing identity tests keep their behaviour: `issueToken`'s callers all send `.response`.

- [ ] **Step 6: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): audit events for sign-ins, invitations, users and passwords (#198)"
```

---

### Task 5: Fire sites in teams-access

**Files:**
- Modify: `packages/server/src/teams/repo.ts` (`deleteGrant` returns the removed role), `routes/teams.ts`, `routes/members.ts`, `routes/workspaces.ts`, `routes/access.ts`, `routes/invitations.ts` (`addInvitedMember(now, hooks)`), `module.ts`
- Test: `packages/server/test/integration/audit-log/teams-events.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `auditSource`; `teamById`, `workspaceById`, `memberRole` from `teams/repo.ts`; `findUserById` from `identity/repo.ts`.
- Produces: `deleteGrant(db, workspaceId, userId): Promise<WorkspaceRole | undefined>`; `addInvitedMember(now, hooks): InvitationAcceptedHook`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/audit-log/teams-events.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AuditInput } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import { identityHarness } from '../../helpers/identity.js';
import { call, seedTeam } from '../../helpers/teams.js';

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;

describeDb('teams-access fire sites (audit-log spec §3.2, plan ruling 7)', () => {
  let h: Awaited<ReturnType<typeof identityHarness>>;
  let events: AuditInput[];
  let admin: Awaited<ReturnType<typeof signedInUser>>;
  let member: Awaited<ReturnType<typeof signedInUser>>;

  beforeAll(async () => {
    // Through the routes, not the seed helpers: the seeds write rows directly and fire nothing.
    h = await identityHarness({ modules: (clock) => [teamsModule({ now: () => clock.now }), auditLogModule({ now: () => clock.now })] });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    member = await signedInUser(h, { email: 'm@example.com' });
  });
  afterAll(() => h.close());

  it('team created, renamed with the previous name, member added, role changed, removed, deleted with its name', async () => {
    const team = (await call<{ id: string }>(h, admin, 'POST', '/teams', { name: 'Payments' })).body;
    expect(last(events, 'team.created')).toMatchObject({ target: { kind: 'team', id: team.id }, teamId: team.id, details: { name: 'Payments' } });
    await call(h, admin, 'PATCH', `/teams/${team.id}`, { name: 'Billing' });
    expect(last(events, 'team.renamed').details).toEqual({ name: 'Billing', previousName: 'Payments' });
    await call(h, admin, 'POST', `/teams/${team.id}/members`, { email: 'm@example.com', role: 'member' });
    expect(last(events, 'team.member_added')).toMatchObject({ target: { kind: 'user', id: member.user.id }, teamId: team.id, details: { role: 'member' } });
    await call(h, admin, 'PATCH', `/teams/${team.id}/members/${member.user.id}`, { role: 'admin' });
    expect(last(events, 'team.member_role_changed').details).toEqual({ role: 'admin', previousRole: 'member' });
    await call(h, admin, 'DELETE', `/teams/${team.id}/members/${member.user.id}`);
    expect(last(events, 'team.member_removed').details).toEqual({ role: 'admin', self: false });
    await call(h, admin, 'DELETE', `/teams/${team.id}`);
    expect(last(events, 'team.deleted').details).toEqual({ name: 'Billing' });
  });

  it('workspace created, renamed, default role changed, grant set and removed with the role, deleted with name and team', async () => {
    const team = await seedTeam(h, { name: 'Ops', admins: [admin] });
    const ws = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'Prod' })).body;
    expect(last(events, 'workspace.created')).toMatchObject({ target: { kind: 'workspace', id: ws.id }, workspaceId: ws.id, teamId: team.id, details: { name: 'Prod', defaultRole: 'viewer' } });
    await call(h, admin, 'PATCH', `/workspaces/${ws.id}`, { name: 'Production', defaultRole: 'editor' });
    expect(last(events, 'workspace.renamed').details).toEqual({ name: 'Production', previousName: 'Prod' });
    expect(last(events, 'workspace.default_role_changed')).toMatchObject({ teamId: team.id, details: { role: 'editor', previousRole: 'viewer' } });
    await call(h, admin, 'POST', `/teams/${team.id}/members`, { email: 'm@example.com', role: 'member' });
    await call(h, admin, 'PUT', `/workspaces/${ws.id}/access/${member.user.id}`, { role: 'admin' });
    expect(last(events, 'workspace.grant_set')).toMatchObject({ target: { kind: 'user', id: member.user.id }, workspaceId: ws.id, teamId: team.id, details: { role: 'admin' } });
    const before = events.length;
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}/access/${member.user.id}`);
    expect(last(events, 'workspace.grant_removed').details).toEqual({ role: 'admin' });
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}/access/${member.user.id}`);
    expect(events.length).toBe(before + 1); // the second delete removed nothing and recorded nothing
    await call(h, admin, 'DELETE', `/workspaces/${ws.id}`);
    expect(last(events, 'workspace.deleted')).toMatchObject({ teamId: team.id, details: { name: 'Production' } });
  });

  it('an accepted team invitation records team.member_added inside the acceptance, actor the new user', async () => {
    const team = await seedTeam(h, { name: 'Invites', admins: [admin] });
    const invited = await call<{ url: string }>(h, admin, 'POST', `/teams/${team.id}/invitations`, { email: 'inv@example.com', role: 'member' });
    const secret = invited.body.url.split('/').at(-1)!;
    await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload: { secret, displayName: 'Inv', password: 'correct horse battery', device: { name: 'x' } } });
    const added = last(events, 'team.member_added');
    expect(added.teamId).toBe(team.id);
    expect(added.details).toMatchObject({ role: 'member', via: 'invitation' });
    expect(added.actor).toMatchObject({ kind: 'user', email: 'inv@example.com' });
  });
});
```

Read `teams/routes/*.ts` for the exact paths and payloads (`POST …/members` may take `userId` rather than `email`; the access routes may be `PUT`/`DELETE …/access/:userId`) and adjust the calls; the assertions are what the task delivers.

- [ ] **Step 2: Run it to see it fail**

Expected: FAIL, no events recorded.

- [ ] **Step 3: Repo change and fire sites**

`teams/repo.ts` (use the grants table's real name from `migrations/teams-access/0003_teams.sql`):

```ts
/** The removed grant's role, or `undefined` when there was none, so a no-op delete records nothing (audit-log plan ruling 7). */
export async function deleteGrant(db: Querier, workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
  const result = await db.query<{ role: WorkspaceRole }>('delete from workspace_grants where workspace_id = $1 and user_id = $2 returning role', [workspaceId, userId]);
  return result.rows[0]?.role;
}
```

`routes/teams.ts`:

- create: in the transaction after `insertMember`: `await recordAudit(env.ctx.hooks, tx, { ...auditSource(request), action: 'team.created', target: { kind: 'team', id: row.id }, teamId: row.id, details: { name } });`
- rename becomes `db.transaction(async (tx) => { const previous = await repo.teamById(tx, teamId); if (previous === undefined) throw teamNotFound(); const row = await repo.renameTeam(tx, teamId, name).catch(nameTakenOr); if (previous.name !== name) await recordAudit(env.ctx.hooks, tx, { ...auditSource(request), action: 'team.renamed', target: { kind: 'team', id: teamId }, teamId, details: { name, previousName: previous.name } }); return row; })`.
- delete: after `lockTeam`, `const team = await repo.teamById(tx, teamId);`; after `deleteTeam`, record `team.deleted` with `teamId`, `details: { name: team?.name ?? null }`.

`routes/members.ts`:

- add: wrap `insertMember` and the event in `db.transaction`; after a successful insert record `team.member_added` with `target: { kind: 'user', id: user.id }`, `teamId`, `details: { role: body.role }`.
- role change: in the transaction after `setMemberRole`, when `current !== role`, record `team.member_role_changed` with `target: { kind: 'user', id: userId }`, `teamId`, `details: { role, previousRole: current }`.
- remove: in the transaction after `deleteMember`, record `team.member_removed` with `target: { kind: 'user', id: userId }`, `teamId`, `details: { role: current, self: userId === request.caller!.id }`.

`routes/workspaces.ts`:

- create: in the transaction before `repos.withLock`, record `workspace.created` with `target: { kind: 'workspace', id }`, `workspaceId: id`, `teamId`, `details: { name, defaultRole: body.defaultRole ?? 'viewer' }`.
- update becomes a transaction: `const previous = await repo.workspaceById(tx, access.workspaceId); if (previous === undefined) throw workspaceNotFound();` then `updateWorkspace(tx, …)`, then, with `const source = auditSource(request)`: when `body.name !== undefined && cleanName(body.name) !== previous.name` record `workspace.renamed` (`details: { name: cleanName(body.name), previousName: previous.name }`); when `body.defaultRole !== undefined && body.defaultRole !== previous.defaultRole` record `workspace.default_role_changed` (`details: { role: body.defaultRole, previousRole: previous.defaultRole }`); both with `target: { kind: 'workspace', id: access.workspaceId }`, `workspaceId`, `teamId: previous.teamId`. Keep the existing post-update read for the response.
- delete: inside `withLock`, `const ws = await repo.workspaceById(db, workspaceId);` then `await db.transaction(async (tx) => { await repo.deleteWorkspace(tx, workspaceId); await recordAudit(env.ctx.hooks, tx, { ...auditSource(request), action: 'workspace.deleted', target: { kind: 'workspace', id: workspaceId }, workspaceId, ...(ws !== undefined ? { teamId: ws.teamId } : {}), details: { name: ws?.name ?? null } }); });` and the announce after.

`routes/access.ts`:

- grant set: in the transaction after `upsertGrant`: `const ws = await repo.workspaceById(tx, workspaceId);` then record `workspace.grant_set` with `target: { kind: 'user', id: userId }`, `workspaceId`, `teamId: ws?.teamId`, `details: { role }`.
- grant removed: `const removed = await repo.deleteGrant(db, workspaceId, userId); if (removed !== undefined) await recordAudit(env.ctx.hooks, db, { ...auditSource(request), action: 'workspace.grant_removed', target: { kind: 'user', id: userId }, workspaceId, details: { role: removed } });` then the existing announce.

`routes/invitations.ts`, `export function addInvitedMember(now: () => Date, hooks: ServerHooks): InvitationAcceptedHook`: after `insertMember`:

```ts
    const user = await findUserById(tx, accepted.userId);
    await recordAudit(hooks, tx, {
      actor: user === undefined ? { kind: 'system' } : { kind: 'user', userId: user.id, email: user.email },
      action: 'team.member_added',
      target: { kind: 'user', id: accepted.userId },
      teamId: invited.teamId,
      details: { role: invited.role, via: 'invitation', invitationId: accepted.invitationId },
    });
```

`teams/module.ts`: `ctx.hooks.invitationAccepted.push(addInvitedMember(now, ctx.hooks));`.

- [ ] **Step 4: Run the teams suites**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/teams packages/server/test/integration/audit-log`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): audit events for teams, members, workspaces and grants, with previous values (#198)"
```

---

### Task 6: Fire sites in server-sync, webhook-capture, webhook-signatures and ci-tokens

**Files:**
- Create: `packages/server/src/audit-log/secrets.ts` (pure, ruling 6)
- Modify: `packages/server/src/sync/routes/commits.ts`, `sync/routes/key-requests.ts`, `hooks/routes/manage.ts`, `ci-tokens/repo.ts`, `ci-tokens/routes.ts`, `ci-tokens/module.ts`, `packages/server/test/helpers/context.ts`
- Test: `packages/server/test/unit/audit-log/secrets.test.ts`, `packages/server/test/integration/audit-log/sync-hooks-events.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `auditSource` (Task 1); `SyncChange` (`@wirebench/engine`); `CommitStore.hasFile(workspaceId, at, path)` (`sync/commit-store.ts`); `signaturePatchOf` and the `found(workspaceId, hookId)` lookup in `hooks/routes/manage.ts`; `revokeCiToken` (`ci-tokens/repo.ts`).
- Produces: `secretEvents(changes, existed): SecretEvent[]` with `SecretEvent { action; details }`; `revokeCiToken(db, workspaceId, id, at): Promise<string | undefined>` (the revoked token's name); `CiTokensEnv.hooks`; test helpers `SECRET_SHAPES` and `expectNoSecretsInAudit(db)`.

- [ ] **Step 1: Write the failing pure test for the secrets derivation**

```ts
// packages/server/test/unit/audit-log/secrets.test.ts
import { describe, expect, it } from 'vitest';
import { secretEvents } from '../../../src/audit-log/secrets.js';

const change = (path: string) => ({ path, encoding: 'utf8' as const, content: 'x' });

describe('secret.* events from a push (audit-log plan ruling 6)', () => {
  it('a new value is shared, an existing one rotated, access and keys are access_changed, other paths are nothing', () => {
    const events = secretEvents(
      [
        change('team-secrets/values/db-password.yaml'),
        change('team-secrets/values/api-key.yaml'),
        change('team-secrets/access/01J9A.yaml'),
        change('team-secrets/keys/K1.yaml'),
        change('projects/p/requests/r.yaml'),
      ],
      (path) => path.endsWith('api-key.yaml'),
    );
    expect(events).toEqual([
      { action: 'secret.shared', details: { count: 1, names: ['db-password'] } },
      { action: 'secret.rotated', details: { count: 1, names: ['api-key'] } },
      { action: 'secret.access_changed', details: { entries: 1, keyRequests: 1 } },
    ]);
  });

  it('a push with no team-secrets paths yields nothing', () => {
    expect(secretEvents([change('projects/p/x.yaml')], () => false)).toEqual([]);
  });

  it('a deletion (null content) under values counts as rotated: the value is gone and must be set again', () => {
    expect(secretEvents([{ path: 'team-secrets/values/old.yaml', encoding: 'utf8', content: null }], () => true)).toEqual([
      { action: 'secret.rotated', details: { count: 1, names: ['old'] } },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/server/test/unit/audit-log/secrets.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write `secrets.ts`**

```ts
// packages/server/src/audit-log/secrets.ts
/**
 * `secret.*` events from a push's paths (audit-log spec §3.2, plan ruling 6). The server never parses a
 * team-secrets file, so what it can say is which kind of file changed and whether a value is new. Names
 * are the file's leaf without extension: a label the team chose, never a value.
 */
import type { AuditDetails, SyncChange } from '@wirebench/engine';

export interface SecretEvent {
  readonly action: 'secret.shared' | 'secret.rotated' | 'secret.access_changed';
  readonly details: AuditDetails;
}

const VALUES = 'team-secrets/values/';
const ACCESS = 'team-secrets/access/';
const KEYS = 'team-secrets/keys/';
const MAX_NAMES = 64;
const leaf = (path: string): string => (path.split('/').at(-1) ?? path).replace(/\.ya?ml$/, '');

/** `existed(path)` answers whether the file was at the push's parent; a deletion is `content: null`. */
export function secretEvents(changes: readonly SyncChange[], existed: (path: string) => boolean): SecretEvent[] {
  const shared: string[] = [];
  const rotated: string[] = [];
  let entries = 0;
  let keyRequests = 0;
  for (const change of changes) {
    if (change.path.startsWith(VALUES)) {
      (change.content !== null && !existed(change.path) ? shared : rotated).push(leaf(change.path));
    } else if (change.path.startsWith(ACCESS)) {
      entries += 1;
    } else if (change.path.startsWith(KEYS)) {
      keyRequests += 1;
    }
  }
  const events: SecretEvent[] = [];
  if (shared.length > 0) events.push({ action: 'secret.shared', details: { count: shared.length, names: shared.slice(0, MAX_NAMES) } });
  if (rotated.length > 0) events.push({ action: 'secret.rotated', details: { count: rotated.length, names: rotated.slice(0, MAX_NAMES) } });
  if (entries + keyRequests > 0) events.push({ action: 'secret.access_changed', details: { entries, keyRequests } });
  return events;
}
```

Run the test again: PASS.

- [ ] **Step 4: Write the failing integration test**

```ts
// packages/server/test/integration/audit-log/sync-hooks-events.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { ciTokensModule } from '../../../src/ci-tokens/module.js';
import type { AuditInput } from '../../../src/context.js';
import { hooksModule } from '../../../src/hooks/module.js';
import { syncModule } from '../../../src/sync/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import { expectNoSecretsInAudit, recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam } from '../../helpers/teams.js';

/** The key the signature suites use (`test/integration/hooks/signatures-manage.test.ts`); without it a signature is refused. */
const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const HMAC = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-sig' };

const last = (events: AuditInput[], action: AuditInput['action']) => events.filter((e) => e.action === action).at(-1)!;

/** One commit through `POST …/sync/commits` (engine `syncPushRequestSchema`). */
async function push(h: IdentityHarness, user: SignedInUser, workspaceId: string, parent: string | null, changes: unknown[]): Promise<string> {
  const res = await call<{ head: string }>(h, user, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
    parent,
    commits: [{ subject: 'push', at: h.clock.now.toISOString(), changes }],
  });
  expect(res.status).toBe(201);
  return res.body.head;
}

describeDb('sync, webhook and CI-token fire sites (audit-log spec §3.2, plan rulings 4, 6, 7)', () => {
  let h: IdentityHarness;
  let events: AuditInput[];
  let admin: SignedInUser;
  let workspaceId: string;

  beforeAll(async () => {
    h = await identityHarness({
      env: KEY_ENV,
      modules: (clock) => [
        teamsModule({ now: () => clock.now }),
        syncModule(),
        hooksModule({ now: () => clock.now }),
        ciTokensModule({ now: () => clock.now }),
        auditLogModule({ now: () => clock.now }),
      ],
    });
    events = recordingAudit(h.hooks);
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    // Through the route, so the bare repository exists for the pushes below.
    workspaceId = (await call<{ id: string }>(h, admin, 'POST', `/teams/${team.id}/workspaces`, { name: 'W' })).body.id;
  });
  afterAll(() => h.close());

  it('a push records workspace.pushed with both heads, and secret events from its paths', async () => {
    const first = await push(h, admin, workspaceId, null, [{ path: 'team-secrets/values/db.yaml', encoding: 'utf8', content: 'enc' }]);
    expect(last(events, 'workspace.pushed')).toMatchObject({
      target: { kind: 'workspace', id: workspaceId },
      workspaceId,
      details: { head: first, previousHead: null, commits: 1 },
    });
    expect(last(events, 'secret.shared').details).toEqual({ count: 1, names: ['db'] });
    await push(h, admin, workspaceId, first, [{ path: 'team-secrets/values/db.yaml', encoding: 'utf8', content: 'enc2' }]);
    expect(last(events, 'secret.rotated').details).toEqual({ count: 1, names: ['db'] });
  });

  it('catch URL created, changed with a signature set then cleared, rotated, cleared, deleted', async () => {
    const base = `/workspaces/${workspaceId}/hooks`;
    const hook = (await call<{ id: string }>(h, admin, 'POST', base, { name: 'orders' })).body;
    expect(last(events, 'hook.created')).toMatchObject({ target: { kind: 'hook', id: hook.id }, workspaceId, details: { name: 'orders' } });

    expect((await call(h, admin, 'PATCH', `${base}/${hook.id}`, { signature: { scheme: HMAC, secret: 'shh' } })).status).toBe(200);
    expect(last(events, 'hook.signature_set').details).toEqual({ scheme: 'hmac' });
    expect(JSON.stringify(events)).not.toContain('shh');

    await call(h, admin, 'PATCH', `${base}/${hook.id}`, { signature: null, name: 'orders-v2' });
    expect(last(events, 'hook.signature_cleared').details).toEqual({ scheme: 'hmac' });
    expect(last(events, 'hook.changed').details).toMatchObject({ name: 'orders-v2', previousName: 'orders' });

    await call(h, admin, 'POST', `${base}/${hook.id}/rotate`);
    expect(last(events, 'hook.rotated').details).toEqual({ name: 'orders-v2' });
    await call(h, admin, 'DELETE', `${base}/${hook.id}/captures`);
    expect(last(events, 'hook.cleared').details).toMatchObject({ name: 'orders-v2' });
    await call(h, admin, 'DELETE', `${base}/${hook.id}`);
    expect(last(events, 'hook.deleted').details).toEqual({ name: 'orders-v2' });
  });

  it('CI token created and revoked with its name; a second revoke records nothing', async () => {
    const base = `/workspaces/${workspaceId}/ci-tokens`;
    const token = (await call<{ id: string }>(h, admin, 'POST', base, { name: 'gha' })).body;
    expect(last(events, 'ci_token.created')).toMatchObject({ target: { kind: 'ci-token', id: token.id }, workspaceId, details: { name: 'gha' } });
    const before = events.length;
    await call(h, admin, 'DELETE', `${base}/${token.id}`);
    expect(last(events, 'ci_token.revoked').details).toEqual({ name: 'gha' });
    await call(h, admin, 'DELETE', `${base}/${token.id}`);
    expect(events.length).toBe(before + 1);
  });

  it('writes no secret-shaped value and never a pushed value', async () => {
    expect(JSON.stringify(events)).not.toContain('enc2');
    await expectNoSecretsInAudit(h.db);
  });
});
```

The paths, bodies and status codes above are read from `sync/routes/commits.ts`, `hooks/routes/manage.ts`, `ci-tokens/routes.ts` and the engine schemas. If a create route answers `201` with a different id field, adjust the read, not the assertions.

- [ ] **Step 5: Run it to see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/sync-hooks-events.test.ts`
Expected: FAIL, no `workspace.pushed` event.

- [ ] **Step 6: The fire sites**

`sync/routes/commits.ts`, after `appendCommits` returns and before the `headMoved` announce (ruling 4). Import `auditSource, recordAudit` from `../../context.js` and `secretEvents` from `../../audit-log/secrets.js`:

```ts
    // Recorded after the ref moved (audit-log plan ruling 4): the commits are on main, so a failure here is logged, not answered.
    try {
      const source = auditSource(request);
      await recordAudit(hooks, db, {
        ...source,
        action: 'workspace.pushed',
        target: { kind: 'workspace', id: workspaceId },
        workspaceId,
        details: { head: result.head, previousHead: body.parent, commits: body.commits.length },
      });
      const changes = body.commits.flatMap((commit) => commit.changes);
      if (changes.some((change) => change.path.startsWith('team-secrets/'))) {
        const existed = new Map<string, boolean>();
        for (const change of changes) {
          if (change.path.startsWith('team-secrets/values/')) {
            existed.set(change.path, body.parent !== null && (await env.store.hasFile(workspaceId, body.parent, change.path)));
          }
        }
        for (const event of secretEvents(changes, (path) => existed.get(path) ?? false)) {
          await recordAudit(hooks, db, { ...source, ...event, target: { kind: 'workspace', id: workspaceId }, workspaceId });
        }
      }
    } catch (error) {
      request.log.warn({ err: error, workspaceId }, 'audit: push not recorded');
    }
    announce(hooks.headMoved, { workspaceId, head: result.head, tokenId: request.caller!.tokenId }, request.log);
```

`hasFile` is asked only for `values/` paths, once each, so a push's cost grows with its secret changes, not its size.

`sync/routes/key-requests.ts`, after `appendCommits` returns, the same try/catch shape with one event: `action: 'secret.access_changed'`, `target: { kind: 'workspace', id: workspaceId }`, `workspaceId`, `details: { entries: 0, keyRequests: 1, keyId: body.keyId, head: result.head }`.

`hooks/routes/manage.ts` (every event has `target: { kind: 'hook', id: hookId }` and `workspaceId`; `const source = auditSource(request)` at the top of each handler):

- create: in the transaction after `insertCatchUrl`, `hook.created` with `details: { name }`.
- PATCH: wrap `updateCatchUrl` and the events in `db.transaction`. After a successful update: `hook.changed` with `details: { name: body.name ?? current.name, previousName: current.name, enabled: body.enabled ?? null, rejectUnverified: body.rejectUnverified ?? null }`; then from the `signature` value `signaturePatchOf` computed: an object → `hook.signature_set` with `details: { scheme: signature.scheme.kind }`; `null` → `hook.signature_cleared` with `details: { scheme: current.signature?.kind ?? null }`; `undefined` → nothing. The secret never comes near `details`.
- rotate: keep `const row = await found(workspaceId, hookId);` (stop discarding it); after `rotateSecret`, `hook.rotated` with `details: { name: row.name }`.
- delete: `const row = await found(…)`; after `deleteCatchUrl`, `hook.deleted` with `details: { name: row.name }`.
- clear: `const row = await found(…)`; `const removed = await repo.clearCaptures(db, hookId)`; `hook.cleared` with `details: { name: row.name, captures: removed }`.

`ci-tokens/repo.ts`:

```ts
/** The revoked token's name, or `undefined` when none was live (audit-log plan ruling 7). */
export async function revokeCiToken(db: Querier, workspaceId: string, id: string, at: Date): Promise<string | undefined> {
  const result = await db.query<{ name: string }>(
    'update ci_tokens set revoked_at = $3 where id = $1 and workspace_id = $2 and revoked_at is null returning name',
    [id, workspaceId, at],
  );
  return result.rows[0]?.name;
}
```

`ci-tokens/routes.ts`: `CiTokensEnv` gains `readonly hooks: ServerHooks;` (set from `ctx.hooks` in `ci-tokens/module.ts`). Create: wrap `insertCiToken` and `ci_token.created` (`target: { kind: 'ci-token', id }`, `workspaceId`, `details: { name }`) in `db.transaction`. Revoke:

```ts
    const name = await repo.revokeCiToken(db, workspaceId, tokenId, env.now());
    if (name === undefined) throw ciTokenNotFound();
    await recordAudit(env.hooks, db, { ...auditSource(request), action: 'ci_token.revoked', target: { kind: 'ci-token', id: tokenId }, workspaceId, details: { name } });
```

Update the existing unit test that asserts `revokeCiToken` returns a boolean.

- [ ] **Step 7: The whole-suite secret assertion (spec §6, §11)**

Add to `test/helpers/context.ts`:

```ts
/** Secret shapes: device tokens, license lines, bearer values, scrypt/bcrypt hashes, long base64url blobs. */
export const SECRET_SHAPES: readonly RegExp[] = [
  /wbs_[A-Za-z0-9_-]{20,}/,
  /wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /\$(2[aby]|scrypt)\$/,
  /[A-Za-z0-9_-]{64,}/,
];

/** Every row this database holds, serialised, matched against every shape: the §6 assertion each suite ends with. */
export async function expectNoSecretsInAudit(db: Querier): Promise<void> {
  const rows = await db.query<Record<string, unknown>>('select actor_email, user_agent, details from audit_events');
  for (const row of rows.rows) {
    const text = JSON.stringify(row);
    for (const shape of SECRET_SHAPES) {
      if (shape.test(text)) throw new Error(`audit row carries a secret-shaped value: ${text}`);
    }
  }
}
```

Add a final `it('writes no secret-shaped value', () => expectNoSecretsInAudit(h.db))` to `identity-events.test.ts` (Task 4), `teams-events.test.ts` (Task 5) and `routes.test.ts` (Task 3), so every kind of row is scanned where it is produced. Task 7's CLI test adds its own.

- [ ] **Step 8: Run and commit**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): audit events for pushes, team-secret paths, catch URLs and CI tokens (#198)"
```

---

### Task 7: The command line: the hook on `admin`, license recording, `admin audit export`

**Files:**
- Modify: `packages/server/src/args.ts`, `src/main.ts`, `src/identity/cli.ts`, `src/licensing/cli.ts`
- Create: `packages/server/src/audit-log/cli.ts`
- Test: `packages/server/test/unit/args.test.ts` (new cases), `packages/server/test/integration/audit-log/cli.test.ts`

**Interfaces:**
- Consumes: `exportLines`, `filterOf`, `exportedEvent` (Task 3); `auditHook` (Task 2); `recordAudit`, `SYSTEM_SOURCE` (Task 1); `runAdmin`, `ServerIo`, `ExitCode` (`io.ts`); `installLicense`, `removeLicense` (`licensing/service.ts`).
- Produces: `ServerCommand` member `{ command: 'admin-audit-export'; from?; to?; action?; workspace? }`; `runAuditCommand(command, env, io): Promise<number>`.

- [ ] **Step 1: Write the failing args test**

In `test/unit/args.test.ts` (use the file's parse function name):

```ts
it('parses admin audit export with its four options', () => {
  expect(parseArgs(['admin', 'audit', 'export'])).toEqual({ command: 'admin-audit-export' });
  expect(
    parseArgs(['admin', 'audit', 'export', '--from', '2026-10-01T00:00:00Z', '--to', '2026-11-01T00:00:00Z', '--action', 'auth.', '--workspace', 'W1']),
  ).toEqual({ command: 'admin-audit-export', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', action: 'auth.', workspace: 'W1' });
  expect(() => parseArgs(['admin', 'audit'])).toThrow(/usage: wirebench-server admin audit export/);
  expect(() => parseArgs(['admin', 'audit', 'export', '--from', 'yesterday'])).toThrow(/ISO 8601/);
  expect(() => parseArgs(['admin', 'license', 'show', '--from', 'x'])).toThrow(/--from/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run packages/server/test/unit/args.test.ts`
Expected: FAIL, `audit` is not a known admin command.

- [ ] **Step 3: args, main, identity CLI, license CLI**

`args.ts`: add `| { readonly command: 'admin-audit-export'; readonly from?: string; readonly to?: string; readonly action?: string; readonly workspace?: string }` to `ServerCommand`; add `from: { type: 'string' }, to: { type: 'string' }, action: { type: 'string' }, workspace: { type: 'string' }` to the `parseArgs` options; guard them the way `--no-admin` is guarded (set outside `admin audit export` → `UsageError('--from applies to admin audit export only')`, and the same for the other three); in the `admin` switch:

```ts
          case 'audit': {
            if (third !== 'export') {
              throw new UsageError('usage: wirebench-server admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]');
            }
            for (const key of ['from', 'to'] as const) {
              const value = parsed.values[key];
              if (value !== undefined && Number.isNaN(Date.parse(value))) throw new UsageError(`--${key} must be an ISO 8601 date-time`);
            }
            return {
              command: 'admin-audit-export',
              ...(parsed.values.from !== undefined ? { from: parsed.values.from } : {}),
              ...(parsed.values.to !== undefined ? { to: parsed.values.to } : {}),
              ...(parsed.values.action !== undefined ? { action: parsed.values.action } : {}),
              ...(parsed.values.workspace !== undefined ? { workspace: parsed.values.workspace } : {}),
            };
          }
```

One `HELP_TEXT` line: `  admin audit export [--from <iso>] [--to <iso>] [--action <name or group.>] [--workspace <id>]   Write the audit log as NDJSON to stdout`.

`main.ts`: add `case 'admin-audit-export':` to the `admin-*` cases that call `runAdmin`.

`identity/cli.ts`, in `runAdmin`: after `env` is built, `env.ctx.hooks.audit.push(auditHook(env.now));` (ruling 2). Add `case 'admin-audit-export': return await runAuditCommand(command, { db, hooks: env.ctx.hooks, now: env.now }, io);`. The license branch passes `hooks: env.ctx.hooks` into `runLicenseCommand`'s env.

`licensing/cli.ts`: the env gains `readonly hooks: ServerHooks`. After `installLicense` succeeds:

```ts
    await recordAudit(env.hooks, env.db, {
      ...SYSTEM_SOURCE,
      action: 'license.installed',
      target: { kind: 'license', id: changed.licenseId },
      details: { edition: changed.edition ?? null, via: 'cli' },
    });
```

After `removeLicense` returns a change: the same with `license.removed`, `target: { kind: 'license', id: changed.licenseId }` and `details: { via: 'cli' }`.

- [ ] **Step 4: `audit-log/cli.ts`**

```ts
// packages/server/src/audit-log/cli.ts
/**
 * `wirebench-server admin audit export …` (audit-log spec §3.5): the lines the endpoint streams, to
 * stdout, for a scheduled collector on the box. It needs no license: the operator has the database. It
 * records `audit.exported` with the system actor.
 */
import { auditExportQuerySchema } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { recordAudit, SYSTEM_SOURCE, type Querier, type ServerHooks } from '../context.js';
import { ExitCode, type ServerIo } from '../io.js';
import { exportedEvent, exportLines, filterOf } from './routes.js';

type AuditCommand = Extract<ServerCommand, { command: 'admin-audit-export' }>;

export async function runAuditCommand(
  command: AuditCommand,
  env: { readonly db: Querier; readonly hooks: ServerHooks; readonly now: () => Date },
  io: ServerIo,
): Promise<number> {
  const parsed = auditExportQuerySchema.safeParse({
    ...(command.from !== undefined ? { from: new Date(command.from).toISOString() } : {}),
    ...(command.to !== undefined ? { to: new Date(command.to).toISOString() } : {}),
    ...(command.action !== undefined ? { action: command.action } : {}),
    ...(command.workspace !== undefined ? { workspaceId: command.workspace } : {}),
  });
  if (!parsed.success) {
    io.stderr.write(`${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')}\n`);
    return ExitCode.Config;
  }
  const query = parsed.data;
  const lines = exportLines(env.db, filterOf(query), (count) => recordAudit(env.hooks, env.db, exportedEvent(SYSTEM_SOURCE, query, count)));
  for await (const line of lines) io.stdout.write(line);
  return ExitCode.Ok;
}
```

- [ ] **Step 5: Integration test**

Model `packages/server/test/integration/audit-log/cli.test.ts` on the licensing CLI test (`test/integration/licensing/cli.test.ts`): the same database setup, the same `io` fake, `runAdmin` with `publicKeys: keys.publicKeys`. Cases:

```ts
it('invites, installs a license, then exports both events with the system actor', async () => {
  expect(await runAdmin({ command: 'admin-invite', email: 'a@example.com', admin: true }, env, io)).toBe(0);
  expect(await runAdmin({ command: 'admin-license-install', file: licenseFile }, env, io)).toBe(0);
  io.stdout.clear();
  expect(await runAdmin({ command: 'admin-audit-export' }, env, io)).toBe(0);
  const lines = io.stdout
    .text()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { action: string; actor: { kind: string }; details: Record<string, unknown> });
  expect(lines.map((l) => l.action)).toEqual(['user.invited', 'license.installed']);
  expect(lines.every((l) => l.actor.kind === 'system')).toBe(true);
  expect(lines[1]!.details).toMatchObject({ via: 'cli', edition: 'team' });
  io.stdout.clear();
  expect(await runAdmin({ command: 'admin-audit-export', action: 'audit.' }, env, io)).toBe(0);
  const exported = JSON.parse(io.stdout.text().trim()) as { details: { count: number } };
  expect(exported.details.count).toBe(2);
});

it('a bad action pattern is a configuration error that names the field', async () => {
  expect(await runAdmin({ command: 'admin-audit-export', action: 'Nope' }, env, io)).toBe(2);
  expect(io.stderr.text()).toContain('action');
});

it('writes no secret-shaped value: the license line never reaches a row', () => expectNoSecretsInAudit(env.db));
```

Match the `io` fake's accessor names (`text()`, `clear()`) to what the licensing CLI test defines.

- [ ] **Step 6: Run, gate, commit**

Run: `pnpm exec vitest run packages/server/test/unit/args.test.ts && WIREBENCH_SERVER_TEST_DATABASE_URL=… pnpm exec vitest run --project server-integration packages/server/test/integration/audit-log/cli.test.ts packages/server/test/integration/licensing && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): admin audit export, and the console records its own invites and license changes (#198)"
```

---

### Task 8: Desktop main: wire shapes, channels, `ServerClient.queryAudit`, the streamed export to a file

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (after the server license section), `apps/desktop/src/shared/ipc.ts` (after the `license` block), `apps/desktop/src/main/server-client.ts`, `apps/desktop/src/main/index.ts` (beside `registerLicenseChannels`), `apps/desktop/test/mocks/wirebench-api.ts`, `apps/desktop/test/preload-api.test.ts`
- Create: `apps/desktop/src/main/ipc/audit.ts`
- Test: `apps/desktop/test/ipc-audit.test.ts`, `apps/desktop/test/server-client-audit.test.ts`

**Interfaces:**
- Consumes: `auditPageSchema`, `AuditPage`, `AuditQuery`, `AuditExportQuery` (`@wirebench/engine`; main may import values); the engine's `stream` request hook (`accept(status, headers)` returning a sink with `onChunk`, or `undefined` to buffer); `withToken`, `registerHandler`, `pickSaveFile(sender, picks, opts)`; `ServerClient`'s private `call`, `withQuery`, `normalizeServerUrl`, `this.deps.options`, `this.send`.
- Produces: wire schemas `auditActorWireSchema`, `auditEventWireSchema`, `auditQueryWireSchema`, `auditPageWireSchema`, `auditQueryRequestWireSchema` (`{ url, query }`), `auditExportRequestWireSchema` (`{ url, query }` without `after`/`limit`), `auditExportResponseWireSchema` (`{ saved: false } | { saved: true; path; count }`) and the types `AuditEventWire`, `AuditPageWire`, `AuditQueryWire`, `AuditExportResponseWire`; channels `audit.query`, `audit.export`; `ServerClient.queryAudit(url, token, query): Promise<AuditPage>`; `ServerClient.streamAuditExport(url, token, query, sink): Promise<void>`; `registerAuditChannels(deps)`; `auditFileName(at)`.

- [ ] **Step 1: Wire types and channels**

In `wire-types.ts`, a section `// --- Server audit log (audit-log spec §3.4, §5.3) ---` restating the engine shapes with the license section's comment (the renderer imports only the types). `auditEventWireSchema` takes `action` as `z.string()` so an older desktop still parses a newer server's action:

```ts
export const auditActorWireSchema = z.object({
  kind: z.enum(['user', 'ci-token', 'system', 'anonymous']),
  userId: z.string().optional(),
  email: z.string().optional(),
  tokenId: z.string().optional(),
  workspaceId: z.string().optional(),
});
export const auditEventWireSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: auditActorWireSchema,
  action: z.string(),
  target: z.object({ kind: z.string(), id: z.string().nullable() }),
  workspaceId: z.string().nullable(),
  teamId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export const auditQueryWireSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  action: z.string().regex(/^[a-z_]+\.([a-z_]+)?$/).optional(),
  actorUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  teamId: z.string().optional(),
  targetKind: z.string().optional(),
  targetId: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const auditPageWireSchema = z.object({ events: z.array(auditEventWireSchema), next: z.string().optional() });
export const auditQueryRequestWireSchema = z.object({ url: z.string(), query: auditQueryWireSchema });
export const auditExportRequestWireSchema = z.object({ url: z.string(), query: auditQueryWireSchema.omit({ after: true, limit: true }) });
export const auditExportResponseWireSchema = z.union([
  z.object({ saved: z.literal(false) }),
  z.object({ saved: z.literal(true), path: z.string(), count: z.number().int().nonnegative() }),
]);
export type AuditEventWire = z.infer<typeof auditEventWireSchema>;
export type AuditPageWire = z.infer<typeof auditPageWireSchema>;
export type AuditQueryWire = z.infer<typeof auditQueryWireSchema>;
export type AuditExportResponseWire = z.infer<typeof auditExportResponseWireSchema>;
```

In `ipc.ts`, after `license`:

```ts
  /** The server's audit log (audit-log spec §3.6): server admins on Enterprise; main adds the token and picks the export file. */
  audit: {
    query: defineChannel('audit.query', auditQueryRequestWireSchema, auditPageWireSchema),
    export: defineChannel('audit.export', auditExportRequestWireSchema, auditExportResponseWireSchema),
  },
```

`test/mocks/wirebench-api.ts`: `audit: { query: fail('audit.query'), export: fail('audit.export') },`. `test/preload-api.test.ts`: add `'audit'` to the expected keys.

- [ ] **Step 2: Write the failing `ServerClient` test**

```ts
// apps/desktop/test/server-client-audit.test.ts
import { describe, expect, it } from 'vitest';
import { ServerClient } from '../src/main/server-client.js';

const json = (status: number, body: unknown) =>
  ({ status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) }) as never;

describe('ServerClient audit (audit-log spec §3.4, plan ruling 16)', () => {
  it('queryAudit builds the query string and parses the page', async () => {
    const seen: string[] = [];
    const client = new ServerClient({
      send: (req) => {
        seen.push(req.url);
        return Promise.resolve(json(200, { events: [], next: 'c1' }));
      },
    });
    const page = await client.queryAudit('https://s.example', 'tok', { action: 'auth.', limit: 10, after: 'c0' });
    expect(seen[0]).toBe('https://s.example/api/v1/audit?action=auth.&after=c0&limit=10');
    expect(page.next).toBe('c1');
  });

  it('streamAuditExport hands each chunk to the sink and resolves at the end', async () => {
    const chunks: string[] = [];
    const client = new ServerClient({
      send: (req) => {
        const sink = req.stream!.accept(200, { 'content-type': 'application/x-ndjson' })!;
        sink.onChunk(new TextEncoder().encode('{"a":1}\n'));
        sink.onChunk(new TextEncoder().encode('{"a":2}\n'));
        return Promise.resolve({ status: 200, headers: {}, body: new Uint8Array(), streamEnd: { by: 'server' } } as never);
      },
    });
    await client.streamAuditExport('https://s.example', 'tok', {}, (chunk) => chunks.push(new TextDecoder().decode(chunk)));
    expect(chunks.join('')).toBe('{"a":1}\n{"a":2}\n');
  });

  it("a problem status is not streamed and rejects with the server's code", async () => {
    const client = new ServerClient({
      send: (req) => {
        expect(req.stream!.accept(403, { 'content-type': 'application/json' })).toBeUndefined();
        return Promise.resolve(json(403, { code: 'licensing-feature-required', message: 'no' }));
      },
    });
    await expect(client.streamAuditExport('https://s.example', 'tok', {}, () => undefined)).rejects.toMatchObject({ code: 'licensing-feature-required' });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/test/server-client-audit.test.ts`
Expected: FAIL, `queryAudit` is not a function.

- [ ] **Step 4: `ServerClient` methods**

Beside the license methods in `server-client.ts`:

```ts
  // ---- audit log (audit-log spec §3.4): server admins on Enterprise ------------------------------

  queryAudit(url: string, token: string, query: AuditQuery): Promise<AuditPage> {
    return this.call(url, { method: 'GET', path: withQuery('/api/v1/audit', auditParams(query)), token, schema: auditPageSchema });
  }

  /**
   * Streams the NDJSON export to `sink` as it arrives (audit-log plan ruling 16): `call()` buffers and
   * expects JSON, so this builds the request itself. A non-2xx is read whole and raised as the problem.
   */
  async streamAuditExport(url: string, token: string, query: AuditExportQuery, sink: (chunk: Uint8Array) => void): Promise<void> {
    const origin = normalizeServerUrl(url);
    const options = await this.deps.options?.(origin);
    let streamed = false;
    const response = await this.send({
      url: `${origin}${withQuery('/api/v1/audit/export', auditParams(query))}`,
      method: 'GET',
      headers: { accept: 'application/x-ndjson', authorization: `Bearer ${token}` },
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
      followRedirects: false,
      ...transportOptions(options),
      stream: {
        accept: (status) => {
          if (status < 200 || status >= 300) return undefined;
          streamed = true;
          return { onChunk: sink };
        },
      },
    }).catch((cause: unknown) => {
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`, { cause });
    });
    if (!streamed) this.throwProblem(origin, response);
    if (response.streamEnd?.by === 'error') {
      throw new WirebenchError('server-unreachable', `The export from ${origin} stopped early`, { cause: response.streamEnd.error });
    }
  }
```

At module level:

```ts
const auditParams = (q: AuditQuery | AuditExportQuery): Record<string, string | number | undefined> => ({
  action: q.action,
  actorUserId: q.actorUserId,
  ...('after' in q ? { after: q.after } : {}),
  from: q.from,
  ...('limit' in q ? { limit: q.limit } : {}),
  targetId: q.targetId,
  targetKind: q.targetKind,
  teamId: q.teamId,
  to: q.to,
  workspaceId: q.workspaceId,
});
```

Keys are listed alphabetically because `withQuery` keeps the object's order and the test asserts the string. Extract the non-2xx branch of `call()` into `private throwProblem(origin: string, response: HttpResponse): never` and the tls/proxy spread into a module-level `transportOptions(options)`, so both paths raise the same `WirebenchError` and send the same transport settings. Read `call()` first; the names of the fields it spreads are what `transportOptions` returns.

- [ ] **Step 5: The channels**

```ts
// apps/desktop/src/main/ipc/audit.ts
/**
 * `audit.*` (audit-log spec §3.6, §5.3): the Audit tab's calls, on the account's session. Main picks the
 * export file and writes the stream to it as it arrives (plan ruling 16); the renderer never sees a path.
 */
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { channels } from '../../shared/ipc.js';
import { pickSaveFile, type DialogPicks } from '../native-dialogs.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface AuditChannelDeps {
  readonly client: Pick<ServerClient, 'queryAudit' | 'streamAuditExport'>;
  readonly accounts: TokenSource;
  readonly picks: DialogPicks;
  /** Injected clock for the default file name. */
  readonly now?: () => Date;
}

export const auditFileName = (at: Date): string => `wirebench-audit-${at.toISOString().slice(0, 10)}.ndjson`;

export function registerAuditChannels(deps: AuditChannelDeps): void {
  registerHandler(channels.audit.query, (r) => withToken(deps, r.url, (url, token) => deps.client.queryAudit(url, token, r.query)));

  registerHandler(channels.audit.export, async (r, sender) => {
    const path = await pickSaveFile(sender, deps.picks, {
      title: 'Export audit log',
      filters: [{ name: 'Newline-delimited JSON', extensions: ['ndjson'] }],
      defaultPath: auditFileName((deps.now ?? (() => new Date()))()),
    });
    if (path === undefined) return { saved: false as const };
    const out = createWriteStream(path);
    let count = 0;
    try {
      await withToken(deps, r.url, (url, token) =>
        deps.client.streamAuditExport(url, token, r.query, (chunk) => {
          for (const byte of chunk) if (byte === 0x0a) count += 1;
          out.write(chunk);
        }),
      );
    } finally {
      out.end();
      await once(out, 'close');
    }
    return { saved: true as const, path, count };
  });
}
```

Use the real exported names from `native-dialogs.ts` and `server-token.ts` (`pickSaveFile`'s picks type, `withToken`'s deps type); the shapes above follow `ipc/license.ts` and `ipc/http-log.ts`. A stream that stops early leaves the partial file and the error reaches the renderer through the envelope. In `main/index.ts`, beside `registerLicenseChannels`: `registerAuditChannels({ client: serverClient, accounts: accountService, picks: dialogPicks });` with the variable names that file uses.

- [ ] **Step 6: The channel test**

`apps/desktop/test/ipc-audit.test.ts`, structured as `ipc-license.test.ts` (the `ipcMain.handle` mock into a Map, a stub client, `vi.mock('../src/main/native-dialogs.js')` for `pickSaveFile`):

```ts
it('audit.query forwards url, token and query and returns the page', async () => {
  const page = { events: [], next: undefined };
  const client = { queryAudit: vi.fn().mockResolvedValue(page), streamAuditExport: vi.fn() };
  registerAuditChannels({ client, accounts: signedIn('tok'), picks: {} as never });
  const result = await invoke('audit.query', { url: 'https://s.example', query: { limit: 10 } });
  expect(client.queryAudit).toHaveBeenCalledWith('https://s.example', 'tok', { limit: 10 });
  expect(result).toEqual({ ok: true, value: page });
});

it('audit.export with the dialog cancelled saves nothing and never calls the server', async () => {
  pickSaveFileMock.mockResolvedValue(undefined);
  const client = { queryAudit: vi.fn(), streamAuditExport: vi.fn() };
  registerAuditChannels({ client, accounts: signedIn('tok'), picks: {} as never });
  expect(await invoke('audit.export', { url: 'https://s.example', query: {} })).toEqual({ ok: true, value: { saved: false } });
  expect(client.streamAuditExport).not.toHaveBeenCalled();
});

it('audit.export writes the chunks to the picked file and counts the lines', async () => {
  const path = join(dir, 'audit.ndjson');
  pickSaveFileMock.mockResolvedValue(path);
  const client = {
    queryAudit: vi.fn(),
    streamAuditExport: vi.fn(async (_u: string, _t: string, _q: unknown, sink: (c: Uint8Array) => void) => {
      sink(new TextEncoder().encode('{"a":1}\n{"a":'));
      sink(new TextEncoder().encode('2}\n'));
      sink(new TextEncoder().encode(''));
    }),
  };
  registerAuditChannels({ client, accounts: signedIn('tok'), picks: {} as never });
  expect(await invoke('audit.export', { url: 'https://s.example', query: { action: 'auth.' } })).toEqual({
    ok: true,
    value: { saved: true, path, count: 2 },
  });
  expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
});

it('a signed-out account is the envelope error account-signed-out and no file is written', async () => {
  const path = join(dir, 'none.ndjson');
  pickSaveFileMock.mockResolvedValue(path);
  registerAuditChannels({ client: { queryAudit: vi.fn(), streamAuditExport: vi.fn() }, accounts: signedOut(), picks: {} as never });
  const result = await invoke('audit.export', { url: 'https://s.example', query: {} });
  expect(result).toMatchObject({ ok: false, error: { code: 'account-signed-out' } });
  expect(existsSync(path)).toBe(false);
});
```

`signedIn`, `signedOut`, `invoke` and `pickSaveFileMock` are the fixtures `ipc-license.test.ts` defines; reuse its shapes. The fourth case needs the file opened after the token is resolved: move `createWriteStream(path)` inside the `withToken` callback and keep `out` in the enclosing scope for the `finally`, if the test shows the stream is created before the token check.

- [ ] **Step 7: Run, gate, commit**

Run: `pnpm exec vitest run apps/desktop/test/ipc-audit.test.ts apps/desktop/test/server-client-audit.test.ts apps/desktop/test/preload-api.test.ts && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat(desktop): audit channels, a paged query and a streamed NDJSON export to a chosen file (#198)"
```

---

### Task 9: Desktop renderer: the Audit tab

**Files:**
- Create: `apps/desktop/src/renderer/state/audit.ts`, `state/audit-format.ts`, `features/team/audit-tab.tsx`, `features/team/audit-filter-bar.tsx`, `features/team/audit-detail.tsx`
- Modify: `apps/desktop/src/renderer/state/team.ts` (`TeamTab` gains `'audit'`; the non-admin guard covers it), `features/team/team-dialog.tsx` (tab strip, ruling 15, panel)
- Test: `apps/desktop/test/audit-format.test.ts`, `apps/desktop/test/renderer/audit-tab.test.tsx`, `apps/desktop/test/renderer/team-dialog.test.tsx` (one case)

**Interfaces:**
- Consumes: `ipc()` (`state/ipc-client.ts`); types `AuditEventWire`, `AuditQueryWire` from `shared/wire-types.ts` (type-only); `useGridNavigation` (`lib/grid-navigation.ts`); `Button`, `EmptyState`, the renderer's toast helper; `SELECT_CLASS` (`features/team/roles.ts`); `useTeamStore` (`serverAdmin`, the selected team's workspaces).
- Produces: `useAuditStore` with `{ events, next, loaded, loading, loadingMore, exporting, error, filter, selectedId }` and `setFilter(url, patch)`, `load(url)`, `loadMore(url)`, `select(id)`, `exportToFile(url)`, `reset()`; `queryOf(filter, now, after?)`, `PAGE_SIZE`; in `audit-format.ts`: `RANGE_PRESETS`, `RANGE_LABELS`, `rangeOf(preset, now)`, `ACTION_GROUPS`, `ACTION_GROUP_LABELS`, `actionLabel`, `actorLabel`, `targetLabel`, `GATED_PATTERN`.

- [ ] **Step 1: Write the failing pure test**

```ts
// apps/desktop/test/audit-format.test.ts
import { AUDIT_ACTION_GROUPS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { ACTION_GROUP_LABELS, ACTION_GROUPS, actionLabel, actorLabel, rangeOf, targetLabel } from '../src/renderer/state/audit-format.js';

describe('audit labels and ranges (audit-log spec §3.6)', () => {
  const now = new Date('2026-10-02T12:00:00Z');

  it('range presets are half-open from the past to now, and "all" is unbounded', () => {
    expect(rangeOf('24h', now)).toEqual({ from: '2026-10-01T12:00:00.000Z', to: undefined });
    expect(rangeOf('7d', now).from).toBe('2026-09-25T12:00:00.000Z');
    expect(rangeOf('30d', now).from).toBe('2026-09-02T12:00:00.000Z');
    expect(rangeOf('all', now)).toEqual({ from: undefined, to: undefined });
  });

  it('the renderer copy of the groups matches the engine', () => {
    expect([...ACTION_GROUPS]).toEqual([...AUDIT_ACTION_GROUPS]);
  });

  it('labels are words, not identifiers', () => {
    expect(actionLabel('workspace.default_role_changed')).toBe('Default role changed');
    expect(actionLabel('ci_token.revoked')).toBe('Revoked');
    expect(ACTION_GROUP_LABELS['ci_token']).toBe('CI tokens');
    expect(actorLabel({ kind: 'user', email: 'a@example.com' })).toBe('a@example.com');
    expect(actorLabel({ kind: 'system' })).toBe('Server console');
    expect(actorLabel({ kind: 'anonymous' })).toBe('Not signed in');
    expect(actorLabel({ kind: 'ci-token', tokenId: 'T' })).toBe('CI token');
    expect(targetLabel({ target: { kind: 'invitation', id: 'I1' }, details: { emailLower: 'x@example.com' } })).toBe('Invitation for x@example.com');
    expect(targetLabel({ target: { kind: 'team', id: 'T1' }, details: { name: 'Billing' } })).toBe('Team Billing');
    expect(targetLabel({ target: { kind: 'server', id: null }, details: {} })).toBe('This server');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run apps/desktop/test/audit-format.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: `audit-format.ts`**

```ts
// apps/desktop/src/renderer/state/audit-format.ts
/**
 * Labels and ranges for the Audit tab (audit-log spec §3.6), kept apart from the store so a node test
 * can import them, and free of zod values (the renderer CSP trap). `audit-format.test.ts` keeps the
 * group list honest against the engine's `AUDIT_ACTION_GROUPS`.
 */
import type { AuditEventWire } from '../../shared/wire-types.js';

export const RANGE_PRESETS = ['24h', '7d', '30d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABELS: Record<RangePreset, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };
const HOURS: Record<Exclude<RangePreset, 'all'>, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

export function rangeOf(preset: RangePreset, now: Date): { from: string | undefined; to: string | undefined } {
  if (preset === 'all') return { from: undefined, to: undefined };
  return { from: new Date(now.getTime() - HOURS[preset] * 60 * 60 * 1000).toISOString(), to: undefined };
}

export const ACTION_GROUPS = ['auth', 'user', 'team', 'workspace', 'secret', 'hook', 'ci_token', 'license', 'audit'] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];
export const ACTION_GROUP_LABELS: Record<ActionGroup, string> = {
  auth: 'Sign-ins',
  user: 'Users',
  team: 'Teams',
  workspace: 'Workspaces',
  secret: 'Team secrets',
  hook: 'Catch URLs',
  ci_token: 'CI tokens',
  license: 'License',
  audit: 'Audit log',
};

/** The server's `licensing-feature-required` message names the edition; the tab shows its notice on it. */
export const GATED_PATTERN = /Enterprise edition/;

export function actionLabel(action: string): string {
  const words = (action.split('.')[1] ?? action).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actorLabel(
  actor: Pick<AuditEventWire['actor'], 'kind'> & Partial<Pick<AuditEventWire['actor'], 'email' | 'userId' | 'tokenId'>>,
): string {
  switch (actor.kind) {
    case 'user':
      return actor.email ?? actor.userId ?? 'User';
    case 'ci-token':
      return 'CI token';
    case 'system':
      return 'Server console';
    default:
      return 'Not signed in';
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function targetLabel(event: { target: { kind: string; id: string | null }; details: Record<string, unknown> }): string {
  const d = event.details;
  switch (event.target.kind) {
    case 'server':
      return 'This server';
    case 'user': {
      const email = str(d['emailLower']);
      return email === undefined ? 'User' : `User ${email}`;
    }
    case 'invitation':
      return `Invitation for ${str(d['emailLower']) ?? '…'}`;
    case 'team':
      return `Team ${str(d['name']) ?? str(d['previousName']) ?? ''}`.trim();
    case 'workspace':
      return `Workspace ${str(d['name']) ?? str(d['previousName']) ?? ''}`.trim();
    case 'hook':
      return `Catch URL ${str(d['name']) ?? ''}`.trim();
    case 'ci-token':
      return `CI token ${str(d['name']) ?? ''}`.trim();
    case 'license':
      return 'License';
    default:
      return event.target.kind;
  }
}
```

Run the test again: PASS.

- [ ] **Step 4: The store**

```ts
// apps/desktop/src/renderer/state/audit.ts
/**
 * The Audit tab's state (audit-log spec §3.6). The same stale-answer guard as `state/license.ts`: a
 * `load` that is no longer the latest is dropped, and `reset` bumps the epoch so a late answer from a
 * closed dialog changes nothing. The filter lives here so reopening the tab keeps it within a session.
 */
import { create } from 'zustand';
import type { AuditEventWire, AuditQueryWire } from '../../shared/wire-types.js';
import { rangeOf, type ActionGroup, type RangePreset } from './audit-format.js';
import { ipc } from './ipc-client.js';
import { showToast } from './toast.js';

export interface AuditFilter {
  readonly range: RangePreset;
  readonly group: ActionGroup | 'all';
  readonly workspaceId: string | undefined;
}

export interface AuditSnapshot {
  readonly events: readonly AuditEventWire[];
  readonly next: string | undefined;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly exporting: boolean;
  readonly error: string | undefined;
  readonly filter: AuditFilter;
  readonly selectedId: string | undefined;
}

interface AuditActions {
  setFilter(url: string, patch: Partial<AuditFilter>): Promise<void>;
  load(url: string): Promise<void>;
  loadMore(url: string): Promise<void>;
  select(id: string | undefined): void;
  exportToFile(url: string): Promise<void>;
  reset(): void;
}

export const PAGE_SIZE = 50;

const EMPTY: AuditSnapshot = {
  events: [],
  next: undefined,
  loaded: false,
  loading: false,
  loadingMore: false,
  exporting: false,
  error: undefined,
  filter: { range: '7d', group: 'all', workspaceId: undefined },
  selectedId: undefined,
};

export function queryOf(filter: AuditFilter, now: Date, after?: string): AuditQueryWire {
  const range = rangeOf(filter.range, now);
  return {
    ...(range.from !== undefined ? { from: range.from } : {}),
    ...(filter.group !== 'all' ? { action: `${filter.group}.` } : {}),
    ...(filter.workspaceId !== undefined ? { workspaceId: filter.workspaceId } : {}),
    ...(after !== undefined ? { after } : {}),
    limit: PAGE_SIZE,
  };
}

let loads = 0;
let epoch = 0;

export const useAuditStore = create<AuditSnapshot & AuditActions>((set, get) => ({
  ...EMPTY,
  async setFilter(url, patch) {
    set({ filter: { ...get().filter, ...patch }, selectedId: undefined });
    await get().load(url);
  },
  async load(url) {
    const mine = ++loads;
    set({ loading: true, error: undefined });
    const result = await ipc().audit.query({ url, query: queryOf(get().filter, new Date()) });
    if (mine !== loads) return;
    if (result.ok) set({ events: result.value.events, next: result.value.next, loaded: true, loading: false });
    else set({ loaded: true, loading: false, error: result.error.message, events: [], next: undefined });
  },
  async loadMore(url) {
    const { next, filter, loadingMore } = get();
    if (next === undefined || loadingMore) return;
    const started = epoch;
    set({ loadingMore: true });
    const result = await ipc().audit.query({ url, query: queryOf(filter, new Date(), next) });
    if (started !== epoch) return;
    if (result.ok) set((s) => ({ events: [...s.events, ...result.value.events], next: result.value.next, loadingMore: false }));
    else set({ loadingMore: false, error: result.error.message });
  },
  select(id) {
    set({ selectedId: id });
  },
  async exportToFile(url) {
    const { limit: _limit, after: _after, ...query } = queryOf(get().filter, new Date());
    set({ exporting: true });
    const result = await ipc().audit.export({ url, query });
    set({ exporting: false });
    if (!result.ok) showToast(result.error.message);
    else if (result.value.saved) showToast(`Exported ${String(result.value.count)} events to ${result.value.path}`);
  },
  reset() {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
```

`showToast` stands for the renderer's toast helper; read `state/license.ts` or `features/team/license-tab.tsx` for the one the team dialog uses and import that.

`state/team.ts`: `export type TeamTab = 'members' | 'workspaces' | 'invitations' | 'license' | 'audit';` and the non-admin guard becomes `if (!list.serverAdmin && (get().tab === 'license' || get().tab === 'audit')) set({ tab: 'members' });`.

- [ ] **Step 5: The components**

`audit-filter-bar.tsx`: `export function AuditFilterBar({ url, workspaces }: { readonly url: string; readonly workspaces: readonly { id: string; name: string }[] })`. Three `<select className={SELECT_CLASS}>` with visible `<label>`s: *Range* (`RANGE_PRESETS` / `RANGE_LABELS`), *Kind* (`all` plus `ACTION_GROUPS` / `ACTION_GROUP_LABELS`), *Workspace* (rendered only when `workspaces.length > 0`: *Any workspace* plus the list). Each `onChange` calls `useAuditStore.getState().setFilter(url, { … })`. A ghost *Refresh* `Button` calls `load(url)`; a primary *Export…* `Button` calls `exportToFile(url)` and is `disabled={exporting}`. Test ids: `audit-range`, `audit-group`, `audit-workspace`, `audit-refresh`, `audit-export`.

`audit-detail.tsx`: `export function AuditDetail({ event, onClose }: { readonly event: AuditEventWire; readonly onClose: () => void })`. A `<section aria-label="Event detail" data-testid="audit-detail">` with the License tab's `<dl>` grid pattern: *When* (`new Date(event.at).toLocaleString()`), *Who* (`actorLabel`), *What* (`actionLabel` plus the group label), *Target* (`targetLabel`), *Workspace* (`event.workspaceId ?? '—'`), *Team*, *Address* (`event.ip ?? '—'`), *Client* (`event.userAgent ?? '—'`), *Event id*. Below, *Details* as `<pre data-testid="audit-details-json">{JSON.stringify(event.details, null, 2)}</pre>` with the repository's small-code classes. A ghost *Close* button top right calls `onClose`. No Monaco: the object is small and flat by construction.

`audit-tab.tsx`:

```tsx
export function AuditTab({ url, workspaces }: { readonly url: string; readonly workspaces: readonly { id: string; name: string }[] }) {
  const store = useAuditStore();
  useEffect(() => {
    void useAuditStore.getState().load(url);
    return () => {
      useAuditStore.getState().reset();
    };
  }, [url]);
  const nav = useGridNavigation(store.events.length, { onActiveRowChange: (i) => store.select(store.events[i]?.id) });
  const selected = store.events.find((e) => e.id === store.selectedId);

  if (store.error !== undefined && store.events.length === 0 && GATED_PATTERN.test(store.error)) {
    return (
      <div data-testid="audit-tab" className="flex flex-col gap-3 text-sm">
        <p data-testid="audit-gated" role="status">
          The audit log is an Enterprise feature. Events are being recorded; install an Enterprise license to read them.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="audit-tab" className="flex h-full min-h-0 flex-col gap-3 text-sm">
      <AuditFilterBar url={url} workspaces={workspaces} />
      {store.error !== undefined && (
        <p data-testid="audit-error" role="alert" className="text-xs text-status-danger">
          {store.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {store.loaded && store.events.length === 0 ? (
            <EmptyState title="No events in this range" description="Widen the range or pick another kind." />
          ) : (
            <table role="grid" aria-label="Audit events" aria-rowcount={store.events.length} className="w-full text-left" {...nav.gridProps}>
              <thead>
                <tr>
                  <th role="columnheader">When</th>
                  <th role="columnheader">Who</th>
                  <th role="columnheader">What</th>
                  <th role="columnheader">Target</th>
                </tr>
              </thead>
              <tbody>
                {store.events.map((e, i) => (
                  <tr
                    key={e.id}
                    role="row"
                    aria-rowindex={i + 1}
                    aria-selected={e.id === store.selectedId}
                    data-testid="audit-row"
                    className={e.id === store.selectedId ? SELECTED_ROW_CLASS : undefined}
                    onClick={() => {
                      store.select(e.id);
                      nav.setActiveRow(i);
                    }}
                    {...nav.rowProps(i)}
                  >
                    <td>{new Date(e.at).toLocaleString()}</td>
                    <td>{actorLabel(e.actor)}</td>
                    <td>{actionLabel(e.action)}</td>
                    <td>{targetLabel(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {store.next !== undefined && (
            <div className="p-2">
              <Button data-testid="audit-load-more" disabled={store.loadingMore} onClick={() => void store.loadMore(url)}>
                {store.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
        {selected !== undefined && (
          <div className={DETAIL_PANE_CLASS}>
            <AuditDetail event={selected} onClose={() => store.select(undefined)} />
          </div>
        )}
      </div>
    </div>
  );
}
```

`SELECTED_ROW_CLASS` and `DETAIL_PANE_CLASS` stand for the class strings the repository already uses for a selected grid row and a right-hand detail pane: read `features/team/license-tab.tsx`, `features/webhooks/catch-url-tab.tsx` and the attachments table for them and inline the same tokens. Check `useGridNavigation`'s real option and return names in `lib/grid-navigation.ts` before using `gridProps`, `rowProps` and `setActiveRow`.

`team-dialog.tsx` (ruling 15):

```tsx
    const adminTabs: TabItem<TeamTab>[] = store.serverAdmin ? [{ id: 'license', label: 'License' }, { id: 'audit', label: 'Audit' }] : [];
    const tabs: TabItem<TeamTab>[] = team === undefined ? adminTabs : [...teamTabs, ...adminTabs];
    const activeTab: TeamTab = team === undefined ? (store.tab === 'audit' ? 'audit' : 'license') : store.tab;
```

where `teamTabs` is the members / workspaces / invitations list the file builds today. In the panel: `{activeTab === 'audit' && store.serverAdmin && url !== undefined && <AuditTab url={url} workspaces={workspacesOf(team)} />}` where `workspacesOf` maps the team store's workspace list to `{ id, name }` (the Workspaces tab already lists them; read its source for the field names).

- [ ] **Step 6: Renderer tests**

`test/renderer/audit-tab.test.tsx`, with `installWirebenchApi({ audit: { query, export } })` and `beforeEach(() => useAuditStore.getState().reset())`:

```tsx
const event = (i: number, action = 'auth.signed_in'): AuditEventWire => ({
  id: `01J9ZK3V8Q000000000000000${String(i)}`,
  at: new Date(Date.UTC(2026, 9, 2, 12, i)).toISOString(),
  actor: { kind: 'user', userId: 'U1', email: 'alice@example.com' },
  action,
  target: { kind: 'user', id: 'U1' },
  workspaceId: null,
  teamId: null,
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0',
  details: { method: 'local', device: 'laptop' },
});

it('a licensing-feature-required answer shows the gated notice and no filters', async () => {
  query.mockResolvedValue({ ok: false, error: { code: 'licensing-feature-required', message: 'This needs the Enterprise edition.' } });
  render(<AuditTab url="https://s.example" workspaces={[]} />);
  expect(await screen.findByTestId('audit-gated')).toBeInTheDocument();
  expect(screen.queryByTestId('audit-range')).toBeNull();
});

it('renders a page, opens a detail on click', async () => {
  query.mockResolvedValue({ ok: true, value: { events: [event(1), event(2, 'team.created')] } });
  render(<AuditTab url="https://s.example" workspaces={[]} />);
  expect(await screen.findAllByTestId('audit-row')).toHaveLength(2);
  fireEvent.click(screen.getAllByTestId('audit-row')[1]!);
  expect(screen.getByTestId('audit-detail')).toHaveTextContent('alice@example.com');
  expect(screen.getByTestId('audit-details-json')).toHaveTextContent('"method": "local"');
});

it('changing the kind queries with the group prefix', async () => {
  query.mockResolvedValue({ ok: true, value: { events: [] } });
  render(<AuditTab url="https://s.example" workspaces={[]} />);
  await screen.findByTestId('audit-range');
  fireEvent.change(screen.getByTestId('audit-group'), { target: { value: 'auth' } });
  await waitFor(() =>
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ action: 'auth.', limit: 50 }) })),
  );
});

it('Load more sends the cursor and appends the second page', async () => {
  query.mockResolvedValueOnce({ ok: true, value: { events: [event(1)], next: 'c1' } }).mockResolvedValueOnce({ ok: true, value: { events: [event(2)] } });
  render(<AuditTab url="https://s.example" workspaces={[]} />);
  fireEvent.click(await screen.findByTestId('audit-load-more'));
  await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(2));
  expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ after: 'c1' }) }));
  expect(screen.queryByTestId('audit-load-more')).toBeNull();
});

it('Export… sends the filter without a limit and toasts the count', async () => {
  query.mockResolvedValue({ ok: true, value: { events: [] } });
  exportMock.mockResolvedValue({ ok: true, value: { saved: true, path: '/tmp/a.ndjson', count: 3 } });
  render(<AuditTab url="https://s.example" workspaces={[]} />);
  fireEvent.click(await screen.findByTestId('audit-export'));
  await waitFor(() =>
    expect(exportMock).toHaveBeenCalledWith(expect.objectContaining({ query: expect.not.objectContaining({ limit: expect.anything() }) })),
  );
  expect(await screen.findByText(/Exported 3 events/)).toBeInTheDocument();
});
```

`test/renderer/team-dialog.test.tsx`: beside the case that shows a License tab to a server admin only, add one that shows an Audit tab to a server admin and, with no team, lets the Audit tab be selected.

- [ ] **Step 7: Run, gate, commit**

Run: `pnpm exec vitest run apps/desktop/test/audit-format.test.ts apps/desktop/test/renderer/audit-tab.test.tsx apps/desktop/test/renderer/team-dialog.test.tsx && WIREBENCH_SKIP_PERF=1 nice pnpm check` (the renderer import lint runs inside `pnpm lint`).
Expected: green.

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat(desktop): the Audit tab with filters, a keyboard grid, detail, load more and export (#198)"
```

---

### Task 10: One end-to-end path

**Files:**
- Modify: `e2e/helpers/fake-server.ts` (audit routes; `features` on an Enterprise license), `e2e/helpers/launch-app.ts` (an `env` option, if absent)
- Create: `e2e/specs/audit.spec.ts`

**Interfaces:**
- Consumes: `startFakeServer`, `launchApp`, `signIn`, `runCommand` as `e2e/specs/license.spec.ts` does; `WIREBENCH_E2E_DIALOG_SAVE`, which `pickSaveFile` honours in e2e builds.
- Produces: `FakeServerOptions.auditEvents?: AuditEvent[]`.

- [ ] **Step 1: The fake server**

`licenseState()` returns `features: installedLicense?.edition === 'enterprise' ? ['audit-log'] : []`. An in-memory `auditEvents` seeded from `FakeServerOptions.auditEvents`. Routes behind the session check:

```ts
  if (url.pathname === '/api/v1/audit' || url.pathname === '/api/v1/audit/export') {
    if (!user.serverAdmin) return problem(res, 403, 'identity-forbidden', 'Server admins only');
    if (!licenseState().features.includes('audit-log')) return problem(res, 403, 'licensing-feature-required', 'This needs the Enterprise edition.');
    const action = url.searchParams.get('action');
    const from = url.searchParams.get('from');
    const workspaceId = url.searchParams.get('workspaceId');
    const matching = auditEvents
      .filter(
        (e) => (action === null || e.action.startsWith(action)) && (from === null || e.at >= from) && (workspaceId === null || e.workspaceId === workspaceId),
      )
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    if (url.pathname.endsWith('/export')) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end([...matching].reverse().map((e) => `${JSON.stringify(e)}\n`).join(''));
      return;
    }
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const after = url.searchParams.get('after');
    const start = after === null ? 0 : Number(Buffer.from(after, 'base64url').toString());
    const events = matching.slice(start, start + limit);
    const next = start + limit < matching.length ? Buffer.from(String(start + limit)).toString('base64url') : undefined;
    return json(res, 200, { events, ...(next !== undefined ? { next } : {}) });
  }
```

Record each request in `server.requests` as the other routes do; use the file's own `problem` and `json` helpers.

- [ ] **Step 2: The spec**

```ts
// e2e/specs/audit.spec.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import { signIn } from '../helpers/server.js';

const PASSWORD = 'correct horse battery';
const ROOT: FakeUser = { email: 'root@example.com', password: PASSWORD, displayName: 'Root', serverAdmin: true };
const ENTERPRISE = `wbl1.${Buffer.from(
  JSON.stringify({
    id: '01J9ZK3V8Q0000000000000000',
    customer: 'Example AG',
    edition: 'enterprise',
    seats: null,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2099-09-01T00:00:00Z',
  }),
).toString('base64url')}.c2lnbmF0dXJl`;
const now = Date.now();
const EVENTS = [0, 1, 2].map((i) => ({
  id: `01J9ZK3V8Q000000000000000${String(i)}`,
  at: new Date(now - i * 60_000).toISOString(),
  actor: { kind: 'user', userId: 'U1', email: 'alice@example.com' },
  action: i === 1 ? 'team.created' : 'auth.signed_in',
  target: i === 1 ? { kind: 'team', id: 'T1' } : { kind: 'user', id: 'U1' },
  workspaceId: null,
  teamId: i === 1 ? 'T1' : null,
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0',
  details: i === 1 ? { name: 'Payments' } : { method: 'local', device: 'laptop' },
}));

test.describe('audit log (audit-log spec §3.6)', () => {
  let launched: LaunchedApp | undefined;
  let server: FakeServer | undefined;
  let userDataDir = '';
  let exportPath = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-audit-'));
    exportPath = join(userDataDir, 'audit.ndjson');
  });
  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await server?.close();
    server = undefined;
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('gated on Community; filters, opens a detail and exports on Enterprise', async () => {
    test.setTimeout(120_000);
    server = await startFakeServer({ users: [ROOT], auditEvents: EVENTS });
    launched = await launchApp({ userDataDir, keepUserDataDir: true, env: { WIREBENCH_E2E_DIALOG_SAVE: exportPath } });
    const page = launched.window;
    await signIn(page, server.url, ROOT);
    await runCommand(page, 'Account: Manage teams');
    const dialog = page.getByTestId('team-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('tab', { name: 'Audit' }).click();
    await expect(dialog.getByTestId('audit-gated')).toBeVisible();

    await dialog.getByRole('tab', { name: 'License' }).click();
    await dialog.getByTestId('license-input').fill(ENTERPRISE);
    await dialog.getByRole('button', { name: 'Install license' }).click();
    await expect(dialog.getByTestId('license-edition')).toHaveText('Enterprise');

    await dialog.getByRole('tab', { name: 'Audit' }).click();
    await expect(dialog.getByTestId('audit-row')).toHaveCount(3);
    await dialog.getByTestId('audit-group').selectOption('team');
    await expect(dialog.getByTestId('audit-row')).toHaveCount(1);
    await dialog.getByTestId('audit-row').first().click();
    await expect(dialog.getByTestId('audit-detail')).toContainText('alice@example.com');
    await expect(dialog.getByTestId('audit-details-json')).toContainText('"name": "Payments"');

    await dialog.getByTestId('audit-export').click();
    await expect.poll(() => readFileSync(exportPath, 'utf8').trim().split('\n').length).toBe(1);
    expect(server.requests.some((r) => r.method === 'GET' && r.path.startsWith('/api/v1/audit/export'))).toBe(true);
  });
});
```

Use the test ids and command name the License e2e spec uses for the dialog, the license input and the install button. If `launchApp` has no `env` option, add one in `e2e/helpers/launch-app.ts`, merged into the Electron process environment.

- [ ] **Step 3: Build and run in CI only**

Push the branch and let CI run e2e (`pnpm build && xvfb-run -a pnpm test:e2e` on the runner). Do not run it locally. Fix what CI reports.

- [ ] **Step 4: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add e2e
git commit -m "test(e2e): a server admin reads, filters and exports the audit log once Enterprise is installed (#198)"
```

---

### Task 11: Docs, changelog, roadmap, spec revisions

**Files:**
- Create: `docs-site/src/content/docs/guides/server-audit-log.mdx`
- Modify: `docs-site/astro.config.mjs` (after *Editions and licenses*), `docs-site/src/content/docs/guides/server-licensing.mdx` and `guides/wirebench-server.mdx` (*Related*), `site/src/docs-links.ts` (`serverAuditLog`), `site/src/pages/features.astro` (the *Teams and Wirebench Server* links), `packages/server/README.md` (an *Audit log* section after *License*), `CHANGELOG.md` (after the editions entry), `docs/roadmap.md` (item 18's status), `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` (*Revisions after planning*)

- [ ] **Step 1: The guide**

Frontmatter: `title: Audit log`; `description: What Wirebench Server records about who did what, how long it keeps it, and how a server admin reads or exports it.` Sections, in the voice of `server-licensing.mdx`:

- intro: recorded on every edition, read and exported on Enterprise; an event is who, what, which target, when, from where.
- **What is recorded**: a table of the groups (sign-ins, users, teams, workspaces, team secrets, catch URLs, CI tokens, license, exports), one line each; the sentence that pushes and license changes are recorded right after they complete while everything else is recorded in the same transaction as the change. What is not recorded: reads, captures arriving, sync fetches, live sockets.
- **Reading the log**: the Audit tab in *Account: Manage teams* for server admins; range, kind and workspace filters; the detail pane; *Load more*.
- **Exporting**: *Export…* writes newline-delimited JSON; `wirebench-server admin audit export` on the box with its four options and one example `cron` line; the export itself is recorded.
- **Retention**: `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, default 365, range 30–3650, swept every ten minutes.
- **Personal data**: `actor.email`, the IP address and the lower-cased email on a failed sign-in are personal data under the same retention; export then purge for one person with `delete from audit_events where actor_user_id = $1` run by the operator; the two `revoke update, delete on audit_events from <role>` statements for a database-level append-only guarantee.
- **Related**: the Wirebench Server and Editions and licenses guides.

- [ ] **Step 2: Links**

`astro.config.mjs`: `{ label: 'Audit log', slug: 'guides/server-audit-log' },` after the licenses entry. `docs-links.ts`: `serverAuditLog: 'guides/server-audit-log',` after `serverLicensing`. `features.astro`: `{ label: 'Audit log', slug: DOCS_LINKS.serverAuditLog },` after the licenses link. Both guides' *Related* lists: `- [Audit log](/wirebench/docs/guides/server-audit-log/): who did what on the server, read and exported by server admins.`

- [ ] **Step 3: README, changelog, roadmap, spec**

`packages/server/README.md`, after *License*:

```markdown
## Audit log

The server records who did what: sign-ins and failed sign-ins, users, teams, workspace roles, pushes,
team-secret changes, catch URLs, CI tokens and license changes. Recording is on for every edition; reading
needs an Enterprise license. Server admins read it in the app's Audit tab or export it:

    docker compose -f packages/server/compose.yaml exec server node /app/dist/bin.js admin audit export --from 2026-10-01T00:00:00Z > audit.ndjson

Events older than `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` (default 365) are deleted. See the docs site's
_Audit log_ guide for what each event carries and how to handle personal data.
```

`CHANGELOG.md`, under `### Added`, after the editions entry:

```markdown
- **Server audit log.** Wirebench Server records sign-ins, user, team and workspace changes, pushes,
  team-secret changes, catch URLs, CI tokens and license changes as immutable events, on every edition.
  Server admins on Enterprise read them in the new Audit tab and export them as newline-delimited JSON,
  from the app or with `wirebench-server admin audit export`. Retention is by age
  (`WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, default a year). See
  [Audit log](https://wirebench.github.io/wirebench/docs/guides/server-audit-log/).
```

`docs/roadmap.md`, item 18's status: `licensing built (#197); audit log built (#198)`.

The spec: append `## Revisions after planning` listing rulings 1–20 of this plan, one line each, with the plan's path; say that ruling 4 changes a requirement in §3.1 (a push's events are written after the ref moves and never fail the push) and that ruling 1 corrects §5.1 (`request.ciCaller`, not `request.caller`).

- [ ] **Step 4: Check the docs**

Run: `pnpm check:banned-terms && pnpm check:doc-paths && pnpm check:docs-images && pnpm docs:build && pnpm exec vitest run --project site`
Expected: green.

- [ ] **Step 5: Gate and commit**

Run: `WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add docs-site site packages/server/README.md CHANGELOG.md docs/roadmap.md docs/specs/2026-10-01-wirebench-server-audit-log-design.md
git commit -m "docs: the audit log guide, the server README, the changelog and the spec's revisions (#198)"
```

---

## After the last task

- `pnpm test:perf` unskipped before the push (repository gate). Push the branch and open the PR against `main`. Its body lists the rulings above and says that recording is on for every edition and only reading is gated. No generated-by footer.
- Close #198 through the PR; tick the audit line on epic #199.
- Follow-ups to open, each `audience: enterprise`, `area: server`, `priority: P3`, linked from #199: team-admin scoped reads (spec §16); syslog or HTTP push of events; hash-chaining for tamper evidence (spec §15); desktop-side events once there is a privacy ruling (spec §1.2).

## Open questions for the owner

Each has a default the plan already follows.

1. **Pushes are recorded after the ref moves and never fail the push** (ruling 4). The alternative, refusing the push when the audit row cannot be written, would make the client resend commits that are already on main.
2. **The secret scan in the tests uses five regular expressions** (Task 6, Step 7). If the secret-scanning plan (`docs/plans/2026-09-22-secret-scanning-plan.md`) exposes its pattern list from the engine, the helper should import it instead.
3. **`auth.sign_in_failed` keeps the lower-cased email** (spec §16), personal data under the same retention. The alternative is a hash, which keeps brute-force attempts countable but not readable.
