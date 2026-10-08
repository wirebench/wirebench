# ADR-0003: A project is a folder of small YAML and XML files, `formatVersion: 1`

- Status: accepted
- Date: 2026-09-09
- Context: spec §7 (data model and project format), §13 SC10, §17 (decision log)

## Context

The traditional format for this kind of tool is one large XML file per project. That file is
the thing teams actually fight with: two people editing different requests produce a conflict in
the same document, a one-character change produces an unreadable diff, and the file is where
credentials end up.

Wirebench projects are meant to live in git next to the service they exercise.

## Decision

A project is a **directory**. Every file is UTF-8 text with stable key order, and each file
holds one concept:

```
my-service/
  wirebench.yaml                   # manifest: name, formatVersion, settings, properties, environments
  environments/dev.yaml            # endpoints + properties per environment
  interfaces/<Interface>/
    interface.yaml                 # definitionUrl, cache, soapVersion, endpoints[], wsa, defaultAuth (refs only)
    definition/                    # the fetched WSDL/XSD, byte-exact, plus manifest.yaml (url → file, sha256)
    operations/<Operation>/
      <Request>.request.yaml       # endpointRef, headers, attachments, auth, wsa, properties
      <Request>.xml                # the envelope, exactly as edited
  wss/…                            # outgoing/incoming WSS configs and keystore entries (no secrets)
  attachments/                     # content-addressed by sha256
```

The envelope is a plain `.xml` file, not a string inside YAML — it is XML, it is edited as
XML, and it should diff as XML. `formatVersion` is `1`; a breaking change bumps it and ships a
migration, and opening a newer format shows a clear error rather than guessing.

Secrets are never in the folder (ADR-0004), and neither is history — it lives in app data,
keyed by project id, so a project directory is safe to commit and share.

## Rationale

- **Reviewable diffs.** Renaming one request touches exactly two files; this is asserted, not
  assumed (spec §13 SC10, `e2e/specs/project.spec.ts`).
- **Mergeable.** Two people editing two requests edit two files.
- **Inspectable and scriptable.** YAML and XML on disk means `grep`, `sed` and code review
  work without Wirebench installed.
- **YAML over JSON** for the hand-edited files: comments and readable multi-line values. XML
  stays XML.

## Consequences

- Many small files: loading a project is a directory walk, and the loader must be robust to
  files added, removed or edited behind the app's back (`project-watch`).
- Names on disk come from user-supplied names, so every write goes through the path-safety
  rules in ADR-0005 — an interface called `../../etc` must never escape the project root.
- Stable key order and deterministic serialization are part of the format, not a nicety: any
  non-determinism shows up as a spurious diff in someone's pull request.
- `formatVersion` is a commitment, and stricter than "adding fields is free". The loader
  validates every file with `exact<T>()` (`packages/engine/src/project/load.ts`): a key the
  schema does not know is dropped on load and therefore **lost on the next save**. That is
  deliberate — it is what keeps an unknown key from surviving as an unreviewable ghost in
  someone's project — but it means *any* additive field bumps `formatVersion` and ships a
  migration, exactly as a changed or removed one does. A field added inside the current
  version would silently delete itself from every project written by an older build.

**Update (workspaces, ADR-0006):** projects now normally live inside a workspace folder in app
data (`<userData>/workspaces/<id>/projects/<slug>/`), unchanged in format; they are exported or
linked to a folder of the user's choosing when git is wanted.

**Update (2026-09-12, per-variable enabled flag): `formatVersion: 2`.** Every property scope
gained a per-variable enabled flag: a variable can be switched off without deleting it, so
resolution falls through to the next scope as if it were absent. On disk this is a sibling
`disabled:` list of names next to `properties` (which stays a plain `name -> value` map), sorted,
deduplicated, and omitted entirely when empty — exactly the additive-field case this ADR's
Consequences section calls out, so it is a format bump like any other. A version-1 file (no
`disabled` key) migrates as "all enabled" and is rewritten at version 2 on the next save; a
version-3-or-later file is refused with the existing clear error. This also means a 1.0.0 build
cannot open a project this build has saved — it sees `formatVersion: 2` and refuses it with its
"created by a newer version of Wirebench" error.

**Update (2026-09-14, REST APIs): `formatVersion: 3`.** A project may now hold **APIs beside
interfaces** (ADR-0007), in a parallel tree that follows the same one-concept-per-file rule:

```
my-service/
  interfaces/<Interface>/…          # unchanged
  apis/<Api>/
    api.yaml                        # kind: rest, baseUrl, auth (refs only), settings, definition ref
    definition/                     # the imported OpenAPI document, byte-exact, plus manifest.yaml
    requests/
      <Request>.request.yaml        # kind: rest, method, url, pathParams, query, headers, body, auth
      <Request>.body.json           # a raw body, in a file of its own language (.json/.xml/.txt/…)
      <Folder>/folder.yaml          # a folder's own name, order and inherited auth
      <Folder>/<Request>.request.yaml
```

