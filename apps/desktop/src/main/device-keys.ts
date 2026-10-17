import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_KEY_TYPE,
  SshModelError,
  ecdsaP256Blob,
  encodeDeviceKey,
  publicKeyLine,
  sshRsaBlobFromSpki,
} from '@wirebench/ssh';
import type { DeviceKeySigner, DevicePlatform, ParsedDeviceKey } from '@wirebench/ssh';

/**
 * Device keys (#428): SSH keys held by this machine's secure hardware, reached through the device helper, a
 * program shipped beside the app (`native/device-helper/`). Each request runs the helper once: one JSON
 * request in, one JSON answer out. A handle or signature never goes to a log.
 */

export type DeviceHelperCommand = 'status' | 'create' | 'check' | 'sign' | 'unlock';
export type DeviceHelperFailure = 'cancelled' | 'missing' | 'unsupported' | 'failed';

export class DeviceHelperError extends Error {
  constructor(
    readonly reason: DeviceHelperFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceHelperError';
  }
}

/** The helper's file in its folder on each platform that has one. */
export const DEVICE_HELPER_FILE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'wirebench-device-helper',
  win32: 'device-helper.ps1',
};

/** The platform a device key made here is for. */
export const DEVICE_PLATFORM_OF: Partial<Record<NodeJS.Platform, DevicePlatform>> = {
  darwin: 'macos-secure-enclave',
  win32: 'windows-hello',
};

/** A prompt waits for the person; anything else answers at once (PowerShell takes a few seconds to start). */
const PROMPT_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 20_000;
const PROMPTS: ReadonlySet<DeviceHelperCommand> = new Set(['create', 'sign', 'unlock']);
const UNAVAILABLE = 'Device keys are not available on this computer';
const UNREADABLE = 'The device helper answered something Wirebench cannot read';

export interface DeviceHelperDeps {
  readonly platform: NodeJS.Platform;
  /** The folder holding the helper: `Resources/device-helper` packed, `build-resources/device-helper` in dev. */
  readonly dir: string;
  /** Tests inject a fake. */
  readonly spawn?: typeof nodeSpawn;
  readonly timeouts?: { readonly prompt: number; readonly quick: number };
}

/** The PowerShell command line that runs the Windows helper's `command` with `request`. */
export function windowsHelperArgs(script: string, command: DeviceHelperCommand, request: string): string[] {
  const call = `Invoke-DeviceHelper '${command}' '${Buffer.from(request, 'utf8').toString('base64')}'`;
  const encoded = Buffer.from(`${script}\n${call}\n`, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

/** Runs the device helper. Commands that prompt run one at a time, so two prompts never stack up. */
export class DeviceHelper {
  private prompts: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DeviceHelperDeps) {}

  /** The file the helper is in; undefined on a platform without one or when it is not built. */
  get file(): string | undefined {
    const name = DEVICE_HELPER_FILE[this.deps.platform];
    if (name === undefined) return undefined;
    const file = join(this.deps.dir, name);
    return existsSync(file) ? file : undefined;
  }

  /**
   * @throws DeviceHelperError with the helper's own reason, `unsupported` where there is no helper, or
   *   `failed` for a helper that did not answer in time or answered something unreadable
   */
  run(command: DeviceHelperCommand, request: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!PROMPTS.has(command)) return this.exec(command, request);
    const next = this.prompts.then(
      () => this.exec(command, request),
      () => this.exec(command, request),
    );
    this.prompts = next.catch(() => undefined);
    return next;
  }

  private async exec(command: DeviceHelperCommand, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = this.file;
    if (file === undefined) throw new DeviceHelperError('unsupported', UNAVAILABLE);
    const spawn = this.deps.spawn ?? nodeSpawn;
    const json = JSON.stringify(request);
    let child: ReturnType<typeof nodeSpawn>;
    if (this.deps.platform === 'win32') {
      const args = windowsHelperArgs(await readFile(file, 'utf8'), command, json);
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } else {
      child = spawn(file, [command], { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin?.on('error', () => undefined); // a helper that exits early: its answer says why
      child.stdin?.end(json);
    }
    const prompt = PROMPTS.has(command);
    const timeout = prompt
      ? (this.deps.timeouts?.prompt ?? PROMPT_TIMEOUT_MS)
      : (this.deps.timeouts?.quick ?? QUICK_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      const timer = setTimeout(() => {
        if (!settle()) return;
        child.kill();
        const message = prompt ? 'The prompt was not answered in time' : 'The device did not answer in time';
        reject(new DeviceHelperError('failed', message));
      }, timeout);
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => {
        if (settle()) reject(new DeviceHelperError('unsupported', UNAVAILABLE));
      });
      child.on('close', () => {
        if (!settle()) return;
        let answer: unknown;
        try {
          answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          answer = undefined;
        }
        if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
          reject(new DeviceHelperError('failed', UNREADABLE));
          return;
        }
        const fields = answer as Record<string, unknown>;
        const reason = fields['error'];
        if (reason === undefined) {
          resolve(fields);
          return;
        }
        const known: readonly unknown[] = ['cancelled', 'missing', 'unsupported', 'failed'];
        const message = typeof fields['message'] === 'string' ? fields['message'] : 'The device helper failed';
        reject(new DeviceHelperError(known.includes(reason) ? (reason as DeviceHelperFailure) : 'failed', message));
      });
    });
  }
}

