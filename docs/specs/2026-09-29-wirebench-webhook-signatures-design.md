# Wirebench: `webhook-signatures` — design

Date: 2026-09-29 · Status: design approved by the owner in conversation 2026-09-29 · Module:
`webhook-signatures` of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (third slice)

- Builds on:
  - `docs/specs/2026-09-27-wirebench-server-webhook-capture-design.md`: catch URLs, captures, the
    public receive route and the desktop capture viewer.
  - `docs/specs/2026-09-28-wirebench-openapi-webhooks-import-design.md`: the per-project *Webhooks*
    collection, its folders and items, target inheritance and *Save as webhook*. Its §9 asked this
    module to **sign outgoing webhooks** as well as verify captures.
  - The REST sender (`packages/engine/src/rest/send.ts`) and the secret references auth already uses
    (`…Ref` from the OS keychain, `…Env` for CI as `WIREBENCH_SECRET_<name>`).
- Decisions recorded here (owner, 2026-09-29):
  - Captures are verified **on the server, on receipt**. The catch URL holds the scheme and secret.
  - Three generic schemes ship: **HMAC of the body**, **timestamped HMAC** and **Standard
    Webhooks**. No asymmetric or JWT schemes.
  - The server keeps verification secrets **encrypted at rest** (AES-256-GCM) with a key from
    `WIREBENCH_SERVER_HOOKS_SECRET_KEY`. Signature settings are refused while the key is unset.
  - A failed or missing signature is **recorded** on the capture. A per-URL option, *Reject
    unverified*, answers `401` instead of the configured response, and the capture is still stored.
  - Outgoing signing is set on the **collection, a folder or an item**, inherited with the nearest
    setting winning, in the same way as target and auth. The secret is a keychain reference with a
    CI name, never a value in the repository.

## 1. Goal

A developer's receiver must check that a webhook really came from its sender. To build and test
that check, they need two things:

- Webhooks they send from Wirebench that carry a valid signature, or a deliberately broken one.
- Proof of whether a request that reached a catch URL was correctly signed.

Both sides use the same few schemes, so one implementation serves both, and each side proves the
other correct.

### 1.1 In scope

- An engine module that signs and verifies the three schemes.
- On a catch URL: a scheme, a write-only secret and *Reject unverified*.
- On each capture: a verdict (*verified*, *failed* with a reason, or *not checked*), and whether the
  capture was answered `401`.
- On the webhook collection, a folder or an item: a signing setting that is inherited, set to none,
  or set to a scheme with a secret reference. It is applied at send time by the desktop and the CLI.
- Docs, the configuration reference and the changelog.

### 1.2 Not in scope

- RSA, ECDSA or Ed25519 signatures, signed JWT headers and fetching JWKS.
- Checking stored captures again after the scheme or secret changes. A verdict is fixed on receipt.
- Rotating the server key, and re-encrypting secrets under a new key.
- Signing ordinary API requests. A pre-request script can already do that.
- Verifying on the desktop against a keychain secret.

## 2. Schemes (engine)

The new file is `packages/engine/src/webhooks/signature.ts`, exported from the engine index. It
contains pure functions over bytes and uses `node:crypto` for HMAC, `timingSafeEqual` and random ids.

```ts
export type SignatureScheme =
  | {
      readonly kind: 'hmac';
      readonly algorithm: 'sha1' | 'sha256' | 'sha512';
      readonly encoding: 'hex' | 'base64';
      readonly header: string;          // e.g. 'X-Signature'
      readonly prefix?: string;         // e.g. 'sha256='
    }
  | {
      readonly kind: 'timestamped';
      readonly header: string;          // e.g. 'X-Signature'
      readonly toleranceSec: number;    // default 300
    }
  | {
      readonly kind: 'standard';
      readonly toleranceSec: number;    // default 300
    };

export type SignatureFailure =
  | 'missing-header' | 'malformed-header' | 'mismatch' | 'stale-timestamp' | 'key-error';

export type SignatureVerdict =
  | { readonly verdict: 'verified' }
  | { readonly verdict: 'failed'; readonly reason: SignatureFailure };

export function signWebhook(
  scheme: SignatureScheme, secret: string, body: Uint8Array,
  options?: { readonly now?: Date; readonly id?: string },
): readonly (readonly [name: string, value: string])[];

export function verifyWebhook(
  scheme: SignatureScheme, secret: string,
  headers: readonly (readonly [string, string])[], body: Uint8Array,
  options?: { readonly now?: Date },
): SignatureVerdict;

export const signatureSchemeSchema: z.ZodType<SignatureScheme>;
```

