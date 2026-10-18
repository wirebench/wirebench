import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_FILE, buildDeviceHelper, checkPackedHelper } from './build-device-helper.ts';

const hasSwift = (): boolean => {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Runs the built helper as main does: one JSON request on stdin, one JSON answer on stdout. */
function ask(file: string, command: string, request: unknown = {}): Record<string, unknown> {
  let out: string;
  try {
    out = execFileSync(file, [command], { input: JSON.stringify(request), encoding: 'utf8' });
  } catch (error) {
    const { stdout } = error as { stdout?: string | Buffer };
    out = stdout === undefined ? '' : stdout.toString();
  }
  return JSON.parse(out) as Record<string, unknown>;
}

describe('build-device-helper', () => {
  it('copies the Windows script, and builds nothing for Linux', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-helper-out-'));
    try {
      const dir = join(root, 'device-helper');
      expect(await buildDeviceHelper('linux', dir)).toBeUndefined();
      const script = await buildDeviceHelper('win32', dir);
      expect(script).toBe(join(dir, HELPER_FILE.win32));
      expect(readFileSync(script as string, 'utf8')).toContain('function Invoke-DeviceHelper');
      expect(checkPackedHelper('win32', root)).toEqual([]);
      expect(checkPackedHelper('darwin', root)).toEqual([`${join(dir, HELPER_FILE.darwin)} is missing`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The real Swift helper, built as the release builds it. CI's macOS VMs have no Secure Enclave, so there it
// answers unsupported; on a Mac with one, a key is made (asking for nothing) and its handle checked.
describe.skipIf(!hasSwift())('the macOS device helper', { timeout: 240_000 }, () => {
  let root: string;
  let file: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wb-helper-mac-'));
    file = (await buildDeviceHelper('darwin', join(root, 'device-helper'))) as string;
  }, 240_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is one universal binary', () => {
    expect(existsSync(file)).toBe(true);
    expect(checkPackedHelper('darwin', root)).toEqual([]);
  });

  it('answers the protocol', () => {
    const status = ask(file, 'status');
    expect(typeof status['supported']).toBe('boolean');
    expect(ask(file, 'check', { handle: Buffer.from('not a key').toString('base64') })).toEqual({ present: false });
    expect(ask(file, 'sign', { handle: 'AAAA', data: 'AAAA', reason: 'x' })).toMatchObject({
      error: status['supported'] === true ? 'missing' : 'unsupported',
    });
    expect(ask(file, 'nonsense')).toMatchObject({ error: 'failed' });
    if (status['supported'] !== true) return;
    const made = ask(file, 'create', { label: 'test' });
    // A locked Mac cannot make a key; that is an answer too.
    if (made['error'] !== undefined) {
      expect(made).toMatchObject({ error: 'failed', message: 'Unlock this Mac and try again' });
      return;
    }
    expect(Buffer.from(String(made['publicKey']), 'base64')).toHaveLength(65);
    expect(ask(file, 'check', { handle: made['handle'] })).toEqual({ present: true });
  });
});