A raw body is a **file beside its request**, not a string inside the YAML, for the same reason the
SOAP envelope is: it is JSON (or XML, or text), it is edited as that, and it should diff as that.
Folders nest, capped at the depth the REST spec sets, and a folder deeper than the cap is reported
as a problem rather than written. Every name on disk goes through ADR-0005's path-safety rules, and
`api.yaml`/`*.request.yaml` both carry `kind:` explicitly (`grpc` is reserved and refused by name).

`FORMAT_VERSION` moved to `3`. A version-1 or version-2 project opens unchanged — the
migration is "no APIs, no folders, no REST requests" — and is rewritten at version 3 on the next
save. As before, this is **one-way**: a 1.1.0 build cannot open a project this build has saved,
because it sees `formatVersion: 3` and refuses it with its "created by a newer version of
Wirebench" error, whether or not the project actually holds an API.

**Update (2026-09-22, token auth for SOAP owners): `formatVersion: 5`.** A SOAP interface,
endpoint or request's `auth` field can now hold `bearer`, `api-key` or `oauth2` — previously
offered to REST owners only — with the exact shapes `bearerAuthSchema`, `apiKeyAuthSchema` and
`oauth2AuthSchema` already define, plaintext-secret rejection included. `inherit` stays refused at
all three SOAP sites: a SOAP owner still has nothing above it to inherit from, so the chain stays
request → endpoint (override/complement) → interface. The new schema
(`soapOwnerAuthSchema`) is a plain union reusing the REST arms rather than a copy, so this policy
statement's own rule about additive fields applies unchanged: new keys (`tokenRef`, `valueRef`,
`clientId`, …) and new enum values on an existing field are still a breaking read for an older
build, which would otherwise fail the narrower schema with a confusing "invalid project file"
error instead of the clean "created by a newer version of Wirebench" one. The 4 → 5 migration is a
stamp — no data moves, proved by a version-4 fixture whose save changes only the `formatVersion`
line.

**Update (2026-09-28, Sequences): `formatVersion` stays `5`; `sequences/` carries its own `version`.**
Sequences (`docs/specs/2026-09-28-sequences-design.md`) are a new file kind in a new top-level folder,
`sequences/<slug>.sequence.yaml`. The additive-field rule above is about a key an older build would drop from
a file it *does* read and then lose on save. A folder an older build never reads is a different case, and the
code makes it safe: `loadProject` walks only the folders it knows, `listManagedFiles` never lists
`sequences/`, so nothing there is deleted, and `isManagedPath` ignores it. An older build therefore opens the
project, shows no sequences, and leaves the folder byte for byte as it was, just as ADR-0014 relies on for
`team-secrets/`. Each sequence file carries `kind: sequence` and its own `version: 1`. A change to the
sequence shape bumps that version, and a build refuses only the files that are too new for it, as a
`sequence-version-too-new` problem, never the whole project. The project's `formatVersion` still moves
for any change to a file kind an older build reads.

**Update (2026-09-28, typed scripting): `formatVersion: 6`.** A SOAP, REST or gRPC request file may carry a
`scripts` key (`docs/specs/2026-09-28-typed-scripting-design.md`, #63), and each script lives in a file beside the
request, `<slug>.pre.ts` / `<slug>.post.ts` (`.js` for the Postman layer). This is the additive case this policy
exists for, and worse than most: an older build would drop the key, delete the script files on its next save, and
until then send the request without its scripts. So it bumps the version, and an older build refuses a project this
build has saved. The 5 → 6 migration is a stamp, proved by a version-5 fixture whose save changes only the
`formatVersion` line. The loader always opens the script file named from the request's slug and never the name the
request file records, so a hand-edited name cannot point outside the request's directory. Save treats a script file
beside a known request as managed, like a body file, so renaming a request moves its scripts and removing a script
removes its file.

**Update (2026-10-04, response examples): `formatVersion: 7`.** A REST request file may carry an `examples` list
(#64): saved responses, each with a status, headers and a body, the body in a file beside the request at
`<slug>.examples/<id>.body.<ext>`. This is the additive case again: an older build would drop the key and, on its next
save, delete the example files as unmanaged. So it bumps the version, and an older build refuses a project this build
has saved. The 6 → 7 migration is a stamp; a file with no `examples` reads as it did. The loader opens an example's
body only from its own request's `<slug>.examples/` directory, named from the request's slug and the example's id,
so a hand-edited path cannot point elsewhere. Save treats the `<id>.body.<ext>` files in that directory as managed,
so renaming a request moves its examples and removing an example removes its file.

**Update (2026-10-08, mock services): `formatVersion` stays `7`; `mocks/` carries its own `version`.** Mock
services (#59, [ADR-0021](0021-mock-stubs-are-files-under-mocks.md)) are a new file kind in a new top-level folder,
`mocks/<slug>/`, with `mock.yaml`, `operations/<slug>/operation.yaml`, one `<slug>.response.yaml` per stub and its
body beside it. This is the sequences case again: no build before this one reads `mocks/` or counts a file there as
managed, so an older build opens the project, shows no mocks, and leaves the folder byte for byte. `mock.yaml` carries
`kind: mock` and `version: 1`, and a change to the shape of any mock file bumps that version rather than the project's.
