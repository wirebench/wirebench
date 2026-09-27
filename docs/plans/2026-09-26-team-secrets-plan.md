# Team secrets in a shared workspace — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/specs/2026-09-26-team-secrets-design.md`. Issue #38.

**Goal:** When one teammate rotates a secret in a shared workspace, everyone else's next send uses the new value
after their next sync, with nothing pasted. Values travel in the tree encrypted to each approved machine's key; the
git host and Wirebench Server only ever hold ciphertext.

**Architecture:** The engine gains `packages/engine/src/team-secrets/`: machine keys (X25519 + Ed25519), an envelope
(AES-256-GCM value, per-recipient wraps through ECDH + HKDF), canonical-JSON signatures, zod schemas for the three
file kinds under `team-secrets/`, a signed access-log replay, the vault operations (build, verify, open, seal, heal)
and the concurrent-change winner. `team-secrets` becomes a tree item. The server refuses a non-admin push that touches
`team-secrets/access/` and gains a key-request route for members who cannot push. The desktop's `SyncService` learns
to settle vault conflicts itself and to commit a vault write under its own message. A new main-process
`TeamSecretsService` owns the machine key per workspace, reads and writes the tree's `team-secrets/` files, runs after
every pull, and serves `teamSecrets.*` IPC. A `TeamSecretStore` wraps the keychain store so every save path (secret
field, `${secret:name}` dialog, secret-scan move) writes the vault, and a getter wrapper turns a missing value on an
unapproved machine into `team-secrets-pending`. The renderer adds a **Team secrets** section to the Sync panel, a
waiting count on the sync badge, and *Only on this machine* / *Rotate* marks on the secret field.

**Tech Stack:** TypeScript, `node:crypto` (X25519, Ed25519, HKDF-SHA256, AES-256-GCM), zod 4, `yaml` (the engine's
serializer), `ulidx` (already an engine dependency), Fastify + git plumbing (server), Electron main + zod IPC
channels, React 19, Zustand, Vitest (node and jsdom), Playwright e2e.

Gate before each commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
Make one commit per task.

## Global Constraints

- Commit as **Mohammed Naami <m.naami@outlook.com>** (already the worktree's `user.name` / `user.email`).
- **NO `Co-Authored-By:`** and **NO `Claude-Session:`** trailers on any commit.
- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit (the gate line above is that command with more
  heap and a lower priority); **one commit per task**. If the gate fails with an Electron install "File exists"
  race, run it again.
- Never name the products that inspired a feature, in code, tests, docs or commit messages;
  `pnpm check:banned-terms` enforces it.
- Renderer modules import only **types** from `apps/desktop/src/shared/wire-types.ts` (`import type …`). A value
  import pulls zod into the renderer bundle and breaks every e2e spec through the CSP eval probe.
- No local Electron e2e runs (CI runs e2e). E2e specs are written and type-checked only:
  `pnpm exec tsc --noEmit -p e2e/tsconfig.json`.
- No new npm dependency: `node:crypto` only for cryptography.
- Values and private keys never cross IPC, and never reach logs, the tree, History or HAR. Only ids, names,
  fingerprints and labels leave main.
- In this worktree, three desktop files (`workspace-service`, `workspace-share`, `workspace-share-server`) can fail
  to load with "Electron failed to install correctly". That is the local Electron install, not this change; repair
  the install as the message says before running the gate, and never skip a failing file.

## Plan decisions

Where the spec is silent or meets the real code differently, this plan decides as follows. Each is implemented
and tested in the task named.

1. **`team-secrets` is a tree item** (Task 2). `TREE_ITEMS` lists `workspace.yaml`, `environments`, `projects`,
   `.gitattributes` only, and both the server (`assertTreePath` in the commit store) and the desktop
   (`server-state.ts`) refuse any other first segment. `TEAM_SECRETS_DIR = 'team-secrets'` joins the list. Spec §14
   ("an older app ignores `team-secrets/`") therefore holds for git and folder shares only: an older app on a
   **server** share refuses a snapshot that carries `team-secrets/` paths (`sync-path-refused`). The CHANGELOG and
   the guide say members update before an admin turns team secrets on in a server workspace (Task 12).
2. **Vault files are never text-merged** (Task 2). `GIT_ATTRIBUTES` gains `team-secrets/values/** -merge`, so git
   reports a conflict instead of a line merge that could splice two ciphertexts. Existing shares only write
   `.gitattributes` when it is missing, so turning team secrets on appends the line when absent (Task 6). The server
   backend's `mergeFiles` is already whole-file.
3. **Secret identity** (Task 2). The spec's "SHA-256 of the secret key" is `vaultEntryId(secret)` =
   first 26 base32 characters of SHA-256 of `ref:<ref>` or `token:<projectId>\n<name>`.
4. **Access-entry ordering and the genesis pin** (Tasks 2, 6, 8). Entries replay in ULID order. A ULID's time is chosen
   by its writer, so anyone with push access could backdate a second "genesis". Each machine pins the first
   genesis id it sees (trust on first use, in the machine-local `team-secrets.json`) and replays with only that id
   allowed as genesis. It also remembers every access-entry id it has replayed; if one disappears from the tree, the
   Team secrets section says the log is damaged and the machine stops writing the vault and managing keys until the
   file is restored.
5. **What `updatedAt` means** (Task 3). It is the time the *value* was last set. Healing, approval rewraps and
   removal re-encryption keep it and change only `updatedBy` (the signer) and the signature. This is what lets rotate
   marks come from the replay: an entry is marked for a removal when `updatedAt < removal.at` (the value was alive
   while that key was approved); changing the value moves `updatedAt` past the removal and clears the mark.
6. **Late re-encryption** (Tasks 3, 8). A value written concurrently with a removal can carry a wrap for the removed
   key. The pull hook re-encrypts, with a fresh data key, any trusted entry that wraps a key the log no longer
   approves. This is §3.6's re-encryption applied late; healing itself still only adds wraps.
7. **Conflict sides read via `git show`** (Task 5; superseded during implementation). `git show` is now on
   the desktop's git allow-list, read-only. `GitBackend.conflictSides` reads each side straight from the
   index — `git show :2:<path>` (ours) and `:3:<path>` (theirs) — never touching the working file, so
   previewing a decision cannot change what a person resolving the conflict by hand would see. The
   resolution that follows still checks out the chosen side with `checkout --ours|--theirs`.
8. **A deleted side of a vault conflict** (Task 3). The side that still has the file wins (a value is never lost
   silently; deleting again is one click). An unparseable side loses.
9. **Who sees the "replaced" notice** (Task 8). The conflict is seen by the machine that pulls second; that machine
   keeps its losing value for **Use mine** and shows the notice. A machine whose already-pushed value is later
   superseded by a newer concurrent one receives it as any later change. The notice has **Keep theirs** as well
   (`teamSecrets.dismissReplaced`), which the spec's channel list lacks.
10. **Server shares turn on after the share push** (Task 9). At share time the sharer's server role is unknown, and a
    non-admin's push touching `access/` is refused. `WorkspaceService.shareToServer` calls `turnOnIfAdmin()` after
    its catch-up push; the genesis is then its own commit ("Turn on team secrets"). Git and folder shares write it
    into the share's first commit, as the spec says.
11. **Key requests on a server share always use the route** (Tasks 4, 6). One path for editors and viewers alike;
    the file arrives on the requester's next pull. The route refuses a key file that already exists
    (`409 team-secrets-key-exists`) so no member can overwrite someone else's request; the desktop treats that 409
    as done. Its body is `{ keyId, content }` with `content` the key file's text, at most 4 KiB.
12. **The admin-only check ignores case** (Task 4). The server compares `path.toLowerCase()` with
    `team-secrets/access/`: a checkout on a case-insensitive file system would put `TEAM-SECRETS/access/x.yaml` in
    the same folder.
13. **Viewers never write the vault** (Tasks 6, 7). On a server share a viewer's commits never leave the machine, so
    a viewer's save stays local and is marked *Only on this machine*; viewers do not heal or back-fill either.
14. **Nothing inside a pull waits on the sync queue** (Tasks 5, 6). `onPulled` runs inside a queued sync operation.
    `SyncService.identity()` therefore reads the backend directly, and the service fires the server key request and
    every vault commit (`afterTeamSecretsWrite`) without awaiting them.
15. **Folder shares** (Task 9). A folder share has no pull. The workspace watcher also watches `team-secrets/**`,
    and a change there runs the same hook `onPulled` runs.
16. **Stop sharing leaves `team-secrets/` behind** (Task 9). It does not come back into the local workspace, which
    never has team secrets (§2); the values stay in this machine's keychain.
17. **What "local only" means** (Task 6). A secret the workspace uses, whose value is on this machine, while this
    machine cannot write the vault (not approved, a viewer, or a damaged log). An approved machine's missing entries
    are back-filled on the next sync.
18. **Deleting a ref** (Task 7). The vault entry goes when the value is deleted through `secrets.delete`, the only
    deletion path. A ref merely dropped from a project keeps its (encrypted) entry.
19. **The waiting count lives on the badge** (Task 11). The status bar's sync item is a button that opens the Sync
    panel; it has no menu. Admins see "· *N* waiting" on it, and the panel's **Team secrets** section is the "menu".
20. **A removed machine can ask again** (Task 6). `teamSecrets.requestAccess` makes a fresh key and request; a
    removed key itself can never be approved again (the replay refuses it).
21. **Identity for a key request** (Task 6). Git and server shares use the commit identity (the backend's
    `identity()`); a folder share, which has none, uses the OS user name and an empty email.
22. **The secret scanner needs no change** (§6). It scans project models, never tree files, so `team-secrets/` is
    out of its reach already. No task changes it.
23. **E2e keychain** (Task 12). Linux CI may have no keychain (the existing `secrets.spec.ts` allows for it). The new
    spec asks the app whether OS encryption is available and skips without it; macOS and Windows run it in
    full. Existing sync specs are adjusted where a key-request commit or the
    pending message changes what they see.
24. **Event name** (Task 10). The spec's `team-secrets-changed` event is `teamSecrets.changed`, following the
    `sync.statusChanged` naming of every other event.

## Questions for the owner

None.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/team-secrets/keys.ts` (new) | machine keys, key id, fingerprint, base32/base64url |
| `packages/engine/src/team-secrets/sign.ts` (new) | canonical JSON, sign, verify |
| `packages/engine/src/team-secrets/envelope.ts` (new) | value encryption, data-key wrap/unwrap |
| `packages/engine/src/team-secrets/errors.ts` (new) | the §3.8 codes and messages |
| `packages/engine/src/team-secrets/schema.ts` (new) | zod for the three file kinds, paths, ids, tree reading |
| `packages/engine/src/team-secrets/log.ts` (new) | access-log replay |
| `packages/engine/src/team-secrets/vault.ts` (new) | build, verify, open, seal, heal, rotate marks |
| `packages/engine/src/team-secrets/resolve-conflict.ts` (new) | §3.5 winner |
| `packages/engine/src/team-secrets/index.ts` (new) | barrel |
| `packages/engine/src/secrets/secret-refs.ts` (new) | `secretRefsInValue` |
| `packages/engine/src/workspace/paths.ts`, `sync/tree-paths.ts`, `workspace/commit-message.ts` | `TEAM_SECRETS_DIR`, tree item, `-merge`, commit kind |
| `packages/engine/src/server-api/sync.ts`, `packages/engine/src/index.ts` | key-request wire; exports |
| `packages/server/src/sync/errors.ts`, `commit-store.ts`, `module.ts`, `routes/commits.ts` | admin-only guard, `hasFile` |
| `packages/server/src/sync/routes/key-requests.ts` (new) | `POST …/team-secrets/key-requests` |
| `apps/desktop/src/main/server-client.ts` | `requestTeamSecretsKey` |
| `apps/desktop/src/main/sync/{backend,git-backend,server-backend,sync-service}.ts` | conflict sides, key request, members, auto-resolve, vault commits |
| `apps/desktop/src/main/secrets.ts` | `put`, `encryptionAvailable` |
| `apps/desktop/src/main/team-secrets-service.ts` (new) | the service |
| `apps/desktop/src/main/team-secret-store.ts` (new) | `TeamSecretStore`, `teamSecretGetter` |
| `apps/desktop/src/main/workspace-service.ts`, `workspace-share.ts` | attach, share turn-on, pull hook, watcher, stop sharing |
| `apps/desktop/src/main/ipc/team-secrets.ts` (new), `ipc/secrets.ts`, `index.ts` | channels, wiring |
| `apps/desktop/src/shared/wire-types.ts`, `shared/ipc.ts` | status wire, channels, event |
| `apps/desktop/src/renderer/state/team-secrets.ts` (new) | store |
| `apps/desktop/src/renderer/features/sync/team-secrets-section.tsx` (new) | the section |
| `apps/desktop/src/renderer/features/sync/{sync-panel,sync-badge}.tsx`, `components/secret-field.tsx`, `shell/app-shell.tsx` | section, waiting count, marks, subscription |
| `e2e/specs/team-secrets.spec.ts` (new), `e2e/helpers/sync.ts`, `e2e/specs/sync-secret.spec.ts` | e2e |
| `docs/adr/0014-team-secrets-are-sealed-per-machine-in-the-tree.md` (new), `docs-site/src/content/docs/guides/{secrets,shared-workspaces}.mdx`, `CHANGELOG.md`, `docs/success-criteria.md` | docs |

---

## Task 1: engine crypto primitives — keys, signatures, envelope

**Files:**
- Create: `packages/engine/src/team-secrets/keys.ts`
- Create: `packages/engine/src/team-secrets/sign.ts`
- Create: `packages/engine/src/team-secrets/envelope.ts`
- Create: `packages/engine/src/team-secrets/errors.ts`
- Test: `packages/engine/test/unit/team-secrets/crypto.test.ts` (new)

**Interfaces:**
- Consumes: `WirebenchError` (`packages/engine/src/errors.ts`); `node:crypto`.
- Produces:
  - `keys.ts`: `export const KEY_ID_PATTERN = /^[A-Z2-7]{26}$/`;
    `export interface MachinePublicKeys { readonly encryptionKey: string; readonly signingKey: string }`;
    `export interface MachineKeys extends MachinePublicKeys { readonly keyId: string; readonly encryptionPrivate: string; readonly signingPrivate: string }`;
    `base64url(bytes: Uint8Array): string`, `fromBase64url(text: string): Buffer`, `base32(bytes: Uint8Array): string`,
    `keyIdOf(keys: MachinePublicKeys): string`, `fingerprintOf(keys: MachinePublicKeys): string`,
    `generateMachineKeys(): MachineKeys`, `encryptionPublicKey(raw: string): KeyObject`,
    `encryptionPrivateKey(keys: MachineKeys): KeyObject`, `signingPublicKey(raw: string): KeyObject`,
    `signingPrivateKey(keys: MachineKeys): KeyObject`, `serializeMachineKeys(keys: MachineKeys): string`,
    `parseMachineKeys(text: string): MachineKeys | undefined`.
  - `sign.ts`: `canonicalJson(value: unknown): string`, `type Signed<T> = T & { readonly signature: string }`,
    `withoutSignature(doc: object): Record<string, unknown>`, `signDocument<T extends object>(doc: T, keys: MachineKeys): Signed<T>`,
    `verifyDocument(doc: { readonly signature: string }, signingKey: string): boolean`.
  - `envelope.ts`: `WRAP_INFO = 'wirebench-team-secrets-v1-wrap'`, `newDataKey(): Buffer`,
    `encryptValue(value: string, dataKey: Buffer, entryId: string): string`,
    `decryptValue(cipher: string, dataKey: Buffer, entryId: string): string`,
    `wrapDataKey(dataKey: Buffer, recipientEncryptionKey: string): string`,
    `unwrapDataKey(wrap: string, keys: MachineKeys): Buffer`; failures throw `WirebenchError('team-secrets-decrypt-failed')`.
  - `errors.ts`: `TEAM_SECRETS_MESSAGES` (the five §3.8 messages keyed by code), `type TeamSecretsErrorCode`,
    `teamSecretsError(code: TeamSecretsErrorCode, details?: Readonly<Record<string, unknown>>): WirebenchError`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/unit/team-secrets/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import {
  decryptValue,
  encryptValue,
  newDataKey,
  unwrapDataKey,
  wrapDataKey,
} from '../../../src/team-secrets/envelope.js';
import { TEAM_SECRETS_MESSAGES, teamSecretsError } from '../../../src/team-secrets/errors.js';
import {
  base32,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  KEY_ID_PATTERN,
  keyIdOf,
  parseMachineKeys,
  serializeMachineKeys,
} from '../../../src/team-secrets/keys.js';
import { canonicalJson, signDocument, verifyDocument } from '../../../src/team-secrets/sign.js';

describe('machine keys (team secrets §2, §4)', () => {
  it('encodes base32 as RFC 4648 without padding', () => {
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(base32(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('generates 32-byte public keys, a 26-character key id and a grouped fingerprint', () => {
    const keys = generateMachineKeys();
    expect(fromBase64url(keys.encryptionKey)).toHaveLength(32);
    expect(fromBase64url(keys.signingKey)).toHaveLength(32);
    expect(keys.keyId).toMatch(KEY_ID_PATTERN);
    expect(keys.keyId).toBe(keyIdOf(keys));
    expect(fingerprintOf(keys)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(generateMachineKeys().keyId).not.toBe(keys.keyId);
  });

  it('round-trips through its stored form and refuses one whose key id does not match', () => {
    const keys = generateMachineKeys();
    expect(parseMachineKeys(serializeMachineKeys(keys))).toEqual(keys);
    const other = generateMachineKeys();
    expect(parseMachineKeys(JSON.stringify({ ...keys, keyId: other.keyId }))).toBeUndefined();
    expect(parseMachineKeys('not json')).toBeUndefined();
  });
});

describe('signatures', () => {
  it('writes canonical JSON: sorted keys at every depth, no whitespace, undefined dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('verifies a signed document and refuses a changed field, another key or a bad signature', () => {
    const keys = generateMachineKeys();
    const signed = signDocument({ version: 1, key: 'K', at: '2026-09-26T10:00:00.000Z' }, keys);
    expect(verifyDocument(signed, keys.signingKey)).toBe(true);
    expect(verifyDocument({ ...signed, at: '2026-09-26T11:00:00.000Z' }, keys.signingKey)).toBe(false);
    expect(verifyDocument(signed, generateMachineKeys().signingKey)).toBe(false);
    expect(verifyDocument({ ...signed, signature: 'AAAA' }, keys.signingKey)).toBe(false);
    expect(verifyDocument(signed, 'not-a-key')).toBe(false);
  });

  it('signs the document without its signature, so re-signing replaces it', () => {
    const keys = generateMachineKeys();
    const once = signDocument({ a: 1 }, keys);
    const twice = signDocument(once, keys);
    expect(verifyDocument(twice, keys.signingKey)).toBe(true);
    expect(Object.keys(twice).sort()).toEqual(['a', 'signature']);
  });
});

describe('envelope', () => {
  it('encrypts a value and decrypts it with the same data key and entry id', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA');
    expect(cipher).not.toContain('hunter2');
    expect(decryptValue(cipher, dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA')).toBe('hunter2');
  });

  it('refuses a cipher moved to another entry (the entry id is the additional data)', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA');
    expect(() => decryptValue(cipher, dataKey, 'ENTRYBBBBBBBBBBBBBBBBBBBBB')).toThrow(WirebenchError);
  });

  it('refuses a tampered cipher, a wrong data key and a truncated cipher', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'E');
    const bytes = fromBase64url(cipher);
    bytes[14] = (bytes[14] ?? 0) ^ 0xff;
    expect(() => decryptValue(bytes.toString('base64url'), dataKey, 'E')).toThrow(/could not be decrypted/);
    expect(() => decryptValue(cipher, newDataKey(), 'E')).toThrow(WirebenchError);
    expect(() => decryptValue('AAAA', dataKey, 'E')).toThrow(WirebenchError);
  });

  it('wraps a data key for a recipient, who alone can unwrap it', () => {
    const alice = generateMachineKeys();
    const bob = generateMachineKeys();
    const dataKey = newDataKey();
    const wrap = wrapDataKey(dataKey, alice.encryptionKey);
    expect(unwrapDataKey(wrap, alice).equals(dataKey)).toBe(true);
    expect(() => unwrapDataKey(wrap, bob)).toThrow(WirebenchError);
    expect(wrapDataKey(dataKey, alice.encryptionKey)).not.toBe(wrap);
  });

  it('refuses a tampered wrap', () => {
    const alice = generateMachineKeys();
    const bytes = fromBase64url(wrapDataKey(newDataKey(), alice.encryptionKey));
    bytes[40] = (bytes[40] ?? 0) ^ 0x01;
    expect(() => unwrapDataKey(bytes.toString('base64url'), alice)).toThrow(WirebenchError);
  });
});

describe('errors (§3.8)', () => {
  it('carries the spec wording for every code', () => {
    expect(TEAM_SECRETS_MESSAGES['team-secrets-pending']).toBe(
      'This machine is waiting for an admin to approve it for team secrets.',
    );
    const error = teamSecretsError('team-secrets-last-admin');
    expect(error.code).toBe('team-secrets-last-admin');
    expect(error.message).toBe('A workspace needs at least one admin for team secrets.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/crypto.test.ts`
Expected: FAIL — the modules under `src/team-secrets/` do not exist.

- [ ] **Step 3: Write `keys.ts`**

Create `packages/engine/src/team-secrets/keys.ts`:

```ts
/**
 * Machine keys for team secrets (team-secrets spec §2, §4): one X25519 pair to decrypt and one Ed25519
 * pair to sign, per machine per workspace. Keys travel as base64url of their raw 32 bytes, which is what
 * a JWK's `x` and `d` already are, so `node:crypto` imports them without any DER handling.
 *
 * Pure: no I/O. The desktop keeps the private halves in its keychain-backed store; nothing else does.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** A key id: the first 26 base32 characters of SHA-256 over both public keys. */
export const KEY_ID_PATTERN = /^[A-Z2-7]{26}$/;

/** The two public keys a key request publishes. */
export interface MachinePublicKeys {
  /** X25519, base64url of 32 bytes. */
  readonly encryptionKey: string;
  /** Ed25519, base64url of 32 bytes. */
  readonly signingKey: string;
}

/** A machine's full key set. The private halves never leave the desktop's main process. */
export interface MachineKeys extends MachinePublicKeys {
  readonly keyId: string;
  readonly encryptionPrivate: string;
  readonly signingPrivate: string;
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    // Only the bits not yet written are kept (fewer than 13), so the number never overflows.
    value = ((value << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function publicDigest(keys: MachinePublicKeys): Buffer {
  return createHash('sha256')
    .update(fromBase64url(keys.encryptionKey))
    .update(fromBase64url(keys.signingKey))
    .digest();
}

export function keyIdOf(keys: MachinePublicKeys): string {
  return base32(publicDigest(keys)).slice(0, 26);
}

/** What an admin reads out to the person (§3.2): the first 16 hex of the same digest, in groups of four. */
export function fingerprintOf(keys: MachinePublicKeys): string {
  return (
    publicDigest(keys)
      .toString('hex')
      .slice(0, 16)
      .match(/.{4}/g)
      ?.join(' ') ?? ''
  );
}

export function generateMachineKeys(): MachineKeys {
  const encryption = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const signing = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const publicKeys: MachinePublicKeys = { encryptionKey: String(encryption.x), signingKey: String(signing.x) };
  return {
    ...publicKeys,
    keyId: keyIdOf(publicKeys),
    encryptionPrivate: String(encryption.d),
    signingPrivate: String(signing.d),
  };
}

export function encryptionPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

export function encryptionPrivateKey(keys: MachineKeys): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: keys.encryptionKey, d: keys.encryptionPrivate },
    format: 'jwk',
  });
}

export function signingPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

export function signingPrivateKey(keys: MachineKeys): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: keys.signingKey, d: keys.signingPrivate },
    format: 'jwk',
  });
}

/** The stored form, kept in the keychain-backed store only. */
export function serializeMachineKeys(keys: MachineKeys): string {
  return JSON.stringify({
    keyId: keys.keyId,
    encryptionKey: keys.encryptionKey,
    encryptionPrivate: keys.encryptionPrivate,
    signingKey: keys.signingKey,
    signingPrivate: keys.signingPrivate,
  });
}

/** Reads the stored form back; `undefined` for anything malformed or whose key id does not match its keys. */
export function parseMachineKeys(text: string): MachineKeys | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const fields = parsed as Record<string, unknown>;
  const names = ['keyId', 'encryptionKey', 'encryptionPrivate', 'signingKey', 'signingPrivate'] as const;
  if (names.some((name) => typeof fields[name] !== 'string')) {
    return undefined;
  }
  const keys = Object.fromEntries(names.map((name) => [name, fields[name]])) as unknown as MachineKeys;
  return keyIdOf(keys) === keys.keyId ? keys : undefined;
}
```

- [ ] **Step 4: Write `sign.ts`**

Create `packages/engine/src/team-secrets/sign.ts`:

```ts
/**
 * Signatures over team-secrets files (§4): Ed25519 over the canonical JSON (keys sorted at every depth, no
 * whitespace, `undefined` dropped) of the document without its `signature` field. YAML formatting, key
 * order in the file and line endings therefore never change what was signed.
 */
import { sign, verify } from 'node:crypto';
import { base64url, fromBase64url, signingPrivateKey, signingPublicKey, type MachineKeys } from './keys.js';

export type Signed<T> = T & { readonly signature: string };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** A shallow copy of `doc` without its `signature` field. */
export function withoutSignature(doc: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  delete copy['signature'];
  return copy;
}

function signedBytes(doc: object): Buffer {
  return Buffer.from(canonicalJson(withoutSignature(doc)), 'utf8');
}

/** `doc` with a fresh `signature` by `keys`; an existing signature is replaced. */
export function signDocument<T extends object>(doc: T, keys: MachineKeys): Signed<T> {
  const signature = base64url(sign(null, signedBytes(doc), signingPrivateKey(keys)));
  return { ...(withoutSignature(doc) as T), signature };
}

/** Whether `doc.signature` is `signingKey`'s signature over the rest of `doc`. Never throws. */
export function verifyDocument(doc: { readonly signature: string }, signingKey: string): boolean {
  try {
    return verify(null, signedBytes(doc), signingPublicKey(signingKey), fromBase64url(doc.signature));
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Write `errors.ts` and `envelope.ts`**

Create `packages/engine/src/team-secrets/errors.ts`:

```ts
import { WirebenchError } from '../errors.js';

/** The user-facing team-secrets failures (spec §3.8), one message each. */
export const TEAM_SECRETS_MESSAGES = {
  'team-secrets-pending': 'This machine is waiting for an admin to approve it for team secrets.',
  'team-secrets-no-safe-storage':
    'Team secrets need the system keychain, which is not available on this machine.',
  'team-secrets-admin-only': 'Only a workspace admin can change who has access to team secrets.',
  'team-secrets-untrusted': 'Ignored a secret signed by a key that is not approved.',
  'team-secrets-last-admin': 'A workspace needs at least one admin for team secrets.',
} as const;

export type TeamSecretsErrorCode = keyof typeof TEAM_SECRETS_MESSAGES;

export function teamSecretsError(
  code: TeamSecretsErrorCode,
  details?: Readonly<Record<string, unknown>>,
): WirebenchError {
  return new WirebenchError(code, TEAM_SECRETS_MESSAGES[code], details !== undefined ? { details } : undefined);
}
```

Create `packages/engine/src/team-secrets/envelope.ts`:

```ts
/**
 * The vault envelope (§4): a value is encrypted once with a random data key (AES-256-GCM, the vault entry id
 * as additional data, so a cipher cannot be moved to another secret), and the data key is wrapped for each
 * approved machine. A wrap is a fresh ephemeral X25519 public key, a nonce and the sealed data key; the
 * sealing key is HKDF-SHA256 of the ECDH secret, salted with both public keys.
 *
 * Every binary field is base64url: `nonce || ciphertext || tag` for a cipher, `ephemeral || nonce ||
 * sealed || tag` for a wrap.
 */
import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import {
  base64url,
  encryptionPrivateKey,
  encryptionPublicKey,
  fromBase64url,
  type MachineKeys,
} from './keys.js';

export const WRAP_INFO = 'wirebench-team-secrets-v1-wrap';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;

function failed(cause?: unknown): WirebenchError {
  return new WirebenchError('team-secrets-decrypt-failed', 'A team secret could not be decrypted.', {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw failed();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch (error) {
    throw failed(error);
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptValue(value: string, dataKey: Buffer, entryId: string): string {
  return base64url(seal(dataKey, Buffer.from(value, 'utf8'), Buffer.from(entryId, 'utf8')));
}

/** @throws WirebenchError `team-secrets-decrypt-failed` */
export function decryptValue(cipher: string, dataKey: Buffer, entryId: string): string {
  return open(dataKey, fromBase64url(cipher), Buffer.from(entryId, 'utf8')).toString('utf8');
}

function wrapKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), WRAP_INFO, KEY_BYTES));
}

export function wrapDataKey(dataKey: Buffer, recipientEncryptionKey: string): string {
  const pair = generateKeyPairSync('x25519');
  const ephemeral = fromBase64url(String(pair.publicKey.export({ format: 'jwk' }).x));
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: encryptionPublicKey(recipientEncryptionKey) });
  const key = wrapKey(shared, ephemeral, fromBase64url(recipientEncryptionKey));
  return base64url(Buffer.concat([ephemeral, seal(key, dataKey)]));
}

/** @throws WirebenchError `team-secrets-decrypt-failed` */
export function unwrapDataKey(wrap: string, keys: MachineKeys): Buffer {
  const bytes = fromBase64url(wrap);
  if (bytes.length < PUBLIC_KEY_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw failed();
  }
  const ephemeral = bytes.subarray(0, PUBLIC_KEY_BYTES);
  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: encryptionPrivateKey(keys),
      publicKey: encryptionPublicKey(base64url(ephemeral)),
    });
  } catch (error) {
    throw failed(error);
  }
  return open(wrapKey(shared, ephemeral, fromBase64url(keys.encryptionKey)), bytes.subarray(PUBLIC_KEY_BYTES));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/crypto.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/team-secrets/keys.ts packages/engine/src/team-secrets/sign.ts \
  packages/engine/src/team-secrets/envelope.ts packages/engine/src/team-secrets/errors.ts \
  packages/engine/test/unit/team-secrets/crypto.test.ts
git commit -m "feat(engine): team secrets keys, signatures and envelope (#38)

