# ADR-0003: A project is a folder of small YAML and XML files, `formatVersion: 1`

- Status: accepted
- Date: 2026-09-09
- Context: spec §7 (data model and project format), §13 SC10, §17 (decision log)

## Context

SoapUI keeps a project in one large XML file. That file is the thing teams actually fight
with: two people editing different requests produce a conflict in the same document, a
one-character change produces an unreadable diff, and the file is where credentials end up.

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
- `formatVersion` is a commitment. Adding fields is free; changing or removing them costs a
  migration.
