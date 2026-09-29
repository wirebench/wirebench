import { HttpError, ProjectError } from '@wirebench/engine';
import type { FailedRequest } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExitCode } from '../../../src/exit-codes.js';
import { defineOp, runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../../../src/ops/errors.js';
import { defaultHistoryDir, defaultUserDataDir, historyFileFor } from '../../../src/ops/paths.js';
import { redactBody, redactError } from '../../../src/ops/redact.js';

const SECRET = 'abc123def456ghi789';

const base: OpsBase = {
  projectDir: '/nowhere',
  historyDir: '/nowhere/history',
  env: {},
  gates: { write: false, send: false },
  origin: 'cli',
  warn: () => undefined,
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