Machine keys are an X25519 pair to decrypt and an Ed25519 pair to sign, carried as base64url of their raw
bytes; the key id and the fingerprint both come from SHA-256 over the two public keys. Documents are signed
over canonical JSON without their signature, so YAML formatting never changes what was signed. A value is
sealed once with a random data key and the vault entry id as additional data; the data key is wrapped per
recipient through ECDH and HKDF. All of it is node:crypto."
```

---

## Task 2: engine files, tree paths and the access-log replay

**Files:**
- Create: `packages/engine/src/team-secrets/schema.ts`
- Create: `packages/engine/src/team-secrets/log.ts`
- Create: `packages/engine/src/secrets/secret-refs.ts`
- Modify: `packages/engine/src/workspace/paths.ts:58` (after `GIT_ATTRIBUTES_FILE`), `:65-66` (`GIT_ATTRIBUTES`)
- Modify: `packages/engine/src/workspace/index.ts:30` (export `TEAM_SECRETS_DIR`)
- Modify: `packages/engine/src/sync/tree-paths.ts:9-23` (`TREE_ITEMS`)
- Modify: `packages/engine/src/workspace/commit-message.ts:15-27` (`TreeEntityKind`), `:119` (`describeTreePath`),
  `:145-157` (`LABELS`)
- Test: `packages/engine/test/unit/team-secrets/log.test.ts` (new),
  `packages/engine/test/unit/team-secrets/schema.test.ts` (new),
  `packages/engine/test/unit/secrets/secret-refs.test.ts` (new),
  `packages/engine/test/unit/sync/tree-paths.test.ts:17`, `packages/engine/test/unit/workspace/commit-message.test.ts`

**Interfaces:**
- Consumes: Task 1's `KEY_ID_PATTERN`, `MachineKeys`, `keyIdOf`, `fingerprintOf`, `base32`, `verifyDocument`,
  `signDocument`; `stringifyYaml`, `parseYaml` (`project/yaml.ts`); `SECRET_NAME_PATTERN` (`secrets/secret-token.ts`).
- Produces:
  - `workspace/paths.ts`: `export const TEAM_SECRETS_DIR = 'team-secrets'`; `GIT_ATTRIBUTES` ends with
    `team-secrets/values/** -merge\n`.
  - `TREE_ITEMS = ['workspace.yaml', 'environments', 'projects', '.gitattributes', 'team-secrets']`.
  - `TreeEntityKind` gains `'team-secrets'` (label `team secrets file`).
  - `schema.ts`: `TEAM_SECRETS_FORMAT_VERSION = 1`, `keyIdSchema`, `ULID_PATTERN`, `ACCESS_ACTIONS`,
    `type AccessAction`, `keyRequestFileSchema`, `accessEntryFileSchema`, `secretKeySchema`,
    `vaultEntryFileSchema`, types `KeyRequestFile`, `AccessEntryFile`, `VaultEntryFile`, `SecretKey`;
    `TEAM_SECRETS_KEYS_DIR`, `TEAM_SECRETS_ACCESS_DIR`, `TEAM_SECRETS_VALUES_DIR`;
    `keyRequestPath(keyId)`, `accessEntryPath(id)`, `vaultEntryPath(id)`, `isTeamSecretsPath(path)`,
    `isVaultEntryPath(path)`, `vaultEntryIdOfPath(path): string | undefined`, `vaultEntryId(secret: SecretKey)`,
    `sameSecret(a: SecretKey, b: SecretKey): boolean`, `teamSecretsFileText(doc: object): string`,
    `parseTeamSecretsFile<S extends z.ZodType>(schema: S, text: string): z.infer<S> | undefined`,
    `interface TeamSecretsFiles { keys: KeyRequestFile[]; access: AccessEntryFile[]; values: Map<string, VaultEntryFile>; invalid: string[] }`,
    `readTeamSecretsFiles(files: ReadonlyMap<string, string>): TeamSecretsFiles`.
  - `log.ts`: `interface KeyInfo { keyId; encryptionKey; signingKey; name; email; machine; requestedAt; fingerprint }`,
    `interface Removal { keyId; at; by; entryId }`, `type LogProblem`,
    `interface AccessState { on; authority?; genesisId?; keys; approved; admins; removed; problems }`,
    `verifiedKeys(files: readonly KeyRequestFile[]): Map<string, KeyInfo>`,
    `replayAccessLog(keys: ReadonlyMap<string, KeyInfo>, entries: readonly AccessEntryFile[], options?: { readonly genesisId?: string }): AccessState`,
    `nextAccessEntryId(existing: readonly string[], now: number): string` (a ULID after every existing one, so a
    slow clock cannot slot an entry before the genesis — spec §15).
  - `secrets/secret-refs.ts`: `SECRET_REF_PATTERN`, `secretRefsInValue(value: unknown): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/test/unit/team-secrets/log.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { generateMachineKeys, type MachineKeys } from '../../../src/team-secrets/keys.js';
import { nextAccessEntryId, replayAccessLog, verifiedKeys } from '../../../src/team-secrets/log.js';
import type { AccessAction, AccessEntryFile, KeyRequestFile } from '../../../src/team-secrets/schema.js';
import { signDocument } from '../../../src/team-secrets/sign.js';

let clock = Date.parse('2026-09-26T10:00:00.000Z');

function request(keys: MachineKeys, name: string): KeyRequestFile {
  return signDocument(
    {
      version: 1 as const,
      keyId: keys.keyId,
      encryptionKey: keys.encryptionKey,
      signingKey: keys.signingKey,
      name,
      email: `${name.toLowerCase()}@example.test`,
      machine: `${name.toLowerCase()}-laptop`,
      requestedAt: '2026-09-26T09:00:00.000Z',
    },
    keys,
  );
}

function entry(
  action: AccessAction,
  key: MachineKeys,
  by: MachineKeys,
  extra: { authority?: 'signed' | 'server' } = {},
): AccessEntryFile {
  clock += 1000;
  return signDocument(
    {
      version: 1 as const,
      id: ulid(clock),
      action,
      ...extra,
      key: key.keyId,
      by: by.keyId,
      at: new Date(clock).toISOString(),
    },
    by,
  );
}

const alice = generateMachineKeys();
const bob = generateMachineKeys();
const carol = generateMachineKeys();
const keys = verifiedKeys([request(alice, 'Alice'), request(bob, 'Bob'), request(carol, 'Carol')]);

describe('verifiedKeys', () => {
  it('keeps self-signed requests whose id matches their keys, with a fingerprint', () => {
    expect([...keys.keys()].sort()).toEqual([alice.keyId, bob.keyId, carol.keyId].sort());
    expect(keys.get(alice.keyId)?.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  });

  it('drops a request signed by another key, or naming another key id', () => {
    const forged = { ...request(bob, 'Bob'), name: 'Mallory' };
    const renamed = { ...request(bob, 'Bob'), keyId: alice.keyId };
    expect(verifiedKeys([forged, renamed]).size).toBe(0);
  });
});

describe('replayAccessLog (signed authority)', () => {
  it('is off without a genesis', () => {
    const state = replayAccessLog(keys, []);
    expect(state.on).toBe(false);
    expect(state.approved.size).toBe(0);
  });

  it('replays in ULID order whatever order the files are listed in', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approve = entry('approve', bob, alice);
    const grant = entry('grant-admin', bob, alice);
    const revoke = entry('revoke-admin', alice, bob);
    const state = replayAccessLog(keys, [revoke, grant, approve, genesis]);
    expect(state.authority).toBe('signed');
    expect([...state.approved].sort()).toEqual([alice.keyId, bob.keyId].sort());
    expect([...state.admins]).toEqual([bob.keyId]);
    expect(state.problems).toEqual([]);
  });

  it('ignores an approval signed by a non-admin, and one with a bad signature', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approveBob = entry('approve', bob, alice);
    const bobApprovesCarol = entry('approve', carol, bob);
    const tampered = { ...entry('approve', carol, alice), key: bob.keyId };
    const state = replayAccessLog(keys, [genesis, approveBob, bobApprovesCarol, tampered]);
    expect(state.approved.has(carol.keyId)).toBe(false);
    expect(state.problems).toEqual([
      { id: bobApprovesCarol.id, problem: 'not-allowed' },
      { id: tampered.id, problem: 'bad-signature' },
    ]);
  });

  it('removes a key for good and records when, and refuses to remove or revoke the last admin', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'signed' });
    const approve = entry('approve', bob, alice);
    const remove = entry('remove', bob, alice);
    const again = entry('approve', bob, alice);
    const lastRevoke = entry('revoke-admin', alice, alice);
    const lastRemove = entry('remove', alice, alice);
    const state = replayAccessLog(keys, [genesis, approve, remove, again, lastRevoke, lastRemove]);
    expect([...state.approved]).toEqual([alice.keyId]);
    expect(state.removed).toEqual([{ keyId: bob.keyId, at: remove.at, by: alice.keyId, entryId: remove.id }]);
    expect(state.problems.map((p) => p.problem)).toEqual(['removed-key', 'last-admin', 'last-admin']);
  });

  it('refuses a second genesis, and honours only the pinned one', () => {
    const first = entry('genesis', alice, alice, { authority: 'signed' });
    const second = entry('genesis', bob, bob, { authority: 'signed' });
    expect(replayAccessLog(keys, [first, second]).problems).toEqual([{ id: second.id, problem: 'second-genesis' }]);

    // A backdated genesis sorts first; the pin keeps the one this machine saw.
    clock -= 60_000;
    const backdated = entry('genesis', carol, carol, { authority: 'signed' });
    const pinned = replayAccessLog(keys, [first, backdated], { genesisId: first.id });
    expect(pinned.genesisId).toBe(first.id);
    expect(pinned.approved.has(carol.keyId)).toBe(false);
  });
});

describe('nextAccessEntryId', () => {
  it('sorts after every existing entry even when this clock is behind', () => {
    const later = ulid(Date.parse('2030-01-01T00:00:00.000Z'));
    const next = nextAccessEntryId([ulid(clock), later], clock);
    expect(next > later).toBe(true);
    expect(nextAccessEntryId([], clock) > ulid(clock - 1000)).toBe(true);
  });
});

describe('replayAccessLog (server authority)', () => {
  it('accepts an approval by any approved key, and has no admin entries', () => {
    const genesis = entry('genesis', alice, alice, { authority: 'server' });
    const approveBob = entry('approve', bob, alice);
    const bobApprovesCarol = entry('approve', carol, bob);
    const grant = entry('grant-admin', bob, alice);
    const state = replayAccessLog(keys, [genesis, approveBob, bobApprovesCarol, grant]);
    expect([...state.approved].sort()).toEqual([alice.keyId, bob.keyId, carol.keyId].sort());
    expect(state.admins.size).toBe(0);
    expect(state.problems).toEqual([{ id: grant.id, problem: 'wrong-authority' }]);
  });
});
```

Create `packages/engine/test/unit/team-secrets/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateMachineKeys } from '../../../src/team-secrets/keys.js';
import {
  accessEntryPath,
  isTeamSecretsPath,
  isVaultEntryPath,
  keyRequestFileSchema,
  keyRequestPath,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  teamSecretsFileText,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
} from '../../../src/team-secrets/schema.js';
import { signDocument } from '../../../src/team-secrets/sign.js';

describe('team-secrets paths and ids', () => {
  it('derives a stable 26-character id per secret, different for a ref and a token', () => {
    const ref = vaultEntryId({ ref: 'sec_0123456789abcdef0123456789' });
    expect(ref).toMatch(/^[A-Z2-7]{26}$/);
    expect(vaultEntryId({ ref: 'sec_0123456789abcdef0123456789' })).toBe(ref);
    expect(vaultEntryId({ token: { projectId: 'P', name: 'api_key' } })).not.toBe(ref);
    expect(vaultEntryId({ token: { projectId: 'P', name: 'api_key' } })).not.toBe(
      vaultEntryId({ token: { projectId: 'Q', name: 'api_key' } }),
    );
  });

  it('recognises exactly the three kinds of team-secrets file', () => {
    const id = vaultEntryId({ ref: 'sec_x' });
    expect(isTeamSecretsPath(vaultEntryPath(id))).toBe(true);
    expect(isVaultEntryPath(vaultEntryPath(id))).toBe(true);
    expect(vaultEntryIdOfPath(vaultEntryPath(id))).toBe(id);
    expect(isVaultEntryPath(keyRequestPath('A'.repeat(26)))).toBe(false);
    expect(isTeamSecretsPath(accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'))).toBe(true);
    for (const path of ['team-secrets/other/X.yaml', 'team-secrets/values/x.yaml', 'team-secrets/values', 'projects/a.yaml']) {
      expect(isTeamSecretsPath(path)).toBe(false);
    }
  });
});

describe('reading the tree', () => {
  it('parses valid files, and lists malformed ones or ones whose name does not match their id', () => {
    const keys = generateMachineKeys();
    const doc = signDocument(
      {
        version: 1 as const,
        keyId: keys.keyId,
        encryptionKey: keys.encryptionKey,
        signingKey: keys.signingKey,
        name: 'Alex Doe',
        email: 'alex@example.com',
        machine: 'alex-mbp',
        requestedAt: '2026-09-26T10:00:00.000Z',
      },
      keys,
    );
    const text = teamSecretsFileText(doc);
    expect(parseTeamSecretsFile(keyRequestFileSchema, text)).toEqual(doc);
    const other = 'B'.repeat(26);
    const files = readTeamSecretsFiles(
      new Map([
        [keyRequestPath(keys.keyId), text],
        [keyRequestPath(other), text],
        [accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'), 'version: [unclosed'],
      ]),
    );
    expect(files.keys).toEqual([doc]);
    expect(files.invalid.sort()).toEqual([accessEntryPath('01J8ZK6Q3V4W5X6Y7Z8A9B0C1D'), keyRequestPath(other)].sort());
  });
});
```

Create `packages/engine/test/unit/secrets/secret-refs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { secretRefsInValue } from '../../../src/secrets/secret-refs.js';

describe('secretRefsInValue', () => {
  it('finds every keychain reference anywhere in a model, once each, and nothing else', () => {
    const model = {
      auth: { type: 'basic', passwordRef: 'sec_0123456789abcdef0123456789' },
      apis: [{ auth: { tokenRef: 'sec_fedcba9876543210fedcba9876' } }, { note: 'sec_0123456789abcdef0123456789' }],
      name: 'sec_', // too short
      other: 'Sec_0123456789abcdef0123456789',
    };
    expect(secretRefsInValue(model).sort()).toEqual(
      ['sec_0123456789abcdef0123456789', 'sec_fedcba9876543210fedcba9876'].sort(),
    );
  });
});
```

In `packages/engine/test/unit/sync/tree-paths.test.ts`, change `:17` to:

```ts
    expect([...TREE_ITEMS]).toEqual(['workspace.yaml', 'environments', 'projects', '.gitattributes', 'team-secrets']);
```

and add to the `accepts %s and returns it unchanged` table, after `['an environment', 'environments/qa.yaml'],`:

```ts
    ['a vault entry', 'team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml'],
```

In `packages/engine/test/unit/workspace/commit-message.test.ts`, append inside `describe('describeTreePath', …)`
before its closing `});`:

```ts
  it('classifies the team-secrets files, and a vault-only change reads as one kind', () => {
    expect(describeTreePath('team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml')).toEqual({
      kind: 'team-secrets',
      name: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      key: 'team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml',
    });
    const changes: TreeChange[] = [
      { path: 'team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml', status: 'modified' },
      { path: 'team-secrets/values/BBCDEFGHIJKLMNOPQRSTUVWXYZ.yaml', status: 'modified' },
    ];
    expect(commitMessage(changes).split('\n\n')[0]).toBe('Update 2 team secrets files');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/ packages/engine/test/unit/secrets/secret-refs.test.ts packages/engine/test/unit/sync/tree-paths.test.ts packages/engine/test/unit/workspace/commit-message.test.ts`
Expected: FAIL — `schema.ts`, `log.ts` and `secret-refs.ts` do not exist; `TREE_ITEMS` has four items;
`describeTreePath` answers `other`.

- [ ] **Step 3: Paths, tree item, attributes and the commit kind**

In `packages/engine/src/workspace/paths.ts`, after `export const GIT_ATTRIBUTES_FILE = '.gitattributes';` add:

```ts
/** Directory at the tree root holding team secrets: key requests, the access log and the vault (team-secrets §4). */
export const TEAM_SECRETS_DIR = 'team-secrets';
```

and replace the `GIT_ATTRIBUTES` string with (one line added at the end, and the doc comment gains the last sentence):

```ts
/**
 * Contents of {@link GIT_ATTRIBUTES_FILE}: normalises line endings, and leaves bytes alone where
 * they must stay exact — attachments, and the definition caches of interfaces and APIs, which keep
 * each document as fetched (a WSDL's manifest records its SHA-256, so a CRLF definition normalised
 * by git fails that check on the other side, which then re-fetches and rewrites the cache). A vault
 * entry is never text-merged: two concurrent changes are a conflict the sync settles whole.
 */
export const GIT_ATTRIBUTES =
  '* text=auto eol=lf\n*.yaml text\n*.xml text\n*.wsdl text\n*.xsd text\nprojects/*/attachments/** -text\nprojects/*/interfaces/*/definition/** -text\nprojects/*/apis/*/definition/** -text\nteam-secrets/values/** -merge\n';
```

In `packages/engine/src/workspace/index.ts`, add `TEAM_SECRETS_DIR,` after `GIT_ATTRIBUTES,` in the `./paths.js`
export list.

In `packages/engine/src/sync/tree-paths.ts`, add `TEAM_SECRETS_DIR,` to the `../workspace/paths.js` import and
replace `TREE_ITEMS`:

```ts
/** Everything that makes up a workspace tree, in the order a share moves them (formerly private to the desktop's workspace-share.ts). */
export const TREE_ITEMS = [
  WORKSPACE_MANIFEST,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_PROJECTS_DIR,
  GIT_ATTRIBUTES_FILE,
  TEAM_SECRETS_DIR,
] as const;
```

In `packages/engine/src/workspace/commit-message.ts`, import `TEAM_SECRETS_DIR` from `./paths.js`, add
`| 'team-secrets'` before `| 'other'` in `TreeEntityKind`, add `'team-secrets': 'team secrets file',` before
`other: 'file',` in `LABELS`, and in `describeTreePath` insert before the final `return { kind: 'other', … }`:

```ts
  const teamSecretsMatch = new RegExp(`^${TEAM_SECRETS_DIR}/(?:keys|access|values)/([^/]+)\\.yaml$`).exec(relativePath);
  if (teamSecretsMatch !== null) {
    return { kind: 'team-secrets', name: teamSecretsMatch[1] ?? basename(relativePath), key: relativePath };
  }
```

- [ ] **Step 4: Write `secret-refs.ts`**

Create `packages/engine/src/secrets/secret-refs.ts`:

```ts
/**
 * The keychain references (`sec_…`) a model carries, wherever they sit: an auth's `passwordRef`, a
 * `tokenRef`, a `valueRef`, an OAuth client secret. Team secrets back-fill the vault from them (§3.1).
 * Pure: no I/O.
 */

/** The shape `SecretStore` mints (`sec_` and lowercase hex); a little looser, so an older ref still counts. */
export const SECRET_REF_PATTERN = /^sec_[0-9a-z]{16,64}$/;

export function secretRefsInValue(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (SECRET_REF_PATTERN.test(current)) {
        found.add(current);
      }
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current !== null && typeof current === 'object' && !ArrayBuffer.isView(current)) {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}
```

- [ ] **Step 5: Write `schema.ts`**

Create `packages/engine/src/team-secrets/schema.ts`:

```ts
/**
 * The three kinds of file under `team-secrets/` (§4): key requests, access-log entries and vault entries,
 * one YAML document each, written by the engine's serializer. Binary fields are base64url without padding.
 * Parsing never throws: a malformed or misnamed file is listed in `invalid` and otherwise ignored.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseYaml, stringifyYaml } from '../project/yaml.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
import { TEAM_SECRETS_DIR } from '../workspace/paths.js';
import { base32, KEY_ID_PATTERN } from './keys.js';

export const TEAM_SECRETS_FORMAT_VERSION = 1;

/** A Crockford-base32 ULID, as `ulidx` writes it. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** 32 bytes as base64url without padding. */
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const isoSchema = z.iso.datetime({ offset: true });

export const keyIdSchema = z.string().regex(KEY_ID_PATTERN);

export const keyRequestFileSchema = z.object({
  version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
  keyId: keyIdSchema,
  encryptionKey: publicKeySchema,
  signingKey: publicKeySchema,
  name: z.string().min(1).max(200),
  email: z.string().max(320),
  machine: z.string().min(1).max(200),
  requestedAt: isoSchema,
  signature: base64urlSchema,
});
export type KeyRequestFile = z.infer<typeof keyRequestFileSchema>;

export const ACCESS_ACTIONS = ['genesis', 'approve', 'remove', 'grant-admin', 'revoke-admin'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const accessEntryFileSchema = z.object({
  version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
  id: z.string().regex(ULID_PATTERN),
  action: z.enum(ACCESS_ACTIONS),
  authority: z.enum(['signed', 'server']).optional(),
  key: keyIdSchema,
  by: keyIdSchema,
  at: isoSchema,
  signature: base64urlSchema,
});
export type AccessEntryFile = z.infer<typeof accessEntryFileSchema>;

/** Which secret an entry holds: a keychain ref as the tree names it, or a `${secret:name}` token of one project. */
export const secretKeySchema = z.union([
  z.strictObject({ ref: z.string().min(1).max(200) }),
  z.strictObject({
    token: z.strictObject({ projectId: z.string().min(1).max(200), name: z.string().regex(SECRET_NAME_PATTERN) }),
  }),
]);
export type SecretKey = z.infer<typeof secretKeySchema>;

export const vaultEntryFileSchema = z.object({
  version: z.literal(TEAM_SECRETS_FORMAT_VERSION),
  secret: secretKeySchema,
  /** The display label, never the value. */
  label: z.string().max(200),
  cipher: base64urlSchema,
  wraps: z.record(keyIdSchema, base64urlSchema),
  /** When the value was last set; rewraps keep it (plan decision 5). */
  updatedAt: isoSchema,
  /** The key that signed this version. */
  updatedBy: keyIdSchema,
  signature: base64urlSchema,
});
export type VaultEntryFile = z.infer<typeof vaultEntryFileSchema>;

export const TEAM_SECRETS_KEYS_DIR = `${TEAM_SECRETS_DIR}/keys`;
export const TEAM_SECRETS_ACCESS_DIR = `${TEAM_SECRETS_DIR}/access`;
export const TEAM_SECRETS_VALUES_DIR = `${TEAM_SECRETS_DIR}/values`;

export function keyRequestPath(keyId: string): string {
  return `${TEAM_SECRETS_KEYS_DIR}/${keyId}.yaml`;
}

export function accessEntryPath(id: string): string {
  return `${TEAM_SECRETS_ACCESS_DIR}/${id}.yaml`;
}

export function vaultEntryPath(id: string): string {
  return `${TEAM_SECRETS_VALUES_DIR}/${id}.yaml`;
}

const TEAM_SECRETS_FILE = new RegExp(`^${TEAM_SECRETS_DIR}/(keys|access|values)/([0-9A-Z]{26})\\.yaml$`);

export function isTeamSecretsPath(path: string): boolean {
  return TEAM_SECRETS_FILE.test(path);
}

export function isVaultEntryPath(path: string): boolean {
  return TEAM_SECRETS_FILE.exec(path)?.[1] === 'values';
}

export function vaultEntryIdOfPath(path: string): string | undefined {
  const match = TEAM_SECRETS_FILE.exec(path);
  return match?.[1] === 'values' ? match[2] : undefined;
}

/** Plan decision 3: base32 of SHA-256 over `ref:<ref>` or `token:<projectId>\n<name>`, first 26 characters. */
export function vaultEntryId(secret: SecretKey): string {
  const text = 'ref' in secret ? `ref:${secret.ref}` : `token:${secret.token.projectId}\n${secret.token.name}`;
  return base32(createHash('sha256').update(text, 'utf8').digest()).slice(0, 26);
}

export function sameSecret(a: SecretKey, b: SecretKey): boolean {
  return vaultEntryId(a) === vaultEntryId(b);
}

export function teamSecretsFileText(doc: object): string {
  return stringifyYaml(doc);
}

export function parseTeamSecretsFile<S extends z.ZodType>(schema: S, text: string): z.infer<S> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, 'team-secrets');
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Everything under `team-secrets/`, parsed. `values` is keyed by the file's id. */
export interface TeamSecretsFiles {
  readonly keys: KeyRequestFile[];
  readonly access: AccessEntryFile[];
  readonly values: Map<string, VaultEntryFile>;
  /** Tree paths that are malformed, or whose name is not their id. */
  readonly invalid: string[];
}

/** Parses the tree's team-secrets files, given as tree path → text. Other paths are ignored. */
export function readTeamSecretsFiles(files: ReadonlyMap<string, string>): TeamSecretsFiles {
  const out: TeamSecretsFiles = { keys: [], access: [], values: new Map(), invalid: [] };
  for (const [path, text] of files) {
    const match = TEAM_SECRETS_FILE.exec(path);
    if (match === null) {
      continue;
    }
    const [, kind, name] = match;
    if (kind === 'keys') {
      const doc = parseTeamSecretsFile(keyRequestFileSchema, text);
      if (doc !== undefined && doc.keyId === name) {
        out.keys.push(doc);
      } else {
        out.invalid.push(path);
      }
    } else if (kind === 'access') {
      const doc = parseTeamSecretsFile(accessEntryFileSchema, text);
      if (doc !== undefined && doc.id === name) {
        out.access.push(doc);
      } else {
        out.invalid.push(path);
      }
    } else {
      const doc = parseTeamSecretsFile(vaultEntryFileSchema, text);
      if (doc !== undefined && name !== undefined) {
        out.values.set(name, doc);
      } else {
        out.invalid.push(path);
      }
    }
  }
  return out;
}
```

- [ ] **Step 6: Write `log.ts`**

Create `packages/engine/src/team-secrets/log.ts`:

```ts
/**
 * The access log (§2, §3.7): `access/<ulid>.yaml` entries replayed in ULID order give the approved keys
 * and the admins. With `authority: signed` (git and folder shares) an entry counts only when an admin at
 * that point of the replay signed it; with `authority: server` any approved key's signature counts, and
 * the server refuses a non-admin's push to `access/` (§5.1). Invalid entries are skipped and listed.
 */
import { decodeTime, ulid } from 'ulidx';
import { fingerprintOf, keyIdOf } from './keys.js';
import type { AccessEntryFile, KeyRequestFile } from './schema.js';
import { verifyDocument } from './sign.js';

/** A key request that proved possession of its keys. */
export interface KeyInfo {
  readonly keyId: string;
  readonly encryptionKey: string;
  readonly signingKey: string;
  readonly name: string;
  readonly email: string;
  readonly machine: string;
  readonly requestedAt: string;
  readonly fingerprint: string;
}

export interface Removal {
  readonly keyId: string;
  readonly at: string;
  readonly by: string;
  readonly entryId: string;
}

export type LogProblem =
  | 'unknown-signer'
  | 'bad-signature'
  | 'second-genesis'
  | 'no-genesis'
  | 'not-allowed'
  | 'unknown-key'
  | 'already-approved'
  | 'removed-key'
  | 'not-approved'
  | 'last-admin'
  | 'wrong-authority';

export interface AccessState {
  /** A valid genesis was replayed. */
  readonly on: boolean;
  readonly authority?: 'signed' | 'server';
  readonly genesisId?: string;
  readonly keys: ReadonlyMap<string, KeyInfo>;
  readonly approved: ReadonlySet<string>;
  /** Always empty with `authority: server`. */
  readonly admins: ReadonlySet<string>;
  readonly removed: readonly Removal[];
  readonly problems: readonly { readonly id: string; readonly problem: LogProblem }[];
}

/** The key requests whose id matches their keys and whose self-signature verifies, by key id. */
export function verifiedKeys(files: readonly KeyRequestFile[]): Map<string, KeyInfo> {
  const keys = new Map<string, KeyInfo>();
  for (const file of files) {
    if (keyIdOf(file) !== file.keyId || !verifyDocument(file, file.signingKey)) {
      continue;
    }
    keys.set(file.keyId, {
      keyId: file.keyId,
      encryptionKey: file.encryptionKey,
      signingKey: file.signingKey,
      name: file.name,
      email: file.email,
      machine: file.machine,
      requestedAt: file.requestedAt,
      fingerprint: fingerprintOf(file),
    });
  }
  return keys;
}

/**
 * The id for a new access entry: a ULID for `now`, or just after the newest existing one when this
 * machine's clock is behind it, so the entry always replays after what its writer saw (§15 clock skew).
 */
export function nextAccessEntryId(existing: readonly string[], now: number): string {
  const last = existing.reduce<string | undefined>((max, id) => (max === undefined || id > max ? id : max), undefined);
  return ulid(last === undefined ? now : Math.max(now, decodeTime(last) + 1));
}

/**
 * Replays `entries` in ULID order. `genesisId`, when given, is the only entry allowed to be the genesis
 * (plan decision 4); without it the first valid genesis wins.
 */