What each scheme signs and how it is checked:

- **`hmac`**
  - The HMAC covers the body bytes.
  - The header value is `prefix + digest(encoding)`.
  - On verify:
    - The header is matched without regard to case.
    - If a prefix is configured, it must be present. It is stripped before comparing.
    - Hex digests are compared case-insensitively. They are decoded to bytes, then compared with
      `timingSafeEqual`.
  - A header that does not decode, or decodes to the wrong length, fails as `malformed-header`.
- **`timestamped`**
  - The header is `t=<unix seconds>,v1=<hex HMAC-SHA256>`, computed over the UTF-8 of `<t>.`
    followed by the body bytes.
  - On verify:
    - The header is split on `,` into `key=value` parts.
    - `t` must be an integer, otherwise `malformed-header`.
    - `|now − t|` must be at most `toleranceSec`, otherwise `stale-timestamp`.
    - Any matching `v1` passes. More than one `v1` means the sender is rotating its secret.
    - Unknown keys are ignored.
- **`standard`** (the Standard Webhooks open specification)
  - Headers: `webhook-id` (a new random id, unless one is given), `webhook-timestamp` (unix
    seconds) and `webhook-signature: v1,<base64 HMAC-SHA256>`. The HMAC covers
    `<id>.<timestamp>.` followed by the body.
  - The secret:
    - With a `whsec_` prefix, the rest is base64 key bytes. A bad base64 fails as `key-error` when
      verifying, and throws `WirebenchError('webhook-signing-secret')` when signing.
    - Otherwise, its UTF-8 bytes are the key.
  - On verify:
    - The signature header is a space-separated list, and any `v1,` entry that matches passes.
    - The timestamp is checked against the tolerance as for `timestamped`.

The check order for every scheme is: header present → header parses → timestamp → digest.
`verifyWebhook` never throws. Any unexpected error returns `failed: key-error`.

## 3. Server: verification on receipt

### 3.1 Key

- `WIREBENCH_SERVER_HOOKS_SECRET_KEY` is new in `config.ts` and marked `secret: true`. It holds 32
  bytes, base64-encoded. A value that is present but decodes to any other length stops start-up with
  a configuration error, just as other invalid variables do.
- A new file, `packages/server/src/hooks/secret-box.ts`, provides `seal` and `open`:
  - `seal(key, plaintext) → Buffer` builds `version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext` with
    AES-256-GCM and a random IV.
  - `open(key, sealed) → string` throws when authentication fails.
- If the key is unset:
  - The server starts.
  - A `PATCH` that sets a signature answers `409` with problem type `signature-key-unset`.
  - `GET /api/v1/…/catch-urls` includes `signatureAvailable: false` so the desktop can explain why.
  - When catch URLs with a signature already exist, start-up logs one warning. Their captures are
    recorded as `failed: key-error`.

### 3.2 Storage

Migration `packages/server/migrations/webhook-signatures/0005_webhook-signatures.sql`:

```sql
alter table catch_urls
  add column signature jsonb null,               -- SignatureScheme, validated by the app
  add column signature_secret bytea null,        -- sealed; never returned
  add column signature_hint text null,           -- last 4 characters of the secret
  add column reject_unverified boolean not null default false;
alter table captures
  add column signature_verdict text null,        -- 'verified' | 'failed'; null = not checked
  add column signature_reason text null,         -- a SignatureFailure when failed
  add column rejected boolean not null default false;
```

`signature` and `signature_secret` are both null or both set. A check constraint enforces this.

### 3.3 Receive path (`hooks/routes/public.ts`)

After the rate-limit bucket and before the capture is built:

1. If the catch URL has a signature, open its secret and call `verifyWebhook(scheme, secret,
   headerPairs, fullBody, { now: env.now() })`. This runs on the **full** body, before
   `truncateBody`. If the secret will not open, the verdict is `failed: key-error`, and the error
   is logged without the secret. With no signature configured, the verdict is null.
2. `rejected = reject_unverified && verdict?.verdict !== 'verified'`. A catch URL with no scheme is
   never rejected: *Reject unverified* is only offered alongside a scheme.
