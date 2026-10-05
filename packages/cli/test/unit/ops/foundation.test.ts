import {
  awaitCallbacks,
  HttpError,
  prepareCallbacks,
  ProjectError,
  REDACTED_MARKER,
  REDACTED_XML_MARKER,
} from '@wirebench/engine';
import type {
  AssertionResult,
  CallbackAssertion,
  CaptureDetailView,
  CaptureSource,
  FailedRequest,
  StepAssertion,
} from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExitCode } from '../../../src/exit-codes.js';
import { defineOp, runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../../../src/ops/errors.js';
import { defaultHistoryDir, defaultUserDataDir, historyFileFor } from '../../../src/ops/paths.js';
import {
  redactAssertions,
  redactBaseline,
  redactBody,
  redactError,
  redactUrlsInText,
} from '../../../src/ops/redact.js';
import { createSourceCache } from '@wirebench/engine';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../../src/source-secrets.js';

const SECRET = 'abc123def456ghi789';

const base: OpsBase = {
  projectDir: '/nowhere',
  historyDir: '/nowhere/history',
  env: {},
  gates: { write: false, send: false },
  origin: 'cli',
  warn: () => undefined,
  secretSources: DEFAULT_CLI_SECRET_SOURCES,
  secretSourceCache: createSourceCache(),
  secretSourceValues: new Set<string>(),
};

const leaky = defineOp({
  name: 'leaky',
  title: 'Leaky',
  description: 'Returns and throws what it was given, for the redaction step to catch.',
  input: z.object({ value: z.string(), fail: z.boolean().default(false) }),
  run(input, context) {
    context.revealed.add(SECRET);
    if (input.fail) {
      return Promise.reject(new OpsError('leak', `failed near ${SECRET}`, { quoted: [SECRET] }));
    }
    return Promise.resolve({ echoed: `key=${SECRET}`, nested: [{ value: input.value }] });
  },
});

describe('runOp', () => {
  it('masks a value a source handed out in an earlier call of the same base', async () => {
    const echo = defineOp({
      name: 'echo',
      title: 'Echo',
      description: 'Returns its input, resolving nothing.',
      input: z.object({ value: z.string() }),
      run: (input) => Promise.resolve({ echoed: input.value }),
    });
    const shared: OpsBase = { ...base, origin: 'mcp', secretSourceValues: new Set<string>() };
    // What `sendAndRecord` leaves behind after call 1 resolved a source value.
    shared.secretSourceValues.add('from-vault-long-value');
    const result = await runOp(echo, { value: 'seen from-vault-long-value' }, shared);
    expect(result.echoed).toBe('seen <redacted>');
  });

  it('masks every secret the call revealed, at any depth', async () => {
    const result = await runOp(leaky, { value: `also ${SECRET}` }, base);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.echoed).toBe('key=<redacted>');
    expect(result.nested[0]?.value).toBe('also <redacted>');
  });

  it('masks a thrown error message and its details', async () => {
    const error = await runOp(leaky, { value: 'x', fail: true }, base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsError);
    expect((error as OpsError).code).toBe('leak');
    expect((error as OpsError).message).toBe('failed near <redacted>');
    expect(JSON.stringify((error as OpsError).details)).not.toContain(SECRET);
  });

  it('refuses input its schema rejects, naming the field', async () => {
    await expect(runOp(leaky, { value: 3 }, base)).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('value') as unknown,
    });
  });
});

const failing = (make: () => Error): ReturnType<typeof defineOp> =>
  defineOp({
    name: 'failing',
    title: 'Failing',
    description: 'Throws what it is given.',
    input: z.object({}),
    run(_input, context) {
      context.revealed.add(SECRET);
      return Promise.reject(make());
    },
  });

