import { Writable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { signWebhook } from '@wirebench/engine';
import type { SignatureScheme } from '@wirebench/engine';
import * as repo from '../../../src/hooks/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCatchUrl, seedSignature, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const MIB = 1024 * 1024;
const KEY_ENV = { WIREBENCH_SERVER_HOOKS_SECRET_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=' };
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const BODY = Buffer.from('{"event":"order.created"}');
const CONFIGURED_BODY = '{"accepted":true}';

interface Cast {
  readonly h: HooksHarness;
  readonly hook: repo.CatchUrlRow;
  readonly lines: string[];
}

async function setUp(
  options: {
    readonly env?: Record<string, string>;
    readonly sealKey?: Buffer;
    readonly rejectUnverified?: boolean;
    readonly delayMs?: number;
    readonly signed?: boolean;
  } = {},
): Promise<Cast> {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf-8'));
      callback();
    },
  });
  const h = await hooksHarness({
    env: { ...KEY_ENV, WIREBENCH_SERVER_LOG_LEVEL: 'info', ...options.env },
    logStream,
  });
  const team = await seedTeam(h, { name: 'Payments QA' });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const hook = await seedCatchUrl(h, workspaceId, 'Signed', {
    response: { status: 202, contentType: 'application/json', body: CONFIGURED_BODY, delayMs: options.delayMs ?? 0 },
  });
  if (options.signed !== false) {
    await seedSignature(h, hook.id, {
      scheme: HMAC,
      secret: SECRET,
      key: options.sealKey ?? Buffer.alloc(32, 7),
      rejectUnverified: options.rejectUnverified ?? false,
    });
  }
  return { h, hook, lines };
}

const deliver = (c: Cast, body: Buffer, headers: Record<string, string> = {}) =>
  c.h.app.inject({
    method: 'POST',
    url: `/hooks/${c.hook.secret}/orders`,
    headers: { 'content-type': 'application/octet-stream', ...headers },
    payload: body,
  });
const signedHeaders = (body: Buffer, secret = SECRET): Record<string, string> =>
  Object.fromEntries(signWebhook(HMAC, secret, body));
const newest = async (c: Cast): Promise<repo.CaptureRow> => {
  const [summary] = await repo.listCaptures(c.h.db, c.hook.id, {}, 1);
  return (await repo.captureById(c.h.db, c.hook.id, summary!.id))!;
};

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the public route: signatures (§3.3)', () => {
  it('records verified, failed and not-checked captures', async () => {
    c = await setUp();
    expect((await deliver(c, BODY, signedHeaders(BODY))).statusCode).toBe(202);
    expect((await newest(c)).signature).toEqual({ verdict: 'verified' });
    await deliver(c, BODY, signedHeaders(BODY, 'zzz999yyy888xxx777'));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'mismatch' });
    await deliver(c, BODY);
    expect(await newest(c)).toMatchObject({
      signature: { verdict: 'failed', reason: 'missing-header' },
      rejected: false,
    });
    await c.h.close();
    c = await setUp({ signed: false });
    await deliver(c, BODY, signedHeaders(BODY));
    expect(await newest(c)).toMatchObject({ signature: null, rejected: false });
  });

  it('verifies the full body before truncating it', async () => {
    c = await setUp({ env: { WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '1' } });
    const large = Buffer.alloc(1.5 * MIB, 0x61);
    expect((await deliver(c, large, signedHeaders(large))).statusCode).toBe(202);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'verified' }, truncated: true, bodySize: 1.5 * MIB });
  });

  it('answers 401 at once when rejecting, and still stores the capture', async () => {
    c = await setUp({ rejectUnverified: true, delayMs: 30_000 });
    const rejected = await deliver(c, BODY);
    expect([rejected.statusCode, rejected.body]).toEqual([401, '']);
    expect(await newest(c)).toMatchObject({
      signature: { verdict: 'failed', reason: 'missing-header' },
      rejected: true,
    });
    await repo.updateCatchUrl(c.h.db, c.hook.id, { response: { delayMs: 0 } });
    const accepted = await deliver(c, BODY, signedHeaders(BODY));
    expect([accepted.statusCode, accepted.body]).toEqual([202, CONFIGURED_BODY]);
    expect(await newest(c)).toMatchObject({ signature: { verdict: 'verified' }, rejected: false });
  });

  it('records key-error under a wrong key and with no key, logging without the secret', async () => {
    c = await setUp({ sealKey: Buffer.alloc(32, 9) });
    await deliver(c, BODY, signedHeaders(BODY));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'key-error' });
    expect(c.lines.some((line) => line.includes('could not open a catch URL signature secret'))).toBe(true);
    expect(c.lines.join('')).not.toContain(SECRET);
    await c.h.close();
    c = await setUp({ env: { WIREBENCH_SERVER_HOOKS_SECRET_KEY: '' } });
    await deliver(c, BODY, signedHeaders(BODY));
    expect((await newest(c)).signature).toEqual({ verdict: 'failed', reason: 'key-error' });
  });

  it('never puts the secret in a response or a log line', async () => {
    c = await setUp();
    const answered = await deliver(c, BODY, signedHeaders(BODY));
    // Content first, so the absence checks below cannot pass on an empty response or an empty log.
    expect([answered.statusCode, answered.body]).toEqual([202, CONFIGURED_BODY]);
    expect(JSON.stringify(answered.headers)).not.toContain(SECRET);
    expect(answered.body).not.toContain(SECRET);
    const wrongKey = await setUp({ sealKey: Buffer.alloc(32, 9) });
    try {
      await deliver(wrongKey, BODY, signedHeaders(BODY));
      // The wrong-key path logs an error naming this catch URL, so the log is known to be non-empty.
      const logged = wrongKey.lines.join('');
      expect(logged).toContain('could not open a catch URL signature secret');
      expect(logged).toContain(wrongKey.hook.id);
      expect(logged).not.toContain(SECRET);
    } finally {
      await wrongKey.h.close();
    }
    // The request itself was logged (info level), so this log is not empty either.
    expect(c.lines.join('')).toContain('/hooks/');
    expect(c.lines.join('')).not.toContain(SECRET);
  });
});
