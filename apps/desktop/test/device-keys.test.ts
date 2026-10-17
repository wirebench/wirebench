// @vitest-environment node
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDeviceKey } from '@wirebench/ssh';
import type { ParsedDeviceKey } from '@wirebench/ssh';
import {
  DEVICE_HELPER_FILE,
  DeviceHelper,
  DeviceHelperError,
  DeviceKeys,
  windowsHelperArgs,
} from '../src/main/device-keys.js';

const HELPER_SCRIPT = join(__dirname, '..', 'native', 'device-helper', 'windows', 'device-helper.ps1');

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void };

/** A child that answers `answers(command, request)` once its request is in, or never for `undefined`. */
function fakeSpawn(answers: (command: string, request: string) => string | undefined) {
  const calls: { command: string; request: string }[] = [];
  const spawn = vi.fn((_file: string, args: readonly string[]): FakeChild => {
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => {
        child.emit('close', null);
      }),
    });
    const command = args[0] ?? '';
    let request = '';
    child.stdin.on('data', (chunk: Buffer) => (request += chunk.toString('utf8')));
    child.stdin.on('end', () => {
      calls.push({ command, request });
      const answer = answers(command, request);
      if (answer === undefined) return;
      setImmediate(() => {
        child.stdout.end(answer);
        child.stdout.on('end', () => child.emit('close', 0));
        child.stdout.resume();
      });
    });
    return child;
  });
  return { spawn, calls };
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A folder holding a helper file, so the runner finds one. */
function helperDir(platform: 'darwin' | 'win32' = 'darwin'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-helper-'));
  dirs.push(dir);
  writeFileSync(join(dir, DEVICE_HELPER_FILE[platform] as string), platform === 'win32' ? '# script' : '');
  return dir;
}

describe('DeviceHelper', () => {
  it('sends the request as JSON and answers the helper’s JSON', async () => {
    const { spawn, calls } = fakeSpawn(() => '{"present":true}');
    const helper = new DeviceHelper({ platform: 'darwin', dir: helperDir(), spawn: spawn as never });
    await expect(helper.run('check', { handle: 'h' })).resolves.toEqual({ present: true });
    expect(calls).toEqual([{ command: 'check', request: '{"handle":"h"}' }]);
  });

  it('maps the helper’s error answers, and unknown or unreadable ones to failed', async () => {
    const answers = [
      '{"error":"cancelled","message":"The prompt was cancelled"}',
      '{"error":"weird","message":"?"}',
      'not json',
    ];
    const { spawn } = fakeSpawn(() => answers.shift());
    const helper = new DeviceHelper({ platform: 'darwin', dir: helperDir(), spawn: spawn as never });
    await expect(helper.run('status')).rejects.toMatchObject({
      reason: 'cancelled',
      message: 'The prompt was cancelled',
    });
    await expect(helper.run('status')).rejects.toMatchObject({ reason: 'failed' });
    await expect(helper.run('status')).rejects.toMatchObject({ reason: 'failed', message: /cannot read/ });
  });

  it('is unsupported with no helper file, and on Linux', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wb-helper-'));
    dirs.push(empty);
    await expect(new DeviceHelper({ platform: 'darwin', dir: empty }).run('status')).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(new DeviceHelper({ platform: 'linux', dir: helperDir() }).run('status')).rejects.toBeInstanceOf(
      DeviceHelperError,
    );
  });

  it('gives up on a helper that does not answer in time, and kills it', async () => {
    const { spawn } = fakeSpawn(() => undefined);
    const helper = new DeviceHelper({
      platform: 'darwin',
      dir: helperDir(),
      spawn: spawn as never,
      timeouts: { prompt: 30, quick: 10 },
    });
    await expect(helper.run('status')).rejects.toMatchObject({ message: 'The device did not answer in time' });
    await expect(helper.run('sign', {})).rejects.toMatchObject({ message: 'The prompt was not answered in time' });
  });

  it('runs one prompt at a time', async () => {
    const pending: (() => void)[] = [];
    const order: string[] = [];
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        kill: vi.fn(),
      });
      order.push(`start ${args[0] ?? ''}`);
      pending.push(() => {
        order.push(`end ${args[0] ?? ''}`);
        child.stdout.end('{"ok":true}');
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    });
    const helper = new DeviceHelper({ platform: 'darwin', dir: helperDir(), spawn: spawn as never });
    const first = helper.run('sign', {});
    const second = helper.run('unlock', {});
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await first;
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()?.();
    await second;
    expect(order).toEqual(['start sign', 'end sign', 'start unlock', 'end unlock']);
  });

  it.skipIf(process.platform === 'win32')('runs a real helper program', async () => {
    const dir = helperDir();
    const file = join(dir, DEVICE_HELPER_FILE.darwin as string);
    writeFileSync(file, '#!/bin/sh\nread request\nprintf \'{"command":"%s","request":%s}\' "$1" "$request"\n');
    chmodSync(file, 0o755);
    await expect(new DeviceHelper({ platform: 'darwin', dir }).run('check', { handle: 'x' })).resolves.toEqual({
      command: 'check',
      request: { handle: 'x' },
    });
  });

  it('runs the Windows script through -EncodedCommand, within the command-line limit', () => {
    const script = readFileSync(HELPER_SCRIPT, 'utf8');
    const request = JSON.stringify({ handle: 'wirebench-x', data: 'A'.repeat(2048), reason: 'sign in to u@h' });
    const args = windowsHelperArgs(script, 'sign', request);
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const decoded = Buffer.from(args[3] ?? '', 'base64').toString('utf16le');
    expect(decoded.startsWith(script)).toBe(true);
    expect(decoded).toMatch(/\nInvoke-DeviceHelper 'sign' '[A-Za-z0-9+/=]+'\n$/);
    expect(['powershell.exe', ...args].join(' ').length).toBeLessThan(32_767);
  });
});

