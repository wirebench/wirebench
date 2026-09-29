# Wirebench `webhook-signatures` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Webhooks sent from Wirebench carry a valid (or deliberately broken) signature, and every request that reaches a catch URL records whether it was correctly signed — three generic schemes, one implementation for both sides.

**Architecture:**

- **Engine.** `webhooks/signature.ts` signs and verifies *HMAC of body*, *timestamped HMAC* and *Standard Webhooks* over exact bytes. `webhooks/model.ts` gains `WebhookSigning` on the collection, its folders and its items (`RestRequestDef.signing`), resolved by `effectiveSigning`. The project files round-trip it at format 6. `sendRest` applies `RestSendInput.sign` last, over the encoded body. The runner (`run/select.ts`, `secret-needs.ts`, `prepare.ts`) resolves the secret from `WIREBENCH_SECRET_<secretEnv>`. `server-api/hooks.ts` wire shapes gain optional signature fields.
- **Server.** `WIREBENCH_SERVER_HOOKS_SECRET_KEY` (32 bytes, base64) keys `hooks/secret-box.ts` (AES-256-GCM). Migration `0005` adds the columns. The manage `PATCH` sets a scheme and a write-only secret; reads return the scheme and a hint. The public route verifies the **full** body before truncation, records the verdict, and answers `401` when *Reject unverified* holds.
- **Desktop main.** Wire types restate the new shapes. Mutations carry `signing` on items, folders and the collection. `resolveWebhookSend` reports the effective signing; `webhookSignFor` reads its secret from the keychain and the send refuses rather than go out unsigned. `hooks.*` answers pass the new fields through.
- **Renderer.** A *Signature* section in the catch URL settings; a ✓/✗ badge and a *401* marker on capture rows; a *Signature* block in the capture viewer's Details; the signing controls in *Webhooks settings* and a **Signing** tab for webhook items; *Save as webhook* drops the Standard Webhooks headers.
- **Proof.** Known-answer vectors computed below; engine, server (PostgreSQL), desktop main and jsdom tests per task; one CI-only e2e spec.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`), Node 24 `node:crypto`, zod 4, vitest 5, Fastify 5 + `pg` + PostgreSQL 16, Electron main/preload/renderer, React + zustand + Radix, Playwright e2e (CI only). **No new dependencies.**

**Spec:** `docs/specs/2026-09-29-wirebench-webhook-signatures-design.md` (binding). Section numbers below are the spec's.

## Global Constraints

- Branch `feat/webhook-signatures`, worktree `git-worktrees/webhook-signatures`.
- Commit as Mohammed Naami <m.naami@outlook.com>; NO Co-Authored-By and NO Claude-Session trailers.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 nice pnpm check` is green (add `NODE_OPTIONS=--max-old-space-size=8192` if typecheck runs out of heap). Run `pnpm test:perf` unskipped once before the push.
- Never name products/companies that inspired a feature (`pnpm check:banned-terms`); "Standard Webhooks" (the open specification) is allowed.
- Fixture secrets are neutral like `abc123def456ghi789`; never provider-shaped (`sk_live_…`); `whsec_` appears only as the Standard Webhooks scheme's documented prefix with neutral base64 content (`whsec_YWJjMTIzZGVmNDU2Z2hpNzg5` is `abc123def456ghi789`).
- No local Electron windows, no local e2e/Playwright runs; CI runs e2e. Headless checks under `nice`.
- Never touch port 5432. Server integration tests read `WIREBENCH_SERVER_TEST_DATABASE_URL` and skip without it (`packages/server/test/helpers/database.ts`). Locally: `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db`, once `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`, then `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`. Each test file gets its own schema (`testDatabase()`).
- Never bare `git stash` (the stash stack is shared across worktrees); use a WIP commit.
- Project format stays 6 (`FORMAT_VERSION` is unreleased and shared with request scripts and the webhook collection); only its doc comment changes.
- Renderer must not eagerly import values from wire-types (CSP zod eval trap): renderer modules import **only types** (`import type`) from `apps/desktop/src/shared/wire-types.ts` and from `@wirebench/engine` for everything this plan adds. Values the renderer needs (scheme labels, defaults, reason texts, limits, the header-name pattern) are restated in renderer files and pinned by a unit test. `wire-types.ts` itself imports nothing from the engine; it restates the engine's shapes.
- Single test runs: `nice pnpm vitest run <path>` from the worktree root (the root vitest config's projects pick the file up). Server integration files: `nice pnpm exec vitest run --project server-integration <path>`.
- `pnpm lint` runs `prettier --check .`: run `pnpm exec prettier --write <touched files>` before the gate.
- Error codes (engine/desktop): `webhook-signing-secret`, `webhook-signing-invalid`, `webhook-signing-not-webhook`. Server: `hooks-signature-key-unset` (409), `hooks-signature-secret-required` (400), `invalid-request` (400).
- UI labels: schemes *None*, *HMAC of body*, *Timestamped HMAC*, *Standard Webhooks*; reasons *missing header*, *malformed header*, *digest mismatch*, *timestamp outside tolerance*, *server key error*; tab **Signing**; checkbox **Reject unverified requests (401)**.

## Known-answer vectors (computed with `node:crypto`)

Inputs: secret `abc123def456ghi789`; body `{"event":"order.created"}` (25 bytes, UTF-8); timestamp `1790000000` (2026-09-21T14:13:20Z); id `msg_abc123`; second secret `zzz999yyy888xxx777`.

| Scheme | Value |
|---|---|
| HMAC-SHA1 hex | `6db609cce579e8456b98a94073445d14f37bd235` |
| HMAC-SHA1 base64 | `bbYJzOV56EVrmKlAc0RdFPN70jU=` |
| HMAC-SHA256 hex | `e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab` |
| HMAC-SHA256 base64 | `5NJir3ghJ16Ox/UfeZmkojn6PuFV9BP9mAw5xO1YZKs=` |
| HMAC-SHA512 hex | `d7aaa909aea25c91725cf9a97133a35f5e3269896a93b70ca45c3889ec658e134cb17ae2575ef400f554296830edae207ba91cce331f6e3997465b84d6a20a09` |
| HMAC-SHA512 base64 | `16qpCa6iXJFyXPmpcTOjX14yaYlqk7cMpFw4iexljhNMsXriV170APVUKWgw7a4ge6kczjMfbjmXRluE1qIKCQ==` |
| HMAC-SHA256 hex, empty body | `0651527d1590913395d9980a7ddfb12498b7a03d7641908edc2bf93fb11e600a` |
| HMAC-SHA256 hex, second secret | `b9a3458ac91ac944b2487de4a6f083af032cf56a6b14eb00152d98fc2fbf931b` |
| timestamped `v1` (`1790000000.` + body) | `7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1` |
| timestamped `v1`, second secret | `10e27b534521eed0781c9a1d09553b287288df64359022fee53eb2bc5a17e997` |
| Standard `v1` (`msg_abc123.1790000000.` + body), key `whsec_YWJjMTIzZGVmNDU2Z2hpNzg5` or raw `abc123def456ghi789` (same key bytes) | `0X/18qlmjeuc20Np0qosSxkxGvEGn7q/oRzVkwtcFqc=` |
| secret-box: key 32×`0x07`, IV 12×`0x01`, plaintext `abc123def456ghi789` | `01010101010101010101010101fb452e3409398ea867df0aba4cd4a4571783ea86a28c886bb7e0e917175f190690c2` |

Server keys used in tests: `BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=` (32×`0x07`), `CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=` (32×`0x09`), `BwcHBwcHBwcHBwcHBwcHBw==` (16 bytes, invalid).

---

## File Structure

Engine (`packages/engine/src/`):
- `webhooks/signature.ts` — **new**: `SignatureScheme`, `SignatureFailure`, `SignatureVerdict`, `signatureSchemeSchema`, `toSignatureScheme`, `signWebhook`, `verifyWebhook`, `DEFAULT_SIGNATURE_TOLERANCE_SEC`.
- `webhooks/model.ts` — `WebhookSigning`, `EffectiveSigning`, `signing` on `WebhookCollection`/`WebhookFolder` and their factories, `effectiveSigning`, `signingSourceLabel`, `signingSecretRef`, `signingSecretMissing`.
- `rest/model.ts` — `RestRequestDef.signing?`, `CreateRestRequestInput.signing?`.
- `rest/send.ts` — `RestSendInput.sign?`, applied last.
- `project/schema.ts`, `project/load.ts`, `project/serialize.ts`, `project/model.ts` (comment only).
- `run/select.ts`, `run/secret-needs.ts`, `run/prepare.ts`.
- `server-api/hooks.ts` — signature fields on catch URLs, captures and the update request.
- `index.ts` — exports.

Server (`packages/server/`):
- `src/config.ts` — `WIREBENCH_SERVER_HOOKS_SECRET_KEY`; `README.md` table regenerated.
- `src/hooks/secret-box.ts` — **new**: `seal`, `open`, `hintOf`.
- `src/hooks/settings.ts` — `secretKey`.
- `migrations/webhook-signatures/0005_webhook-signatures.sql` — **new**.
- `src/context.ts`, `src/serve.ts` — `migrationsDir` may be a list.
- `src/hooks/module.ts` — both migration folders; start-up warning.
- `src/hooks/repo.ts` — columns, patches, verdicts.
- `src/hooks/errors.ts` — three problems.
- `src/hooks/routes/manage.ts` — `signaturePatchOf`, reads, `PATCH`.
- `src/hooks/verify.ts` — **new**: `verifyCapture`.
- `src/hooks/routes/public.ts` — verdict, `401`.
- `test/helpers/identity.ts`, `test/helpers/hooks.ts` — `logStream`, `seedSignature`.

Desktop main (`apps/desktop/src/`):
- `shared/wire-types.ts` — signing and signature shapes, patch fields, change kinds.
- `main/project-wire.ts`, `main/project-rest-mutations.ts`, `main/project-webhook-mutations.ts`, `main/project-mutations.ts`, `main/rest-send.ts`.
- `main/webhook-send.ts` — `webhookSigning` on the resolution, `webhookSignFor`.
- `main/ipc/request.ts` — `sendRestRequest` applies it.
- `main/hooks/hooks-service.ts` — `toCaptureView` keeps the verdict.

Renderer (`apps/desktop/src/renderer/`):
- `features/webhooks/signature-text.ts` — **new**: labels, defaults, reasons, header pattern.
- `features/webhooks/scheme-fields.tsx` — **new**: the per-scheme fields.
- `features/webhooks/catch-url-signature.tsx` — **new**: the settings section, its form and request.
- `features/webhooks/signature-badge.tsx` — **new**: the row badge and *401* marker.
- `features/webhooks/catch-url-settings-dialog.tsx`, `catch-url-tab.tsx`, `capture-viewer.tsx`.
- `features/webhook-items/signing.ts` — **new**: `effectiveSigningOf`, `ciNameOf`.
- `features/webhook-items/signing-fields.tsx` — **new**.
- `features/webhook-items/webhook-settings-dialog.tsx`, `save-as-webhook.ts`.
- `features/rest-editor/signing-tab.tsx` — **new**; `rest-editor.tsx`.
- `state/project.ts` — `setWebhookFolderSigning`, `layerRestEdits`.

e2e: `e2e/helpers/fake-server.ts`, `e2e/specs/webhook-signatures.spec.ts` (**new**).

Docs: `docs-site/src/content/docs/guides/webhook-signatures.mdx` (**new**), `docs-site/astro.config.mjs`, `guides/sending-webhooks.mdx`, `guides/webhooks.mdx`, `CHANGELOG.md`, `docs/specs/2026-09-24-wirebench-server-capability-map.md`.

---

### Task 1: Engine — the three schemes

**Files:**
- Create: `packages/engine/src/webhooks/signature.ts`
- Modify: `packages/engine/src/index.ts` (after the `./webhooks/model.js` exports)
- Test: `packages/engine/test/unit/webhooks/signature.test.ts`

**Interfaces:**
- Consumes: `WirebenchError` (`packages/engine/src/errors.ts`).
- Produces:
  - `type SignatureScheme` (spec §2), `type SignatureFailure`, `type SignatureVerdict`
  - `const signatureSchemeSchema` (zod discriminated union on `kind`), `toSignatureScheme(parsed: z.output<typeof signatureSchemeSchema>): SignatureScheme`
  - `signWebhook(scheme, secret, body, options?: { now?: Date; id?: string }): readonly (readonly [string, string])[]`
  - `verifyWebhook(scheme, secret, headers, body, options?: { now?: Date }): SignatureVerdict` — never throws
  - `DEFAULT_SIGNATURE_TOLERANCE_SEC = 300`, `SIGNATURE_FAILURES` (the five reasons, in spec order)

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/webhooks/signature.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  signWebhook,
  signatureSchemeSchema,
  toSignatureScheme,
  verifyWebhook,
} from '../../../src/index.js';
import type { SignatureScheme } from '../../../src/index.js';

const SECRET = 'abc123def456ghi789';
const OTHER = 'zzz999yyy888xxx777';
const BODY = new TextEncoder().encode('{"event":"order.created"}');
const T = 1_790_000_000;
const AT = new Date(T * 1000);
const STANDARD_SECRET = 'whsec_YWJjMTIzZGVmNDU2Z2hpNzg5';

const hmac = (patch: Partial<Extract<SignatureScheme, { kind: 'hmac' }>> = {}): SignatureScheme => ({
  kind: 'hmac',
  algorithm: 'sha256',
  encoding: 'hex',
  header: 'X-Signature',
  ...patch,
});
const timestamped: SignatureScheme = { kind: 'timestamped', header: 'X-Signature', toleranceSec: 300 };
const standard: SignatureScheme = { kind: 'standard', toleranceSec: 300 };
const at = (seconds: number): Date => new Date(seconds * 1000);
const tampered = new TextEncoder().encode('{"event":"order.created!"}');

describe('signWebhook — known answers', () => {
  it.each([
    ['sha1', 'hex', '6db609cce579e8456b98a94073445d14f37bd235'],
    ['sha1', 'base64', 'bbYJzOV56EVrmKlAc0RdFPN70jU='],
    ['sha256', 'hex', 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab'],
    ['sha256', 'base64', '5NJir3ghJ16Ox/UfeZmkojn6PuFV9BP9mAw5xO1YZKs='],
    [
      'sha512',
      'hex',
      'd7aaa909aea25c91725cf9a97133a35f5e3269896a93b70ca45c3889ec658e134cb17ae2575ef400f554296830edae207ba91cce331f6e3997465b84d6a20a09',
    ],
    [
      'sha512',
      'base64',
      '16qpCa6iXJFyXPmpcTOjX14yaYlqk7cMpFw4iexljhNMsXriV170APVUKWgw7a4ge6kczjMfbjmXRluE1qIKCQ==',
    ],
  ] as const)('hmac %s %s', (algorithm, encoding, digest) => {
    expect(signWebhook(hmac({ algorithm, encoding }), SECRET, BODY)).toEqual([['X-Signature', digest]]);
    expect(signWebhook(hmac({ algorithm, encoding, prefix: `${algorithm}=` }), SECRET, BODY)).toEqual([
      ['X-Signature', `${algorithm}=${digest}`],
    ]);
  });

  it('hmac over an empty body', () => {
    expect(signWebhook(hmac(), SECRET, new Uint8Array())).toEqual([
      ['X-Signature', '0651527d1590913395d9980a7ddfb12498b7a03d7641908edc2bf93fb11e600a'],
    ]);
  });

  it('timestamped', () => {
    expect(signWebhook(timestamped, SECRET, BODY, { now: AT })).toEqual([
      ['X-Signature', 't=1790000000,v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1'],
    ]);
  });

  it('standard, with a whsec_ secret and with a raw one of the same bytes', () => {
    const expected = [
      ['webhook-id', 'msg_abc123'],
      ['webhook-timestamp', '1790000000'],
      ['webhook-signature', 'v1,0X/18qlmjeuc20Np0qosSxkxGvEGn7q/oRzVkwtcFqc='],
    ];
    expect(signWebhook(standard, STANDARD_SECRET, BODY, { now: AT, id: 'msg_abc123' })).toEqual(expected);
    expect(signWebhook(standard, SECRET, BODY, { now: AT, id: 'msg_abc123' })).toEqual(expected);
  });

  it('standard makes a fresh msg_ id when none is given', () => {
    const first = signWebhook(standard, SECRET, BODY, { now: AT })[0]?.[1];
    const second = signWebhook(standard, SECRET, BODY, { now: AT })[0]?.[1];
    expect(first).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it('refuses a whsec_ secret that is not base64', () => {
    expect(() => signWebhook(standard, 'whsec_not*base64', BODY, { now: AT })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-secret' }),
    );
  });
});

describe('verifyWebhook', () => {
  it('round-trips every algorithm and encoding, with and without a prefix', () => {
    for (const algorithm of ['sha1', 'sha256', 'sha512'] as const) {
      for (const encoding of ['hex', 'base64'] as const) {
        for (const prefix of [undefined, `${algorithm}=`]) {
          const scheme = hmac({ algorithm, encoding, ...(prefix !== undefined ? { prefix } : {}) });
          const headers = signWebhook(scheme, SECRET, BODY);
          expect(verifyWebhook(scheme, SECRET, headers, BODY)).toEqual({ verdict: 'verified' });
          expect(verifyWebhook(scheme, SECRET, headers, tampered)).toEqual({ verdict: 'failed', reason: 'mismatch' });
        }
      }
    }
  });

  it('matches the header name and a hex digest without regard to case', () => {
    const upper = 'E4D262AF7821275E8EC7F51F7999A4A239FA3EE155F413FD980C39C4ED5864AB';
    expect(verifyWebhook(hmac(), SECRET, [['x-signature', upper]], BODY)).toEqual({ verdict: 'verified' });
  });

  it('fails an hmac header that is missing, unprefixed, undecodable or the wrong length', () => {
    const prefixed = hmac({ prefix: 'sha256=' });
    const digest = 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab';
    expect(verifyWebhook(hmac(), SECRET, [], BODY)).toEqual({ verdict: 'failed', reason: 'missing-header' });
    expect(verifyWebhook(prefixed, SECRET, [['X-Signature', digest]], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac(), SECRET, [['X-Signature', 'zz']], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac(), SECRET, [['X-Signature', digest.slice(2)]], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(hmac({ encoding: 'base64' }), SECRET, [['X-Signature', 'not base64!']], BODY)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
  });

  it('checks a timestamped header: tolerance edge, garbling, rotation, unknown keys', () => {
    const good = 't=1790000000,v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1';
    const verify = (value: string, now = AT) => verifyWebhook(timestamped, SECRET, [['X-Signature', value]], BODY, { now });
    expect(verify(good, at(T + 300))).toEqual({ verdict: 'verified' });
    expect(verify(good, at(T - 300))).toEqual({ verdict: 'verified' });
    expect(verify(good, at(T + 301))).toEqual({ verdict: 'failed', reason: 'stale-timestamp' });
    expect(verify('t=soon,v1=7f95')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    expect(verify('t=1790000000')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    expect(verify('garbage')).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    const rotated =
      't=1790000000,v1=10e27b534521eed0781c9a1d09553b287288df64359022fee53eb2bc5a17e997,' +
      'v1=7f95bd46a401bdcea761242f8434ccf8badf5a73346dffaa3186cc52873465e1,v0=ignored';
    expect(verify(rotated)).toEqual({ verdict: 'verified' });
    expect(verifyWebhook(timestamped, OTHER, [['X-Signature', good]], BODY, { now: AT })).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
    expect(verifyWebhook(timestamped, SECRET, [], BODY, { now: AT })).toEqual({
      verdict: 'failed',
      reason: 'missing-header',
    });
  });

  it('checks standard headers: any v1 in the list, tolerance, a bad whsec_ key', () => {
    const headers = (signature: string, timestamp = '1790000000'): [string, string][] => [
      ['Webhook-Id', 'msg_abc123'],
      ['Webhook-Timestamp', timestamp],
      ['Webhook-Signature', signature],
    ];
    const good = 'v1,0X/18qlmjeuc20Np0qosSxkxGvEGn7q/oRzVkwtcFqc=';
    const opts = { now: AT };
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), BODY, opts)).toEqual({ verdict: 'verified' });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(`v1,AAAA ${good}`), BODY, opts)).toEqual({
      verdict: 'verified',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), tampered, opts)).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good), BODY, { now: at(T + 301) })).toEqual({
      verdict: 'failed',
      reason: 'stale-timestamp',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good, 'later'), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers('v2,abc'), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'malformed-header',
    });
    expect(verifyWebhook(standard, STANDARD_SECRET, headers(good).slice(1), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'missing-header',
    });
    expect(verifyWebhook(standard, 'whsec_not*base64', headers(good), BODY, opts)).toEqual({
      verdict: 'failed',
      reason: 'key-error',
    });
  });

  it('checks in order: header → parse → timestamp → digest', () => {
    // A stale timestamp with a garbled digest reports the parse, not the age.
    expect(
      verifyWebhook(timestamped, SECRET, [['X-Signature', 't=1,v1=zz']], BODY, { now: AT }),
    ).toEqual({ verdict: 'failed', reason: 'malformed-header' });
    // A stale timestamp with a wrong digest reports the age.
    expect(
      verifyWebhook(timestamped, OTHER, [['X-Signature', `t=1,v1=${'0'.repeat(64)}`]], BODY, { now: AT }),
    ).toEqual({ verdict: 'failed', reason: 'stale-timestamp' });
  });
});

