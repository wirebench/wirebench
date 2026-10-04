# Plan: Snapshot report hardening

Spec: `docs/specs/2026-10-03-wirebench-snapshot-report-hardening-design.md` (issue #219).

**Goal:** Stop a report cap from leaving a secret's prefix unmasked, and make the golden sidecar read
open the file without following a link.

**Architecture:** `createSecretMasker` (`packages/engine/src/redact/literal.ts`) gets one more pass,
after whole needles: it masks a needle prefix that ends at a `…` cut. `readGoldenFile`
(`packages/engine/src/snapshot/golden-file.ts`) opens the sidecar with `O_NOFOLLOW` where the
platform has it, checks that the handle is the file `lstat` saw, and reads from that handle.

## Global constraints

- Only the engine changes. The CLI, the desktop and the report shapes stay as they are.
- `@wirebench/engine/snapshot` stays free of `node:*` imports.
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` passes before every commit. Make one commit per task,
  with a subject ending `(#219)`. Don't add a `Co-Authored-By` or `Claude-Session` trailer, and
  don't run e2e locally.

## Task 1: Cut-aware masker

Files: `packages/engine/src/redact/literal.ts`, `packages/engine/test/unit/redact/literal.test.ts`.

- [ ] Write the failing tests first. The spec's Testing section lists the masker cases: a
      `truncateValue` cut; `diffSnapshot` JSON, XML-attribute and text values; `\n… truncated`;
      a trailing U+FFFD; `…"`; a cut `Basic` credential; and the no-over-reach cases.
- [ ] Implement it. Keep the needle list (longest first) and the plain values. After the whole-needle
      pass, scan each `…`. Find the cut point (step back over one `\n`, then over U+FFFD). Replace the
      longest proper needle prefix that ends there. A `Basic <base64>` run that ends at a cut point
      is replaced whole.
- [ ] Run `pnpm check`, then commit: `fix(engine): mask a secret's prefix left before a report cut (#219)`.

## Task 2: Golden read through one handle

Files: `packages/engine/src/snapshot/golden-file.ts`, `packages/engine/test/unit/snapshot/golden-file.test.ts`.

- [ ] Write the failing tests first:
  - Race: a mocked `lstat` sees a regular file while the path is already a link to a file
    outside the project. The result is `not-a-file`.
  - A different `ino` on the handle gives `not-a-file`.
  - A FIFO does not hang (POSIX only).
- [ ] Implement it: `lstat`, then `open` with
      `O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0)`. Map `ELOOP` to `not-a-file` and `ENOENT`
      to `none`. On the handle, `stat` must be a regular file with the same `dev`/`ino`. Read with
      `handle.readFile('utf8')` and close the handle in `finally`.
- [ ] Run `pnpm check`, then commit: `fix(engine): read the golden sidecar through one no-follow handle (#219)`.

## Task 3: Run-level proof

Files: `packages/engine/test/integration/run/run.test.ts`.

- [ ] Add a `--baseline` run whose changed JSON value carries a secret starting at character 195.
      Pass the result through `createSecretMasker`, the way the CLI masks reports. The masked
      `baseline.changes` and the assertion message contain no prefix of the secret longer than
      zero characters.
- [ ] Run `pnpm check`, then commit: `test(engine): a baseline report hides a cut secret (#219)`.