/** A helper whose answer a test sets per command. */
function scripted(answers: Partial<Record<string, Record<string, unknown> | Error>>) {
  const run = vi.fn<(command: string, request?: Record<string, unknown>) => Promise<Record<string, unknown>>>(
    (command) => {
      const answer = answers[command];
      if (answer instanceof Error) return Promise.reject(answer);
      return answer === undefined ? Promise.reject(new Error(`unexpected ${command}`)) : Promise.resolve(answer);
    },
  );
  return { run };
}

const point = (): Buffer =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);

describe('DeviceKeys', () => {
  it('says what this machine makes, and asks only once', async () => {
    const helper = scripted({ status: { supported: true } });
    const keys = new DeviceKeys(helper, 'darwin');
    await expect(keys.status()).resolves.toEqual({
      supported: true,
      platform: 'macos-secure-enclave',
      keyType: 'ecdsa-sha2-nistp256',
    });
    await keys.status();
    expect(helper.run).toHaveBeenCalledTimes(1);
    const none = new DeviceKeys(scripted({ status: { supported: false, reason: 'no enclave' } }), 'darwin');
    await expect(none.status()).resolves.toMatchObject({ supported: false, reason: 'no enclave' });
    await expect(new DeviceKeys(scripted({}), 'linux').status()).resolves.toMatchObject({ supported: false });
  });

  it('makes a Secure Enclave key as a block naming this device', async () => {
    const helper = scripted({ create: { publicKey: point().toString('base64'), handle: 'SEHANDLE' } });
    const block = await new DeviceKeys(helper, 'darwin', () => 'work-laptop').create('me@work-laptop');
    const key = parseDeviceKey(block);
    expect(key).toMatchObject({
      platform: 'macos-secure-enclave',
      device: 'work-laptop',
      handle: 'SEHANDLE',
      keyType: 'ecdsa-sha2-nistp256',
    });
    expect(key?.publicKey.endsWith(' me@work-laptop')).toBe(true);
    expect(helper.run).toHaveBeenCalledWith('create', { label: 'me@work-laptop' });
  });

  it('makes a Windows Hello key from its SPKI', async () => {
    const spki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    const helper = scripted({ create: { publicKey: spki.toString('base64'), handle: 'wirebench-1' } });
    const key = parseDeviceKey(await new DeviceKeys(helper, 'win32', () => 'desk').create(''));
    expect(key).toMatchObject({ platform: 'windows-hello', keyType: 'ssh-rsa', handle: 'wirebench-1' });
  });

  it('turns create refusals into SSH errors', async () => {
    const cancelled = scripted({ create: new DeviceHelperError('cancelled', 'x') });
    await expect(new DeviceKeys(cancelled, 'darwin').create('')).rejects.toMatchObject({
      code: 'ssh-device-key-cancelled',
    });
    const locked = scripted({ create: new DeviceHelperError('failed', 'Unlock this Mac and try again') });
    await expect(new DeviceKeys(locked, 'darwin').create('')).rejects.toMatchObject({
      code: 'ssh-device-key-unavailable',
      message: 'Unlock this Mac and try again',
    });
    await expect(new DeviceKeys(scripted({}), 'linux').create('')).rejects.toMatchObject({
      code: 'ssh-device-key-unavailable',
    });
  });

  async function madeHere(): Promise<ParsedDeviceKey> {
    const helper = scripted({ create: { publicKey: point().toString('base64'), handle: 'H' } });
    return parseDeviceKey(await new DeviceKeys(helper, 'darwin', () => 'work-laptop').create('c')) as ParsedDeviceKey;
  }

  it('signs through the helper, and maps its refusals', async () => {
    const key = await madeHere();
    const signature = Buffer.alloc(64, 9);
    const helper = scripted({ sign: { signature: signature.toString('base64') } });
    const keys = new DeviceKeys(helper, 'darwin');
    await expect(keys.sign(key, Buffer.from('data'), 'sign in to u@h')).resolves.toEqual(signature);
    expect(helper.run).toHaveBeenCalledWith('sign', {
      handle: 'H',
      data: Buffer.from('data').toString('base64'),
      reason: 'sign in to u@h',
    });
    const missing = scripted({ sign: new DeviceHelperError('missing', 'gone') });
    await expect(new DeviceKeys(missing, 'darwin').sign(key, Buffer.alloc(1), 'r')).rejects.toMatchObject({
      code: 'ssh-device-key-missing',
      message: 'This key lives on another device (made on work-laptop)',
      details: { device: 'work-laptop' },
    });
    const cancelled = scripted({ sign: new DeviceHelperError('cancelled', 'x') });
    await expect(new DeviceKeys(cancelled, 'darwin').sign(key, Buffer.alloc(1), 'r')).rejects.toMatchObject({
      code: 'ssh-device-key-cancelled',
    });
  });

  it('reports a key of another platform as missing without asking the helper', async () => {
    const key = await madeHere();
    const helper = scripted({});
    const windows = new DeviceKeys(helper, 'win32');
    await expect(windows.sign(key, Buffer.alloc(1), 'r')).rejects.toMatchObject({ code: 'ssh-device-key-missing' });
    await expect(windows.isHere(key)).resolves.toBe(false);
    expect(helper.run).not.toHaveBeenCalled();
  });

  it('checks whether the hardware here holds a key', async () => {
    const key = await madeHere();
    await expect(new DeviceKeys(scripted({ check: { present: true } }), 'darwin').isHere(key)).resolves.toBe(true);
    await expect(new DeviceKeys(scripted({ check: { present: false } }), 'darwin').isHere(key)).resolves.toBe(false);
    await expect(new DeviceKeys(scripted({ check: new Error('x') }), 'darwin').isHere(key)).resolves.toBe(false);
  });
});

// The real script on a Windows runner: Hello is not set up there, so `status` should answer unsupported.
describe.skipIf(process.platform !== 'win32')('the Windows helper script', () => {
  it('answers status in the protocol’s shape', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-helper-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'device-helper.ps1'), readFileSync(HELPER_SCRIPT));
    const answer = await new DeviceHelper({ platform: 'win32', dir }).run('status');
    expect(typeof answer['supported']).toBe('boolean');
    if (answer['supported'] === false) expect(typeof answer['reason']).toBe('string');
  });
});
