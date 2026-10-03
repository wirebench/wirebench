# Plan: MCP baseline check on send

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/specs/2026-10-03-wirebench-mcp-baseline-design.md` (issue #218). Builds on
`docs/specs/2026-10-03-wirebench-runner-baseline-design.md` (#36) and
`docs/specs/2026-09-29-wirebench-mcp-server-design.md` (#32).

**Goal:** `send` (MCP tool and `wirebench send`) takes `baseline: true` and compares the response with
the request's committed golden, returning the masked differences; a difference fails the send.

**Architecture:** No engine change. `sendAndRecord` (`packages/cli/src/ops/send.ts`) passes an optional
`RunOptions.baseline` to `runRequests`; the engine already runs `checkBaseline`, appends the synthetic
`baseline` assertion and sets `RequestResult.baseline`. The op masks that field and assertion with the
send's secret masker and copies the field onto `SendResult`. The CLI verb maps `--baseline` to the
input and prints the `missing` / `unsupported` line.

**Tech Stack:** TypeScript on Node 24, zod 4, Vitest, `@modelcontextprotocol/sdk`, pnpm workspaces.

## Global Constraints

- No engine or desktop change. Use the engine's exported `readGoldenFile`, `BaselineReport`, `RunOptions`, `SelectedRequest`.
- `baseline` defaults to off: without it, `send` returns exactly what it returns today and reads no golden.
- The golden source is always `require: false`. A missing golden is `baseline.status: 'missing'`, nothing else.
- The golden is the saved request's (`item.request.id`), with or without a body override.
- Every string from the comparison passes through the send's `mask` before it leaves the op.
- `baseline` is already a `run` option in `packages/cli/src/args.ts`. **Do not** add it to `OP_OPTIONS`
  (`args-ops.ts`): every key there becomes an op-only flag that `run` refuses (the existing
  `describe('run --baseline')` tests in `test/unit/args.test.ts` would fail). Add it to `VERB_FLAGS.send` only.
- Gate before every commit: `WIREBENCH_SKIP_PERF=1 pnpm check`. One commit per task. Commits as
  Mohammed Naami; no `Co-Authored-By` or `Claude-Session` trailer.
- `pnpm check:banned-terms` must pass: never name another product.
- Run tests quietly: `nice pnpm --filter @wirebench/cli exec vitest run <file>`; no Electron windows.

---

### Task 1: `send` compares with the golden

**Files:**
- Modify: `packages/cli/src/ops/send.ts`
- Modify: `packages/cli/test/unit/ops/helpers.ts` (add `writeGolden`)
- Test: `packages/cli/test/unit/ops/send.test.ts` (new `describe('op send with baseline')`, one test in the WebSocket describe)

**Interfaces:**
- Produces: `SendResult.baseline?: BaselineReport`; op input `baseline?: boolean`;
  `SendAndRecordInput.baseline?: RunOptions['baseline']`; test helper
  `writeGolden(dir: string, item: string, golden: { body: string; ignore?: readonly string[]; contentType?: string }): Promise<string>`
  (returns the sidecar path).

- [ ] **Step 1: Add the test helper** to `packages/cli/test/unit/ops/helpers.ts`. Add `requestFileLocation`
  to its `@wirebench/engine` import.

```ts
/**
 * Writes the golden sidecar the desktop's Snapshot tab would save beside the saved request at `item`
 * (its path as `operations` lists it). JSON is YAML, so no YAML dependency is needed here.
 *
 * @returns the sidecar's path
 */