describe('signatureSchemeSchema', () => {
  it('fills the tolerance, drops an empty prefix, and refuses bad names', () => {
    expect(toSignatureScheme(signatureSchemeSchema.parse({ kind: 'standard' }))).toEqual({
      kind: 'standard',
      toleranceSec: DEFAULT_SIGNATURE_TOLERANCE_SEC,
    });
    expect(
      toSignatureScheme(
        signatureSchemeSchema.parse({ kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Sig', prefix: '' }),
      ),
    ).toEqual({ kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Sig' });
    expect(signatureSchemeSchema.safeParse({ kind: 'timestamped', header: 'X Sig' }).success).toBe(false);
    expect(signatureSchemeSchema.safeParse({ kind: 'standard', toleranceSec: 0 }).success).toBe(false);
    expect(signatureSchemeSchema.safeParse({ kind: 'jwt' }).success).toBe(false);
    expect(SIGNATURE_FAILURES).toEqual(['missing-header', 'malformed-header', 'mismatch', 'stale-timestamp', 'key-error']);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/signature.test.ts`
Expected: FAIL — `signWebhook` and the other exports do not exist.

- [ ] **Step 3: Implement**

Create `packages/engine/src/webhooks/signature.ts`:

```ts
/**
 * Signing and verifying webhooks (spec `2026-09-29-wirebench-webhook-signatures-design.md` §2): three
 * generic schemes over the exact body bytes. One implementation serves the sender (`sendRest`'s
 * `sign`) and the receiver (the server's verification on receipt), so each side proves the other.
 *
 * Pure over bytes: `node:crypto` supplies the HMAC, the constant-time compare and the random id.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WirebenchError } from '../errors.js';

export type SignatureAlgorithm = 'sha1' | 'sha256' | 'sha512';

export type SignatureScheme =
  | {
      readonly kind: 'hmac';
      readonly algorithm: SignatureAlgorithm;
      readonly encoding: 'hex' | 'base64';
      /** e.g. `X-Signature`. */
      readonly header: string;
      /** e.g. `sha256=`; required on verify when set, and stripped before comparing. */
      readonly prefix?: string;
    }
  | { readonly kind: 'timestamped'; readonly header: string; readonly toleranceSec: number }
  | { readonly kind: 'standard'; readonly toleranceSec: number };

/** Why a verification failed, in the order the checks run. */
export const SIGNATURE_FAILURES = [
  'missing-header',
  'malformed-header',
  'mismatch',
  'stale-timestamp',
  'key-error',
] as const;
export type SignatureFailure = (typeof SIGNATURE_FAILURES)[number];

export type SignatureVerdict =
  | { readonly verdict: 'verified' }
  | { readonly verdict: 'failed'; readonly reason: SignatureFailure };

/** Five minutes either way, as the Standard Webhooks specification suggests. */
export const DEFAULT_SIGNATURE_TOLERANCE_SEC = 300;

/** An HTTP field name: RFC 9110 §5.1's `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEX = /^[0-9a-fA-F]+$/;
/** Canonical, padded base64 only: `Buffer.from(…, 'base64')` would silently skip anything else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UNIX_SECONDS = /^\d{1,15}$/;
const STANDARD_SECRET_PREFIX = 'whsec_';
const DIGEST_BYTES: Readonly<Record<SignatureAlgorithm, number>> = { sha1: 20, sha256: 32, sha512: 64 };

const headerName = z.string().min(1).max(100).regex(HEADER_NAME);
const tolerance = z.number().int().min(1).max(86_400).default(DEFAULT_SIGNATURE_TOLERANCE_SEC);

/**
 * A scheme as the server's API and the project files accept it. Not annotated as
 * `z.ZodType<SignatureScheme>`: its output has `prefix?: string | undefined`, which
 * `exactOptionalPropertyTypes` will not assign; {@link toSignatureScheme} closes that gap.
 */
export const signatureSchemeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hmac'),
    algorithm: z.enum(['sha1', 'sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
    header: headerName,
    prefix: z
      .string()
      .max(32)
      .regex(/^[\x21-\x7e]*$/)
      .optional(),
  }),
  z.object({ kind: z.literal('timestamped'), header: headerName, toleranceSec: tolerance }),
  z.object({ kind: z.literal('standard'), toleranceSec: tolerance }),
]);

/** A parsed scheme with an absent (or empty) prefix truly absent. */
export function toSignatureScheme(parsed: z.output<typeof signatureSchemeSchema>): SignatureScheme {
  if (parsed.kind !== 'hmac') return parsed;
  const { prefix, ...rest } = parsed;
  return prefix === undefined || prefix === '' ? rest : { ...rest, prefix };
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

function mac(algorithm: SignatureAlgorithm, key: string | Uint8Array, ...parts: Uint8Array[]): Buffer {
  const hmac = createHmac(algorithm, key);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

/** The key bytes: base64 after `whsec_`, else the secret's own UTF-8. `undefined` for a bad base64. */
function standardKey(secret: string): Buffer | undefined {
  if (!secret.startsWith(STANDARD_SECRET_PREFIX)) return utf8(secret);
  const encoded = secret.slice(STANDARD_SECRET_PREFIX.length);
  return encoded.length > 0 && BASE64.test(encoded) ? Buffer.from(encoded, 'base64') : undefined;
}

const unixSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);

/**
 * The headers that sign `body`. Every value is computed over the exact bytes given, so the caller
 * signs what goes on the wire, after every expansion and encoding.
 *
 * @throws WirebenchError `webhook-signing-secret` for a `standard` secret whose `whsec_` tail is not base64
 */
export function signWebhook(
  scheme: SignatureScheme,
  secret: string,
  body: Uint8Array,
  options: { readonly now?: Date; readonly id?: string } = {},
): readonly (readonly [name: string, value: string])[] {
  const now = options.now ?? new Date();
  switch (scheme.kind) {
    case 'hmac':
      return [[scheme.header, `${scheme.prefix ?? ''}${mac(scheme.algorithm, secret, body).toString(scheme.encoding)}`]];
    case 'timestamped': {
      const t = String(unixSeconds(now));
      return [[scheme.header, `t=${t},v1=${mac('sha256', secret, utf8(`${t}.`), body).toString('hex')}`]];
    }
    case 'standard': {
      const key = standardKey(secret);
      if (key === undefined) {
        throw new WirebenchError(
          'webhook-signing-secret',
          'The signing secret starts with whsec_ but the rest is not base64',
        );
      }
      const id = options.id ?? `msg_${randomBytes(16).toString('hex')}`;
      const t = String(unixSeconds(now));
      return [
        ['webhook-id', id],
        ['webhook-timestamp', t],
        ['webhook-signature', `v1,${mac('sha256', key, utf8(`${id}.${t}.`), body).toString('base64')}`],
      ];
    }
  }
}

const VERIFIED: SignatureVerdict = { verdict: 'verified' };
const failed = (reason: SignatureFailure): SignatureVerdict => ({ verdict: 'failed', reason });

/** The first header named `name`, any case, trimmed. */
function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1].trim();
}

/** A received digest as bytes, or `undefined` unless it is `encoding` of exactly `bytes` bytes. */
function decodeDigest(text: string, encoding: 'hex' | 'base64', bytes: number): Buffer | undefined {
  const valid = encoding === 'hex' ? HEX.test(text) && text.length === bytes * 2 : text.length > 0 && BASE64.test(text);
  if (!valid) return undefined;
  const decoded = Buffer.from(text, encoding);
  return decoded.length === bytes ? decoded : undefined;
}

const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const within = (t: number, now: Date, toleranceSec: number): boolean =>
  Math.abs(unixSeconds(now) - t) <= toleranceSec;
const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

function verifyHmac(
  scheme: Extract<SignatureScheme, { kind: 'hmac' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
): SignatureVerdict {
  let value = headerValue(headers, scheme.header);
  if (value === undefined) return failed('missing-header');
  const prefix = scheme.prefix ?? '';
  if (prefix !== '') {
    if (!value.startsWith(prefix)) return failed('malformed-header');
    value = value.slice(prefix.length);
  }
  const received = decodeDigest(value, scheme.encoding, DIGEST_BYTES[scheme.algorithm]);
  if (received === undefined) return failed('malformed-header');
  return same(received, mac(scheme.algorithm, secret, body)) ? VERIFIED : failed('mismatch');
}

/** `t=<seconds>,v1=<hex>[,v1=…]`; unknown keys and parts without `=` are ignored. */
function parseTimestamped(value: string): { readonly t: string; readonly v1: readonly Buffer[] } | undefined {
  let t: string | undefined;
  const v1: Buffer[] = [];
  for (const part of value.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const key = part.slice(0, at).trim();
    const text = part.slice(at + 1).trim();
    if (key === 't') {
      if (t !== undefined || !UNIX_SECONDS.test(text)) return undefined;
      t = text;
    } else if (key === 'v1') {
      const digest = decodeDigest(text, 'hex', 32);
      if (digest !== undefined) v1.push(digest);
    }
  }
  return t === undefined || v1.length === 0 ? undefined : { t, v1 };
}

function verifyTimestamped(
  scheme: Extract<SignatureScheme, { kind: 'timestamped' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  now: Date,
): SignatureVerdict {
  const value = headerValue(headers, scheme.header);
  if (value === undefined) return failed('missing-header');
  const parsed = parseTimestamped(value);
  if (parsed === undefined) return failed('malformed-header');
  if (!within(Number(parsed.t), now, scheme.toleranceSec)) return failed('stale-timestamp');
  // Signed over the timestamp exactly as sent, not re-formatted.
  const expected = mac('sha256', secret, utf8(`${parsed.t}.`), body);
  return parsed.v1.some((candidate) => same(candidate, expected)) ? VERIFIED : failed('mismatch');
}

function verifyStandard(
  scheme: Extract<SignatureScheme, { kind: 'standard' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  now: Date,
): SignatureVerdict {
  const id = headerValue(headers, 'webhook-id');
  const t = headerValue(headers, 'webhook-timestamp');
  const signature = headerValue(headers, 'webhook-signature');
  if (id === undefined || t === undefined || signature === undefined) return failed('missing-header');
  if (!UNIX_SECONDS.test(t)) return failed('malformed-header');
  const candidates = signature
    .split(/\s+/)
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => decodeDigest(entry.slice(3), 'base64', 32))
    .filter(isDefined);
  if (candidates.length === 0) return failed('malformed-header');
  if (!within(Number(t), now, scheme.toleranceSec)) return failed('stale-timestamp');
  const key = standardKey(secret);
  if (key === undefined) return failed('key-error');
  const expected = mac('sha256', key, utf8(`${id}.${t}.`), body);
  return candidates.some((candidate) => same(candidate, expected)) ? VERIFIED : failed('mismatch');
}

/**
 * Whether `body` arrived correctly signed under `scheme` and `secret`. Checks run header present →
 * header parses → timestamp → digest. Never throws: anything unexpected is `failed: key-error`.
 */
export function verifyWebhook(
  scheme: SignatureScheme,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  options: { readonly now?: Date } = {},
): SignatureVerdict {
  const now = options.now ?? new Date();
  try {
    switch (scheme.kind) {
      case 'hmac':
        return verifyHmac(scheme, secret, headers, body);
      case 'timestamped':
        return verifyTimestamped(scheme, secret, headers, body, now);
      case 'standard':
        return verifyStandard(scheme, secret, headers, body, now);
    }
  } catch {
    return failed('key-error');
  }
}
```

In `packages/engine/src/index.ts`, after the `./webhooks/model.js` type exports:

```ts
export {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  signWebhook,
  signatureSchemeSchema,
  toSignatureScheme,
  verifyWebhook,
} from './webhooks/signature.js';
export type {
  SignatureAlgorithm,
  SignatureFailure,
  SignatureScheme,
  SignatureVerdict,
} from './webhooks/signature.js';
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/signature.test.ts`
Expected: PASS (all vectors match the table above).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): sign and verify webhooks with three generic schemes"
```

---

### Task 2: Engine — signing on the webhook collection, folders and items

**Files:**
- Modify: `packages/engine/src/webhooks/model.ts`
- Modify: `packages/engine/src/rest/model.ts` (`RestRequestDef`, `CreateRestRequestInput`, `createRestRequest`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/webhooks/signing.test.ts`

**Interfaces:**
- Consumes: `SignatureScheme` (Task 1), `webhookPath` (existing, `webhooks/model.ts`).
- Produces:
  - `type WebhookSigning = { mode: 'none' } | { mode: 'sign'; scheme: SignatureScheme; secretRef?: string; secretEnv?: string }` (spec §5.1)
  - `WebhookCollection.signing?`, `WebhookFolder.signing?`, `RestRequestDef.signing?`; `signing?` on `CreateWebhookCollectionInput`, `CreateWebhookFolderInput`, `CreateRestRequestInput`
  - `interface EffectiveSigning { signing: WebhookSigning; from: 'item' | 'folder' | 'collection' | 'default'; fromName?: string }`
  - `effectiveSigning(collection: WebhookCollection, requestId: string): EffectiveSigning`
  - `signingAlong(collection: Pick<WebhookCollection, 'signing'>, chain: readonly WebhookFolder[], request: RestRequestDef): EffectiveSigning` — the same rule for a request already in hand (desktop: the saved item with its draft applied)
  - `signingSourceLabel(effective: EffectiveSigning): string`
  - `signingSecretRef(signing: Extract<WebhookSigning, { mode: 'sign' }>): string | undefined`
  - `signingSecretMissing(effective: EffectiveSigning): WirebenchError` (`webhook-signing-secret`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/webhooks/signing.test.ts
import { describe, expect, it } from 'vitest';
import {
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  effectiveSigning,
  signingAlong,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
} from '../../../src/index.js';
import type { WebhookSigning } from '../../../src/index.js';

const hmac = (secretRef: string): WebhookSigning => ({
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef,
  secretEnv: 'ORDERS_SIGNING',
});

function collection(signing?: WebhookSigning) {
  return createWebhookCollection({
    ...(signing !== undefined ? { signing } : {}),
    requests: [
      createRestRequest('Ping', { id: 'r1' }),
      createRestRequest('Own', { id: 'r2', signing: { mode: 'none' } }),
    ],
    folders: [
      createWebhookFolder('Orders', {
        id: 'f1',
        signing: hmac('ref-orders'),
        folders: [createWebhookFolder('Inner', { id: 'f2', requests: [createRestRequest('Deep', { id: 'r3' })] })],
        requests: [createRestRequest('Paid', { id: 'r4', signing: hmac('ref-paid') })],
      }),
    ],
  });
}

describe('effectiveSigning (§5.1)', () => {
  it('is none by default when nothing is set anywhere', () => {
    expect(effectiveSigning(collection(), 'r1')).toEqual({ signing: { mode: 'none' }, from: 'default' });
    expect(effectiveSigning(collection(), 'missing')).toEqual({ signing: { mode: 'none' }, from: 'default' });
  });

  it('takes the item, then the nearest folder, then the collection', () => {
    const c = collection(hmac('ref-root'));
    expect(effectiveSigning(c, 'r1')).toEqual({ signing: hmac('ref-root'), from: 'collection' });
    expect(effectiveSigning(c, 'r2')).toEqual({ signing: { mode: 'none' }, from: 'item', fromName: 'Own' });
    expect(effectiveSigning(c, 'r3')).toEqual({ signing: hmac('ref-orders'), from: 'folder', fromName: 'Orders' });
    expect(effectiveSigning(c, 'r4')).toEqual({ signing: hmac('ref-paid'), from: 'item', fromName: 'Paid' });
  });

  it('resolves an edited copy of an item the same way', () => {
    const c = collection(hmac('ref-root'));
    const [orders] = c.folders;
    // `Paid` signs itself when saved; an unsigned copy of it under the same folder inherits the folder's.
    expect(signingAlong(c, [orders!], createRestRequest('Paid', { id: 'r4' }))).toEqual({
      signing: hmac('ref-orders'),
      from: 'folder',
      fromName: 'Orders',
    });
  });

  it('names where signing is set, and the secret a run reads', () => {
    const c = collection(hmac('ref-root'));
    expect(signingSourceLabel(effectiveSigning(c, 'r1'))).toBe('the Webhooks collection');
    expect(signingSourceLabel(effectiveSigning(c, 'r3'))).toBe('the folder “Orders”');
    expect(signingSourceLabel(effectiveSigning(c, 'r4'))).toBe('the item “Paid”');
    expect(signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretRef: 'r' })).toBe('r');
    expect(signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'CI_KEY' })).toBe(
      'webhook-signing:CI_KEY',
    );
    expect(signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 } })).toBeUndefined();
    const error = signingSecretMissing(effectiveSigning(c, 'r3'));
    expect(error.code).toBe('webhook-signing-secret');
    expect(error.message).toBe('Signing is set on the folder “Orders” but its secret is not set');
  });

  it('keeps signing on a created request, folder and collection', () => {
    expect(createRestRequest('x', { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(createRestRequest('y').signing).toBeUndefined();
    expect(createWebhookFolder('F').signing).toBeUndefined();
    expect(createWebhookCollection().signing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/signing.test.ts`
Expected: FAIL — `effectiveSigning` does not exist.

- [ ] **Step 3: Implement**

In `packages/engine/src/webhooks/model.ts`, add imports:

```ts
import { WirebenchError } from '../errors.js';
import type { SignatureScheme } from './signature.js';
```

After `HookLink`:

```ts
/**
 * How the webhook collection, a folder or an item signs what it sends (spec §5.1). Absent means
 * inherit: the item, then the nearest folder, then the collection; nothing set anywhere is `none`.
 */
export type WebhookSigning =
  | { readonly mode: 'none' }
  | {
      readonly mode: 'sign';
      readonly scheme: SignatureScheme;
      /** Opaque reference into the OS-keychain-backed secret store. Never a secret value. */
      readonly secretRef?: string;
      /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
      readonly secretEnv?: string;
    };

/** The signing an item sends with, and where it was set. */
export interface EffectiveSigning {
  readonly signing: WebhookSigning;
  readonly from: 'item' | 'folder' | 'collection' | 'default';
  /** The item's or the folder's name; absent for the collection and the default. */
  readonly fromName?: string;
}
```

Add `readonly signing?: WebhookSigning;` (with the doc line `/** Overrides the inherited signing for everything inside. */`) to `WebhookFolder` and `WebhookCollection`; add `readonly signing?: WebhookSigning;` to `CreateWebhookCollectionInput` and `CreateWebhookFolderInput`. In `createWebhookCollection`, after the `auth` spread: `...(input.signing !== undefined ? { signing: input.signing } : {}),`. In `createWebhookFolder`, after the `target` spread: `...(input.signing !== undefined ? { signing: input.signing } : {}),`.

After `effectiveTarget`:

```ts
const NO_SIGNING: EffectiveSigning = { signing: { mode: 'none' }, from: 'default' };

/**
 * The signing `request`, under `chain` (root → leaf folders), is sent with: its own, else the
 * nearest folder's, else the collection's, else none. Takes the request itself so a caller holding
 * an edited copy (the desktop's draft) resolves what will actually be sent.
 */
export function signingAlong(
  collection: Pick<WebhookCollection, 'signing'>,
  chain: readonly WebhookFolder[],
  request: RestRequestDef,
): EffectiveSigning {
  if (request.signing !== undefined) return { signing: request.signing, from: 'item', fromName: request.name };
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const folder = chain[index]!;
    if (folder.signing !== undefined) return { signing: folder.signing, from: 'folder', fromName: folder.name };
  }
  return collection.signing !== undefined ? { signing: collection.signing, from: 'collection' } : NO_SIGNING;
}

/** The signing request `requestId` is sent with (spec §5.1); none for an id the collection lacks. */
export function effectiveSigning(collection: WebhookCollection, requestId: string): EffectiveSigning {
  const path = webhookPath(collection, requestId);
  return path === undefined ? NO_SIGNING : signingAlong(collection, path.chain, path.request);
}

/** `the item “Paid”`, `the folder “Orders”`, `the Webhooks collection`. */
export function signingSourceLabel(effective: EffectiveSigning): string {
  switch (effective.from) {
    case 'item':
      return `the item “${effective.fromName ?? ''}”`;
    case 'folder':
      return `the folder “${effective.fromName ?? ''}”`;
    default:
      return 'the Webhooks collection';
  }
}

/**
 * The ref a run's `GetSecret` is asked for. With only a CI name, a pseudo-ref whose declared name
 * is that CI name, so `WIREBENCH_SECRET_<secretEnv>` is read first (`envVariablesFor`).
 */
export function signingSecretRef(signing: Extract<WebhookSigning, { mode: 'sign' }>): string | undefined {
  if (signing.secretRef !== undefined && signing.secretRef !== '') return signing.secretRef;
  return signing.secretEnv !== undefined ? `webhook-signing:${signing.secretEnv}` : undefined;
}

/** The refusal when signing is set but its secret is not: a send never goes out unsigned (§5.2). */
export function signingSecretMissing(effective: EffectiveSigning): WirebenchError {
  return new WirebenchError(
    'webhook-signing-secret',
    `Signing is set on ${signingSourceLabel(effective)} but its secret is not set`,
    { details: { from: effective.from, ...(effective.fromName !== undefined ? { fromName: effective.fromName } : {}) } },
  );
}
```

In `packages/engine/src/rest/model.ts`: change the type import to `import type { HookLink, WebhookSigning } from '../webhooks/model.js';`; inside `RestRequestDef`, after `hook?`:

```ts
  /**
   * Only on an item of a project's webhook collection: how it signs what it sends, overriding its
   * folders and the collection (spec `2026-09-29-…-webhook-signatures-design.md` §5.1).
   */
  readonly signing?: WebhookSigning;
```

Inside `CreateRestRequestInput`: `readonly signing?: WebhookSigning;`; in `createRestRequest`, after the `hook` spread: `...(input.signing !== undefined ? { signing: input.signing } : {}),`.

In `packages/engine/src/index.ts`, add `effectiveSigning`, `signingAlong`, `signingSecretMissing`, `signingSecretRef`, `signingSourceLabel` to the `./webhooks/model.js` value export and `EffectiveSigning`, `WebhookSigning` to its type export.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/webhooks/signing.test.ts packages/engine/test/unit/webhooks/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): inherited webhook signing on the collection, folders and items"
```

---

### Task 3: Engine — `signing` in the project files (format stays 6)

**Files:**
- Modify: `packages/engine/src/project/schema.ts` (`webhookSigningSchema`; `signing` on `webhooksFileSchema`, `restRequestFileSchema`, `webhookFolderFileSchema`)
- Modify: `packages/engine/src/project/load.ts` (`signingOf`; `restRequestReader`, `apiRequestReader`, `loadWebhooks`)
- Modify: `packages/engine/src/project/serialize.ts` (`signingDocument`; `restRequestDocument`, `addWebhookFiles`)
- Modify: `packages/engine/src/project/model.ts` (the `FORMAT_VERSION` comment only)
- Test: `packages/engine/test/unit/project/webhook-signing-format.test.ts`

**Interfaces:**
- Consumes: `signatureSchemeSchema`, `toSignatureScheme` (Task 1); `WebhookSigning` (Task 2).
- Produces: `webhookSigningSchema`, `type WebhookSigningFile = z.output<typeof webhookSigningSchema>` (schema.ts). Files `webhooks/webhooks.yaml`, `webhooks/requests/**/folder.yaml` and webhook `*.request.yaml` carry a `signing` key; an `apis/` request with `signing` is refused (`project-file-invalid`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/project/webhook-signing-format.test.ts
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORMAT_VERSION,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  loadProject,
  projectFiles,
  saveProject,
} from '../../../src/index.js';
import type { Project, WebhookSigning } from '../../../src/index.js';
import { tempProjectDir } from './fixture.js';

const HMAC: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', prefix: 'sha256=' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};
const STANDARD: WebhookSigning = { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'HOOKS' };
const TIMESTAMPED: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'timestamped', header: 'X-Signature', toleranceSec: 120 },
  secretRef: 'ref-paid',
};

function signedProject(): Project {
  return {
    ...createProject('Hooks', { id: 'p1' }),
    properties: { webhookTarget: '' },
    webhooks: createWebhookCollection({
      signing: STANDARD,
      requests: [createRestRequest('Ping', { id: 'r1', slug: 'ping', method: 'POST', url: '/ping', signing: { mode: 'none' } })],
      folders: [
        createWebhookFolder('Orders', {
          id: 'f1',
          slug: 'orders',
          signing: HMAC,
          requests: [createRestRequest('Paid', { id: 'r2', slug: 'paid', method: 'POST', url: '/paid', signing: TIMESTAMPED })],
        }),
      ],
    }),
  };
}

describe('signing in the webhooks/ tree (§5.1)', () => {
  it('stays format 6', () => {
    expect(FORMAT_VERSION).toBe(6);
  });

  it('writes signing at every level, references only', () => {
    const files = projectFiles(signedProject());
    expect(files.get('webhooks/webhooks.yaml')).toContain('kind: standard');
    expect(files.get('webhooks/requests/orders/folder.yaml')).toContain('secretEnv: ORDERS_SIGNING');
    expect(files.get('webhooks/requests/orders/folder.yaml')).toContain('prefix: sha256=');
    expect(files.get('webhooks/requests/ping.request.yaml')).toContain('mode: none');
    expect(files.get('webhooks/requests/orders/paid.request.yaml')).toContain('toleranceSec: 120');
  });

  it('round-trips, byte-stable', async () => {
    const dir = await tempProjectDir();
    await saveProject(signedProject(), dir);
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.webhooks).toEqual(signedProject().webhooks);
    const again = await saveProject(project, dir);
    expect(again.written).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses signing on a request under apis/', async () => {
    const dir = await tempProjectDir();
    await saveProject(createProject('Plain', { id: 'p3' }), dir);
    await mkdir(join(dir, 'apis/a/requests'), { recursive: true });
    await writeFile(join(dir, 'apis/a/api.yaml'), 'kind: rest\nid: a1\nname: A\norder: 0\nbaseUrl: ""\n');
    await writeFile(
      join(dir, 'apis/a/requests/x.request.yaml'),
      'kind: rest\nid: x1\nname: X\norder: 0\nmethod: GET\nurl: /\nsigning: { mode: none }\n',
    );
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a plaintext secret in a signing block', async () => {
    const dir = await tempProjectDir();
    await saveProject(signedProject(), dir);
    const file = join(dir, 'webhooks/webhooks.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('mode: sign', 'mode: sign\n  secret: abc123def456ghi789'));
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-file-invalid' });
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/project/webhook-signing-format.test.ts`
Expected: FAIL — `signing` is not written (`toContain('kind: standard')` fails).

- [ ] **Step 3: Implement**

`packages/engine/src/project/schema.ts` — import `import { signatureSchemeSchema } from '../webhooks/signature.js';`, and before `webhooksFileSchema`:

```ts
/**
 * A webhook collection's, folder's or item's `signing` key (webhook-signatures §5.1). References
 * only: a plaintext `secret` is refused outright, as auth refuses its value keys.
 */
export const webhookSigningSchema = z.union([
  z.looseObject({ mode: z.literal('none') }),
  z
    .looseObject({
      mode: z.literal('sign'),
      scheme: signatureSchemeSchema,
      secretRef: z.string().optional(),
      secretEnv: envName,
    })
    .refine((value) => !('secret' in value), {
      message: 'signing must not contain a plaintext "secret" field; use secretRef',
      path: ['secret'],
    }),
]);
export type WebhookSigningFile = z.output<typeof webhookSigningSchema>;
```

Add `signing: webhookSigningSchema.optional(),` to `webhooksFileSchema` (after `auth`), to `restRequestFileSchema` (after `hook`, with the comment `/** Only under \`webhooks/\`; refused elsewhere by the loader. */`) and to `webhookFolderFileSchema`'s `extend` (after `source`).

`packages/engine/src/project/load.ts` — import `toSignatureScheme` from `'../webhooks/signature.js'`, `WebhookSigning` into the `../webhooks/model.js` type import and `WebhookSigningFile` from `./schema.js`; add after `exact`:

```ts
/** A parsed `signing` key as the model holds it. */
function signingOf(parsed: WebhookSigningFile): WebhookSigning {
  if (parsed.mode === 'none') return { mode: 'none' };
  return {
    mode: 'sign',
    scheme: toSignatureScheme(parsed.scheme),
    ...optional('secretRef', parsed.secretRef),
    ...optional('secretEnv', parsed.secretEnv),
  };
}
```

In `restRequestReader`'s returned object, after the `hook` spread: `...(parsed.signing !== undefined ? { signing: signingOf(parsed.signing) } : {}),`.

In `apiRequestReader`, replace the `if (request.hook !== undefined)` block's condition and messages so both keys are refused:

```ts
    const misplaced = request.hook !== undefined ? 'hook' : request.signing !== undefined ? 'signing' : undefined;
    if (misplaced !== undefined) {
      const file = `${dir}/${fileName}`;
      throw new ProjectError(
        'project-file-invalid',
        `Invalid project file ${file}: ${misplaced} is only allowed under ${WEBHOOKS_DIR}/`,
        {
          details: { file, issues: [{ path: misplaced, message: `only allowed under ${WEBHOOKS_DIR}/` }] },
        },
      );
    }
```

In `loadWebhooks`, the folder callback returns additionally `...(folder.signing !== undefined ? { signing: signingOf(folder.signing) } : {}),`; the returned collection adds `...(parsed.signing !== undefined ? { signing: signingOf(parsed.signing) } : {}),` after `auth`.

`packages/engine/src/project/serialize.ts` — import type `WebhookSigning` from `../webhooks/model.js`; add after `authDocument`:

```ts
/** A `signing` key as written: the scheme's own fields, and references only. */
function signingDocument(signing: WebhookSigning | undefined): Record<string, unknown> | undefined {
  if (signing === undefined) return undefined;
  if (signing.mode === 'none') return { mode: 'none' };
  return compact({
    mode: 'sign',
    scheme: compact({ ...signing.scheme }),
    secretRef: signing.secretRef,
    secretEnv: signing.secretEnv,
  });
}
```

In `restRequestDocument`, after `hook:`: `signing: signingDocument(request.signing),` (API requests never carry it: the loader refuses it there and main refuses the patch, Task 10). In `addWebhookFiles`: the `webhooks.yaml` object gains `signing: signingDocument(webhooks.signing),` after `auth`; the folder callback returns additionally `signing: signingDocument(hook.signing),`.

`packages/engine/src/project/model.ts` — the `FORMAT_VERSION` comment's sentence becomes: `6 added \`scripts\` on a SOAP, REST or gRPC request (#63), the project's webhook collection under \`webhooks/\`, \`hook\` on a request, and \`signing\` on the collection, its folders and its items.`

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/project/webhook-signing-format.test.ts packages/engine/test/unit/project/webhooks-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): signing round-trips in the webhooks/ files, format 6"
```

---

### Task 4: Engine — `sendRest` signs the bytes on the wire

**Files:**
- Modify: `packages/engine/src/rest/send.ts` (`RestSendInput`, `sendRest`)
- Test: `packages/engine/test/integration/rest/send-signing.test.ts`

**Interfaces:**
- Consumes: `signWebhook`, `SignatureScheme` (Task 1); `startTestRestServer` (`packages/engine/test/helpers/test-rest-server.ts`, `/echo` returns method, headers (lower-case) and body text).
- Produces: `RestSendInput.sign?: { readonly scheme: SignatureScheme; readonly secret: string }`. Applied after auth, body encoding and header merging; a signing header replaces a merged header of the same name (any case). Stream bodies: none exist in `RestBody` (see Rulings), so `webhook-signing-body` has no reachable case and is not added.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/integration/rest/send-signing.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entry } from '../../../src/rest/model.js';
import { sendRest } from '../../../src/rest/send.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import { verifyWebhook } from '../../../src/webhooks/signature.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;
beforeAll(async () => {
  server = await startTestRestServer();
});
afterAll(async () => {
  await server.close();
});

const SECRET = 'abc123def456ghi789';
const BODY = '{"event":"order.created"}';

function input(extra: Partial<RestSendInput> & { readonly body?: string; readonly headers?: RestSendInput['request']['headers'] }): RestSendInput {
  const { body, headers, ...rest } = extra;
  return {
    baseUrl: server.url,
    request: {
      method: body === undefined ? 'GET' : 'POST',
      url: '/echo',
      pathParams: [],
      query: [],
      headers: headers ?? [],
      body: body === undefined ? { kind: 'none' } : { kind: 'raw', language: 'json', text: body },
    },
    settings: { timeoutMs: 5_000, followRedirects: true },
    ...rest,
  };
}

interface Echo {
  readonly headers: Record<string, string>;
  readonly body: string;
}
const echo = (text: string): Echo => JSON.parse(text) as Echo;

describe('sendRest with sign (§5.2)', () => {
  it('signs the encoded body last, replacing a typed header of the same name', async () => {
    const exchange = await sendRest(
      input({
        body: BODY,
        headers: [entry('x-signature', 'stale')],
        sign: {
          scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', prefix: 'sha256=' },
          secret: SECRET,
        },
      }),
    );
    const seen = echo(exchange.text);
    expect(seen.body).toBe(BODY);
    expect(seen.headers['x-signature']).toBe(
      'sha256=e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab',
    );
  });

  it('signs an absent body as zero bytes', async () => {
    const exchange = await sendRest(
      input({ sign: { scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' }, secret: SECRET } }),
    );
    expect(echo(exchange.text).headers['x-signature']).toBe(
      '0651527d1590913395d9980a7ddfb12498b7a03d7641908edc2bf93fb11e600a',
    );
  });

  it('adds the three Standard Webhooks headers, which the receiver verifies', async () => {
    const exchange = await sendRest(
      input({ body: BODY, sign: { scheme: { kind: 'standard', toleranceSec: 300 }, secret: 'whsec_YWJjMTIzZGVmNDU2Z2hpNzg5' } }),
    );
    const seen = echo(exchange.text);
    expect(seen.headers['webhook-id']).toMatch(/^msg_[0-9a-f]{32}$/);
    const pairs = Object.entries(seen.headers);
    expect(
      verifyWebhook({ kind: 'standard', toleranceSec: 300 }, SECRET, pairs, new TextEncoder().encode(seen.body)),
    ).toEqual({ verdict: 'verified' });
  });

  it('refuses to send with a bad whsec_ secret', async () => {
    await expect(
      sendRest(input({ body: BODY, sign: { scheme: { kind: 'standard', toleranceSec: 300 }, secret: 'whsec_not*base64' } })),
    ).rejects.toMatchObject({ code: 'webhook-signing-secret' });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/integration/rest/send-signing.test.ts`
Expected: FAIL — typecheck of `sign` (vitest reports `x-signature` is `stale`).

- [ ] **Step 3: Implement**

In `packages/engine/src/rest/send.ts`, add imports:

```ts
import type { SignatureScheme } from '../webhooks/signature.js';
import { signWebhook } from '../webhooks/signature.js';
```

In `RestSendInput`, after `boundary?`:

```ts
  /**
   * A webhook item's signing (webhook-signatures §5.2), its secret already resolved. Applied last,
   * over the encoded body bytes and the merged headers, so the signature covers exactly what goes
   * on the wire. A signing header replaces a merged header of the same name.
   */
  readonly sign?: { readonly scheme: SignatureScheme; readonly secret: string };
```

After `mergeRequestHeaders`:

```ts
/** `headers` with the signing headers set over `body`, replacing any header of the same name. */
function withSignature(
  headers: Record<string, string>,
  sign: NonNullable<RestSendInput['sign']>,
  body: Uint8Array,
): Record<string, string> {
  const out = { ...headers };
  for (const [name, value] of signWebhook(sign.scheme, sign.secret, body)) {
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === name.toLowerCase()) delete out[key];
    }
    out[name] = value;
  }
  return out;
}
```

In `sendRest`, rename the merged `const headers = mergeRequestHeaders(…)` to `const merged = mergeRequestHeaders(…)` and add right after it:

```ts
  // Signing runs last (§5.2): after auth, encoding and merging, so it signs the bytes that go out.
  const headers =
    input.sign === undefined ? merged : withSignature(merged, input.sign, encoded.bytes ?? new Uint8Array());
```

Update `sendRest`'s JSDoc `@throws` with `WirebenchError \`webhook-signing-secret\` when a \`standard\` signing secret cannot be decoded`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/integration/rest/send-signing.test.ts packages/engine/test/integration/rest/send.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): sendRest signs the encoded body when asked"
```

---

### Task 5: Engine — the runner signs webhook items from `WIREBENCH_SECRET_<secretEnv>`

**Files:**
- Modify: `packages/engine/src/run/select.ts` (rest arm of `SelectedRequest`, `walkWebhooks`)
- Modify: `packages/engine/src/run/secret-needs.ts` (`needsOf`)
- Modify: `packages/engine/src/run/prepare.ts` (`prepareRest`)
- Test: `packages/engine/test/unit/run/webhook-signing.test.ts`

**Interfaces:**
- Consumes: `effectiveSigning`, `signingSecretRef`, `signingSecretMissing`, `signingSourceLabel` (Task 2); `RestSendInput.sign` (Task 4); `hooksProject()` (`packages/engine/test/unit/webhooks/fixture.ts`).
- Produces: `SelectedRequest` rest arm `signing?: EffectiveSigning` (webhook items only); a `SecretNeed` `{ ref, envName: secretEnv, purpose: 'webhook signing secret (<source>)' }`; `PreparedSend.input.sign`; a missing secret throws `webhook-signing-secret` before anything is sent.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/run/webhook-signing.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareSend } from '../../../src/run/prepare.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { selectRequests } from '../../../src/run/select.js';
import type { Project, WebhookSigning } from '../../../src/index.js';
import { hooksProject } from '../webhooks/fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'wb-signing-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIGNING: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-hooks',
  secretEnv: 'HOOKS_SIGNING',
};

function signed(): Project {
  const project = hooksProject();
  return { ...project, webhooks: { ...project.webhooks!, signing: SIGNING } };
}

const context = (project: Project, secrets: Record<string, string>): RunContext => ({
  project,
  projectDir: dir,
  overrides: {},
  getSecret: (ref) => Promise.resolve(secrets[ref]),
});

describe('runner signing (§5.2)', () => {
  it('selects webhook items with their effective signing', () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    expect(ping?.kind === 'rest' ? ping.signing : undefined).toEqual({ signing: SIGNING, from: 'collection' });
  });

  it('asks for the secret under its CI name', () => {
    const selected = selectRequests(signed(), ['Webhooks']).selected;
    expect(secretNeedsOf(selected, signed()).find((need) => need.ref === 'ref-hooks')).toEqual({
      ref: 'ref-hooks',
      envName: 'HOOKS_SIGNING',
      purpose: 'webhook signing secret (the Webhooks collection)',
      usedBy: ['Webhooks/Ping', 'Webhooks/Group/Inner'],
    });
  });

  it('puts the resolved secret on the send input', async () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    const prepared = await prepareSend(ping!, context(signed(), { 'ref-hooks': 'abc123def456ghi789' }));
    expect(prepared.kind === 'rest' ? prepared.input.sign : undefined).toEqual({
      scheme: SIGNING.scheme,
      secret: 'abc123def456ghi789',
    });
  });

  it('refuses an item whose secret the run was not given', async () => {
    const [ping] = selectRequests(signed(), ['Webhooks/Ping']).selected;
    await expect(prepareSend(ping!, context(signed(), {}))).rejects.toMatchObject({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the Webhooks collection but its secret is not set',
    });
  });

  it('adds nothing for an unsigned item', async () => {
    const [ping] = selectRequests(hooksProject(), ['Webhooks/Ping']).selected;
    const prepared = await prepareSend(ping!, context(hooksProject(), {}));
    expect(prepared.kind === 'rest' ? prepared.input.sign : 'x').toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/engine/test/unit/run/webhook-signing.test.ts`
Expected: FAIL — `signing` is undefined on the selection.

- [ ] **Step 3: Implement**

`packages/engine/src/run/select.ts` — import `effectiveSigning` beside `effectiveTarget`, and `EffectiveSigning` into the type import. In the rest arm of `SelectedRequest` add:

```ts
      /** A webhook item's effective signing (webhook-signatures §5.2); absent for an API request. */
      readonly signing?: EffectiveSigning;
```

In `walkWebhooks`, the pushed item gains `signing: effectiveSigning(collection, request.id),` after `request,`.

`packages/engine/src/run/secret-needs.ts` — import `signingSecretRef`, `signingSourceLabel` from `'../webhooks/model.js'`; add before `needsOf`:

```ts
/** A webhook item's signing secret, read from `WIREBENCH_SECRET_<secretEnv>` (§5.2). */
function signingNeeds(selected: Extract<SelectedRequest, { kind: 'rest' }>): SecretNeed[] {
  const effective = selected.signing;
  if (effective === undefined || effective.signing.mode !== 'sign') return [];
  const ref = signingSecretRef(effective.signing);
  if (ref === undefined) return [];
  return [
    {
      ref,
      ...(effective.signing.secretEnv !== undefined ? { envName: effective.signing.secretEnv } : {}),
      purpose: `webhook signing secret (${signingSourceLabel(effective)})`,
    },
  ];
}
```

and in `needsOf`'s rest branch append `...signingNeeds(selected),`.

`packages/engine/src/run/prepare.ts` — import `signingSecretMissing`, `signingSecretRef` from `'../webhooks/model.js'`; add before `prepareRest`:

```ts
/**
 * A webhook item's signing with its secret, or `undefined` when it signs nothing. The secret is
 * read through the run's `GetSecret` (the CLI: `WIREBENCH_SECRET_<secretEnv>`), so it is masked
 * like every other secret the run hands out.
 *
 * @throws WirebenchError `webhook-signing-secret` when signing is set and the secret is not given
 */
async function signFor(selected: RestSelected, context: RunContext): Promise<RestSendInput['sign']> {
  const effective = selected.signing;
  if (effective === undefined || effective.signing.mode !== 'sign') return undefined;
  const ref = signingSecretRef(effective.signing);
  const secret = ref === undefined ? undefined : await context.getSecret(ref);
  if (secret === undefined || secret === '') throw signingSecretMissing(effective);
  return { scheme: effective.signing.scheme, secret };
}
```

In `prepareRest`, before `const proxy = …`: `const sign = await signFor(selected, context);` and in the returned `input` add `...(sign !== undefined ? { sign } : {}),` after the proxy spread. Add `webhook-signing-secret` to `prepareSend`'s `@throws` list.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/engine/test/unit/run`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): wirebench run signs webhook items with their CI secret"
```

---

### Task 6: Server — the key, the secret box and the settings

**Files:**
- Modify: `packages/server/src/config.ts` (`inputSchema`, `CONFIG_VARIABLES`)
- Create: `packages/server/src/hooks/secret-box.ts`
- Modify: `packages/server/src/hooks/settings.ts` (`HooksSettings.secretKey`, `hooksSettings`)
- Modify: `packages/server/README.md` (regenerated by `pnpm docs:server-config`, which `pnpm check` verifies)
- Test: `packages/server/test/unit/hooks/secret-box.test.ts`

**Interfaces:**
- Produces:
  - Config key `hooksSecretKey?: string` from `WIREBENCH_SERVER_HOOKS_SECRET_KEY` (`secret: true`); any value that is not canonical base64 of exactly 32 bytes stops start-up with `ConfigError` `must be 32 bytes, base64-encoded`.
  - `HooksSettings.secretKey?: Buffer`
  - `seal(key: Buffer, plaintext: string, iv?: Buffer): Buffer` — `version(1)=0x01 ‖ iv(12) ‖ tag(16) ‖ ciphertext`, AES-256-GCM, random IV (`iv` is for the known-answer test only)
  - `open(key: Buffer, sealed: Buffer): string` — throws on a wrong key, a changed byte, or an unknown/short box
  - `hintOf(secret: string): string | null` — the last four characters, only for a secret of 8 or more

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/unit/hooks/secret-box.test.ts
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, describeConfig, loadConfig } from '../../../src/config.js';
import { hintOf, open, seal } from '../../../src/hooks/secret-box.js';
import { hooksSettings } from '../../../src/hooks/settings.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};
const VARIABLE = 'WIREBENCH_SERVER_HOOKS_SECRET_KEY';
const KEY_TEXT = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';

describe('WIREBENCH_SERVER_HOOKS_SECRET_KEY (§3.1)', () => {
  it('is optional, secret and documented', () => {
    expect(CONFIG_VARIABLES.find((variable) => variable.env === VARIABLE)).toMatchObject({
      key: 'hooksSecretKey',
      required: false,
      secret: true,
    });
    expect(hooksSettings(loadConfig(required, 't')).secretKey).toBeUndefined();
  });

  it('decodes 32 bytes into the hooks settings', () => {
    expect(hooksSettings(loadConfig({ ...required, [VARIABLE]: KEY_TEXT }, 't')).secretKey).toEqual(KEY);
  });

  it.each(['BwcHBwcHBwcHBwcHBwcHBw==', 'not base64 at all', `${KEY_TEXT.slice(0, -1)}AAAA=`])(
    'stops start-up for a key that is not 32 bytes of base64, never echoing it (%#)',
    (value) => {
      let caught: unknown;
      try {
        loadConfig({ ...required, [VARIABLE]: value }, 't');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).problems).toEqual([{ variable: VARIABLE, message: 'must be 32 bytes, base64-encoded' }]);
      expect((caught as ConfigError).message).not.toContain(value);
      expect(describeConfig({ ...required, [VARIABLE]: value }).find((row) => row.variable === VARIABLE)?.status).toBe(
        'invalid',
      );
    },
  );
});

describe('secret-box (§3.1)', () => {
  it('seals as version ‖ iv ‖ tag ‖ ciphertext (known answer)', () => {
    expect(seal(KEY, SECRET, Buffer.alloc(12, 1)).toString('hex')).toBe(
      '01010101010101010101010101fb452e3409398ea867df0aba4cd4a4571783ea86a28c886bb7e0e917175f190690c2',
    );
  });

  it('round-trips under a fresh IV each time', () => {
    const first = seal(KEY, SECRET);
    const second = seal(KEY, SECRET);
    expect(first.equals(second)).toBe(false);
    expect(first.length).toBe(1 + 12 + 16 + SECRET.length);
    expect(first.includes(Buffer.from(SECRET))).toBe(false);
    expect(open(KEY, first)).toBe(SECRET);
    expect(open(KEY, second)).toBe(SECRET);
  });

  it('throws on a wrong key, a changed byte, and a short or unknown box', () => {
    const sealed = seal(KEY, SECRET);
    expect(() => open(Buffer.alloc(32, 9), sealed)).toThrow();
    const changed = Buffer.from(sealed);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
    expect(() => open(KEY, changed)).toThrow();
    expect(() => open(KEY, sealed.subarray(0, 20))).toThrow('sealed secret');
    const other = Buffer.from(sealed);
    other.writeUInt8(2, 0);
    expect(() => open(KEY, other)).toThrow('sealed secret');
  });

  it('hints the last four characters of a secret of eight or more', () => {
    expect(hintOf(SECRET)).toBe('i789');
    expect(hintOf('abcdefgh')).toBe('efgh');
    expect(hintOf('short12')).toBeNull();
  });
});
```

(`${KEY_TEXT.slice(0, -1)}AAAA=` is valid base64 of 35 bytes.)

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/server/test/unit/hooks/secret-box.test.ts`
Expected: FAIL — `secret-box.js` does not exist.

- [ ] **Step 3: Implement**

`packages/server/src/config.ts` — after `originText`:

```ts
/** Canonical, padded base64: `Buffer.from(…, 'base64')` would silently skip anything else. */
const BASE64_TEXT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** An AES-256 key: 32 bytes, base64-encoded (webhook-signatures §3.1). */
const keyText = z
  .string()
  .refine(
    (value) => BASE64_TEXT.test(value) && Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes, base64-encoded',
  );
```

In `inputSchema`, after `hooksPerWorkspace`: `hooksSecretKey: keyText.optional(),`. In `CONFIG_VARIABLES`, after `WIREBENCH_SERVER_HOOKS_PER_WORKSPACE`:

```ts
  {
    env: 'WIREBENCH_SERVER_HOOKS_SECRET_KEY',
    key: 'hooksSecretKey',
    required: false,
    secret: true,
    description:
      'Encrypts catch URL signature secrets at rest: 32 random bytes, base64-encoded (`openssl rand -base64 32`). Unset, signature settings are refused.',
  },
```

Create `packages/server/src/hooks/secret-box.ts`:

```ts
/**
 * Catch URL signature secrets at rest (webhook-signatures §3.1): AES-256-GCM under the key from
 * `WIREBENCH_SERVER_HOOKS_SECRET_KEY`, laid out `version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext`. The
 * version byte leaves room for another layout; rotating the key is out of scope (§1.2).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** A fresh IV per seal; `iv` exists for the known-answer test only. */
export function seal(key: Buffer, plaintext: string, iv: Buffer = randomBytes(IV_BYTES)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** @throws Error when the box is not one this build wrote, or does not authenticate under `key`. */
export function open(key: Buffer, sealed: Buffer): string {
  if (sealed.length < HEADER_BYTES || sealed[0] !== VERSION) throw new Error('sealed secret: unknown format');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + IV_BYTES));
  decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
}

/**
 * The last four characters (§3.2), shown to editors as *● set …f789*. A secret shorter than eight
 * gets none: four of seven characters would give most of it away.
 */
export function hintOf(secret: string): string | null {
  return secret.length >= 8 ? secret.slice(-4) : null;
}
```

`packages/server/src/hooks/settings.ts` — in `HooksSettings`, after `perWorkspace`:

```ts
  /** The signature-secret key (§3.1); absent, signature settings are refused and nothing can be opened. */
  readonly secretKey?: Buffer;
```

and in `hooksSettings`'s returned object, after `perWorkspace`:

```ts
    ...(config.hooksSecretKey !== undefined ? { secretKey: Buffer.from(config.hooksSecretKey, 'base64') } : {}),
```

Regenerate the README table: `pnpm docs:server-config`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/server/test/unit/hooks/secret-box.test.ts packages/server/test/unit/config.test.ts packages/server/test/unit/hooks/module.test.ts && pnpm docs:server-config --check`
Expected: PASS; `packages/server/README.md config table is up to date`.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): an encryption key and a sealed box for catch URL signature secrets"
```

---

### Task 7: Server — migration 0005 and the repository

**Files:**
- Create: `packages/server/migrations/webhook-signatures/0005_webhook-signatures.sql`
- Modify: `packages/server/src/context.ts` (`ServerModule.migrationsDir`)
- Modify: `packages/server/src/serve.ts` (`allMigrations`)
- Modify: `packages/server/src/hooks/module.ts` (`SIGNATURES_MIGRATIONS_DIR`, `migrationsDir`)
- Modify: `packages/server/src/hooks/repo.ts`
- Modify: `packages/server/test/unit/serve.test.ts`, `packages/server/test/integration/hooks/repo.test.ts` (expectations)
- Test: `packages/server/test/integration/hooks/signatures-repo.test.ts`

**Interfaces:**
- Consumes: `signatureSchemeSchema`, `toSignatureScheme`, `SignatureScheme`, `SignatureVerdict`, `SignatureFailure` (Task 1).
- Produces:
  - `ServerModule.migrationsDir?: string | readonly string[]`
  - `CatchUrlRow` + `signature: SignatureScheme | null`, `secretSet: boolean`, `signatureHint: string | null`, `rejectUnverified: boolean`
  - `PublicCatchUrl` + `signature?: { scheme: SignatureScheme | undefined; sealedSecret: Buffer }`, `rejectUnverified: boolean`
  - `interface SignaturePatch { scheme: SignatureScheme; sealedSecret?: Buffer; hint?: string | null }`; `CatchUrlPatch` + `signature?: SignaturePatch | null`, `rejectUnverified?: boolean`
  - `NewCapture` + optional `signature?: SignatureVerdict | null`, `rejected?: boolean`; `CaptureSummaryRow` + `signature: SignatureVerdict | null`, `rejected: boolean`
  - `countSignedCatchUrls(db: Querier): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/hooks/signatures-repo.test.ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SignatureScheme } from '@wirebench/engine';
import * as repo from '../../../src/hooks/repo.js';
import { seal } from '../../../src/hooks/secret-box.js';
import { describeDb } from '../../helpers/database.js';
import { hooksRepoHarness, newCapture, seedCatchUrl } from '../../helpers/hooks.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const STANDARD: SignatureScheme = { kind: 'standard', toleranceSec: 300 };

describeDb('webhook-signatures storage (§3.2)', () => {
  let h: IdentityHarness;
  let workspaceId: string;
  beforeEach(async () => {
    h = await hooksRepoHarness();
    const team = await seedTeam(h, { name: 'Payments QA' });
    workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  });
  afterEach(() => h.close());

  it('0005 adds the columns', async () => {
    const columns = await h.db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = current_schema()
         and column_name in ('signature', 'signature_secret', 'signature_hint', 'reject_unverified',
                             'signature_verdict', 'signature_reason', 'rejected')
       order by 1, 2`,
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      'captures.rejected',
      'captures.signature_reason',
      'captures.signature_verdict',
      'catch_urls.reject_unverified',
      'catch_urls.signature',
      'catch_urls.signature_hint',
      'catch_urls.signature_secret',
    ]);
  });

  it('stores a scheme with its sealed secret, reads back only that one is set, and clears all four', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    expect(hook).toMatchObject({ signature: null, secretSet: false, signatureHint: null, rejectUnverified: false });
    await repo.updateCatchUrl(h.db, hook.id, {
      signature: { scheme: HMAC, sealedSecret: seal(KEY, SECRET), hint: 'i789' },
      rejectUnverified: true,
    });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: HMAC,
      secretSet: true,
      signatureHint: 'i789',
      rejectUnverified: true,
    });
    const found = await repo.catchUrlBySecret(h.db, hook.secret);
    expect(found?.signature?.scheme).toEqual(HMAC);
    expect(found?.rejectUnverified).toBe(true);
    expect(await repo.countSignedCatchUrls(h.db)).toBe(1);
    expect(JSON.stringify(await repo.catchUrlsOfWorkspace(h.db, workspaceId))).not.toContain(SECRET);

    await repo.updateCatchUrl(h.db, hook.id, { signature: { scheme: STANDARD } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: STANDARD,
      secretSet: true,
      signatureHint: 'i789',
    });

    await repo.updateCatchUrl(h.db, hook.id, { signature: null, rejectUnverified: false });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, hook.id)).toMatchObject({
      signature: null,
      secretSet: false,
      signatureHint: null,
      rejectUnverified: false,
    });
    expect((await repo.catchUrlBySecret(h.db, hook.secret))?.signature).toBeUndefined();
    expect(await repo.countSignedCatchUrls(h.db)).toBe(0);
  });

  it('refuses a scheme without a secret, and reject unverified without a scheme (check constraints)', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    await expect(
      h.db.query(`update catch_urls set signature = '{"kind":"standard","toleranceSec":300}'::jsonb where id = $1`, [
        hook.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(repo.updateCatchUrl(h.db, hook.id, { rejectUnverified: true })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('records a verdict and a rejection on a capture', async () => {
    const hook = await seedCatchUrl(h, workspaceId, 'Payments');
    const verified = newCapture(hook.id, { signature: { verdict: 'verified' } });
    const failed = newCapture(hook.id, { signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    const unchecked = newCapture(hook.id);
    for (const capture of [verified, failed, unchecked]) await repo.insertCapture(h.db, capture);
    const page = await repo.listCaptures(h.db, hook.id, {}, 10);
    expect(page.map((row) => [row.id, row.signature, row.rejected])).toEqual([
      [unchecked.id, null, false],
      [failed.id, { verdict: 'failed', reason: 'mismatch' }, true],
      [verified.id, { verdict: 'verified' }, false],
    ]);
    expect(await repo.captureById(h.db, hook.id, failed.id)).toMatchObject({
      signature: { verdict: 'failed', reason: 'mismatch' },
      rejected: true,
    });
  });
});
```

Add to `packages/server/test/unit/serve.test.ts`, inside `describe('allMigrations', …)`:

```ts
  it('reads every folder of a module that brings more than one', async () => {
    const identity = await folder('0002_identity.sql');
    const capture = await folder('0003_capture.sql');
    const signatures = await folder('0004_signatures.sql');
    const hooks: ServerModule = {
      name: 'webhook-capture',
      migrationsDir: [capture, signatures],
      register: () => Promise.resolve(),
    };
    const combined = await allMigrations([moduleWith(identity), hooks]);
    expect(combined.map((m) => `${m.version}_${m.name}`)).toEqual([
      '1_init',
      '2_identity',
      '3_capture',
      '4_signatures',
    ]);
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run packages/server/test/unit/serve.test.ts && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/signatures-repo.test.ts`
Expected: FAIL — `migrationsDir` is not iterable as a list; the integration file fails on the missing columns.

- [ ] **Step 3: Implement**

Create `packages/server/migrations/webhook-signatures/0005_webhook-signatures.sql`:

```sql
-- Wirebench Server 0005: signature verification on catch URLs (webhook-signatures spec §3.2).
-- A catch URL's scheme and its sealed secret are set and cleared together; the secret is never
-- returned. A capture's verdict is fixed on receipt: null means the catch URL checked nothing.

alter table catch_urls
  -- A SignatureScheme, validated by the app before it is written.
  add column signature jsonb null,
  -- version ‖ iv ‖ tag ‖ ciphertext (hooks/secret-box.ts); never returned or logged.
  add column signature_secret bytea null,
  -- The last four characters of the secret, for editors.
  add column signature_hint text null,
  add column reject_unverified boolean not null default false,
  add constraint catch_urls_signature_pair check ((signature is null) = (signature_secret is null)),
  add constraint catch_urls_reject_needs_signature check (not reject_unverified or signature is not null);

alter table captures
  add column signature_verdict text null check (signature_verdict in ('verified', 'failed')),
  -- A SignatureFailure when the verdict is 'failed'.
  add column signature_reason text null,
  -- Answered 401 because the catch URL rejects unverified requests; stored all the same.
  add column rejected boolean not null default false;
```

`packages/server/src/context.ts` — `ServerModule.migrationsDir` becomes:

```ts
  /**
   * The module's `NNNN_name.sql` files, merged with the host's in version order (`serve.ts`
   * `allMigrations`). By convention `packages/server/migrations/<module>/` (e.g.
   * `migrations/identity/0002_identity.sql`): the package ships `migrations/` beside `dist/`, and
   * `tsc` copies no `.sql` files, so a folder under `src/` would be missing from the image. A module
   * that grew a later capability's tables lists one folder per capability, in order.
   */
  readonly migrationsDir?: string | readonly string[];
```

`packages/server/src/serve.ts` — in `allMigrations`:

```ts
  const moduleDirs = modules.flatMap((m) =>
    m.migrationsDir === undefined ? [] : typeof m.migrationsDir === 'string' ? [m.migrationsDir] : [...m.migrationsDir],
  );
```

`packages/server/src/hooks/module.ts` — after `HOOKS_MIGRATIONS_DIR`:

```ts
/** webhook-signatures' columns (capability map, third slice): the same module owns the tables. */
export const SIGNATURES_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations/webhook-signatures/', import.meta.url),
);
```

and `migrationsDir: [HOOKS_MIGRATIONS_DIR, SIGNATURES_MIGRATIONS_DIR],`.

`packages/server/src/hooks/repo.ts`:

1. Imports:

```ts
import { signatureSchemeSchema, toSignatureScheme } from '@wirebench/engine';
import type { CatchUrlResponse, SignatureFailure, SignatureScheme, SignatureVerdict } from '@wirebench/engine';
```

2. `CatchUrlRow` gains:

```ts
  /** The scheme, or `null` with none. The sealed secret is never selected with a row. */
  readonly signature: SignatureScheme | null;
  readonly secretSet: boolean;
  /** The last four characters of the secret (§3.2), or `null`. */
  readonly signatureHint: string | null;
  readonly rejectUnverified: boolean;
```

3. `PublicCatchUrl` gains:

```ts
  /** Set when the catch URL checks signatures. `scheme` is `undefined` when the stored one no longer parses. */
  readonly signature?: { readonly scheme: SignatureScheme | undefined; readonly sealedSecret: Buffer };
  readonly rejectUnverified: boolean;
```

4. After `ResponsePatch`:

```ts
/** A scheme to store; with a new secret, its sealed bytes and hint. Without one, the stored secret stays. */
export interface SignaturePatch {
  readonly scheme: SignatureScheme;
  readonly sealedSecret?: Buffer;
  readonly hint?: string | null;
}
```

and `CatchUrlPatch` gains:

```ts
  /** `null` clears the scheme, the secret, the hint and *Reject unverified* (§3.4). */
  readonly signature?: SignaturePatch | null;
  readonly rejectUnverified?: boolean;
```

5. `NewCapture` gains `readonly signature?: SignatureVerdict | null;` and `readonly rejected?: boolean;`; `CaptureSummaryRow` gains `readonly signature: SignatureVerdict | null;` and `readonly rejected: boolean;`.

6. Columns:

```ts
const CATCH_URL_COLUMNS = `h.id, h.workspace_id as "workspaceId", h.name, h.secret, h.enabled,
  h.response_status as "status", h.response_content_type as "contentType", h.response_body as "body",
  h.response_delay_ms as "delayMs", h.created_by as "createdBy", h.created_at as "createdAt",
  h.signature, h.signature_secret is not null as "secretSet", h.signature_hint as "signatureHint",
  h.reject_unverified as "rejectUnverified"`;
const SUMMARY_COLUMNS = `id, received_at as "receivedAt", method, subpath, body_size as "bodySize", truncated,
  source_ip as "sourceIp", signature_verdict as "signatureVerdict", signature_reason as "signatureReason", rejected`;
```

7. Helpers after `responseOf`:

```ts
/** A stored scheme, or `undefined` when it no longer parses (written by another build). */
function schemeOf(value: unknown): SignatureScheme | undefined {
  const parsed = signatureSchemeSchema.safeParse(value);
  return parsed.success ? toSignatureScheme(parsed.data) : undefined;
}

function verdictOf(row: Raw): SignatureVerdict | null {
  if (row.signatureVerdict === 'verified') return { verdict: 'verified' };
  if (row.signatureVerdict === 'failed') {
    return { verdict: 'failed', reason: (row.signatureReason ?? 'key-error') as SignatureFailure };
  }
  return null;
}
```

8. `catchUrlOf` adds, after `createdAt`:

```ts
    signature: row.signature === null ? null : (schemeOf(row.signature) ?? null),
    secretSet: row.secretSet as boolean,
    signatureHint: row.signatureHint as string | null,
    rejectUnverified: row.rejectUnverified as boolean,
```

and `summaryOf` adds `signature: verdictOf(row), rejected: row.rejected as boolean,`.

9. `catchUrlBySecret` selects `h.signature, h.signature_secret as "signatureSecret", h.reject_unverified as "rejectUnverified"` in addition, and returns, after `response`:

```ts
    rejectUnverified: row.rejectUnverified as boolean,
    ...(row.signature !== null && row.signatureSecret !== null
      ? { signature: { scheme: schemeOf(row.signature), sealedSecret: row.signatureSecret as Buffer } }
      : {}),
```

10. `updateCatchUrl`, after the response fields and before the `sets.length === 0` check:

```ts
  if (patch.signature === null) {
    set('signature', null);
    set('signature_secret', null);
    set('signature_hint', null);
    set('reject_unverified', false);
  } else if (patch.signature !== undefined) {
    params.push(JSON.stringify(patch.signature.scheme));
    sets.push(`signature = $${params.length}::jsonb`);
    if (patch.signature.sealedSecret !== undefined) {
      set('signature_secret', patch.signature.sealedSecret);
      set('signature_hint', patch.signature.hint ?? null);
    }
  }
  // Clearing the signature has already cleared this; assigning a column twice is an SQL error.
  if (patch.rejectUnverified !== undefined && patch.signature !== null) {
    set('reject_unverified', patch.rejectUnverified);
  }
```

11. `insertCapture`:

```ts
export async function insertCapture(tx: Querier, capture: NewCapture): Promise<void> {
  const signature = capture.signature ?? null;
  await tx.query(
    `insert into captures (id, catch_url_id, received_at, method, subpath, query, headers, body, body_size, truncated,
       source_ip, signature_verdict, signature_reason, rejected)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
    [
      capture.id,
      capture.catchUrlId,
      capture.receivedAt,
      capture.method,
      capture.subpath,
      capture.query,
      JSON.stringify(capture.headers),
      capture.body,
      capture.bodySize,
      capture.truncated,
      capture.sourceIp,
      signature?.verdict ?? null,
      signature?.verdict === 'failed' ? signature.reason : null,
      capture.rejected ?? false,
    ],
  );
}
```

12. After `deleteCatchUrl`:

```ts
/** Catch URLs that check signatures: start-up warns when there are some and no key to open them (§3.1). */
export async function countSignedCatchUrls(db: Querier): Promise<number> {
  const row = (await db.query<{ n: number }>('select count(*)::int as n from catch_urls where signature is not null'))
    .rows[0];
  return row?.n ?? 0;
}
```

Existing expectations in `packages/server/test/integration/hooks/repo.test.ts`:
- the first test: rename it `0004 and 0005 follow teams-access across modules, and production runs them before live-updates` and expect `['1_init', '2_identity', '3_teams', '4_webhook-capture', '5_webhook-signatures']`;
- the `catchUrlBySecret` `toEqual` gains `rejectUnverified: false`;
- the `captureById` `toEqual` gains `signature: null, rejected: false`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run packages/server/test/unit/serve.test.ts && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): store catch URL signature settings and capture verdicts (migration 0005)"
```

---

### Task 8: Engine wire shapes and the manage API

**Files:**
- Modify: `packages/engine/src/server-api/hooks.ts`, `packages/engine/src/index.ts`
- Modify: `packages/server/src/hooks/errors.ts`
- Modify: `packages/server/src/hooks/routes/manage.ts` (`toCatchUrl`, `signaturePatchOf`, the `GET`, `POST`, `PATCH` and `rotate` handlers)
- Modify: `packages/server/src/hooks/module.ts` (`warnUnopenableSignatures`, called from `register`)
- Test: `packages/engine/test/unit/server-api/hooks-signature.test.ts`, `packages/server/test/integration/hooks/signatures-manage.test.ts`

**Interfaces:**
- Consumes: `seal`, `hintOf` (Task 6); repo (Task 7); `requireWorkspaceRole`'s `request.workspaceAccess.role`.
- Produces:
  - Engine: `SIGNATURE_SECRET_MAX_LENGTH = 512`; `catchUrlSignatureSchema` (`{ scheme, secret: { set: true, hint: string | null } }`); `captureSignatureSchema` (`{ verdict: 'verified' | 'failed', reason?: SignatureFailure }`); optional `signature`, `rejectUnverified`, `signatureAvailable` on `catchUrlSchema`; optional `signature`, `rejectUnverified` on `catchUrlUpdateRequestSchema`; optional `signature`, `rejected` on `captureSummarySchema` (and so `captureSchema`). Types `CatchUrlSignature`, `CaptureSignature`.
  - Server: `toCatchUrl(row, publicUrl, view: { showHint: boolean; signatureAvailable: boolean }): CatchUrl`; `signaturePatchOf(body, current, key): repo.SignaturePatch | null | undefined`; `warnUnopenableSignatures(db, settings, log): Promise<void>`; problems `hooks-signature-key-unset` (409), `hooks-signature-secret-required` (400), `invalid-request` (400, *Reject unverified* without a scheme).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/server-api/hooks-signature.test.ts
import { describe, expect, it } from 'vitest';
import {
  CATCH_URL_DEFAULT_RESPONSE,
  captureSummarySchema,
  catchUrlSchema,
  catchUrlUpdateRequestSchema,
  SIGNATURE_SECRET_MAX_LENGTH,
} from '../../../src/index.js';

const OLD_SERVER = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  name: 'Payments',
  url: 'https://wirebench.test/hooks/3ZC5Q0V7R3T9XK2M4N6P8QAB7Y',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
};

describe('server-api hooks: signature fields (§3.4)', () => {
  it('still parses a catch URL from a server without signatures', () => {
    expect(catchUrlSchema.parse(OLD_SERVER)).toEqual(OLD_SERVER);
  });

  it('parses the scheme with a write-only secret, filling the tolerance', () => {
    const parsed = catchUrlSchema.parse({
      ...OLD_SERVER,
      signature: { scheme: { kind: 'standard' }, secret: { set: true, hint: 'i789' } },
      rejectUnverified: true,
      signatureAvailable: true,
    });
    expect(parsed.signature).toEqual({ scheme: { kind: 'standard', toleranceSec: 300 }, secret: { set: true, hint: 'i789' } });
    expect(catchUrlSchema.safeParse({ ...OLD_SERVER, signature: { scheme: { kind: 'standard' }, secret: { set: false, hint: null } } }).success).toBe(false);
  });

  it('bounds the secret in an update, and lets null clear', () => {
    const scheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
    expect(SIGNATURE_SECRET_MAX_LENGTH).toBe(512);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: null }).success).toBe(true);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme } }).success).toBe(true);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: 'x'.repeat(512) } }).success).toBe(true);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: 'x'.repeat(513) } }).success).toBe(false);
    expect(catchUrlUpdateRequestSchema.safeParse({ signature: { scheme, secret: '' } }).success).toBe(false);
    expect(catchUrlUpdateRequestSchema.safeParse({ rejectUnverified: true }).success).toBe(true);
  });

  it('carries a verdict and a rejection on a capture summary', () => {
    const summary = {
      id: '01J8ZC5Q0V7R3T9XK2M4N6P8QC',
      receivedAt: '2026-09-29T10:00:01.000Z',
      method: 'POST',
      subpath: '',
      bodySize: 2,
      truncated: false,
      sourceIp: '203.0.113.9',
    };
    expect(captureSummarySchema.parse(summary)).toEqual(summary);
    expect(
      captureSummarySchema.parse({ ...summary, signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true }),
    ).toMatchObject({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    expect(captureSummarySchema.safeParse({ ...summary, signature: { verdict: 'failed', reason: 'late' } }).success).toBe(
      false,
    );
  });
});
```

```ts
// packages/server/test/integration/hooks/signatures-manage.test.ts
import { afterEach, expect, it, vi } from 'vitest';
import type { CatchUrl } from '@wirebench/engine';
import { warnUnopenableSignatures } from '../../../src/hooks/module.js';
import { open } from '../../../src/hooks/secret-box.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const SECRET = 'abc123def456ghi789';
const HMAC = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };

interface Cast {
  readonly h: HooksHarness;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly workspaceId: string;
  readonly hook: CatchUrl;
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  const hook = (await call<CatchUrl>(h, editor, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'Signed' })).body;
  return { h, editor, viewer, workspaceId, hook };
}

const patch = (c: Cast, as: SignedInUser, body: object) =>
  call<CatchUrl & { code?: string }>(c.h, as, 'PATCH', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`, body);
const list = (c: Cast, as: SignedInUser) => call<CatchUrl[]>(c.h, as, 'GET', `/workspaces/${c.workspaceId}/hooks`);
const sealedOf = async (c: Cast): Promise<Buffer | null> =>
  (await c.h.db.query<{ s: Buffer | null }>('select signature_secret as s from catch_urls where id = $1', [c.hook.id]))
    .rows[0]?.s ?? null;

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the management API: signatures (§3.4, §6)', () => {
  it('answers 409 while the key is unset, says so on reads, and still clears', async () => {
    c = await setUp();
    const refused = await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    expect([refused.status, refused.body.code]).toEqual([409, 'hooks-signature-key-unset']);
    expect((await list(c, c.editor)).body[0]).toMatchObject({
      signature: null,
      rejectUnverified: false,
      signatureAvailable: false,
    });
    expect((await patch(c, c.editor, { signature: null })).status).toBe(200);
  });

  it('sets a scheme and a write-only secret, sealed at rest; viewers see no hint', async () => {
    c = await setUp(KEY_ENV);
    const set = await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET }, rejectUnverified: true });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      signature: { scheme: HMAC, secret: { set: true, hint: 'i789' } },
      rejectUnverified: true,
      signatureAvailable: true,
    });
    expect(JSON.stringify(set.body)).not.toContain(SECRET);
    const sealed = await sealedOf(c);
    expect(sealed?.includes(Buffer.from(SECRET))).toBe(false);
    expect(open(Buffer.alloc(32, 7), sealed!)).toBe(SECRET);
    expect((await list(c, c.viewer)).body[0]?.signature).toEqual({ scheme: HMAC, secret: { set: true, hint: null } });
  });

  it('changes the scheme alone and keeps the stored secret', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    const before = await sealedOf(c);
    const changed = await patch(c, c.editor, { signature: { scheme: { kind: 'standard' } } });
    expect(changed.body.signature).toEqual({
      scheme: { kind: 'standard', toleranceSec: 300 },
      secret: { set: true, hint: 'i789' },
    });
    expect((await sealedOf(c))?.equals(before!)).toBe(true);
  });

  it('answers 400 for a scheme with no stored secret, reject unverified without a scheme, and a bad secret', async () => {
    c = await setUp(KEY_ENV);
    const noSecret = await patch(c, c.editor, { signature: { scheme: HMAC } });
    expect([noSecret.status, noSecret.body.code]).toEqual([400, 'hooks-signature-secret-required']);
    const reject = await patch(c, c.editor, { rejectUnverified: true });
    expect([reject.status, reject.body.code]).toEqual([400, 'invalid-request']);
    const both = await patch(c, c.editor, { signature: null, rejectUnverified: true });
    expect([both.status, both.body.code]).toEqual([400, 'invalid-request']);
    for (const secret of ['', 'x'.repeat(513)]) {
      const bad = await patch(c, c.editor, { signature: { scheme: HMAC, secret } });
      expect([bad.status, bad.body.code]).toEqual([400, 'invalid-request']);
    }
    const header = await patch(c, c.editor, { signature: { scheme: { ...HMAC, header: 'X Sig' }, secret: SECRET } });
    expect(header.status).toBe(400);
  });

  it('clears the scheme, the secret, the hint and reject unverified', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET }, rejectUnverified: true });
    const cleared = await patch(c, c.editor, { signature: null });
    expect(cleared.body).toMatchObject({ signature: null, rejectUnverified: false });
    expect(await sealedOf(c)).toBeNull();
  });

  it('lets only editors change it', async () => {
    c = await setUp(KEY_ENV);
    const refused = await patch(c, c.viewer, { signature: { scheme: HMAC, secret: SECRET } });
    expect([refused.status, refused.body.code]).toEqual([403, 'teams-forbidden']);
  });

  it('warns once at start-up when signed catch URLs exist and the key is unset', async () => {
    c = await setUp(KEY_ENV);
    await patch(c, c.editor, { signature: { scheme: HMAC, secret: SECRET } });
    const warn = vi.fn();
    await warnUnopenableSignatures(c.h.db, { enabled: true }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    warn.mockClear();
    await warnUnopenableSignatures(c.h.db, { enabled: true, secretKey: Buffer.alloc(32, 7) }, { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run packages/engine/test/unit/server-api/hooks-signature.test.ts && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/signatures-manage.test.ts`
Expected: FAIL — `SIGNATURE_SECRET_MAX_LENGTH` is not exported; the `PATCH` ignores `signature`.

- [ ] **Step 3: Implement**

`packages/engine/src/server-api/hooks.ts` — imports `import { SIGNATURE_FAILURES, signatureSchemeSchema } from '../webhooks/signature.js';`; after `CATCH_URL_DEFAULT_RESPONSE`:

```ts
/** A catch URL's signature secret, in characters (webhook-signatures §3.4). */
export const SIGNATURE_SECRET_MAX_LENGTH = 512;

/** What a read shows of a catch URL's signature: the scheme, and only that a secret is set (§3.4). */
export const catchUrlSignatureSchema = z.object({
  scheme: signatureSchemeSchema,
  /** Write-only: never the secret, only that one is set and, to editors, its last four characters. */
  secret: z.object({ set: z.literal(true), hint: z.string().nullable() }),
});
export type CatchUrlSignature = z.infer<typeof catchUrlSignatureSchema>;

/** A capture's verdict, fixed on receipt (§3.3); `null` on the capture means not checked. */
export const captureSignatureSchema = z.object({
  verdict: z.enum(['verified', 'failed']),
  reason: z.enum(SIGNATURE_FAILURES).optional(),
});
export type CaptureSignature = z.infer<typeof captureSignatureSchema>;
```

`catchUrlSchema` gains (optional, so a server from before this module still parses):

```ts
  /** webhook-signatures §3.4; absent from an older server. */
  signature: catchUrlSignatureSchema.nullable().optional(),
  rejectUnverified: z.boolean().optional(),
  /** `false` while `WIREBENCH_SERVER_HOOKS_SECRET_KEY` is unset, so the desktop can explain why. */
  signatureAvailable: z.boolean().optional(),
```

`catchUrlUpdateRequestSchema` gains:

```ts
  /** `null` clears; a scheme without `secret` keeps the stored one (§3.4). */
  signature: z
    .object({ scheme: signatureSchemeSchema, secret: z.string().min(1).max(SIGNATURE_SECRET_MAX_LENGTH).optional() })
    .nullable()
    .optional(),
  rejectUnverified: z.boolean().optional(),
```

`captureSummarySchema` gains `signature: captureSignatureSchema.nullable().optional(), rejected: z.boolean().optional(),`.

`packages/engine/src/index.ts` — add `captureSignatureSchema`, `catchUrlSignatureSchema`, `SIGNATURE_SECRET_MAX_LENGTH` to the `./server-api/hooks.js` value export and `CaptureSignature`, `CatchUrlSignature` to its type export.

`packages/server/src/hooks/errors.ts`:

```ts
export const signatureKeyUnset = (): WirebenchError =>
  problem(
    'hooks-signature-key-unset',
    'Signatures need WIREBENCH_SERVER_HOOKS_SECRET_KEY, which the server administrator has not set.',
    409,
  );
export const signatureSecretRequired = (): WirebenchError =>
  problem('hooks-signature-secret-required', 'Enter the secret the sender signs with.', 400);
/** Spec §6's `400 invalid`: the generic shape code, since the request is well-formed but contradictory. */
export const rejectNeedsSignature = (): WirebenchError =>
  problem('invalid-request', 'Reject unverified needs a signature scheme.', 400);
```

`packages/server/src/hooks/routes/manage.ts`:

1. Imports: add `signatureSchemeSchema`, `toSignatureScheme` to the engine value import; add `rejectNeedsSignature`, `signatureKeyUnset`, `signatureSecretRequired` to the errors import; `import { hintOf, seal } from '../secret-box.js';`.

2. `toCatchUrl`:

```ts
/** Who is reading, for what a row shows (§3.4): the hint only to editors, and whether signatures work. */
export interface CatchUrlView {
  readonly showHint: boolean;
  readonly signatureAvailable: boolean;
}

/** A row as the wire shows it: the secret only inside the full URL (§5); the signature secret never. */
export function toCatchUrl(row: repo.CatchUrlListRow, publicUrl: string, view: CatchUrlView): CatchUrl {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    url: `${publicUrl}${CATCH_URL_PATH_PREFIX}${row.secret}`,
    enabled: row.enabled,
    response: row.response,
    captureCount: row.captureCount,
    newestCaptureId: row.newestCaptureId,
    createdAt: row.createdAt,
    signature:
      row.signature === null
        ? null
        : { scheme: row.signature, secret: { set: true, hint: view.showHint ? row.signatureHint : null } },
    rejectUnverified: row.rejectUnverified,
    signatureAvailable: view.signatureAvailable,
  };
}
```

3. After `checkResponse`:

```ts
/**
 * What a `PATCH`'s `signature` and `rejectUnverified` do to the row (§3.4): `undefined` leaves the
 * signature alone, `null` clears it, a patch sets it. The scheme is re-parsed with zod: Ajv applies
 * no defaults inside a union, and the stored scheme must be exactly what the engine reads back.
 *
 * @throws problems `hooks-signature-key-unset`, `hooks-signature-secret-required`, `invalid-request`
 */
export function signaturePatchOf(
  body: Pick<CatchUrlUpdateRequest, 'signature' | 'rejectUnverified'>,
  current: Pick<repo.CatchUrlRow, 'signature' | 'secretSet'>,
  key: Buffer | undefined,
): repo.SignaturePatch | null | undefined {
  if (body.signature === null) {
    if (body.rejectUnverified === true) throw rejectNeedsSignature();
    return null;
  }
  if (body.signature === undefined) {
    if (body.rejectUnverified === true && current.signature === null) throw rejectNeedsSignature();
    return undefined;
  }
  if (key === undefined) throw signatureKeyUnset();
  const scheme = toSignatureScheme(signatureSchemeSchema.parse(body.signature.scheme));
  const secret = body.signature.secret;
  if (secret === undefined) {
    if (!current.secretSet) throw signatureSecretRequired();
    return { scheme };
  }
  return { scheme, sealedSecret: seal(key, secret), hint: hintOf(secret) };
}
```

4. In `manageRoutes`, after `hookOf`:

```ts
    const viewOf = (request: FastifyRequest): CatchUrlView => ({
      showHint: request.workspaceAccess!.role !== 'viewer',
      signatureAvailable: env.settings.secretKey !== undefined,
    });
```

Every `toCatchUrl(…, config.publicUrl)` call (list, create, patch, rotate) becomes `toCatchUrl(…, config.publicUrl, viewOf(request))`.

5. The `PATCH` handler body:

```ts
        const { workspaceId, hookId } = hookOf(request);
        const body = request.body as CatchUrlUpdateRequest;
        const current = await found(workspaceId, hookId);
        checkResponse(body.response);
        const signature = signaturePatchOf(body, current, env.settings.secretKey);
        let updated: boolean;
        try {
          updated = await repo.updateCatchUrl(db, hookId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.response !== undefined ? { response: body.response } : {}),
            ...(signature !== undefined ? { signature } : {}),
            ...(body.rejectUnverified !== undefined ? { rejectUnverified: body.rejectUnverified } : {}),
          });
        } catch (error) {
          conflictOr(error);
        }
        if (!updated) throw catchUrlNotFound();
        announce(env.ctx.hooks.hooksChanged, { workspaceId }, request.log);
        return toCatchUrl(await found(workspaceId, hookId), config.publicUrl, viewOf(request));
```

`packages/server/src/hooks/module.ts` — imports `import type { FastifyBaseLogger } from 'fastify';`, `import type { Querier } from '../context.js';`, `import * as repo from './repo.js';` and `import type { HooksSettings } from './settings.js';`; add before `hooksModule`:

```ts
/**
 * §3.1: once at start-up, when catch URLs check signatures but no key can open their secrets. The
 * server still starts; their captures are recorded as `failed: key-error` until the key returns.
 */
export async function warnUnopenableSignatures(
  db: Querier,
  settings: Pick<HooksSettings, 'enabled' | 'secretKey'>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  if (!settings.enabled || settings.secretKey !== undefined) return;
  const signed = await repo.countSignedCatchUrls(db);
  if (signed > 0) {
    log.warn(
      { signed },
      'catch URLs check signatures but WIREBENCH_SERVER_HOOKS_SECRET_KEY is unset: their captures are recorded as failed: key-error',
    );
  }
}
```

In `register`, replace the trailing `await Promise.resolve();` with `await warnUnopenableSignatures(ctx.db, env.settings, ctx.log);`.

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run packages/engine/test/unit/server-api && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine packages/server
git commit -m "feat(server): set a catch URL's signature scheme and write-only secret"
```

---

### Task 9: Server — verify on receipt, and *Reject unverified*

**Files:**
- Create: `packages/server/src/hooks/verify.ts`
- Modify: `packages/server/src/hooks/routes/public.ts` (`receive`)
- Modify: `packages/server/test/helpers/identity.ts` (`identityHarness` option `logStream`), `packages/server/test/helpers/hooks.ts` (`hooksHarness` passes `logStream`; `seedSignature`)
- Test: `packages/server/test/unit/hooks/verify.test.ts`, `packages/server/test/integration/hooks/signatures-public.test.ts`

**Interfaces:**
- Consumes: `verifyWebhook` (Task 1), `open` (Task 6), `PublicCatchUrl.signature`, `NewCapture.signature`/`rejected` (Task 7).
- Produces: `verifyCapture(env: Pick<HooksEnv, 'now'> & { settings: Pick<HooksSettings, 'secretKey'> }, hook: repo.PublicCatchUrl, headers, body: Buffer, log: Pick<FastifyBaseLogger, 'error'>): SignatureVerdict | null`. The public route stores the verdict and answers `401` (no body, no delay) when rejected.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/test/unit/hooks/verify.test.ts
import { describe, expect, it, vi } from 'vitest';
import { CATCH_URL_DEFAULT_RESPONSE, signWebhook } from '@wirebench/engine';
import type { SignatureScheme } from '@wirebench/engine';
import type { PublicCatchUrl } from '../../../src/hooks/repo.js';
import { seal } from '../../../src/hooks/secret-box.js';
import { verifyCapture } from '../../../src/hooks/verify.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const BODY = Buffer.from('{"event":"order.created"}');
const NOW = new Date('2026-09-24T12:00:00.000Z');

const hook = (signature?: PublicCatchUrl['signature']): PublicCatchUrl => ({
  id: 'h1',
  workspaceId: 'w1',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  rejectUnverified: false,
  ...(signature !== undefined ? { signature } : {}),
});
const env = (secretKey?: Buffer) => ({ settings: secretKey === undefined ? {} : { secretKey }, now: () => NOW });
const log = () => ({ error: vi.fn() });
const headers = (secret = SECRET): [string, string][] => signWebhook(HMAC, secret, BODY).map(([n, v]) => [n, v]);

describe('verifyCapture (§3.3 step 1)', () => {
  it('is null when the catch URL checks nothing', () => {
    expect(verifyCapture(env(KEY), hook(), headers(), BODY, log())).toBeNull();
  });

  it('verifies with the opened secret, and fails a wrong one', () => {
    const signed = hook({ scheme: HMAC, sealedSecret: seal(KEY, SECRET) });
    expect(verifyCapture(env(KEY), signed, headers(), BODY, log())).toEqual({ verdict: 'verified' });
    expect(verifyCapture(env(KEY), signed, headers('zzz999yyy888xxx777'), BODY, log())).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
  });

  it('is key-error without a key, under the wrong key (logged without the secret), and for an unreadable scheme', () => {
    const signed = hook({ scheme: HMAC, sealedSecret: seal(Buffer.alloc(32, 9), SECRET) });
    expect(verifyCapture(env(), signed, headers(), BODY, log())).toEqual({ verdict: 'failed', reason: 'key-error' });
    const logged = log();
    expect(verifyCapture(env(KEY), signed, headers(), BODY, logged)).toEqual({ verdict: 'failed', reason: 'key-error' });
    expect(logged.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.error.mock.calls)).not.toContain(SECRET);
    const unreadable = hook({ scheme: undefined, sealedSecret: seal(KEY, SECRET) });
    expect(verifyCapture(env(KEY), unreadable, headers(), BODY, log())).toEqual({ verdict: 'failed', reason: 'key-error' });
  });
});
```

```ts
// packages/server/test/integration/hooks/signatures-public.test.ts
import { Writable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { signWebhook } from '@wirebench/engine';
import type { SignatureScheme } from '@wirebench/engine';
import * as repo from '../../../src/hooks/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCatchUrl, seedSignature, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const MIB = 1024 * 1024;
const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const BODY = Buffer.from('{"event":"order.created"}');

interface Cast {
  readonly h: HooksHarness;
  readonly hook: repo.CatchUrlRow;
  readonly lines: string[];
}

async function setUp(
  options: {
    readonly env?: Record<string, string>;
    readonly sealKey?: Buffer;
    readonly rejectUnverified?: boolean;
    readonly delayMs?: number;
    readonly signed?: boolean;
  } = {},
): Promise<Cast> {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf-8'));
      callback();
    },
  });
  const h = await hooksHarness({
    env: { ...KEY_ENV, WIREBENCH_SERVER_LOG_LEVEL: 'info', ...options.env },
    logStream,
  });
  const team = await seedTeam(h, { name: 'Payments QA' });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const hook = await seedCatchUrl(h, workspaceId, 'Signed', {
    response: { status: 202, contentType: null, body: null, delayMs: options.delayMs ?? 0 },
  });
  if (options.signed !== false) {
    await seedSignature(h, hook.id, {
      scheme: HMAC,
      secret: SECRET,
      key: options.sealKey ?? Buffer.alloc(32, 7),
      rejectUnverified: options.rejectUnverified ?? false,
    });
  }
  return { h, hook, lines };
}

const deliver = (c: Cast, body: Buffer, headers: Record<string, string> = {}) =>
  c.h.app.inject({
    method: 'POST',
    url: `/hooks/${c.hook.secret}/orders`,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: body,
  });
const signedHeaders = (body: Buffer, secret = SECRET): Record<string, string> =>
  Object.fromEntries(signWebhook(HMAC, secret, body));
const newest = async (c: Cast): Promise<repo.CaptureRow> => {
  const [summary] = await repo.listCaptures(c.h.db, c.hook.id, {}, 1);
  return (await repo.captureById(c.h.db, c.hook.id, summary!.id))!;
};

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the public route: signatures (§3.3)', () => {
  it('records verified, failed and not-checked captures', async () => {
    c = await setUp();
    expect((await deliver(c, BODY, signedHeaders(BODY))).statusCode).toBe(202);
    expect((await newest(c)).signature).toEqual({ verdict: 'verified' });
    await deliver(c, BODY, signedHeaders(BODY, 'zzz999yyy888xxx777'));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'mismatch' });
    await deliver(c, BODY);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'failed', reason: 'missing-header' }, rejected: false });
    await c.h.close();
    c = await setUp({ signed: false });
    await deliver(c, BODY, signedHeaders(BODY));
    expect(await newest(c)).toMatchObject({ signature: null, rejected: false });
  });

  it('verifies the full body before truncating it', async () => {
    c = await setUp({ env: { WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '1' } });
    const large = Buffer.alloc(1.5 * MIB, 0x61);
    expect((await deliver(c, large, signedHeaders(large))).statusCode).toBe(202);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'verified' }, truncated: true, bodySize: 1.5 * MIB });
  });

  it('answers 401 at once when rejecting, and still stores the capture', async () => {
    c = await setUp({ rejectUnverified: true, delayMs: 30_000 });
    const rejected = await deliver(c, BODY);
    expect([rejected.statusCode, rejected.body]).toEqual([401, '']);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'failed', reason: 'missing-header' }, rejected: true });
    await repo.updateCatchUrl(c.h.db, c.hook.id, { response: { delayMs: 0 } });
    expect((await deliver(c, BODY, signedHeaders(BODY))).statusCode).toBe(202);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'verified' }, rejected: false });
  });

  it('records key-error under a wrong key and with no key, logging without the secret', async () => {
    c = await setUp({ sealKey: Buffer.alloc(32, 9) });
    await deliver(c, BODY, signedHeaders(BODY));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'key-error' });
    expect(c.lines.some((line) => line.includes('could not open a catch URL signature secret'))).toBe(true);
    expect(c.lines.join('')).not.toContain(SECRET);
    await c.h.close();
    c = await setUp({ env: { WIREBENCH_SERVER_HOOKS_SECRET_KEY: '' } });
    await deliver(c, BODY, signedHeaders(BODY));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'key-error' });
  });

  it('never puts the secret in a response or a log line', async () => {
    c = await setUp();
    const answered = await deliver(c, BODY, signedHeaders(BODY));
    expect(answered.body).not.toContain(SECRET);
    expect(c.lines.join('')).not.toContain(SECRET);
  });
});
```

(`WIREBENCH_SERVER_HOOKS_SECRET_KEY: ''` counts as unset: `inputFrom` skips empty values; the seeded row is sealed under the default key.)

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run packages/server/test/unit/hooks/verify.test.ts && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/signatures-public.test.ts`
Expected: FAIL — `verify.js` and `seedSignature` do not exist.

- [ ] **Step 3: Implement**

Create `packages/server/src/hooks/verify.ts`:

```ts
/**
 * §3.3 step 1: a capture's verdict, from the catch URL's scheme and its opened secret, over the full
 * body before truncation. Never throws: a secret that will not open is `failed: key-error`, logged
 * without the secret; with no scheme there is nothing to check (`null`).
 */
import { verifyWebhook } from '@wirebench/engine';
import type { SignatureVerdict } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { HooksEnv } from './env.js';
import type { PublicCatchUrl } from './repo.js';
import { open } from './secret-box.js';
import type { HooksSettings } from './settings.js';

const KEY_ERROR: SignatureVerdict = { verdict: 'failed', reason: 'key-error' };

export function verifyCapture(
  env: Pick<HooksEnv, 'now'> & { readonly settings: Pick<HooksSettings, 'secretKey'> },
  hook: PublicCatchUrl,
  headers: readonly (readonly [string, string])[],
  body: Buffer,
  log: Pick<FastifyBaseLogger, 'error'>,
): SignatureVerdict | null {
  const signature = hook.signature;
  if (signature === undefined) return null;
  const key = env.settings.secretKey;
  if (key === undefined || signature.scheme === undefined) return KEY_ERROR;
  let secret: string;
  try {
    secret = open(key, signature.sealedSecret);
  } catch (error) {
    log.error(
      { hookId: hook.id, reason: error instanceof Error ? error.message : String(error) },
      'could not open a catch URL signature secret',
    );
    return KEY_ERROR;
  }
  return verifyWebhook(signature.scheme, secret, headers, body, { now: env.now() });
}
```

`packages/server/src/hooks/routes/public.ts` — import `import { verifyCapture } from '../verify.js';`; in `receive`, replace the capture construction with:

```ts
  const { path, query } = splitTarget(request.url);
  const body = Buffer.isBuffer(request.body) ? request.body : EMPTY;
  const headers = headerPairs(request.raw.rawHeaders);
  // webhook-signatures §3.3 step 1: on the full body, before truncation, so a correctly signed body
  // over the storage limit is still `verified`.
  const signature = verifyCapture(env, hook, headers, body, request.log);
  // Step 2: *Reject unverified* is only ever set beside a scheme (a check constraint), so a catch URL
  // with no scheme is never rejected.
  const rejected = hook.rejectUnverified && signature !== null && signature.verdict !== 'verified';
  const capture: repo.NewCapture = {
    id: env.newCaptureId(),
    catchUrlId: hook.id,
    receivedAt: env.now(),
    method: request.method,
    subpath: subpathOf(path),
    query,
    headers,
    ...truncateBody(body, env.settings.bodyLimitBytes),
    // `request.ip` follows `trustProxy` (§3.3).
    sourceIp: request.ip,
    signature,
    rejected,
  };
```

and after the `announce(…)` call, before `await delay(…)`:

```ts
  // Step 4: at once, with no body and no configured delay; the capture is already stored.
  if (rejected) return reply.code(401).send();
```

Update the file's header comment list of answers to include `401` (*Reject unverified*).

`packages/server/test/helpers/identity.ts` — `identityHarness`'s options gain `readonly logStream?: NodeJS.WritableStream;` and the build becomes `buildServer(ctx, { modules, ...(options.logStream !== undefined ? { logStream: options.logStream } : {}) })`.

`packages/server/test/helpers/hooks.ts` — `hooksHarness`'s options gain `readonly logStream?: NodeJS.WritableStream;`, passed through as `...(options.logStream !== undefined ? { logStream: options.logStream } : {})`; add:

```ts
/** A signature written straight into the row (webhook-signatures §3.2), sealed under `key`. */
export async function seedSignature(
  h: IdentityHarness,
  hookId: string,
  input: {
    readonly scheme: SignatureScheme;
    readonly secret: string;
    readonly key: Buffer;
    readonly rejectUnverified?: boolean;
  },
): Promise<void> {
  await repo.updateCatchUrl(h.db, hookId, {
    signature: { scheme: input.scheme, sealedSecret: seal(input.key, input.secret), hint: hintOf(input.secret) },
    ...(input.rejectUnverified !== undefined ? { rejectUnverified: input.rejectUnverified } : {}),
  });
}
```

(imports: `import type { SignatureScheme } from '@wirebench/engine';`, `import { hintOf, seal } from '../../src/hooks/secret-box.js';`).

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run packages/server/test/unit/hooks && nice pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): verify captures on receipt and reject unverified ones with 401"
```

---

### Task 10: Desktop main — signing on the wire, in mutations and in the project projection

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (`signatureSchemeWireSchema`, `webhookSigningWireSchema`, `signing` on `webhookCollectionWireSchema` / `restRequestWireSchema` / `restFolderWireSchema` / `restRequestPatchSchema`, the `update-webhooks` patch, the new `set-webhook-folder-signing` change)
- Modify: `apps/desktop/src/main/project-rest-mutations.ts` (`toEngineSigning`, `applyRestRequestPatch`, `updateRestRequest`, `cloneRestRequest`)
- Modify: `apps/desktop/src/main/project-webhook-mutations.ts` (`updateWebhooks`, `setWebhookFolderSigning`)
- Modify: `apps/desktop/src/main/project-mutations.ts` (the two change cases)
- Modify: `apps/desktop/src/main/rest-send.ts` (`withDraft`)
- Modify: `apps/desktop/src/main/project-wire.ts` (`toRestRequestWire`, `toWebhookCollectionWire`, `toWebhookTreeWires`)
- Test: `apps/desktop/test/project-webhook-signing.test.ts`

**Interfaces:**
- Consumes: `WebhookSigning`, `signatureSchemeSchema`, `toSignatureScheme` (Tasks 1–2).
- Produces:
  - `signatureSchemeWireSchema`, `type SignatureSchemeWire`; `webhookSigningWireSchema`, `type WebhookSigningWire` (restated; `wire-types.ts` imports nothing from the engine).
  - `RestRequestPatchWire.signing?: WebhookSigningWire | null` — `null` removes the item's own signing (back to inherit).
  - `update-webhooks` `patch.signing?: WebhookSigningWire | null`; change `{ kind: 'set-webhook-folder-signing', folderId, signing: WebhookSigningWire | null }`.
  - `toEngineSigning(wire: WebhookSigningWire): WebhookSigning` — `ProjectError('webhook-signing-invalid')` for a scheme the engine schema refuses.
  - `setWebhookFolderSigning(project, folderId, signing: WebhookSigningWire | null): RestMutationResult`.
  - `updateRestRequest` refuses `signing` on an API request: `ProjectError('webhook-signing-not-webhook')`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/project-webhook-signing.test.ts
import { describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, createWebhookCollection, createWebhookFolder } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import { toProjectWire } from '../src/main/project-wire.js';
import { cloneRestRequest, updateRestRequest } from '../src/main/project-rest-mutations.js';
import { setWebhookFolderSigning, updateWebhooks } from '../src/main/project-webhook-mutations.js';
import { withDraft } from '../src/main/rest-send.js';
import { projectChangeSchema, restRequestPatchSchema } from '../src/shared/wire-types.js';
import type { WebhookSigningWire } from '../src/shared/wire-types.js';

const HMAC: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};
const deps = { generate: () => Promise.reject(new Error('not needed')) };