export function replayAccessLog(
  keys: ReadonlyMap<string, KeyInfo>,
  entries: readonly AccessEntryFile[],
  options: { readonly genesisId?: string } = {},
): AccessState {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let authority: 'signed' | 'server' | undefined;
  let genesisId: string | undefined;
  const approved = new Set<string>();
  const admins = new Set<string>();
  const removedKeys = new Set<string>();
  const removed: Removal[] = [];
  const problems: { id: string; problem: LogProblem }[] = [];

  for (const entry of sorted) {
    const reject = (problem: LogProblem): void => {
      problems.push({ id: entry.id, problem });
    };
    const signer = keys.get(entry.by);
    if (signer === undefined) {
      reject('unknown-signer');
      continue;
    }
    if (!verifyDocument(entry, signer.signingKey)) {
      reject('bad-signature');
      continue;
    }
    if (entry.action === 'genesis') {
      if (authority !== undefined || (options.genesisId !== undefined && options.genesisId !== entry.id)) {
        reject('second-genesis');
        continue;
      }
      if (entry.key !== entry.by || entry.authority === undefined) {
        reject('not-allowed');
        continue;
      }
      authority = entry.authority;
      genesisId = entry.id;
      approved.add(entry.key);
      if (authority === 'signed') {
        admins.add(entry.key);
      }
      continue;
    }
    if (authority === undefined) {
      reject('no-genesis');
      continue;
    }
    const mayManage = authority === 'signed' ? admins.has(entry.by) : approved.has(entry.by);
    if (!mayManage) {
      reject('not-allowed');
      continue;
    }
    if (!keys.has(entry.key)) {
      reject('unknown-key');
      continue;
    }
    switch (entry.action) {
      case 'approve':
        if (removedKeys.has(entry.key)) {
          reject('removed-key');
        } else if (approved.has(entry.key)) {
          reject('already-approved');
        } else {
          approved.add(entry.key);
        }
        break;
      case 'remove':
        if (!approved.has(entry.key)) {
          reject('not-approved');
        } else if (authority === 'signed' && admins.has(entry.key) && admins.size === 1) {
          reject('last-admin');
        } else {
          approved.delete(entry.key);
          admins.delete(entry.key);
          removedKeys.add(entry.key);
          removed.push({ keyId: entry.key, at: entry.at, by: entry.by, entryId: entry.id });
        }
        break;
      case 'grant-admin':
        if (authority !== 'signed') {
          reject('wrong-authority');
        } else if (!approved.has(entry.key)) {
          reject('not-approved');
        } else {
          admins.add(entry.key);
        }
        break;
      case 'revoke-admin':
        if (authority !== 'signed') {
          reject('wrong-authority');
        } else if (!admins.has(entry.key)) {
          reject('not-approved');
        } else if (admins.size === 1) {
          reject('last-admin');
        } else {
          admins.delete(entry.key);
        }
        break;
    }
  }

  return {
    on: authority !== undefined,
    ...(authority !== undefined ? { authority } : {}),
    ...(genesisId !== undefined ? { genesisId } : {}),
    keys,
    approved,
    admins,
    removed,
    problems,
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/ packages/engine/test/unit/secrets/ packages/engine/test/unit/sync/ packages/engine/test/unit/workspace/`
Expected: PASS, the existing sync and workspace tests included.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/team-secrets/schema.ts packages/engine/src/team-secrets/log.ts \
  packages/engine/src/secrets/secret-refs.ts packages/engine/src/workspace/paths.ts \
  packages/engine/src/workspace/index.ts packages/engine/src/sync/tree-paths.ts \
  packages/engine/src/workspace/commit-message.ts packages/engine/test/unit/team-secrets/log.test.ts \
  packages/engine/test/unit/team-secrets/schema.test.ts packages/engine/test/unit/secrets/secret-refs.test.ts \
  packages/engine/test/unit/sync/tree-paths.test.ts packages/engine/test/unit/workspace/commit-message.test.ts
git commit -m "feat(engine): team secrets files and the access-log replay (#38)

team-secrets/ becomes a tree item beside workspace.yaml, environments, projects and .gitattributes, so
both ends of a server sync accept its paths, and vault entries are marked -merge so git never splices
two ciphertexts. Key requests, access entries and vault entries each have a zod schema; a vault entry's
id is a hash of the secret it holds. The replay orders entries by ULID, counts an entry only when its
signer may manage keys at that point, and lets a machine pin the genesis it first saw."
```

---

## Task 3: engine vault, the conflict winner and the exports

**Files:**
- Create: `packages/engine/src/team-secrets/vault.ts`
- Create: `packages/engine/src/team-secrets/resolve-conflict.ts`
- Create: `packages/engine/src/team-secrets/index.ts`
- Modify: `packages/engine/src/index.ts:867` (`TEAM_SECRETS_DIR` beside `GIT_ATTRIBUTES`), `:1131` (after the
  secret-scan exports: the team-secrets block)
- Test: `packages/engine/test/unit/team-secrets/vault.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–2 (`newDataKey`, `encryptValue`, `decryptValue`, `wrapDataKey`, `unwrapDataKey`,
  `signDocument`, `verifyDocument`, `withoutSignature`, `vaultEntryId`, `VaultEntryFile`, `SecretKey`, `KeyInfo`,
  `AccessState`).
- Produces (all exported from `@wirebench/engine`, with everything Tasks 1–2 made):
  - `buildVaultEntry(input: { secret: SecretKey; label: string; value: string; recipients: readonly KeyInfo[]; signer: MachineKeys; at: string }): VaultEntryFile`
  - `sealVaultEntry(entry: VaultEntryFile, value: string, recipients: readonly KeyInfo[], signer: MachineKeys): VaultEntryFile`
    (fresh data key; keeps `secret`, `label`, `updatedAt`)
  - `approvedRecipients(state: AccessState): KeyInfo[]`
  - `type VaultVerdict = 'trusted' | 'wrong-id' | 'not-approved' | 'bad-signature'`;
    `verifyVaultEntry(entry: VaultEntryFile, fileId: string, state: AccessState): VaultVerdict`
  - `openVaultEntry(entry: VaultEntryFile, me: MachineKeys): string | undefined`
  - `healVaultEntry(entry: VaultEntryFile, state: AccessState, me: MachineKeys): VaultEntryFile | undefined`
  - `wrapsUnapprovedKey(entry: VaultEntryFile, state: AccessState): boolean`
  - `interface RotateMark { entryId: string; label: string; secret: SecretKey; removedNames: string[] }`;
    `rotateMarks(values: ReadonlyMap<string, VaultEntryFile>, state: AccessState): RotateMark[]`
  - `vaultConflictWinner(mine: VaultEntryFile | undefined, theirs: VaultEntryFile | undefined): 'mine' | 'theirs'`
  - `SECRET_REF_PATTERN`, `secretRefsInValue`, `TEAM_SECRETS_DIR`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/unit/team-secrets/vault.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import {
  buildVaultEntry,
  generateMachineKeys,
  healVaultEntry,
  openVaultEntry,
  replayAccessLog,
  rotateMarks,
  sealVaultEntry,
  signDocument,
  vaultConflictWinner,
  vaultEntryId,
  verifiedKeys,
  verifyVaultEntry,
  wrapsUnapprovedKey,
  type AccessAction,
  type AccessEntryFile,
  type AccessState,
  type KeyInfo,
  type MachineKeys,
  type VaultEntryFile,
} from '../../../src/index.js';

let clock = Date.parse('2026-09-26T10:00:00.000Z');
const tick = (): string => new Date((clock += 1000)).toISOString();

function requestOf(keys: MachineKeys, name: string) {
  return signDocument(
    {
      version: 1 as const,
      keyId: keys.keyId,
      encryptionKey: keys.encryptionKey,
      signingKey: keys.signingKey,
      name,
      email: `${name}@example.test`,
      machine: name,
      requestedAt: tick(),
    },
    keys,
  );
}

function entry(action: AccessAction, key: MachineKeys, by: MachineKeys, authority?: 'signed'): AccessEntryFile {
  const at = tick();
  return signDocument(
    { version: 1 as const, id: ulid(Date.parse(at)), action, ...(authority ? { authority } : {}), key: key.keyId, by: by.keyId, at },
    by,
  );
}

const alice = generateMachineKeys();
const bob = generateMachineKeys();
const carol = generateMachineKeys();
const keys = verifiedKeys([requestOf(alice, 'alice'), requestOf(bob, 'bob'), requestOf(carol, 'carol')]);
const info = (k: MachineKeys): KeyInfo => keys.get(k.keyId)!;
const REF = { ref: 'sec_0123456789abcdef0123456789' } as const;

const genesis = entry('genesis', alice, alice, 'signed');
const approveBob = entry('approve', bob, alice);
const withBob = replayAccessLog(keys, [genesis, approveBob]);

function valueFor(value: string, state: AccessState, signer = alice): VaultEntryFile {
  return buildVaultEntry({
    secret: REF,
    label: 'Payments API key',
    value,
    recipients: [...state.approved].map((id) => keys.get(id)!),
    signer,
    at: tick(),
  });
}

describe('vault entries (§3.3, §3.4, §4)', () => {
  it('encrypts for every approved key, and only they can open it', () => {
    const written = valueFor('hunter2', withBob);
    expect(JSON.stringify(written)).not.toContain('hunter2');
    expect(Object.keys(written.wraps).sort()).toEqual([alice.keyId, bob.keyId].sort());
    expect(verifyVaultEntry(written, vaultEntryId(REF), withBob)).toBe('trusted');
    expect(openVaultEntry(written, alice)).toBe('hunter2');
    expect(openVaultEntry(written, bob)).toBe('hunter2');
    expect(openVaultEntry(written, carol)).toBeUndefined();
  });

  it('does not trust a moved entry, a signer that is not approved, or a changed field', () => {
    const written = valueFor('hunter2', withBob);
    expect(verifyVaultEntry(written, vaultEntryId({ ref: 'sec_other000000000000000000' }), withBob)).toBe('wrong-id');
    const byCarol = valueFor('x', withBob, carol);
    expect(verifyVaultEntry(byCarol, vaultEntryId(REF), withBob)).toBe('not-approved');
    expect(verifyVaultEntry({ ...written, label: 'Other' }, vaultEntryId(REF), withBob)).toBe('bad-signature');
  });

  it('cannot be opened once re-signed for another secret: the entry id is the cipher’s additional data', () => {
    const written = valueFor('hunter2', withBob);
    const other = { ref: 'sec_other000000000000000000' };
    const moved = signDocument({ ...written, secret: other }, alice);
    expect(verifyVaultEntry(moved, vaultEntryId(other), withBob)).toBe('trusted');
    expect(openVaultEntry(moved, alice)).toBeUndefined();
  });

  it('heals a missing wrap for a newly approved key, keeping the value time and the other wraps', () => {
    const written = valueFor('hunter2', withBob);
    const withCarol = replayAccessLog(keys, [genesis, approveBob, entry('approve', carol, alice)]);
    expect(healVaultEntry(written, withBob, bob)).toBeUndefined();
    expect(healVaultEntry(written, withCarol, carol)).toBeUndefined();
    const healed = healVaultEntry(written, withCarol, bob)!;
    expect(healed.updatedAt).toBe(written.updatedAt);
    expect(healed.updatedBy).toBe(bob.keyId);
    expect(healed.wraps[alice.keyId]).toBe(written.wraps[alice.keyId]);
    expect(verifyVaultEntry(healed, vaultEntryId(REF), withCarol)).toBe('trusted');
    expect(openVaultEntry(healed, carol)).toBe('hunter2');
  });

  it('seals again for the remaining keys after a removal, and marks what the removed key could read', () => {
    const before = valueFor('hunter2', withBob);
    const remove = entry('remove', bob, alice);
    const without = replayAccessLog(keys, [genesis, approveBob, remove]);
    expect(wrapsUnapprovedKey(before, without)).toBe(true);
    const sealed = sealVaultEntry(before, 'hunter2', [info(alice)], alice);
    expect(sealed.updatedAt).toBe(before.updatedAt);
    expect(sealed.cipher).not.toBe(before.cipher);
    expect(openVaultEntry(sealed, bob)).toBeUndefined();
    expect(wrapsUnapprovedKey(sealed, without)).toBe(false);

    const after = valueFor('rotated', without);
    const marks = rotateMarks(
      new Map([
        ['A'.repeat(26), sealed],
        ['B'.repeat(26), after],
      ]),
      without,
    );
    expect(marks).toEqual([
      { entryId: 'A'.repeat(26), label: 'Payments API key', secret: REF, removedNames: ['bob'] },
    ]);
  });
});

describe('vaultConflictWinner (§3.5)', () => {
  const at = (updatedAt: string, updatedBy: string): VaultEntryFile =>
    ({ updatedAt, updatedBy }) as unknown as VaultEntryFile;

  it('keeps the later value, the lower key id on a tie, and the side that still has the file', () => {
    expect(vaultConflictWinner(at('2026-09-26T10:00:01.000Z', 'B'), at('2026-09-26T10:00:00.000Z', 'A'))).toBe('mine');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), at('2026-09-26T10:00:01.000Z', 'B'))).toBe('theirs');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), at('2026-09-26T10:00:00.000Z', 'B'))).toBe('mine');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'B'), at('2026-09-26T10:00:00.000Z', 'A'))).toBe('theirs');
    expect(vaultConflictWinner(undefined, at('2026-09-26T10:00:00.000Z', 'A'))).toBe('theirs');
    expect(vaultConflictWinner(at('2026-09-26T10:00:00.000Z', 'A'), undefined)).toBe('mine');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/vault.test.ts`
Expected: FAIL — `@wirebench/engine`'s `src/index.ts` exports none of these names yet.

- [ ] **Step 3: Write `vault.ts` and `resolve-conflict.ts`**

Create `packages/engine/src/team-secrets/vault.ts`:

```ts
/**
 * Vault entries (§2, §3.3–§3.6): build one for the approved keys, verify it against the replayed log,
 * open it with this machine's key, seal it again with a fresh data key (removal, late re-encryption), heal
 * it with wraps for keys approved since, and say which values a removed key could read. Pure.
 */
import { decryptValue, encryptValue, newDataKey, unwrapDataKey, wrapDataKey } from './envelope.js';
import type { MachineKeys } from './keys.js';
import type { AccessState, KeyInfo } from './log.js';
import { vaultEntryId, type SecretKey, type VaultEntryFile } from './schema.js';
import { signDocument, verifyDocument, withoutSignature } from './sign.js';

type VaultBody = Omit<VaultEntryFile, 'signature'>;

function seal(
  body: { readonly secret: SecretKey; readonly label: string; readonly updatedAt: string },
  value: string,
  recipients: readonly KeyInfo[],
  signer: MachineKeys,
): VaultEntryFile {
  const dataKey = newDataKey();
  const wraps: Record<string, string> = {};
  for (const recipient of recipients) {
    wraps[recipient.keyId] = wrapDataKey(dataKey, recipient.encryptionKey);
  }
  return signDocument(
    {
      version: 1 as const,
      secret: body.secret,
      label: body.label,
      cipher: encryptValue(value, dataKey, vaultEntryId(body.secret)),
      wraps,
      updatedAt: body.updatedAt,
      updatedBy: signer.keyId,
    },
    signer,
  );
}

/** A new value (§3.3): fresh data key, wrapped for `recipients`, signed by `signer`, dated `at`. */
export function buildVaultEntry(input: {
  readonly secret: SecretKey;
  readonly label: string;
  readonly value: string;
  readonly recipients: readonly KeyInfo[];
  readonly signer: MachineKeys;
  readonly at: string;
}): VaultEntryFile {
  return seal({ secret: input.secret, label: input.label, updatedAt: input.at }, input.value, input.recipients, input.signer);
}

/** The same value under a fresh data key for `recipients` only (§3.6); the value time is kept. */
export function sealVaultEntry(
  entry: VaultEntryFile,
  value: string,
  recipients: readonly KeyInfo[],
  signer: MachineKeys,
): VaultEntryFile {
  return seal(entry, value, recipients, signer);
}

/** Every approved key the log has a verified request for. */
export function approvedRecipients(state: AccessState): KeyInfo[] {
  return [...state.approved].flatMap((keyId) => {
    const info = state.keys.get(keyId);
    return info === undefined ? [] : [info];
  });
}

export type VaultVerdict = 'trusted' | 'wrong-id' | 'not-approved' | 'bad-signature';

/** §6: trusted only when it sits under its own id and an approved key signed it. */
export function verifyVaultEntry(entry: VaultEntryFile, fileId: string, state: AccessState): VaultVerdict {
  if (vaultEntryId(entry.secret) !== fileId) {
    return 'wrong-id';
  }
  if (!state.approved.has(entry.updatedBy)) {
    return 'not-approved';
  }
  const signer = state.keys.get(entry.updatedBy);
  return signer !== undefined && verifyDocument(entry, signer.signingKey) ? 'trusted' : 'bad-signature';
}

/** The value, when `entry` is wrapped for `me` and opens; `undefined` otherwise. */
export function openVaultEntry(entry: VaultEntryFile, me: MachineKeys): string | undefined {
  const wrap = entry.wraps[me.keyId];
  if (wrap === undefined) {
    return undefined;
  }
  try {
    return decryptValue(entry.cipher, unwrapDataKey(wrap, me), vaultEntryId(entry.secret));
  } catch {
    return undefined;
  }
}

/**
 * §3.4 healing: `entry` with a wrap added for each approved key it lacks, under the same data key, re-signed
 * by `me`. `undefined` when nothing is missing or `me` cannot open the data key. Never removes a wrap.
 * Callers heal trusted entries only.
 */
export function healVaultEntry(entry: VaultEntryFile, state: AccessState, me: MachineKeys): VaultEntryFile | undefined {
  const missing = approvedRecipients(state).filter((recipient) => entry.wraps[recipient.keyId] === undefined);
  const mine = entry.wraps[me.keyId];
  if (missing.length === 0 || mine === undefined) {
    return undefined;
  }
  let dataKey: Buffer;
  try {
    dataKey = unwrapDataKey(mine, me);
  } catch {
    return undefined;
  }
  const wraps: Record<string, string> = { ...entry.wraps };
  for (const recipient of missing) {
    wraps[recipient.keyId] = wrapDataKey(dataKey, recipient.encryptionKey);
  }
  return signDocument({ ...(withoutSignature(entry) as VaultBody), wraps, updatedBy: me.keyId }, me);
}

/** Plan decision 6: the entry still carries a wrap for a key the log no longer approves. */
export function wrapsUnapprovedKey(entry: VaultEntryFile, state: AccessState): boolean {
  return Object.keys(entry.wraps).some((keyId) => !state.approved.has(keyId));
}

export interface RotateMark {
  readonly entryId: string;
  readonly label: string;
  readonly secret: SecretKey;
  /** The names on the removed keys that could read this value. */
  readonly removedNames: string[];
}

/**
 * §3.6: a value set before a removal was readable by the removed key (plan decision 5), so it is marked
 * until it changes. Pass trusted entries only, keyed by id.
 */
export function rotateMarks(values: ReadonlyMap<string, VaultEntryFile>, state: AccessState): RotateMark[] {
  const marks: RotateMark[] = [];
  for (const [entryId, entry] of values) {
    const setAt = Date.parse(entry.updatedAt);
    const names = state.removed
      .filter((removal) => setAt < Date.parse(removal.at))
      .map((removal) => state.keys.get(removal.keyId)?.name ?? removal.keyId);
    if (names.length > 0) {
      marks.push({ entryId, label: entry.label, secret: entry.secret, removedNames: [...new Set(names)] });
    }
  }
  return marks;
}
```

Create `packages/engine/src/team-secrets/resolve-conflict.ts`:

```ts
/**
 * §3.5: a vault entry is a whole-file value. Of two concurrent versions the later `updatedAt` wins, then
 * the lower `updatedBy`; a side without the file (deleted, or unreadable) loses to one that has it (plan
 * decision 8). Both missing: theirs.
 */
import type { VaultEntryFile } from './schema.js';

export function vaultConflictWinner(
  mine: VaultEntryFile | undefined,
  theirs: VaultEntryFile | undefined,
): 'mine' | 'theirs' {
  if (mine === undefined) {
    return 'theirs';
  }
  if (theirs === undefined) {
    return 'mine';
  }
  const mineAt = Date.parse(mine.updatedAt);
  const theirsAt = Date.parse(theirs.updatedAt);
  if (mineAt !== theirsAt) {
    return mineAt > theirsAt ? 'mine' : 'theirs';
  }
  return mine.updatedBy < theirs.updatedBy ? 'mine' : 'theirs';
}
```

- [ ] **Step 4: The barrel and the engine exports**

Create `packages/engine/src/team-secrets/index.ts`:

```ts
export { decryptValue, encryptValue, newDataKey, unwrapDataKey, WRAP_INFO, wrapDataKey } from './envelope.js';
export { TEAM_SECRETS_MESSAGES, teamSecretsError } from './errors.js';
export type { TeamSecretsErrorCode } from './errors.js';
export {
  base32,
  base64url,
  encryptionPrivateKey,
  encryptionPublicKey,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  KEY_ID_PATTERN,
  keyIdOf,
  parseMachineKeys,
  serializeMachineKeys,
  signingPrivateKey,
  signingPublicKey,
} from './keys.js';
export type { MachineKeys, MachinePublicKeys } from './keys.js';
export { nextAccessEntryId, replayAccessLog, verifiedKeys } from './log.js';
export type { AccessState, KeyInfo, LogProblem, Removal } from './log.js';
export { vaultConflictWinner } from './resolve-conflict.js';
export {
  ACCESS_ACTIONS,
  accessEntryFileSchema,
  accessEntryPath,
  isTeamSecretsPath,
  isVaultEntryPath,
  keyIdSchema,
  keyRequestFileSchema,
  keyRequestPath,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  sameSecret,
  secretKeySchema,
  TEAM_SECRETS_ACCESS_DIR,
  TEAM_SECRETS_FORMAT_VERSION,
  TEAM_SECRETS_KEYS_DIR,
  TEAM_SECRETS_VALUES_DIR,
  teamSecretsFileText,
  ULID_PATTERN,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
} from './schema.js';
export type {
  AccessAction,
  AccessEntryFile,
  KeyRequestFile,
  SecretKey,
  TeamSecretsFiles,
  VaultEntryFile,
} from './schema.js';
export { canonicalJson, signDocument, verifyDocument, withoutSignature } from './sign.js';
export type { Signed } from './sign.js';
export {
  approvedRecipients,
  buildVaultEntry,
  healVaultEntry,
  openVaultEntry,
  rotateMarks,
  sealVaultEntry,
  verifyVaultEntry,
  wrapsUnapprovedKey,
} from './vault.js';
export type { RotateMark, VaultVerdict } from './vault.js';
```

In `packages/engine/src/index.ts`, add `TEAM_SECRETS_DIR,` after `GIT_ATTRIBUTES,` (`:867`), and after
`export type { SecretFinding, SecretLocation } from './secrets/scan/walk.js';` (`:1131`) add:

```ts
export { SECRET_REF_PATTERN, secretRefsInValue } from './secrets/secret-refs.js';

// ---------------------------------------------------------------------------
// Team secrets: machine keys, the access log and the vault (team-secrets spec §4, §5.2)
// ---------------------------------------------------------------------------
export {
  ACCESS_ACTIONS,
  accessEntryFileSchema,
  accessEntryPath,
  approvedRecipients,
  base32,
  base64url,
  buildVaultEntry,
  canonicalJson,
  decryptValue,
  encryptValue,
  encryptionPrivateKey,
  encryptionPublicKey,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  healVaultEntry,
  isTeamSecretsPath,
  isVaultEntryPath,
  KEY_ID_PATTERN,
  keyIdOf,
  keyIdSchema,
  keyRequestFileSchema,
  keyRequestPath,
  newDataKey,
  nextAccessEntryId,
  openVaultEntry,
  parseMachineKeys,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  replayAccessLog,
  rotateMarks,
  sameSecret,
  sealVaultEntry,
  secretKeySchema,
  serializeMachineKeys,
  signDocument,
  signingPrivateKey,
  signingPublicKey,
  TEAM_SECRETS_ACCESS_DIR,
  TEAM_SECRETS_FORMAT_VERSION,
  TEAM_SECRETS_KEYS_DIR,
  TEAM_SECRETS_MESSAGES,
  TEAM_SECRETS_VALUES_DIR,
  teamSecretsError,
  teamSecretsFileText,
  ULID_PATTERN,
  unwrapDataKey,
  vaultConflictWinner,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
  verifiedKeys,
  verifyDocument,
  verifyVaultEntry,
  withoutSignature,
  WRAP_INFO,
  wrapDataKey,
  wrapsUnapprovedKey,
} from './team-secrets/index.js';
export type {
  AccessAction,
  AccessEntryFile,
  AccessState,
  KeyInfo,
  KeyRequestFile,
  LogProblem,
  MachineKeys,
  MachinePublicKeys,
  Removal,
  RotateMark,
  SecretKey,
  Signed,
  TeamSecretsErrorCode,
  TeamSecretsFiles,
  VaultEntryFile,
  VaultVerdict,
} from './team-secrets/index.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/team-secrets/`
Expected: PASS (crypto, schema, log and vault).

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/team-secrets/vault.ts packages/engine/src/team-secrets/resolve-conflict.ts \
  packages/engine/src/team-secrets/index.ts packages/engine/src/index.ts \
  packages/engine/test/unit/team-secrets/vault.test.ts
git commit -m "feat(engine): team secrets vault entries and the concurrent-change winner (#38)

A vault entry wraps one data key per approved machine and is trusted only when it sits under its own id
and an approved key signed it. Healing adds wraps for keys approved since and never removes one;
sealing again uses a fresh data key for the keys that remain. The value time survives both, which is
what lets the replay mark every value a removed machine could read. Of two concurrent versions the
later one wins, then the lower key id."
```

---

## Task 4: server — the admin-only guard and the key-request route

**Files:**
- Modify: `packages/engine/src/server-api/sync.ts` (end of file: the key-request wire)
- Modify: `packages/engine/src/index.ts` (the `./server-api/sync.js` export lists)
- Modify: `packages/server/src/sync/errors.ts` (three problems)
- Modify: `packages/server/src/sync/commit-store.ts` (`hasFile`, after `counts`)
- Modify: `packages/server/src/sync/routes/commits.ts:41-51`
- Create: `packages/server/src/sync/routes/key-requests.ts`
- Modify: `packages/server/src/sync/module.ts:14`, `:43` (register the route)
- Test: `packages/server/test/integration/sync/team-secrets.test.ts` (new)

**Interfaces:**
- Consumes: `KEY_ID_PATTERN`, `TEAM_SECRETS_ACCESS_DIR`, `keyRequestPath`, `TEAM_SECRETS_MESSAGES` (Tasks 1–3);
  `requireWorkspaceRole` (`teams/roles.ts:93`), `CommitStore.head`/`appendCommits` (`commit-store.ts:369`),
  `announce` (`context.ts`), `findUserById` (`identity/repo.ts`).
- Produces:
  - Engine wire: `TEAM_SECRETS_KEY_REQUEST_MAX_BYTES = 4096`,
    `teamSecretsKeyRequestSchema = z.object({ keyId, content })`, `type TeamSecretsKeyRequest`,
    `teamSecretsKeyRequestResponseSchema = z.object({ head })`, `type TeamSecretsKeyRequestResponse`.
  - `POST /api/v1/workspaces/:workspaceId/team-secrets/key-requests` → `201 { head }`; `400 invalid-request`
    (bad `keyId`, more than 4 KiB); `409 team-secrets-key-exists`; `404` for a non-member.
  - `POST …/sync/commits` → `403 team-secrets-admin-only` for a non-admin whose push adds, changes or deletes a path
    under `team-secrets/access/` (case-insensitive).
  - `CommitStore.hasFile(workspaceId: string, at: string, path: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/integration/sync/team-secrets.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type {
  SyncChange,
  SyncLogEntry,
  SyncPushCommit,
  SyncPushResponse,
  SyncSnapshotResponse,
} from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-26T12:00:00.000Z';
const KEY_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCESS = 'team-secrets/access/01J8ZK6Q3V4W5X6Y7Z8A9B0C1D.yaml';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('team secrets on the server (team-secrets §5.1)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/${route}`;
  const push = (as: SignedInUser, payload: object) =>
    call<SyncPushResponse & { code?: string }>(f.h, as, 'POST', url('sync/commits'), payload);
  const head = async () => (await call<{ head: string | null }>(f.h, f.viewer, 'GET', url('sync/head'))).body.head;
  const requestKey = (as: SignedInUser, body: object) =>
    call<{ head?: string; code?: string }>(f.h, as, 'POST', url('team-secrets/key-requests'), body);
  const snapshot = async () =>
    (await call<SyncSnapshotResponse>(f.h, f.viewer, 'GET', url('sync/snapshot'))).body.files.map((file) => file.path);

  it("refuses a non-admin's push that adds, changes or deletes an access entry, and writes nothing", async () => {
    const base = await push(f.admin, { parent: null, commits: [commit('Base', [text(ACCESS, 'genesis\n')])] });
    expect(base.status).toBe(201);
    const forged = [text(ACCESS, 'forged\n'), { path: ACCESS, encoding: 'utf8', content: null }, text('TEAM-SECRETS/Access/X.yaml', 'x\n')];
    for (const change of forged) {
      expect(await push(f.editor, { parent: base.body.head, commits: [commit('Forge', [change as SyncChange])] })).toMatchObject({
        status: 403,
        body: { code: 'team-secrets-admin-only', message: 'Only a workspace admin can change who has access to team secrets.' },
      });
    }
    expect(await head()).toBe(base.body.head);
  });

  it("accepts an admin's access entry and an editor's key request and vault entry", async () => {
    const base = await push(f.admin, { parent: null, commits: [commit('Genesis', [text(ACCESS, 'genesis\n')])] });
    expect(base.status).toBe(201);
    const editor = await push(f.editor, {
      parent: base.body.head,
      commits: [
        commit('Update secret Key', [
          text(`team-secrets/keys/${KEY_ID}.yaml`, 'key\n'),
          text('team-secrets/values/BBCDEFGHIJKLMNOPQRSTUVWXYZ.yaml', 'value\n'),
        ]),
      ],
    });
    expect(editor.status).toBe(201);
  });

  it('lets a viewer add exactly one key file as a commit authored by them', async () => {
    const before = await head();
    const res = await requestKey(f.viewer, { keyId: KEY_ID, content: 'version: 1\n' });
    expect(res.status).toBe(201);
    expect(await head()).toBe(res.body.head);
    expect(await snapshot()).toEqual([`team-secrets/keys/${KEY_ID}.yaml`]);
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('sync/log'));
    expect(log.body[0]).toMatchObject({
      id: res.body.head,
      subject: 'Request team secrets access for viewer',
      author: 'viewer <viewer@example.com>',
    });
    expect(before).toBeNull();
  });

  it('refuses a key id that is not 26 base32 characters, a body over 4 KiB, a repeat and a stranger', async () => {
    for (const keyId of ['short', 'abcdefghijklmnopqrstuvwxyz', '../../../../workspace.yaml', `${KEY_ID}0`]) {
      expect(await requestKey(f.viewer, { keyId, content: 'x' })).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
    }
    expect(await requestKey(f.viewer, { keyId: KEY_ID, content: 'é'.repeat(3000) })).toMatchObject({ status: 400 });
    expect((await requestKey(f.editor, { keyId: KEY_ID, content: 'mine\n' })).status).toBe(201);
    expect(await requestKey(f.viewer, { keyId: KEY_ID, content: 'theirs\n' })).toMatchObject({
      status: 409,
      body: { code: 'team-secrets-key-exists' },
    });
    expect((await requestKey(f.stranger, { keyId: 'BBCDEFGHIJKLMNOPQRSTUVWXYZ', content: 'x' })).status).toBe(404);
    expect(await snapshot()).toEqual([`team-secrets/keys/${KEY_ID}.yaml`]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/sync/team-secrets.test.ts`
Expected: FAIL — the forged pushes are accepted (201) and the key-request route answers 404. (Without
`WIREBENCH_SERVER_TEST_DATABASE_URL` the file is skipped; start the database first:
`docker compose -f packages/server/compose.yaml up -d db`.)

- [ ] **Step 3: The wire**

Append to `packages/engine/src/server-api/sync.ts` (and add `import { KEY_ID_PATTERN } from '../team-secrets/keys.js';`
to its imports):

```ts

// ---- team secrets (team-secrets spec §5.1) -------------------------------------------------

/** The most a key request's file may hold, in UTF-8 bytes. */
export const TEAM_SECRETS_KEY_REQUEST_MAX_BYTES = 4096;

/**
 * `POST …/team-secrets/key-requests`: `content` is the key file's text as the app wrote it. The server
 * derives the path from `keyId` and never parses `content` (plan decision 11).
 */
export const teamSecretsKeyRequestSchema = z.object({
  keyId: z.string().regex(KEY_ID_PATTERN),
  content: z.string().min(1).max(TEAM_SECRETS_KEY_REQUEST_MAX_BYTES),
});
export type TeamSecretsKeyRequest = z.infer<typeof teamSecretsKeyRequestSchema>;
export const teamSecretsKeyRequestResponseSchema = z.object({ head: syncCommitIdSchema });
export type TeamSecretsKeyRequestResponse = z.infer<typeof teamSecretsKeyRequestResponseSchema>;
```

In `packages/engine/src/index.ts`, add `TEAM_SECRETS_KEY_REQUEST_MAX_BYTES,`, `teamSecretsKeyRequestSchema,` and
`teamSecretsKeyRequestResponseSchema,` to the value export list from `./server-api/sync.js`, and
`TeamSecretsKeyRequest,` and `TeamSecretsKeyRequestResponse,` to its type export list.

- [ ] **Step 4: Problems and `hasFile`**

Append to `packages/server/src/sync/errors.ts` (and import `TEAM_SECRETS_KEY_REQUEST_MAX_BYTES` and
`TEAM_SECRETS_MESSAGES` from `@wirebench/engine` beside `MAX_SYNC_FILE_BYTES`):

```ts

/** team-secrets §5.1: only an admin's push may touch `team-secrets/access/`. */
export function teamSecretsAdminOnly(): WirebenchError {
  return problem('team-secrets-admin-only', TEAM_SECRETS_MESSAGES['team-secrets-admin-only'], 403);
}

/** A key request for a key file that is already there; nobody overwrites another machine's request. */
export function teamSecretsKeyExists(): WirebenchError {
  return problem('team-secrets-key-exists', 'This machine has already asked for access to team secrets.', 409);
}

export function teamSecretsRequestTooLarge(): WirebenchError {
  const kib = TEAM_SECRETS_KEY_REQUEST_MAX_BYTES / 1024;
  return problem('invalid-request', `A request for team secrets access is limited to ${kib} KiB.`, 400);
}
```

In `packages/server/src/sync/commit-store.ts`, add after `counts(…)`:

```ts
  /** Whether `path` names a file in commit `at`. @throws syncPathRefused for a path outside the tree rules */
  async hasFile(workspaceId: string, at: string, path: string): Promise<boolean> {
    commitId(at);
    const dir = this.repos.path(workspaceId);
    try {
      await this.git.run(dir, [GIT.catFile, '-e', `${at}:${treePath(path)}`]);
      return true;
    } catch (error) {
      const code = exitCodeOf(error);
      if (code === 1 || code === 128) return false;
      throw error;
    }
  }
```

- [ ] **Step 5: The guard on pushes**

In `packages/server/src/sync/routes/commits.ts`, import `TEAM_SECRETS_ACCESS_DIR` from `@wirebench/engine` and
`teamSecretsAdminOnly` beside `syncSubjectInvalid`, add below `CONTROL_CHARACTER`:

```ts
/**
 * team-secrets §5.1: whether any change in the push lands under `team-secrets/access/`. Case-insensitive,
 * since a checkout on a case-insensitive file system would merge `TEAM-SECRETS/access` into the same folder.
 */
function touchesAccessLog(body: SyncPushRequest): boolean {
  const prefix = `${TEAM_SECRETS_ACCESS_DIR}/`;
  return body.commits.some((c) => c.changes.some((change) => change.path.toLowerCase().startsWith(prefix)));
}
```

and replace the first two lines of the handler:

```ts
        const { workspaceId, role } = request.workspaceAccess!;
        const body = request.body as SyncPushRequest;
        // The commit store takes the subject as is; JSON Schema cannot say "no control characters".
        if (body.commits.some((c) => CONTROL_CHARACTER.test(c.subject))) throw syncSubjectInvalid();
        // No file body is parsed: the paths alone say whether the access log changes.
        if (role !== 'admin' && touchesAccessLog(body)) throw teamSecretsAdminOnly();
```

- [ ] **Step 6: The key-request route**

Create `packages/server/src/sync/routes/key-requests.ts`:

```ts
/**
 * `POST /workspaces/:workspaceId/team-secrets/key-requests` (team-secrets spec §5.1): a member with at least
 * the viewer role adds exactly one file, `team-secrets/keys/<keyId>.yaml`, as a commit authored by the
 * signed-in account. A viewer cannot push, and this is how its machine asks for access. The path comes
 * from the checked `keyId`; the content is never parsed. An existing key file is never overwritten.
 */
import {
  keyRequestPath,
  TEAM_SECRETS_KEY_REQUEST_MAX_BYTES,
  teamSecretsKeyRequestResponseSchema,
  teamSecretsKeyRequestSchema,
  teamWorkspaceParamsSchema,
  type TeamSecretsKeyRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { unauthenticated } from '../../identity/errors.js';
import { findUserById } from '../../identity/repo.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { SyncEnv } from '../env.js';
import { teamSecretsKeyExists, teamSecretsRequestTooLarge } from '../errors.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export const keyRequestRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos, hooks } = env.ctx;
    app.post(
      '/workspaces/:workspaceId/team-secrets/key-requests',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        // A key request is a few hundred bytes; the operator's sync limit is for trees.
        bodyLimit: 16 * 1024,
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          body: jsonSchema(teamSecretsKeyRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamSecretsKeyRequestResponseSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as TeamSecretsKeyRequest;
        if (Buffer.byteLength(body.content, 'utf8') > TEAM_SECRETS_KEY_REQUEST_MAX_BYTES) {
          throw teamSecretsRequestTooLarge();
        }
        const user = await findUserById(db, request.caller!.id);
        if (user === undefined) throw unauthenticated();
        const path = keyRequestPath(body.keyId);
        const subject = `Request team secrets access for ${user.displayName.replace(CONTROL_CHARACTERS, ' ')}`;
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          const head = await env.store.head(workspaceId);
          if (head !== null && (await env.store.hasFile(workspaceId, head, path))) throw teamSecretsKeyExists();
          return env.store.appendCommits(
            workspaceId,
            head,
            [{ subject, at: new Date().toISOString(), changes: [{ path, encoding: 'utf8', content: body.content }] }],
            { name: user.displayName, email: user.email },
          );
        });
        announce(hooks.headMoved, { workspaceId, head: result.head, tokenId: request.caller!.tokenId }, request.log);
        return reply.code(201).send({ head: result.head });
      },
    );
  };
```

In `packages/server/src/sync/module.ts`, import `{ keyRequestRoutes } from './routes/key-requests.js';` and add
`keyRequestRoutes(env)(app);` after `logRoutes(env)(app);`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/sync/`
Expected: PASS, the existing push, routes and races tests included.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/server-api/sync.ts packages/engine/src/index.ts packages/server/src/sync/errors.ts \
  packages/server/src/sync/commit-store.ts packages/server/src/sync/routes/commits.ts \
  packages/server/src/sync/routes/key-requests.ts packages/server/src/sync/module.ts \
  packages/server/test/integration/sync/team-secrets.test.ts
git commit -m "feat(server): only admins change team secrets access; members can ask for it (#38)

A push that adds, changes or deletes a file under team-secrets/access/ is refused with 403
team-secrets-admin-only unless the pusher is a workspace admin; the check reads the paths only, in any
case. A new route lets any member, viewers included, add exactly one key file as a commit authored by
their account. The path comes from a checked key id, the body is capped at 4 KiB, and an existing key
file is never overwritten."
```

---

## Task 5: desktop sync plumbing — conflict sides, key requests, vault commits

**Files:**
- Modify: `apps/desktop/src/main/server-client.ts` (after `workspaceAccess`, `:316`)
- Modify: `apps/desktop/src/main/sync/backend.ts:27-66` (`ConflictSides`, three optional methods)
- Modify: `apps/desktop/src/main/sync/git-backend.ts` (after `resolve`, `:459`)
- Modify: `apps/desktop/src/main/sync/server-backend.ts:50-52` (`ServerBackendDeps.client`), after `resolve` (`:414`)
- Modify: `apps/desktop/src/main/sync/sync-service.ts` (`SyncServiceDeps`, public methods, `pullNow` `:679-689`)
- Modify: `apps/desktop/test/sync/fake-server-backend.ts` (after `resolve`)
- Test: `apps/desktop/test/sync/backend-contract.ts` (one contract test), `apps/desktop/test/sync/sync-service.test.ts`

**Interfaces:**
- Consumes: `teamSecretsKeyRequestResponseSchema`, `TeamSecretsKeyRequest` (Task 4); `isTeamSecretsPath` (Task 2);
  `assertTreePath` (`@wirebench/engine`).
- Produces:
  - `ServerClient.requestTeamSecretsKey(url: string, token: string, workspaceId: string, body: TeamSecretsKeyRequest): Promise<TeamSecretsKeyRequestResponse>`
  - `export interface ConflictSides { readonly mine: string | null; readonly theirs: string | null }` (`sync/backend.ts`)
  - `SyncBackend.conflictSides?(path: string): Promise<ConflictSides>` (git, server, fake server),
    `SyncBackend.requestTeamSecretsKey?(keyId: string, content: string): Promise<void>` (server; a `409
    team-secrets-key-exists` is success), `SyncBackend.workspaceMembers?(): Promise<readonly string[] | undefined>`
    (server; emails with a role, `undefined` when refused).
  - `SyncServiceDeps.resolveConflicts?: (conflicts: readonly SyncConflictWire[], sides: (path: string) => Promise<ConflictSides>) => Promise<ReadonlyMap<string, 'mine' | 'theirs'>>`
  - `SyncService.identity(): Promise<{ name: string; email: string } | undefined>` (not queued — plan decision 14),
    `SyncService.requestTeamSecretsKey(keyId: string, content: string): Promise<void>` (queued; fetches after),
    `SyncService.workspaceMembers(): Promise<readonly string[] | undefined>` (queued),
    `SyncService.afterTeamSecretsWrite(message: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/sync/backend-contract.ts`, inside `defineContract` after the last `it(…)`:

```ts
  it('reads both sides of a conflicted vault entry, a deleted side as null (team-secrets §3.5)', async () => {
    fixture = await factory();
    const { a, b } = fixture;
    const changed = 'team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml';
    const deleted = 'team-secrets/values/BBCDEFGHIJKLMNOPQRSTUVWXYZ.yaml';
    await fixture.writeA(changed, 'side: base\n');
    await fixture.writeA(deleted, 'side: base\n');
    await a.commit('Add two entries');
    await a.push();
    await b.fetch();
    await b.merge();

    await fixture.writeA(changed, 'side: a\n');
    await fixture.deleteA(deleted);
    await a.commit('A changes one and deletes the other');
    await a.push();
    await fixture.writeB(changed, 'side: b\n');
    await fixture.writeB(deleted, 'side: b\n');
    await b.commit('B changes both');
    await b.fetch();

    const merged = await b.merge();
    expect(merged.conflicts.map((conflict) => conflict.path).sort()).toEqual([changed, deleted].sort());
    expect(await b.conflictSides?.(changed)).toEqual({ mine: 'side: b\n', theirs: 'side: a\n' });
    expect(await b.conflictSides?.(deleted)).toEqual({ mine: 'side: b\n', theirs: null });

    await b.resolve(changed, 'theirs');
    await b.resolve(deleted, 'mine');
    await b.finishMerge();
    expect(await fixture.readB(changed)).toBe('side: a\n');
    expect(await fixture.readB(deleted)).toBe('side: b\n');
  });
```

Append to `apps/desktop/test/sync/sync-service.test.ts` (before the file's last line):

```ts
describe('team secrets (team-secrets §3.3, §3.5)', () => {
  const VAULT = 'team-secrets/values/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml';
  const conflictOf = (path: string): SyncConflictWire => ({ path, entity: { kind: 'team-secrets', name: 'x' } });

  it('settles the conflicts the resolver answers, finishes the merge and applies it', async () => {
    const decided = vi.fn().mockResolvedValue(new Map([[VAULT, 'theirs' as const]]));
    const h = harness({}, { resolveConflicts: decided });
    Object.assign(h.backend, {
      conflictSides: (path: string) => Promise.resolve({ mine: `mine:${path}`, theirs: `theirs:${path}` }),
    });
    const resolve = vi.spyOn(h.backend, 'resolve');
    h.backend.mergeResult = { conflicts: [conflictOf(VAULT)], changedPaths: [] };
    h.backend.mergeChanged = [VAULT];

    await h.service.pull();

    expect(decided).toHaveBeenCalledWith([conflictOf(VAULT)], expect.any(Function));
    const sides = decided.mock.calls[0]?.[1] as (path: string) => Promise<unknown>;
    await expect(sides(VAULT)).resolves.toEqual({ mine: `mine:${VAULT}`, theirs: `theirs:${VAULT}` });
    expect(resolve).toHaveBeenCalledWith(VAULT, 'theirs');
    expect(h.backend.calls).toContain('finishMerge');
    expect(h.pulled).toEqual([[VAULT]]);
    expect(h.conflicts).toEqual([]);
  });

  it('hands the dialog only what the resolver left', async () => {
    const other = conflictOf('environments/qa.yaml');
    const h = harness({}, { resolveConflicts: () => Promise.resolve(new Map([[VAULT, 'mine' as const]])) });
    Object.assign(h.backend, { conflictSides: () => Promise.resolve({ mine: null, theirs: null }) });
    h.backend.mergeResult = { conflicts: [conflictOf(VAULT), other], changedPaths: [] };

    await h.service.pull();

    expect(h.conflicts).toEqual([[other]]);
    expect(h.backend.calls).not.toContain('finishMerge');
  });

  it('commits a vault-only change under its own message and pushes, and a mixed one under the generated one', async () => {
    const h = harness();
    await h.service.start();
    const mark = h.backend.calls.length;
    h.backend.changes = [{ path: VAULT, status: 'modified' }];
    h.service.afterTeamSecretsWrite('Update secret Payments API key');
    await h.service.idle();
    expect(h.backend.commits.at(-1)).toBe('Update secret Payments API key');
    expect(h.backend.calls.slice(mark)).toContain('push');

    const mixed: TreeChange[] = [
      { path: VAULT, status: 'modified' },
      { path: 'environments/qa.yaml', status: 'modified' },
    ];
    h.backend.changes = mixed;
    h.service.afterTeamSecretsWrite('Update secret Payments API key');
    await h.service.idle();
    expect(h.backend.commits.at(-1)).toBe(commitMessage(mixed));
  });

  it('leaves a vault write uncommitted when commit-on-save is off', async () => {
    const h = harness({ commitOnSave: false });
    await h.service.start();
    const before = h.backend.commits.length;
    h.backend.changes = [{ path: VAULT, status: 'added' }];
    h.service.afterTeamSecretsWrite('Update secret X');
    await h.service.idle();
    expect(h.backend.commits).toHaveLength(before);
  });

  it('reads the identity without queuing behind a running operation', async () => {
    const h = harness();
    const gate = deferred();
    h.backend.fetchScript.push(() => gate.promise);
    const fetching = h.service.fetch();
    await expect(h.service.identity()).resolves.toEqual({ name: 'Ada', email: 'ada@example.test' });
    gate.resolve();
    await fetching;
  });

  it('sends a key request through a backend that has the route, then fetches; refuses one that has not', async () => {
    const h = harness();
    const request = vi.fn().mockResolvedValue(undefined);
    Object.assign(h.backend, { requestTeamSecretsKey: request });
    const mark = h.backend.calls.length;
    await h.service.requestTeamSecretsKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'version: 1\n');
    expect(request).toHaveBeenCalledWith('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'version: 1\n');
    expect(h.backend.calls.slice(mark)).toContain('fetch');

    const plain = harness();
    await expect(plain.service.requestTeamSecretsKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'x')).rejects.toMatchObject({
      code: 'sync-not-supported',
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/sync/sync-service.test.ts apps/desktop/test/sync/backend-contract.test.ts`
Expected: FAIL — `conflictSides`, `afterTeamSecretsWrite`, `identity` and `requestTeamSecretsKey` do not exist, and
`pull` reports the vault conflict to the dialog.

- [ ] **Step 3: The client and the backend interface**

In `apps/desktop/src/main/server-client.ts`, import `teamSecretsKeyRequestResponseSchema`, `TeamSecretsKeyRequest`
and `TeamSecretsKeyRequestResponse` from `@wirebench/engine` and add after `workspaceAccess(…)`:

```ts
  /** team-secrets §5.1: adds this machine's key request as a server-authored commit. */
  requestTeamSecretsKey(
    url: string,
    token: string,
    workspaceId: string,
    body: TeamSecretsKeyRequest,
  ): Promise<TeamSecretsKeyRequestResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/team-secrets/key-requests`,
      token,
      body,
      schema: teamSecretsKeyRequestResponseSchema,
    });
  }
```

In `apps/desktop/src/main/sync/backend.ts`, add before `export interface SyncBackend`:

```ts
/** Both versions of one conflicted path as text; `null` for a side that deleted it (team-secrets §3.5). */
export interface ConflictSides {
  readonly mine: string | null;
  readonly theirs: string | null;
}
```

and inside `SyncBackend`, after `subscribeRemote(…)`:

```ts
  /**
   * Reads both sides of a conflicted path, so a whole-file value can be settled without the dialog
   * (team-secrets §3.5). Optional: a backend without it never has a conflict settled for it.
   */
  conflictSides?(path: string): Promise<ConflictSides>;
  /** Server shares only: commits a team-secrets key request through the server's route (§5.1). */
  requestTeamSecretsKey?(keyId: string, content: string): Promise<void>;
  /** Server shares only: the emails of the people with a role in the workspace; `undefined` when not allowed to ask. */
  workspaceMembers?(): Promise<readonly string[] | undefined>;
```

- [ ] **Step 4: Git, server and fake backends**

In `apps/desktop/src/main/sync/git-backend.ts`, add `readFile` to the `node:fs/promises` import, `assertTreePath`
to the `@wirebench/engine` import, `ConflictSides` to the `./backend.js` type import, and after `resolve(…)`:

```ts
  /**
   * Each side through `checkout --theirs|--ours` and a read: the allow-list has no `show` (plan decision 7).
   * The working file is left at ours; the `resolve` that follows checks out the side it keeps.
   */
  async conflictSides(path: string): Promise<ConflictSides> {
    assertTreePath(path);
    const read = async (flag: '--ours' | '--theirs'): Promise<string | null> => {
      try {
        await this.git.run(this.tree, ['checkout', flag, '--', path]);
        return await readFile(join(this.tree, ...path.split('/')), 'utf8');
      } catch {
        return null;
      }
    };
    const theirs = await read('--theirs');
    const mine = await read('--ours');
    return { mine, theirs };
  }
```

In `apps/desktop/src/main/sync/server-backend.ts`, change `ServerBackendDeps.client` to:

```ts
  readonly client: Pick<ServerClient, 'syncHead' | 'syncChanges' | 'pushCommits' | 'syncLog'> &
    Partial<Pick<ServerClient, 'requestTeamSecretsKey' | 'workspaceAccess'>>;
```

add `ConflictSides` to the `./backend.js` import, and after `resolve(…)`:

```ts
  async conflictSides(path: string): Promise<ConflictSides> {
    const record = await this.state.readMerge();
    const text = (file: TreeFile | undefined): string | null =>
      file === undefined
        ? null
        : file.encoding === 'utf8'
          ? file.content
          : Buffer.from(file.content, 'base64').toString('utf8');
    return { mine: text(record?.mine[path]), theirs: text(record?.theirs[path]) };
  }

  /** §5.1: a key file that is already there is this machine's own earlier request. */
  async requestTeamSecretsKey(keyId: string, content: string): Promise<void> {
    const request = this.deps.client.requestTeamSecretsKey;
    if (request === undefined) {
      throw new WirebenchError('sync-not-supported', 'This server cannot take a team secrets request.');
    }
    try {
      await this.call((url, token) =>
        request.call(this.deps.client, url, token, this.deps.workspaceId, { keyId, content }),
      );
    } catch (error) {
      if (isWirebenchError(error) && error.code === 'team-secrets-key-exists') return;
      throw error;
    }
  }

  /** Who still has a role here (team-secrets §3.6); only an admin may ask, so anyone else gets `undefined`. */
  async workspaceMembers(): Promise<readonly string[] | undefined> {
    const access = this.deps.client.workspaceAccess;
    if (access === undefined) return undefined;
    try {
      const rows = await this.call((url, token) => access.call(this.deps.client, url, token, this.deps.workspaceId));
      return rows.filter((row) => row.effectiveRole !== 'none').map((row) => row.email.toLowerCase());
    } catch {
      return undefined;
    }
  }
```

(`TreeFile` is already imported from `./server-state.js` in this file; add it to that import if it is not.)

In `apps/desktop/test/sync/fake-server-backend.ts`, import `ConflictSides` and add after `resolve(…)`:

```ts
  conflictSides(path: string): Promise<ConflictSides> {
    return Promise.resolve({
      mine: this.mergeState?.mine.get(path) ?? null,
      theirs: this.mergeState?.theirs.get(path) ?? null,
    });
  }
```

- [ ] **Step 5: `SyncService`**

In `apps/desktop/src/main/sync/sync-service.ts`, add `isTeamSecretsPath` to the `@wirebench/engine` import and
`ConflictSides` to the `./backend.js` type import. In `SyncServiceDeps`, after `unsaved?: () => boolean;`:

```ts
  /**
   * Decides the conflicts the sync settles itself (team-secrets §3.5: whole-file vault entries). Each path in
   * the answer is resolved to that side; the rest go to `onConflict`. `sides` reads both versions of a path.
   */
  resolveConflicts?: (
    conflicts: readonly SyncConflictWire[],
    sides: (path: string) => Promise<ConflictSides>,
  ) => Promise<ReadonlyMap<string, 'mine' | 'theirs'>>;
```

Add these public methods after `resume()`:

```ts
  /**
   * The commit identity, read from the backend directly rather than queued: a pull's `onPulled` runs inside a
   * queued operation and asks for it (plan decision 14). Reading config races nothing.
   */
  identity(): Promise<{ name: string; email: string } | undefined> {
    return this.backend.identity();
  }

  /** Server shares: sends a team-secrets key request through the server's route, then fetches (§3.2). */
  requestTeamSecretsKey(keyId: string, content: string): Promise<void> {
    return this.run(async () => {
      const request = this.backend.requestTeamSecretsKey?.bind(this.backend);
      if (request === undefined) {
        throw new WirebenchError('sync-not-supported', 'This share has no key-request route.');
      }
      await request(keyId, content);
      await this.fetchNow();
    });
  }

  /** Server shares: the emails of the people with a role in the workspace, when this account may ask. */
  workspaceMembers(): Promise<readonly string[] | undefined> {
    return this.run(async () => await this.backend.workspaceMembers?.());
  }

  /**
   * Team secrets wrote into the tree (§3.3). With commit-on-save it commits now — under `message` when only
   * `team-secrets/` changed, under the generated message when other saves ride along — and pushes as a save
   * would. Held like any automatic commit while possible secrets wait for review. Never throws.
   */
  afterTeamSecretsWrite(message: string): void {
    if (this.stopped || !this.canSync() || !this.deps.settings().commitOnSave) {
      return;
    }
    void this.run(async () => {
      const commit: PendingCommit = { message: undefined, autosave: false, push: true };
      if (await this.holdForSecrets(commit)) {
        return;
      }
      const changes = await this.backend.changedPaths();
      if (changes.length === 0) {
        return;
      }
      const onlyTeamSecrets = changes.every((change) => isTeamSecretsPath(change.path));
      await this.commitThenMaybePush({ ...commit, message: onlyTeamSecrets ? message : undefined });
    }).catch(() => undefined);
  }
```

Replace the conflict branch of `pullNow` (`const { conflicts, changedPaths } = await this.backend.merge();` through
the `return;` inside `if (conflicts.length > 0) { … }`) with:

```ts
    const { conflicts, changedPaths } = await this.backend.merge();
    if (conflicts.length > 0) {
      const left = await this.autoResolve(conflicts);
      if (left.length > 0) {
        await this.probeNow();
        this.deps.onConflict(left);
        return;
      }
      // Every conflict was a whole-file value settled above: finish as `resolve` does for the last one.
      const merged = await this.backend.finishMerge();
      await this.probeNow();
      if (merged.changedPaths.length > 0) {
        await this.deps.onPulled(merged.changedPaths);
      }
      return;
    }
```

and add after `pullNow`:

```ts
  /** Resolves what `deps.resolveConflicts` answers; returns the conflicts still open. */
  private async autoResolve(conflicts: readonly SyncConflictWire[]): Promise<SyncConflictWire[]> {
    const decide = this.deps.resolveConflicts;
    const sides = this.backend.conflictSides?.bind(this.backend);
    if (decide === undefined || sides === undefined) {
      return [...conflicts];
    }
    const decisions = await decide(conflicts, sides);
    if (decisions.size === 0) {
      return [...conflicts];
    }
    for (const [path, side] of decisions) {
      await this.backend.resolve(path, side);
    }
    return await this.backend.conflicts();
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/sync/`
Expected: PASS: the contract against git and the fake server backend, and every existing sync-service test.

Run: `nice pnpm vitest run --project server-integration packages/server/test/integration/sync/backend-contract.test.ts`
Expected: PASS: the same contract test against two real `ServerBackend`s.

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/server-client.ts apps/desktop/src/main/sync/backend.ts \
  apps/desktop/src/main/sync/git-backend.ts apps/desktop/src/main/sync/server-backend.ts \
  apps/desktop/src/main/sync/sync-service.ts apps/desktop/test/sync/fake-server-backend.ts \
  apps/desktop/test/sync/backend-contract.ts apps/desktop/test/sync/sync-service.test.ts
git commit -m "feat(sync): settle whole-file conflicts and commit vault writes (#38)

Every backend can now read both sides of a conflicted path, git through checkout and a read since its
allow-list has no show. SyncService asks an optional resolver about each conflict after a merge,
resolves what it answers and finishes the merge itself when nothing is left for the dialog. A vault
write commits at once under its own message when it is the only change, and a server share can send a
key request through the server's route. The identity is read without queuing, because a pull's hook
asks for it from inside a queued operation."
```

---

## Task 6: desktop main — the team-secrets service: machine key, turning on, key requests, approvals

**Files:**
- Modify: `apps/desktop/src/main/secrets.ts` (`SecretStore.put`, `SecretStore.encryptionAvailable`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (end of the sync section, after `syncConflictWireSchema`, `:4446`)
- Create: `apps/desktop/src/main/team-secrets-service.ts`
- Test: `apps/desktop/test/team-secrets-service.test.ts` (new), `apps/desktop/test/secrets.test.ts`

**Interfaces:**
- Consumes: the engine's team-secrets exports (Tasks 1–3), `generateId`, `secretStoreLabel`
  (`secret-resolver.ts:47`), `SecretStore` (`secrets.ts:124`).
- Produces:
  - `SecretStore.put(ref: string, value: string, opts?: { label?: string }): Promise<void>` (writes under a given
    ref, keeping an existing entry's label and creation time) and `SecretStore.encryptionAvailable(): boolean`.
  - Wire (`shared/wire-types.ts`): `teamSecretsSecretWireSchema`, `teamSecretsKeyWireSchema`,
    `teamSecretsRotateMarkWireSchema`, `teamSecretsUntrustedWireSchema`, `teamSecretsReplacedWireSchema`,
    `teamSecretsStatusWireSchema`, types `TeamSecretsSecretWire`, `TeamSecretsKeyWire`, `TeamSecretsStatusWire`.
  - `team-secrets-service.ts`: `TEAM_KEY_LABEL_PREFIX = 'wirebench-team-key:'`,
    `TEAM_REPLACED_LABEL_PREFIX = 'wirebench-team-replaced:'`, `TEAM_SECRETS_LOCAL_FILE = 'team-secrets.json'`,
    `TEAM_SECRETS_OFF: TeamSecretsStatusWire`, `type TeamSecretsStore`, `interface SecretUse { secret: SecretKey }`,
    `interface TeamSecretsWorkspace` (below), `interface TeamSecretsServiceDeps`, and `class TeamSecretsService` with
    `attach(ws)`, `detach(): Promise<void>`, `status()`, `turnOn(options?: { commit: boolean })`,
    `turnOnIfAdmin(): Promise<void>`, `afterPull(paths: readonly string[]): Promise<void>`, `approve(keyId)`,
    `decline(keyId)`, `remove(keyId)`, `grantAdmin(keyId)`, `revokeAdmin(keyId)`, `requestAccess()` — every
    `Promise<TeamSecretsStatusWire>` unless noted. Task 7 adds `recordValue`, `forget`, `waitingFor`; Task 8 replaces
    `refreshNow` and adds `resolveConflicts`, `restoreMine`, `dismissReplaced`.

```ts
export interface TeamSecretsWorkspace {
  readonly workspaceId: string;
  readonly dir: string; // app data: team-secrets.json
  readonly tree: string;
  readonly kind: 'git' | 'folder' | 'server';
  readonly role: () => 'viewer' | 'editor' | 'admin' | undefined;
  readonly uses: () => readonly SecretUse[];
  readonly identity: () => Promise<{ readonly name: string; readonly email: string } | undefined>;
  readonly beforeWrite: (paths: readonly string[]) => void;
  readonly afterWrite: (message: string) => void;
  readonly requestKey?: (keyId: string, content: string) => Promise<void>;
  readonly memberEmails?: () => Promise<readonly string[] | undefined>;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/secrets.test.ts` (it already has `fakeCrypto(available)` and a temp `dir`; use the
file's own setup names if they differ):

```ts
describe('SecretStore.put and encryptionAvailable (team secrets)', () => {
  it('writes under a given ref, keeping an existing label, and says whether the keychain encrypts', async () => {
    const store = new SecretStore(dir, fakeCrypto());
    expect(store.encryptionAvailable()).toBe(true);
    expect(new SecretStore(dir, fakeCrypto(false)).encryptionAvailable()).toBe(false);
    await store.put('sec_0123456789abcdef0123456789', 'one', { label: 'Password' });
    await store.put('sec_0123456789abcdef0123456789', 'two');
    expect(await store.get('sec_0123456789abcdef0123456789')).toBe('two');
    expect(await store.list()).toEqual([
      expect.objectContaining({ ref: 'sec_0123456789abcdef0123456789', label: 'Password' }),
    ]);
  });
});
```

Create `apps/desktop/test/team-secrets-service.test.ts`:

```ts
// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTeamSecretsFile, vaultEntryFileSchema, vaultEntryId, vaultEntryPath } from '@wirebench/engine';
import { SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import {
  TeamSecretsService,
  type SecretUse,
  type TeamSecretsWorkspace,
} from '../src/main/team-secrets-service.js';

const REF = 'sec_0123456789abcdef0123456789';
const fakeCrypto = (available = true): CryptoBackend => ({
  available,
  encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
  decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
});

let base: string;
let tree: string;
let clock: number;

interface Machine {
  readonly name: string;
  readonly service: TeamSecretsService;
  readonly store: SecretStore;
  readonly ws: TeamSecretsWorkspace;
  readonly commits: string[];
  readonly requests: { keyId: string; content: string }[];
  uses: SecretUse[];
  role: 'viewer' | 'editor' | 'admin' | undefined;
}

function machine(
  name: string,
  options: {
    readonly kind?: TeamSecretsWorkspace['kind'];
    readonly role?: 'viewer' | 'editor' | 'admin';
    readonly available?: boolean;
  } = {},
): Machine {
  const store = new SecretStore(join(base, name), fakeCrypto(options.available ?? true));
  const m = {
    name,
    store,
    commits: [] as string[],
    requests: [] as { keyId: string; content: string }[],
    uses: [] as SecretUse[],
    role: options.role,
  } as Machine;
  const kind = options.kind ?? 'folder';
  const ws: TeamSecretsWorkspace = {
    workspaceId: 'ws-1',
    dir: join(base, name, 'workspace'),
    tree,
    kind,
    role: () => m.role,
    uses: () => m.uses,
    identity: () => Promise.resolve({ name, email: `${name.toLowerCase()}@example.test` }),
    beforeWrite: () => undefined,
    afterWrite: (message) => {
      m.commits.push(message);
    },
    ...(kind === 'server'
      ? {
          // What the route does on the server: one key file, committed for the requester.
          requestKey: async (keyId: string, content: string) => {
            m.requests.push({ keyId, content });
            await mkdir(join(tree, 'team-secrets', 'keys'), { recursive: true });
            await writeFile(join(tree, 'team-secrets', 'keys', `${keyId}.yaml`), content, 'utf8');
          },
        }
      : {}),
  };
  const service = new TeamSecretsService({
    store,
    machine: () => `${name.toLowerCase()}-laptop`,
    now: () => new Date((clock += 1000)),
  });
  service.attach(ws);
  Object.assign(m, { service, ws });
  return m;
}

/** Every file under the tree, as one string: what a search of the repository would see. */
async function treeText(): Promise<string> {
  const names = (await readdir(tree, { recursive: true })).map(String);
  const parts = await Promise.all(names.map((name) => readFile(join(tree, name), 'utf8').catch(() => '')));
  return parts.join('\n');
}

async function vaultEntry(ref = REF) {
  const text = await readFile(join(tree, ...vaultEntryPath(vaultEntryId({ ref })).split('/')), 'utf8');
  return parseTeamSecretsFile(vaultEntryFileSchema, text)!;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wirebench-team-secrets-'));
  tree = join(base, 'tree');
  await mkdir(tree, { recursive: true });
  clock = Date.parse('2026-09-26T10:00:00.000Z');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A turns team secrets on holding `hunter2` for REF; B asks; A approves B. */
async function aliceAndBob(): Promise<{ a: Machine; b: Machine }> {
  const a = machine('Alice');
  await a.store.put(REF, 'hunter2', { label: 'Password' });
  a.uses = [{ secret: { ref: REF } }];
  await a.service.turnOn();
  const b = machine('Bob');
  b.uses = [{ secret: { ref: REF } }];
  await b.service.afterPull([]);
  const bobKey = (await b.service.status()).me.keyId!;
  await a.service.approve(bobKey);
  return { a, b };
}

describe('TeamSecretsService — turning on (§3.1)', () => {
  it('writes this machine’s key, a genesis naming it admin and every value it holds, in one commit', async () => {
    const a = machine('Alice');
    await a.store.put(REF, 'hunter2', { label: 'Password' });
    a.uses = [{ secret: { ref: REF } }];

    const status = await a.service.turnOn();

    expect(status).toMatchObject({ on: true, authority: 'signed', canManage: true, me: { state: 'approved', admin: true } });
    expect(status.me.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(a.commits).toEqual(['Turn on team secrets']);
    const entry = await vaultEntry();
    expect(entry.label).toBe('Password');
    expect(Object.keys(entry.wraps)).toEqual([status.me.keyId]);
    expect(await treeText()).not.toContain('hunter2');
  });

  it('needs the keychain, and is a no-op once on', async () => {
    const noKeychain = machine('Nokey', { available: false });
    await expect(noKeychain.service.turnOn()).rejects.toMatchObject({ code: 'team-secrets-no-safe-storage' });
    expect((await noKeychain.service.status()).canTurnOn).toBe(false);

    const a = machine('Alice');
    await a.service.turnOn();
    await a.service.turnOn();
    expect(a.commits).toEqual(['Turn on team secrets']);
    // The workspace is on now; this machine still cannot make a key.
    expect(await noKeychain.service.status()).toMatchObject({
      me: { state: 'unavailable' },
      message: 'Team secrets need the system keychain, which is not available on this machine.',
    });
  });

  it('on a server share, only a server admin turns it on, with server authority', async () => {
    const editor = machine('Eve', { kind: 'server', role: 'editor' });
    await expect(editor.service.turnOn()).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
    expect((await editor.service.status()).canTurnOn).toBe(false);
    const admin = machine('Alice', { kind: 'server', role: 'admin' });
    expect(await admin.service.turnOn()).toMatchObject({ on: true, authority: 'server', canManage: true });
  });
});

describe('TeamSecretsService — joining and approval (§3.2)', () => {
  it('asks for access on the next sync and waits; the admin sees the request with its fingerprint', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const b = machine('Bob');

    await b.service.afterPull([]);
    await b.service.afterPull([]);

    const mine = await b.service.status();
    expect(mine.me.state).toBe('pending');
    expect(b.commits).toEqual(['Request team secrets access for Bob']);
    const theirs = await a.service.status();
    expect(theirs.pending).toEqual([
      {
        keyId: mine.me.keyId,
        name: 'Bob',
        email: 'bob@example.test',
        machine: 'bob-laptop',
        fingerprint: mine.me.fingerprint,
        requestedAt: expect.any(String) as string,
        admin: false,
        mine: false,
      },
    ]);
  });

  it('approves in one commit that wraps every value for the new key', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    expect(a.commits.at(-1)).toBe('Approve team secrets access for Bob');
    expect(Object.keys((await vaultEntry()).wraps)).toContain(bobKey);
    expect((await b.service.status()).me.state).toBe('approved');
    expect((await a.service.status()).pending).toEqual([]);
  });

  it('refuses a non-admin’s approval, and declines by deleting the request', async () => {
    const { a, b } = await aliceAndBob();
    const c = machine('Carol');
    await c.service.afterPull([]);
    const carolKey = (await c.service.status()).me.keyId!;
    await expect(b.service.approve(carolKey)).rejects.toMatchObject({ code: 'team-secrets-admin-only' });

    await a.service.decline(carolKey);
    expect(a.commits.at(-1)).toBe('Decline team secrets access for Carol');
    expect(await readdir(join(tree, 'team-secrets', 'keys'))).not.toContain(`${carolKey}.yaml`);
  });

  it('on a server share, asks through the route and commits nothing itself', async () => {
    const a = machine('Alice', { kind: 'server', role: 'admin' });
    await a.service.turnOn();
    const v = machine('Vera', { kind: 'server', role: 'viewer' });
    await v.service.afterPull([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(v.requests).toHaveLength(1);
    expect(v.commits).toEqual([]);
    expect((await a.service.status()).pending.map((key) => key.name)).toEqual(['Vera']);
  });
});

describe('TeamSecretsService — removing and admins (§3.6, §3.7)', () => {
  it('re-encrypts every value without the removed key and marks each one it could read', async () => {
    const { a, b } = await aliceAndBob();
    const bobKey = (await b.service.status()).me.keyId!;
    const before = await vaultEntry();

    const status = await a.service.remove(bobKey);

    const after = await vaultEntry();
    expect(Object.keys(after.wraps)).not.toContain(bobKey);
    expect(after.cipher).not.toBe(before.cipher);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(a.commits.at(-1)).toBe('Remove Bob from team secrets');
    expect(status.rotate).toEqual([
      { entryId: vaultEntryId({ ref: REF }), label: 'Password', secret: { ref: REF }, removedNames: ['Bob'] },
    ]);
    expect(await b.service.status()).toMatchObject({
      me: { state: 'removed' },
      message: 'An admin removed this machine from team secrets.',
    });
  });

  it('never revokes or removes the last admin, and hands admin over when there is another', async () => {
    const { a, b } = await aliceAndBob();
    const aliceKey = (await a.service.status()).me.keyId!;
    const bobKey = (await b.service.status()).me.keyId!;
    await expect(a.service.revokeAdmin(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-last-admin' });
    await expect(a.service.remove(aliceKey)).rejects.toMatchObject({ code: 'team-secrets-last-admin' });
    await a.service.grantAdmin(bobKey);
    await a.service.revokeAdmin(aliceKey);
    expect((await b.service.status()).canManage).toBe(true);
    expect((await a.service.status()).canManage).toBe(false);
  });

  it('lets a removed machine ask again with a fresh key', async () => {
    const { a, b } = await aliceAndBob();
    const old = (await b.service.status()).me.keyId!;
    await a.service.remove(old);
    const again = await b.service.requestAccess();
    expect(again.me.state).toBe('pending');
    expect(again.me.keyId).not.toBe(old);
  });
});

describe('TeamSecretsService — what leaves main', () => {
  it('never answers with a value or a private key', async () => {
    const { a, b } = await aliceAndBob();
    const keyRef = await a.store.findByLabel('wirebench-team-key:ws-1');
    const privateKeys = JSON.parse((await a.store.get(keyRef!))!) as Record<string, string>;
    const answered = JSON.stringify([await a.service.status(), await b.service.status()]);
    expect(answered).not.toContain('hunter2');
    expect(answered).not.toContain(privateKeys['encryptionPrivate']);
    expect(answered).not.toContain(privateKeys['signingPrivate']);
    expect(await treeText()).not.toContain(privateKeys['signingPrivate']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts apps/desktop/test/secrets.test.ts`
Expected: FAIL — `SecretStore.put` and `team-secrets-service.ts` do not exist.

- [ ] **Step 3: `SecretStore.put` and `encryptionAvailable`**

In `apps/desktop/src/main/secrets.ts`, add after `replace(…)`:

```ts
  /**
   * Stores `value` under the given `ref`, creating the entry when it does not exist (team secrets write a
   * ref the tree already names). An existing entry keeps its label and creation time; `opts.label` names a
   * new one.
   */
  put(ref: string, value: string, opts?: { label?: string }): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.data.entries[ref];
      const { blob, encrypted } = this.encode(value);
      const label = existing?.label ?? opts?.label;
      const entry: SecretEntry = {
        value: blob,
        encrypted,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        ...(label !== undefined ? { label } : {}),
      };
      this.data = { version: 2, entries: { ...this.data.entries, [ref]: entry } };
      await this.persist();
    });
  }

  /** Whether values are really encrypted at rest here; team secrets refuse to make a key without it. */
  encryptionAvailable(): boolean {
    return this.crypto.available;
  }
```

- [ ] **Step 4: The status wire**

In `apps/desktop/src/shared/wire-types.ts`, after `export type SyncConflictWire = …;`, add:

```ts
// ---- team secrets (docs/specs/2026-09-26-team-secrets-design.md §4) -------------------------

const teamSecretsIdSchema = z.string().regex(/^[A-Z2-7]{26}$/);

/** Which secret: a keychain ref the tree names, or one project's `${secret:name}` token. Never a value. */
export const teamSecretsSecretWireSchema = z.union([
  z.object({ ref: z.string() }),
  z.object({ token: z.object({ projectId: z.string(), name: z.string() }) }),
]);
export type TeamSecretsSecretWire = z.infer<typeof teamSecretsSecretWireSchema>;

/** One machine key: who asked, from which machine, and the fingerprint an admin checks out of band. */
export const teamSecretsKeyWireSchema = z.object({
  keyId: teamSecretsIdSchema,
  name: z.string(),
  email: z.string(),
  machine: z.string(),
  fingerprint: z.string(),
  requestedAt: z.string(),
  admin: z.boolean(),
  mine: z.boolean(),
});
export type TeamSecretsKeyWire = z.infer<typeof teamSecretsKeyWireSchema>;

export const teamSecretsRotateMarkWireSchema = z.object({
  entryId: teamSecretsIdSchema,
  label: z.string(),
  secret: teamSecretsSecretWireSchema,
  removedNames: z.array(z.string()),
});
export type TeamSecretsRotateMarkWire = z.infer<typeof teamSecretsRotateMarkWireSchema>;

export const teamSecretsUntrustedWireSchema = z.object({ entryId: teamSecretsIdSchema, label: z.string() });
export const teamSecretsReplacedWireSchema = z.object({
  entryId: teamSecretsIdSchema,
  label: z.string(),
  byName: z.string(),
});
export type TeamSecretsReplacedWire = z.infer<typeof teamSecretsReplacedWireSchema>;

/** `teamSecrets.status` and the `teamSecrets.changed` event: ids, names, fingerprints and labels only. */
export const teamSecretsStatusWireSchema = z.object({
  on: z.boolean(),
  authority: z.enum(['signed', 'server']).optional(),
  canTurnOn: z.boolean(),
  /** May approve, decline and remove (and, with signed authority, change admins). */
  canManage: z.boolean(),
  me: z.object({
    state: z.enum(['unavailable', 'none', 'pending', 'approved', 'removed']),
    keyId: teamSecretsIdSchema.optional(),
    fingerprint: z.string().optional(),
    admin: z.boolean(),
  }),
  /** Why this machine cannot take part, when it cannot (no keychain, a damaged log, removed). */
  message: z.string().optional(),
  pending: z.array(teamSecretsKeyWireSchema),
  approved: z.array(teamSecretsKeyWireSchema),
  /** Server shares: approved keys whose email has no role in the workspace any more (§3.6). */
  formerMembers: z.array(teamSecretsIdSchema),
  rotate: z.array(teamSecretsRotateMarkWireSchema),
  untrusted: z.array(teamSecretsUntrustedWireSchema),
  replaced: z.array(teamSecretsReplacedWireSchema),
  /** Secrets whose value is on this machine only (plan decision 17). */
  localOnly: z.array(teamSecretsSecretWireSchema),
});
export type TeamSecretsStatusWire = z.infer<typeof teamSecretsStatusWireSchema>;
```

- [ ] **Step 5: Write the service**

Create `apps/desktop/src/main/team-secrets-service.ts`:

```ts
/**
 * Team secrets in a shared workspace (docs/specs/2026-09-26-team-secrets-design.md), in main.
 *
 * Owns this machine's key per workspace, kept in the keychain-backed store under
 * `wirebench-team-key:<workspaceId>`, and reads and writes the tree's `team-secrets/` files through the
 * workspace it is attached to. Values and private keys go only into the `SecretStore` and, encrypted,
 * into the tree: every answer is ids, names, fingerprints and labels.
 *
 * One operation at a time (a promise chain). Nothing here awaits the sync queue: the pull hook runs
 * inside a queued sync operation, so commits and server requests are fired, not awaited (plan decision 14).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  accessEntryPath,
  approvedRecipients,
  buildVaultEntry,
  fingerprintOf,
  generateMachineKeys,
  GIT_ATTRIBUTES,
  GIT_ATTRIBUTES_FILE,
  healVaultEntry,
  isTeamSecretsPath,
  keyRequestPath,
  nextAccessEntryId,
  openVaultEntry,
  parseMachineKeys,
  readTeamSecretsFiles,
  replayAccessLog,
  rotateMarks,
  sealVaultEntry,
  secretKeySchema,
  serializeMachineKeys,
  signDocument,
  TEAM_SECRETS_DIR,
  TEAM_SECRETS_MESSAGES,
  teamSecretsError,
  teamSecretsFileText,
  vaultEntryId,
  vaultEntryPath,
  verifiedKeys,
  verifyVaultEntry,
  WirebenchError,
  type AccessAction,
  type AccessState,
  type KeyInfo,
  type MachineKeys,
  type SecretKey,
  type TeamSecretsFiles,
  type VaultEntryFile,
} from '@wirebench/engine';
import type { TeamSecretsKeyWire, TeamSecretsStatusWire } from '../shared/wire-types.js';
import { secretStoreLabel } from './secret-resolver.js';
import type { SecretStore } from './secrets.js';

export const TEAM_KEY_LABEL_PREFIX = 'wirebench-team-key:';
export const TEAM_REPLACED_LABEL_PREFIX = 'wirebench-team-replaced:';
/** Machine-local, in the workspace's app-data folder: the genesis pin, seen entries, replaced notices. */
export const TEAM_SECRETS_LOCAL_FILE = 'team-secrets.json';

const ATTRIBUTES_LINE = 'team-secrets/values/** -merge';
const DAMAGED_MESSAGE =
  'An access change is missing from this workspace. Restore it from the history before changing team secrets.';
const REMOVED_MESSAGE = 'An admin removed this machine from team secrets.';

export const TEAM_SECRETS_OFF: TeamSecretsStatusWire = {
  on: false,
  canTurnOn: false,
  canManage: false,
  me: { state: 'none', admin: false },
  pending: [],
  approved: [],
  formerMembers: [],
  rotate: [],
  untrusted: [],
  replaced: [],
  localOnly: [],
};

export type TeamSecretsStore = Pick<
  SecretStore,
  'get' | 'set' | 'put' | 'delete' | 'findByLabel' | 'list' | 'encryptionAvailable'
>;

/** One secret the workspace's projects use. */
export interface SecretUse {
  readonly secret: SecretKey;
}

/** What the service needs from the open shared workspace; `WorkspaceService` builds it (Task 9). */
export interface TeamSecretsWorkspace {
  readonly workspaceId: string;
  /** The workspace's app-data folder, never the tree. */
  readonly dir: string;
  readonly tree: string;
  readonly kind: 'git' | 'folder' | 'server';
  /** The server role; `undefined` for git and folder shares, and before the first fetch. */
  readonly role: () => 'viewer' | 'editor' | 'admin' | undefined;
  readonly uses: () => readonly SecretUse[];
  readonly identity: () => Promise<{ readonly name: string; readonly email: string } | undefined>;
  /** Tree paths about to be written or removed: the watcher's self-writes. */
  readonly beforeWrite: (paths: readonly string[]) => void;
  /** Files were written: commit (and push) under `message`, as a save would. Never awaited. */
  readonly afterWrite: (message: string) => void;
  /** Server shares: sends a key request through the route (§5.1). */
  readonly requestKey?: (keyId: string, content: string) => Promise<void>;
  /** Server shares: the emails with a role now; `undefined` when this account may not ask. */
  readonly memberEmails?: () => Promise<readonly string[] | undefined>;
}

export interface TeamSecretsServiceDeps {
  /** The raw keychain-backed store: never the team-aware wrapper, which would write the vault again. */
  readonly store: TeamSecretsStore;
  readonly onChanged?: (workspaceId: string, status: TeamSecretsStatusWire) => void;
  readonly now?: () => Date;
  /** The machine label on a key request; the host name by default. */
  readonly machine?: () => string;
  /** The name on a folder share's key request, which has no commit identity (plan decision 21). */
  readonly osUser?: () => string;
  /** Messages only: never a value. */
  readonly log?: (message: string) => void;
}

const localStateSchema = z.object({
  version: z.literal(1),
  genesisId: z.string().optional(),
  seenAccess: z.array(z.string()).default([]),
  replaced: z
    .array(
      z.object({
        entryId: z.string(),
        label: z.string(),
        byName: z.string(),
        secret: secretKeySchema,
        /** The store ref the losing value is kept under, on this machine only. */
        storedRef: z.string(),
      }),
    )
    .default([]),
});
type LocalState = z.infer<typeof localStateSchema>;

interface View {
  readonly ws: TeamSecretsWorkspace;
  readonly files: TeamSecretsFiles;
  readonly access: AccessState;
  readonly me: MachineKeys | undefined;
  readonly local: LocalState;
  /** A remembered access entry is missing from the tree (plan decision 4). */
  readonly damaged: boolean;
}

type MyState = TeamSecretsStatusWire['me']['state'];

async function readTreeFiles(tree: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const kind of ['keys', 'access', 'values']) {
    const dir = join(tree, TEAM_SECRETS_DIR, kind);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = `${TEAM_SECRETS_DIR}/${kind}/${name}`;
      if (!isTeamSecretsPath(path)) {
        continue;
      }
      try {
        files.set(path, await readFile(join(dir, name), 'utf8'));
      } catch {
        // Gone since the listing: a pull or an outside edit moved it.
      }
    }
  }
  return files;
}

async function readLocalState(dir: string): Promise<LocalState> {
  try {
    return localStateSchema.parse(JSON.parse(await readFile(join(dir, TEAM_SECRETS_LOCAL_FILE), 'utf8')));
  } catch {
    return { version: 1, seenAccess: [], replaced: [] };
  }
}

async function writeLocalState(dir: string, state: LocalState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, TEAM_SECRETS_LOCAL_FILE), JSON.stringify(state, null, 2), 'utf8');
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return a !== undefined && b !== undefined && a.length === b.length && a.every((item, i) => item === b[i]);
}

export class TeamSecretsService {
  private ws: TeamSecretsWorkspace | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** What the send path reads synchronously (Task 7): refreshed by every load. */
  protected cache: { on: boolean; approved: boolean; vaultIds: ReadonlySet<string> } = {
    on: false,
    approved: false,
    vaultIds: new Set(),
  };
  private members: readonly string[] | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: TeamSecretsServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** The open shared workspace; `WorkspaceService` calls it on open, before sync starts. */
  attach(ws: TeamSecretsWorkspace): void {
    this.ws = ws;
    this.members = undefined;
    this.cache = { on: false, approved: false, vaultIds: new Set() };
  }

  /** The workspace closed: nothing further touches its tree, and the operation in flight finishes. */
  async detach(): Promise<void> {
    this.ws = undefined;
    this.cache = { on: false, approved: false, vaultIds: new Set() };
    await this.queue.catch(() => undefined);
  }

  status(): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.ws;
      return ws === undefined ? TEAM_SECRETS_OFF : await this.statusOf(await this.load(ws));
    });
  }

  /** §3.1: genesis, this machine's key and every value it holds; `commit: false` inside the share's own first commit. */
  turnOn(options: { readonly commit: boolean } = { commit: true }): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      await this.turnOnNow(ws, options.commit);
      return await this.emit(ws);
    });
  }

  /** Plan decision 10: a server share turns on after its first push, when the sharer turns out to be an admin. */
  turnOnIfAdmin(): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.ws;
      if (ws?.kind !== 'server' || ws.role() !== 'admin' || (await this.load(ws)).access.on) {
        return;
      }
      await this.turnOnNow(ws, true);
      await this.emit(ws);
    });
  }

  /** After every pull, and a folder share's outside edit under `team-secrets/`. Never throws. */
  afterPull(_paths: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.ws;
      if (ws === undefined) {
        return;
      }
      try {
        await this.refreshNow(ws);
      } catch (error) {
        this.deps.log?.(`[team-secrets] refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.emit(ws);
    });
  }

  /** §3.2: an `approve` entry and every vault entry this machine can open healed for the new key, in one commit. */
  approve(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      const subject = this.pendingKey(view, keyId);
      const entry = this.accessEntry(view, 'approve', keyId, me);
      const next = this.replayWith(view, entry);
      const files = new Map<string, string | null>([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]);
      for (const [id, value] of this.trustedValues(view)) {
        const healed = healVaultEntry(value, next, me);
        if (healed !== undefined) {
          files.set(vaultEntryPath(id), teamSecretsFileText(healed));
        }
      }
      await this.write(view.ws, files);
      view.ws.afterWrite(`Approve team secrets access for ${subject.name}`);
      return await this.emit(view.ws);
    });
  }

  /** §3.2: deletes the request file. */
  decline(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view } = await this.managerView();
      const subject = this.pendingKey(view, keyId);
      await this.write(view.ws, new Map([[keyRequestPath(keyId), null]]));
      view.ws.afterWrite(`Decline team secrets access for ${subject.name}`);
      return await this.emit(view.ws);
    });
  }

  /** §3.6: a `remove` entry and every value it can open sealed again for the remaining keys, in one commit. */
  remove(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      const subject = this.approvedKey(view, keyId);
      if (view.access.authority === 'signed' && view.access.admins.has(keyId) && view.access.admins.size === 1) {
        throw teamSecretsError('team-secrets-last-admin');
      }
      const entry = this.accessEntry(view, 'remove', keyId, me);
      const recipients = approvedRecipients(this.replayWith(view, entry));
      const files = new Map<string, string | null>([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]);
      for (const [id, value] of this.trustedValues(view)) {
        const plain = openVaultEntry(value, me);
        if (plain !== undefined) {
          files.set(vaultEntryPath(id), teamSecretsFileText(sealVaultEntry(value, plain, recipients, me)));
        }
      }
      await this.write(view.ws, files);
      view.ws.afterWrite(`Remove ${subject.name} from team secrets`);
      return await this.emit(view.ws);
    });
  }

  grantAdmin(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.changeAdmin(keyId, 'grant-admin');
  }

  revokeAdmin(keyId: string): Promise<TeamSecretsStatusWire> {
    return this.changeAdmin(keyId, 'revoke-admin');
  }

  /** Plan decision 20: a removed machine makes a fresh key and asks again. */
  requestAccess(): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      const view = await this.load(ws);
      if (!view.access.on || this.myState(view) === 'approved') {
        return await this.statusOf(view);
      }
      await this.sendKeyRequest(ws, await this.newKeys(ws));
      return await this.emit(ws);
    });
  }

  // ——— internals ——————————————————————————————————————————————————————————————————————————

  protected enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }

  protected requireWorkspace(): TeamSecretsWorkspace {
    if (this.ws === undefined) {
      throw new WirebenchError('team-secrets-not-shared', 'Team secrets need a shared workspace.');
    }
    return this.ws;
  }

  protected get attached(): TeamSecretsWorkspace | undefined {
    return this.ws;
  }

  protected get store(): TeamSecretsStore {
    return this.deps.store;
  }

  protected get clock(): () => Date {
    return this.now;
  }

  private keyLabel(ws: TeamSecretsWorkspace): string {
    return `${TEAM_KEY_LABEL_PREFIX}${ws.workspaceId}`;
  }

  private async myKeys(ws: TeamSecretsWorkspace): Promise<MachineKeys | undefined> {
    const ref = await this.deps.store.findByLabel(this.keyLabel(ws));
    const text = ref === undefined ? undefined : await this.deps.store.get(ref);
    return text === undefined ? undefined : parseMachineKeys(text);
  }

  /** A fresh key pair for this workspace, replacing any older one. @throws team-secrets-no-safe-storage */
  private async newKeys(ws: TeamSecretsWorkspace): Promise<MachineKeys> {
    if (!this.deps.store.encryptionAvailable()) {
      throw teamSecretsError('team-secrets-no-safe-storage');
    }
    const keys = generateMachineKeys();
    const label = this.keyLabel(ws);
    const existing = await this.deps.store.findByLabel(label);
    if (existing === undefined) {
      await this.deps.store.set(serializeMachineKeys(keys), { label });
    } else {
      await this.deps.store.put(existing, serializeMachineKeys(keys));
    }
    return keys;
  }

  /** Reads the tree and replays the log, pinning the genesis and every valid entry seen (plan decision 4). */
  protected async load(ws: TeamSecretsWorkspace): Promise<View> {
    const files = readTeamSecretsFiles(await readTreeFiles(ws.tree));
    let local = await readLocalState(ws.dir);
    const access = replayAccessLog(
      verifiedKeys(files.keys),
      files.access,
      local.genesisId !== undefined ? { genesisId: local.genesisId } : {},
    );
    const present = new Set(files.access.map((entry) => entry.id));
    const damaged = local.seenAccess.some((id) => !present.has(id));
    if (access.on && !damaged) {
      const rejected = new Set(access.problems.map((problem) => problem.id));
      const seen = [...new Set([...local.seenAccess, ...[...present].filter((id) => !rejected.has(id))])].sort();
      if (local.genesisId !== access.genesisId || !sameList(seen, local.seenAccess)) {
        local = { ...local, ...(access.genesisId !== undefined ? { genesisId: access.genesisId } : {}), seenAccess: seen };
        await writeLocalState(ws.dir, local);
      }
    }
    const me = await this.myKeys(ws);
    this.cache = {
      on: access.on,
      approved: me !== undefined && access.approved.has(me.keyId),
      vaultIds: new Set(files.values.keys()),
    };
    return { ws, files, access, me, local, damaged };
  }

  protected async saveLocal(ws: TeamSecretsWorkspace, local: LocalState): Promise<void> {
    await writeLocalState(ws.dir, local);
  }

  protected myState(view: View): MyState {
    const { me, access } = view;
    if (me === undefined) {
      return this.deps.store.encryptionAvailable() ? 'none' : 'unavailable';
    }
    if (access.approved.has(me.keyId)) {
      return 'approved';
    }
    return access.removed.some((removal) => removal.keyId === me.keyId) ? 'removed' : 'pending';
  }

  /** Plan decisions 4, 13: approved, not a server viewer, and the log intact. */
  protected canWriteVault(view: View): boolean {
    return (
      view.access.on &&
      !view.damaged &&
      this.myState(view) === 'approved' &&
      !(view.ws.kind === 'server' && view.ws.role() === 'viewer')
    );
  }

  private isManager(view: View): boolean {
    if (!this.canWriteVault(view) || view.me === undefined) {
      return false;
    }
    return view.access.authority === 'signed' ? view.access.admins.has(view.me.keyId) : view.ws.role() === 'admin';
  }

  private async managerView(): Promise<{ view: View; me: MachineKeys }> {
    const view = await this.load(this.requireWorkspace());
    if (!this.isManager(view) || view.me === undefined) {
      throw teamSecretsError('team-secrets-admin-only');
    }
    return { view, me: view.me };
  }

  private pendingKey(view: View, keyId: string): KeyInfo {
    const subject = view.access.keys.get(keyId);
    const removed = view.access.removed.some((removal) => removal.keyId === keyId);
    if (subject === undefined || view.access.approved.has(keyId) || removed) {
      throw new WirebenchError('team-secrets-no-such-key', 'That machine is not waiting for approval.');
    }
    return subject;
  }

  private approvedKey(view: View, keyId: string): KeyInfo {
    const subject = view.access.keys.get(keyId);
    if (subject === undefined || !view.access.approved.has(keyId)) {
      throw new WirebenchError('team-secrets-no-such-key', 'That machine is not approved for team secrets.');
    }
    return subject;
  }

  private changeAdmin(keyId: string, action: 'grant-admin' | 'revoke-admin'): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const { view, me } = await this.managerView();
      if (view.access.authority !== 'signed') {
        throw new WirebenchError(
          'team-secrets-server-authority',
          'On a server workspace, the server roles decide who is an admin.',
        );
      }
      const subject = this.approvedKey(view, keyId);
      if (action === 'revoke-admin' && view.access.admins.has(keyId) && view.access.admins.size === 1) {
        throw teamSecretsError('team-secrets-last-admin');
      }
      const entry = this.accessEntry(view, action, keyId, me);
      await this.write(view.ws, new Map([[accessEntryPath(entry.id), teamSecretsFileText(entry)]]));
      view.ws.afterWrite(
        action === 'grant-admin'
          ? `Make ${subject.name} a team secrets admin`
          : `Remove ${subject.name} as a team secrets admin`,
      );
      return await this.emit(view.ws);
    });
  }

  private accessEntry(view: View, action: AccessAction, key: string, me: MachineKeys) {
    const now = this.now();
    return signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId(
          view.files.access.map((entry) => entry.id),
          now.getTime(),
        ),
        action,
        key,
        by: me.keyId,
        at: now.toISOString(),
      },
      me,
    );
  }

  private replayWith(view: View, entry: ReturnType<TeamSecretsService['accessEntry']>): AccessState {
    return replayAccessLog(
      view.access.keys,
      [...view.files.access, entry],
      view.local.genesisId !== undefined ? { genesisId: view.local.genesisId } : {},
    );
  }

  /** The vault entries the replay trusts, by id. */
  protected trustedValues(view: View): Map<string, VaultEntryFile> {
    return new Map([...view.files.values].filter(([id, entry]) => verifyVaultEntry(entry, id, view.access) === 'trusted'));
  }

  /** Writes (text) or removes (`null`) tree files, announcing them to the watcher first. */
  protected async write(ws: TeamSecretsWorkspace, files: ReadonlyMap<string, string | null>): Promise<void> {
    ws.beforeWrite([...files.keys()]);
    for (const [path, text] of files) {
      const full = join(ws.tree, ...path.split('/'));
      if (text === null) {
        await rm(full, { force: true });
      } else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, text, 'utf8');
      }
    }
  }

  private async keyRequestText(ws: TeamSecretsWorkspace, keys: MachineKeys): Promise<{ text: string; name: string }> {
    const identity = await ws.identity().catch(() => undefined);
    const name = identity?.name || (this.deps.osUser ?? ((): string => userInfo().username))() || 'Someone';
    const machine = (this.deps.machine ?? hostname)() || 'this machine';
    const doc = signDocument(
      {
        version: 1 as const,
        keyId: keys.keyId,
        encryptionKey: keys.encryptionKey,
        signingKey: keys.signingKey,
        name,
        email: identity?.email ?? '',
        machine,
        requestedAt: this.now().toISOString(),
      },
      keys,
    );
    return { text: teamSecretsFileText(doc), name };
  }

  /** §3.2: a file and a commit on git and folder shares; the route on a server share (plan decision 11). */
  private async sendKeyRequest(ws: TeamSecretsWorkspace, keys: MachineKeys): Promise<void> {
    const { text, name } = await this.keyRequestText(ws, keys);
    if (ws.kind === 'server') {
      void ws.requestKey?.(keys.keyId, text).catch((error: unknown) => {
        this.deps.log?.(`[team-secrets] key request failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    await this.write(ws, new Map([[keyRequestPath(keys.keyId), text]]));
    ws.afterWrite(`Request team secrets access for ${name}`);
  }

  /** Makes a key and asks for access when this machine has neither asked nor been approved or removed. */
  protected async ensureRequested(view: View): Promise<void> {
    const state = this.myState(view);
    if (state !== 'none' && state !== 'pending') {
      return;
    }
    const keys = view.me ?? (await this.newKeys(view.ws));
    if (!view.access.keys.has(keys.keyId)) {
      await this.sendKeyRequest(view.ws, keys);
    }
  }

  private async turnOnNow(ws: TeamSecretsWorkspace, commit: boolean): Promise<void> {
    const view = await this.load(ws);
    if (view.access.on || view.damaged) {
      return;
    }
    if (ws.kind === 'server' && ws.role() !== 'admin') {
      throw teamSecretsError('team-secrets-admin-only');
    }
    const me = view.me ?? (await this.newKeys(ws));
    const { text } = await this.keyRequestText(ws, me);
    const genesis = signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId([], this.now().getTime()),
        action: 'genesis' as const,
        authority: ws.kind === 'server' ? ('server' as const) : ('signed' as const),
        key: me.keyId,
        by: me.keyId,
        at: this.now().toISOString(),
      },
      me,
    );
    const files = new Map<string, string | null>([
      [keyRequestPath(me.keyId), text],
      [accessEntryPath(genesis.id), teamSecretsFileText(genesis)],
    ]);
    if (ws.kind === 'git') {
      const attributes = await this.attributesWithMerge(ws);
      if (attributes !== undefined) {
        files.set(GIT_ATTRIBUTES_FILE, attributes);
      }
    }
    await this.write(ws, files);
    await writeLocalState(ws.dir, { ...view.local, genesisId: genesis.id, seenAccess: [genesis.id] });
    const values = await this.backfillFiles(await this.load(ws));
    if (values.size > 0) {
      await this.write(ws, values);
    }
    if (commit) {
      ws.afterWrite('Turn on team secrets');
    }
  }

  /** Plan decision 2: the tree's `.gitattributes` with the `-merge` line, or `undefined` when it has it. */
  private async attributesWithMerge(ws: TeamSecretsWorkspace): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(join(ws.tree, GIT_ATTRIBUTES_FILE), 'utf8');
    } catch {
      return GIT_ATTRIBUTES;
    }
    if (text.split(/\r?\n/).some((line) => line.trim() === ATTRIBUTES_LINE)) {
      return undefined;
    }
    return `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${ATTRIBUTES_LINE}\n`;
  }

  /** §3.1: an entry for every secret the workspace uses whose value this machine holds and the vault lacks. */
  protected async backfillFiles(view: View): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.canWriteVault(view) || view.me === undefined) {
      return out;
    }
    const recipients = approvedRecipients(view.access);
    const done = new Set<string>();
    for (const use of view.ws.uses()) {
      const id = vaultEntryId(use.secret);
      if (view.files.values.has(id) || done.has(id)) {
        continue;
      }
      done.add(id);
      const stored = await this.storedValue(use.secret);
      if (stored !== undefined) {
        const entry = buildVaultEntry({
          secret: use.secret,
          label: stored.label,
          value: stored.value,
          recipients,
          signer: view.me,
          at: this.now().toISOString(),
        });
        out.set(vaultEntryPath(id), teamSecretsFileText(entry));
      }
    }
    return out;
  }

  /** This machine's value for `secret`, with its display label; `undefined` when none is stored. */
  protected async storedValue(secret: SecretKey): Promise<{ value: string; label: string } | undefined> {
    const { store } = this.deps;
    if ('ref' in secret) {
      const value = await store.get(secret.ref);
      if (value === undefined) {
        return undefined;
      }
      const label = (await store.list()).find((entry) => entry.ref === secret.ref)?.label ?? secret.ref;
      return { value, label };
    }
    const ref = await store.findByLabel(secretStoreLabel(secret.token.projectId, secret.token.name));
    const value = ref === undefined ? undefined : await store.get(ref);
    return value === undefined ? undefined : { value, label: secret.token.name };
  }

  /** Task 8 replaces this with the full pull hook; here it only asks for access. */
  protected async refreshNow(ws: TeamSecretsWorkspace): Promise<void> {
    const view = await this.load(ws);
    if (view.access.on && !view.damaged) {
      await this.ensureRequested(view);
    }
  }

  protected async statusOf(view: View): Promise<TeamSecretsStatusWire> {
    const { access, me, ws } = view;
    if (!access.on && !view.damaged) {
      return {
        ...TEAM_SECRETS_OFF,
        canTurnOn: this.deps.store.encryptionAvailable() && (ws.kind !== 'server' || ws.role() === 'admin'),
        me: { state: this.myState(view), admin: false },
      };
    }
    const state = this.myState(view);
    const removed = new Set(access.removed.map((removal) => removal.keyId));
    const keyWire = (info: KeyInfo): TeamSecretsKeyWire => ({
      keyId: info.keyId,
      name: info.name,
      email: info.email,
      machine: info.machine,
      fingerprint: info.fingerprint,
      requestedAt: info.requestedAt,
      admin: access.admins.has(info.keyId),
      mine: info.keyId === me?.keyId,
    });
    const approved = approvedRecipients(access);
    const members = this.members;
    const message =
      state === 'unavailable'
        ? TEAM_SECRETS_MESSAGES['team-secrets-no-safe-storage']
        : view.damaged
          ? DAMAGED_MESSAGE
          : state === 'removed'
            ? REMOVED_MESSAGE
            : undefined;
    const localOnly: SecretKey[] = [];
    if (!this.canWriteVault(view)) {
      for (const use of ws.uses()) {
        if ((await this.storedValue(use.secret)) !== undefined) {
          localOnly.push(use.secret);
        }
      }
    }
    return {
      on: true,
      ...(access.authority !== undefined ? { authority: access.authority } : {}),
      canTurnOn: false,
      canManage: this.isManager(view),
      me: {
        state,
        ...(me !== undefined ? { keyId: me.keyId, fingerprint: fingerprintOf(me) } : {}),
        admin: me !== undefined && access.admins.has(me.keyId),
      },
      ...(message !== undefined ? { message } : {}),
      pending: [...access.keys.values()]
        .filter((info) => !access.approved.has(info.keyId) && !removed.has(info.keyId))
        .map(keyWire),
      approved: approved.map(keyWire),
      formerMembers:
        ws.kind === 'server' && members !== undefined
          ? approved.filter((info) => !members.includes(info.email.toLowerCase())).map((info) => info.keyId)
          : [],
      rotate: rotateMarks(this.trustedValues(view), access),
      untrusted: [...view.files.values]
        .filter(([id, entry]) => verifyVaultEntry(entry, id, access) !== 'trusted')
        .map(([entryId, entry]) => ({ entryId, label: entry.label })),
      replaced: view.local.replaced.map(({ entryId, label, byName }) => ({ entryId, label, byName })),
      localOnly,
    };
  }

  /** Reports the status to `onChanged`; on a server share an admin's member list is refreshed behind it. */
  protected async emit(ws: TeamSecretsWorkspace): Promise<TeamSecretsStatusWire> {
    const status = await this.statusOf(await this.load(ws));
    this.deps.onChanged?.(ws.workspaceId, status);
    if (ws.kind === 'server' && status.canManage && ws.memberEmails !== undefined) {
      void ws
        .memberEmails()
        .then(async (emails) => {
          if (this.ws !== ws || sameList(emails, this.members)) {
            return;
          }
          this.members = emails;
          this.deps.onChanged?.(ws.workspaceId, await this.status());
        })
        .catch(() => undefined);
    }
    return status;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts apps/desktop/test/secrets.test.ts`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/secrets.ts apps/desktop/src/shared/wire-types.ts \
  apps/desktop/src/main/team-secrets-service.ts apps/desktop/test/team-secrets-service.test.ts \
  apps/desktop/test/secrets.test.ts
git commit -m "feat(desktop): team secrets service — machine keys, turning on, approvals (#38)

Each machine keeps one key pair per workspace in the keychain-backed store and refuses to make one
without OS encryption. Turning on writes this machine's key, a genesis naming it admin and a vault
entry for every value it already holds. A machine that is not approved asks on its next sync, through
a file and a commit or, on a server share, the key-request route. Approving heals every value for the
new key; removing seals every value again without the removed key, whose earlier values are marked for
rotation. Answers carry ids, names, fingerprints and labels only."
```

---

## Task 7: desktop main — saving a value writes the vault; a waiting machine says so at send

**Files:**
- Modify: `apps/desktop/src/main/team-secrets-service.ts` (`recordValue`, `forget`, `waitingFor`)
- Create: `apps/desktop/src/main/team-secret-store.ts`
- Test: `apps/desktop/test/team-secrets-service.test.ts` (append), `apps/desktop/test/team-secret-store.test.ts` (new)

**Interfaces:**
- Consumes: Task 6's service and test helpers; `parseSecretPseudoRef` (engine); `secretStoreLabel`.
- Produces:
  - `TeamSecretsService.recordValue(secret: SecretKey, label: string, value: string): Promise<void>` — writes (or
    rewrites) the vault entry sealed for every approved key and commits `Update secret <label>`; does nothing
    when this machine may not write the vault (plan decisions 13, 17) or the vault already holds that value.
  - `TeamSecretsService.forget(secret: SecretKey, label: string): Promise<void>` — removes the entry and commits
    `Delete secret <label>` (plan decision 18).
  - `TeamSecretsService.waitingFor(ref: string, projectId: string | undefined): boolean` — synchronous: team
    secrets are on, this machine is not approved, and the vault holds an entry for that ref or token.
  - `team-secret-store.ts`: `secretOfLabel(ref: string, label: string | undefined): SecretKey` (a
    `wirebench-secret:<projectId>:<name>` label → the token, anything else → the ref),
    `class TeamSecretStore` implementing `Pick<SecretStore, 'set' | 'replace' | 'exists' | 'delete' | 'findByLabel' | 'list'>`
    over the raw store, and `teamSecretGetter(inner: GetSecret, service: Pick<TeamSecretsService, 'waitingFor'>,
    projectId: string | undefined): GetSecret`, which throws `team-secrets-pending` for a value this machine is
    waiting for instead of answering `undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/team-secrets-service.test.ts`:

```ts
describe('TeamSecretsService — saving values (§3.3)', () => {
  it('writes a value an approved machine saves, sealed for every approved key, and deletes it again', async () => {
    const { a, b } = await aliceAndBob();
    const other = { ref: 'sec_abcdefabcdefabcdefabcdefab' };

    await b.service.recordValue(other, 'Token', 'tok-123');

    expect(b.commits.at(-1)).toBe('Update secret Token');
    const entry = await vaultEntry(other.ref);
    expect(Object.keys(entry.wraps).sort()).toEqual(
      [(await a.service.status()).me.keyId!, (await b.service.status()).me.keyId!].sort(),
    );
    expect(await treeText()).not.toContain('tok-123');

    await b.service.recordValue(other, 'Token', 'tok-123');
    expect(b.commits.filter((message) => message === 'Update secret Token')).toHaveLength(1);

    await b.service.forget(other, 'Token');
    expect(b.commits.at(-1)).toBe('Delete secret Token');
    await expect(vaultEntry(other.ref)).rejects.toThrow();
  });

  it('keeps a value local on a machine that is not approved, or is a server viewer', async () => {
    const a = machine('Alice');
    await a.service.turnOn();
    const b = machine('Bob');
    await b.service.afterPull([]);
    b.uses = [{ secret: { ref: REF } }];
    await b.store.put(REF, 'mine-only', { label: 'Password' });

    await b.service.recordValue({ ref: REF }, 'Password', 'mine-only');

    expect(b.commits).toEqual(['Request team secrets access for Bob']);
    expect((await b.service.status()).localOnly).toEqual([{ ref: REF }]);
  });

  it('keeps an approved server viewer’s value local until the role allows writing (plan decision 13)', async () => {
    const admin = machine('Ann', { kind: 'server', role: 'admin' });
    await admin.service.turnOn();
    const viewer = machine('Vic', { kind: 'server', role: 'viewer' });
    await viewer.service.afterPull([]);
    await new Promise((resolve) => setImmediate(resolve));
    await admin.service.approve((await viewer.service.status()).me.keyId!);

    await viewer.service.recordValue({ ref: REF }, 'Password', 'viewer-value');
    await expect(vaultEntry()).rejects.toThrow();

    viewer.role = 'editor';
    await viewer.service.recordValue({ ref: REF }, 'Password', 'editor-value');
    expect((await vaultEntry()).label).toBe('Password');
    expect(await treeText()).not.toContain('editor-value');
  });

  it('says a machine is waiting for a value the vault holds for it', async () => {
    const a = machine('Alice');
    await a.store.put(REF, 'hunter2', { label: 'Password' });
    a.uses = [{ secret: { ref: REF } }];
    await a.service.turnOn();
    const b = machine('Bob');
    await b.service.afterPull([]);

    expect(b.service.waitingFor(REF, undefined)).toBe(true);
    expect(b.service.waitingFor('sec_ffffffffffffffffffffffffff', undefined)).toBe(false);
    expect(a.service.waitingFor(REF, undefined)).toBe(false);
  });
});
```

Create `apps/desktop/test/team-secret-store.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { secretOfLabel, TeamSecretStore, teamSecretGetter } from '../src/main/team-secret-store.js';

const REF = 'sec_0123456789abcdef0123456789';

function rawStore() {
  const values = new Map<string, { value: string; label?: string }>();
  let next = 0;
  return {
    values,
    set: vi.fn((value: string, opts?: { label?: string }) => {
      const ref = `sec_${String(next++).padStart(26, '0')}`;
      values.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return Promise.resolve(ref);
    }),
    replace: vi.fn((ref: string, value: string) => {
      values.set(ref, { ...values.get(ref), value });
      return Promise.resolve(ref);
    }),
    exists: vi.fn((ref: string) => Promise.resolve(values.has(ref))),
    delete: vi.fn((ref: string) => Promise.resolve(values.delete(ref))),
    findByLabel: vi.fn((label: string) =>
      Promise.resolve([...values].find(([, entry]) => entry.label === label)?.[0]),
    ),
    list: vi.fn(() =>
      Promise.resolve(
        [...values].map(([ref, entry]) => ({
          ref,
          createdAt: '2026-09-26T10:00:00.000Z',
          ...(entry.label !== undefined ? { label: entry.label } : {}),
        })),
      ),
    ),
  };
}

function service() {
  return {
    recordValue: vi.fn(() => Promise.resolve()),
    forget: vi.fn(() => Promise.resolve()),
  };
}

describe('secretOfLabel', () => {
  it('reads a token label as the token and anything else as the ref', () => {
    expect(secretOfLabel(REF, 'wirebench-secret:proj-1:api_token')).toEqual({
      token: { projectId: 'proj-1', name: 'api_token' },
    });
    expect(secretOfLabel(REF, 'Password')).toEqual({ ref: REF });
    expect(secretOfLabel(REF, undefined)).toEqual({ ref: REF });
  });
});

describe('TeamSecretStore', () => {
  it('stores the value on this machine first, then hands it to the vault', async () => {
    const raw = rawStore();
    const team = service();
    const store = new TeamSecretStore(raw, team);

    const ref = await store.set('hunter2', { label: 'Password' });
    await store.replace(ref, 'hunter3');
    // What the `${secret:name}` dialog (SecretScanSession.setValue) calls.
    await store.set('tok-1', { label: 'wirebench-secret:proj-1:api_token' });

    expect(raw.values.get(ref)?.value).toBe('hunter3');
    expect(team.recordValue.mock.calls).toEqual([
      [{ ref }, 'Password', 'hunter2'],
      [{ ref }, 'Password', 'hunter3'],
      [{ token: { projectId: 'proj-1', name: 'api_token' } }, 'api_token', 'tok-1'],
    ]);
  });

  it('forgets a deleted value, and never fails a save over the vault', async () => {
    const raw = rawStore();
    const team = service();
    team.recordValue.mockRejectedValue(new Error('disk full'));
    const log = vi.fn();
    const store = new TeamSecretStore(raw, team, log);

    const ref = await store.set('hunter2', { label: 'Password' });
    expect(await store.delete(ref)).toBe(true);

    expect(raw.values.has(ref)).toBe(false);
    expect(team.forget).toHaveBeenCalledWith({ ref }, 'Password');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });
});

describe('teamSecretGetter', () => {
  it('answers a stored value, refuses a value this machine waits for, and passes on a plain miss', async () => {
    const inner = vi.fn((ref: string) => Promise.resolve(ref === REF ? 'hunter2' : undefined));
    const waiting = { waitingFor: vi.fn((ref: string) => ref === 'sec_waitingwaitingwaitingwait') };
    const get = teamSecretGetter(inner, waiting, 'proj-1');

    expect(await get(REF)).toBe('hunter2');
    expect(await get('sec_missingmissingmissingmiss')).toBeUndefined();
    const refused = await get('sec_waitingwaitingwaitingwait').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WirebenchError);
    expect(refused).toMatchObject({
      code: 'team-secrets-pending',
      message: 'This machine is waiting for an admin to approve it for team secrets.',
    });
    expect(waiting.waitingFor).toHaveBeenCalledWith('sec_waitingwaitingwaitingwait', 'proj-1');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts apps/desktop/test/team-secret-store.test.ts`
Expected: FAIL — `recordValue` is not a function; `team-secret-store.ts` does not exist.

- [ ] **Step 3: The service's value methods**

In `apps/desktop/src/main/team-secrets-service.ts`, add `parseSecretPseudoRef` to the engine import and these
public methods after `requestAccess()`:

```ts
  /** §3.3: the value a save stored on this machine, into the vault for every approved key. */
  recordValue(secret: SecretKey, label: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.attached;
      if (ws === undefined) {
        return;
      }
      const view = await this.load(ws);
      if (!this.canWriteVault(view) || view.me === undefined) {
        if (view.access.on) {
          await this.emit(ws); // the "Only on this machine" mark (plan decision 17)
        }
        return;
      }
      const id = vaultEntryId(secret);
      const existing = view.files.values.get(id);
      if (existing !== undefined && existing.label === label && openVaultEntry(existing, view.me) === value) {
        return;
      }
      const entry = buildVaultEntry({
        secret,
        label,
        value,
        recipients: approvedRecipients(view.access),
        signer: view.me,
        at: this.clock().toISOString(),
      });
      await this.write(ws, new Map([[vaultEntryPath(id), teamSecretsFileText(entry)]]));
      ws.afterWrite(`Update secret ${label}`);
      await this.emit(ws);
    });
  }

  /** Plan decision 18: a value deleted on an approved machine leaves the vault too. */
  forget(secret: SecretKey, label: string): Promise<void> {
    return this.enqueue(async () => {
      const ws = this.attached;
      if (ws === undefined) {
        return;
      }
      const view = await this.load(ws);
      const id = vaultEntryId(secret);
      if (!this.canWriteVault(view) || !view.files.values.has(id)) {
        return;
      }
      await this.write(ws, new Map([[vaultEntryPath(id), null]]));
      ws.afterWrite(`Delete secret ${label}`);
      await this.emit(ws);
    });
  }

  /**
   * §3.2: whether a send that found no value should say this machine is waiting for approval. Reads
   * the state the last load cached, so the send path never waits on the tree.
   */
  waitingFor(ref: string, projectId: string | undefined): boolean {
    if (!this.cache.on || this.cache.approved) {
      return false;
    }
    const name = parseSecretPseudoRef(ref);
    if (name !== undefined && projectId === undefined) {
      return false;
    }
    const secret: SecretKey = name === undefined ? { ref } : { token: { projectId: projectId!, name } };
    return this.cache.vaultIds.has(vaultEntryId(secret));
  }
```

- [ ] **Step 4: The team-aware store and getter**

Create `apps/desktop/src/main/team-secret-store.ts`:

```ts
/**
 * The store the renderer's `secrets.*` channels and the secret scan write through (plan decision 18):
 * the value lands in the keychain-backed store first, exactly as before, and is then handed to team
 * secrets, which seal it into the vault when this machine may. A vault failure is logged — never the
 * value — and never fails the save.
 *
 * Main's own writers (sign-in tokens, OAuth refresh tokens, a cURL import) keep the raw store: they
 * are this machine's, not the team's.
 */
import { teamSecretsError, type GetSecret, type SecretKey } from '@wirebench/engine';
import type { SecretStore } from './secrets.js';
import type { TeamSecretsService } from './team-secrets-service.js';

const TOKEN_LABEL = /^wirebench-secret:([^:]+):(.+)$/;

/** Which secret a store entry is, for the vault: a token's label names its project and name. */
export function secretOfLabel(ref: string, label: string | undefined): SecretKey {
  const match = label === undefined ? null : TOKEN_LABEL.exec(label);
  return match === null ? { ref } : { token: { projectId: match[1]!, name: match[2]! } };
}

function displayLabel(secret: SecretKey, label: string | undefined, ref: string): string {
  return 'token' in secret ? secret.token.name : (label ?? ref);
}

type RawStore = Pick<SecretStore, 'set' | 'replace' | 'exists' | 'delete' | 'findByLabel' | 'list'>;

export class TeamSecretStore implements RawStore {
  constructor(
    private readonly raw: RawStore,
    private readonly team: Pick<TeamSecretsService, 'recordValue' | 'forget'>,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  async set(value: string, opts?: { label?: string }): Promise<string> {
    const ref = await this.raw.set(value, opts);
    await this.record(ref, opts?.label, value);
    return ref;
  }

  async replace(ref: string, value: string): Promise<string> {
    const stored = await this.raw.replace(ref, value);
    await this.record(ref, await this.labelOf(ref), value);
    return stored;
  }

  exists(ref: string): Promise<boolean> {
    return this.raw.exists(ref);
  }

  async delete(ref: string): Promise<boolean> {
    const label = await this.labelOf(ref);
    const deleted = await this.raw.delete(ref);
    if (deleted) {
      const secret = secretOfLabel(ref, label);
      await this.team.forget(secret, displayLabel(secret, label, ref)).catch((error: unknown) => {
        this.log(`[team-secrets] could not remove a deleted secret from the vault: ${describe(error)}`);
      });
    }
    return deleted;
  }

  findByLabel(label: string): Promise<string | undefined> {
    return this.raw.findByLabel(label);
  }

  list(): ReturnType<SecretStore['list']> {
    return this.raw.list();
  }

  private async labelOf(ref: string): Promise<string | undefined> {
    return (await this.raw.list()).find((entry) => entry.ref === ref)?.label;
  }

  private async record(ref: string, label: string | undefined, value: string): Promise<void> {
    const secret = secretOfLabel(ref, label);
    await this.team.recordValue(secret, displayLabel(secret, label, ref), value).catch((error: unknown) => {
      this.log(`[team-secrets] could not write a secret to the vault: ${describe(error)}`);
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The send getter with team secrets (§3.2): a value this machine is waiting for refuses the send with
 * `team-secrets-pending` instead of the plain "not on this machine".
 */
export function teamSecretGetter(
  inner: GetSecret,
  service: Pick<TeamSecretsService, 'waitingFor'>,
  projectId: string | undefined,
): GetSecret {
  return async (ref) => {
    const value = await inner(ref);
    if (value === undefined && service.waitingFor(ref, projectId)) {
      throw teamSecretsError('team-secrets-pending');
    }
    return value;
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts apps/desktop/test/team-secret-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/team-secrets-service.ts apps/desktop/src/main/team-secret-store.ts \
  apps/desktop/test/team-secrets-service.test.ts apps/desktop/test/team-secret-store.test.ts
git commit -m "feat(desktop): saving a secret writes the team vault (#38)

A value saved on an approved machine is stored locally first, then sealed into the vault for every
approved key and committed as 'Update secret <label>'; deleting it removes the entry. A machine that
is not approved, or a server viewer, keeps the value local. A send that finds no value the vault holds
for this machine says it is waiting for approval instead of 'not on this machine'."
```

---

## Task 8: desktop main — the pull hook: import, heal, re-encrypt, backfill; vault conflicts

**Files:**
- Modify: `apps/desktop/src/main/team-secrets-service.ts` (`refreshNow` body, `importValue`, `resolveConflicts`,
  `restoreMine`, `dismissReplaced`)
- Test: `apps/desktop/test/team-secrets-service.test.ts` (append)

**Interfaces:**
- Consumes: Task 3's `vaultConflictWinner`, `wrapsUnapprovedKey`, `healVaultEntry`; Task 5's `ConflictSides`
  and the `resolveConflicts` dep shape; `SyncConflictWire`.
- Produces:
  - `refreshNow` (protected; run by `afterPull`): asks for access when needed; once approved, stores every
    trusted value this machine can open that differs from what it holds (raw store: `put` for a ref, `set`/`put`
    under `secretStoreLabel` for a token); logs each untrusted entry by label; then, when it may write the vault,
    heals entries missing an approved key, re-encrypts entries still wrapped for a key that is no longer
    approved (plan decision 6), backfills (§3.1) — all in one write and one commit, `Update team secrets`.
  - `resolveConflicts(conflicts: readonly SyncConflictWire[], sides: (path: string) => Promise<ConflictSides>):
    Promise<Map<string, 'mine' | 'theirs'>>` — decides vault paths only (plan decisions 7, 8); when this
    machine's value loses, it is kept in the store under `wirebench-team-replaced:<entryId>` and a notice is
    recorded (plan decision 9).
  - `restoreMine(entryId: string): Promise<TeamSecretsStatusWire>` and
    `dismissReplaced(entryId: string): Promise<TeamSecretsStatusWire>`.

- [ ] **Step 1: Write the failing tests**

Add to the imports of `apps/desktop/test/team-secrets-service.test.ts`: `accessEntryPath`, `buildVaultEntry`,
`generateMachineKeys`, `keyRequestPath`, `nextAccessEntryId`, `parseMachineKeys`, `signDocument`,
`teamSecretsFileText`, `verifiedKeys`, `keyRequestFileSchema` from `@wirebench/engine`, and append:

```ts
async function keysOf(m: Machine) {
  return parseMachineKeys((await m.store.get((await m.store.findByLabel('wirebench-team-key:ws-1'))!))!)!;
}

async function writeTree(path: string, text: string): Promise<void> {
  const full = join(tree, ...path.split('/'));
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, text, 'utf8');
}

/** The verified keys of every approved and pending machine, read from the tree (the status wire has no public keys). */
async function approvedAndPending(m: Machine) {
  const status = await m.service.status();
  const ids = new Set([...status.approved, ...status.pending].map((key) => key.keyId));
  const names = (await readdir(join(tree, 'team-secrets', 'keys'))).map(String);
  const files = await Promise.all(
    names.map(async (name) =>
      parseTeamSecretsFile(keyRequestFileSchema, await readFile(join(tree, 'team-secrets', 'keys', name), 'utf8'))!,
    ),
  );
  return [...verifiedKeys(files).values()].filter((key) => ids.has(key.keyId));
}

describe('TeamSecretsService — after a pull (§3.2, §3.4)', () => {
  it('stores the values an approved machine can open: refs and tokens', async () => {
    const a = machine('Alice');
    await a.store.put(REF, 'hunter2', { label: 'Password' });
    await a.store.set('tok-1', { label: 'wirebench-secret:proj-1:api_token' });
    a.uses = [{ secret: { ref: REF } }, { secret: { token: { projectId: 'proj-1', name: 'api_token' } } }];
    await a.service.turnOn();
    const b = machine('Bob');
    await b.service.afterPull([]);
    await a.service.approve((await b.service.status()).me.keyId!);

    await b.service.afterPull([]);

    expect(await b.store.get(REF)).toBe('hunter2');
    const tokenRef = await b.store.findByLabel('wirebench-secret:proj-1:api_token');
    expect(await b.store.get(tokenRef!)).toBe('tok-1');
    expect(b.service.waitingFor(REF, undefined)).toBe(false);
  });

  it('ignores a value signed by a key that is not approved, and lists it', async () => {
    const { a, b } = await aliceAndBob();
    await b.service.afterPull([]);
    const c = machine('Carol');
    await c.service.afterPull([]);
    const forged = buildVaultEntry({
      secret: { ref: REF },
      label: 'Password',
      value: 'forged',
      recipients: await approvedAndPending(a),
      signer: await keysOf(c),
      at: '2027-01-01T00:00:00.000Z',
    });
    await writeTree(vaultEntryPath(vaultEntryId({ ref: REF })), teamSecretsFileText(forged));

    await b.service.afterPull([]);

    expect(await b.store.get(REF)).toBe('hunter2');
    expect((await b.service.status()).untrusted).toEqual([{ entryId: vaultEntryId({ ref: REF }), label: 'Password' }]);
  });

  it('re-encrypts a value still wrapped for a key that is not approved (plan decision 6)', async () => {
    const { a } = await aliceAndBob();
    const c = machine('Carol');
    await c.service.afterPull([]);
    const aliceKeys = await keysOf(a);
    const carolKey = (await c.service.status()).me.keyId!;
    const withCarol = buildVaultEntry({
      secret: { ref: REF },
      label: 'Password',
      value: 'hunter2',
      recipients: await approvedAndPending(a),
      signer: aliceKeys,
      at: '2026-09-26T09:00:00.000Z',
    });
    await writeTree(vaultEntryPath(vaultEntryId({ ref: REF })), teamSecretsFileText(withCarol));
    expect(Object.keys((await vaultEntry()).wraps)).toContain(carolKey);

    await a.service.afterPull([]);

    expect(Object.keys((await vaultEntry()).wraps)).not.toContain(carolKey);
    expect(a.commits.at(-1)).toBe('Update team secrets');
  });

  it('backfills a value the vault lacks once this machine is approved', async () => {
    const { a, b } = await aliceAndBob();
    const other = { ref: 'sec_abcdefabcdefabcdefabcdefab' };
    await b.store.put(other.ref, 'tok-9', { label: 'Token' });
    b.uses = [{ secret: { ref: REF } }, { secret: other }];

    await b.service.afterPull([]);

    expect((await vaultEntry(other.ref)).label).toBe('Token');
    expect(b.commits.at(-1)).toBe('Update team secrets');
    await a.service.afterPull([]);
    expect(await a.store.get(other.ref)).toBe('tok-9');
  });
});

describe('TeamSecretsService — a damaged or replaced log (plan decision 4, §6)', () => {
  it('keeps the genesis it first saw when another appears before it', async () => {
    const { a, b } = await aliceAndBob();
    const mallory = generateMachineKeys();
    const request = signDocument(
      {
        version: 1 as const,
        keyId: mallory.keyId,
        encryptionKey: mallory.encryptionKey,
        signingKey: mallory.signingKey,
        name: 'Mallory',
        email: 'mallory@example.test',
        machine: 'm',
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
      mallory,
    );
    const genesis = signDocument(
      {
        version: 1 as const,
        id: nextAccessEntryId([], Date.parse('2026-01-01T00:00:00.000Z')),
        action: 'genesis' as const,
        authority: 'signed' as const,
        key: mallory.keyId,
        by: mallory.keyId,
        at: '2026-01-01T00:00:00.000Z',
      },
      mallory,
    );
    await writeTree(keyRequestPath(mallory.keyId), teamSecretsFileText(request));
    await writeTree(accessEntryPath(genesis.id), teamSecretsFileText(genesis));

    await b.service.afterPull([]);

    const status = await b.service.status();
    expect(status.approved.map((key) => key.name).sort()).toEqual(['Alice', 'Bob']);
    expect((await a.service.status()).canManage).toBe(true);
  });

  it('stops writing when an access entry it saw is gone', async () => {
    const { a, b } = await aliceAndBob();
    await b.service.afterPull([]); // B has now seen the approval
    const access = await readdir(join(tree, 'team-secrets', 'access'));
    await rm(join(tree, 'team-secrets', 'access', access.sort().at(-1)!));

    await b.service.afterPull([]);
    await b.service.recordValue({ ref: 'sec_abcdefabcdefabcdefabcdefab' }, 'Token', 'tok');

    expect(await b.service.status()).toMatchObject({
      message:
        'An access change is missing from this workspace. Restore it from the history before changing team secrets.',
      canManage: false,
    });
    await expect(vaultEntry('sec_abcdefabcdefabcdefabcdefab')).rejects.toThrow();
    await expect(a.service.approve('AAAAAAAAAAAAAAAAAAAAAAAAAA')).rejects.toMatchObject({ code: 'team-secrets-admin-only' });
  });
});

describe('TeamSecretsService — two machines set one value (§3.4)', () => {
  it('keeps the newer value, and gives the loser its own back on request', async () => {
    const { a, b } = await aliceAndBob();
    const path = vaultEntryPath(vaultEntryId({ ref: REF }));
    await a.service.recordValue({ ref: REF }, 'Password', 'alice-new');
    const mine = await readFile(join(tree, ...path.split('/')), 'utf8');
    await b.service.recordValue({ ref: REF }, 'Password', 'bob-new');
    const theirs = await readFile(join(tree, ...path.split('/')), 'utf8');

    const decided = await a.service.resolveConflicts(
      [{ path }, { path: 'projects/p/project.yaml' }],
      () => Promise.resolve({ mine, theirs }),
    );

    expect([...decided]).toEqual([[path, 'theirs']]);
    await a.service.afterPull([path]);
    expect(await a.store.get(REF)).toBe('bob-new');
    const entryId = vaultEntryId({ ref: REF });
    expect((await a.service.status()).replaced).toEqual([{ entryId, label: 'Password', byName: 'Bob' }]);
    expect(JSON.stringify(await a.service.status())).not.toContain('alice-new');

    await a.service.restoreMine(entryId);

    expect(a.commits.at(-1)).toBe('Update secret Password');
    expect(await a.store.get(REF)).toBe('alice-new');
    expect((await a.service.status()).replaced).toEqual([]);
    expect(await a.store.findByLabel(`wirebench-team-replaced:${entryId}`)).toBeUndefined();
    await b.service.afterPull([path]);
    expect(await b.store.get(REF)).toBe('alice-new');
  });

  it('lets a deleted side lose, and dismisses a notice without writing', async () => {
    const { a, b } = await aliceAndBob();
    const path = vaultEntryPath(vaultEntryId({ ref: REF }));
    const text = await readFile(join(tree, ...path.split('/')), 'utf8');
    expect([...(await a.service.resolveConflicts([{ path }], () => Promise.resolve({ mine: null, theirs: text })))]).toEqual([
      [path, 'theirs'],
    ]);

    await a.service.recordValue({ ref: REF }, 'Password', 'alice-new');
    const mine = await readFile(join(tree, ...path.split('/')), 'utf8');
    await b.service.recordValue({ ref: REF }, 'Password', 'bob-new');
    const theirs = await readFile(join(tree, ...path.split('/')), 'utf8');
    await a.service.resolveConflicts([{ path }], () => Promise.resolve({ mine, theirs }));
    const commits = a.commits.length;

    const status = await a.service.dismissReplaced(vaultEntryId({ ref: REF }));

    expect(status.replaced).toEqual([]);
    expect(a.commits).toHaveLength(commits);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts`
Expected: FAIL — `resolveConflicts` is not a function, and the pull tests find no imported value.

- [ ] **Step 3: The full pull hook**

In `apps/desktop/src/main/team-secrets-service.ts`, add `isVaultEntryPath`, `parseTeamSecretsFile`,
`vaultConflictWinner`, `vaultEntryFileSchema`, `vaultEntryIdOfPath`, `wrapsUnapprovedKey` to the engine import,
`import type { ConflictSides } from './sync/backend.js';` and `SyncConflictWire` to the wire-types import, and
replace `refreshNow`:

```ts
  /** After a pull: ask, import, then heal, re-encrypt and backfill in one commit (§3.2, §3.4, plan decision 6). */
  protected async refreshNow(ws: TeamSecretsWorkspace): Promise<void> {
    const view = await this.load(ws);
    if (!view.access.on || view.damaged) {
      return;
    }
    await this.ensureRequested(view);
    const me = view.me;
    if (me === undefined || this.myState(view) !== 'approved') {
      return;
    }
    const trusted = this.trustedValues(view);
    for (const [id, entry] of view.files.values) {
      if (!trusted.has(id)) {
        this.deps.log?.(`[team-secrets] ${TEAM_SECRETS_MESSAGES['team-secrets-untrusted']} (${entry.label})`);
      }
    }
    for (const entry of trusted.values()) {
      const value = openVaultEntry(entry, me);
      if (value !== undefined) {
        await this.importValue(entry.secret, entry.label, value);
      }
    }
    if (!this.canWriteVault(view)) {
      return;
    }
    const files = new Map<string, string | null>();
    const recipients = approvedRecipients(view.access);
    for (const [id, entry] of trusted) {
      if (wrapsUnapprovedKey(entry, view.access)) {
        const value = openVaultEntry(entry, me);
        if (value !== undefined) {
          files.set(vaultEntryPath(id), teamSecretsFileText(sealVaultEntry(entry, value, recipients, me)));
        }
        continue;
      }
      const healed = healVaultEntry(entry, view.access, me);
      if (healed !== undefined) {
        files.set(vaultEntryPath(id), teamSecretsFileText(healed));
      }
    }
    for (const [path, text] of await this.backfillFiles(view)) {
      files.set(path, text);
    }
    if (files.size > 0) {
      await this.write(ws, files);
      ws.afterWrite('Update team secrets');
    }
  }

  /** Stores a vault value on this machine (the raw store: nothing goes back to the vault). */
  private async importValue(secret: SecretKey, label: string, value: string): Promise<void> {
    if ('ref' in secret) {
      if ((await this.store.get(secret.ref)) !== value) {
        await this.store.put(secret.ref, value, { label });
      }
      return;
    }
    const storeLabel = secretStoreLabel(secret.token.projectId, secret.token.name);
    const ref = await this.store.findByLabel(storeLabel);
    if (ref === undefined) {
      await this.store.set(value, { label: storeLabel });
    } else if ((await this.store.get(ref)) !== value) {
      await this.store.put(ref, value);
    }
  }
```

- [ ] **Step 4: Vault conflicts and the replaced notice**

Add after `waitingFor(…)`:

```ts
  /**
   * §3.4, plan decisions 7–9: decides every conflicted vault entry — the newer value wins, a deleted or
   * unreadable side loses — and leaves every other path to the Conflicts list. Runs inside the sync
   * operation, so it never waits on the sync queue.
   */
  resolveConflicts(
    conflicts: readonly SyncConflictWire[],
    sides: (path: string) => Promise<ConflictSides>,
  ): Promise<Map<string, 'mine' | 'theirs'>> {
    return this.enqueue(async () => {
      const decided = new Map<string, 'mine' | 'theirs'>();
      const ws = this.attached;
      const paths = conflicts.map((conflict) => conflict.path).filter(isVaultEntryPath);
      if (ws === undefined || paths.length === 0) {
        return decided;
      }
      const view = await this.load(ws);
      let local = view.local;
      const parse = (text: string | null) =>
        text === null ? undefined : parseTeamSecretsFile(vaultEntryFileSchema, text);
      for (const path of paths) {
        const both = await sides(path).catch(() => undefined);
        if (both === undefined) {
          continue;
        }
        const mine = parse(both.mine);
        const theirs = parse(both.theirs);
        const side = vaultConflictWinner(mine, theirs);
        decided.set(path, side);
        if (side !== 'theirs' || mine === undefined || theirs === undefined || view.me === undefined) {
          continue;
        }
        const lost = openVaultEntry(mine, view.me);
        if (lost === undefined || lost === openVaultEntry(theirs, view.me)) {
          continue;
        }
        const entryId = vaultEntryIdOfPath(path)!;
        for (const old of local.replaced.filter((notice) => notice.entryId === entryId)) {
          await this.store.delete(old.storedRef);
        }
        const storedRef = await this.store.set(lost, { label: `${TEAM_REPLACED_LABEL_PREFIX}${entryId}` });
        local = {
          ...local,
          replaced: [
            ...local.replaced.filter((notice) => notice.entryId !== entryId),
            {
              entryId,
              label: mine.label,
              byName: view.access.keys.get(theirs.updatedBy)?.name ?? 'Someone',
              secret: mine.secret,
              storedRef,
            },
          ],
        };
      }
      if (local !== view.local) {
        await this.saveLocal(ws, local);
      }
      return decided;
    });
  }

  /** Puts this machine's replaced value back, here and (when it may write) in the vault as the newest. */
  restoreMine(entryId: string): Promise<TeamSecretsStatusWire> {
    return this.settleReplaced(entryId, true);
  }

  /** Keeps the value that won and forgets this machine's replaced one. */
  dismissReplaced(entryId: string): Promise<TeamSecretsStatusWire> {
    return this.settleReplaced(entryId, false);
  }

  private settleReplaced(entryId: string, restore: boolean): Promise<TeamSecretsStatusWire> {
    return this.enqueue(async () => {
      const ws = this.requireWorkspace();
      const view = await this.load(ws);
      const notice = view.local.replaced.find((item) => item.entryId === entryId);
      if (notice === undefined) {
        return await this.statusOf(view);
      }
      const value = restore ? await this.store.get(notice.storedRef) : undefined;
      if (value !== undefined) {
        await this.importValue(notice.secret, notice.label, value);
        if (this.canWriteVault(view) && view.me !== undefined) {
          const entry = buildVaultEntry({
            secret: notice.secret,
            label: notice.label,
            value,
            recipients: approvedRecipients(view.access),
            signer: view.me,
            at: this.clock().toISOString(),
          });
          await this.write(ws, new Map([[vaultEntryPath(entryId), teamSecretsFileText(entry)]]));
          ws.afterWrite(`Update secret ${notice.label}`);
        }
      }
      await this.store.delete(notice.storedRef);
      await this.saveLocal(ws, {
        ...view.local,
        replaced: view.local.replaced.filter((item) => item.entryId !== entryId),
      });
      return await this.emit(ws);
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/team-secrets-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/team-secrets-service.ts apps/desktop/test/team-secrets-service.test.ts
git commit -m "feat(desktop): team secrets after a pull — import, heal, re-encrypt, conflicts (#38)

An approved machine stores every value it can open after each pull, and seals any value still missing
an approved key, or still readable by a key that is no longer approved, in one commit. A value signed
by a key the log does not approve is ignored and listed. Two machines setting one value keep the newer;
the machine whose value lost keeps it locally with a notice to restore it or let it go. A genesis
other than the one first seen, or a missing access entry, stops this machine writing."
```

---

## Task 9: desktop main — the open shared workspace drives team secrets

**Files:**
- Modify: `apps/desktop/src/main/workspace-service.ts` (deps `:185`, `openWorkspace` `:715`, `close` `:1010`,
  `startSync` `:1294`, `applyPulled` `:1404`, `shareToServer` `:1613`, `shareDeps` `:1695`)
- Modify: `apps/desktop/src/main/workspace-share.ts` (`ShareDeps.open` `:121`, `shareAsGit` `:393`,
  `shareToFolder` `:458`, `stopSharing` `:588`)
- Test: `apps/desktop/test/workspace-team-secrets.test.ts` (new)

**Interfaces:**
- Consumes: `TeamSecretsService` (Tasks 6–8), `TeamSecretStore` (Task 7), `SyncService.identity`,
  `requestTeamSecretsKey`, `workspaceMembers`, `afterTeamSecretsWrite` and the `resolveConflicts` dep (Task 5),
  `secretRefsInValue` (Task 2), `secretNamesInValue` (engine), `isTeamSecretsPath`, `TEAM_SECRETS_DIR`.
- Produces:
  - `WorkspaceServiceDeps.teamSecrets?: Pick<TeamSecretsService, 'attach' | 'detach' | 'turnOn' | 'turnOnIfAdmin' | 'afterPull' | 'resolveConflicts'>`.
  - `ShareDeps.open(id, options?: { initialCommitMessage?: string; teamSecrets?: boolean })`; `shareAsGit` and
    `shareToFolder` pass `teamSecrets: true` (§3.1: sharing turns team secrets on); a server share turns on after
    its first push when the sharer is an admin (plan decision 10).
  - The workspace watcher reports `team-secrets/**` and hands those paths to `afterPull` (plan decision 15);
    stop sharing leaves `team-secrets/` in the tree (plan decision 16).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/workspace-team-secrets.test.ts`:

```ts
// @vitest-environment node
/**
 * Team secrets through a real shared git workspace: two app-data roots ("machines") on one bare
 * remote, each with its own keychain-backed store (fake crypto) and team-secrets service.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  DEFAULT_GIT_SHARE_SETTINGS,
  saveShare,
  saveWorkspace,
  vaultEntryId,
  vaultEntryPath,
  workspaceDir,
} from '@wirebench/engine';
import type { GitCli, Workspace } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { SecretStore } from '../src/main/secrets.js';
import { GitBackend } from '../src/main/sync/git-backend.js';
import type { SyncConflictWire } from '../src/main/sync/types.js';
import { TeamSecretStore } from '../src/main/team-secret-store.js';
import { TeamSecretsService } from '../src/main/team-secrets-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
  setTestIdentity,
} from './sync/git-fixture.js';

const WAIT = { timeout: 20_000, interval: 50 };

interface Machine {
  readonly service: WorkspaceService;
  readonly team: TeamSecretsService;
  readonly store: SecretStore;
  /** What the renderer's `secrets.*` channels write through. */
  readonly secrets: TeamSecretStore;
  readonly conflicts: SyncConflictWire[][];
}

let base: string;
let git: GitCli;
let remoteUrl: string;
let workspace: Workspace;
const machines: Machine[] = [];

function share(): Parameters<typeof saveShare>[1] {
  return { version: 1, kind: 'git', git: { ...DEFAULT_GIT_SHARE_SETTINGS, remote: remoteUrl, autoFetchSeconds: 0 } };
}

async function seedShared(): Promise<string> {
  const root = join(base, 'a');
  workspace = createWorkspace('Team');
  const dir = workspaceDir(root, workspace.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await GitBackend.init(git, tree, 'main');
  await setTestIdentity(git, tree);
  await saveWorkspace(workspace, tree);
  await saveShare(dir, share());
  await git.run(tree, ['remote', 'add', 'origin', remoteUrl]);
  await git.run(tree, ['add', '-A', '--', '.']);
  await git.run(tree, ['commit', '-m', 'Share workspace']);
  await git.run(tree, ['push', 'origin', 'HEAD:refs/heads/main']);
  return root;
}

async function cloneTo(name: string): Promise<string> {
  const root = join(base, name);
  const dir = workspaceDir(root, workspace.id);
  await mkdir(dir, { recursive: true });
  await GitBackend.clone(git, remoteUrl, 'main', join(dir, 'tree'));
  await setTestIdentity(git, join(dir, 'tree'), 'Bob', 'bob@example.com');
  await saveShare(dir, share());
  return root;
}

async function openMachine(root: string): Promise<Machine> {
  const store = new SecretStore(join(root, 'secrets'), {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  });
  const team = new TeamSecretsService({ store, machine: () => root });
  const conflicts: SyncConflictWire[][] = [];
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    watchDebounceMs: 30,
    git: () => Promise.resolve(git),
    teamSecrets: team,
    hooks: { onSyncConflict: (_id, list) => conflicts.push([...list]) },
  });
  const machine: Machine = { service, team, store, secrets: new TeamSecretStore(store, team), conflicts };
  machines.push(machine);
  await service.open(workspace.id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);
  await service.sync()?.idle();
  return machine;
}

async function latestSubject(m: Machine): Promise<string | undefined> {
  return (await m.service.sync()?.log(1))?.[0]?.subject;
}

/** Waits for `subject` to be the newest commit, then pushes it. */
async function committed(m: Machine, subject: string): Promise<void> {
  await vi.waitFor(async () => expect(await latestSubject(m)).toBe(subject), WAIT);
  await m.service.sync()?.push();
}

beforeEach(async () => {
  base = await mkTempDir('wirebench-team-secrets-');
  const hooksDir = join(base, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  git = makeTestGitCli(hooksDir, await hermeticGitEnv(base));
  ({ url: remoteUrl } = await createBareRemote(git, join(base, 'remote.git')));
});

afterEach(async () => {
  for (const machine of machines.splice(0)) {
    await machine.service.close();
  }
  await removeTempDir(base);
});

it('leaves a local workspace alone (§13.6)', async () => {
  const root = join(base, 'local');
  const team = {
    attach: vi.fn(),
    detach: vi.fn(() => Promise.resolve()),
    turnOn: vi.fn(),
    turnOnIfAdmin: vi.fn(),
    afterPull: vi.fn(),
    resolveConflicts: vi.fn(),
  };
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    teamSecrets: team,
  });
  await service.create('Solo');
  await service.close();
  expect(team.attach).not.toHaveBeenCalled();
  expect(team.turnOn).not.toHaveBeenCalled();
  expect(team.afterPull).not.toHaveBeenCalled();
});