export async function writeGolden(
  dir: string,
  item: string,
  golden: { readonly body: string; readonly ignore?: readonly string[]; readonly contentType?: string },
): Promise<string> {
  const { project } = await loadProject(dir);
  const found = selectRequests(project, []).selected.find((selected) => selected.path === item);
  if (found === undefined) {
    throw new Error(`no request at ${item}`);
  }
  const location = requestFileLocation(project, found.request.id);
  if (location === undefined) {
    throw new Error(`no file location for ${item}`);
  }
  const file = join(dir, ...location.dir.split('/'), `${location.slug}.golden.yaml`);
  await writeFile(
    file,
    JSON.stringify({
      savedAt: '2026-10-03T10:00:00.000Z',
      ignore: golden.ignore ?? [],
      body: golden.body,
      ...(golden.contentType !== undefined ? { contentType: golden.contentType } : {}),
    }),
  );
  return file;
}
```

- [ ] **Step 2: Write the failing tests.** In `send.test.ts`, add `writeGolden` to the helpers import
  and `rm`, `symlink` to the `node:fs/promises` import. Add this describe before the WebSocket one:

```ts
describe('op send with baseline', () => {
  /** The REST fixture's GET /pets, served by a stub that answers `body` as JSON. */
  async function petsSend(body: unknown): Promise<{ fixture: Awaited<ReturnType<typeof restProject>>; item: string }> {
    const fixture = await restProject();
    const pets = await server(() => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    return { fixture, item: await restItem(fixture.dir, 'GET', '/pets') };
  }

  it('reports a match, counting what the ignore rules hid', async () => {
    const { fixture, item } = await petsSend({ ok: true, at: '2026-10-03' });
    await writeGolden(fixture.dir, item, { body: '{"ok": true, "at": "2026-01-01"}', ignore: ['/at'] });

    const result = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());

    expect(result.outcome).toBe('passed');
    expect(result.baseline).toMatchObject({ status: 'matched', format: 'json', ignored: 1 });
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ type: 'baseline', outcome: 'passed', label: 'matches the baseline (1 ignored)' }),
    );
  });

  it('fails on a difference, listing kind, path, expected and actual', async () => {
    const { fixture, item } = await petsSend({ ok: true });
    await writeGolden(fixture.dir, item, { body: '{"ok": false}' });

    const result = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());

    expect(result.outcome).toBe('failed');
    expect(result.baseline).toMatchObject({
      status: 'differs',
      changes: [{ kind: 'changed', path: '/ok', expected: 'false', actual: 'true' }],
    });
    expect(result.baseline?.truncated).toBeUndefined();
    expect(result.assertions).toContainEqual(
      expect.objectContaining({ type: 'baseline', outcome: 'failed', label: '1 difference from the baseline' }),
    );
  });

  it('keeps the first 100 changes and says more were cut', async () => {
    const { fixture, item } = await petsSend(Array.from({ length: 101 }, (_, n) => n + 1));
    await writeGolden(fixture.dir, item, { body: JSON.stringify(Array.from({ length: 101 }, (_, n) => n)) });

    const result = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());

    expect(result.baseline?.status).toBe('differs');
    expect(result.baseline?.changes).toHaveLength(100);
    expect(result.baseline?.truncated).toBe(true);
  });

  it('reports a missing golden without failing the send', async () => {
    const { fixture, item } = await petsSend({ ok: true });

    const result = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());

    expect(result.outcome).toBe('passed');
    expect(result.baseline).toEqual({ status: 'missing' });
    expect(result.assertions.some((assertion) => assertion.type === 'baseline')).toBe(false);
  });

  it('errors on a golden that is a symbolic link, and on one too large to compare', async () => {
    const { fixture, item } = await petsSend({ ok: true });
    const file = await writeGolden(fixture.dir, item, { body: '{}' });
    const elsewhere = join(fixture.dir, 'elsewhere.yaml');
    await writeFile(elsewhere, await readFile(file, 'utf8'));
    await rm(file);
    await symlink(elsewhere, file);

    const linked = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());
    expect(linked.outcome).toBe('errored');
    expect(linked.baseline?.status).toBe('unreadable');

    await rm(file);
    await writeGolden(fixture.dir, item, { body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    const large = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());
    expect(large.outcome).toBe('errored');
    expect(large.baseline?.status).toBe('too-large');
  });

  it("compares a body override's response with the saved request's golden", async () => {
    const { fixture, item } = await petsSend({ ok: true });
    await writeGolden(fixture.dir, item, { body: '{"ok": true}' });

    const result = await runOp(
      sendOp,
      { item, environment: 'local', body: '{"changed": 1}', baseline: true },
      fixture.base(),
    );

    expect(result.baseline?.status).toBe('matched');
  });

  it('reads no golden and adds no field without the flag', async () => {
    const { fixture, item } = await petsSend({ ok: true });
    await writeGolden(fixture.dir, item, { body: '{"ok": false}' });

    const result = await runOp(sendOp, { item, environment: 'local' }, fixture.base());

    expect(result.outcome).toBe('passed');
    expect(result).not.toHaveProperty('baseline');
  });
});
```

  In the `op send on a WebSocket request` describe, add:

```ts
  it('reports a WebSocket request as not compared', async () => {
    const echo = await startTestWsServer();
    sockets.push(echo);
    const fixture = await wsProject(echo.url);

    const result = await runOp(
      sendOp,
      { item: 'Chat/Echo', baseline: true },
      fixture.base({ env: { WIREBENCH_SECRET_WSKEY: SECRET } }),
    );

    expect(result.outcome).toBe('passed');
    expect(result.baseline).toEqual({ status: 'unsupported' });
  });