function project(): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    apis: [createApi('Shop', { id: 'api-1', requests: [createRestRequest('List', { id: 'r1' })] })],
    webhooks: createWebhookCollection({
      requests: [createRestRequest('Ping', { id: 'w1', method: 'POST' })],
      folders: [
        createWebhookFolder('Orders', {
          id: 'g1',
          requests: [createRestRequest('Paid', { id: 'w2', method: 'POST' })],
        }),
      ],
    }),
  };
}

describe('webhook signing in main (§5.1)', () => {
  it('sets and clears the collection, a folder and an item', () => {
    let p = updateWebhooks(project(), { signing: HMAC }).project;
    expect(p.webhooks?.signing).toEqual(HMAC);
    p = setWebhookFolderSigning(p, 'g1', { mode: 'none' }).project;
    expect(p.webhooks?.folders[0]?.signing).toEqual({ mode: 'none' });
    p = updateRestRequest(p, 'w2', { signing: HMAC }).project;
    expect(p.webhooks?.folders[0]?.requests[0]?.signing).toEqual(HMAC);
    p = updateRestRequest(p, 'w2', { signing: null }).project;
    expect(p.webhooks?.folders[0]?.requests[0]).not.toHaveProperty('signing');
    p = setWebhookFolderSigning(p, 'g1', null).project;
    expect(p.webhooks?.folders[0]).not.toHaveProperty('signing');
    p = updateWebhooks(p, { signing: null }).project;
    expect(p.webhooks).not.toHaveProperty('signing');
  });

  it('keeps signing through an unrelated patch and a clone', () => {
    let p = updateRestRequest(project(), 'w1', { signing: HMAC }).project;
    p = updateRestRequest(p, 'w1', { url: '/ping' }).project;
    expect(p.webhooks?.requests[0]?.signing).toEqual(HMAC);
    const cloned = cloneRestRequest(p, 'w1');
    expect(cloned.project.webhooks?.requests.find((r) => r.id === cloned.createdId)?.signing).toEqual(HMAC);
  });

  it('refuses signing on an API request, and a scheme the engine refuses', () => {
    expect(() => updateRestRequest(project(), 'r1', { signing: HMAC })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-not-webhook' }),
    );
    const bad: WebhookSigningWire = { ...HMAC, scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X Sig' } };
    expect(() => updateRestRequest(project(), 'w1', { signing: bad })).toThrow(
      expect.objectContaining({ code: 'webhook-signing-invalid' }),
    );
  });

  it('carries the change kinds through the wire and applyChange', async () => {
    expect(restRequestPatchSchema.parse({ signing: null })).toEqual({ signing: null });
    const change = projectChangeSchema.parse({ kind: 'set-webhook-folder-signing', folderId: 'g1', signing: HMAC });
    expect((await applyChange(project(), change, deps)).project.webhooks?.folders[0]?.signing).toEqual(HMAC);
    const collection = projectChangeSchema.parse({ kind: 'update-webhooks', patch: { signing: { mode: 'none' } } });
    expect((await applyChange(project(), collection, deps)).project.webhooks?.signing).toEqual({ mode: 'none' });
  });

  it('projects signing onto the collection, folder and request wires', () => {
    let p = updateWebhooks(project(), { signing: HMAC }).project;
    p = setWebhookFolderSigning(p, 'g1', { mode: 'none' }).project;
    p = updateRestRequest(p, 'w2', { signing: HMAC }).project;
    const wire = toProjectWire(p, { dir: '/tmp', dirty: false, problems: [], runtime: new Map() });
    expect(wire.webhooks?.signing).toEqual(HMAC);
    expect(wire.folders.find((f) => f.id === 'g1')?.signing).toEqual({ mode: 'none' });
    expect(wire.restRequests.find((r) => r.id === 'w2')?.signing).toEqual(HMAC);
    expect(wire.restRequests.find((r) => r.id === 'w1')).not.toHaveProperty('signing');
  });

  it('applies a draft signing for a send, and null drops it', () => {
    const saved = { ...createRestRequest('Ping', { id: 'w1' }), signing: HMAC };
    expect(withDraft(saved, { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(withDraft(saved, { signing: null })).not.toHaveProperty('signing');
    expect(withDraft(saved, { url: '/x' }).signing).toEqual(HMAC);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run apps/desktop/test/project-webhook-signing.test.ts`
Expected: FAIL — `setWebhookFolderSigning` is not exported; `signing` is stripped by the patch schema.

- [ ] **Step 3: Implement**

`apps/desktop/src/shared/wire-types.ts` — before `restRequestWireSchema` (after `hookLinkWireSchema`):

```ts
/**
 * The engine's `SignatureScheme` restated (webhook-signatures §2). Main re-validates with the
 * engine's schema (`toEngineSigning`); these only check the shape crossing the bridge.
 */
export const signatureSchemeWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hmac'),
    algorithm: z.enum(['sha1', 'sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
    header: z.string(),
    prefix: z.string().optional(),
  }),
  z.object({ kind: z.literal('timestamped'), header: z.string(), toleranceSec: z.number() }),
  z.object({ kind: z.literal('standard'), toleranceSec: z.number() }),
]);
export type SignatureSchemeWire = z.infer<typeof signatureSchemeWireSchema>;

/** The engine's `WebhookSigning` restated (§5.1): absent on a node means inherit. */
export const webhookSigningWireSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('sign'),
    scheme: signatureSchemeWireSchema,
    /** A keychain reference, never the secret. */
    secretRef: z.string().optional(),
    /** The CI name: `WIREBENCH_SECRET_<secretEnv>`. */
    secretEnv: z.string().optional(),
  }),
]);
export type WebhookSigningWire = z.infer<typeof webhookSigningWireSchema>;
```

Add `signing: webhookSigningWireSchema.optional(),` to `webhookCollectionWireSchema` (after `auth`), to `restRequestWireSchema` (after `hook`, doc `/** Webhook items only: overrides the inherited signing. */`) and to `restFolderWireSchema` (after `source`, doc `/** Webhook folder only. */`). Add to `restRequestPatchSchema`:

```ts
  /** Webhook items only; `null` removes the item's own signing, back to inherit (§5.1). */
  signing: webhookSigningWireSchema.nullable().optional(),
```

In the `update-webhooks` patch object: `signing: webhookSigningWireSchema.nullable().optional(),` (doc: `` /** `null` clears the collection's signing: nothing inherits any. */ ``). After the `set-webhook-folder-target` change:

```ts
  z.object({
    kind: z.literal('set-webhook-folder-signing'),
    folderId: z.string(),
    /** `null` clears the folder's own signing, back to inheriting. */
    signing: webhookSigningWireSchema.nullable(),
  }),
```

`apps/desktop/src/main/project-rest-mutations.ts` — imports `signatureSchemeSchema`, `toSignatureScheme` (values) and `WebhookSigning` (type) from `@wirebench/engine`, `WebhookSigningWire` from wire-types. After `toEngineAuthConfig`:

```ts
/**
 * A wire signing as the engine's (webhook-signatures §5.1). The scheme is re-parsed with the
 * engine's schema: it applies the tolerance default and the header-name rule the files enforce, so
 * main never saves a scheme the loader would then refuse.
 *
 * @throws ProjectError `webhook-signing-invalid`
 */
export function toEngineSigning(wire: WebhookSigningWire): WebhookSigning {
  if (wire.mode === 'none') return { mode: 'none' };
  const parsed = signatureSchemeSchema.safeParse(wire.scheme);
  if (!parsed.success) {
    throw new ProjectError('webhook-signing-invalid', 'The signing scheme is not valid', {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }
  return {
    mode: 'sign',
    scheme: toSignatureScheme(parsed.data),
    ...(wire.secretRef !== undefined && wire.secretRef !== '' ? { secretRef: wire.secretRef } : {}),
    ...(wire.secretEnv !== undefined && wire.secretEnv !== '' ? { secretEnv: wire.secretEnv } : {}),
  };
}
```

In `applyRestRequestPatch`, after the `hook` spread:

```ts
    // Webhook items only (`updateRestRequest` refuses it elsewhere); `null` returns to inherit.
    ...(patch.signing === null
      ? {}
      : patch.signing !== undefined
        ? { signing: toEngineSigning(patch.signing) }
        : request.signing !== undefined
          ? { signing: request.signing }
          : {}),
```

In `updateRestRequest`, before `const apply`:

```ts
  if (patch.signing !== undefined) {
    const owner = restTreeOwnerOf(project, requestId);
    if (owner !== undefined && !isWebhookOwner(owner)) {
      throw new ProjectError('webhook-signing-not-webhook', 'Only a webhook item can sign what it sends', {
        details: { requestId },
      });
    }
  }
```

In `cloneRestRequest`'s `withAssertions`, add `...(original.signing !== undefined ? { signing: original.signing } : {}),` (a clone signs like its original; only `hook` is deliberately dropped).

`apps/desktop/src/main/project-webhook-mutations.ts` — import `toEngineSigning` from `./project-rest-mutations.js` and `WebhookSigningWire` from wire-types. `updateWebhooks`' patch type gains `readonly signing?: WebhookSigningWire | null`, and the `cleanUndefined` object gains:

```ts
    signing:
      patch.signing === null ? undefined : patch.signing !== undefined ? toEngineSigning(patch.signing) : webhooks.signing,
```

After `setWebhookFolderTarget`:

```ts
/** Sets, or clears with `signing: null`, one folder's own signing override (§5.1). */
export function setWebhookFolderSigning(
  project: Project,
  folderId: string,
  signing: WebhookSigningWire | null,
): RestMutationResult {
  const webhooks = project.webhooks;
  if (webhooks === undefined) {
    notFound('folder', folderId);
  }
  const next = signing === null ? undefined : toEngineSigning(signing);
  const folders = mapFolder(webhooks.folders, folderId, (folder) => {
    const rest: Record<string, unknown> = { ...folder };
    if (next === undefined) {
      delete rest['signing'];
    } else {
      rest['signing'] = next;
    }
    return rest as unknown as WebhookFolder;
  });
  if (folders === undefined) {
    notFound('folder', folderId);
  }
  return { project: { ...project, webhooks: { ...webhooks, folders } } };
}
```

`apps/desktop/src/main/project-mutations.ts` — the `update-webhooks` case adds `...(change.patch.signing !== undefined ? { signing: change.patch.signing } : {}),`; after the `set-webhook-folder-target` case:

```ts
    case 'set-webhook-folder-signing':
      return setWebhookFolderSigning(project, change.folderId, change.signing);
```

`apps/desktop/src/main/rest-send.ts` — `withDraft` becomes:

```ts
export function withDraft(request: RestRequestDef, draft: RestRequestPatchWire | undefined): RestRequestDef {
  if (draft === undefined) {
    return request;
  }
  const merged: RestRequestDef = {
    ...request,
    ...(draft.method !== undefined ? { method: draft.method } : {}),
    ...(draft.url !== undefined ? { url: draft.url } : {}),
    ...(draft.pathParams !== undefined ? { pathParams: toEngineRows(draft.pathParams) } : {}),
    ...(draft.query !== undefined ? { query: toEngineRows(draft.query) } : {}),
    ...(draft.headers !== undefined ? { headers: toEngineRows(draft.headers) } : {}),
    ...(draft.body !== undefined ? { body: toEngineBody(draft.body) } : {}),
    ...(draft.auth !== undefined ? { auth: toEngineAuthConfig(draft.auth) } : {}),
    ...(draft.settings !== undefined ? { settings: cleanSettings(draft.settings) } : {}),
    ...(draft.signing !== undefined && draft.signing !== null ? { signing: toEngineSigning(draft.signing) } : {}),
  };
  if (draft.signing !== null) return merged;
  // An unsaved *Inherit* on the Signing tab: send as the parents would sign.
  const { signing: _dropped, ...rest } = merged;
  return rest;
}
```

(import `toEngineSigning` beside `toEngineAuthConfig`).

`apps/desktop/src/main/project-wire.ts` — `toRestRequestWire` adds `...(request.signing !== undefined ? { signing: request.signing } : {}),` after `hook`; `toWebhookCollectionWire` adds `...(webhooks.signing !== undefined ? { signing: webhooks.signing } : {}),`; the folder push in `toWebhookTreeWires` adds `...(folder.signing !== undefined ? { signing: folder.signing } : {}),`. (The engine shapes are assignable to the wire ones: the wire's fields are a superset with `prefix?: string`.)

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run apps/desktop/test/project-webhook-signing.test.ts apps/desktop/test/project-webhook-mutations.test.ts apps/desktop/test/webhook-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): signing on webhook items, folders and the collection in main"
```

---

### Task 11: Desktop main — sign on send, and the catch URL signature wire

**Files:**
- Modify: `apps/desktop/src/main/rest-send.ts` (`RestSendResolution.webhookSigning`)
- Modify: `apps/desktop/src/main/webhook-send.ts` (`resolveWebhookSend`, `webhookSignFor`)
- Modify: `apps/desktop/src/main/ipc/request.ts` (`sendRestRequest`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (`signatureFailureWireSchema`, `captureSignatureWireSchema`, fields on `catchUrlWireSchema`, `captureSummaryWireSchema`, `hooksUpdateRequestWireSchema`)
- Modify: `apps/desktop/src/main/hooks/hooks-service.ts` (`toCaptureView`)
- Test: `apps/desktop/test/webhook-send-signing.test.ts`, `apps/desktop/test/hooks/hooks-signature-wire.test.ts`

**Interfaces:**
- Consumes: `signingAlong`, `signingSecretRef`, `signingSecretMissing`, `EffectiveSigning`, `RestSendInput.sign` (Tasks 2, 4); `CaptureSignature`, `CatchUrlSignature` (Task 8).
- Produces:
  - `RestSendResolution.webhookSigning?: EffectiveSigning` — set only when the effective signing is `sign`.
  - `webhookSignFor(effective: EffectiveSigning | undefined, getSecret: GetSecret): Promise<RestSendInput['sign']>` — throws `webhook-signing-secret` when the keychain has nothing.
  - Wire: `CatchUrlWire.signature?`, `rejectUnverified?`, `signatureAvailable?`; `CaptureSummaryWire.signature?`, `rejected?` (and so `CaptureViewWire`); `HooksUpdateRequestWire.signature?`, `rejectUnverified?`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/webhook-send-signing.test.ts
import { describe, expect, it } from 'vitest';
import { createProject, createRestRequest, createWebhookCollection, createWebhookFolder } from '@wirebench/engine';
import type { Project, PropertyScopes, WebhookSigning } from '@wirebench/engine';
import { resolveWebhookSend, webhookSignFor } from '../src/main/webhook-send.js';

const scopes: PropertyScopes = { project: {}, global: {}, system: {} };
const SIGNING: WebhookSigning = {
  mode: 'sign',
  scheme: { kind: 'standard', toleranceSec: 300 },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};

function project(signing?: WebhookSigning): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    webhooks: createWebhookCollection({
      target: 'https://receiver.test/hooks',
      folders: [
        createWebhookFolder('Orders', {
          id: 'g1',
          ...(signing !== undefined ? { signing } : {}),
          requests: [createRestRequest('Paid', { id: 'w1', method: 'POST', url: '/paid' })],
        }),
      ],
    }),
  };
}

const resolve = (p: Project, draft?: Parameters<typeof resolveWebhookSend>[0]['draft']) =>
  resolveWebhookSend({ project: p, projectId: 'p1', requestId: 'w1', scopes, newest: () => undefined, ...(draft ? { draft } : {}) })!;

describe('signing a webhook send (§5.2)', () => {
  it('reports the effective signing, drafts included, and nothing when it is none', () => {
    expect(resolve(project(SIGNING)).webhookSigning).toEqual({ signing: SIGNING, from: 'folder', fromName: 'Orders' });
    expect(resolve(project()).webhookSigning).toBeUndefined();
    expect(resolve(project(SIGNING), { signing: { mode: 'none' } }).webhookSigning).toBeUndefined();
  });

  it('reads the secret from the keychain lookup auth uses', async () => {
    const effective = resolve(project(SIGNING)).webhookSigning;
    const secrets: Record<string, string> = { 'ref-orders': 'abc123def456ghi789' };
    await expect(webhookSignFor(effective, (ref) => Promise.resolve(secrets[ref]))).resolves.toEqual({
      scheme: SIGNING.scheme,
      secret: 'abc123def456ghi789',
    });
    await expect(webhookSignFor(undefined, () => Promise.resolve(undefined))).resolves.toBeUndefined();
  });

  it('refuses rather than send unsigned', async () => {
    const effective = resolve(project(SIGNING)).webhookSigning;
    await expect(webhookSignFor(effective, () => Promise.resolve(undefined))).rejects.toMatchObject({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the folder “Orders” but its secret is not set',
    });
  });
});
```

```ts
// apps/desktop/test/hooks/hooks-signature-wire.test.ts
import { describe, expect, it } from 'vitest';
import { captureSummarySchema, catchUrlSchema, CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import type { Capture } from '@wirebench/engine';
import { toCaptureView } from '../../src/main/hooks/hooks-service.js';
import {
  captureSummaryWireSchema,
  catchUrlWireSchema,
  hooksUpdateRequestWireSchema,
} from '../../src/shared/wire-types.js';

const HOOK = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  name: 'Signed',
  url: 'https://wirebench.test/hooks/3ZC5Q0V7R3T9XK2M4N6P8QAB7Y',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  signature: {
    scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
    secret: { set: true, hint: 'i789' },
  },
  rejectUnverified: true,
  signatureAvailable: true,
};

describe('catch URL signature fields cross the bridge (§4)', () => {
  it('keeps what the engine parsed', () => {
    const parsed = catchUrlSchema.parse(HOOK);
    expect(catchUrlWireSchema.parse(parsed)).toEqual(parsed);
    expect(hooksUpdateRequestWireSchema.parse({ url: 'u', workspaceId: 'w', hookId: 'h', signature: null })).toMatchObject({
      signature: null,
    });
  });

  it('passes a verdict and a rejection through to the viewer', () => {
    const summary = captureSummarySchema.parse({
      id: '01J8ZC5Q0V7R3T9XK2M4N6P8QC',
      receivedAt: '2026-09-29T10:00:01.000Z',
      method: 'POST',
      subpath: '',
      bodySize: 2,
      truncated: false,
      sourceIp: '203.0.113.9',
      signature: { verdict: 'failed', reason: 'mismatch' },
      rejected: true,
    });
    expect(captureSummaryWireSchema.parse(summary)).toEqual(summary);
    const capture: Capture = { ...summary, query: '', headers: [], body: Buffer.from('{}').toString('base64') };
    expect(toCaptureView(capture)).toMatchObject({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    const { signature: _s, rejected: _r, ...unchecked } = capture;
    const view = toCaptureView(unchecked);
    expect(view).not.toHaveProperty('signature');
    expect(view).not.toHaveProperty('rejected');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run apps/desktop/test/webhook-send-signing.test.ts apps/desktop/test/hooks/hooks-signature-wire.test.ts`
Expected: FAIL — `webhookSignFor` is not exported; the wire schemas strip the new fields.

- [ ] **Step 3: Implement**

`apps/desktop/src/main/rest-send.ts` — `RestSendResolution` gains (import `EffectiveSigning` as a type from the engine):

```ts
  /** A webhook item's signing when it signs (webhook-signatures §5.2); its secret is read at send. */
  readonly webhookSigning?: EffectiveSigning;
```

`apps/desktop/src/main/webhook-send.ts` — imports: add `signingAlong`, `signingSecretMissing` to the engine value import; `EffectiveSigning`, `GetSecret`, `RestSendInput` to the type import. In `resolveWebhookSend`, after `const auth = …`:

```ts
  const signing = signingAlong(collection, path.chain, request);
```

and in the returned object, after `auth`: `...(signing.signing.mode === 'sign' ? { webhookSigning: signing } : {}),`. Update the doc comment: *Signing climbs the same way: item → nearest folder → collection.* Add at the end of the file:

```ts
/**
 * The signing to put on the send input, its secret read through the keychain lookup auth uses
 * (§5.2). Never sends unsigned: signing set with nothing in the keychain refuses the send.
 *
 * @throws WirebenchError `webhook-signing-secret`
 */
export async function webhookSignFor(
  effective: EffectiveSigning | undefined,
  getSecret: GetSecret,
): Promise<RestSendInput['sign']> {
  if (effective === undefined || effective.signing.mode !== 'sign') return undefined;
  const ref = effective.signing.secretRef;
  const secret = ref === undefined || ref === '' ? undefined : await getSecret(ref);
  if (secret === undefined || secret === '') throw signingSecretMissing(effective);
  return { scheme: effective.signing.scheme, secret };
}
```

(Only `secretRef` is read here: the desktop has a keychain, and `secretEnv` is for CI.)

`apps/desktop/src/main/ipc/request.ts` — import `webhookSignFor` from `../webhook-send.js`; in `sendRestRequest`'s `try`, replace the `input = …` line with:

```ts
    // Signing is computed by the engine over the encoded body (§5.2); here it only gets its secret,
    // inside the prepare stage so a missing one is logged as a send that never went out.
    const sign = await webhookSignFor(resolved.webhookSigning, getSecret);
    input = {
      ...resolved.input,
      tls: mergedTls,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(sign !== undefined ? { sign } : {}),
    };
```

`apps/desktop/src/shared/wire-types.ts` — before `catchUrlWireSchema`:

```ts
/** The engine's `SignatureFailure`, restated (webhook-signatures §3.3). */
export const signatureFailureWireSchema = z.enum([
  'missing-header',
  'malformed-header',
  'mismatch',
  'stale-timestamp',
  'key-error',
]);
export type SignatureFailureWire = z.infer<typeof signatureFailureWireSchema>;
/** A capture's verdict; absent (or `null`) on a capture means not checked. */
export const captureSignatureWireSchema = z.object({
  verdict: z.enum(['verified', 'failed']),
  reason: signatureFailureWireSchema.optional(),
});
export type CaptureSignatureWire = z.infer<typeof captureSignatureWireSchema>;
```

`catchUrlWireSchema` gains:

```ts
  /** The scheme and only whether a secret is set; the hint only for editors (§3.4). */
  signature: z
    .object({
      scheme: signatureSchemeWireSchema,
      secret: z.object({ set: z.literal(true), hint: z.string().nullable() }),
    })
    .nullable()
    .optional(),
  rejectUnverified: z.boolean().optional(),
  /** `false` while the server's key is unset. Absent from a server without the module. */
  signatureAvailable: z.boolean().optional(),
```

`captureSummaryWireSchema` gains `signature: captureSignatureWireSchema.nullable().optional(), rejected: z.boolean().optional(),`. `hooksUpdateRequestWireSchema` gains:

```ts
  /** `null` clears; without `secret` the stored one stays (§3.4). */
  signature: z.object({ scheme: signatureSchemeWireSchema, secret: z.string().optional() }).nullable().optional(),
  rejectUnverified: z.boolean().optional(),
```

(`signatureSchemeWireSchema` is declared earlier in the file, Task 10.) The `hooks.update` handler already spreads the rest of the request into the patch, so the new fields reach `updateHook` unchanged.

`apps/desktop/src/main/hooks/hooks-service.ts` — `toCaptureView` adds after `sourceIp`:

```ts
    ...(capture.signature !== undefined && capture.signature !== null ? { signature: capture.signature } : {}),
    ...(capture.rejected === true ? { rejected: true } : {}),
```

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run apps/desktop/test/webhook-send-signing.test.ts apps/desktop/test/hooks apps/desktop/test/webhook-send.test.ts apps/desktop/test/ipc-hooks.test.ts apps/desktop/test/project-host-webhook-send.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): sign webhook sends from the keychain; pass catch URL signatures through"
```

---

### Task 12: Renderer — the catch URL's *Signature* section

**Files:**
- Create: `apps/desktop/src/renderer/features/webhooks/signature-text.ts`
- Create: `apps/desktop/src/renderer/features/webhooks/scheme-fields.tsx`
- Create: `apps/desktop/src/renderer/features/webhooks/catch-url-signature.tsx`
- Modify: `apps/desktop/src/renderer/features/webhooks/catch-url-settings-dialog.tsx`
- Test: `apps/desktop/test/renderer/signature-text.test.ts`, `apps/desktop/test/renderer/catch-url-signature.test.tsx`

**Interfaces:**
- Consumes (types only): `SignatureSchemeWire`, `SignatureFailureWire`, `CaptureSignatureWire`, `CatchUrlWire`, `HooksUpdateRequestWire` (Tasks 10–11).
- Produces:
  - `signature-text.ts`: `SCHEME_KINDS`, `SCHEME_LABELS`, `REASON_TEXT`, `SIGNATURE_LIMITS`, `HEADER_NAME_PATTERN`, `PREFIX_PATTERN`, `defaultScheme(kind)`, `schemeSummary(scheme)`, `schemeProblemOf(scheme)`, `signatureHeadersOf(headers, scheme)`, `verdictText(signature)`.
  - `SchemeFields({ scheme, onChange, disabled, prefix })` — test ids `${prefix}-algorithm`, `-encoding`, `-header`, `-prefix`, `-tolerance`.
  - `catch-url-signature.tsx`: `SignatureForm`, `signatureFormOf(hook)`, `signatureProblemOf(form, hook)`, `signatureRequestOf(form, hook)`, `SignatureSection`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/renderer/signature-text.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SEC,
  SIGNATURE_FAILURES,
  SIGNATURE_SECRET_MAX_LENGTH,
  signatureSchemeSchema,
} from '@wirebench/engine';
import {
  defaultScheme,
  HEADER_NAME_PATTERN,
  REASON_TEXT,
  SCHEME_KINDS,
  schemeProblemOf,
  schemeSummary,
  SIGNATURE_LIMITS,
  signatureHeadersOf,
  verdictText,
} from '../../src/renderer/features/webhooks/signature-text.js';

describe('the renderer restates the signature rules (webhook-signatures §2, §4)', () => {
  it('matches the engine', () => {
    expect(Object.keys(REASON_TEXT)).toEqual([...SIGNATURE_FAILURES]);
    expect(SIGNATURE_LIMITS.maxSecretLength).toBe(SIGNATURE_SECRET_MAX_LENGTH);
    expect(SIGNATURE_LIMITS.defaultToleranceSec).toBe(DEFAULT_SIGNATURE_TOLERANCE_SEC);
    for (const kind of SCHEME_KINDS) {
      expect(signatureSchemeSchema.parse(defaultScheme(kind))).toEqual(defaultScheme(kind));
    }
    for (const header of ['X-Signature', 'x_sig.1', 'X Sig', 'X:Sig', '']) {
      const engine = signatureSchemeSchema.safeParse({ kind: 'timestamped', header, toleranceSec: 300 }).success;
      expect(schemeProblemOf({ kind: 'timestamped', header, toleranceSec: 300 }) === undefined).toBe(engine);
      expect(HEADER_NAME_PATTERN.test(header)).toBe(engine);
    }
    for (const toleranceSec of [0, 1, 86_400, 86_401]) {
      const engine = signatureSchemeSchema.safeParse({ kind: 'standard', toleranceSec }).success;
      expect(schemeProblemOf({ kind: 'standard', toleranceSec }) === undefined).toBe(engine);
    }
  });

  it('describes schemes, verdicts and the headers that carried them', () => {
    expect(schemeSummary(defaultScheme('hmac'))).toBe('HMAC of body · SHA-256 · hex · X-Signature');
    expect(schemeSummary({ kind: 'standard', toleranceSec: 300 })).toBe('Standard Webhooks · ±300 s');
    expect(verdictText({ verdict: 'verified' })).toBe('✓ verified');
    expect(verdictText({ verdict: 'failed', reason: 'mismatch' })).toBe('✗ digest mismatch');
    expect(verdictText(null)).toBe('not checked');
    const headers: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['webhook-id', 'msg_1'],
      ['X-Signature', 'abc'],
      ['webhook-signature', 'v1,xyz'],
    ];
    expect(signatureHeadersOf(headers, defaultScheme('hmac'))).toEqual([['X-Signature', 'abc']]);
    expect(signatureHeadersOf(headers, { kind: 'standard', toleranceSec: 300 })).toEqual([
      ['webhook-id', 'msg_1'],
      ['webhook-signature', 'v1,xyz'],
    ]);
    expect(signatureHeadersOf(headers, undefined)).toEqual([
      ['webhook-id', 'msg_1'],
      ['X-Signature', 'abc'],
      ['webhook-signature', 'v1,xyz'],
    ]);
  });
});
```

```tsx
// apps/desktop/test/renderer/catch-url-signature.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatchUrlSettingsDialog } from '../../src/renderer/features/webhooks/catch-url-settings-dialog.js';
import {
  signatureFormOf,
  signatureProblemOf,
  signatureRequestOf,
} from '../../src/renderer/features/webhooks/catch-url-signature.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CatchUrlWire } from '../../src/shared/wire-types.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HMAC = { kind: 'hmac' as const, algorithm: 'sha256' as const, encoding: 'hex' as const, header: 'X-Signature' };
const PLAIN: CatchUrlWire = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6H001',
  workspaceId: SERVER.workspaceId,
  name: 'Signed',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  signature: null,
  rejectUnverified: false,
  signatureAvailable: true,
};
const SIGNED: CatchUrlWire = {
  ...PLAIN,
  signature: { scheme: HMAC, secret: { set: true, hint: 'i789' } },
  rejectUnverified: true,
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp(role: 'viewer' | 'editor', hook: CatchUrlWire) {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [hook] })),
      update: vi.fn().mockResolvedValue(ok({ hook })),
    },
  });
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [hook],
    loaded: true,
  });
  render(<CatchUrlSettingsDialog />);
  act(() => useWebhooksDialogs.getState().openSettings(hook.id));
  return api;
}

afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false });
  useSyncStore.getState().reset();
  useEditorsStore.getState().reset();
});

describe('the Signature form (§4)', () => {
  it('sends nothing when nothing changed, a new secret only when typed, and null to clear', () => {
    const form = signatureFormOf(SIGNED);
    expect(signatureRequestOf(form, SIGNED)).toEqual({});
    expect(signatureRequestOf({ ...form, secret: 'abc123def456ghi789' }, SIGNED)).toEqual({
      signature: { scheme: HMAC, secret: 'abc123def456ghi789' },
    });
    expect(signatureRequestOf({ ...form, scheme: { kind: 'standard', toleranceSec: 300 } }, SIGNED)).toEqual({
      signature: { scheme: { kind: 'standard', toleranceSec: 300 } },
    });
    expect(signatureRequestOf({ ...form, scheme: null }, SIGNED)).toEqual({ signature: null });
    expect(signatureRequestOf({ ...form, rejectUnverified: false }, SIGNED)).toEqual({ rejectUnverified: false });
  });

  it('asks for a secret when none is stored, and bounds it', () => {
    const form = { ...signatureFormOf(PLAIN), scheme: HMAC };
    expect(signatureProblemOf(form, PLAIN)).toBe('Enter the secret the sender signs with.');
    expect(signatureProblemOf({ ...form, secret: 'x'.repeat(513) }, PLAIN)).toBe('The secret is at most 512 characters.');
    expect(signatureProblemOf({ ...form, secret: 'abc123def456ghi789' }, PLAIN)).toBeUndefined();
    expect(signatureProblemOf({ ...form, scheme: { ...HMAC, header: 'X Sig' }, secret: 'a' }, PLAIN)).toBe(
      'The header name has a character a header name cannot have.',
    );
  });
});