describeGit('WorkspaceService — team secrets over git', { timeout: 90_000 }, () => {
  it('turns on, asks, approves and delivers a value to the second machine', async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');
    const ref = await a.secrets.set('hunter2', { label: 'Password' });
    await committed(a, 'Update secret Password');

    const b = await openMachine(await cloneTo('b'));
    await committed(b, 'Request team secrets access for Bob');

    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect((await a.team.status()).pending).toHaveLength(1), WAIT);
    await a.team.approve((await a.team.status()).pending[0]!.keyId);
    await committed(a, 'Approve team secrets access for Bob');

    await b.service.sync()?.pull();
    await vi.waitFor(async () => expect(await b.store.get(ref)).toBe('hunter2'), WAIT);
    expect((await b.team.status()).me.state).toBe('approved');
  });

  it('settles two machines setting one value without a conflict dialog: the newer value wins', async () => {
    const a = await openMachine(await seedShared());
    await a.team.turnOn();
    await committed(a, 'Turn on team secrets');
    const ref = await a.secrets.set('hunter2', { label: 'Password' });
    await committed(a, 'Update secret Password');
    const b = await openMachine(await cloneTo('b'));
    await committed(b, 'Request team secrets access for Bob');
    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect((await a.team.status()).pending).toHaveLength(1), WAIT);
    await a.team.approve((await a.team.status()).pending[0]!.keyId);
    await committed(a, 'Approve team secrets access for Bob');
    await b.service.sync()?.pull();
    await vi.waitFor(async () => expect(await b.store.get(ref)).toBe('hunter2'), WAIT);

    await a.secrets.replace(ref, 'from-a');
    await committed(a, 'Update secret Password');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await b.secrets.replace(ref, 'from-b');
    await vi.waitFor(async () => expect(await latestSubject(b)).toBe('Update secret Password'), WAIT);

    await b.service.sync()?.pull();

    expect(b.conflicts.flat().map((conflict) => conflict.path)).not.toContain(
      vaultEntryPath(vaultEntryId({ ref })),
    );
    expect(b.service.sync()?.status().state).not.toBe('conflict');
    expect(await b.store.get(ref)).toBe('from-b');
    await b.service.sync()?.push();
    await a.service.sync()?.pull();
    await vi.waitFor(async () => expect(await a.store.get(ref)).toBe('from-b'), WAIT);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/workspace-team-secrets.test.ts`
Expected: FAIL — `teamSecrets` is not a `WorkspaceServiceDeps` field, so `turnOn` finds no workspace
(`team-secrets-not-shared`).

- [ ] **Step 3: Wire the service into `WorkspaceService`**

In `apps/desktop/src/main/workspace-service.ts`:

Imports: add `isTeamSecretsPath`, `secretNamesInValue`, `secretRefsInValue` to the `@wirebench/engine` import and
`import type { SecretUse, TeamSecretsService } from './team-secrets-service.js';`.

In `WorkspaceServiceDeps`, after `secretScans`:

```ts
  /**
   * Team secrets for the open shared workspace (team-secrets spec): attached on open, told about
   * every pull, and asked to decide vault conflicts. Omitted in tests that never share secrets.
   */
  readonly teamSecrets?: Pick<
    TeamSecretsService,
    'attach' | 'detach' | 'turnOn' | 'turnOnIfAdmin' | 'afterPull' | 'resolveConflicts'
  >;
```

Change `openWorkspace`'s options type to `{ readonly initialCommitMessage?: string; readonly teamSecrets?: boolean }`.
Replace the watcher construction with:

```ts
      open.watcher = new ProjectWatcher({
        dir: tree,
        isManaged: (path) => isWorkspaceManagedPath(path) || isTeamSecretsPath(path),
        isWatchedDir: (dir) => isWorkspaceManagedDir(dir) || dir === 'team-secrets' || dir.startsWith('team-secrets/'),
        ...(this.deps.watchDebounceMs !== undefined ? { debounceMs: this.deps.watchDebounceMs } : {}),
        onChange: (changed) => {
          // A folder share has no pull: another machine's team-secrets write arrives as an outside edit.
          const teamPaths = changed.filter(isTeamSecretsPath);
          if (teamPaths.length > 0) {
            void this.deps.teamSecrets?.afterPull(teamPaths);
          }
          const paths = changed.filter((path) => !isTeamSecretsPath(path));
          if (paths.length === 0 || open.held.offerWorkspace(paths)) {
            return;
          }
          void this.enqueueWorkspaceOp(() => this.reloadWorkspaceFromDisk(open, paths));
        },
      });
```

and replace the `open.syncReady = …` line with:

```ts
      this.attachTeamSecrets(open);
      open.syncReady = this.turnOnTeamSecrets(open, options.teamSecrets === true)
        .then(() => this.startSync(open, options.initialCommitMessage))
        .catch(() => undefined);
```

Add these private methods after `secretHoldDeps`:

```ts
  /** Hands the open shared workspace to team secrets; a local workspace has none. */
  private attachTeamSecrets(open: OpenWorkspace): void {
    const team = this.deps.teamSecrets;
    const share = open.share;
    if (team === undefined || share === undefined) {
      return;
    }
    team.attach({
      workspaceId: open.workspace.id,
      dir: open.dir,
      tree: open.tree,
      kind: share.kind,
      role: () => open.sync?.status().role,
      uses: () => this.secretUses(open),
      identity: () => open.sync?.identity() ?? Promise.resolve(undefined),
      beforeWrite: (paths) => {
        open.watcher?.expect(paths);
      },
      afterWrite: (message) => {
        if (!this.stale(open)) {
          open.sync?.afterTeamSecretsWrite(message);
        }
      },
      ...(share.kind === 'server'
        ? {
            requestKey: (keyId: string, content: string) =>
              open.sync?.requestTeamSecretsKey(keyId, content) ?? Promise.resolve(),
            memberEmails: () => open.sync?.workspaceMembers() ?? Promise.resolve(undefined),
          }
        : {}),
    });
  }

  /** §3.1: a git or folder share turns team secrets on as it is made, inside its first commit. */
  private async turnOnTeamSecrets(open: OpenWorkspace, requested: boolean): Promise<void> {
    if (!requested || open.share === undefined || open.share.kind === 'server') {
      return;
    }
    // No keychain: the share still happens, and the Sync panel says why team secrets are off.
    await this.deps.teamSecrets?.turnOn({ commit: false }).catch(() => undefined);
  }

  /** Every secret the workspace's open projects and its environments name: refs and tokens. */
  private secretUses(open: OpenWorkspace): SecretUse[] {
    const uses: SecretUse[] = secretRefsInValue(open.workspace).map((ref) => ({ secret: { ref } }));
    for (const entry of open.entries) {
      const model = entry.host?.model();
      if (model === undefined) {
        continue;
      }
      for (const ref of secretRefsInValue(model)) {
        uses.push({ secret: { ref } });
      }
      for (const name of secretNamesInValue(model)) {
        uses.push({ secret: { token: { projectId: entry.projectId, name } } });
      }
    }
    return uses;
  }
```

In `startSync`, add to the `SyncService` deps (after `onIdentityNeeded`):

```ts
      ...(this.deps.teamSecrets !== undefined
        ? {
            resolveConflicts: (conflicts: readonly SyncConflictWire[], sides: (path: string) => Promise<ConflictSides>) =>
              this.deps.teamSecrets!.resolveConflicts(conflicts, sides),
          }
        : {}),
```

(import `ConflictSides` from `./sync/backend.js` and `SyncConflictWire` from the wire types if the file does not
already), and after `await sync.start();`:

```ts
    // The first look: ask for access, or pick up what changed while this workspace was closed.
    void this.deps.teamSecrets?.afterPull([]);
```

In `applyPulled`, after `open.watcher?.expect(plan.workspacePaths);` add:

```ts
      const teamPaths = changedPaths.filter(isTeamSecretsPath);
      open.watcher?.expect(teamPaths);
```

and after the `onSyncPulled` hook call, still inside the queued operation:

```ts
      // Not awaited: team secrets never wait on this pull's sync operation (plan decision 14).
      void this.deps.teamSecrets?.afterPull(teamPaths);
```

In `close()`, after the `waitAtMost(open.sync.idle(), …)` block:

```ts
    await this.deps.teamSecrets?.detach().catch(() => undefined);
```

In `shareToServer`, replace `await reopened.sync?.push().catch(() => undefined);` with:

```ts
    await reopened.sync?.push().catch(() => undefined);
    // Plan decision 10: the push told us the role; an admin's server workspace turns team secrets on.
    await this.deps.teamSecrets?.turnOnIfAdmin().catch(() => undefined);
```

In `shareDeps()`, `open: (id, options) => this.openWorkspace(id, options ?? {}),` is unchanged (the options type
widens with `ShareDeps.open`).

- [ ] **Step 4: Share turns it on; stop sharing leaves it**

In `apps/desktop/src/main/workspace-share.ts`:

```ts
  /** Opens a workspace; `initialCommitMessage` is committed before sync's own first commit, and `teamSecrets` turns team secrets on in it. */
  readonly open: (
    id: string,
    options?: { readonly initialCommitMessage?: string; readonly teamSecrets?: boolean },
  ) => Promise<WorkspaceWire>;
```

`:393` becomes `return await deps.open(id, { initialCommitMessage: \`Share workspace ${name}\`, teamSecrets: true });`
and `:458` (`shareToFolder`'s success path) becomes `return await deps.open(id, { teamSecrets: true });`. Add
`TEAM_SECRETS_DIR` to the engine import and change `:588` to:

```ts
  // Plan decision 16: the vault stays with the shared tree; a local workspace has no team.
  const present = TREE_ITEMS.filter((name) => name !== TEAM_SECRETS_DIR && existsSync(join(tree, name)));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/workspace-team-secrets.test.ts apps/desktop/test/workspace-sync.test.ts apps/desktop/test/workspace-share.test.ts apps/desktop/test/workspace-share-server.test.ts`
Expected: PASS — the new file, and the existing sync and share tests unchanged (none of them passes `teamSecrets`).

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/workspace-service.ts apps/desktop/src/main/workspace-share.ts \
  apps/desktop/test/workspace-team-secrets.test.ts
git commit -m "feat(desktop): shared workspaces drive team secrets (#38)

Opening a shared workspace attaches it to team secrets; every pull, and a folder share's outside edit
under team-secrets/, runs the pull hook, and sync asks team secrets to settle vault conflicts before
any reach the Conflicts list. Sharing to git or a folder turns team secrets on inside the first
commit; a server share turns on after its first push when the sharer is an admin. Stop sharing leaves
the vault with the shared tree."
```

---

## Task 10: IPC — `teamSecrets.*` channels, the `teamSecrets.changed` event, and main's wiring

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (after Task 6's status schemas)
- Modify: `apps/desktop/src/shared/ipc.ts` (channels after `secretScan` `:835`; events after `sync` `:1023`)
- Create: `apps/desktop/src/main/ipc/team-secrets.ts`
- Modify: `apps/desktop/src/main/ipc/secrets.ts` (the store parameter type)
- Modify: `apps/desktop/src/main/index.ts` (`:106-115` store and getter, `:280-300` workspace deps, `:375` secret
  scans, `:571` channel registration)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts` (defaults for the new channels)
- Test: `apps/desktop/test/ipc-team-secrets.test.ts` (new)

**Interfaces:**
- Consumes: `TeamSecretsService` (Tasks 6–8), `TeamSecretStore`, `teamSecretGetter` (Task 7), `TEAM_SECRETS_OFF`.
- Produces:
  - Wire: `teamSecretsKeyActionRequestSchema = { keyId }`, `teamSecretsEntryActionRequestSchema = { entryId }`,
    `teamSecretsChangedEventSchema = { workspaceId, status: teamSecretsStatusWireSchema }` and their types.
  - Channels (every one answers `TeamSecretsStatusWire`): `teamSecrets.status`, `teamSecrets.turnOn`,
    `teamSecrets.requestAccess` (no request); `teamSecrets.approve`, `teamSecrets.decline`, `teamSecrets.remove`,
    `teamSecrets.grantAdmin`, `teamSecrets.revokeAdmin` (`{ keyId }`); `teamSecrets.restoreMine`,
    `teamSecrets.dismissReplaced` (`{ entryId }`).
  - Event: `teamSecrets.changed` (plan decision 24).
  - `registerTeamSecretsChannels(service: TeamSecretsChannelService): void`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/ipc-team-secrets.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, events } from '../src/shared/ipc.js';
import { registerTeamSecretsChannels } from '../src/main/ipc/team-secrets.js';
import { TEAM_SECRETS_OFF } from '../src/main/team-secrets-service.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function service() {
  const answer = () => Promise.resolve(TEAM_SECRETS_OFF);
  return {
    status: vi.fn(answer),
    turnOn: vi.fn(answer),
    requestAccess: vi.fn(answer),
    approve: vi.fn(answer),
    decline: vi.fn(answer),
    remove: vi.fn(answer),
    grantAdmin: vi.fn(answer),
    revokeAdmin: vi.fn(answer),
    restoreMine: vi.fn(answer),
    dismissReplaced: vi.fn(answer),
  };
}

beforeEach(() => {
  handlers.clear();
});

describe('teamSecrets channels', () => {
  it('registers one handler per channel and routes each to the service', async () => {
    const team = service();
    registerTeamSecretsChannels(team);

    expect([...handlers.keys()].filter((name) => name.startsWith('teamSecrets.')).sort()).toEqual(
      Object.values(channels.teamSecrets)
        .map((channel) => channel.name)
        .sort(),
    );
    expect(await invoke('teamSecrets.status')).toEqual({ ok: true, value: TEAM_SECRETS_OFF });
    await invoke('teamSecrets.turnOn');
    await invoke('teamSecrets.approve', { keyId: KEY });
    await invoke('teamSecrets.remove', { keyId: KEY });
    await invoke('teamSecrets.restoreMine', { entryId: KEY });
    expect(team.turnOn).toHaveBeenCalledWith({ commit: true });
    expect(team.approve).toHaveBeenCalledWith(KEY);
    expect(team.remove).toHaveBeenCalledWith(KEY);
    expect(team.restoreMine).toHaveBeenCalledWith(KEY);
  });

  it('refuses a malformed key id before it reaches the service', async () => {
    const team = service();
    registerTeamSecretsChannels(team);
    const result = (await invoke('teamSecrets.approve', { keyId: '../../etc' })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(team.approve).not.toHaveBeenCalled();
  });

  it('carries no value on any answer schema', () => {
    expect(events.teamSecrets.changed.name).toBe('teamSecrets.changed');
    for (const channel of Object.values(channels.teamSecrets)) {
      expect(JSON.stringify(channel.response.safeParse({ ...TEAM_SECRETS_OFF, value: 'x' }).data)).not.toContain(
        '"value"',
      );
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-team-secrets.test.ts`
Expected: FAIL — `ipc/team-secrets.ts` does not exist.

- [ ] **Step 3: Wire schemas, channels and the event**

In `apps/desktop/src/shared/wire-types.ts`, after `export type TeamSecretsStatusWire = …;`:

```ts
export const teamSecretsKeyActionRequestSchema = z.object({ keyId: teamSecretsIdSchema });
export type TeamSecretsKeyActionRequest = z.infer<typeof teamSecretsKeyActionRequestSchema>;
export const teamSecretsEntryActionRequestSchema = z.object({ entryId: teamSecretsIdSchema });
export type TeamSecretsEntryActionRequest = z.infer<typeof teamSecretsEntryActionRequestSchema>;

/** Payload for `teamSecrets.changed`: the open shared workspace's team-secrets status, as `teamSecrets.status` answers. */
export const teamSecretsChangedEventSchema = z.object({ workspaceId: z.string(), status: teamSecretsStatusWireSchema });
export type TeamSecretsChangedEvent = z.infer<typeof teamSecretsChangedEventSchema>;
```

In `apps/desktop/src/shared/ipc.ts`, import the four schemas and add after the `secretScan` block:

```ts
  // Team secrets in the open shared workspace (team-secrets spec §4). Nothing here carries a value
  // or a private key in either direction: ids, names, fingerprints and labels only.
  teamSecrets: {
    status: defineChannel('teamSecrets.status', z.undefined(), teamSecretsStatusWireSchema),
    turnOn: defineChannel('teamSecrets.turnOn', z.undefined(), teamSecretsStatusWireSchema),
    requestAccess: defineChannel('teamSecrets.requestAccess', z.undefined(), teamSecretsStatusWireSchema),
    approve: defineChannel('teamSecrets.approve', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    decline: defineChannel('teamSecrets.decline', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    remove: defineChannel('teamSecrets.remove', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    grantAdmin: defineChannel('teamSecrets.grantAdmin', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    revokeAdmin: defineChannel('teamSecrets.revokeAdmin', teamSecretsKeyActionRequestSchema, teamSecretsStatusWireSchema),
    restoreMine: defineChannel('teamSecrets.restoreMine', teamSecretsEntryActionRequestSchema, teamSecretsStatusWireSchema),
    dismissReplaced: defineChannel(
      'teamSecrets.dismissReplaced',
      teamSecretsEntryActionRequestSchema,
      teamSecretsStatusWireSchema,
    ),
  },
```

and in `events`, after `sync: { … },`:

```ts
  teamSecrets: {
    /** The open shared workspace's team-secrets status changed (a pull, an approval, a save). */
    changed: defineEvent('teamSecrets.changed', teamSecretsChangedEventSchema),
  },
```

- [ ] **Step 4: The handlers**

Create `apps/desktop/src/main/ipc/team-secrets.ts`:

```ts
/**
 * The `teamSecrets.*` IPC channels: the Sync panel's Team secrets section drives the open shared
 * workspace's {@link TeamSecretsService} through these. Every answer is the status wire — ids,
 * names, fingerprints and labels — and no request carries a value.
 */
import { channels } from '../../shared/ipc.js';
import type { TeamSecretsService } from '../team-secrets-service.js';
import { registerHandler } from './register.js';

export type TeamSecretsChannelService = Pick<
  TeamSecretsService,
  | 'status'
  | 'turnOn'
  | 'requestAccess'
  | 'approve'
  | 'decline'
  | 'remove'
  | 'grantAdmin'
  | 'revokeAdmin'
  | 'restoreMine'
  | 'dismissReplaced'
>;

export function registerTeamSecretsChannels(service: TeamSecretsChannelService): void {
  registerHandler(channels.teamSecrets.status, () => service.status());
  registerHandler(channels.teamSecrets.turnOn, () => service.turnOn({ commit: true }));
  registerHandler(channels.teamSecrets.requestAccess, () => service.requestAccess());
  registerHandler(channels.teamSecrets.approve, ({ keyId }) => service.approve(keyId));
  registerHandler(channels.teamSecrets.decline, ({ keyId }) => service.decline(keyId));
  registerHandler(channels.teamSecrets.remove, ({ keyId }) => service.remove(keyId));
  registerHandler(channels.teamSecrets.grantAdmin, ({ keyId }) => service.grantAdmin(keyId));
  registerHandler(channels.teamSecrets.revokeAdmin, ({ keyId }) => service.revokeAdmin(keyId));
  registerHandler(channels.teamSecrets.restoreMine, ({ entryId }) => service.restoreMine(entryId));
  registerHandler(channels.teamSecrets.dismissReplaced, ({ entryId }) => service.dismissReplaced(entryId));
}
```

In `apps/desktop/src/main/ipc/secrets.ts`, change the first parameter to
`secrets: Pick<SecretStore, 'set' | 'replace' | 'exists' | 'delete' | 'list'>,` (the team-aware store is passed
in production; `ipc-secrets.test.ts` keeps passing a plain `SecretStore`).

- [ ] **Step 5: Main's wiring**

In `apps/desktop/src/main/index.ts`, import `TeamSecretsService` from `./team-secrets-service.js`,
`TeamSecretStore` and `teamSecretGetter` from `./team-secret-store.js`, and `registerTeamSecretsChannels` from
`./ipc/team-secrets.js`. After the `secretStore` constant (`:106`):

```ts
/**
 * Team secrets for the open shared workspace. It writes this machine's keys and the team's values
 * into `secretStore` directly; everything the renderer saves goes through `teamSecretStore`, which
 * stores locally and then hands the value to the vault. Sign-in tokens, OAuth refresh tokens and a
 * cURL import stay on `secretStore`: they are this machine's, not the team's.
 */
const teamSecrets = new TeamSecretsService({
  store: secretStore,
  onChanged: (workspaceId, status) => broadcast(events.teamSecrets.changed, { workspaceId, status }),
  log: (message) => console.warn(message),
});
const teamSecretStore = new TeamSecretStore(secretStore, teamSecrets);
```

Replace `secretsFor` with:

```ts
const secretsFor = (projectId: string | undefined) =>
  teamSecretGetter(projectSecretGetter(secretStore, projectId, recordSecretValue), teamSecrets, projectId);
```

In the `WorkspaceService` deps, after `secrets: secretStore,` add `teamSecrets,`. In `SecretScanSessions`, change
`store: secretStore,` to `store: teamSecretStore,`. Replace `registerSecretsChannels(secretStore, showSecretsFlag);`
with:

```ts
  registerSecretsChannels(teamSecretStore, showSecretsFlag);
  registerTeamSecretsChannels(teamSecrets);
```

`broadcast` is a function declaration (`:213`), so the `onChanged` above may name it before its line.

- [ ] **Step 6: Renderer test defaults**

In `apps/desktop/test/mocks/wirebench-api.ts`, after the `secretScan` block of the default API:

```ts
    teamSecrets: {
      status: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          on: false,
          canTurnOn: false,
          canManage: false,
          me: { state: 'none', admin: false },
          pending: [],
          approved: [],
          formerMembers: [],
          rotate: [],
          untrusted: [],
          replaced: [],
          localOnly: [],
        },
      }),
      turnOn: fail('teamSecrets.turnOn'),
      requestAccess: fail('teamSecrets.requestAccess'),
      approve: fail('teamSecrets.approve'),
      decline: fail('teamSecrets.decline'),
      remove: fail('teamSecrets.remove'),
      grantAdmin: fail('teamSecrets.grantAdmin'),
      revokeAdmin: fail('teamSecrets.revokeAdmin'),
      restoreMine: fail('teamSecrets.restoreMine'),
      dismissReplaced: fail('teamSecrets.dismissReplaced'),
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-team-secrets.test.ts apps/desktop/test/ipc-secrets.test.ts apps/desktop/test/ipc-secret-scan.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/team-secrets.ts \
  apps/desktop/src/main/ipc/secrets.ts apps/desktop/src/main/index.ts apps/desktop/test/mocks/wirebench-api.ts \
  apps/desktop/test/ipc-team-secrets.test.ts
git commit -m "feat(desktop): team secrets channels and main wiring (#38)

The Sync panel drives team secrets through teamSecrets.* channels that answer with ids, names,
fingerprints and labels only, and hears about changes on teamSecrets.changed. Values the renderer
saves, including a \${secret:name} set from the token dialog, go through the team-aware store; a send
that finds no value this machine is waiting for says so."
```

---

## Task 11: renderer — the Team secrets section, the waiting count, and the secret field's marks

**Files:**
- Create: `apps/desktop/src/renderer/state/team-secrets.ts`
- Create: `apps/desktop/src/renderer/features/sync/team-secrets-section.tsx`
- Modify: `apps/desktop/src/renderer/features/sync/sync-panel.tsx` (render the section after Conflicts, `:361`)
- Modify: `apps/desktop/src/renderer/features/sync/sync-badge.tsx` (the waiting count)
- Modify: `apps/desktop/src/renderer/components/secret-field.tsx` (the two marks)
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx:260` (subscribe)
- Test: `apps/desktop/test/renderer/team-secrets-section.test.tsx` (new), `apps/desktop/test/renderer/sync-badge.test.tsx`,
  `apps/desktop/test/renderer/secret-field.test.tsx`, `apps/desktop/test/renderer/team-secrets-store.test.ts` (new)

**Interfaces:**
- Consumes: the `teamSecrets.*` channels and `teamSecrets.changed` event (Task 10); types only from
  `shared/wire-types.ts`.
- Produces:
  - `useTeamSecretsStore` — `{ status: TeamSecretsStatusWire; busy: boolean; refresh(); run(action, id?);
    applyChanged(workspaceId, status); reset() }` where `action` is one of the channel names other than `status`.
  - `subscribeToTeamSecrets(): () => void`.
  - `TeamSecretsSection` (testids below), the badge suffix `· N waiting` (plan decision 19), and on `SecretField`
    `secret-local-only` ("Only on this machine") and `secret-rotate` ("Rotate").

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/renderer/team-secrets-store.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTeamSecretsStore, TEAM_SECRETS_OFF_STATUS } from '../../src/renderer/state/team-secrets.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { TeamSecretsStatusWire } from '../../src/shared/wire-types.js';

const ON: TeamSecretsStatusWire = { ...TEAM_SECRETS_OFF_STATUS, on: true, authority: 'signed', canManage: true };

describe('useTeamSecretsStore', () => {
  afterEach(() => {
    useTeamSecretsStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('applies a change for the open workspace only', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-1', share: { kind: 'git', managed: true } }) });
    useTeamSecretsStore.getState().applyChanged('ws-2', ON);
    expect(useTeamSecretsStore.getState().status.on).toBe(false);
    useTeamSecretsStore.getState().applyChanged('ws-1', ON);
    expect(useTeamSecretsStore.getState().status.on).toBe(true);
  });

  it('runs an action with its id and takes the answer', async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true, value: ON });
    installWirebenchApi({ teamSecrets: { approve } });
    await useTeamSecretsStore.getState().run('approve', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(approve).toHaveBeenCalledWith({ keyId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    expect(useTeamSecretsStore.getState().status).toEqual(ON);
  });
});
```

Create `apps/desktop/test/renderer/team-secrets-section.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeamSecretsSection } from '../../src/renderer/features/sync/team-secrets-section.js';
import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { TeamSecretsKeyWire, TeamSecretsStatusWire } from '../../src/shared/wire-types.js';

const ADA: TeamSecretsKeyWire = {
  keyId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
  name: 'Ada',
  email: 'ada@example.test',
  machine: 'ada-laptop',
  fingerprint: '1a2b 3c4d 5e6f 7a8b',
  requestedAt: '2026-09-26T10:00:00.000Z',
  admin: true,
  mine: true,
};
const BEN: TeamSecretsKeyWire = {
  ...ADA,
  keyId: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
  name: 'Ben',
  email: 'ben@example.test',
  machine: 'ben-desktop',
  fingerprint: '9f8e 7d6c 5b4a 3928',
  admin: false,
  mine: false,
};

function status(patch: Partial<TeamSecretsStatusWire>): TeamSecretsStatusWire {
  return {
    ...TEAM_SECRETS_OFF_STATUS,
    on: true,
    authority: 'signed',
    canManage: true,
    me: { state: 'approved', keyId: ADA.keyId, fingerprint: ADA.fingerprint, admin: true },
    approved: [ADA],
    ...patch,
  };
}

describe('TeamSecretsSection', () => {
  afterEach(() => {
    cleanup();
    useTeamSecretsStore.getState().reset();
  });

  it('offers to turn team secrets on when it may', async () => {
    const turnOn = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { turnOn } });
    useTeamSecretsStore.setState({ status: { ...TEAM_SECRETS_OFF_STATUS, canTurnOn: true } });
    render(<TeamSecretsSection />);
    await userEvent.click(screen.getByTestId('team-secrets-turn-on'));
    expect(turnOn).toHaveBeenCalled();
  });

  it('shows a request with its fingerprint, the out-of-band check, and approves it', async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true, value: status({ approved: [ADA, BEN] }) });
    installWirebenchApi({ teamSecrets: { approve } });
    useTeamSecretsStore.setState({ status: status({ pending: [BEN] }) });
    render(<TeamSecretsSection />);

    const row = screen.getByTestId('team-secrets-pending-row');
    expect(row.textContent).toContain('Ben');
    expect(row.textContent).toContain('ben-desktop');
    expect(row.textContent).toContain('9f8e 7d6c 5b4a 3928');
    expect(screen.getByTestId('team-secrets-fingerprint-note').textContent).toContain('another way');
    await userEvent.click(screen.getByTestId('team-secrets-approve'));
    expect(approve).toHaveBeenCalledWith({ keyId: BEN.keyId });
    await waitFor(() => expect(screen.queryByTestId('team-secrets-pending-row')).toBeNull());
  });

  it('warns a lone admin, and confirms a removal', async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { remove } });
    useTeamSecretsStore.setState({ status: status({ approved: [ADA, BEN] }) });
    render(<TeamSecretsSection />);

    expect(screen.getByTestId('team-secrets-single-admin')).toBeTruthy();
    await userEvent.click(screen.getAllByTestId('team-secrets-remove')[0]!);
    await userEvent.click(screen.getByTestId('team-secrets-remove-confirm'));
    expect(remove).toHaveBeenCalledWith({ keyId: BEN.keyId });
  });

  it('lists what to rotate, what it ignored, and a replaced value to restore', async () => {
    const restoreMine = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { restoreMine } });
    useTeamSecretsStore.setState({
      status: status({
        rotate: [
          { entryId: 'CCCCCCCCCCCCCCCCCCCCCCCCCC', label: 'Password', secret: { ref: 'sec_x' }, removedNames: ['Cy'] },
        ],
        untrusted: [{ entryId: 'DDDDDDDDDDDDDDDDDDDDDDDDDD', label: 'Token' }],
        replaced: [{ entryId: 'EEEEEEEEEEEEEEEEEEEEEEEEEE', label: 'Api key', byName: 'Ben' }],
      }),
    });
    render(<TeamSecretsSection />);

    expect(screen.getByTestId('team-secrets-rotate-row').textContent).toContain('Cy');
    expect(screen.getByTestId('team-secrets-untrusted-row').textContent).toContain('Token');
    expect(screen.getByTestId('team-secrets-replaced-row').textContent).toContain('Ben');
    await userEvent.click(screen.getByTestId('team-secrets-restore'));
    expect(restoreMine).toHaveBeenCalledWith({ entryId: 'EEEEEEEEEEEEEEEEEEEEEEEEEE' });
  });

  it('tells a waiting machine its fingerprint, and a removed one how to ask again', async () => {
    const requestAccess = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { requestAccess } });
    useTeamSecretsStore.setState({
      status: status({ canManage: false, me: { state: 'pending', keyId: BEN.keyId, fingerprint: BEN.fingerprint, admin: false } }),
    });
    const { rerender } = render(<TeamSecretsSection />);
    expect(screen.getByTestId('team-secrets-me').textContent).toContain('Waiting for an admin');
    expect(screen.getByTestId('team-secrets-me').textContent).toContain(BEN.fingerprint);

    useTeamSecretsStore.setState({
      status: status({
        canManage: false,
        me: { state: 'removed', keyId: BEN.keyId, admin: false },
        message: 'An admin removed this machine from team secrets.',
      }),
    });
    rerender(<TeamSecretsSection />);
    await userEvent.click(screen.getByTestId('team-secrets-request-access'));
    expect(requestAccess).toHaveBeenCalled();
  });
});
```

Append inside the `SyncBadge` describe of `apps/desktop/test/renderer/sync-badge.test.tsx`:

```tsx
  it('counts the machines waiting for an admin who can approve them', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({
      status: { kind: 'git', gitAvailable: true, state: 'clean', ahead: 0, behind: 0, uncommitted: 0 },
    });
    useTeamSecretsStore.setState({
      status: {
        ...TEAM_SECRETS_OFF_STATUS,
        on: true,
        canManage: true,
        pending: [
          {
            keyId: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
            name: 'Ben',
            email: '',
            machine: 'm',
            fingerprint: 'f',
            requestedAt: '2026-09-26T10:00:00.000Z',
            admin: false,
            mine: false,
          },
        ],
      },
    });
    render(<SyncBadge />);
    expect(screen.getByTestId('status-bar-sync').textContent).toContain('Up to date · 1 waiting');
    expect(screen.getByTestId('status-bar-sync').getAttribute('data-state')).toBe('clean');
  });
