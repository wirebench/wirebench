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
