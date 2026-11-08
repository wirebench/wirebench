// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { AccountService } from '../src/account-service.js';
import type { LoopbackCallback } from '../src/loopback-callback.js';
import type { ServerClient } from '../src/server-client.js';

const URL_A = 'https://wb.test';
const USER = { id: '01J8Z0000000000000000000AB', email: 'alice@example.com', displayName: 'Alice', serverAdmin: false };
const TOKEN = `wbs_${'A'.repeat(43)}`;
const CHALLENGE = 'C'.repeat(43);
const PASSWORD = 'pw'.repeat(6);

function fakeSecrets() {
  const entries = new Map<string, string>();
  let n = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.set is async; this fake has no await
    set: vi.fn(async (value: string) => {
      const ref = `sec_${String(++n).padStart(26, '0')}`;
      entries.set(ref, value);
      return ref;
    }),
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.get is async; this fake has no await
    get: vi.fn(async (ref: string) => entries.get(ref)),
    // eslint-disable-next-line @typescript-eslint/require-await -- SecretStore.delete is async; this fake has no await
    delete: vi.fn(async (ref: string) => entries.delete(ref)),
  };
}

function fakeClient(overrides: Partial<Record<keyof ServerClient, unknown>> = {}): ServerClient {
  return {
    signInLocal: vi.fn().mockResolvedValue({
      twoFactor: { challenge: CHALLENGE, methods: ['totp', 'passkey', 'recovery'], setup: false },
    }),
    verifyTwoFactor: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    startTwoFactorPasskey: vi.fn().mockResolvedValue({ url: `${URL_A}/sign-in/two-factor/passkey?flow=FLOW1` }),
    completeTwoFactorPasskey: vi.fn().mockResolvedValue({ token: TOKEN, user: USER }),
    setUpTotp: vi.fn().mockResolvedValue({ uri: 'otpauth://totp/x', qrSvg: '<svg/>', secret: 'ABCD' }),
    confirmTotpSetup: vi.fn().mockResolvedValue({ token: TOKEN, user: USER, recoveryCodes: ['aaaaa-bbbbb'] }),
    ...overrides,
  } as unknown as ServerClient;
}

function fakeLoopback() {
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
  const listener: LoopbackCallback = {
    redirectUri: 'http://127.0.0.1:49152/callback',
    port: 49152,
    result: new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }),
    cancel: vi.fn(() => settle?.reject(new WirebenchError('loopback-cancelled', 'cancelled'))),
  };
  return {
    listener,
    // eslint-disable-next-line @typescript-eslint/require-await -- startLoopbackCallback is async; this fake has no await
    start: vi.fn(async () => listener),
    answer: (params: Record<string, string>) => settle?.resolve(new URLSearchParams(params)),
  };
}