export interface DeviceKeyStatus {
  readonly supported: boolean;
  readonly platform?: DevicePlatform;
  /** The key type a device key made here is. */
  readonly keyType?: string;
  /** Why it is not supported. */
  readonly reason?: string;
}

const text = (fields: Record<string, unknown>, name: string): string => {
  const value = fields[name];
  if (typeof value !== 'string' || value === '') throw new SshModelError('ssh-device-key-unavailable', UNREADABLE);
  return value;
};

/**
 * This machine's device keys: whether it can make them, making one, telling one made here from one made
 * elsewhere, signing with one (the {@link DeviceKeySigner} dial uses) and the app lock's prompt.
 */
export class DeviceKeys implements DeviceKeySigner {
  private asked: Promise<DeviceKeyStatus> | undefined;

  constructor(
    private readonly helper: Pick<DeviceHelper, 'run'>,
    private readonly os: NodeJS.Platform,
    private readonly device: () => string = hostname,
  ) {}

  /** The platform a key made here is for; undefined where there is none. */
  get platform(): DevicePlatform | undefined {
    return DEVICE_PLATFORM_OF[this.os];
  }

  /** Asked once; the answer stands for the life of the app. */
  status(): Promise<DeviceKeyStatus> {
    this.asked ??= this.askStatus();
    return this.asked;
  }

  private async askStatus(): Promise<DeviceKeyStatus> {
    const platform = this.platform;
    if (platform === undefined) return { supported: false, reason: 'Device keys are not available on this OS' };
    try {
      const answer = await this.helper.run('status');
      if (answer['supported'] === true) return { supported: true, platform, keyType: DEVICE_KEY_TYPE[platform] };
      const reason = typeof answer['reason'] === 'string' ? answer['reason'] : 'This computer cannot make device keys';
      return { supported: false, platform, reason };
    } catch (error) {
      return { supported: false, platform, reason: (error as Error).message };
    }
  }

  /**
   * Makes a key in the hardware and answers the block to store as its secret.
   *
   * @throws SshModelError `ssh-device-key-cancelled` | `ssh-device-key-unavailable` | `ssh-key-invalid`
   */
  async create(comment: string): Promise<string> {
    const platform = this.platform;
    if (platform === undefined) throw new SshModelError('ssh-device-key-unavailable', UNAVAILABLE);
    let answer: Record<string, unknown>;
    try {
      answer = await this.helper.run('create', { label: comment });
    } catch (error) {
      throw asSshError(error, undefined);
    }
    const publicKey = Buffer.from(text(answer, 'publicKey'), 'base64');
    const blob = platform === 'macos-secure-enclave' ? ecdsaP256Blob(publicKey) : sshRsaBlobFromSpki(publicKey);
    return encodeDeviceKey({
      platform,
      device: this.device(),
      publicKey: publicKeyLine(blob, comment),
      handle: text(answer, 'handle'),
    });
  }

  /** Whether this machine's hardware holds `key`; asks for nothing. */
  async isHere(key: ParsedDeviceKey): Promise<boolean> {
    if (key.platform !== this.platform) return false;
    try {
      return (await this.helper.run('check', { handle: key.handle }))['present'] === true;
    } catch {
      return false;
    }
  }

  /** @throws SshModelError `ssh-device-key-missing` | `ssh-device-key-cancelled` | `ssh-device-key-unavailable` */
  async sign(key: ParsedDeviceKey, data: Buffer, reason: string): Promise<Buffer> {
    if (key.platform !== this.platform) throw missing(key);
    let answer: Record<string, unknown>;
    try {
      answer = await this.helper.run('sign', { handle: key.handle, data: data.toString('base64'), reason });
    } catch (error) {
      throw asSshError(error, key);
    }
    return Buffer.from(text(answer, 'signature'), 'base64');
  }

  /**
   * Asks for the device owner (biometrics or the OS password), for the app lock.
   *
   * @throws DeviceHelperError `cancelled` | `unsupported` | `failed`
   */
  async unlock(reason: string): Promise<void> {
    await this.helper.run('unlock', { reason });
  }
}

const missing = (key: ParsedDeviceKey): SshModelError =>
  new SshModelError(
    'ssh-device-key-missing',
    `This key lives on another device${key.device === '' ? '' : ` (made on ${key.device})`}`,
    { device: key.device },
  );

function asSshError(error: unknown, key: ParsedDeviceKey | undefined): SshModelError {
  if (error instanceof SshModelError) return error;
  if (!(error instanceof DeviceHelperError))
    return new SshModelError('ssh-device-key-unavailable', 'The device helper failed');
  if (error.reason === 'missing' && key !== undefined) return missing(key);
  if (error.reason === 'cancelled') return new SshModelError('ssh-device-key-cancelled', 'The prompt was cancelled');
  return new SshModelError('ssh-device-key-unavailable', error.message);
}

/** Where the helper is: beside the app's resources when packed, in the build folder in development. */
export function deviceHelperDir(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'device-helper')
    : join(input.appPath, 'build-resources', 'device-helper');
}
