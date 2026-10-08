# Plan: Mock recording proxy

Spec: [`docs/specs/2026-10-08-mock-recording-design.md`](../specs/2026-10-08-mock-recording-design.md)
Issue: [#60](https://github.com/wirebench/wirebench/issues/60)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- `startRecorder` passes traffic through to a real system and keeps each routed response as a masked stub.
- `addRecordedStubs` adds those stubs to a mock.
- `wirebench mock record` runs a recording and saves the stubs.

**Architecture:**
- `packages/engine/src/mock/record.ts` holds the proxy.
- `packages/engine/src/mock/record-stubs.ts` holds `addRecordedStubs`, the pure merge.
- Both are core. They reach the protocols only through `openMockContract`, so no new
  `check:engine-layers` exception is needed.
- The listener helpers in `mock/server.ts` move to an internal `mock/http.ts`, which both the server and the
  recorder import.
- The CLI command is `packages/cli/src/commands/mock-record.ts`, with its arguments in
  `packages/cli/src/args-mock-record.ts`.

**Tech stack:** TypeScript (ESM, `.js` suffixes), vitest, `node:http`, `sendHttp` (undici).

## Global constraints

- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check`.
  Run `pnpm test:perf` before the push.
- No local Electron windows. Run focused tests with `nice pnpm --filter <pkg> exec vitest run <file>`.
- **Commits:** one per task once the gate is green. Author them as Mohammed Naami <m.naami@outlook.com>,
  with no `Co-Authored-By:` or `Claude-Session:` trailer.
- Never name the product that inspired a feature (`pnpm check:banned-terms`). Add no new dependencies.
- Change nothing in the ADR-0021 file shape, and leave `FORMAT_VERSION` alone.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/mock/http.ts` | new: the listener helpers, moved out of `server.ts` |
| `packages/engine/src/mock/server.ts` | imports them |
| `packages/engine/src/mock/record.ts` | new: `startRecorder`, `RunningRecorder`, `RecordExchangeEvent`, `MockRecording`, masking |
| `packages/engine/src/mock/record-stubs.ts` | new: `addRecordedStubs` |
| `packages/engine/src/mock/index.ts`, `packages/engine/src/index.ts` | exports |
| `packages/engine/test/unit/mock/record.test.ts`, `record-stubs.test.ts` | new |
| `packages/engine/test/unit/rest/mock-record.test.ts` | new: round trip with the REST facet |
| `packages/cli/src/args-mock-record.ts`, `args.ts`, `main.ts` | the `mock record` verb |
| `packages/cli/src/commands/mock-record.ts` | new |
| `packages/cli/test/…/mock-record.test.ts` | new |
| `docs/cli.md`, `docs/security.md`, `docs/roadmap.md`, `CHANGELOG.md` | docs |

---

### Task 1: Spec and plan

- [ ] Write this spec and plan.
- [ ] Gate, then commit `docs: mock recording proxy spec and plan (#60)`.

### Task 2: `addRecordedStubs`

- [ ] Test first (`record-stubs.test.ts`):
  - a new operation with its default;
  - `Recorded <status>` names, unique, and their slugs;
  - order after the existing responses;
  - dedupe against existing responses and within one call, and `dedupe: false`;
  - `replace`;
  - the responses, operations and bodies limits;
  - the input mock is not mutated.
- [ ] Implement it in `record-stubs.ts` and export it.
- [ ] Gate, then commit `feat(engine): add recorded stubs to a mock (#60)`.

### Task 3: The recording proxy

- [ ] Move the listener helpers into `mock/http.ts`: `hostnameOf`, `isLoopback`, `urlHost`, `headerPairs`,
  `queryOf`, `maskedUrl`, `cut`, `write`, `plain` and `readBody`. `server.ts` imports them, with no change
  in behaviour.
- [ ] Test first (`record.test.ts`, with a fake facet and a local upstream):
  - path mapping and the 404 outside the mock's path;
  - forwarded and relayed headers;
  - a gzip relay;
  - 502, 504 and 501;
  - the host check;
  - a definition request and an unrouted request, not recorded;
  - binary and oversized bodies;
  - masking of headers, of XML (`wsse:Password`), JSON and form bodies, and of `secrets`;
  - the charset rewrite;
  - an invalid target;
  - `stop()`.
- [ ] Implement `record.ts` and export it.
- [ ] Gate, then commit `feat(engine): mock recording proxy (#60)`.

### Task 4: Round trip with the REST facet

- [ ] `rest/mock-record.test.ts`: a cached OpenAPI fixture and an upstream. Record two requests, add the
  stubs, `saveProject`, `loadProject`, then `startMock` returns the recorded bodies in sequence.
- [ ] Gate, then commit `test(engine): record then replay a REST mock (#60)`.

### Task 5: `wirebench mock record`

- [ ] Arguments: `mock record <path> <mock> --target …`, with usage errors.
- [ ] The command:
  - find the mock, or generate one with `--from`;
  - the proxy from the environment, `--insecure`, and the `WIREBENCH_SECRET_*` values as `secrets`;
  - one line per exchange;
  - stop on the `AbortSignal` or SIGINT, then add the stubs and save.
- [ ] Tests run in-process, with an upstream and an `AbortSignal`.
- [ ] Gate, then commit `feat(cli): wirebench mock record (#60)`.

### Task 6: Docs

- [ ] The CLI reference, the "Mock recording" subsection of `docs/security.md`, roadmap item 11 and the
  changelog.
- [ ] Gate, then commit `docs: mock recording proxy (#60)`.