```

- [ ] **Step 3: Run them and see them fail**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops/send.test.ts`
Expected: the new tests FAIL (`result.baseline` is undefined; zod strips or refuses the unknown key).

- [ ] **Step 4: Implement** in `packages/cli/src/ops/send.ts`.

  Imports: add `readGoldenFile` to the `@wirebench/engine` value import; add `BaselineReport`,
  `RunOptions` and `SelectedRequest` to the type import.

  `SendResult`, after `assertions`:

```ts
  /** `baseline: true` only: the comparison with the golden saved beside the request, masked (#218). */
  readonly baseline?: BaselineReport;
```

  The input schema, after `body`:

```ts
  baseline: z
    .boolean()
    .optional()
    .describe(
      'Also compare the response body with the golden saved beside the request (<slug>.golden.yaml), ' +
        "by meaning, honouring the golden's ignore rules. A difference fails the send.",
    ),
```

  `SendAndRecordInput`, after `adHoc`:

```ts
  /** `send`'s golden comparison (#218); a contract tool's call never sets it. */
  readonly baseline?: RunOptions['baseline'];
```

  In `sendAndRecord`, the `runRequests` options:

```ts
    const run = await runRequests([item], runContext, {
      ...(input.captures !== undefined ? { captures: input.captures } : {}),
      ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
      onSent: (_item, sent) => {
        seen.sent = sent;
      },
    });
```

  In `commonOf`, add `'baseline'` to the `Pick` and, after `assertions`:

```ts
    ...(result.baseline !== undefined ? { baseline: result.baseline } : {}),
```

  In `sendOp.run`, pass the source to `sendAndRecord` after `captures: captures.source,`. Under a body
  override the item keeps the saved request's id, so the saved request's golden is read:

```ts
        ...(value.baseline === true
          ? {
              baseline: {
                source: (selected: SelectedRequest) =>
                  readGoldenFile(context.projectDir, opened.project, selected.request.id),
                require: false,
              },
            }
          : {}),
```

  Append to `sendOp.description`:
  `' With baseline: true it also compares the response with the golden saved beside the request: a difference fails the send, and a request with no golden reports baseline status missing.'`

- [ ] **Step 5: Run the tests and see them pass**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops/send.test.ts`
Expected: PASS. If a change path or a label differs from the test, read
`packages/engine/src/run/baseline.ts` and `snapshot/diff.ts` and fix the test, never the engine.

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/cli/src/ops/send.ts packages/cli/test/unit/ops/helpers.ts packages/cli/test/unit/ops/send.test.ts
git commit -m "feat(cli): send compares the response with its golden on baseline: true (#218)"
```

---

### Task 2: Mask the comparison, keep assertion pairing

**Files:**
- Modify: `packages/cli/src/ops/send.ts`
- Modify: `packages/cli/src/ops/redact.ts` (`redactAssertions`)
- Test: `packages/cli/test/unit/ops/send.test.ts`, `packages/cli/test/unit/mcp/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `SendResult.baseline`, `writeGolden`, and `petsSend` in the `op send with baseline` describe.
- Produces: module-private `maskedBaseline(result: RequestResult, mask: (text: string) => string): RequestResult`.

- [ ] **Step 1: Write the failing tests** in the `op send with baseline` describe:

```ts
  it('masks a secret the response echoes, in the changes and in the assertion message', async () => {
    const fixture = await restProject();
    const pets = await server((request) => ({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: request.headers['x-api-key'] }),
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      headers: [...request.headers, { name: 'X-Api-Key', value: '${secret:petsKey}', enabled: true }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');
    await writeGolden(fixture.dir, item, { body: '{"key": "old"}' });

    const result = await runOp(
      sendOp,
      { item, environment: 'local', baseline: true },
      fixture.base({ env: { WIREBENCH_SECRET_PETSKEY: SECRET } }),
    );

    expect(result.baseline?.status).toBe('differs');
    expect(result.baseline?.changes?.[0]?.path).toBe('/key');
    expect(JSON.stringify(result.baseline)).not.toContain(SECRET);
    expect(JSON.stringify(result.assertions)).not.toContain(SECRET);
  });

  it("keeps the request's own assertions redacted as before, beside the baseline result", async () => {
    const { fixture, item } = await petsSend({ token: SECRET, name: 'Rex' });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      assertions: [{ type: 'match', language: 'jsonpath', expression: '$.token', equals: 'something-else' }],
    }));
    await writeGolden(fixture.dir, item, { body: '{"token": "x", "name": "Rex"}' });

    const result = await runOp(sendOp, { item, environment: 'local', baseline: true }, fixture.base());

    expect(result.assertions.map((assertion) => assertion.type)).toEqual(['match', 'baseline']);
    expect(result.assertions[0]).toMatchObject({ outcome: 'failed', actual: REDACTED_MARKER });
  });