describe('the Signature section in the settings dialog (§4)', () => {
  it('sets a scheme and a secret as an editor', async () => {
    const api = setUp('editor', PLAIN);
    fireEvent.change(screen.getByTestId('catch-url-signature-scheme'), { target: { value: 'hmac' } });
    fireEvent.change(screen.getByTestId('catch-url-signature-secret'), { target: { value: 'abc123def456ghi789' } });
    fireEvent.click(screen.getByTestId('catch-url-reject-unverified'));
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          signature: { scheme: HMAC, secret: 'abc123def456ghi789' },
          rejectUnverified: true,
        }),
      ),
    );
  });

  it('shows only that a secret is set, and replaces it on request', () => {
    setUp('editor', SIGNED);
    expect(screen.getByTestId('catch-url-signature-secret-set').textContent).toBe('● set …i789');
    expect(screen.queryByTestId('catch-url-signature-secret')).toBeNull();
    fireEvent.click(screen.getByTestId('catch-url-signature-replace'));
    expect(screen.getByTestId('catch-url-signature-secret')).toBeTruthy();
  });

  it('is read only for a viewer, with no hint', () => {
    setUp('viewer', { ...SIGNED, signature: { scheme: HMAC, secret: { set: true, hint: null } } });
    expect((screen.getByTestId('catch-url-signature-scheme') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('catch-url-signature-secret-set').textContent).toBe('● set');
    expect(screen.queryByTestId('catch-url-signature-replace')).toBeNull();
  });

  it('says why when the server has no key, and is absent on a server without the module', () => {
    setUp('editor', { ...PLAIN, signatureAvailable: false });
    expect(screen.getByTestId('catch-url-signature-unavailable').textContent).toContain(
      'WIREBENCH_SERVER_HOOKS_SECRET_KEY',
    );
    expect((screen.getByTestId('catch-url-signature-scheme') as HTMLSelectElement).disabled).toBe(true);
    cleanup();
    const { signature: _s, rejectUnverified: _r, signatureAvailable: _a, ...older } = PLAIN;
    setUp('editor', older);
    expect(screen.queryByTestId('catch-url-signature')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run apps/desktop/test/renderer/signature-text.test.ts apps/desktop/test/renderer/catch-url-signature.test.tsx`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/features/webhooks/signature-text.ts`:

```ts
/**
 * Signature words and rules for the renderer (webhook-signatures §2, §4), restated because the
 * renderer imports no engine values (Global Constraints). `signature-text.test.ts` pins them to
 * the engine's.
 */
import type { CaptureSignatureWire, SignatureFailureWire, SignatureSchemeWire } from '../../../shared/wire-types.js';

export type SchemeKind = SignatureSchemeWire['kind'];

export const SCHEME_KINDS: readonly SchemeKind[] = ['hmac', 'timestamped', 'standard'];

export const SCHEME_LABELS: Readonly<Record<SchemeKind, string>> = {
  hmac: 'HMAC of body',
  timestamped: 'Timestamped HMAC',
  standard: 'Standard Webhooks',
};

/** In the engine's `SIGNATURE_FAILURES` order. */
export const REASON_TEXT: Readonly<Record<SignatureFailureWire, string>> = {
  'missing-header': 'missing header',
  'malformed-header': 'malformed header',
  mismatch: 'digest mismatch',
  'stale-timestamp': 'timestamp outside tolerance',
  'key-error': 'server key error',
};

export const SIGNATURE_LIMITS = {
  maxSecretLength: 512,
  maxHeaderLength: 100,
  maxPrefixLength: 32,
  minToleranceSec: 1,
  maxToleranceSec: 86_400,
  defaultToleranceSec: 300,
} as const;

/** An HTTP field name (RFC 9110 `token`), as the engine checks it. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A prefix: visible ASCII, no spaces. */
export const PREFIX_PATTERN = /^[\x21-\x7e]*$/;

export function defaultScheme(kind: SchemeKind): SignatureSchemeWire {
  switch (kind) {
    case 'hmac':
      return { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
    case 'timestamped':
      return { kind: 'timestamped', header: 'X-Signature', toleranceSec: SIGNATURE_LIMITS.defaultToleranceSec };
    case 'standard':
      return { kind: 'standard', toleranceSec: SIGNATURE_LIMITS.defaultToleranceSec };
  }
}

const ALGORITHM_LABELS = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' } as const;

/** One line for a list or a read-only row. */
export function schemeSummary(scheme: SignatureSchemeWire): string {
  switch (scheme.kind) {
    case 'hmac':
      return [
        SCHEME_LABELS.hmac,
        ALGORITHM_LABELS[scheme.algorithm],
        scheme.encoding,
        scheme.prefix !== undefined && scheme.prefix !== '' ? `${scheme.header} (${scheme.prefix}…)` : scheme.header,
      ].join(' · ');
    case 'timestamped':
      return [SCHEME_LABELS.timestamped, scheme.header, `±${String(scheme.toleranceSec)} s`].join(' · ');
    case 'standard':
      return [SCHEME_LABELS.standard, `±${String(scheme.toleranceSec)} s`].join(' · ');
  }
}

function headerProblem(header: string): string | undefined {
  if (header === '') return 'Name the header the signature travels in.';
  if (header.length > SIGNATURE_LIMITS.maxHeaderLength)
    return `The header name is at most ${String(SIGNATURE_LIMITS.maxHeaderLength)} characters.`;
  return HEADER_NAME_PATTERN.test(header) ? undefined : 'The header name has a character a header name cannot have.';
}

function toleranceProblem(seconds: number): string | undefined {
  return Number.isInteger(seconds) &&
    seconds >= SIGNATURE_LIMITS.minToleranceSec &&
    seconds <= SIGNATURE_LIMITS.maxToleranceSec
    ? undefined
    : `The tolerance is ${String(SIGNATURE_LIMITS.minToleranceSec)} to ${String(SIGNATURE_LIMITS.maxToleranceSec)} seconds.`;
}

/** What the engine's schema would refuse, in the dialog's words; `undefined` when it would accept. */
export function schemeProblemOf(scheme: SignatureSchemeWire): string | undefined {
  switch (scheme.kind) {
    case 'hmac': {
      const prefix = scheme.prefix ?? '';
      if (prefix.length > SIGNATURE_LIMITS.maxPrefixLength || !PREFIX_PATTERN.test(prefix))
        return `The prefix is up to ${String(SIGNATURE_LIMITS.maxPrefixLength)} visible characters, no spaces.`;
      return headerProblem(scheme.header);
    }
    case 'timestamped':
      return headerProblem(scheme.header) ?? toleranceProblem(scheme.toleranceSec);
    case 'standard':
      return toleranceProblem(scheme.toleranceSec);
  }
}

const STANDARD_HEADERS = new Set(['webhook-id', 'webhook-timestamp', 'webhook-signature']);

/**
 * The headers that carried a signature, in arrival order: the ones the current scheme reads, or,
 * with no scheme, any whose name holds `signature` or starts with `webhook-`.
 */
export function signatureHeadersOf(
  headers: readonly (readonly [string, string])[],
  scheme: SignatureSchemeWire | undefined,
): [string, string][] {
  const wanted = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (scheme === undefined) return lower.includes('signature') || lower.startsWith('webhook-');
    return scheme.kind === 'standard' ? STANDARD_HEADERS.has(lower) : lower === scheme.header.toLowerCase();
  };
  return headers.filter(([name]) => wanted(name)).map(([name, value]) => [name, value]);
}

export function verdictText(signature: CaptureSignatureWire | null | undefined): string {
  if (signature === null || signature === undefined) return 'not checked';
  if (signature.verdict === 'verified') return '✓ verified';
  return `✗ ${REASON_TEXT[signature.reason ?? 'key-error']}`;
}
```

Create `apps/desktop/src/renderer/features/webhooks/scheme-fields.tsx`:

```tsx
/** The fields of one signature scheme, shared by the catch URL section and the signing controls. */
import { INPUT_CLASS } from '../team/roles.js';
import type { SignatureSchemeWire } from '../../../shared/wire-types.js';

const LABEL_CLASS = 'mt-2 block text-xs text-fg-subtle';

export function SchemeFields({
  scheme,
  onChange,
  disabled,
  prefix,
}: {
  readonly scheme: SignatureSchemeWire;
  readonly onChange: (next: SignatureSchemeWire) => void;
  readonly disabled: boolean;
  /** Test-id and element-id prefix, e.g. `catch-url-signature`. */
  readonly prefix: string;
}) {
  const tolerance =
    scheme.kind === 'hmac' ? null : (
      <div className="w-32">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-tolerance`}>
          Tolerance (s)
        </label>
        <input
          id={`${prefix}-tolerance`}
          data-testid={`${prefix}-tolerance`}
          inputMode="numeric"
          disabled={disabled}
          value={String(scheme.toleranceSec)}
          onChange={(event) => onChange({ ...scheme, toleranceSec: Number(event.target.value) })}
          className={INPUT_CLASS}
        />
      </div>
    );
  const header =
    scheme.kind === 'standard' ? null : (
      <div className="min-w-0 flex-1">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-header`}>
          Header
        </label>
        <input
          id={`${prefix}-header`}
          data-testid={`${prefix}-header`}
          disabled={disabled}
          value={scheme.header}
          onChange={(event) => onChange({ ...scheme, header: event.target.value })}
          className={INPUT_CLASS}
        />
      </div>
    );
  if (scheme.kind !== 'hmac') {
    return (
      <div className="flex gap-3">
        {header}
        {tolerance}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      <div className="w-28">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-algorithm`}>
          Algorithm
        </label>
        <select
          id={`${prefix}-algorithm`}
          data-testid={`${prefix}-algorithm`}
          disabled={disabled}
          value={scheme.algorithm}
          onChange={(event) => onChange({ ...scheme, algorithm: event.target.value as typeof scheme.algorithm })}
          className={INPUT_CLASS}
        >
          <option value="sha1">SHA-1</option>
          <option value="sha256">SHA-256</option>
          <option value="sha512">SHA-512</option>
        </select>
      </div>
      <div className="w-24">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-encoding`}>
          Encoding
        </label>
        <select
          id={`${prefix}-encoding`}
          data-testid={`${prefix}-encoding`}
          disabled={disabled}
          value={scheme.encoding}
          onChange={(event) => onChange({ ...scheme, encoding: event.target.value as typeof scheme.encoding })}
          className={INPUT_CLASS}
        >
          <option value="hex">hex</option>
          <option value="base64">base64</option>
        </select>
      </div>
      {header}
      <div className="w-28">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-prefix`}>
          Prefix
        </label>
        <input
          id={`${prefix}-prefix`}
          data-testid={`${prefix}-prefix`}
          placeholder="None"
          disabled={disabled}
          value={scheme.prefix ?? ''}
          onChange={(event) => {
            const { prefix: _old, ...rest } = scheme;
            onChange(event.target.value === '' ? rest : { ...rest, prefix: event.target.value });
          }}
          className={INPUT_CLASS}
        />
      </div>
    </div>
  );
}
```

Create `apps/desktop/src/renderer/features/webhooks/catch-url-signature.tsx`:

```tsx
/**
 * A catch URL's *Signature* section (webhook-signatures §4): the scheme, a write-only secret shown
 * only as *● set …f789*, and *Reject unverified requests (401)*. Shown when editing an existing
 * catch URL on a server that has the module; the server refuses signature settings until its key
 * is set, and the section says so rather than letting a save fail.
 */
import { INPUT_CLASS } from '../team/roles.js';
import { Button } from '../../components/button.js';
import { SchemeFields } from './scheme-fields.js';
import { defaultScheme, SCHEME_KINDS, SCHEME_LABELS, schemeProblemOf, SIGNATURE_LIMITS } from './signature-text.js';
import type { SchemeKind } from './signature-text.js';
import type { CatchUrlWire, HooksUpdateRequestWire, SignatureSchemeWire } from '../../../shared/wire-types.js';

export interface SignatureForm {
  /** `null` is *None*. */
  readonly scheme: SignatureSchemeWire | null;
  /** A new secret; empty keeps the stored one. */
  readonly secret: string;
  /** The secret input is open: always when none is stored, after *Replace…* otherwise. */
  readonly replacing: boolean;
  readonly rejectUnverified: boolean;
}

export function signatureFormOf(hook: CatchUrlWire | undefined): SignatureForm {
  const stored = hook?.signature ?? null;
  return {
    scheme: stored?.scheme ?? null,
    secret: '',
    replacing: stored === null,
    rejectUnverified: hook?.rejectUnverified ?? false,
  };
}

export function signatureProblemOf(form: SignatureForm, hook: CatchUrlWire | undefined): string | undefined {
  if (form.scheme === null) return undefined;
  const stored = hook?.signature !== null && hook?.signature !== undefined;
  if (form.secret === '' && !stored) return 'Enter the secret the sender signs with.';
  if (form.secret.length > SIGNATURE_LIMITS.maxSecretLength)
    return `The secret is at most ${String(SIGNATURE_LIMITS.maxSecretLength)} characters.`;
  return schemeProblemOf(form.scheme);
}

