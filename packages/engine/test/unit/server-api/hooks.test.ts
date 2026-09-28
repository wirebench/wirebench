import { describe, expect, it } from 'vitest';
import {
  CATCH_CONTENT_TYPE_PATTERN,
  CATCH_SECRET_PATTERN,
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  hooksMetaSchema,
  metaResponseSchema,
  type Capture,
  type CatchUrl,
} from '../../../src/index.js';

const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const CAPTURE = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const SECRET = '3ZC5Q0V7R3T9XK2M4N6P8QAB7Y';

const catchUrl: CatchUrl = {
  id: HOOK,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wirebench.test/hooks/${SECRET}`,
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-28T10:00:00.000Z',
};

const capture: Capture = {
  id: CAPTURE,
  receivedAt: '2026-09-28T10:00:01.000Z',
  method: 'POST',
  subpath: '/payments/events',
  query: 'a=1&a=2',
  headers: [
    ['Content-Type', 'application/json'],
    ['Via', '1.1 a'],
    ['Via', '1.1 b'],
  ],
  body: Buffer.from('{"ok":true}').toString('base64'),
  bodySize: 11,
  truncated: false,
  sourceIp: '203.0.113.9',
};

describe('server-api hooks schemas (webhook-capture §3.5, §3.7)', () => {
  it('pins the limits the server enforces and the desktop explains', () => {
    expect(HOOKS_LIMITS).toEqual({
      maxNameLength: 100,
      maxContentTypeLength: 255,
      maxResponseBodyBytes: 65_536,
      maxDelayMs: 30_000,
      defaultPageSize: 50,
      maxPageSize: 200,
    });
    expect(CATCH_URL_PATH_PREFIX).toBe('/hooks/');
    expect(CATCH_URL_DEFAULT_RESPONSE).toEqual({ status: 200, contentType: null, body: null, delayMs: 0 });
  });

  it('a secret is 26 Crockford base32 characters, upper case, as 128 random bits encode', () => {
    expect(CATCH_SECRET_PATTERN.test(SECRET)).toBe(true);
    for (const bad of [SECRET.toLowerCase(), `${SECRET}A`, SECRET.slice(1), 'I'.repeat(26), 'U'.repeat(26), '../etc']) {
      expect(CATCH_SECRET_PATTERN.test(bad)).toBe(false);
    }
  });

  it('a configured content type is printable ASCII, so it can never split a response header', () => {
    expect(CATCH_CONTENT_TYPE_PATTERN.test('application/json; charset=utf-8')).toBe(true);
    for (const bad of ['', 'text/plain\r\nX-Evil: 1', 'text/plain\n', 'tëxt/plain', 'a\tb']) {
      expect(CATCH_CONTENT_TYPE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('parses a catch URL and a full capture, repeated headers kept in order', () => {
    expect(catchUrlSchema.parse(catchUrl)).toEqual(catchUrl);
    expect(captureSchema.parse(capture)).toEqual(capture);
    const { id, receivedAt, method, subpath, bodySize, truncated, sourceIp } = capture;
    const summary = { id, receivedAt, method, subpath, bodySize, truncated, sourceIp };
    expect(capturesResponseSchema.parse([summary])).toEqual([summary]);
  });

  it('creation needs a name; every response setting is optional and range-checked', () => {
    expect(catchUrlCreateRequestSchema.parse({ name: 'Payments' })).toEqual({ name: 'Payments' });
    expect(
      catchUrlCreateRequestSchema.parse({ name: 'P', enabled: false, response: { status: 202, delayMs: 250 } }),
    ).toEqual({ name: 'P', enabled: false, response: { status: 202, delayMs: 250 } });
    for (const bad of [
      {},
      { name: '' },
      { name: 'x'.repeat(HOOKS_LIMITS.maxNameLength + 1) },
      { name: 'P', response: { status: 199 } },
      { name: 'P', response: { status: 600 } },
      { name: 'P', response: { delayMs: -1 } },
      { name: 'P', response: { delayMs: HOOKS_LIMITS.maxDelayMs + 1 } },
      { name: 'P', response: { contentType: 'x'.repeat(HOOKS_LIMITS.maxContentTypeLength + 1) } },
      { name: 'P', response: { contentType: 'text/plain\r\nX: 1' } },
      { name: 'P', response: { body: 'x'.repeat(HOOKS_LIMITS.maxResponseBodyBytes + 1) } },
    ]) {
      expect(catchUrlCreateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('an update may change anything or nothing; null clears a content type or a body', () => {
    expect(catchUrlUpdateRequestSchema.parse({})).toEqual({});
    expect(catchUrlUpdateRequestSchema.parse({ response: { contentType: null, body: null } })).toEqual({
      response: { contentType: null, body: null },
    });
  });

  it('route parameters are ULIDs; the page size is 1 to 200', () => {
    expect(catchUrlParamsSchema.safeParse({ workspaceId: WS, hookId: 'nope' }).success).toBe(false);
    expect(captureParamsSchema.parse({ workspaceId: WS, hookId: HOOK, captureId: CAPTURE })).toBeTruthy();
    expect(capturesQuerySchema.parse({ before: CAPTURE, limit: 200 })).toEqual({ before: CAPTURE, limit: 200 });
    expect(capturesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(capturesQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(capturesQuerySchema.safeParse({ after: 'x' }).success).toBe(false);
  });

  it('/meta carries hooks when the module reports them, and an older server without them still parses', () => {
    const base = {
      name: 'wirebench-server',
      version: '1',
      apiVersion: 1,
      publicUrl: 'https://x.test',
      auth: { local: true, oidc: false },
      capabilities: [],
    };
    const hooks = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
    expect(hooksMetaSchema.parse(hooks)).toEqual(hooks);
    expect(metaResponseSchema.parse({ ...base, hooks }).hooks).toEqual(hooks);
    expect(metaResponseSchema.parse(base).hooks).toBeUndefined();
  });
});