```

and add `import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';`
to its imports and `useTeamSecretsStore.getState().reset();` to its `afterEach` (`:71`).

Append to `apps/desktop/test/renderer/secret-field.test.tsx`:

```tsx
describe('SecretField — team secrets marks', () => {
  afterEach(() => {
    cleanup();
    useTeamSecretsStore.getState().reset();
  });

  it('marks a value that is only on this machine, and one to rotate', async () => {
    installWirebenchApi({ secrets: { exists: vi.fn().mockResolvedValue({ ok: true, value: { exists: true } }) } });
    useTeamSecretsStore.setState({
      status: {
        ...TEAM_SECRETS_OFF_STATUS,
        on: true,
        localOnly: [{ ref: 'sec_local' }],
        rotate: [
          { entryId: 'CCCCCCCCCCCCCCCCCCCCCCCCCC', label: 'Password', secret: { ref: 'sec_old' }, removedNames: ['Cy'] },
        ],
      },
    });
    const { rerender } = render(<SecretField value="sec_local" label="Password" onChange={() => undefined} />);
    expect(screen.getByTestId('secret-local-only').textContent).toBe('Only on this machine');
    expect(screen.queryByTestId('secret-rotate')).toBeNull();

    rerender(<SecretField value="sec_old" label="Password" onChange={() => undefined} />);
    expect(screen.getByTestId('secret-rotate').textContent).toBe('Rotate');
    expect(screen.getByTestId('secret-rotate').getAttribute('title')).toContain('Cy');
    await waitFor(() => expect(screen.queryByTestId('secret-local-only')).toBeNull());
  });
});
```

