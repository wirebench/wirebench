# ADR-0025: The SFTP local pane reads and writes any local path

- Status: accepted
- Date: 2026-10-13
- Context: issue #357 (ruling R5), #445; `docs/specs/2026-10-12-ssh-sftp-design.md` (D2, D9);
  [ADR-0005](0005-renderer-path-safety.md); [ADR-0021](0021-a-desktop-area-is-a-module-behind-one-interface.md).

## Context

[ADR-0005](0005-renderer-path-safety.md) makes main distrust every path the renderer names. A path is
usable only if it lies inside a folder the app owns (the open project and its caches, through
`path-containment.ts`) or the user picked that exact path in a native dialog during the session
(`dialog-picks.ts`). The two are joined in `path-access.ts`, and every file channel asks it.

The SSH area's Files tab puts this machine in one pane and a host in the other. Its local pane is a
file manager: the user browses to a folder, drags files to the host, and downloads into whatever
folder they are looking at. Neither half of ADR-0005 fits that:

- **Containment** would confine the pane to the project folder. Files moved to and from servers
  (logs, dumps, builds, certificates) almost never live there, and a Files tab can be open with no
  project at all.
- **Dialog evidence** would mean an OS folder picker before every folder the pane opens, or a list of
  granted folders the user keeps by hand. Files dropped from the OS file manager carry no main-side
  evidence at all; the preload only turns a `File` into its path (`webUtils.getPathForFile`).

The design offered granted folders as the recommendation. The owner ruled against it (R5,
2026-10-12): the local pane browses the whole disk, as a desktop file manager does.

## Decision

- **The `sftp.*` channels use a local path as given.** `sftp.list`, `sftp.mkdir`, `sftp.rename`,
  `sftp.remove` and `sftp.copy` with a `{ kind: 'local' }` place, and `sftp.localHome`, act through
  `node:fs/promises` on the path the renderer sent, without `path-access.ts`. They reach anything the
  OS user can read and write. Errors are `local-fs-failed` with the `errno` code.
- **Scoped to these channels.** No other channel changes. `DialogPicks`, project containment and
  every file channel outside `sftp.*` keep ADR-0005 as it is.
- **Gone with the area switch.** The channels are registered only while the SSH area is on
  ([ADR-0021](0021-a-desktop-area-is-a-module-behind-one-interface.md)). With
  `WIREBENCH_AREAS=ssh=off` none of them exists in main, so neither does the exception
  (`packages/host/test/areas-switch.test.ts`).
- **Remote names never pick a local path.** A download writes to `join(targetDir, name)` only after
  `safeLocalName` refuses `''`, `.`, `..` and names holding `/`, `\` or NUL (`sftp-failed` with
  `details.reason: 'unsafe-name'`). The local folder comes from the user's browsing; a server cannot
  steer a write outside it.
- **Edit copies stay in the app's data folder.** Editing in the system editor downloads to
  `userData/sftp-edit/<random>/` (mode `0700`), not to a renderer-named path, and the copies are
  removed when the edit ends and at start-up.

## Consequences

- The Files tab works like a file manager: any folder, OS drops onto a host's pane, downloads into
  the folder shown. No grant list to keep, and no picker per folder.
- **The cost.** A compromised renderer (a script injection that gets past the CSP and the sandbox)
  could list, overwrite or delete any file the user can, and upload a local file to a host the
  workspace already trusts. ADR-0005 alone would have kept it to the project folder and the user's
  picks.
- **What limits it.**
  - The access is only on the `sftp.*` channels, and only while the SSH area is on: an operator who
    does not want it sets `WIREBENCH_AREAS=ssh=off`.
  - An upload goes only to a host whose key the user trusted by a click; the renderer cannot add a
    host key or read a credential.
  - A window acts only on its own SFTP sessions, transfers and edits.
  - No channel returns a file's content to the renderer: listings carry names, sizes, times and
    modes, and transfer events carry names, sizes and states. Reading a file means sending it to a
    host.
- A later feature that wants wider local access argues for it in its own ADR; this one is not a
  precedent for loosening ADR-0005 elsewhere.
