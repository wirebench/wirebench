# Snapshot report hardening — design

**Date:** 2026-10-03
**Status:** Draft
**Scope:** Engine secret masker and golden reader; no CLI flag, report field or UI change.

Issue: [#219](https://github.com/wirebench/wirebench/issues/219).
Builds on: `2026-10-03-wirebench-runner-baseline-design.md` (#36), `2026-09-22-snapshot-regression-design.md` (#34).

## Goal

Close two gaps that `wirebench run --baseline` exposes in CI:

1. A secret cut short by a report cap must not show its first characters.
2. The golden sidecar must be read without following a symbolic link swapped in after the check.

## Decisions (owner, 2026-10-03)

1. **The masker learns about cuts; the engine keeps capping raw text.** The engine reports raw
   values and the host masks them. That split stays. `createSecretMasker` also masks the start of a
   secret that sits right before a cut marker. Every capped value then gets the fix at once: snapshot
   diff values, the baseline assertion message, header and callback assertion actuals, and capped
   exchanges. Patching only `diffSnapshot` would leave those other caps open.
2. **Over-masking right before a cut is accepted.** If the last characters before a `…` happen to
   match the start of a secret, they are masked. A few hidden characters cost less than a leaked
   prefix.

## Background

### Where a cut happens before the mask

| Cap | Where | Marker |
| --- | --- | --- |
| Snapshot change value, 200 chars | `snapshot/format.ts` `truncateValue` (used by the JSON, XML and text diffs) | `…` |
| Header assertion actual, 200 chars | `assert/header.ts` | `…` |
| Callback assertion actual | `assert/callback.ts` | `…` then the closing `"` of `JSON.stringify` |
| Failed exchange, per side | `run/run.ts` `capped` | `\n… truncated` |

The CLI masks results later, in `createMaskedReporters` (`cli/src/reporters/mask.ts`) with
`createSecretMasker([...secrets, ...tokens])`. The masker replaces whole needles: each value and its
encoded forms. A value cut at character 199 no longer contains any whole needle, so its prefix
survives. Example: `changed /token: abc… → s3cr…`, where `s3cr` is the start of the secret
`s3cret-value`.

The `history` op (`cli/src/ops/history.ts`) and the desktop Snapshot tab are not affected. `history`
diffs bodies that were already redacted, and the desktop shows the user's own data locally.

### The golden read race

`readGoldenFile` (`snapshot/golden-file.ts`) calls `lstat(file)`, refuses anything that is not a
regular file, and then calls `readFile(file)` by path. A link put at that path between the two calls
is followed, so the read can return any file the process can open, such as one outside the project.
That content becomes the golden, and its text can appear in diff values. Both the runner and the
desktop store read goldens through this function.

## Design

### 1. Cut-aware masking (`redact/literal.ts`)

`createSecretMasker(values)` keeps its current pass: Basic credentials, then every needle, longest
first. Then it runs one more pass:

- **Cut marker.** Each `…` (U+2026) in the text.
- **Cut point.** The position just before the marker. From there, step back over one optional `\n`
  (the exchange cap writes `\n… truncated`), then over any trailing U+FFFD characters (a byte cap
  can split a multi-byte character).
- **Rule.** Find the longest needle prefix, at least one character long and shorter than the
  needle, that the text ends with at the cut point. Replace it with `REDACTED_MARKER`. Leave the
  marker and everything after it unchanged.
- **Needles.** The same set as the first pass: each value and its encoded forms (percent, form, XML,
  JSON). A JSON-diff value is `JSON.stringify` output, and an XML value can hold entities, so the cut
  may fall inside an encoded form.
- **Basic credential.** If a `Basic <base64>` run ends right at a cut point, its base64 is replaced
  whole. It is cut, so it cannot be decoded and checked, and it is a credential either way.
- **Order.** Full needles are masked first. Text before a cut can then end in `REDACTED_MARKER`
  itself, which is never a needle prefix, so the extra pass changes nothing there.

Cost: one scan for `…` per string. For each cut, a check of each needle's prefixes, up to the needle
length minus one. Needles are short (secrets and tokens) and cuts are rare, so this is negligible
next to the existing `split`/`join` pass.

`createSecretBytesMasker` (base64 frames) is out of scope: frames are not capped before masking.

### 2. Golden read through one handle (`snapshot/golden-file.ts`)

Replace the path-based `lstat` + `readFile` pair with these steps:

1. `lstat(file)`. Return `none` on ENOENT. Return `unreadable / not-a-file` if it is not a regular
   file. No change from today.
2. `open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, using each flag only where `fs.constants`
   defines it. Windows defines neither `O_NOFOLLOW` nor `O_NONBLOCK`.
   - `ELOOP`: a link was swapped in, so return `unreadable / not-a-file`.
   - `ENOENT`: the file vanished, so return `none`.
   - `O_NONBLOCK` stops a FIFO swapped in at the path from blocking the open.
3. `handle.stat()`. It must be a regular file, and its `dev` and `ino` must equal the `lstat`
   result's. Otherwise return `unreadable / not-a-file`. On Windows, where `O_NOFOLLOW` is
   unavailable, this identity check is the guard: a followed link opens a different file.
4. `handle.readFile('utf8')`, then parse as today. Close the handle in `finally`.

The parent folder is still resolved through `realpathOfPrefix` and checked with `isInside`. Only the
sidecar's own name was racy. Swapping a parent folder for a link after the realpath check is out of
scope, as the issue states. The function signature and the `GoldenRead` shape stay the same.

The desktop store's write path (`apps/desktop/src/main/snapshot-store.ts`, `kindOf`) is not
changed. It refuses non-files before a write and replaces the file by `rename`, which does not
follow a link at the destination.

## Testing

Unit, `packages/engine/test/unit/redact/literal.test.ts`:

- A secret cut by `truncateValue` (`'x'.repeat(190) + secret`, truncated) loses its prefix:
  the result ends with `<redacted>…`.
- The same through `diffSnapshot` for a JSON value, an XML attribute and a text body, with the change
  values passed through the masker. The JSON case holds a secret with a `"` to exercise the escaped
  form.
- The exchange shape: a prefix before `\n… truncated` is masked, and so is a prefix followed by
  U+FFFD.
- The callback shape: a prefix before `…"` is masked.
- A cut `Basic dXNlcjpw…` is masked whole.
- No over-reach: text before a `…` that matches no needle prefix is unchanged. A whole needle followed
  by `…` is masked once. A needle prefix not followed by `…` is unchanged.

Unit, `packages/engine/test/unit/snapshot/golden-file.test.ts`:

- A link in place of the sidecar is still `not-a-file`. This is the existing case and stays.
- Race: mock `lstat` to report the original regular file, then swap the path for a link to a file
  outside the project before `open`. The result is `not-a-file` and the outside content is never
  returned. On POSIX the open fails with `ELOOP`.
- Identity: mock the handle's `stat` to return a different `ino`. The result is `not-a-file`. This is
  the path Windows takes.
- A FIFO at the sidecar path does not hang (POSIX only, skipped on Windows).
- Present, malformed and missing goldens behave as today.

Integration, `packages/engine/test/integration/run/run.test.ts`: a `--baseline` run whose golden
holds a long body with a secret at character 195, with the response changed so the value is
reported. The JSON report and the JUnit message contain no prefix of the secret.

## Done when

- [ ] No prefix of a secret value, in any encoded form, survives in a value cut by a report cap.
- [ ] `readGoldenFile` opens the sidecar without following a link, and checks and reads the same
      handle.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check` passes.

## Not in scope

- Raising, lowering or moving any cap.
- Masking in the desktop Snapshot tab (local display, no masker).
- The snapshot store's write path, and parent-folder swaps after the realpath check.
- `createSecretBytesMasker`.