and add `import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';`
to its imports.

- [ ] **Step 2: Run them to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/team-secrets-store.test.ts apps/desktop/test/renderer/team-secrets-section.test.tsx apps/desktop/test/renderer/sync-badge.test.tsx apps/desktop/test/renderer/secret-field.test.tsx`
Expected: FAIL — `state/team-secrets.ts` and `team-secrets-section.tsx` do not exist.

- [ ] **Step 3: The store**

Create `apps/desktop/src/renderer/state/team-secrets.ts`:

```ts
/**
 * The renderer's mirror of the open shared workspace's team secrets (team-secrets spec §4): what
 * `teamSecrets.status` answers, kept current by `teamSecrets.changed`. Nothing here ever holds a
 * value — the status carries ids, names, fingerprints and labels only.
 */
import { create } from 'zustand';
import type { TeamSecretsStatusWire, TeamSecretsChangedEvent, WorkspaceChangedEvent } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { useWorkspaceStore } from './workspace.js';

export const TEAM_SECRETS_OFF_STATUS: TeamSecretsStatusWire = {
  on: false,
  canTurnOn: false,
  canManage: false,
  me: { state: 'none', admin: false },
  pending: [],
  approved: [],
  formerMembers: [],
  rotate: [],
  untrusted: [],
  replaced: [],
  localOnly: [],
};