describe('runOp error redaction', () => {
  it('masks a revealed secret in a plain Error message', async () => {
    const error = await runOp(
      failing(() => new Error(`boom ${SECRET}`)),
      {},
      base,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'internal-error', message: 'boom <redacted>' });
  });

  it('drops the failed request and redacts the URLs an HttpError quotes', async () => {
    const request: FailedRequest = {
      url: `https://api.example.test/v1?token=${SECRET}`,
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      bodyBase64: Buffer.from(`{"token":"${SECRET}"}`).toString('base64'),
      bodyTruncated: false,
    };
    const thrown = new HttpError('network', `connect failed for https://api.example.test/v1?token=${SECRET}`, {
      details: { request, attempts: 2 },
    });
    const error = (await runOp(
      failing(() => thrown),
      {},
      base,
    ).catch((e: unknown) => e)) as OpsError;
    expect(error.code).toBe('network');
    expect(error.details).toEqual({ attempts: 2 });
    expect(error.message).toBe('connect failed for https://api.example.test/v1?token=%3Credacted%3E');
    expect(JSON.stringify([error.message, error.details])).not.toContain(SECRET);
    expect(JSON.stringify([error.message, error.details])).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  it('redacts the URL of an invalid-url message and detail, credentials and query included', async () => {
    const url = `http://ada:${SECRET}@[bad/x?api_key=${SECRET}&page=2`;
    const thrown = new HttpError('invalid-url', `Invalid URL: ${url}`, { details: { url } });
    const error = (await runOp(
      failing(() => thrown),
      {},
      base,
    ).catch((e: unknown) => e)) as OpsError;
    expect(error.message).toBe('Invalid URL: http://[bad/x?api_key=<redacted>&page=<redacted>');
    expect(error.details).toEqual({ url: 'http://[bad/x?api_key=<redacted>&page=<redacted>' });
  });

  it('redacts the credentials and query of a ws or wss URL, whatever its case', async () => {
    const thrown = new HttpError('network', `refused WSS://ada:pw@h.example.test/x?token=${SECRET}`);
    const error = (await runOp(
      failing(() => thrown),
      {},
      base,
    ).catch((e: unknown) => e)) as OpsError;
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('ada:pw');
  });

  it('redacts a long run of query marks in linear time', () => {
    const started = performance.now();
    const redacted = redactError(new OpsError('invalid-url', `Invalid URL: http://[${'?'.repeat(200_000)}`), new Set());
    expect(performance.now() - started).toBeLessThan(200);
    expect(redacted.code).toBe('invalid-url');
  });

  it("keeps each call's revealed secrets to that call", async () => {
    const reveals = defineOp({
      name: 'reveals',
      title: 'Reveals',
      description: 'Reveals a secret and returns it.',
      input: z.object({}),
      run: (_input, context) => {
        context.revealed.add(SECRET);
        return Promise.resolve(`has ${SECRET}`);
      },
    });
    const quiet = defineOp({
      name: 'quiet',
      title: 'Quiet',
      description: 'Reveals nothing and returns the same text.',
      input: z.object({}),
      run: () => Promise.resolve(`has ${SECRET}`),
    });
    const [first, second] = await Promise.all([runOp(reveals, {}, base), runOp(quiet, {}, base)]);
    expect(first).toBe('has <redacted>');
    expect(second).toBe(`has ${SECRET}`);
  });
});

describe('errors', () => {
  it('keeps an engine code and details', () => {
    const mapped = toOpsError(new ProjectError('project-not-found', 'No wirebench.yaml', { details: { root: '/x' } }));
    expect(mapped).toMatchObject({ code: 'project-not-found', message: 'No wirebench.yaml', details: { root: '/x' } });
    expect(toOpsError(new Error('boom'))).toMatchObject({ code: 'internal-error', message: 'boom' });
  });

  it('maps a refusal to exit 2 and a failure to exit 3', () => {
    expect(exitCodeForError(new OpsError('item-not-found', 'x'))).toBe(ExitCode.Usage);
    expect(exitCodeForError(new OpsError('send-not-allowed', 'x'))).toBe(ExitCode.Usage);
    expect(exitCodeForError(new OpsError('history-busy', 'x'))).toBe(ExitCode.RunError);
    expect(exitCodeForError(new OpsError('http-connect-failed', 'x'))).toBe(ExitCode.RunError);
  });
});

describe('paths', () => {
  it("follows the desktop's userData per platform", () => {
    expect(defaultUserDataDir('darwin', {}, '/Users/ada')).toBe('/Users/ada/Library/Application Support/Wirebench');
    expect(defaultUserDataDir('win32', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'C:\\Users\\ada')).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\Wirebench',
    );
    expect(defaultUserDataDir('win32', {}, 'C:\\Users\\ada')).toBe('C:\\Users\\ada\\AppData\\Roaming\\Wirebench');
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/ada')).toBe('/cfg/Wirebench');
    expect(defaultUserDataDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Wirebench');
    expect(defaultHistoryDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Wirebench/history');
  });

  it('refuses a project id that is not one path segment', () => {
    expect(historyFileFor('/h', 'proj-1')).toMatch(/proj-1\.jsonl$/);
    let code: string | undefined;
    try {
      historyFileFor('/h', '../elsewhere');
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('workspace-path-invalid');
  });
});

describe('redactBody', () => {
  it('masks a WS-Security password and a JSON secret key', () => {
    expect(redactBody(`<wsse:Password>${SECRET}</wsse:Password>`, 'text/xml')).not.toContain(SECRET);
    expect(redactBody(JSON.stringify({ token: SECRET }), 'application/json')).not.toContain(SECRET);
    expect(redactBody('plain text', undefined)).toBe('plain text');
  });
});

describe('redactAssertions', () => {
  it('shows a failed header assertion on Set-Cookie as the marker, and keeps an ordinary header', () => {
    const assertions: StepAssertion[] = [
      { type: 'status', equals: 200 },
      { type: 'header', header: 'Set-Cookie', equals: 'session=expected' },
      { type: 'header', header: 'Content-Type', equals: 'application/json' },
    ];
    const results: AssertionResult[] = [
      { type: 'status', label: 'status 200', outcome: 'passed' },
      {
        type: 'header',
        label: 'header Set-Cookie',
        outcome: 'failed',
        expected: 'session=expected',
        actual: `session=${SECRET}`,
      },
      {
        type: 'header',
        label: 'header Content-Type',
        outcome: 'failed',
        expected: 'application/json',
        actual: 'text/xml',
      },
    ];

    const redacted = redactAssertions(results, assertions);

    expect(redacted[1]).toMatchObject({ outcome: 'failed', expected: 'session=expected', actual: REDACTED_MARKER });
    expect(redacted[2]).toMatchObject({ actual: 'text/xml' });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
  });

  it('keeps present or absent, and hides the value of an unpaired header or match result', () => {
    const assertions: StepAssertion[] = [{ type: 'header', header: 'Set-Cookie', exists: false }];
    const results: AssertionResult[] = [
      { type: 'header', label: 'header Set-Cookie', outcome: 'failed', expected: 'absent', actual: 'present' },
      { type: 'match', label: 'named check', outcome: 'failed', expected: 'x', actual: SECRET },
    ];

    const redacted = redactAssertions(results, assertions);

    expect(redacted[0]).toMatchObject({ actual: 'present' });
    expect(redacted[1]).toMatchObject({ actual: REDACTED_MARKER });
  });

  it('leaves a baseline result unpaired, so a later match result still pairs with its own assertion', () => {
    const assertions: StepAssertion[] = [{ type: 'match', language: 'jsonpath', expression: '$.name', equals: 'Fido' }];
    const results: AssertionResult[] = [
      { type: 'baseline', label: 'differs from the baseline', outcome: 'failed' },
      { type: 'match', label: 'match $.name', outcome: 'failed', expected: 'Fido', actual: 'Rex' },
    ];

    const redacted = redactAssertions(results, assertions);

    expect(redacted[1]).toMatchObject({ actual: 'Rex' });
  });

  it("masks the value a callback reason quotes for a sensitive header or a secret key's path", () => {
    const message =
      `matched cap-1, but header Set-Cookie: expected "a=1", got "a=${SECRET}"; ` +
      `$.data.access_token: expected "x", got "${SECRET}"; $.name: expected "Fido", got "Rex"`;
    const results: AssertionResult[] = [{ type: 'callback', label: 'callback hook', outcome: 'failed', message }];

    const [redacted] = redactAssertions(results, []);

    expect(redacted?.message).toBe(
      `matched cap-1, but header Set-Cookie: expected "a=1", got ${REDACTED_MARKER}; ` +
        `$.data.access_token: expected "x", got ${REDACTED_MARKER}; $.name: expected "Fido", got "Rex"`,
    );
  });

  it('hides a match value cut short when it still holds a quoted secret key or an open Password', () => {
    const assertions: StepAssertion[] = [
      { type: 'match', language: 'jsonpath', expression: '$.auth', equals: 'x' },
      { type: 'match', language: 'xpath', expression: '//Header', equals: 'x' },
      { type: 'match', language: 'jsonpath', expression: '$.note', equals: 'x' },
    ];
    const results: AssertionResult[] = [
      { type: 'match', label: 'a', outcome: 'failed', expected: 'x', actual: `{"user":"ann","token":"${SECRET}…` },
      { type: 'match', label: 'b', outcome: 'failed', expected: 'x', actual: `<Header><Password>${SECRET}…` },
      { type: 'match', label: 'c', outcome: 'failed', expected: 'x', actual: 'plain text, cut…' },
    ];

    const redacted = redactAssertions(results, assertions);

    expect(redacted.map((result) => result.actual)).toEqual([REDACTED_MARKER, REDACTED_MARKER, 'plain text, cut…']);
  });

  it("masks the values in a real callback failure reason from the engine's evaluator", async () => {
    const capture: CaptureDetailView = {
      id: '01J00000000000000000000001',
      receivedAt: new Date().toISOString(),
      method: 'POST',
      path: '/',
      signature: null,
      headers: [['Set-Cookie', `session=${SECRET}`]],
      bodyText: JSON.stringify({ token: SECRET, auth: { token: SECRET, user: 'ann' }, name: 'Rex' }),
      truncated: false,
    };
    const source: CaptureSource = {
      resolve: () => Promise.resolve({ hookId: 'hook-1' }),
      cursor: () => Promise.resolve(null),
      after: (_hookId, cursor) => Promise.resolve(cursor === null ? [capture] : []),
      detail: () => Promise.resolve(capture),
    };
    const assertion: CallbackAssertion = {
      type: 'callback',
      catchUrl: 'orders',
      withinMs: 1_000,
      match: { method: 'POST' },
      expect: [
        { header: { name: 'Set-Cookie', equals: 'session=expected' } },
        { body: { language: 'jsonpath', path: '$.token', equals: 'expected' } },
        { body: { language: 'jsonpath', path: '$.auth', equals: 'expected' } },
        { body: { language: 'jsonpath', path: '$.name', equals: 'Fido' } },
      ],
    };
    const pending = await prepareCallbacks([assertion], source);
    const results = await awaitCallbacks(pending, { captures: source, sentAt: performance.now() });
    expect(results[0]?.message).toContain(SECRET);

    const [redacted] = redactAssertions(results, [assertion]);

    expect(redacted?.outcome).toBe('failed');
    expect(redacted?.message).not.toContain(SECRET);
    expect(redacted?.message).toContain(`header Set-Cookie: expected "session=expected", got ${REDACTED_MARKER}`);
    expect(redacted?.message).toContain(`$.token: expected "expected", got ${REDACTED_MARKER}`);
    expect(redacted?.message).toContain('ann');
    expect(redacted?.message).toContain('$.name: expected "Fido", got "Rex"');
  });

  it('redacts credential URLs in every text of a result', () => {
    const url = `https://user:${SECRET}@example.test/path?token=${SECRET}`;
    const results: AssertionResult[] = [
      { type: 'script', label: `calls ${url}`, outcome: 'failed', expected: url, actual: url, message: `got ${url}` },
    ];

    const [redacted] = redactAssertions(results, []);

    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted?.label).toContain('example.test');
  });
});

describe('redactBaseline', () => {
  it('shows the marker on both sides of a change under a secret key, in any path form', () => {
    const paths = [
      '/token',
      '/token/0',
      '/auth/access_token',
      '/auth/token/expires',
      '/Envelope/Body/Login/Password[1]',
      '/wsse:Security/wsse:Password',
      '/Envelope/Header/Login/@password',
    ];

    const report = redactBaseline({
      status: 'differs',
      changes: paths.map((path) => ({ kind: 'changed' as const, path, expected: '"old"', actual: `"${SECRET}"` })),
    });

    expect(report.changes?.map((change) => [change.expected, change.actual])).toEqual(
      paths.map(() => [REDACTED_MARKER, REDACTED_MARKER]),
    );
  });

  it('runs other values through the body redactors, and keeps what holds no credential', () => {
    const report = redactBaseline({
      status: 'differs',
      format: 'json',
      error: `could not parse https://user:${SECRET}@example.test/`,
      changes: [
        { kind: 'changed', path: '/name', expected: '"Rex"', actual: '"Fido"' },
        { kind: 'added', path: '/auth', actual: JSON.stringify({ token: SECRET, user: 'ann' }) },
        { kind: 'removed', path: '/Header', expected: `<Security><Password>${SECRET}</Password></Security>` },
        { kind: 'changed', path: '/tokens', expected: '1', actual: '2' },
      ],
    });

    expect(report.changes?.[0]).toEqual({ kind: 'changed', path: '/name', expected: '"Rex"', actual: '"Fido"' });
    expect(JSON.parse(report.changes?.[1]?.actual ?? '')).toEqual({ token: REDACTED_MARKER, user: 'ann' });
    expect(report.changes?.[2]?.expected).toContain(`<Password>${REDACTED_XML_MARKER}</Password>`);
    expect(report.changes?.[3]).toMatchObject({ expected: '1', actual: '2' });
    expect(report.error).toContain('example.test');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("rebuilds a failed baseline assertion's message from the redacted changes", () => {
    const raw = {
      status: 'differs' as const,
      error: 'Unexpected token',
      changes: Array.from({ length: 21 }, (_, n) =>
        n === 0
          ? { kind: 'changed' as const, path: '/token', expected: '"x"', actual: `"${SECRET}"` }
          : { kind: 'added' as const, path: `/n${n}`, actual: String(n) },
      ),
    };
    const message = [
      'compared as text: Unexpected token',
      `changed /token: "x" → "${SECRET}"`,
      ...Array.from({ length: 19 }, (_, n) => `added /n${n + 1}: ${n + 1}`),
      '… and 1 more',
    ].join('\n');

    const [redacted] = redactAssertions(
      [{ type: 'baseline', label: '21 differences from the baseline', outcome: 'failed', message }],
      [],
      redactBaseline(raw),
    );

    const lines = redacted?.message?.split('\n');
    expect(lines?.[0]).toBe('compared as text: Unexpected token');
    expect(lines?.[1]).toBe(`changed /token: ${REDACTED_MARKER} → ${REDACTED_MARKER}`);
    expect(lines?.[2]).toBe('added /n1: 1');
    expect(lines).toHaveLength(22);
    expect(lines?.at(-1)).toBe('… and 1 more');
    expect(redacted?.message).not.toContain(SECRET);
  });
});

describe('redactUrlsInText', () => {
  it('ends a credential URL at the closing quote of a JSON string, keeping the keys after it', () => {
    const text = JSON.stringify({ url: `https://ada:${SECRET}@h.example.test/x?token=${SECRET}`, next: 'kept' });

    const redacted = redactUrlsInText(text);

    expect(redacted).not.toContain(SECRET);
    const parsed = JSON.parse(redacted) as { url: string; next: string };
    expect(parsed.next).toBe('kept');
    expect(parsed.url).toContain('h.example.test/x?token=');
  });

  it('ends a URL inside a nested object, and at quotes, angle brackets, backslashes and backticks', () => {
    const inner = JSON.stringify({ a: { b: `http://h.example.test/?token=${SECRET}` }, c: [1, 2] });
    expect(JSON.parse(redactUrlsInText(inner))).toEqual({
      a: { b: 'http://h.example.test/?token=%3Credacted%3E' },
      c: [1, 2],
    });
    for (const end of ["'", '<', '>', '\\', '`']) {
      const redacted = redactUrlsInText(`see http://h.example.test/?token=${SECRET}${end}after`);
      expect(redacted).not.toContain(SECRET);
      expect(redacted.endsWith(`${end}after`)).toBe(true);
    }
  });
});