```

  In `packages/cli/test/unit/mcp/server.test.ts`, add to its main describe (import `addEnvironment`,
  `restItem`, `restProject`, `startServer`, `writeGolden` from `../ops/helpers.js` if not imported yet):

```ts
  it('returns a baseline difference as a normal send result, not an error', async () => {
    const fixture = await restProject();
    const pets = await startServer(() => ({ headers: { 'Content-Type': 'application/json' }, body: '{"ok": true}' }));
    closers.push(() => pets.close());
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    const item = await restItem(fixture.dir, 'GET', '/pets');
    await writeGolden(fixture.dir, item, { body: '{"ok": false}' });
    const client = await connect(fixture.base());

    const sent = await call(client, 'send', { item, environment: 'local', baseline: true });

    expect(sent.isError).toBe(false);
    expect(sent.json).toMatchObject({ outcome: 'failed', baseline: { status: 'differs' } });
  });
```

- [ ] **Step 2: Run them and see the masking test fail**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops/send.test.ts test/unit/mcp/server.test.ts`
Expected: the masking test FAILS (`SECRET` appears in `baseline.changes[0].actual`); the other two may
already pass.

- [ ] **Step 3: Implement.** In `send.ts`, above `commonOf`:

```ts
/**
 * The golden comparison and its assertion with every secret the send resolved masked (spec §4): a
 * response can echo a secret, and the changes carry response values.
 */
function maskedBaseline(result: RequestResult, mask: (text: string) => string): RequestResult {
  const { baseline } = result;
  if (baseline === undefined) {
    return result;
  }
  return {
    ...result,
    baseline: {
      ...baseline,
      ...(baseline.error !== undefined ? { error: mask(baseline.error) } : {}),
      ...(baseline.changes !== undefined
        ? {
            changes: baseline.changes.map((change) => ({
              ...change,
              ...(change.expected !== undefined ? { expected: mask(change.expected) } : {}),
              ...(change.actual !== undefined ? { actual: mask(change.actual) } : {}),
            })),
          }
        : {}),
    },
    assertions: result.assertions.map((assertion) =>
      assertion.type === 'baseline'
        ? {
            ...assertion,
            label: mask(assertion.label),
            ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
          }
        : assertion,
    ),
  };
}
```

  In `sendOp.run`, rename the destructured `result` and mask it before building the reply:

