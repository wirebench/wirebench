import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;

beforeAll(async () => {
  demo = await startDemoServer();
});

afterAll(async () => {
  await demo.close();
});

beforeEach(() => {
  demo.requests.length = 0;
  demo.secureAuth.length = 0;
});

const base64 = (text: string): string => Buffer.from(text).toString('base64');
const run = (env: Record<string, string>, ...rest: string[]): ReturnType<typeof runCli> =>
  runCli(['run', FIXTURE, '-e', 'local', '--var', `baseUrl=${demo.url}`, 'demo/secure', ...rest], env);
const list = (env: Record<string, string>): ReturnType<typeof runCli> =>
  runCli(['secrets', 'list', FIXTURE, '-e', 'local', 'demo/secure'], env);

describe('secrets from the environment', () => {
  it('authenticates with the declared variable', async () => {
    const { code } = await run({ WIREBENCH_SECRET_DEMO_PASSWORD: 'hunter2-long' });
    expect(code).toBe(0);
    expect(demo.secureAuth).toEqual([`Basic ${base64('svc:hunter2-long')}`]);
  });

  it('falls back to the ref-derived variable', async () => {
    const { code } = await run({ WIREBENCH_SECRET_SEC_DEMO: 'hunter2-long' });
    expect(code).toBe(0);
  });

  it('exits 3 naming the variable, and sends nothing, when neither is set', async () => {
    const { code, stdout, stderr } = await run({});
    expect(code).toBe(3);
    expect(stdout + stderr).toContain(
      'Set WIREBENCH_SECRET_DEMO_PASSWORD (or WIREBENCH_SECRET_SEC_DEMO) to run "demo/secure".',
    );
    expect(demo.requests).not.toContain('/secure');
  });

  it('names the ref-derived variable when a WS-Security password is missing', async () => {
    // The engine raises this as `secret-missing` with `details.ref`, the same as a missing auth
    // password, so the one rewrite covers it; this pins that down end to end.
    const { code, stdout } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      '--var',
      'soapUrl=http://127.0.0.1:1/soap',
      'Echo/Echo/Secured hello',
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain('secret-missing: Set WIREBENCH_SECRET_SEC_WSS to run "Echo/Echo/Secured hello".');
  });

  it('never prints the value, even verbose and failing', async () => {
    const { code, stdout, stderr } = await run({ WIREBENCH_SECRET_DEMO_PASSWORD: 'wrong-pass-long' }, '-v');
    expect(code).toBe(1);
    expect(demo.secureAuth).toEqual([`Basic ${base64('svc:wrong-pass-long')}`]);
    for (const output of [stdout, stderr]) {
      expect(output).not.toContain('wrong-pass-long');
      expect(output).not.toContain(base64('svc:wrong-pass-long'));
    }
  });
});

describe('wirebench secrets list', () => {
  it('exits 3 with a missing row when unset', async () => {
    const { code, stdout } = await list({});
    expect(code).toBe(3);
    const rows = stdout.trim().split('\n').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^WIREBENCH_SECRET_DEMO_PASSWORD\s+missing\s+basic password for "svc"\s+demo\/secure$/);
  });

  it('exits 0 with a set row, never printing the value', async () => {
    const { code, stdout, stderr } = await list({ WIREBENCH_SECRET_DEMO_PASSWORD: 'hunter2-long' });
    expect(code).toBe(0);
    expect(stdout).toMatch(/WIREBENCH_SECRET_DEMO_PASSWORD\s+set\s/);
    expect(stdout + stderr).not.toContain('hunter2-long');
  });

  it('says so when the selection needs no secrets', async () => {
    const { code, stdout } = await runCli(['secrets', 'list', FIXTURE, '-e', 'local', 'demo/ok']);
    expect(code).toBe(0);
    expect(stdout).toContain('No secrets needed.');
  });
});
