import { ProjectError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExitCode } from '../../../src/exit-codes.js';
import { defineOp, runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../../../src/ops/errors.js';
import { defaultHistoryDir, defaultUserDataDir, historyFileFor } from '../../../src/ops/paths.js';
import { redactBody } from '../../../src/ops/redact.js';

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
    expect(() => historyFileFor('/h', '../elsewhere')).toThrow();
  });
});

describe('redactBody', () => {
  it('masks a WS-Security password and a JSON secret key', () => {
    expect(redactBody(`<wsse:Password>${SECRET}</wsse:Password>`, 'text/xml')).not.toContain(SECRET);
    expect(redactBody(JSON.stringify({ token: SECRET }), 'application/json')).not.toContain(SECRET);
    expect(redactBody('plain text', undefined)).toBe('plain text');
  });
});