```ts
      const { result: sent, exchange, mask, maskBase64, historyId } = await sendAndRecord({
        // …unchanged…
      });
      const result = maskedBaseline(sent, mask);
```

  In `redact.ts` `redactAssertions`, skip the synthetic result when pairing results with saved
  assertions, and end the doc comment with "…then callbacks, then script tests; a `baseline` result
  (#218) is the run's own and pairs with none":

```ts
    if (result.type !== 'callback' && result.type !== 'script' && result.type !== 'baseline') {
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops test/unit/mcp`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/cli/src/ops/send.ts packages/cli/src/ops/redact.ts packages/cli/test/unit/ops/send.test.ts packages/cli/test/unit/mcp/server.test.ts
git commit -m "feat(cli): mask send's golden comparison and keep assertion pairing (#218)"
```

---

### Task 3: `wirebench send --baseline`

**Files:**
- Modify: `packages/cli/src/args-ops.ts` (`USAGE.send`, `VERB_FLAGS.send`, the `send` case, `VERB_HELP.send`, `OPS_HELP_TEXT`)
- Modify: `packages/cli/src/commands/ops-output.ts` (`sendText`)
- Test: `packages/cli/test/unit/ops-verbs.test.ts`

**Interfaces:**
- Consumes: op input `baseline?: boolean`; `SendResult.baseline` (Tasks 1–2).

- [ ] **Step 1: Write the failing tests** in `ops-verbs.test.ts` (add `restItem`, `writeGolden` to the
  helpers import), inside `describe('the op verbs')`:

```ts
  it('compares with the golden on --baseline: exit 0 matched or missing, 1 differs, 3 unreadable', async () => {
    const fixture = await restProject();
    let body = '{"ok": true}';
    server = await startServer(() => ({ headers: { 'Content-Type': 'application/json' }, body }));
    await addEnvironment(fixture.dir, 'local', { Pets: server.url });
    const item = await restItem(fixture.dir, 'GET', '/pets');
    const where = ['--project', fixture.dir, '--history-dir', fixture.historyDir];

    const missing = await cli(['send', item, '-e', 'local', '--baseline', ...where]);
    expect(missing.code).toBe(ExitCode.Ok);
    expect(missing.stdout).toContain('  baseline: no baseline saved\n');

    const file = await writeGolden(fixture.dir, item, { body: '{"ok": true}' });
    const matched = await cli(['send', item, '-e', 'local', '--baseline', ...where]);
    expect(matched.code).toBe(ExitCode.Ok);
    expect(matched.stdout).toContain('ok   matches the baseline');

    body = '{"ok": false}';
    const differs = await cli(['send', item, '-e', 'local', '--baseline', ...where]);
    expect(differs.code).toBe(ExitCode.AssertionFailed);
    expect(differs.stdout).toContain('  FAIL 1 difference from the baseline\n    changed /ok: true → false\n');

    const json = await cli(['send', item, '-e', 'local', '--baseline', '--json', ...where]);
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: 'failed', baseline: { status: 'differs' } });

    const overridden = await cli(['send', item, '-e', 'local', '--baseline', '--body', '{}', ...where]);
    expect(overridden.code).toBe(ExitCode.AssertionFailed);

    await writeFile(file, 'body: [unclosed');
    const unreadable = await cli(['send', item, '-e', 'local', '--baseline', ...where]);
    expect(unreadable.code).toBe(ExitCode.RunError);
    expect(unreadable.stdout).toContain('malformed');
  });

  it('prints a WebSocket send as not compared', () => {
    const text = formatHuman('send', {
      item: 'Chat/Echo',
      kind: 'websocket',
      outcome: 'passed',
      unasserted: true,
      method: 'GET',
      url: 'ws://localhost/echo',
      status: 101,
      statusText: 'Switching Protocols',
      durationMs: 3,
      headers: {},
      body: '[]',
      bodyTruncated: false,
      frames: [],
      assertions: [],
      baseline: { status: 'unsupported' },
    });
    expect(text).toContain('  baseline: not compared (websocket)\n');
  });
```

  Extend the existing `send --help` check (~line 148) with `expect(help.stdout).toContain('--baseline');`.

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops-verbs.test.ts`
Expected: FAIL — `--baseline` refused as foreign to `wirebench send` (exit 2), no baseline line.

- [ ] **Step 3: Implement `args-ops.ts`.**

```ts
  send: 'wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--baseline]',
```

```ts
  send: [...COMMON, 'env', 'body', 'body-file', 'baseline', 'history-dir'],
```

  The `send` case:

```ts
        input: {
          item: one(op, args),
          ...opt('environment', str(values, 'env')),
          ...opt('body', body),
          ...(values['baseline'] === true ? { baseline: true } : {}),
        },
```

  `VERB_HELP.send`, after the `--body` line:

```text
--baseline             Also compare the response with the golden saved beside the request
                       (<slug>.golden.yaml); a difference fails the send.
```

  and its last line becomes:
  `Secrets come from WIREBENCH_SECRET_<NAME> variables, as for run. Exit 1 when an assertion or the baseline failed.`

  `OPS_HELP_TEXT`'s `send` line gains ` [--baseline]` after `--body-file <file>]`.

- [ ] **Step 4: Implement `sendText`** in `ops-output.ts`. Replace the `result.assertions.map(...)`
  spread with:

