# Team secrets in a shared workspace — design (#38)

Status: approved intent (owner interview, 2026-09-26); this spec is the authority for the plan.

## Assumptions

- A shared workspace is a git repository whatever its transport (ADR-0008); the server stores commits
  as opaque blobs and never parses file bodies (ADR-0012, server-host spec §6).
- Secret refs (`sec_…`) and `${secret:name}` tokens already travel in the tree; values live in the
  keychain-backed `SecretStore` on each machine (ADR-0004). Nothing in the renderer can read a value.
- `node:crypto` is the only crypto dependency: X25519, Ed25519, HKDF-SHA256 and AES-256-GCM are all in
  Node's standard library, so no package is added.

## 1. Objective

When one teammate rotates a secret in a shared workspace, everyone else gets the new value on their next
sync, without pasting anything. Values travel in the repository encrypted to each approved machine's
public key; they are decrypted only on members' machines; neither the git host nor Wirebench Server can
read them.

Owner decisions (interview, 2026-09-26):

1. The pain is **rotation drift**; first-day setup is a side effect.
2. **Every** secret in a shared workspace is a team secret. Personal secrets belong in a local workspace,
   which keeps today's keychain-only path unchanged.
3. The **same model over git, synced folders and the server**: public keys are committed in the tree.
4. **Only admins approve** a new key. On a server workspace, admin is the server role (ADR-0011). A git or
   folder workspace has a **signed admin list** in the tree; whoever turns team secrets on is its first
   admin, and every app verifies the chain.
5. **Removing** a machine re-encrypts every value without its key and flags each value it could read as
   "rotate — they had access". Wirebench never rotates a value at the provider.

## 2. Concept model

- **Machine key.** Each machine that opens the workspace has one key pair per workspace: an X25519 key for
  decryption and an Ed25519 key for signing, generated on first use and kept in the `SecretStore`
  (`safeStorage`). Keys belong to machines, not people: a person with two laptops has two keys, each
  approved separately. A lost laptop is one removal.
- **Key request.** A machine with no approval commits its public keys (`keys/<keyId>.yaml`) with the
  person's display name, email and a machine label. Until an admin approves it, it can read nothing.
- **Access log.** `access/<ulid>.yaml` entries, each signed: `genesis`, `approve`, `remove`,
  `grant-admin`, `revoke-admin`. Replaying them in ULID order gives the set of approved keys and admin
  keys. The log is the only thing that says who may read.
- **Vault entry.** One file per secret, `values/<id>.yaml`: the value encrypted once with a random data
  key, the data key wrapped for every approved key, who wrote it and when, and the writer's signature.
- **Team secrets on.** A workspace has team secrets when its tree holds `team-secrets/access/` with a valid
  genesis entry. Local workspaces never do.

## 3. Behaviour

### 3.1 Turning team secrets on

- **Share this workspace…** (git, folder or server) turns team secrets on as part of sharing: the sharer's
  machine creates its key, writes the genesis entry naming itself admin, and encrypts every value it holds
  for the workspace's refs and tokens into the vault, in the same first commit.
- An **existing shared workspace** shows *Turn on team secrets* in the Sync settings to whoever may do it
  (server: admin role; git/folder: anyone, since there is no admin yet). It does the same in one commit.
- After it is on, every member's machine that holds a value for a ref or token the vault lacks adds it on
  its next sync (so values held by different people all end up shared). If two machines add the same one,
  §3.5 decides.

### 3.2 Joining and approval

- A machine that syncs a workspace with team secrets and has no approved key creates its key and commits
  the key request (a viewer on a server workspace cannot push, so its request goes through the server's
  key-request route, §5.1).
- Until approved, a send that needs a team value fails with `team-secrets-pending`: "This machine is
  waiting for an admin to approve it for team secrets." The Enter… path still works and stores a
  machine-only value, shown with "Only on this machine".