3. The capture is inserted with `signature_verdict`, `signature_reason` and `rejected`, and the live
   nudge fires as before.
4. When `rejected` is true, the route answers `401` at once, with no body and no configured delay.
   Otherwise the configured response is sent, as before.

`PublicCatchUrl` gains `signature?: { scheme; sealedSecret }` and `rejectUnverified`.
`catchUrlBySecret` selects them.

### 3.4 Manage API (`hooks/routes/manage.ts`)

- `PATCH …/catch-urls/:id` accepts:
  - `signature: { scheme: SignatureScheme; secret?: string } | null`
    - `null` clears the scheme, the secret, the hint and `reject_unverified`.
    - A new scheme with no secret is allowed only when a secret is already stored, which changes the
      scheme but keeps the secret. Otherwise it answers `400` with `signature-secret-required`.
    - A secret must be 1–512 characters.
  - `rejectUnverified: boolean`. Setting it to `true` with no scheme answers `400`.
  - Only editors may make these changes, as with every other catch URL change.
- Catch URL reads (list and one) return
  `signature: { scheme, secret: { set: true, hint } } | null`, `rejectUnverified` and
  `signatureAvailable`. The secret and its sealed bytes are never returned or logged.
- Capture reads (list rows and detail) return
  `signature: { verdict, reason? } | null` and `rejected`.
- `engine` wire schemas for catch URLs and captures (the shared `CatchUrlWire` and `CaptureWire`
  types) gain these fields as optional, so an older server still parses.

## 4. Desktop: the receiving side

- The catch URL tab's settings (`features/webhooks/catch-url-tab.tsx` and its dialogs) gain a
  **Signature** section:
  - The scheme is chosen from *None*, *HMAC of body*, *Timestamped HMAC* and *Standard Webhooks*.
  - Each scheme shows its fields: algorithm, encoding, header and prefix; header and tolerance; or
    tolerance.
  - **Secret** shows *● set …f789* with *Replace*, or an empty password field.
  - **Reject unverified requests (401)** is a checkbox, enabled only when a scheme is chosen.
  - When `signatureAvailable` is false, the section is disabled and notes that the server
    administrator must set `WIREBENCH_SERVER_HOOKS_SECRET_KEY`.
  - Viewers see the section read-only, without the hint.
- The capture list shows a badge on each row: ✓ *verified*, ✗ *failed*, or nothing when the capture
  was not checked. It also shows a *401* marker when the capture was rejected.
- The capture viewer's overview (`capture-viewer.tsx`) shows:
  - **Signature**: the verdict, the reason in plain words, the catch URL's current scheme, and the
    received signature header values.
  - **Answered 401 (rejected: unverified)** when the capture was rejected.
  - The reasons read as: *missing header*, *malformed header*, *digest mismatch*, *timestamp outside
    tolerance* and *server key error*.
- *Save as webhook* keeps dropping `*signature*` headers, drops the `webhook-id`,
  `webhook-timestamp` and `webhook-signature` headers too, and leaves the new item's signing
  unset (inherited).

## 5. Outgoing signing

### 5.1 Model and format

`packages/engine/src/webhooks/model.ts`:

```ts
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
```

- `signing?: WebhookSigning` is added to `WebhookCollection`, to `WebhookFolder` and to webhook
  items. For items, it lives on `RestRequestDef` as an optional field that only the webhook
  collection's reader and writer carry. API requests never read or write it.
- Absent means inherit: the item, then the nearest folder, then the collection. A collection with
  nothing set means none.
- `effectiveSigning(collection, requestId): { signing: WebhookSigning; from: 'item' | 'folder' |
  'collection' | 'default'; fromName?: string }` goes beside `effectiveTarget`.
- The files involved are `webhooks/webhooks.yaml`, each webhook `folder.yaml` and each webhook
  request YAML. The schema and the loader and serializer round-trip `signing`. The format stays
  **6**, which is not yet released and is shared with request scripts and the webhook collection.
  The `FORMAT_VERSION` comment and the changelog entry mention signing.
- `applyRestRequestPatch`, `cloneRestRequest` (duplicate keeps signing) and the webhook folder and
  collection patches carry `signing`.

### 5.2 Applying at send time