describe('AccountService, two-step sign-in (two-step sign-in spec §4.2, §4.3)', () => {
  let dir: string;
  let clock: Date;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-accounts-2fa-'));
    clock = new Date('2026-11-07T12:00:00.000Z');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const service = (
    client: ServerClient,
    loopback = fakeLoopback(),
    openExternal = vi.fn().mockResolvedValue(undefined),
  ) =>
    new AccountService({
      userDataDir: dir,
      client,
      secrets: fakeSecrets(),
      loopback: loopback.start,
      openExternal,
      defaultDeviceName: () => 'test-host',
      now: () => clock,
    });
  const password = (s: AccountService) =>
    s.signInLocal({ url: URL_A, identifier: 'alice@example.com', password: PASSWORD });

  it('signInLocal holds the challenge and answers the methods only', async () => {
    const s = service(fakeClient());
    const step = await password(s);
    expect(step).toEqual({ twoFactor: { methods: ['totp', 'passkey', 'recovery'], setup: false } });
    expect(JSON.stringify(step)).not.toContain(CHALLENGE);
    expect(s.list()).toEqual([]);
  });

  it('verifyTwoFactor finishes the sign-in and stores the account', async () => {
    const verify = vi.fn().mockResolvedValue({ token: TOKEN, user: USER });
    const s = service(fakeClient({ verifyTwoFactor: verify }));
    await password(s);
    const account = await s.verifyTwoFactor({ method: 'totp', code: '123456' });
    expect(account).toMatchObject({ url: URL_A, userId: USER.id, deviceName: 'test-host' });
    expect(verify).toHaveBeenCalledWith(URL_A, { challenge: CHALLENGE, method: 'totp', code: '123456' });
    expect(await s.tokenFor(URL_A)).toBe(TOKEN);
    // The step is spent.
    await expect(s.verifyTwoFactor({ method: 'totp', code: '123456' })).rejects.toMatchObject({
      code: 'account-two-factor-expired',
    });
  });

  it('a wrong code keeps the step; an ended challenge drops it', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new WirebenchError('identity-two-factor-invalid', 'That code did not work.'))
      .mockRejectedValueOnce(new WirebenchError('identity-two-factor-expired', 'Sign in again.'));
    const s = service(fakeClient({ verifyTwoFactor: verify }));
    await password(s);
    await expect(s.verifyTwoFactor({ method: 'totp', code: '000000' })).rejects.toMatchObject({
      code: 'identity-two-factor-invalid',
    });
    await expect(s.verifyTwoFactor({ method: 'totp', code: '000000' })).rejects.toMatchObject({
      code: 'identity-two-factor-expired',
    });
    await expect(s.verifyTwoFactor({ method: 'totp', code: '000000' })).rejects.toMatchObject({
      code: 'account-two-factor-expired',
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('the passkey hand-off opens the browser and completes with the grant; cancel ends it', async () => {
    const start = vi.fn().mockResolvedValue({ url: `${URL_A}/sign-in/two-factor/passkey?flow=FLOW1` });
    const complete = vi.fn().mockResolvedValue({ token: TOKEN, user: USER });
    const loopback = fakeLoopback();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const s = service(
      fakeClient({ startTwoFactorPasskey: start, completeTwoFactorPasskey: complete }),
      loopback,
      openExternal,
    );
    await password(s);
    const signing = s.startTwoFactorPasskey();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(`${URL_A}/sign-in/two-factor/passkey?flow=FLOW1`));
    expect(start.mock.calls[0]![1]).toMatchObject({ challenge: CHALLENGE, loopbackPort: 49152 });
    loopback.answer({ flow: 'FLOW1', grant: 'G'.repeat(43) });
    expect(await signing).toMatchObject({ url: URL_A, userId: USER.id });
    const body = complete.mock.calls[0]![1] as { flowId: string; grant: string; codeVerifier: string };
    expect(body).toMatchObject({ flowId: 'FLOW1', grant: 'G'.repeat(43) });
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    // Cancel: the loopback ends, and the dialog's Back drops the step.
    const second = fakeLoopback();
    const t = service(fakeClient(), second);
    await password(t);
    const waiting = t.startTwoFactorPasskey();
    await vi.waitFor(() => expect(second.start).toHaveBeenCalled());
    expect(t.cancelSignIn()).toEqual({ cancelled: true });
    await expect(waiting).rejects.toMatchObject({ code: 'account-sign-in-cancelled' });
    t.cancelTwoFactor();
    await expect(t.verifyTwoFactor({ method: 'totp', code: '1' })).rejects.toMatchObject({
      code: 'account-two-factor-expired',
    });
  });

  it('a pending step is dropped after five minutes', async () => {
    const s = service(fakeClient());
    await password(s);
    clock = new Date(clock.getTime() + 5 * 60_000);
    await expect(s.verifyTwoFactor({ method: 'totp', code: '123456' })).rejects.toMatchObject({
      code: 'account-two-factor-expired',
    });
  });

  it('the required setup: an authenticator under the challenge, then the account and its codes', async () => {
    const setUp = vi.fn().mockResolvedValue({ uri: 'otpauth://totp/x', qrSvg: '<svg/>', secret: 'ABCD' });
    const s = service(
      fakeClient({
        signInLocal: vi.fn().mockResolvedValue({ twoFactor: { challenge: CHALLENGE, methods: [], setup: true } }),
        setUpTotp: setUp,
      }),
    );
    expect(await password(s)).toEqual({ twoFactor: { methods: [], setup: true } });
    // A setup step is not a sign-in step.
    await expect(s.verifyTwoFactor({ method: 'totp', code: '1' })).rejects.toMatchObject({
      code: 'account-two-factor-expired',
    });
    await password(s);
    expect(await s.twoFactorSetupStart()).toEqual({ uri: 'otpauth://totp/x', qrSvg: '<svg/>', secret: 'ABCD' });
    expect(setUp).toHaveBeenCalledWith(URL_A, { challenge: CHALLENGE });
    const done = await s.twoFactorSetupConfirm('123456');
    expect(done.recoveryCodes).toEqual(['aaaaa-bbbbb']);
    expect(done.account).toMatchObject({ url: URL_A, userId: USER.id });
    expect(await s.tokenFor(URL_A)).toBe(TOKEN);
  });
});
