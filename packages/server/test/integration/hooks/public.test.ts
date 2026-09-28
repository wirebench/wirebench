/**
 * The public route (webhook-capture spec §3.3, §7): real Fastify, real PostgreSQL. Most requests go
 * through `inject`; repeated headers and the source address go over a real socket, because only
 * Node's HTTP client sends two header lines with one name.
 */
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CaptureReceived } from '../../../src/context.js';
import * as repo from '../../../src/hooks/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCatchUrl, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const MIB = 1024 * 1024;

interface Cast {
  readonly h: HooksHarness;
  readonly workspaceId: string;
  readonly hook: repo.CatchUrlRow;
  readonly heard: CaptureReceived[];
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const team = await seedTeam(h, { name: 'Payments QA' });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const hook = await seedCatchUrl(h, workspaceId, 'Payments');
  const heard: CaptureReceived[] = [];
  h.hooks.captureReceived.push((event) => {
    heard.push(event);
  });
  return { h, workspaceId, hook, heard };
}

async function stored(c: Cast): Promise<repo.CaptureRow[]> {
  const page = await repo.listCaptures(c.h.db, c.hook.id, {}, 200);
  const rows: repo.CaptureRow[] = [];
  for (const summary of page) rows.push((await repo.captureById(c.h.db, c.hook.id, summary.id))!);
  return rows;
}

const header = (row: repo.CaptureRow, name: string): string[] =>
  row.headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the public route: bodies and headers (§3.3 steps 1, 4, 6)', () => {
  beforeEach(async () => {
    c = await setUp();
  });

  it('stores a JSON POST with its subpath, query and headers, answers 200 with nothing, and announces after commit', async () => {
    const { h, hook, workspaceId, heard } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/payments/events?a=1&a=2`,
      headers: { 'content-type': 'application/json', 'x-signature': 't=1,v1=abc' },
      payload: '{"id":"evt_1"}',
      remoteAddress: '203.0.113.9',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBeUndefined();
    const [row] = await stored(c!);
    expect(row).toMatchObject({
      method: 'POST',
      subpath: '/payments/events',
      query: 'a=1&a=2',
      bodySize: 14,
      truncated: false,
      sourceIp: '203.0.113.9',
      receivedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(row!.body.toString('utf8')).toBe('{"id":"evt_1"}');
    expect(header(row!, 'x-signature')).toEqual(['t=1,v1=abc']);
    expect(heard).toEqual([{ workspaceId, hookId: hook.id, captureId: row!.id }]);
  });

  it('stores form, binary and empty bodies byte for byte, on every method and with no subpath', async () => {
    const { h, hook } = c!;
    const binary = Buffer.from([0, 0xff, 0x10, 0x80, 0x7f]);
    await h.app.inject({
      method: 'PUT',
      url: `/hooks/${hook.secret}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&b=%20',
    });
    await h.app.inject({
      method: 'PATCH',
      url: `/hooks/${hook.secret}/`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: binary,
    });
    await h.app.inject({ method: 'DELETE', url: `/hooks/${hook.secret}/x` });
    await h.app.inject({ method: 'GET', url: `/hooks/${hook.secret}/ping?probe=1` });
    const rows = (await stored(c!)).reverse();
    expect(rows.map((row) => [row.method, row.subpath, row.body.toString('hex'), row.bodySize])).toEqual([
      ['PUT', '', Buffer.from('a=1&b=%20').toString('hex'), 9],
      ['PATCH', '/', binary.toString('hex'), 5],
      ['DELETE', '/x', '', 0],
      ['GET', '/ping', '', 0],
    ]);
  });

  it('passes an Authorization header through as data: identity never runs here', async () => {
    const { h, hook } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}`,
      headers: { authorization: 'Bearer not-a-wirebench-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(header((await stored(c!))[0]!, 'authorization')).toEqual(['Bearer not-a-wirebench-token']);
  });

  it('keeps repeated headers in arrival order and records the peer address', async () => {
    const { h, hook } = c!;
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1',
        port: h.port,
        path: `/hooks/${hook.secret}/r`,
        method: 'POST',
        agent: false,
      });
      outgoing.setHeader('Via', ['1.1 first', '1.1 second']);
      outgoing.setHeader('X-Trace', 'one');
      outgoing.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on('error', reject);
      outgoing.end('x');
    });
    expect(status).toBe(200);
    const [row] = await stored(c!);
    expect(header(row!, 'via')).toEqual(['1.1 first', '1.1 second']);
    expect(row!.sourceIp).toBe('127.0.0.1');
  });
});

describeDb('the public route: truncation and the body limit (§3.3 step 1)', () => {
  beforeEach(async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '1', WIREBENCH_SERVER_BODY_LIMIT_MB: '2' });
  });

  it('stores exactly the limit whole, cuts one byte more, and still answers as configured', async () => {
    const { h, hook } = c!;
    await repo.updateCatchUrl(h.db, hook.id, { response: { status: 202 } });
    const exact = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/a`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MIB, 1),
    });
    const over = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/b`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MIB + 1, 2),
    });
    expect([exact.statusCode, over.statusCode]).toEqual([202, 202]);
    const [b, a] = await stored(c!);
    expect([a!.subpath, a!.body.length, a!.bodySize, a!.truncated]).toEqual(['/a', MIB, MIB, false]);
    expect([b!.subpath, b!.body.length, b!.bodySize, b!.truncated]).toEqual(['/b', MIB, MIB + 1, true]);
  });

  it("answers 413 past the server's general limit and stores nothing", async () => {
    const { h, hook, heard } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * MIB + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(await stored(c!)).toEqual([]);
    expect(heard).toEqual([]);
  });
});

describeDb('the public route: the configured answer (§3.3 step 6, §5)', () => {
  beforeEach(async () => {
    c = await setUp();
  });

  it('sends the configured status, content type and body, echoing nothing', async () => {
    const { h, hook } = c!;
    await repo.updateCatchUrl(h.db, hook.id, {
      response: { status: 201, contentType: 'application/json', body: '{"received":true}' },
    });
    const res = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'secret-payload' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBe('{"received":true}');
    expect(JSON.stringify(res.headers)).not.toContain('secret-payload');
  });

  it('waits the configured delay on a timer, after the capture is stored and announced', async () => {
    const { h, hook, heard } = c!;
    await repo.updateCatchUrl(h.db, hook.id, { response: { delayMs: 1500 } });
    let answered = false;
    const pending = h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` }).then((res) => {
      answered = true;
      return res;
    });
    await expect.poll(() => h.timers.pending(1500)).toBe(1);
    expect(answered).toBe(false);
    expect(await stored(c!)).toHaveLength(1);
    expect(heard).toHaveLength(1);
    expect(h.timers.fire(1500)).toBe(1);
    expect((await pending).statusCode).toBe(200);
  });
});