const sameScheme = (a: SignatureSchemeWire | null, b: SignatureSchemeWire | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The update fields this section adds, or `{}` when nothing in it changed. */
export function signatureRequestOf(
  form: SignatureForm,
  hook: CatchUrlWire | undefined,
): Pick<HooksUpdateRequestWire, 'signature' | 'rejectUnverified'> {
  const stored = hook?.signature?.scheme ?? null;
  if (form.scheme === null) return stored === null ? {} : { signature: null };
  const out: { signature?: HooksUpdateRequestWire['signature']; rejectUnverified?: boolean } = {};
  if (!sameScheme(form.scheme, stored) || form.secret !== '') {
    out.signature = { scheme: form.scheme, ...(form.secret !== '' ? { secret: form.secret } : {}) };
  }
  if (form.rejectUnverified !== (hook?.rejectUnverified ?? false)) out.rejectUnverified = form.rejectUnverified;
  return out;
}

export function SignatureSection({
  form,
  onChange,
  hook,
  readOnly,
}: {
  readonly form: SignatureForm;
  readonly onChange: (patch: Partial<SignatureForm>) => void;
  readonly hook: CatchUrlWire;
  readonly readOnly: boolean;
}) {
  const unavailable = hook.signatureAvailable === false;
  const disabled = readOnly || unavailable;
  const hint = hook.signature?.secret.hint ?? null;
  return (
    <fieldset data-testid="catch-url-signature" className="mt-4 border-t border-hairline pt-3">
      <legend className="text-sm font-medium text-fg-default">Signature</legend>
      {unavailable && (
        <p data-testid="catch-url-signature-unavailable" className="mt-1 text-xs text-fg-subtle">
          The server has no WIREBENCH_SERVER_HOOKS_SECRET_KEY, so it cannot keep a signature secret. Ask its
          administrator to set one.
        </p>
      )}
      <label className="mt-2 block text-sm text-fg-subtle" htmlFor="catch-url-signature-scheme">
        Scheme
      </label>
      <select
        id="catch-url-signature-scheme"
        data-testid="catch-url-signature-scheme"
        disabled={disabled}
        value={form.scheme?.kind ?? 'none'}
        onChange={(event) =>
          onChange(
            event.target.value === 'none'
              ? { scheme: null, rejectUnverified: false }
              : { scheme: defaultScheme(event.target.value as SchemeKind) },
          )
        }
        className={INPUT_CLASS}
      >
        <option value="none">None</option>
        {SCHEME_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {SCHEME_LABELS[kind]}
          </option>
        ))}
      </select>
      {form.scheme !== null && (
        <>
          <SchemeFields
            scheme={form.scheme}
            onChange={(scheme) => onChange({ scheme })}
            disabled={disabled}
            prefix="catch-url-signature"
          />
          <label className="mt-2 block text-sm text-fg-subtle" htmlFor="catch-url-signature-secret">
            Secret
          </label>
          {form.replacing || hook.signature === null || hook.signature === undefined ? (
            <input
              id="catch-url-signature-secret"
              data-testid="catch-url-signature-secret"
              type="password"
              autoComplete="off"
              disabled={disabled}
              value={form.secret}
              onChange={(event) => onChange({ secret: event.target.value })}
              className={INPUT_CLASS}
            />
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <span data-testid="catch-url-signature-secret-set" className="text-sm text-fg-default">
                {hint === null ? '● set' : `● set …${hint}`}
              </span>
              {!disabled && (
                <Button data-testid="catch-url-signature-replace" onClick={() => onChange({ replacing: true })}>
                  Replace…
                </Button>
              )}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
            <input
              type="checkbox"
              data-testid="catch-url-reject-unverified"
              disabled={disabled}
              checked={form.rejectUnverified}
              onChange={(event) => onChange({ rejectUnverified: event.target.checked })}
            />
            Reject unverified requests (401)
          </label>
        </>
      )}
    </fieldset>
  );
}
```

`apps/desktop/src/renderer/features/webhooks/catch-url-settings-dialog.tsx`:

1. Import `signatureFormOf`, `signatureProblemOf`, `signatureRequestOf`, `SignatureSection`, `type SignatureForm` from `./catch-url-signature.js`.
2. State: `const [signature, setSignature] = useState<SignatureForm>(() => signatureFormOf(undefined));` and `const [hook, setHook] = useState<CatchUrlWire | undefined>(undefined);`. In the opening effect, after `setForm(formOf(hook))`: `setSignature(signatureFormOf(hook)); setHook(hook);`.
3. `const problem = problemOf(form) ?? (hookId === undefined ? undefined : signatureProblemOf(signature, hook));`
4. `editSignature = (patch: Partial<SignatureForm>) => { setSignature((current) => ({ ...current, ...patch })); setRefused(undefined); };`
5. In `save`, the update call becomes `ipc().hooks.update({ ...server, hookId, ...request, ...signatureRequestOf(signature, hook) })`.
6. After the Body `textarea`: `{hookId !== undefined && hook?.signatureAvailable !== undefined && (<SignatureSection form={signature} onChange={editSignature} hook={hook} readOnly={readOnly} />)}`.
7. The header comment gains: *Editing an existing catch URL also shows its Signature section (webhook-signatures §4).*

(The Content's `w-[32rem]` stays; the section wraps inside it. Existing `catch-url-settings-dialog.test.tsx` expectations stay exact: an untouched section adds nothing to the request.)

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run apps/desktop/test/renderer/signature-text.test.ts apps/desktop/test/renderer/catch-url-signature.test.tsx apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): set a catch URL's signature scheme, secret and reject-unverified"
```

---

### Task 13: Renderer — verdicts on captures, and *Save as webhook* drops

**Files:**
- Create: `apps/desktop/src/renderer/features/webhooks/signature-badge.tsx`
- Modify: `apps/desktop/src/renderer/features/webhooks/catch-url-tab.tsx` (row badge; `signatureScheme` to the viewer)
- Modify: `apps/desktop/src/renderer/features/webhooks/capture-viewer.tsx` (Signature group in Details; the rejected banner)
- Modify: `apps/desktop/src/renderer/features/webhook-items/save-as-webhook.ts` (`DROPPED_EXACT`)
- Test: `apps/desktop/test/renderer/capture-signature.test.tsx`

**Interfaces:**
- Consumes: `verdictText`, `REASON_TEXT`, `schemeSummary`, `signatureHeadersOf` (Task 12); `CaptureSummaryWire.signature`/`rejected` (Task 11).
- Produces: `SignatureBadge({ signature, rejected })` — test ids `capture-signature-badge` (`data-verdict="verified" | "failed"`) and `capture-rejected`; `CaptureViewer` prop `signatureScheme?: SignatureSchemeWire`; Details test ids `capture-signature`, `capture-signature-verdict`, banner `capture-rejected-note`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/renderer/capture-signature.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CaptureViewer } from '../../src/renderer/features/webhooks/capture-viewer.js';
import { SignatureBadge } from '../../src/renderer/features/webhooks/signature-badge.js';
import { droppedHeader } from '../../src/renderer/features/webhook-items/save-as-webhook.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const capture = (patch: Partial<CaptureViewWire> = {}): CaptureViewWire => ({
  id: '01J8ZE00000000000000000001',
  receivedAt: '2026-09-29T12:00:01.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 25,
  truncated: false,
  sourceIp: '203.0.113.9',
  query: '',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Signature', 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab'],
  ],
  bodyBase64: btoa('{"event":"order.created"}'),
  contentType: 'application/json',
  text: '{"event":"order.created"}',
  language: 'json',
  ...patch,
});
const HMAC = { kind: 'hmac' as const, algorithm: 'sha256' as const, encoding: 'hex' as const, header: 'X-Signature' };

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => cleanup());