```ts
    ...result.assertions.flatMap((assertion) =>
      // A baseline difference lists one change per line under its label, as the run's cli reporter does.
      assertion.type === 'baseline' && assertion.outcome === 'failed'
        ? [
            `  ${mark(assertion.outcome)} ${assertion.label}`,
            ...(assertion.message ?? '').split('\n').map((line) => `    ${line}`),
          ]
        : [
            `  ${mark(assertion.outcome)} ${assertion.label}${assertion.message !== undefined ? `: ${assertion.message}` : ''}`,
          ],
    ),
    ...(result.baseline?.status === 'missing' ? ['  baseline: no baseline saved'] : []),
    ...(result.baseline?.status === 'unsupported' ? [`  baseline: not compared (${result.kind})`] : []),
```

  A match, an unreadable golden and an oversize body already print through their `baseline`
  assertion line (`ok   matches the baseline (N ignored)`, `ERR  baseline: …`), so they need no extra line.

- [ ] **Step 5: Run the tests and see them pass**

Run: `nice pnpm --filter @wirebench/cli exec vitest run test/unit/ops-verbs.test.ts test/unit/args.test.ts`
Expected: PASS, including the existing `describe('run --baseline')` in `args.test.ts`. If the
unreadable text differs, assert on what `checkBaseline` writes:
`The saved baseline cannot be read (malformed).`

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add packages/cli/src/args-ops.ts packages/cli/src/commands/ops-output.ts packages/cli/test/unit/ops-verbs.test.ts
git commit -m "feat(cli): wirebench send --baseline (#218)"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/cli.md` (the `send` usage line ~66 and its option text)
- Modify: `docs-site/src/content/docs/guides/agents-mcp.mdx`
- Modify: `docs-site/src/content/docs/guides/snapshot-regression.mdx`
- Modify: `CHANGELOG.md` (Unreleased → Added)

- [ ] **Step 1: `docs/cli.md`.** The usage line becomes
  `wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--baseline]`. Where `send`'s
  options are described, add: "`--baseline` also compares the response body with the golden saved
  beside the request (`<slug>.golden.yaml`), honouring its ignore rules. A difference is a failed
  `baseline` assertion (exit 1); no golden prints `baseline: no baseline saved` and does not fail."

- [ ] **Step 2: `agents-mcp.mdx`.** Add a section after the one describing `send`:

```mdx
## Check a response against its golden

Pass `baseline: true` to `send` to compare the response with the golden response saved beside the
request in the Snapshot tab. The comparison is by meaning and honours the golden's ignore rules, as
`wirebench run --baseline` does in CI.

The result gains a `baseline` field:

| `status` | Meaning |
| --- | --- |
| `matched` | The response matches; `ignored` counts the differences the ignore rules hid. |
| `differs` | `changes` lists each `kind` (`changed`, `added`, `removed`), `path`, `expected` and `actual`, the first 100; `truncated` says there were more. The send's `outcome` is `failed`. |
| `missing` | No baseline saved for this request. The send is judged on its own assertions. |
| `unreadable`, `too-large` | The golden could not be read, or a body is over 2 MB. The send errors. |
| `unsupported` | A WebSocket request: there is no golden to compare. |

A `body` override can be combined with it: the saved request's golden still applies, so you can
change a request and check that the response did not change. Secret values the send resolved are
masked in `changes`.
```

  Then a short worked example in the guide's existing style: the call
  `{ "item": "Pets/pets/List pets", "environment": "local", "baseline": true }` and a result excerpt
  with `"outcome": "failed"` and one change
  `{ "kind": "changed", "path": "/0/name", "expected": "Rex", "actual": "Fido" }`.

- [ ] **Step 3: `snapshot-regression.mdx`.** In its "In CI" section, add: "Agents get the same check
  over MCP: `send` with `baseline: true`." linking to the Agents (MCP) guide the way this guide links others.

- [ ] **Step 4: `CHANGELOG.md`**, Unreleased/Added: "`send` (MCP tool and `wirebench send --baseline`)
  compares the response with the request's golden and returns the differences (#218)."

- [ ] **Step 5: Gate and commit**

```bash
pnpm check:banned-terms
WIREBENCH_SKIP_PERF=1 pnpm check
git add docs/cli.md docs-site/src/content/docs/guides/agents-mcp.mdx docs-site/src/content/docs/guides/snapshot-regression.mdx CHANGELOG.md
git commit -m "docs: the baseline check on send (#218)"
```

---

## Before the push

- `pnpm test:perf` unskipped.
- No e2e: the desktop does not change.