describeDb('the public route: refusals (§3.3 steps 2, 3, 5)', () => {
  it('answers a bare 404 for an unknown, a malformed, a disabled and a rotated secret', async () => {
    c = await setUp();
    const { h, workspaceId, heard } = c;
    const disabled = await seedCatchUrl(h, workspaceId, 'Off', { enabled: false });
    const rotated = await seedCatchUrl(h, workspaceId, 'Rotated');
    const newSecret = 'Z'.repeat(26);
    await repo.rotateSecret(h.db, rotated.id, newSecret);
    for (const secret of ['0'.repeat(26), 'not-a-secret', disabled.secret, rotated.secret]) {
      const res = await h.app.inject({ method: 'POST', url: `/hooks/${secret}/x`, payload: 'x' });
      expect([res.statusCode, res.body]).toEqual([404, '']);
    }
    // The rotated catch URL still answers, on its new URL only.
    expect((await h.app.inject({ method: 'POST', url: `/hooks/${newSecret}` })).statusCode).toBe(200);
    expect((await repo.listCaptures(h.db, disabled.id, {}, 10)).length).toBe(0);
    expect(heard.map((event) => event.hookId)).toEqual([rotated.id]);
  });

  it('answers 429 with Retry-After: 1 past the burst, stores nothing then, and refills with time', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_BURST: '2', WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND: '1' });
    const { h, hook } = c;
    const post = () => h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` });
    expect([(await post()).statusCode, (await post()).statusCode]).toEqual([200, 200]);
    const refused = await post();
    expect([refused.statusCode, refused.headers['retry-after'], refused.body]).toEqual([429, '1', '']);
    expect(await stored(c)).toHaveLength(2);
    h.clock.advance(1000);
    expect((await post()).statusCode).toBe(200);
  });

  it('answers 503 with Retry-After: 30 when storing fails, announces nothing, and recovers', async () => {
    c = await setUp();
    const { h, hook, heard } = c;
    await h.db.query('alter table captures rename to captures_away');
    const res = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'x' });
    expect([res.statusCode, res.headers['retry-after'], res.body]).toEqual([503, '30', '']);
    await h.db.query('alter table captures_away rename to captures');
    await h.db.query('alter table catch_urls rename to catch_urls_away');
    const lookup = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'x' });
    expect([lookup.statusCode, lookup.headers['retry-after']]).toEqual([503, '30']);
    await h.db.query('alter table catch_urls_away rename to catch_urls');
    expect(heard).toEqual([]);
    expect((await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` })).statusCode).toBe(200);
  });

  it('keeps the newest KEEP captures: the one past it prunes the oldest in the same transaction', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_KEEP: '3' });
    const { h, hook } = c;
    for (const n of [1, 2, 3, 4]) await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}/${n}` });
    expect((await stored(c)).map((row) => row.subpath)).toEqual(['/4', '/3', '/2']);
  });
});