type KeyAction = 'approve' | 'decline' | 'remove' | 'grantAdmin' | 'revokeAdmin';
type EntryAction = 'restoreMine' | 'dismissReplaced';
export type TeamSecretsAction = 'turnOn' | 'requestAccess' | KeyAction | EntryAction;

interface TeamSecretsState {
  readonly status: TeamSecretsStatusWire;
  readonly busy: boolean;
  refresh(): Promise<void>;
  run(action: TeamSecretsAction, id?: string): Promise<void>;
  applyChanged(workspaceId: string, status: TeamSecretsStatusWire): void;
  reset(): void;
}

const KEY_ACTIONS: ReadonlySet<TeamSecretsAction> = new Set(['approve', 'decline', 'remove', 'grantAdmin', 'revokeAdmin']);

export const useTeamSecretsStore = create<TeamSecretsState>((set) => ({
  status: TEAM_SECRETS_OFF_STATUS,
  busy: false,

  refresh: async () => {
    const result = await ipc().teamSecrets.status();
    if (result.ok) {
      set({ status: result.value });
    }
  },

  run: async (action, id) => {
    set({ busy: true });
    try {
      const api = ipc().teamSecrets;
      const result =
        action === 'turnOn' || action === 'requestAccess'
          ? await api[action]()
          : KEY_ACTIONS.has(action)
            ? await api[action as KeyAction]({ keyId: id ?? '' })
            : await api[action as EntryAction]({ entryId: id ?? '' });
      if (result.ok) {
        set({ status: result.value });
      } else {
        showToast(result.error.message);
      }
    } finally {
      set({ busy: false });
    }
  },

  applyChanged: (workspaceId, status) => {
    if (workspaceId === useWorkspaceStore.getState().workspace?.id) {
      set({ status });
    }
  },

  reset: () => {
    set({ status: TEAM_SECRETS_OFF_STATUS, busy: false });
  },
}));