describe('capture verdicts (§4)', () => {
  it('badges a row ✓, ✗ with its reason, a 401 marker, and nothing when not checked', () => {
    const { rerender, container } = render(<SignatureBadge signature={{ verdict: 'verified' }} rejected={false} />);
    expect(screen.getByTestId('capture-signature-badge').dataset['verdict']).toBe('verified');
    expect(screen.getByTestId('capture-signature-badge').textContent).toBe('✓');
    rerender(<SignatureBadge signature={{ verdict: 'failed', reason: 'mismatch' }} rejected />);
    expect(screen.getByTestId('capture-signature-badge').getAttribute('title')).toBe('Signature: digest mismatch');
    expect(screen.getByTestId('capture-rejected').textContent).toBe('401');
    rerender(<SignatureBadge signature={undefined} rejected={false} />);
    expect(container.textContent).toBe('');
  });

  it('shows the verdict, the scheme and the signature headers in Details, and the rejection banner', () => {
    render(
      <TooltipPrimitive.Provider>
        <CaptureViewer
          capture={capture({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true })}
          signatureScheme={HMAC}
        />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByTestId('capture-rejected-note').textContent).toBe('Answered 401 (rejected: unverified)');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByTestId('capture-signature-verdict').textContent).toContain('✗ digest mismatch');
    const block = screen.getByTestId('capture-signature').textContent ?? '';
    expect(block).toContain('HMAC of body · SHA-256 · hex · X-Signature');
    expect(block).toContain('X-Signature');
    expect(block).not.toContain('Content-Type');
  });

  it('leaves Details as it was for an unchecked capture', () => {
    render(
      <TooltipPrimitive.Provider>
        <CaptureViewer capture={capture()} />
      </TooltipPrimitive.Provider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.queryByTestId('capture-signature')).toBeNull();
    expect(screen.queryByTestId('capture-rejected-note')).toBeNull();
  });

  it('drops the Standard Webhooks headers when saving a capture as a webhook', () => {
    for (const name of ['webhook-id', 'Webhook-Timestamp', 'webhook-signature', 'X-Signature']) {
      expect(droppedHeader(name)).toBe(true);
    }
    expect(droppedHeader('webhook-event')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run apps/desktop/test/renderer/capture-signature.test.tsx`
Expected: FAIL — `signature-badge.js` does not exist.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/features/webhooks/signature-badge.tsx`:

```tsx
/** A capture row's verdict (webhook-signatures §4): ✓, ✗ with the reason on hover, and *401*. */
import { REASON_TEXT } from './signature-text.js';
import type { CaptureSignatureWire } from '../../../shared/wire-types.js';

export function SignatureBadge({
  signature,
  rejected,
}: {
  readonly signature: CaptureSignatureWire | null | undefined;
  readonly rejected: boolean | undefined;
}) {
  if (signature === null || signature === undefined) return null;
  const verified = signature.verdict === 'verified';
  return (
    <>
      <span
        data-testid="capture-signature-badge"
        data-verdict={signature.verdict}
        title={verified ? 'Signature verified' : `Signature: ${REASON_TEXT[signature.reason ?? 'key-error']}`}
        className={`shrink-0 font-medium ${verified ? 'text-status-success' : 'text-status-danger'}`}
      >
        {verified ? '✓' : '✗'}
      </span>
      {rejected === true && (
        <span
          data-testid="capture-rejected"
          title="Answered 401 (rejected: unverified)"
          className="shrink-0 rounded bg-surface-sunken px-1 font-mono text-status-danger"
        >
          401
        </span>
      )}
    </>
  );
}
```

`catch-url-tab.tsx` — import `SignatureBadge`; in the row button, before the time span: `<SignatureBadge signature={capture.signature} rejected={capture.rejected} />`. Pass `signatureScheme={hook?.signature?.scheme}` to `CaptureViewer` (spread only when defined, for `exactOptionalPropertyTypes`: `{...(hook?.signature?.scheme !== undefined ? { signatureScheme: hook.signature.scheme } : {})}`).

`capture-viewer.tsx`:

1. Import `schemeSummary`, `signatureHeadersOf`, `verdictText` from `./signature-text.js` and `SignatureSchemeWire` (type).
2. `CaptureDetails` takes `signatureScheme?: SignatureSchemeWire` and, after the Request group:

```tsx
      {capture.signature !== undefined && capture.signature !== null && (
        <div data-testid="capture-signature" className="mt-3">
          <SettingsGroup title="Signature">
            <ReadOnlySetting
              label="Verdict"
              testId="capture-signature-verdict"
              value={verdictText(capture.signature)}
            />
            <ReadOnlySetting
              label="Scheme"
              value={signatureScheme === undefined ? '—' : schemeSummary(signatureScheme)}
            />
            {signatureHeadersOf(capture.headers, signatureScheme).map(([name, value], index) => (
              <ReadOnlySetting key={`${name}:${String(index)}`} label={name} value={value} />
            ))}
          </SettingsGroup>
        </div>
      )}
```

(The scheme shown is the catch URL's current one: the capture stores its verdict, not the scheme it was checked under — noted in the component comment.)

3. `CaptureViewer` takes `readonly signatureScheme?: SignatureSchemeWire;`, passes it to `CaptureDetails`, and after the truncated notice:

```tsx
      {capture.rejected === true && (
        <p
          role="status"
          data-testid="capture-rejected-note"
          className="shrink-0 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-status-danger"
        >
          Answered 401 (rejected: unverified)
        </p>
      )}
```

`save-as-webhook.ts` — add `'webhook-id'` and `'webhook-timestamp'` to `DROPPED_EXACT` (the comment above `droppedHeader` becomes *…transport, proxy, forwarding and signature headers, Standard Webhooks' id and timestamp included: a replay signs afresh.*). `webhook-signature` is already dropped by the `signature` substring.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run apps/desktop/test/renderer/capture-signature.test.tsx apps/desktop/test/renderer/capture-viewer.test.tsx apps/desktop/test/renderer/catch-url-tab.test.tsx apps/desktop/test/renderer/save-as-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): show each capture's signature verdict and 401 rejections"
```

---

### Task 14: Renderer — signing controls in *Webhooks settings* and the **Signing** tab

**Files:**
- Create: `apps/desktop/src/renderer/features/webhook-items/signing.ts`
- Create: `apps/desktop/src/renderer/features/webhook-items/signing-fields.tsx`
- Create: `apps/desktop/src/renderer/features/rest-editor/signing-tab.tsx`
- Modify: `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx` (`TABS`, the tab body)
- Modify: `apps/desktop/src/renderer/features/webhook-items/webhook-settings-dialog.tsx`
- Modify: `apps/desktop/src/renderer/state/project.ts` (`setWebhookFolderSigning`, `layerRestEdits`)
- Test: `apps/desktop/test/renderer/webhook-signing-controls.test.tsx`

**Interfaces:**
- Consumes (types only): `WebhookSigningWire`, `RestFolderWire`, `WebhookCollectionWire`; `SchemeFields`, `defaultScheme`, `SCHEME_KINDS`, `SCHEME_LABELS`, `schemeSummary` (Task 12); `SecretField` (`components/secret-field.tsx`).
- Produces:
  - `inheritedSigningOf(folders, parentId, collection): InheritedSigning` (`{ signing, from: 'folder' | 'collection' | 'default', fromName? }`), `ciNameOf(name)`, `signingSummary(inherited)`.
  - `SigningFields({ value, onChange, inherit, nodeName, disabled?, registerFlush? })` — test ids `signing-mode`, `signing-ci-name`; the secret is a `SecretField` labelled *Signing secret*.
  - `SigningTab({ request, inherited, onChange })` — test ids `rest-signing`, `rest-signing-source`.
  - Store: `setWebhookFolderSigning(projectId, folderId, signing | null)`; `layerRestEdits` lays `signing` (and `null`) over the request.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/renderer/webhook-signing-controls.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SigningTab } from '../../src/renderer/features/rest-editor/signing-tab.js';
import { ciNameOf, inheritedSigningOf, signingSummary } from '../../src/renderer/features/webhook-items/signing.js';
import { layerRestEdits } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';
import type { WebhookSigningWire } from '../../src/shared/wire-types.js';

const HMAC: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};

afterEach(() => cleanup());

describe('signing helpers (§5.2)', () => {
  it('finds what an item inherits: nearest folder, then the collection, then none', () => {
    const folders = {
      g1: restFolderWire({ id: 'g1', name: 'Orders', signing: HMAC }),
      g2: restFolderWire({ id: 'g2', name: 'Refunds', parentId: 'g1' }),
    };
    expect(inheritedSigningOf(folders, 'g2', { signing: { mode: 'none' } })).toEqual({
      signing: HMAC,
      from: 'folder',
      fromName: 'Orders',
    });
    expect(inheritedSigningOf({}, undefined, { signing: HMAC })).toEqual({ signing: HMAC, from: 'collection' });
    expect(inheritedSigningOf({}, undefined, {})).toEqual({ signing: { mode: 'none' }, from: 'default' });
    expect(signingSummary({ signing: HMAC, from: 'folder', fromName: 'Orders' })).toBe(
      'Inherits HMAC of body · SHA-256 · hex · X-Signature from the folder “Orders”',
    );
    expect(signingSummary({ signing: { mode: 'none' }, from: 'default' })).toBe('Inherits None (nothing above sets signing)');
  });

  it('pre-fills the CI name from the node name in upper snake case', () => {
    expect(ciNameOf('Order paid')).toBe('ORDER_PAID');
    expect(ciNameOf('  refund.v2 — sent ')).toBe('REFUND_V2_SENT');
    expect(ciNameOf('2fa code')).toBe('WEBHOOK_2FA_CODE');
    expect(ciNameOf('')).toBe('WEBHOOK');
  });

  it('lays a staged signing over the request, and null back to inherit', () => {
    const request = restRequestWire({ id: 'w1', signing: HMAC });
    expect(layerRestEdits(request, { signing: { mode: 'none' } }).signing).toEqual({ mode: 'none' });
    expect(layerRestEdits(request, { signing: null })).not.toHaveProperty('signing');
  });
});

describe('the Signing tab (§5.2)', () => {
  it('shows where the inherited signing comes from, and stages a scheme with a CI name', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid' })}
        inherited={{ signing: HMAC, from: 'collection' }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('rest-signing-source').textContent).toBe(
      'Inherits HMAC of body · SHA-256 · hex · X-Signature from the Webhooks collection',
    );
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'standard' } });
    expect(onChange).toHaveBeenLastCalledWith({
      signing: { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'ORDER_PAID' },
    });
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ signing: { mode: 'none' } });
    fireEvent.change(screen.getByTestId('signing-mode'), { target: { value: 'inherit' } });
    expect(onChange).toHaveBeenLastCalledWith({ signing: null });
  });

  it('shows the item’s own scheme with its secret and CI name', () => {
    installWirebenchApi();
    render(
      <SigningTab
        request={restRequestWire({ id: 'w1', name: 'Order paid', signing: HMAC })}
        inherited={{ signing: { mode: 'none' }, from: 'default' }}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByTestId('signing-mode') as HTMLSelectElement).value).toBe('hmac');
    expect((screen.getByTestId('signing-ci-name') as HTMLInputElement).value).toBe('ORDERS_SIGNING');
    expect(screen.getByText('Signing secret')).toBeTruthy();
  });
});
```

(Add a *webhook-settings-dialog* case to `apps/desktop/test/renderer/webhook-settings-dialog.test.tsx` in the same style as its target cases: choosing *None* in the collection's `signing-mode` and saving calls `updateWebhooks('p1', { target, signing: { mode: 'none' } })`; for a folder, it calls `setWebhookFolderSigning('p1', 'g1', { mode: 'none' })`. The existing exact `updateWebhooks('p1', { target })` expectation stays: signing is added only when touched.)

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run apps/desktop/test/renderer/webhook-signing-controls.test.tsx`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/features/webhook-items/signing.ts`:

```ts
/**
 * What a webhook node inherits for signing, and the CI name it is offered (webhook-signatures §5).
 * The engine's `signingAlong`, restated for the renderer's flat folder map.
 */
import { folderChainOf } from '../../state/project.js';
import { schemeSummary } from '../webhooks/signature-text.js';
import type { RestFolderWire, WebhookCollectionWire, WebhookSigningWire } from '../../../shared/wire-types.js';

export interface InheritedSigning {
  readonly signing: WebhookSigningWire;
  readonly from: 'folder' | 'collection' | 'default';
  readonly fromName?: string;
}

/** The nearest ancestor folder's own signing, else the collection's, else none. */
export function inheritedSigningOf(
  folders: Readonly<Record<string, RestFolderWire>>,
  parentId: string | undefined,
  collection: Pick<WebhookCollectionWire, 'signing'> | undefined,
): InheritedSigning {
  const chain = folderChainOf(folders, parentId);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const folder = chain[index];
    if (folder?.signing !== undefined) return { signing: folder.signing, from: 'folder', fromName: folder.name };
  }
  return collection?.signing !== undefined
    ? { signing: collection.signing, from: 'collection' }
    : { signing: { mode: 'none' }, from: 'default' };
}

/** `Inherits HMAC of body · … from the folder “Orders”`. */
export function signingSummary(inherited: InheritedSigning): string {
  if (inherited.from === 'default') return 'Inherits None (nothing above sets signing)';
  const what = inherited.signing.mode === 'none' ? 'None' : schemeSummary(inherited.signing.scheme);
  const where = inherited.from === 'folder' ? `the folder “${inherited.fromName ?? ''}”` : 'the Webhooks collection';
  return `Inherits ${what} from ${where}`;
}

/**
 * A CI name from a node's name: upper snake case (`Order paid` → `ORDER_PAID`), `WEBHOOK_` in front
 * when it would start with a digit, `WEBHOOK` when nothing is left — the project file's `envName`
 * rule, `^[A-Z][A-Z0-9_]*$`.
 */
export function ciNameOf(name: string): string {
  const snake = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (snake === '') return 'WEBHOOK';
  return /^[A-Z]/.test(snake) ? snake : `WEBHOOK_${snake}`;
}
```

Create `apps/desktop/src/renderer/features/webhook-items/signing-fields.tsx`:

```tsx
/**
 * The signing controls (webhook-signatures §5.2): *Inherit* (when the node can inherit), *None*,
 * or a scheme with its fields, a keychain secret, and the CI name a pipeline supplies it under.
 */
import { SecretField } from '../../components/secret-field.js';
import { INPUT_CLASS } from '../team/roles.js';
import { SchemeFields } from '../webhooks/scheme-fields.js';
import { defaultScheme, SCHEME_KINDS, SCHEME_LABELS } from '../webhooks/signature-text.js';
import type { SchemeKind } from '../webhooks/signature-text.js';
import { ciNameOf } from './signing.js';
import type { WebhookSigningWire } from '../../../shared/wire-types.js';

const LABEL_CLASS = 'mt-2 block text-sm text-fg-subtle';

export function SigningFields({
  value,
  onChange,
  inherit,
  nodeName,
  disabled = false,
  registerFlush,
}: {
  /** The node's own signing; `undefined` is *Inherit*. */
  readonly value: WebhookSigningWire | undefined;
  /** `undefined` chooses *Inherit* (offered only when `inherit` is true). */
  readonly onChange: (next: WebhookSigningWire | undefined) => void;
  readonly inherit: boolean;
  /** Pre-fills the CI name. */
  readonly nodeName: string;
  readonly disabled?: boolean;
  readonly registerFlush?: (flush: (() => Promise<string | undefined>) | undefined) => void;
}) {
  const mode = value === undefined ? 'inherit' : value.mode === 'none' ? 'none' : value.scheme.kind;
  const choose = (next: string): void => {
    if (next === 'inherit') return onChange(undefined);
    if (next === 'none') return onChange({ mode: 'none' });
    const kind = next as SchemeKind;
    const kept = value?.mode === 'sign' ? value : undefined;
    onChange({
      mode: 'sign',
      scheme: kept?.scheme.kind === kind ? kept.scheme : defaultScheme(kind),
      ...(kept?.secretRef !== undefined ? { secretRef: kept.secretRef } : {}),
      secretEnv: kept?.secretEnv ?? ciNameOf(nodeName),
    });
  };
  return (
    <div data-testid="signing-fields">
      <label className={LABEL_CLASS} htmlFor="signing-mode">
        Signing
      </label>
      <select
        id="signing-mode"
        data-testid="signing-mode"
        disabled={disabled}
        value={mode}
        onChange={(event) => choose(event.target.value)}
        className={INPUT_CLASS}
      >
        {inherit && <option value="inherit">Inherit</option>}
        <option value="none">None</option>
        {SCHEME_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {SCHEME_LABELS[kind]}
          </option>
        ))}
      </select>
      {value?.mode === 'sign' && (
        <>
          <SchemeFields
            scheme={value.scheme}
            onChange={(scheme) => onChange({ ...value, scheme })}
            disabled={disabled}
            prefix="signing"
          />
          <div className="mt-2">
            <SecretField
              label="Signing secret"
              value={value.secretRef}
              disabled={disabled}
              {...(registerFlush !== undefined ? { registerFlush } : {})}
              onChange={(ref) => {
                const { secretRef: _old, ...rest } = value;
                onChange(ref === undefined ? rest : { ...rest, secretRef: ref });
              }}
            />
          </div>
          <label className={LABEL_CLASS} htmlFor="signing-ci-name">
            CI name (WIREBENCH_SECRET_…)
          </label>
          <input
            id="signing-ci-name"
            data-testid="signing-ci-name"
            disabled={disabled}
            value={value.secretEnv ?? ''}
            onChange={(event) => {
              const { secretEnv: _old, ...rest } = value;
              const next = event.target.value.toUpperCase();
              onChange(next === '' ? rest : { ...rest, secretEnv: next });
            }}
            className={`${INPUT_CLASS} font-mono`}
          />
        </>
      )}
    </div>
  );
}
```

Create `apps/desktop/src/renderer/features/rest-editor/signing-tab.tsx`:

```tsx
/** A webhook item's **Signing** tab (webhook-signatures §5.2); ordinary REST requests have none. */
import { SigningFields } from '../webhook-items/signing-fields.js';
import { signingSummary } from '../webhook-items/signing.js';
import type { InheritedSigning } from '../webhook-items/signing.js';
import type { RestRequestPatchWire, RestRequestWire } from '../../../shared/wire-types.js';

export function SigningTab({
  request,
  inherited,
  onChange,
}: {
  readonly request: RestRequestWire;
  readonly inherited: InheritedSigning;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}) {
  return (
    <div data-testid="rest-signing" className="overflow-auto p-3">
      {request.signing === undefined && (
        <p data-testid="rest-signing-source" className="text-sm text-fg-subtle">
          {signingSummary(inherited)}
        </p>
      )}
      <SigningFields
        value={request.signing}
        inherit
        nodeName={request.name}
        onChange={(signing) => onChange({ signing: signing ?? null })}
      />
    </div>
  );
}
```

`rest-editor.tsx`:
- `TABS` gains `{ id: 'signing', label: 'Signing' },` after `auth`.
- The `items` passed to `Tabs` filter it for non-webhook requests: `TABS.filter((item) => item.id !== 'signing' || isWebhookItem).map(…)`; and `const shownTab = tab === 'signing' && !isWebhookItem ? 'params' : tab;` is used for `active` and the body switches.
- After the Auth tab body:

```tsx
        {shownTab === 'signing' && isWebhookItem && (
          <SigningTab
            request={request}
            inherited={inheritedSigningOf(folders, request.folderId, webhookCollection)}
            onChange={stage}
          />
        )}
```

(`folders` is the folder map the editor already selects for its chain; import `SigningTab` and `inheritedSigningOf`.)

`webhook-settings-dialog.tsx`:
- State: `const [signing, setSigning] = useState<WebhookSigningWire | undefined>(undefined); const [signingTouched, setSigningTouched] = useState(false);` and a `signingFlush` ref like `authFlush` (`registerSigningFlush` with `SecretField`'s flush type).
- The opening effect sets `setSigning(settings.folderId === undefined ? collection?.signing : openedFolder?.signing); setSigningTouched(false);`.
- In `save`:

```ts
    const flushedRef = await signingFlush.current?.();
    const signingNow =
      signing?.mode === 'sign' && flushedRef !== undefined && flushedRef !== signing.secretRef
        ? { ...signing, secretRef: flushedRef }
        : signing;
    const signingChanged = signingTouched || signingNow !== signing;
```

  For a folder: after the target call, `if (signingChanged) await useProjectStore.getState().setWebhookFolderSigning(projectId, folderId, signingNow ?? null);`. For the collection: `if (signingChanged) patch.signing = signingNow ?? null;` (the patch type gains `signing?: WebhookSigningWire | null`).
- After the target row (and after `AuthFields` for the collection):

```tsx
            <div className="mt-4 border-t border-hairline pt-3">
              {isFolder && signing === undefined && (
                <p data-testid="webhook-settings-signing-source" className="text-xs text-fg-subtle">
                  {signingSummary(inheritedSigningOf(foldersMap, folder?.parentId, collection))}
                </p>
              )}
              <SigningFields
                value={signing}
                inherit={isFolder}
                nodeName={isFolder ? (folder?.name ?? '') : 'Webhooks'}
                registerFlush={registerSigningFlush}
                onChange={(next) => {
                  setSigning(next);
                  setSigningTouched(true);
                }}
              />
            </div>
```

  The collection offers *None* and the schemes (no *Inherit*: nothing is above it; `undefined` there shows as *None*, so the select's value falls back to `none` — handle with `value={signing ?? (isFolder ? undefined : { mode: 'none' })}` and treat choosing *None* on an unset collection as touched). The description line gains *…and how it signs.* The folder title stays *Target for “…”* (renaming it is not this module's call).

`state/project.ts`:
- `ProjectState` gains `readonly setWebhookFolderSigning: (projectId: string, folderId: string, signing: WebhookSigningWire | null) => Promise<void>;` implemented beside `setWebhookFolderTarget`:

```ts
    setWebhookFolderSigning: async (projectId, folderId, signing) => {
      await mutate(projectId, { kind: 'set-webhook-folder-signing', folderId, signing });
    },
```

- `layerRestEdits` ends with:

```ts
  const layered: RestRequestWire = {
    ...request,
    // …the existing spreads…
    ...(draftPatch.signing !== undefined && draftPatch.signing !== null ? { signing: draftPatch.signing } : {}),
  };
  if (draftPatch.signing !== null) return layered;
  const { signing: _inherit, ...rest } = layered;
  return rest;
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run apps/desktop/test/renderer/webhook-signing-controls.test.tsx apps/desktop/test/renderer/webhook-settings-dialog.test.tsx apps/desktop/test/renderer`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): signing controls in Webhooks settings and a Signing tab for webhook items"
```

---

### Task 15: CLI — name the variable for a missing signing secret, and prove the signature on the wire

**Files:**
- Modify: `packages/engine/src/secrets/env-names.ts` (`SIGNING_PSEUDO_REF_PREFIX`, `envVariablesFor`)
- Modify: `packages/engine/src/webhooks/model.ts` (`signingSecretRef` uses the prefix; `signingSecretMissing(effective, ref?)`)
- Modify: `packages/engine/src/run/prepare.ts` (`signFor` passes the ref)
- Modify: `packages/cli/src/commands/run.ts` (`explainMissingSecret`)
- Test: `packages/engine/test/unit/secrets/env-names-signing.test.ts`, `packages/cli/test/unit/explain-missing-secret.test.ts` (one case), `packages/cli/test/integration/webhook-signing.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
  - `SIGNING_PSEUDO_REF_PREFIX = 'webhook-signing:'`; `envVariablesFor({ ref: 'webhook-signing:X', envName: 'X' })` → `['WIREBENCH_SECRET_X']` only.
  - `signingSecretMissing(effective, ref?)` puts `ref` in `details` when given.
  - `explainMissingSecret` rewrites `webhook-signing-secret` like `secret-missing`: `Set WIREBENCH_SECRET_<secretEnv> … to run "<path>".`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/secrets/env-names-signing.test.ts
import { describe, expect, it } from 'vitest';
import { envVariablesFor, SIGNING_PSEUDO_REF_PREFIX } from '../../../src/secrets/env-names.js';
import { effectiveSigning, signingSecretMissing, signingSecretRef } from '../../../src/webhooks/model.js';
import { createRestRequest, createWebhookCollection } from '../../../src/index.js';

describe('the CI variable for a signing secret (§5.2)', () => {
  it('reads only WIREBENCH_SECRET_<secretEnv> for a CI-only secret', () => {
    const ref = signingSecretRef({ mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'HOOKS_SIGNING' });
    expect(ref).toBe(`${SIGNING_PSEUDO_REF_PREFIX}HOOKS_SIGNING`);
    expect(envVariablesFor({ ref: ref!, envName: 'HOOKS_SIGNING' })).toEqual(['WIREBENCH_SECRET_HOOKS_SIGNING']);
    expect(envVariablesFor({ ref: 'ref-hooks', envName: 'HOOKS_SIGNING' })).toEqual([
      'WIREBENCH_SECRET_HOOKS_SIGNING',
      'WIREBENCH_SECRET_REF_HOOKS',
    ]);
  });

  it('carries the ref on the refusal, for the CLI to name the variable', () => {
    const collection = createWebhookCollection({
      signing: { mode: 'sign', scheme: { kind: 'standard', toleranceSec: 300 }, secretEnv: 'HOOKS_SIGNING' },
      requests: [createRestRequest('Ping', { id: 'w1' })],
    });
    const error = signingSecretMissing(effectiveSigning(collection, 'w1'), 'webhook-signing:HOOKS_SIGNING');
    expect(error.details).toEqual({ from: 'collection', ref: 'webhook-signing:HOOKS_SIGNING' });
  });
});
```

Add to `packages/cli/test/unit/explain-missing-secret.test.ts`:

```ts
  it('rewrites a missing webhook signing secret to its CI variable', () => {
    const raw = errored({
      code: 'webhook-signing-secret',
      message: 'Signing is set on the Webhooks collection but its secret is not set',
      details: { from: 'collection', ref: 'webhook-signing:HOOKS_SIGNING' },
    });
    const needs = [
      { ref: 'webhook-signing:HOOKS_SIGNING', envName: 'HOOKS_SIGNING', purpose: 'webhook signing secret (the Webhooks collection)' },
    ];
    expect(explainMissingSecret(raw, needs).error?.message).toBe(
      'Set WIREBENCH_SECRET_HOOKS_SIGNING to run "Echo/Echo/Secured hello".',
    );
  });
```

```ts
// packages/cli/test/integration/webhook-signing.test.ts
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProject, createRestRequest, createWebhookCollection, saveProject } from '@wirebench/engine';
import { runCli } from './helpers.js';

const BODY = '{"event":"order.created"}';
/** HMAC-SHA256 hex of BODY under abc123def456ghi789 (the plan's known-answer table). */
const EXPECTED = 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab';

let dir: string;
let receiverUrl: string;
let close: () => Promise<void>;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-signing-'));
  await saveProject(
    {
      ...createProject('Hooks', { id: 'p1' }),
      webhooks: createWebhookCollection({
        target: receiverUrl,
        signing: {
          mode: 'sign',
          scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
          secretEnv: 'HOOKS_SIGNING',
        },
        requests: [
          createRestRequest('Ping', {
            id: 'w1',
            slug: 'ping',
            method: 'POST',
            url: '/ping',
            body: { kind: 'raw', language: 'json', text: BODY },
          }),
        ],
      }),
    },
    dir,
  );
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  received.length = 0;
});

describe('wirebench run signs webhook items (§5.2)', () => {
  it('signs the bytes it sends with the secret from WIREBENCH_SECRET_<secretEnv>', async () => {
    const { code, stdout } = await runCli(['run', dir, 'Webhooks/Ping'], {
      WIREBENCH_SECRET_HOOKS_SIGNING: 'abc123def456ghi789',
    });
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe(BODY);
    expect(received[0]?.headers['x-signature']).toBe(EXPECTED);
    expect(stdout).not.toContain('abc123def456ghi789');
  });

  it('exits 3 naming the variable, and sends nothing, without the secret', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Webhooks/Ping'], {});
    expect(code).toBe(3);
    expect(stdout + stderr).toContain('Set WIREBENCH_SECRET_HOOKS_SIGNING to run "Webhooks/Ping".');
    expect(received).toHaveLength(0);
  });
});
```

(`createRestRequest`'s `body` input shape is the engine's `RestBody`; if the raw arm requires `contentType`, add `contentType: 'application/json'` — the expected digest depends only on the text.)

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run packages/engine/test/unit/secrets/env-names-signing.test.ts packages/cli/test/unit/explain-missing-secret.test.ts && nice pnpm --filter @wirebench/cli build && nice pnpm vitest run packages/cli/test/integration/webhook-signing.test.ts`
Expected: FAIL — `SIGNING_PSEUDO_REF_PREFIX` is not exported; the CLI prints the engine's sentence rather than the variable.

- [ ] **Step 3: Implement**

`packages/engine/src/secrets/env-names.ts`:

```ts
/**
 * The pseudo-ref a webhook signing secret is asked for when its node names only a CI variable
 * (webhook-signatures §5.2): `webhook-signing:<secretEnv>`. Like a `${secret:name}` token's, its
 * name is already stable, so only `WIREBENCH_SECRET_<secretEnv>` is read.
 */
export const SIGNING_PSEUDO_REF_PREFIX = 'webhook-signing:';
```

and at the top of `envVariablesFor`:

```ts
  if (secret.ref.startsWith(SIGNING_PSEUDO_REF_PREFIX)) {
    return [`${SECRET_ENV_PREFIX}${secret.envName ?? secret.ref.slice(SIGNING_PSEUDO_REF_PREFIX.length)}`];
  }
```

Export `SIGNING_PSEUDO_REF_PREFIX` from `packages/engine/src/index.ts` beside `envVariablesFor`.

`packages/engine/src/webhooks/model.ts` — `signingSecretRef` returns `` `${SIGNING_PSEUDO_REF_PREFIX}${signing.secretEnv}` `` (import from `../secrets/env-names.js`); `signingSecretMissing` becomes:

```ts
export function signingSecretMissing(effective: EffectiveSigning, ref?: string): WirebenchError {
  return new WirebenchError(
    'webhook-signing-secret',
    `Signing is set on ${signingSourceLabel(effective)} but its secret is not set`,
    {
      details: {
        from: effective.from,
        ...(effective.fromName !== undefined ? { fromName: effective.fromName } : {}),
        // The CLI names the variable to set from this (`explainMissingSecret`).
        ...(ref !== undefined ? { ref } : {}),
      },
    },
  );
}
```

`packages/engine/src/run/prepare.ts` — in `signFor`: `throw signingSecretMissing(effective, ref);`.

`packages/cli/src/commands/run.ts` — in `explainMissingSecret`:

```ts
const EXPLAINED_CODES: ReadonlySet<string> = new Set(['secret-missing', 'webhook-signing-secret']);
…
  const ref = EXPLAINED_CODES.has(result.error?.code ?? '') ? result.error?.details?.['ref'] : undefined;
```

and extend its doc comment: *…and a webhook item's signing secret (`webhook-signing-secret`, webhook-signatures §5.2).*

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run packages/engine/test/unit/secrets packages/engine/test/unit/run packages/cli/test/unit && nice pnpm --filter @wirebench/cli build && nice pnpm vitest run packages/cli/test/integration/webhook-signing.test.ts packages/cli/test/integration/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine packages/cli
git commit -m "feat(cli): sign webhook items in wirebench run and name the missing CI variable"
```

---

### Task 16: e2e — sign, verify ✓, change the secret, see ✗ *digest mismatch* (CI only)

**Files:**
- Modify: `e2e/helpers/fake-server.ts` (catch URL `PATCH`; signature fields; verification on receipt)
- Create: `e2e/specs/webhook-signatures.spec.ts`

**Interfaces:**
- Consumes: `verifyWebhook`, `signatureSchemeSchema`, `toSignatureScheme` (Task 1, from `@wirebench/engine`, which the fake server already imports); every renderer test id from Tasks 12–14.
- Produces: the fake server's `PATCH /workspaces/:id/hooks/:hookId` for `name`, `enabled`, `response`, `signature`, `rejectUnverified`; `signatureAvailable: true` on every catch URL; captures carry `signature` and `rejected` (the fake stores the secret in memory, plainly: it is a test double of the API, not of the storage).

- [ ] **Step 1: Extend the fake server**

In `e2e/helpers/fake-server.ts`:

1. Import `signatureSchemeSchema`, `toSignatureScheme`, `verifyWebhook`, and the types `SignatureScheme`, `SignatureVerdict` from `@wirebench/engine`.
2. `FakeCapture` gains `readonly signature: SignatureVerdict | null; readonly rejected: boolean;`. `FakeCatchUrl` gains `signature: { scheme: SignatureScheme; secret: string } | null; rejectUnverified: boolean;` and its `name`, `enabled`, `response` lose `readonly` (the `PATCH` below edits them in place).
3. The `POST` handler's new hook gets `signature: null, rejectUnverified: false`.
4. `toCatchUrl` adds:

```ts
    signature:
      hook.signature === null
        ? null
        : { scheme: hook.signature.scheme, secret: { set: true, hint: hook.signature.secret.length >= 8 ? hook.signature.secret.slice(-4) : null } },
    rejectUnverified: hook.rejectUnverified,
    signatureAvailable: true,
```

5. `toSummary` adds `signature: capture.signature, rejected: capture.rejected,`.
6. After the `hook === undefined` 404 and before the captures routes:

```ts
    if (sub === undefined && method === 'PATCH') {
      if (role === 'viewer') return problem(response, 403, 'teams-forbidden');
      const body = (await readJson(request)) as {
        name?: string;
        enabled?: boolean;
        response?: Partial<FakeCatchUrl['response']>;
        signature?: { scheme: unknown; secret?: string } | null;
        rejectUnverified?: boolean;
      };
      if (body.name !== undefined) hook.name = body.name.trim();
      if (body.enabled !== undefined) hook.enabled = body.enabled;
      if (body.response !== undefined) hook.response = { ...hook.response, ...body.response };
      if (body.signature === null) {
        hook.signature = null;
        hook.rejectUnverified = false;
      } else if (body.signature !== undefined) {
        const scheme = toSignatureScheme(signatureSchemeSchema.parse(body.signature.scheme));
        const secret = body.signature.secret ?? hook.signature?.secret;
        if (secret === undefined) return problem(response, 400, 'hooks-signature-secret-required');
        hook.signature = { scheme, secret };
      }
      if (body.rejectUnverified !== undefined) {
        if (body.rejectUnverified && hook.signature === null) return problem(response, 400, 'invalid-request');
        hook.rejectUnverified = body.rejectUnverified;
      }
      liveSendTo(subscribersOf(ws.id), { type: 'hooks', workspaceId: ws.id });
      return send(response, 200, toCatchUrl(hook));
    }
```

7. In `catchPublic`, after building `headers`:

```ts
    const signature =
      hook.signature === null ? null : verifyWebhook(hook.signature.scheme, hook.signature.secret, headers, body);
    const rejected = hook.rejectUnverified && signature !== null && signature.verdict !== 'verified';
```

   add `signature, rejected` to the capture, and after the `liveSendTo(…)`: `if (rejected) { response.writeHead(401, { 'content-length': '0' }); response.end(); return; }`.

(Update the block comment: *…enough of the management API for `server-webhooks.spec.ts` and `webhook-signatures.spec.ts`…*.)

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/webhook-signatures.spec.ts
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { chooseContextMenuItem, responseStatus, sendRest } from '../helpers/rest.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
const LIVE_TIMEOUT = 5_000;
const SECRET = 'abc123def456ghi789';
const OTHER_SECRET = 'zzz999yyy888xxx777';

/** Types a value into a SecretField that is not yet in edit mode, and commits it with Enter. */
async function enterSecret(scope: Locator, button: 'Set…' | 'Replace…', value: string): Promise<void> {
  await scope.getByRole('button', { name: button }).click();
  const input = scope.locator('input[type="password"]');
  await input.fill(value);
  await input.press('Enter');
}

async function newestCapture(page: Page, count: number): Promise<Locator> {
  const rows = page.getByTestId('catch-url-tab').getByTestId('capture-row');
  await expect(rows).toHaveCount(count, { timeout: LIVE_TIMEOUT });
  return rows.first();
}

test.describe('webhook signatures', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const server = fake;
    fake = undefined;
    try {
      await current.dispose();
    } finally {
      await server?.close();
    }
  });

  test('a signed webhook verifies at the catch URL; a changed secret fails as a digest mismatch', async () => {
    test.setTimeout(180_000);
    fake = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      hooks: true,
    });
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, fake.url, ALICE);
    await createWorkspace(page);
    await createProject(page, 'Demo');
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    const root = page.getByTestId('webhooks-row');
    await expect(root).toBeVisible({ timeout: SYNC_TIMEOUT });

    // --- 1. A catch URL "Signed" with HMAC of body and the secret --------------------------------
    await chooseContextMenuItem(page, root, 'New catch URL…');
    const catchDialog = page.getByTestId('catch-url-settings');
    await catchDialog.getByTestId('catch-url-name').fill('Signed');
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();
    const catchRow = page.getByTestId('catch-url-row').filter({ hasText: 'Signed' });
    await expect(catchRow).toBeVisible();
    await chooseContextMenuItem(page, catchRow, 'Settings…');
    await expect(catchDialog.getByTestId('catch-url-signature')).toBeVisible();
    await catchDialog.getByTestId('catch-url-signature-scheme').selectOption('hmac');
    await catchDialog.getByTestId('catch-url-signature-secret').fill(SECRET);
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();

    // --- 2. A webhook item aimed at it, signing with the same scheme and secret -----------------
    await chooseContextMenuItem(page, page.getByTestId('explorer-project-row'), 'New Webhook');
    const editor = page.getByTestId('rest-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const collectionRow = page.getByTestId('webhook-collection-row');
    await chooseContextMenuItem(page, collectionRow, 'Settings…');
    const settings = page.getByTestId('webhook-settings');
    await settings.getByTestId('webhook-settings-catch-urls').click();
    await page.getByRole('menuitem', { name: 'Signed' }).click();
    await settings.getByTestId('webhook-settings-save').click();
    await expect(settings).toBeHidden();

    await editor.getByRole('tab', { name: 'Signing' }).click();
    const signing = editor.getByTestId('rest-signing');
    await signing.getByTestId('signing-mode').selectOption('hmac');
    await enterSecret(signing, 'Set…', SECRET);
    await sendRest(page);
    await expect(responseStatus(page)).toContainText(/2\d\d/);

    await catchRow.dblclick();
    let row = await newestCapture(page, 1);
    await expect(row.getByTestId('capture-signature-badge')).toHaveAttribute('data-verdict', 'verified');

    // --- 3. Replace the item's secret, send again: ✗ digest mismatch -----------------------------
    await page.getByTestId('webhook-request-row').first().dblclick();
    await editor.getByRole('tab', { name: 'Signing' }).click();
    await enterSecret(editor.getByTestId('rest-signing'), 'Replace…', OTHER_SECRET);
    await sendRest(page);
    await expect(responseStatus(page)).toContainText(/2\d\d/);

    await catchRow.dblclick();
    row = await newestCapture(page, 2);
    await expect(row.getByTestId('capture-signature-badge')).toHaveAttribute('data-verdict', 'failed');
    await row.click();
    const viewer = page.getByTestId('catch-url-tab').getByTestId('capture-viewer');
    await viewer.getByRole('tab', { name: 'Details' }).click();
    await expect(viewer.getByTestId('capture-signature-verdict')).toContainText('digest mismatch');
  });
});
```

(Before committing, check each helper's exact export in `e2e/helpers/*.ts` and each test id against the components as written; the spec is not run locally.)

- [ ] **Step 3: Typecheck only (no local run)**

Run: `nice pnpm typecheck`
Expected: PASS. Do **not** run Playwright locally; CI runs `pnpm build && xvfb-run -a pnpm test:e2e`.

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e
git commit -m "test(e2e): a signed webhook verifies at its catch URL; a changed secret fails"
```

---

### Task 17: Docs — the *Webhook signatures* guide, the changelog and the capability map

**Files:**
- Create: `docs-site/src/content/docs/guides/webhook-signatures.mdx`
- Modify: `docs-site/astro.config.mjs` (sidebar), `docs-site/src/content/docs/guides/sending-webhooks.mdx`, `docs-site/src/content/docs/guides/webhooks.mdx`
- Modify: `CHANGELOG.md` (Unreleased ▸ Added), `docs/specs/2026-09-24-wirebench-server-capability-map.md` (the `webhook-signatures` row)
- Verify: `packages/server/README.md` already carries `WIREBENCH_SERVER_HOOKS_SECRET_KEY` (Task 6)

- [ ] **Step 1: Write the guide**

`docs-site/src/content/docs/guides/webhook-signatures.mdx` — frontmatter `title: Webhook signatures`, `description: Sign the webhooks you send and check the signatures of the ones you catch.` Sections, in the house style of `sending-webhooks.mdx` (short paragraphs, `<Steps>` for procedures, neutral secrets):

1. **The three schemes** — a table: *HMAC of body* (one header, hex or base64 digest of the exact body, optional prefix such as `sha256=`), *Timestamped HMAC* (`t=<unix>,v1=<hex>` over `<t>.<body>`, with a tolerance), *Standard Webhooks* (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`; a `whsec_` secret is base64 key bytes). One worked example with the known-answer vector (secret `abc123def456ghi789`, body `{"event":"order.created"}`, HMAC-SHA256 hex `e4d262af…64ab`).
2. **Check signatures at a catch URL** — `<Steps>`: open the catch URL's *Settings…*, choose a scheme, enter the secret (write-only: shown afterwards only as *● set …i789*), optionally tick **Reject unverified requests (401)**. What ✓ and ✗ mean, the five reasons (*missing header*, *malformed header*, *digest mismatch*, *timestamp outside tolerance*, *server key error*), where the Signature block sits (the capture's **Details**), that a body larger than the storage limit is still verified in full, and that a rejected request is still stored, marked *401*.
3. **Sign what you send** — the **Signing** tab on a webhook item, and the collection's and a folder's *Webhooks settings*: *Inherit*, *None*, or a scheme; the secret in the keychain (*Set…* / *Replace…*); the CI name. Inheritance: item → nearest folder → collection. A send with signing set and no secret is refused, never sent unsigned. The signature covers the exact bytes on the wire, after scripts and property expansion. History and cURL export show what was sent; a resend from History is not re-signed.
4. **In CI** — `wirebench run` reads the secret from `WIREBENCH_SECRET_<CI name>`; a missing one exits 3 naming the variable. Example: `WIREBENCH_SECRET_ORDERS_SIGNING=… wirebench run ./project Webhooks/Orders`.
5. **Server setup** — `WIREBENCH_SERVER_HOOKS_SECRET_KEY` (32 random bytes, base64: `openssl rand -base64 32`); unset, signature settings are refused and the dialog says so; losing or changing the key turns every check into *server key error* until secrets are entered again (key rotation is not supported yet).

- [ ] **Step 2: Update the neighbours**

- `astro.config.mjs`: after `{ label: 'Sending webhooks', slug: 'guides/sending-webhooks' },` add `{ label: 'Webhook signatures', slug: 'guides/webhook-signatures' },`.
- `sending-webhooks.mdx`: replace *Signing an outgoing webhook is not yet supported; it is planned for a later release.* with *To sign what you send, see [Webhook signatures](/guides/webhook-signatures/).*; add Standard Webhooks' `webhook-id` and `webhook-timestamp` to the list of headers *Save as webhook…* leaves out.
- `webhooks.mdx`: under *Read captures*, one paragraph: a catch URL with a signature scheme marks each capture ✓ or ✗ (with *401* when it rejected it) — link to the guide.
- `CHANGELOG.md` ▸ Unreleased ▸ Added, a new bullet after the webhook ones:

```md
- **Webhook signatures.** Webhook items, their folders and the Webhooks collection can sign what they
  send — *HMAC of body*, *Timestamped HMAC* or *Standard Webhooks* — with a secret from the keychain,
  or from `WIREBENCH_SECRET_<name>` in `wirebench run`. A catch URL can check the same schemes: each
  capture shows ✓ verified or ✗ with the reason, and **Reject unverified requests** answers 401 while
  still keeping the capture. The server keeps catch URL secrets encrypted under
  `WIREBENCH_SERVER_HOOKS_SECRET_KEY`.
```

- Capability map row: description *Third slice: three generic schemes (HMAC of body, timestamped HMAC, Standard Webhooks) verified on receipt per catch URL, with a write-only secret encrypted at rest and an optional 401 for unverified requests; the same schemes sign outgoing webhook items* and spec `2026-09-29-wirebench-webhook-signatures-design.md`.

- [ ] **Step 3: Check**

Run: `pnpm check:banned-terms && pnpm check:doc-paths && pnpm docs:server-config --check`
Expected: all clean. Proof-read that no provider or product name appears (only "Standard Webhooks", the open specification) and every secret is neutral.

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs-site CHANGELOG.md docs/specs/2026-09-24-wirebench-server-capability-map.md
git commit -m "docs: webhook signatures guide, changelog and capability map"
```

Before the push: `pnpm test:perf` (unskipped) once.

---

## Self-review

### Spec coverage

| Spec | Where |
|---|---|
| §1 goal, §1.1 scope (one implementation both sides) | Tasks 1, 4, 9 |
| §2 schemes, exact bytes, `whsec_`, tolerance, second `v1`, reasons | Task 1 (known-answer vectors above) |
| §3.1 key: config, 32 bytes base64, start-up refusal, start-up warning, key-error | Tasks 6, 8 (`warnUnopenableSignatures`), 9 |
| §3.2 storage: migration `0005`, pair / reject check constraints, hint | Task 7 |
| §3.3 receive: verify before truncation, verdict stored, 401 without delay, stored anyway, logs without secret | Task 9 |
| §3.4 manage API: set, scheme-only change, clear, write-only read, hint for editors, 409 / 400s, editor-only | Task 8 |
| §4 desktop receiving: Signature section (unavailable, viewer), row badges, Details block, *Save as webhook* drops | Tasks 11, 12, 13 |
| §5.1 model and format (format 6, refused under `apis/`) | Tasks 2, 3, 10 |
| §5.2 send: `sign` applied last; desktop keychain; never unsigned; CLI `WIREBENCH_SECRET_<secretEnv>`; Signing tab and settings; CI name prefill | Tasks 4, 5, 11, 14, 15 |
| §6 errors | Tasks 1, 2, 5, 8, 10, 11, 15 (codes in Global Constraints) |
| §7 testing: engine, server, desktop unit, e2e, docs | every task's tests; Task 16 (e2e); Task 17 (docs) |

### Rulings

- Ruling: server error codes carry the module's `hooks-` prefix (`hooks-signature-key-unset`, `hooks-signature-secret-required`); *Reject unverified* without a scheme is the generic `invalid-request` — every other server problem in the module is prefixed, and spec §6's `invalid` names the shape, not a new code.
- Ruling: `signatureAvailable` travels on each catch URL object rather than in `/meta` — the dialog already holds the catch URL, and `/meta` stays free of anything about secrets.
- Ruling: the hint is the last four characters, only for secrets of 8 or more, and only for editors and admins — four of seven characters would give most of a short secret away, and viewers cannot use it.
- Ruling: the migration lives in its own folder `migrations/webhook-signatures/`, and `ServerModule.migrationsDir` may be a list — the capability has its own folder like every other, while the hooks module keeps owning its tables.
- Ruling: `webhook-signing-body` is not implemented — `RestBody` has no stream kind, so a webhook item cannot produce one (spec §6's row is unreachable).
- Ruling: no header redaction is added — the spec's "redaction that already applies to `*signature*` headers" does not exist (`SENSITIVE_HEADERS` has none); a signature is not a credential, and adding redaction is out of this module's scope.
- Ruling: the capture's Signature block lives in the viewer's **Details** tab — the viewer has no overview; the spec's "overview block" maps there.
- Ruling: the Signature section shows only when editing an existing catch URL on a server that reports `signatureAvailable` — the `PATCH` is the only endpoint that takes it, and an older server has none.
- Ruling: the Details block shows the catch URL's current scheme and picks the signature headers by it (none: headers containing `signature` or starting with `webhook-`) — a capture stores its verdict, not the scheme it was checked under.
- Ruling: a Standard Webhooks message id is `msg_` plus 32 hex characters — unique per send, and the shape the specification's examples use.
- Ruling: `signatureSchemeSchema` is not annotated as `z.ZodType<SignatureScheme>`; `toSignatureScheme` closes the `exactOptionalPropertyTypes` gap, an empty prefix means none, and header/prefix/tolerance limits are enforced — so a stored or saved scheme is always one the engine reads back.
- Ruling: `signing` is refused on API requests both at load (`project-file-invalid`) and on mutation (`webhook-signing-not-webhook`) — it means nothing outside `webhooks/`.
- Ruling: a node with only a CI name is asked for as the pseudo-ref `webhook-signing:<secretEnv>`, read from `WIREBENCH_SECRET_<secretEnv>` alone — a project committed for CI needs no keychain ref.
- Ruling: timestamped headers are parsed leniently (entries trimmed, undecodable `v1` entries skipped) but a duplicate `t` is malformed — two timestamps cannot both be signed.
- Ruling: a stored scheme that no longer parses verifies as `key-error` — it is the server's fault, not the sender's.
- Ruling: the CI name is pre-filled from the node's name in upper snake case, `WEBHOOK_` in front of a leading digit, `WEBHOOK` when empty — the project file's `envName` rule.
- Ruling: History, the HTTP log and cURL export show the signing headers exactly as sent (they are among the headers `sendRest` passes on, spec §5.2); a resend from History replays them and is not re-signed — a replay is a record of what went out.
- Ruling: scheme defaults are HMAC-SHA256 hex in `X-Signature`, timestamped in `X-Signature` with ±300 s, Standard Webhooks ±300 s.
- Ruling: AES-GCM runs without additional authenticated data — a box moved to another row still only opens under the same key, and the row binding adds nothing the check constraints do not.
- Ruling: a catch URL's scheme may change without a new secret when one is stored — per spec §3.4.
- Ruling: the desktop reads only `secretRef` from the keychain; `secretEnv` is for CI — the desktop has a keychain, and a pipeline has none.