- Admins see "*N* machines waiting" in the status bar sync menu and in the Sync settings **Team secrets**
  section: name, email, machine label, key fingerprint (first 16 hex of SHA-256 of the public keys, in
  groups of four), requested date. **Approve** writes an `approve` entry and wraps every vault entry's
  data key for the new key, in one commit. **Decline** deletes the request file.
- A declined machine remembers that its request was seen and then deleted while it waited: it does not ask
  again by itself, and shows `team-secrets-declined` ("An admin declined this machine's request for team
  secrets.") with **Request access**, which makes a fresh key and asks again. A removed machine sees
  `team-secrets-removed` ("An admin removed this machine from team secrets.") and the same button. Both
  codes replace `team-secrets-pending` on a send that needs a team value, and on an access change.
- **Request access** waits for the request to go out: a failure (the server's `team-secrets-rate-limited`,
  no network) is shown, and the machine keeps the key and state it had.
- The admin checks the fingerprint with the person out of band; the dialog says so.

### 3.3 Changing a value

- Saving a value (Enter…, the secret field, the `${secret:name}` dialog, or a secret-scan move) for a ref or
  token the workspace's projects or environments use, in a workspace with team secrets, writes the vault
  entry: new data key, value encrypted, wrapped for every
  key approved in the current log, signed by this machine. The keychain keeps a local copy as the cache.
- The vault write is an ordinary tree change: it follows commit-on-save and push-on-save like any other
  save, and the commit message reads "Update secret <label>" (never the value).
- Deleting a ref the workspace uses deletes its vault entry.
- **App-level secrets stay on the machine.** A value the workspace does not use — the proxy password in
  Preferences, any ref no project or environment names — never reaches the vault, even while a shared
  workspace is open. A ref a project starts using later is sealed by the backfill that runs after that
  save (and after every pull).
- A machine without an approved key cannot write the vault; its save stays local and is marked "Only on
  this machine".

### 3.4 Receiving a change

- After every pull (`onPulled`), the app replays the access log, verifies every changed vault entry
  (signature by a key approved when it was written — see §6), decrypts the ones wrapped for this machine
  and writes the values into the local `SecretStore` under the same ref or label. The next send uses them.
- An entry that fails verification is ignored and listed in the Team secrets section as "Not trusted:
  signed by a key that is not approved"; the previous value stays.
- **Healing.** If a vault entry lacks a wrap for a key the log approves (a value written while an
  approval was in flight), any approved machine that can decrypt it adds the missing wraps on its next
  sync. Healing only ever adds wraps for approved keys.

### 3.5 Concurrent changes

A vault entry is a whole-file value, never text-merged. When the three-way merge reports a conflict on a
path under `team-secrets/values/`, the sync resolves it without the conflict dialog: the side with the
later `updatedAt` wins (ties: the lower `keyId`). The loser gets a notice, "Your change to *label* was
replaced by *name*'s newer value", with the replaced value kept on the machine for *Restore my value*,
which writes it again as a new change. Conflicts on `keys/` or `access/` files cannot happen in normal use
(unique file names); if one does, the conflict dialog handles it as any file.

### 3.6 Removing a machine or a person

- **Remove** on an approved key (admins only) writes a `remove` entry and, in the same commit, re-encrypts
  every vault entry with a fresh data key wrapped only for the remaining keys.
- Every entry that the removed key could decrypt is marked **Rotate** in the Team secrets section and on
  its secret field: "*name* had access. Change this value at its provider, then here." Changing it clears
  the mark. The marks come from the log replay (a value written after the removal is not marked), so
  every member sees them.
- Old ciphertexts stay in git history under keys the removed machine held; the rotate marks are the
  answer, and the docs say so plainly.
- On a server workspace, removing a person from the team does not remove their keys by itself; the Team
  secrets section lists "Keys of people no longer in this workspace" with *Remove* for an admin.

### 3.7 Admins

- **Git and folder workspaces:** the genesis signer is the first admin. An admin can grant or revoke admin
  on any approved key; the last admin key cannot be revoked. An `approve`, `remove`, `grant-admin` or
  `revoke-admin` entry is valid only if signed by a key that is an admin at that point of the replay.
- **Server workspaces:** the server role decides. The genesis entry records `authority: server`; entries
  are still signed by the approver's machine key, and valid if that key is approved; the server refuses a
  push that changes `team-secrets/access/` unless the pusher is an admin of the workspace (§5.1). There
  are no `grant-admin`/`revoke-admin` entries in this mode.
- The authority is fixed at genesis. Moving a workspace between transports keeps its log and authority.

### 3.8 Errors

| Code | When | Message |
| --- | --- | --- |
| `team-secrets-pending` | send needs a team value; machine not approved | This machine is waiting for an admin to approve it for team secrets. |
| `team-secrets-removed` | send needs a team value, or an access change is asked for, on a removed machine | An admin removed this machine from team secrets. |
| `team-secrets-declined` | the same, on a machine whose request an admin declined | An admin declined this machine's request for team secrets. |
| `team-secrets-no-safe-storage` | creating a machine key without OS encryption | Team secrets need the system keychain, which is not available on this machine. |
| `team-secrets-admin-only` | server refuses a non-admin push touching `access/`, or changing or deleting an existing `keys/` file | Only a workspace admin can change who has access to team secrets. |
| `team-secrets-untrusted` | vault entry fails verification | Ignored a secret signed by a key that is not approved. |
| `team-secrets-last-admin` | revoking the last admin key | A workspace needs at least one admin for team secrets. |
| `team-secrets-damaged` | this machine's access log does not match what it saw before | The team secrets access log on this machine does not match what it saw before; this machine will not change team secrets until it is repaired. |
| `team-secrets-remove-self` | an admin tries to remove their own machine's key | Ask another admin to remove this machine. |
| `team-secrets-cannot-reencrypt` | removing a key whose vault entries this machine cannot decrypt to re-encrypt | Some team secrets are not readable on this machine, so they cannot be re-encrypted. Ask another admin to remove this machine, or wait for this machine to receive them. |
| `team-secrets-already-admin` | granting admin to a key that already is one | That machine is already a team secrets admin. |
| `team-secrets-not-admin` | revoking admin from a key that is not one | That machine is not a team secrets admin. |
| `team-secrets-last-approved` | removing the last approved machine | A workspace needs at least one approved machine for team secrets. |
| `team-secrets-not-allowed` | a change to team secrets access that the current authority does not allow | That change to team secrets access is not allowed. |
| `team-secrets-rate-limited` | a machine asks the server for team secrets access too often | Too many requests for team secrets access. Try again in a few minutes. |
| `team-secrets-not-shared` | a team secrets action is called without an open shared workspace | Team secrets need a shared workspace. |
| `team-secrets-no-such-key` | approving, declining, removing or changing admin on a `keyId` that is not in the state the action needs (already approved, not yet requested, already removed) | That machine is not waiting for approval, or not approved, as this change needs. |

`team-secrets-server-authority` ("On a server workspace, the server roles decide who is an admin.") guards
`grantAdmin`/`revokeAdmin` on the server authority, but the renderer only offers those buttons when
`status.authority === 'signed'` (§5.4), so this code is not reachable from the UI in normal use.

## 4. Data model and wire

All files live under `team-secrets/` at the tree root, YAML, one document each, written by the engine's
serializer. Binary fields are base64url without padding. Signatures cover the canonical JSON (sorted keys,
no whitespace) of the document without its `signature` field.

```yaml
# team-secrets/keys/<keyId>.yaml          keyId = first 26 base32 chars of SHA-256(encPub || signPub)
version: 1
keyId: K7Q…
encryptionKey: <x25519 public, 32 bytes>
signingKey: <ed25519 public, 32 bytes>
name: Alex Doe
email: alex@example.com
machine: alex-mbp
requestedAt: 2026-09-26T10:00:00.000Z
signature: <ed25519 by signingKey>        # proves possession
```

```yaml
# team-secrets/access/<ulid>.yaml
version: 1
id: <ulid>
action: genesis | approve | remove | grant-admin | revoke-admin
authority: signed | server                # genesis only
key: <keyId>                              # subject (genesis: the first admin)
by: <keyId>                               # signer
at: 2026-09-26T10:00:00.000Z
signature: <ed25519 by `by`>
```

```yaml
# team-secrets/values/<id>.yaml           id = SHA-256 of the secret key, first 26 base32 chars
version: 1
secret: { ref: sec_… }                    # or { token: { projectId, name } }
label: Payments API key                   # the display label, never the value
cipher: <AES-256-GCM(dataKey, value): nonce || ciphertext || tag>
wraps:
  <keyId>: <ephemeral X25519 pub || nonce || AES-256-GCM(HKDF(ECDH), dataKey)>
updatedAt: 2026-09-26T10:00:00.000Z
updatedBy: <keyId>
signature: <ed25519 by updatedBy>
```

Wrapping: fresh ephemeral X25519 pair per wrap; shared secret by ECDH with the recipient's key; HKDF-SHA256
with salt = ephemeral pub || recipient pub and info `wirebench-team-secrets-v1-wrap` gives the AES key;
AES-256-GCM with a random 12-byte nonce. The GCM additional data for `cipher` is the vault entry id, so an
entry cannot be moved to another secret.

Wire additions (desktop main ↔ renderer): `teamSecrets.status` (on, authority, my key state, pending
requests, approved keys with admin flags, rotate marks, untrusted entries, replaced notices), `teamSecrets.turnOn`,
`.requestAccess`, `.approve`, `.decline`, `.remove`, `.grantAdmin`, `.revokeAdmin`, `.restoreMine`,
`.dismissReplaced`; and a `teamSecrets.changed` event. Only ids, names, fingerprints and labels cross IPC,
never a value or a private key. An untrusted entry may carry `reason: 'rolled-back'` when it reads as an
older signed copy than the one this machine already accepted, distinct from one signed by a key that is
not approved.

## 5. Architecture

### 5.1 Server

- `POST /workspaces/:id/sync/commits` checks the changed paths (already computed by the commit store) and
  refuses with 403 `team-secrets-admin-only` when a non-admin's push adds, changes or deletes a file under
  `team-secrets/access/`, or changes or deletes an existing file under `team-secrets/keys/` (adding a new
  key request stays allowed: that is how an editor asks). No file body is parsed.
- `POST /workspaces/:id/team-secrets/key-requests` lets any member with at least viewer role add exactly
  one file `team-secrets/keys/<keyId>.yaml` as a server-authored commit ("Request team secrets access for
  <name>"), author the signed-in account. The body is size-capped (4 KiB) and the path is derived from the
  `keyId` field checked against `^[A-Z2-7]{26}$`; the server does not verify the key's signature.

### 5.2 Engine (`packages/engine/src/team-secrets/`)

Pure, no Electron: `keys.ts` (generate, keyId, fingerprint), `envelope.ts` (encrypt, wrap, unwrap,
decrypt), `sign.ts` (canonical JSON, sign, verify), `log.ts` (replay → `{authority, approved, admins,
removed, errors}`), `vault.ts` (build, verify, rewrap, heal), `schema.ts` (zod for the three file
kinds), `resolve-conflict.ts` (§3.5 winner). Reused by desktop main and by tests; the CLI is unchanged
(CI keeps `passwordEnv`/`tokenEnv`).

### 5.3 Desktop main

`team-secrets-service.ts`: owns the machine key per workspace (stored in `SecretStore` under
`wirebench-team-key:<workspaceId>`, refusing when `safeStorage` is unavailable), writes key requests,
access entries and vault entries through the workspace's tree writer, runs the pull hook (§3.4) from
`WorkspaceService.applyPulled`, feeds conflict resolution in `sync-service.ts`, and serves the IPC in §4.
`secrets` IPC `set`/`replace`/`delete` call it when the workspace has team secrets on. The secret-scan
move writes the vault too.

### 5.4 Desktop renderer

- Sync settings: **Team secrets** section (turn on, my machine state and fingerprint, pending requests
  with Approve/Decline, approved keys with Remove and admin toggles, people no longer in the workspace,
  rotate marks, untrusted entries).
- Status bar sync menu: "*N* machines waiting" for admins.
- Secret field: "Only on this machine" and "Rotate" marks.
- Renderer imports only types from `shared/wire-types.ts`.

## 6. Security

- Values and private keys never leave main unencrypted; the tree, IPC, logs, History, HAR and crash
  reports never carry either.
- A vault entry is trusted only if its `updatedBy` key is approved in the current replay. A removal
  re-encrypts every entry, so the remover becomes the signer of the entries the removed key had written.
- Anyone with push access can commit a key request or a forged file; forged files fail verification and
  are ignored. Only an admin's signature (git) or the server's admin check (server) adds a reader.
- The secret scanner ignores `team-secrets/` (ciphertext is not a secret leak).
- Git history keeps old ciphertexts; removal marks values for rotation instead of claiming they are safe.
- **Rollback protection.** A machine pins the genesis it first saw and every access entry it has accepted;
  it refuses to write a vault entry older than one it already accepted for the same secret, and a seen
  access entry that goes missing or comes back tampered with (its signature, or its signer's request, no
  longer checks out, or the request of the key it removes or changes admin on is gone) stops that machine
  from writing team secrets at all until repaired (`team-secrets-damaged`). Only an `approve` whose
  subject's request is gone is not damage: a concurrent decline deletes exactly that. A machine also keeps
  every removal it saw, so the Rotate marks survive the removed key's request file being deleted.
- A vault ref entry labelled like a `${secret:name}` token's store entry (`wirebench-secret:…`) or a
  machine-only one is refused as untrusted; a token's store label always comes from the entry's token.
- The machine's own private key never leaves the keychain-backed store: it is kept under a machine-only
  label and cannot be listed, deleted, replaced, or used as an ordinary secret's value.
- `updatedAt` on a vault entry is whatever the writing member's machine sets; a future-dated value wins a
  conflict against an honestly-dated one (§3.5). Members of a shared workspace are trusted; this is not a
  defense against a malicious member, only against races between honest ones.

## 7. Tech stack

`node:crypto` (X25519, Ed25519, HKDF, AES-256-GCM); zod for schemas; the existing YAML serializer. No new
dependency.

## 8. Commands

`WIREBENCH_SKIP_PERF=1 pnpm check` before every commit; `pnpm test:perf` before push; e2e runs in CI.

## 9. Project structure (new or changed)

- `packages/engine/src/team-secrets/*` (new)
- `packages/server/src/sync/routes/commits.ts`, new `packages/server/src/sync/routes/key-requests.ts`
- `apps/desktop/src/main/team-secrets-service.ts` (new), `ipc/team-secrets.ts` (new), `ipc/secrets.ts`,
  `sync/sync-service.ts`, `workspace-service.ts`, `workspace-share.ts`
- `apps/desktop/src/shared/wire-types.ts`
- renderer: `features/sync/team-secrets-section.tsx` (new), `components/secret-field.tsx`, the status bar
  sync menu
- `e2e/specs/team-secrets.spec.ts` (new)
- docs: `docs/adr/0014-team-secrets-are-encrypted-to-machine-keys.md`, the docs-site secrets guide,
  CHANGELOG

## 10. Code style

Match the surrounding modules: small pure functions in the engine, `WirebenchError` codes for failures,
zod schemas beside the types.

## 11. Testing strategy

- Engine unit tests: round trip, wrong key, tampered cipher/wrap/signature, moved entry (AAD), log replay
  for each action and invalid signers, healing, conflict winner, canonical JSON stability.
- Server: non-admin push touching `access/` refused; admin allowed; key-request route (viewer allowed,
  bad keyId refused, oversize refused, one file only).
- Desktop main: turn on, approve, remove with rotate marks, pull hook writes values, untrusted ignored,
  pending send error, conflict auto-resolve with notice and restore, no-safeStorage refusal.
- Renderer: Team secrets section states, fingerprint shown, admin-only controls.
- e2e: two app profiles on one git remote: A shares, B requests, A approves, A rotates, B sends with the
  new value; A removes B, marks appear.

## 12. Boundaries

- **Always:** keep values and private keys in main; sign every file the feature writes; verify before use.
- **Never:** write a plaintext value to the tree; let the server parse a vault file; approve a key
  automatically; drop the keychain-only path for local workspaces.

## 13. Success criteria (done when all are true)

1. A value changed on machine A is used by machine B's next send after B syncs, with nothing typed on B.
2. The tree and the server database contain no plaintext value (tested by searching the repository objects
   for the value).
3. A new machine reads nothing until an admin approves it; a non-admin's approval is ignored (git) or
   refused (server).
4. Removing a machine re-encrypts every value without it and marks each one it could read for rotation.
5. Concurrent changes to one secret resolve to the newer value with a notice and a restore.
6. Local workspaces behave exactly as before.

## 14. Migration and compatibility

Existing shared workspaces keep per-member values until an admin turns team secrets on (§3.1). An older
app version ignores `team-secrets/` and keeps working with per-member values. On a Wirebench Server share,
though, an older app refuses to open a workspace whose tree holds `team-secrets/` at all (it is a tree
item the older app does not recognise), so members should update before an admin turns team secrets on
for a server workspace.

## 15. Risks

- Clock skew decides concurrent-change winners; acceptable, and the loser can restore.
- A lost admin key with no other admin leaves access frozen (recovery is out of scope); the UI warns when
  there is a single admin.
- **Two turn-ons at once.** If two machines turn team secrets on for the same git or folder share before
  either syncs, each pins its own genesis; the other's is ignored as a second genesis on that machine, and
  the team stays split without a notice. There is no turn-off to start over from, so the docs ask members
  to agree who turns team secrets on. Parked: a status message on `second-genesis`, and a way to reset.
- **A server workspace moved to git or a folder** keeps its server authority, where any approved member
  can change access because no server checks the pusher. Parked: treating that log as read-only, or turning
  team secrets off and on again once a turn-off exists; until then the docs say to move such a workspace
  only among members everyone would trust as admins.
- **The secret field marks refs only.** "Only on this machine" and Rotate on a secret field follow refs;
  `${secret:name}` tokens show those marks in the Team secrets section only.
- **A quick decline on a server share.** A server share's key request goes through the route without waiting,
  so a decline that lands before the machine's next load has seen its request file is not recognised as a
  decline: the machine asks once more, automatically. A second decline sticks.
- An approved machine whose request file goes missing (its approval, which it saw, is still in the tree) is
  waiting again, not declined: it re-sends the same key and the approval counts again.
- A new value is dated after every removal this machine knows, so a clock running behind never leaves a
  rotated value marked Rotate.
- **Known limits.** The remote author of a losing concurrent change gets no "replaced" notice — only the
  machine that merges and sees both sides does (§3.5, plan decision 9). Forgetting a value (deleting its
  ref) that a project still uses elsewhere can be brought back by another member's next save of that
  value, since healing and ordinary saves both re-add what the log still approves.

## 16. Out of scope

Personal secrets inside a shared workspace; secrets from external managers (#37); per-environment access;
recovery when every admin key is lost; the CLI reading team secrets; rotating values at providers.