- `RestSendInput` gains `sign?: { scheme: SignatureScheme; secret: string }`. `sendRest` applies it
  last:
  - The input is the encoded body bytes (empty when there is no body) and the merged headers.
  - `signWebhook` is called, and its headers are set, replacing any header of the same name.
  - This runs after auth, body encoding and header merging. Pre-request scripts and property
    expansion have already run upstream. The signature therefore covers exactly the bytes on the
    wire.
  - Stream bodies are not used by webhook items. If one appears, the send fails with
    `webhook-signing-body`.
- Desktop (`main/webhook-send.ts` → `resolveWebhookSend`):
  - The effective signing is resolved. For `sign`, the secret is resolved through the same
    keychain lookup auth uses, and `sign` is passed on.
  - A missing secret fails the send with `WirebenchError('webhook-signing-secret', 'Signing is set
    on <from> but its secret is not set')`. The send never goes out unsigned.
  - The HTTP log and history show the added headers. The redaction that already applies to headers
    named `*signature*` still applies.
- CLI and runner (`run/select.ts`): the secret comes from `WIREBENCH_SECRET_<secretEnv>`, the
  same as for auth. A missing secret fails the item with the same error code.
- Editors: the collection, folder and item settings (`webhook-settings-dialog.tsx`, and a
  **Signing** tab in the REST editor for webhook items only) offer:
  - *Inherit (→ shows the effective source)*, *None*, or a scheme with its fields.
  - A secret set in the keychain, with *Set…*/*Replace…*.
  - A CI name, pre-filled from the node's name in upper snake case.

## 6. Errors

| Where | Condition | Result |
|---|---|---|
| server PATCH | key unset | `409 signature-key-unset` |
| server PATCH | scheme without secret, none stored | `400 signature-secret-required` |
| server PATCH | `rejectUnverified: true` without scheme | `400 invalid` |
| server receive | secret cannot be opened | capture `failed: key-error`, error logged |
| send | signing set, secret missing | `webhook-signing-secret`, not sent |
| send | `standard` secret `whsec_` not base64 | `webhook-signing-secret`, not sent |
| send | stream body | `webhook-signing-body`, not sent |

## 7. Testing

- **Engine**:
  - Fixed known-answer vectors for each scheme.
  - `signWebhook` → `verifyWebhook` round trips for every algorithm and encoding, with and without
    a prefix.
  - A tampered body gives `mismatch`. A missing or garbled header gives `missing-header` or
    `malformed-header`. A timestamp one second past the tolerance gives `stale-timestamp`.
  - A second `v1` entry that matches passes. A bad `whsec_` secret is handled.
  - `effectiveSigning` inheritance.
  - Schema, load and serialize round trips of `signing` at every level.
  - `sendRest` with `sign` adds the headers over the encoded bytes.
- **Server**:
  - `secret-box` round trip and tamper detection.
  - The migration applies.
  - Manage API: set, change scheme only, clear, write-only reads, `409` without the key, `400`
    cases, and editor-only access.
  - Receive:
    - Verified, failed and not-checked captures.
    - Verification runs before truncation. A body over the limit that is correctly signed is still
      `verified`.
    - With *Reject unverified*, the answer is `401` and the capture is still stored.
    - A wrong key gives `key-error`.
    - The secret never appears in responses or captured logs.
- **Desktop unit**:
  - The Signature settings section, including the unavailable and viewer states.
  - The list badges and the overview block.
  - The *Save as webhook* header drops.
  - Signing resolution and the missing-secret error.
  - The signing controls in the webhook settings dialog and in the Signing tab.
- **e2e (CI only)**: on the fake server, with the key set:
  1. Give a catch URL an HMAC scheme and a secret.
  2. Give a webhook item the same scheme and secret, send it to the catch URL, and see ✓ on the
     capture.
  3. Change the item's secret, send again, and see ✗ *digest mismatch*.
- **Docs**:
  - A guide page, *Webhook signatures*, covering both sides and the three schemes.
  - The server configuration reference entry for `WIREBENCH_SERVER_HOOKS_SECRET_KEY`.
  - `CHANGELOG.md` and the capability map row.
  - No product that inspired the feature is named (`pnpm check:banned-terms`). Fixtures use neutral
    secrets such as `abc123def456ghi789`, never provider-shaped keys.

## 8. Later modules

- `callback-assertion`: can assert that a capture it waited for is `verified`.