/** Keeps the mirror current; called once from the shell next to `subscribeToSync`. */
export function subscribeToTeamSecrets(): () => void {
  const offChanged = window.wirebench.on('teamSecrets.changed', ((payload: TeamSecretsChangedEvent) => {
    useTeamSecretsStore.getState().applyChanged(payload.workspaceId, payload.status);
  }) as (payload: unknown) => void);

  let lastWorkspaceId: string | null = null;
  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    const nextId = payload.workspace?.id ?? null;
    if (nextId !== lastWorkspaceId) {
      useTeamSecretsStore.getState().reset();
      if (payload.workspace?.share !== undefined) {
        void useTeamSecretsStore.getState().refresh();
      }
    }
    lastWorkspaceId = nextId;
  }) as (payload: unknown) => void);

  void useTeamSecretsStore.getState().refresh();
  return () => {
    offChanged();
    offWorkspace();
  };
}
```

In `apps/desktop/src/renderer/shell/app-shell.tsx`, import `subscribeToTeamSecrets` and add after `:260`:
`useEffect(() => subscribeToTeamSecrets(), []);`.

- [ ] **Step 4: The section**

Create `apps/desktop/src/renderer/features/sync/team-secrets-section.tsx`:

```tsx
/**
 * The Sync panel's Team secrets section (team-secrets spec §4.2): turning on, who is waiting and who
 * is approved, the fingerprint an admin checks another way before approving, and the values to
 * rotate, ignored, or replaced here. Values never reach this component.
 */
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { SettingsGroup } from '../../components/settings-grid.js';
import { useTeamSecretsStore } from '../../state/team-secrets.js';
import type { TeamSecretsKeyWire } from '../../../shared/wire-types.js';

const ME_WORDS = {
  unavailable: 'Not available on this machine',
  none: 'Not asked yet',
  pending: 'Waiting for an admin to approve this machine',
  approved: 'Approved',
  removed: 'Removed',
} as const;

export function TeamSecretsSection() {
  const status = useTeamSecretsStore((state) => state.status);
  const busy = useTeamSecretsStore((state) => state.busy);
  const run = useTeamSecretsStore((state) => state.run);
  const [removing, setRemoving] = useState<TeamSecretsKeyWire | undefined>(undefined);

  if (!status.on) {
    if (!status.canTurnOn && status.message === undefined) {
      return null;
    }
    return (
      <SettingsGroup
        title="Team secrets"
        hint="Share secret values with the people in this workspace, encrypted for each approved machine."
      >
        {status.message !== undefined && (
          <p data-testid="team-secrets-message" className="mb-2 text-sm text-fg-subtle">
            {status.message}
          </p>
        )}
        {status.canTurnOn && (
          <Button data-testid="team-secrets-turn-on" disabled={busy} onClick={() => void run('turnOn')}>
            Turn on team secrets
          </Button>
        )}
      </SettingsGroup>
    );
  }

  const signed = status.authority === 'signed';
  const admins = status.approved.filter((key) => key.admin);
  const former = new Set(status.formerMembers);

  return (
    <SettingsGroup title="Team secrets">
      <p data-testid="team-secrets-me" className="mb-2 text-sm text-fg-default">
        This machine: {ME_WORDS[status.me.state]}
        {status.me.fingerprint !== undefined && (
          <>
            {' · fingerprint '}
            <span className="font-mono">{status.me.fingerprint}</span>
          </>
        )}
      </p>
      {status.message !== undefined && (
        <p data-testid="team-secrets-message" className="mb-2 text-sm text-fg-subtle">
          {status.message}
        </p>
      )}
      {status.me.state === 'removed' && (
        <Button data-testid="team-secrets-request-access" disabled={busy} onClick={() => void run('requestAccess')}>
          Ask for access again
        </Button>
      )}

      {status.canManage && signed && admins.length === 1 && admins[0]?.mine === true && (
        <p data-testid="team-secrets-single-admin" className="mb-2 text-sm text-status-warning">
          You are the only admin. Make someone else an admin too, so the team keeps access if this machine is lost.
        </p>
      )}

      {status.canManage && status.pending.length > 0 && (
        <>
          <p data-testid="team-secrets-fingerprint-note" className="mb-1 text-sm text-fg-subtle">
            Before approving, check the fingerprint with the person another way — a call or in person.
          </p>
          <ul className="mb-2 flex flex-col gap-1">
            {status.pending.map((key) => (
              <li key={key.keyId} data-testid="team-secrets-pending-row" className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate" title={key.email}>
                  {key.name} · {key.machine} · <span className="font-mono">{key.fingerprint}</span>
                </span>
                <span className="flex gap-1">
                  <Button data-testid="team-secrets-approve" disabled={busy} onClick={() => void run('approve', key.keyId)}>
                    Approve
                  </Button>
                  <Button data-testid="team-secrets-decline" disabled={busy} onClick={() => void run('decline', key.keyId)}>
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="mb-2 flex flex-col gap-1">
        {status.approved.map((key) => (
          <li key={key.keyId} data-testid="team-secrets-member-row" className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate" title={key.email}>
              {key.name} · {key.machine}
              {key.admin && ' · admin'}
              {key.mine && ' · this machine'}
              {former.has(key.keyId) && ' · no longer in the workspace'}
            </span>
            {status.canManage && !key.mine && (
              <span className="flex gap-1">
                {signed && (
                  <Button
                    data-testid={key.admin ? 'team-secrets-revoke-admin' : 'team-secrets-grant-admin'}
                    disabled={busy}
                    onClick={() => void run(key.admin ? 'revokeAdmin' : 'grantAdmin', key.keyId)}
                  >
                    {key.admin ? 'Remove admin' : 'Make admin'}
                  </Button>
                )}
                <Button data-testid="team-secrets-remove" disabled={busy} onClick={() => setRemoving(key)}>
                  Remove
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {status.rotate.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {status.rotate.map((mark) => (
            <li key={mark.entryId} data-testid="team-secrets-rotate-row" className="text-sm text-status-warning">
              Rotate {mark.label}: {mark.removedNames.join(', ')} could read it.
            </li>
          ))}
        </ul>
      )}

      {status.untrusted.map((entry) => (
        <p key={entry.entryId} data-testid="team-secrets-untrusted-row" className="text-sm text-fg-subtle">
          Ignored {entry.label}: it was signed by a key that is not approved.
        </p>
      ))}

      {status.replaced.map((notice) => (
        <div key={notice.entryId} data-testid="team-secrets-replaced-row" className="flex items-center justify-between gap-2 text-sm">
          <span>
            {notice.byName} changed {notice.label} at the same time; their value is in use.
          </span>
          <span className="flex gap-1">
            <Button data-testid="team-secrets-restore" disabled={busy} onClick={() => void run('restoreMine', notice.entryId)}>
              Use mine
            </Button>
            <Button
              data-testid="team-secrets-dismiss"
              disabled={busy}
              onClick={() => void run('dismissReplaced', notice.entryId)}
            >
              Keep theirs
            </Button>
          </span>
        </div>
      ))}

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.name ?? ''} from team secrets?`}
        description="Their machine stops receiving values. Values they could already read are marked Rotate: change them where they are issued."
        confirmLabel="Remove"
        destructive
        confirmTestId="team-secrets-remove-confirm"
        onConfirm={() => {
          const key = removing;
          setRemoving(undefined);
          if (key !== undefined) void run('remove', key.keyId);
        }}
      />
    </SettingsGroup>
  );
}
```

In `apps/desktop/src/renderer/features/sync/sync-panel.tsx`, import `TeamSecretsSection` and render
`<TeamSecretsSection />` right after the Conflicts block's closing `)}` (`:361`), before `Recent commits`.

- [ ] **Step 5: The badge and the secret field**

In `apps/desktop/src/renderer/features/sync/sync-badge.tsx`, import `useTeamSecretsStore`; in `SyncBadge` read
`const waiting = useTeamSecretsStore((store) => (store.status.canManage ? store.status.pending.length : 0));` next to
`status`, and change the text line to:

```tsx
  const synced = relative === undefined ? label : `${label} · ${relative}`;
  const text = waiting > 0 ? `${synced} · ${String(waiting)} waiting` : synced;
```

In `apps/desktop/src/renderer/components/secret-field.tsx`, import `useTeamSecretsStore`; in `SecretField`, after
the `presence` state:

```tsx
  // Team secrets (team-secrets spec §4.3): a value that stays on this machine, or one a removed member could read.
  const localOnly = useTeamSecretsStore(
    (state) => value !== undefined && state.status.localOnly.some((secret) => 'ref' in secret && secret.ref === value),
  );
  const rotate = useTeamSecretsStore((state) =>
    value === undefined ? undefined : state.status.rotate.find((mark) => 'ref' in mark.secret && mark.secret.ref === value),
  );
```

and in the at-rest render, after the masked `<span …>…</span>`:

```tsx
      {localOnly && !missing && (
        <span data-testid="secret-local-only" className="text-xs text-fg-subtle" title="Team secrets are not shared from this machine yet.">
          Only on this machine
        </span>
      )}
      {rotate !== undefined && (
        <span
          data-testid="secret-rotate"
          className="text-xs text-status-warning"
          title={`${rotate.removedNames.join(', ')} could read this value. Change it where it is issued.`}
        >
          Rotate
        </span>
      )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/`
Expected: PASS — the new tests and every existing renderer test (the mock API answers `teamSecrets.status` with the
off status).

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/state/team-secrets.ts apps/desktop/src/renderer/features/sync/team-secrets-section.tsx \
  apps/desktop/src/renderer/features/sync/sync-panel.tsx apps/desktop/src/renderer/features/sync/sync-badge.tsx \
  apps/desktop/src/renderer/components/secret-field.tsx apps/desktop/src/renderer/shell/app-shell.tsx \
  apps/desktop/test/renderer/team-secrets-store.test.ts apps/desktop/test/renderer/team-secrets-section.test.tsx \
  apps/desktop/test/renderer/sync-badge.test.tsx apps/desktop/test/renderer/secret-field.test.tsx
git commit -m "feat(desktop): Team secrets in the Sync panel (#38)

The Sync panel gains a Team secrets section: turn it on, see this machine's fingerprint, approve or
decline a request after checking its fingerprint another way, remove a member (their values are marked
Rotate), manage admins, and settle a value another member replaced. The sync badge counts machines
waiting for an admin; a secret field marks a value that is only on this machine or needs rotating."
```

---

## Task 12: e2e, the guide, ADR-0014, CHANGELOG and the success-criteria rows

**Files:**
- Create: `e2e/specs/team-secrets.spec.ts`
- Modify: `e2e/helpers/sync.ts:214` (`joinSharedWorkspace` waits for the key request)
- Modify: `e2e/specs/sync-secret.spec.ts:92-97` (either message)
- Create: `docs/adr/0014-team-secrets-are-sealed-per-machine-in-the-tree.md`
- Modify: `docs-site/src/content/docs/guides/secrets.mdx` ("What is and isn't shared", `:51`),
  `docs-site/src/content/docs/guides/shared-workspaces.mdx` ("Secrets", `:131`)
- Modify: `CHANGELOG.md` (Unreleased → Added), `docs/success-criteria.md` (intro list and SC-T rows)

**Interfaces:**
- Consumes: the UI testids from Task 11; the e2e helpers `SyncProfiles`, `startSharedWorkspace`,
  `joinSharedWorkspace`, `pullNow`, `syncBadge`, `SYNC_TIMEOUT`, `createBareRemote`, `remoteLog`, `runGit`,
  `startTestSoapServer` (its `/auth/basic` accepts `user`/`pass`).
- Produces: `e2e/specs/team-secrets.spec.ts` — written and type-checked here, run by CI only (Global Constraints).

- [ ] **Step 1: The e2e spec**

Create `e2e/specs/team-secrets.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { createBareRemote, remoteLog, runGit } from '../helpers/git-remote.js';
import { expandExplorer, openFirstRequest, saveAll } from '../helpers/project.js';
import {
  joinSharedWorkspace,
  pullNow,
  startSharedWorkspace,
  syncBadge,
  SyncProfiles,
  SYNC_TIMEOUT,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const BEN = { name: 'Ben', email: 'ben@example.com' };
/** A value distinctive enough that finding it anywhere in the remote's history is proof of a leak. */
const WRONG = 'wrong-7f3e9c41d2';
const RIGHT = 'pass';

async function authPanel(page: Page) {
  await expandExplorer(page, 'Request 1');
  await openFirstRequest(page);
  await page.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
  return page.getByTestId('inspector-panel-request');
}

async function openSyncPanel(page: Page) {
  await syncBadge(page).click();
  return page.getByTestId('sync-panel');
}

async function closeSyncPanel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sync-panel')).toHaveCount(0);
}

/**
 * Team secrets end to end (spec §13): A shares and sets a password; B joins and waits; A approves
 * B after reading the fingerprint; B sends with A's value, and with A's next value, having typed
 * nothing. The remote's history never holds a value. Removing B marks the value for rotation.
 */
test.describe('shared workspaces: team secrets', () => {
  let profiles = new SyncProfiles();
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    try {
      await current.dispose();
    } finally {
      await server?.close();
      server = undefined;
    }
  });

  test('an approved machine uses the team’s values without typing them, and the remote never holds one', async () => {
    test.setTimeout(300_000);
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    const a = await profiles.launch();
    // Plan decision 23: team secrets refuse to make a key without OS encryption (headless Linux CI).
    const keychain = await a.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    test.skip(!keychain, 'Team secrets need an OS keychain, which this environment does not have.');

    await startSharedWorkspace(a.window, server, remote);
    const pageA = a.window;

    // --- A: Basic auth with a first (wrong) value --------------------------------------------
    const panelA = await authPanel(pageA);
    await pageA.getByTestId('request-endpoint').fill(`${server.url}/auth/basic`);
    await pageA.getByTestId('auth-inherit').uncheck();
    await panelA.getByLabel('Authentication type').selectOption('basic');
    await panelA.getByLabel('Username').fill('user');
    await panelA.getByRole('button', { name: 'Set…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(WRONG);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect(panelA.getByLabel('Password')).toHaveText('••••••••');
    await saveAll(pageA);
    await expect.poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT }).toContain('Update secret Password');

    // --- B joins and asks; its send says it is waiting ---------------------------------------
    const b = await profiles.launch({ identity: BEN });
    await joinSharedWorkspace(b.window, remote.url);
    await expect.poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT }).toContain('Request team secrets access for Ben');
    const pageB = b.window;
    const authB = await authPanel(pageB);
    await pageB.getByTestId('request-send').click();
    await expect(
      pageB.getByText('This machine is waiting for an admin to approve it for team secrets.').first(),
    ).toBeVisible({ timeout: 20_000 });
    const syncB = await openSyncPanel(pageB);
    const fingerprintB = (await syncB.getByTestId('team-secrets-me').textContent()) ?? '';
    await closeSyncPanel(pageB);

    // --- A pulls, sees one waiting, checks the fingerprint and approves ----------------------
    await pullNow(pageA);
    await expect(syncBadge(pageA)).toContainText('1 waiting', { timeout: SYNC_TIMEOUT });
    const syncA = await openSyncPanel(pageA);
    const row = syncA.getByTestId('team-secrets-pending-row');
    await expect(row).toContainText('Ben');
    const shown = (await row.textContent()) ?? '';
    expect(fingerprintB).toContain(shown.split('·').at(-1)?.trim() ?? '<none>');
    await syncA.getByTestId('team-secrets-approve').click();
    await expect(row).toHaveCount(0);
    await closeSyncPanel(pageA);
    await expect
      .poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT })
      .toContain('Approve team secrets access for Ben');

    // --- B pulls: A's value is used, nothing typed (the server refuses it) ------------------
    await pullNow(pageB);
    await expect(authB.getByTestId('secret-missing')).toHaveCount(0, { timeout: SYNC_TIMEOUT });
    await pageB.getByTestId('request-send').click();
    await expect(pageB.getByTestId('response-status')).toContainText('401', { timeout: 20_000 });

    // --- A replaces the value; B's next send after a pull succeeds ---------------------------
    await panelA.getByRole('button', { name: 'Replace…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(RIGHT);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect
      .poll(() => remoteLog(remote.dir).filter((subject) => subject === 'Update secret Password').length, {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(2);
    await pullNow(pageB);
    await expect
      .poll(
        async () => {
          await pageB.getByTestId('request-send').click();
          return (await pageB.getByTestId('response-status').textContent()) ?? '';
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toContain('200');

    // --- No value anywhere in the remote's history ------------------------------------------
    expect(runGit(['--git-dir', remote.dir, 'log', '-p', '--all'])).not.toContain(WRONG);

    // --- A removes B: the value B could read is marked Rotate --------------------------------
    const again = await openSyncPanel(pageA);
    await again.getByTestId('team-secrets-remove').click();
    await pageA.getByTestId('team-secrets-remove-confirm').click();
    await expect(again.getByTestId('team-secrets-rotate-row')).toContainText('Ben', { timeout: SYNC_TIMEOUT });
    await closeSyncPanel(pageA);
    await expect(panelA.getByTestId('secret-rotate')).toHaveText('Rotate');
  });
});
```

- [ ] **Step 2: Existing specs**

In `e2e/helpers/sync.ts`, add `fileURLToPath` from `node:url` and `remoteFiles`, `remoteLog` from `./git-remote.js`
to the imports, and replace `joinSharedWorkspace`:

```ts
/**
 * Profile B's start: joins `remoteUrl` from the picker and waits for a clean sync. When the remote
 * has team secrets on, the join also asks for access (a commit of its own); that commit lands
 * before this returns, so a spec's commit counts start after it.
 */
export async function joinSharedWorkspace(page: Page, remoteUrl: string): Promise<void> {
  await joinWorkspace(page, remoteUrl);
  await waitForSync(page, 'clean');
  const remoteDir = fileURLToPath(remoteUrl);
  if (remoteFiles(remoteDir).some((file) => file.startsWith('team-secrets/access/'))) {
    await expect
      .poll(() => remoteLog(remoteDir).some((subject) => subject.startsWith('Request team secrets access for')), {
        timeout: SYNC_TIMEOUT,
      })
      .toBe(true);
    await waitForSync(page, 'clean');
  }
}
```

In `e2e/specs/sync-secret.spec.ts`, replace the `getByText('The password for "user" is not on this machine — …')`
assertion with:

```ts
    // With team secrets on (an OS keychain), the vault holds A's value and B waits for approval;
    // without one, the value is simply not on this machine (plan decision 23).
    await expect(
      pageB
        .getByText(
          /The password for "user" is not on this machine — enter it in the authentication settings\.|This machine is waiting for an admin to approve it for team secrets\./,
        )
        .first(),
    ).toBeVisible({ timeout: 20_000 });
```

Then type-check the e2e project (no local Electron run):

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json`
Expected: no output, exit 0.

- [ ] **Step 3: ADR-0014**

Create `docs/adr/0014-team-secrets-are-sealed-per-machine-in-the-tree.md`:

```markdown
# ADR-0014: Team secrets are sealed per machine and travel in the shared tree

- Status: accepted
- Date: 2026-09-26
- Context: issue #38; `docs/specs/2026-09-26-team-secrets-design.md`. Builds on
  [ADR-0012](0012-server-sync-merges-on-the-client.md) (the client merges; the server stores files).

## Context

A shared workspace carries secret references, never values, so every member types every credential again on
every machine. The team wants a value set once to reach every approved machine, without the server, the git
host or anyone with the repository being able to read it.

## Decision

- **Every machine has its own key pair per workspace** (X25519 for encryption, Ed25519 for signatures), kept in
  the OS keychain-backed store. Without OS encryption, team secrets are off on that machine.
- **Each value is encrypted once** with a fresh AES-256-GCM data key, and the data key is wrapped for every
  approved machine (X25519 + HKDF-SHA256). Everything lives under `team-secrets/` in the tree and syncs like
  any other file; `team-secrets/values/**` is never text-merged.
- **Access is a signed, append-only log** of genesis, approve, remove and admin entries. Each machine pins the
  genesis it first saw and the entries it has seen, so a rewritten or truncated log stops it writing.
- **On a Wirebench Server share, the server's roles are the authority**: the server refuses access-log writes
  from non-admins, and a viewer's key request goes through a route that commits one file for it.
- **Removal re-encrypts, and asks for rotation.** A removed machine may have kept what it could read, so every
  such value is marked for rotation; re-encryption alone is not revocation.

## Consequences

- The server and git host store only ciphertext; losing every admin machine loses the ability to approve.
- Two machines setting one value keep the newer one, and the other machine keeps its own value locally to
  restore.
- Older app versions sync `team-secrets/` as opaque files and ignore it.
```

- [ ] **Step 4: The guides**

In `docs-site/src/content/docs/guides/secrets.mdx`, append to "What is and isn't shared" (before
`## Secret tokens and scanning`):

```mdx
**Shared, encrypted, with team secrets on:** in a shared workspace, the value itself can travel too —
encrypted separately for each approved machine. See [Team secrets](/wirebench/guides/shared-workspaces/#team-secrets).
A value that stays on your machine (team secrets off, or your machine not approved yet) shows
**Only on this machine** next to its field.
```

In `docs-site/src/content/docs/guides/shared-workspaces.mdx`, add after the `## Secrets` section (before
`## Without git`):

```mdx
## Team secrets

Sharing a workspace to git or a folder turns **team secrets** on: the values behind secret references are
shared too, encrypted for each approved machine. A server workspace turns them on when an admin shares it, or
from **Team secrets → Turn on team secrets** in the Sync panel. Team secrets need the system keychain; on a
machine without one, values stay local.

- **Joining.** A machine that joins asks for access on its first sync. Until an admin approves it, sending a
  request that needs a team value says the machine is waiting for approval.
- **Approving.** The sync badge counts machines waiting. In the Sync panel, each request shows its person,
  machine and fingerprint. Check the fingerprint with the person another way — a call or in person — before
  choosing **Approve**. The joining machine sees its own fingerprint in the same section.
- **Changing a value.** Saving a value on an approved machine commits it encrypted as *Update secret …*. Every
  other approved machine uses it after its next sync, with nothing to type.
- **At the same time.** When two machines change one value before syncing, the newer one wins. The other
  machine keeps its own value and offers **Use mine** or **Keep theirs**.
- **Removing.** Removing a machine re-encrypts every value without it. A removed machine may have kept what it
  could read, so every such value is marked **Rotate**: change it where it is issued.
- **Admins.** Whoever turns team secrets on is the first admin; add another so the team keeps access if that
  machine is lost. On a server workspace, the workspace's admins are the team-secrets admins.
- **Updating.** Members of a server workspace should update Wirebench before an admin turns team secrets on:
  an older version syncs the `team-secrets/` folder but cannot use it.
- **Stopping sharing** leaves the encrypted values with the shared copy; the local workspace keeps only this
  machine's own values.
```

- [ ] **Step 5: CHANGELOG and success criteria**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, first bullet:

```markdown
- **Team secrets.** A shared workspace can share secret values, not just references: each value is
  encrypted for every approved machine and travels with the workspace, so a teammate's next send uses it
  with nothing typed. Joining machines ask for access; an admin approves after checking a fingerprint.
  Removing a machine re-encrypts every value and marks the ones it could read for rotation. Two machines
  changing one value keep the newer, with a way back to your own. Needs the system keychain. Members of a
  server workspace should update before an admin turns team secrets on.
```

In `docs/success-criteria.md`, extend the intro sentence's list with `, and SC-T1–SC-T6 for team secrets
([`specs/2026-09-26-team-secrets-design.md`](specs/2026-09-26-team-secrets-design.md) §13, issue #38, built by
[`plans/2026-09-26-team-secrets-plan.md`](plans/2026-09-26-team-secrets-plan.md))` after the SC-D sentence part,
and add after the last SC-D row:

```markdown
| SC-T1 | **Set once, used everywhere** (team secrets §13.1) — a value changed on A is used by B's next send after B syncs, with nothing typed on B | `apps/desktop/test/workspace-team-secrets.test.ts` ("turns on, asks, approves and delivers a value to the second machine"), `apps/desktop/test/team-secrets-service.test.ts` ("stores the values an approved machine can open"), `e2e/specs/team-secrets.spec.ts` | Met; e2e row proven in CI (not run locally) |
| SC-T2 | **No plaintext in the tree or the server** (§13.2) | `apps/desktop/test/team-secrets-service.test.ts` ("writes this machine's key, a genesis…", "never answers with a value or a private key"), `packages/server/test/integration/sync/team-secrets.test.ts`, `e2e/specs/team-secrets.spec.ts` (`git log -p --all` holds no value) | Met; e2e row proven in CI (not run locally) |
| SC-T3 | **Nothing before approval; only admins approve** (§13.3) | `packages/engine/test/unit/team-secrets/log.test.ts`, `apps/desktop/test/team-secrets-service.test.ts` ("refuses a non-admin's approval…", "says a machine is waiting…"), `packages/server/test/integration/sync/team-secrets.test.ts` (non-admin access writes refused) | Met |
| SC-T4 | **Removal re-encrypts and marks for rotation** (§13.4) | `packages/engine/test/unit/team-secrets/vault.test.ts`, `apps/desktop/test/team-secrets-service.test.ts` ("re-encrypts every value without the removed key…", "re-encrypts a value still wrapped for a key that is not approved"), `apps/desktop/test/renderer/{team-secrets-section,secret-field}.test.tsx`, `e2e/specs/team-secrets.spec.ts` | Met |
| SC-T5 | **Concurrent changes: newer wins, with a notice and a restore** (§13.5) | `packages/engine/test/unit/team-secrets/vault.test.ts` (`vaultConflictWinner`), `apps/desktop/test/sync/sync-service.test.ts`, `apps/desktop/test/team-secrets-service.test.ts` ("keeps the newer value, and gives the loser its own back"), `apps/desktop/test/workspace-team-secrets.test.ts` ("settles two machines setting one value…") | Met |
| SC-T6 | **Local workspaces unchanged** (§13.6) | `apps/desktop/test/workspace-team-secrets.test.ts` ("leaves a local workspace alone"), every existing workspace and secrets test unchanged | Met |
```

Check the paths resolve and no banned term slipped in:

Run: `pnpm check:doc-paths && pnpm check:banned-terms`
Expected: both pass.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/specs/team-secrets.spec.ts e2e/helpers/sync.ts e2e/specs/sync-secret.spec.ts \
  docs/adr/0014-team-secrets-are-sealed-per-machine-in-the-tree.md \
  docs-site/src/content/docs/guides/secrets.mdx docs-site/src/content/docs/guides/shared-workspaces.mdx \
  CHANGELOG.md docs/success-criteria.md
git commit -m "docs(team-secrets): guide, ADR-0014, e2e and success criteria (#38)

The shared-workspaces guide explains turning team secrets on, approving after a fingerprint check,
concurrent changes, removal and rotation, and the update note for server members. ADR-0014 records
the per-machine sealing and the signed access log. The e2e spec proves a value set on one machine is
used by another with nothing typed and never reaches the remote's history; it skips without an OS
keychain, and the existing secret spec accepts either message."
```

Before pushing: `pnpm test:perf` unskipped (CLAUDE.md gates); CI runs the e2e matrix.

---

## Self-review

**Spec coverage.**

| Spec section | Task(s) |
| --- | --- |
| §2 Concept model (machine key, vault entry, access log, key request) | 1, 2, 3 |
| §3.1 Turning on (genesis, first admin, backfill; git/folder at share, server by admin) | 6, 9 (plan decision 10) |
| §3.2 Joining and approval (request on first sync, fingerprint, approve rewraps, decline, pending send message) | 4, 6, 7, 11, 12 |
| §3.3 Changing a value (vault write on save, `Update secret <label>`, token dialog and scan move) | 5, 7, 10 |
| §3.4 Receiving a change (import on pull, heal, untrusted ignored) | 8, 9 |
| §3.5 Concurrent changes (newer wins, notice, restore) | 3, 5, 8, 11 |
| §3.6 Removing (re-encrypt, rotate marks, former server members) | 3, 6, 8, 11 |
| §3.7 Admins (grant, revoke, last admin, server authority) | 2, 4, 6, 11 |
| §3.8 Errors (the five codes and messages) | 1, 4, 6, 7 |
| §4 Data model and wire (three file kinds, status wire, channels, event, key-request route) | 2, 4, 6, 10 |
| §5.1 Server (admin-only access writes, key-request route) | 4 |
| §5.2 Engine | 1, 2, 3 |
| §5.3 Desktop main | 5, 6, 7, 8, 9, 10 |
| §5.4 Desktop renderer | 11 |
| §6 Security (no values over IPC/logs/tree/History/HAR, TOFU pin, signatures, damaged log) | 1, 2, 6, 7, 8, 10 |
| §11 Testing strategy (unit, integration, server, renderer, e2e) | every task; e2e in 12 |
| §14 Migration and compatibility (older apps; server-share caveat) | 2 (plan decision 1), 12 |

**Success criteria (§13) → tasks:** SC-T1 value used after sync with nothing typed → 8, 9, 12; SC-T2 no plaintext
in tree or server → 4, 6, 12; SC-T3 nothing before approval, non-admin approval ignored or refused → 2, 4, 6, 7;
SC-T4 removal re-encrypts and marks rotation → 3, 6, 8, 11, 12; SC-T5 concurrent changes → 3, 5, 8, 9, 11;
SC-T6 local workspaces unchanged → 9 (and every existing test left as is). Task 12 records them as rows SC-T1–SC-T6.

**Placeholders.** None: every step has real code or an exact command, and every test names its expected failure.

**Names checked across tasks.** Engine: `vaultEntryId`, `vaultEntryPath`, `keyRequestPath`, `accessEntryPath`,
`nextAccessEntryId`, `replayAccessLog`, `verifiedKeys`, `approvedRecipients`, `buildVaultEntry`, `sealVaultEntry`,
`healVaultEntry`, `openVaultEntry`, `verifyVaultEntry`, `wrapsUnapprovedKey`, `rotateMarks`, `vaultConflictWinner`,
`teamSecretsError`, `TEAM_SECRETS_MESSAGES`, `TEAM_SECRETS_DIR`. Desktop: `ConflictSides`, `resolveConflicts`,
`afterTeamSecretsWrite`, `identity`, `requestTeamSecretsKey`, `workspaceMembers` (Task 5) are the names Tasks 8 and 9
call; `TeamSecretsService` methods (Tasks 6–8) are the names Tasks 9–10 pick; `teamSecrets.*` channel names
(Task 10) are the store actions of Task 11; testids of Task 11 are the ones Task 12's e2e uses.
