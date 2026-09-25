// @vitest-environment node
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startLoopbackCallback } from '../src/main/loopback-callback.js';

const describeOk = (params: URLSearchParams) =>
  params.get('error') === null
    ? { ok: true, message: 'Signed in. You can close this tab.' }
    : { ok: false, message: `Refused (${params.get('error') ?? ''}).` };

/** Whether a TCP connection to `host:port` is accepted. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

describe('startLoopbackCallback', () => {
  it('listens on 127.0.0.1 on a random port, answers the matching callback once, then closes', async () => {
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => 'abc' },
      timeoutMs: 5_000,
      describe: describeOk,
    });
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${String(listener.port)}/callback`);
    const response = await fetch(`${listener.redirectUri}?code=xyz&state=abc`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Signed in.');
    expect((await listener.result).get('code')).toBe('xyz');
    expect(await reachable('127.0.0.1', listener.port)).toBe(false);
  });

  it('answers 400 to a callback whose expected value does not match and stays pending', async () => {
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => 'abc' },
      timeoutMs: 5_000,
      describe: describeOk,
    });
    const wrong = await fetch(`${listener.redirectUri}?code=injected&state=nope`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('did not match');
    const settled = await Promise.race([
      listener.result.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    expect(settled).toBe('pending');
    listener.cancel();
    await expect(listener.result).rejects.toMatchObject({ code: 'loopback-cancelled' });
  });

  it('keeps refusing until the expected value is known, then accepts it', async () => {
    const flow: { value: string | undefined } = { value: undefined };
    const listener = await startLoopbackCallback({
      expected: { name: 'flow', value: () => flow.value },
      timeoutMs: 5_000,
      describe: describeOk,
    });
    expect((await fetch(`${listener.redirectUri}?flow=f1&grant=g`)).status).toBe(400);
    flow.value = 'f1';
    expect((await fetch(`${listener.redirectUri}?flow=f1&grant=g`)).status).toBe(200);
    expect((await listener.result).get('grant')).toBe('g');
  });

  it('renders a refusal with a 400 and escapes what the caller interpolated', async () => {
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => 's' },
      timeoutMs: 5_000,
      describe: describeOk,
    });
    const response = await fetch(
      `${listener.redirectUri}?state=s&error=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect((await listener.result).get('error')).toContain('<script>');
  });

  it('times out with loopback-timeout and frees the port', async () => {
    const listener = await startLoopbackCallback({
      expected: { name: 'state', value: () => 's' },
      timeoutMs: 50,
      describe: describeOk,
    });
    await expect(listener.result).rejects.toMatchObject({ code: 'loopback-timeout' });
    expect(await reachable('127.0.0.1', listener.port)).toBe(false);
  });

  it('honours a fixed port and answers 410 once the flow is over', async () => {
    const first = await startLoopbackCallback({
      expected: { name: 'state', value: () => 's' },
      timeoutMs: 5_000,
      describe: describeOk,
    });
    const port = first.port;
    first.cancel();
    await first.result.catch(() => undefined);
    const second = await startLoopbackCallback({
      expected: { name: 'state', value: () => 's' },
      port,
      timeoutMs: 5_000,
      describe: describeOk,
    });
    expect(second.port).toBe(port);
    await fetch(`${second.redirectUri}?state=s`);
    await second.result;
  });
});
