---
title: Project folder format
description: The on-disk layout of a Wirebench project and workspace, and the project format version.
---

A project is a **folder**, not one file. Every file inside it is UTF-8 text with a stable key
order, and each file holds exactly one concept — a manifest, an interface, one request. That is
deliberate: two people editing different requests touch different files, a one-line change
produces a one-line diff, and the folder can be reviewed, grepped and diffed without Wirebench
installed.

## Project layout

```
my-service/
  wirebench.yaml              # manifest: id, name, settings, properties, environments
  environments/dev.yaml       # endpoints + properties for one environment
  interfaces/<Interface>/
    interface.yaml            # definitionUrl, cache, soapVersion, endpoints, auth (refs only)
    definition/                # the fetched WSDL/XSD, byte-exact, plus manifest.yaml (url → file, sha256)
    operations/<Operation>/
      <Request>.request.yaml  # endpointRef, headers, attachments, auth, WS-Addressing, properties
      <Request>.xml           # the SOAP envelope, exactly as edited
  apis/<Api>/
    api.yaml                  # kind: rest, baseUrl, auth (refs only), settings, definition ref
    definition/                # the imported OpenAPI document, byte-exact, plus manifest.yaml
    requests/
      <Request>.request.yaml  # kind: rest, method, url, path params, query, headers, body, auth
      <Request>.body.json     # a raw body, in a file of its own language (.json/.xml/.txt/…)
      <Request>.golden.yaml   # the request's snapshot, when one is saved (SOAP requests have one too)
      <Folder>/folder.yaml    # a folder's own name, order and inherited auth
  wss/…                       # outgoing/incoming WS-Security configs and keystore entries (no secrets)
  attachments/                 # content-addressed by sha256
```

A SOAP envelope is a plain `.xml` file, never a string embedded in YAML, so it edits and diffs as
XML. A REST body is the same idea: it lives beside its request as `<Request>.body.json` (or
`.xml`/`.txt`, matching its content) rather than as a YAML string.

Every name that ends up on disk — an interface name, a request name, a folder name — comes from
something you typed, so it goes through path-safety rules before it is written: characters
illegal on any supported OS are stripped, and a name cannot escape the project folder.

## File kinds

| File | Holds |
| --- | --- |
| `wirebench.yaml` | The project manifest: `id`, `name`, `settings` (timeouts, caching, pretty-printing), `properties`, which of them are disabled, and the active environment |
| `environments/<slug>.yaml` | One environment's endpoint overrides and properties |
| `interfaces/<Interface>/interface.yaml` | A SOAP interface: its WSDL/XSD reference, endpoints, WS-Addressing policy and auth (a reference, never a credential) |
| `apis/<Api>/api.yaml` | A REST API: its OpenAPI reference, base URL, settings and auth reference |
| `<Request>.request.yaml` + `<Request>.xml` (SOAP) or `<Request>.body.json` (REST) | One saved request: metadata in YAML, the payload in a file of its own kind |
| `<Request>.golden.yaml` | A request's snapshot: the golden response body, its content type, when it was saved and the ignore rules. It sits beside the request's own file, outside the project model, so an older build leaves it alone and it needs no format-version change. Renaming or moving the request leaves it behind. See [Snapshot regression](/wirebench/guides/snapshot-regression/) |
| `definition/` | The fetched or imported API definition (WSDL, XSD, OpenAPI), kept byte-exact, plus a manifest mapping each URL to its cached file and checksum |
| `wss/` | WS-Security configuration and keystore entries — no secret values |
| `attachments/` | Files attached to a request, stored by content hash |

A credential is never written into a project file. Auth fields carry a `secretRef` that points
into the OS keychain instead; a project file that somehow contained a plaintext `password`,
`token` or similar key is refused rather than saved.

## Workspace layout

A workspace groups several projects under one set of environments. It normally lives entirely
inside Wirebench's app data folder (see [Install and first
run](/wirebench/getting-started/installation/) for the exact path per OS):

```
workspaces/<id>/
  workspace.yaml             # id, name, properties, project references
  environments/<slug>.yaml   # one file per workspace environment: properties + endpoint overrides
  projects/<slug>/           # internal projects — ordinary project folders, unchanged format
  local.yaml                  # machine-local state (active environment); never shared or synced
  share.yaml                  # present only for a shared workspace: git remote/branch or a synced folder path
```

A project inside a workspace is byte-for-byte the same folder described above — the workspace only
adds files around it. A project can also be **linked**: an external folder the workspace reads and
writes in place instead of copying in, which is how a project meets git when you want version
control. `local.yaml` and `share.yaml` are never part of what a shared workspace syncs to
teammates.

## Format version

Each project file's `formatVersion` is a commitment: an additive field is a breaking change here,
because an unknown key is dropped on load and would otherwise be silently lost the next time an
older build saves the file. Any format change — added, changed or removed — bumps the version and
ships a migration; opening a project from a newer version fails with a clear error instead of
guessing:

> Project was created by a newer version of Wirebench (format N, this build supports M)

The project format is currently **version 3**:

1. **Version 1** — the original layout described above, without APIs or per-variable disabling.
2. **Version 2** — every property scope gained a per-variable `disabled` list, so a variable can be
   switched off without deleting it. Omitted when empty; a version-1 file migrates as "all
   enabled".
3. **Version 3** — projects can hold REST APIs beside interfaces, in the `apis/` tree shown above.
   A version-1 or version-2 project opens unchanged and is rewritten at version 3 on its next save.

A workspace manifest has its own, independent format version (`WORKSPACE_FORMAT_VERSION`, currently
3), versioned and migrated the same way, with the same "created by a newer version" error when a
workspace's format is ahead of what the build understands.

Migration only ever moves forward: a build cannot open a project or workspace written by a newer
build, even if nothing it actually uses has changed.
