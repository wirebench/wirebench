import { randomBytes } from 'node:crypto';
import { SshModelError } from '../errors.js';
import { SK_ECDSA, SK_ED25519, SK_USER_PRESENCE, SK_USER_VERIFICATION, skSignatureBlob } from '../sk-key.js';
import type { SkKey, SkKeyType } from '../sk-key.js';
import { COSE_EDDSA, COSE_ES256, Ctap2, CtapError, CTAP2_ERR, sha256 } from './ctap2.js';
import type { PinToken } from './ctap2.js';
import { CtapHid, CtapHidError } from './ctaphid.js';
import type { HidDevice } from './ctaphid.js';

/**
 * Signing and enrolling with a FIDO2 security key (#420): finds the authenticator, asks for the touch
 * (and the PIN when the key wants one), and turns CTAP2's answer into what SSH sends. The HID devices come
 * from a {@link FidoTransport}: node-hid in the app, a software authenticator in tests.
 */

export interface FidoDeviceInfo {
  readonly path: string;
  readonly product: string;
}

export interface FidoTransport {
  /** The FIDO HID interfaces plugged in now. */
  list(): Promise<FidoDeviceInfo[]>;
  open(path: string): Promise<HidDevice>;
}

/** The FIDO alliance's HID usage page; usage 1 is CTAPHID. */
const FIDO_USAGE_PAGE = 0xf1d0;

interface NodeHid {
  devicesAsync(): Promise<{ path?: string; product?: string; usagePage?: number; usage?: number }[]>;
  HIDAsync: {
    open(path: string): Promise<{
      write(values: number[] | Buffer): Promise<number>;
      read(timeout?: number): Promise<Buffer | undefined>;
      close(): Promise<void>;
    }>;
  };
}

let nodeHid: Promise<NodeHid> | undefined;

/** node-hid, loaded on first use: a build without its binding still runs everything else. */
function loadNodeHid(): Promise<NodeHid> {
  nodeHid ??= import('node-hid').then((module) => ((module as { default?: NodeHid }).default ?? module) as NodeHid);
  return nodeHid;
}

const unavailable = (detail: string): SshModelError =>
  new SshModelError('ssh-sk-unavailable', `Security keys cannot be used here: ${detail}`);

/**
 * The FIDO HID devices through node-hid. Windows gives raw FIDO HID access to elevated programs only (the
 * rest go through its WebAuthn service), so there security keys are refused for now.
 */
export const nodeHidTransport: FidoTransport = {
  async list() {
    if (process.platform === 'win32') {
      throw unavailable(
        'on Windows only the system’s own security key service may talk to the key, and Wirebench does not use it yet',
      );
    }
    let hid: NodeHid;
    try {
      hid = await loadNodeHid();
    } catch {
      throw unavailable('the USB HID module did not load');
    }
    const devices = await hid.devicesAsync();
    return devices.flatMap((device) =>
      device.usagePage === FIDO_USAGE_PAGE && device.usage === 1 && device.path
        ? [{ path: device.path, product: device.product?.trim() || 'Security key' }]
        : [],
    );
  },
  async open(path) {
    const hid = await loadNodeHid();
    const device = await hid.HIDAsync.open(path);
    return {
      // hidapi takes the report id first; FIDO devices use none, which is written as 0.
      write: async (report) => {
        await device.write(Buffer.concat([Buffer.from([0]), report]));
      },
      read: async (timeoutMs) => {
        const report = await device.read(timeoutMs);
        return report === undefined || report.length === 0 ? undefined : report;
      },
      close: () => device.close(),
    };
  },
};

export interface SkPrompts {
  /** The PIN, when the key needs one; never stored here. */
  readonly pin?: string;
  /** Called when the authenticator waits for a touch. */
  readonly onTouch?: () => void;
  readonly signal?: AbortSignal;
  /** Tests inject a software authenticator. */
  readonly transport?: FidoTransport;
}

/** What a CTAP or transport failure means to the person at the key. */
function asSkError(error: unknown, retries?: number): unknown {
  if (error instanceof SshModelError) return error;
  if (error instanceof CtapHidError) {
    if (error.kind === 'u2f-only') return new SshModelError('ssh-sk-unavailable', error.message);
    return new SshModelError('ssh-sk-failed', error.message);
  }
  if (!(error instanceof CtapError)) return error;
  switch (error.status) {
    case CTAP2_ERR.PIN_REQUIRED:
    case CTAP2_ERR.PIN_AUTH_INVALID:
      return new SshModelError('ssh-sk-pin', 'The security key needs its PIN', { reason: 'required' });
    case CTAP2_ERR.PIN_INVALID:
      return new SshModelError(
        'ssh-sk-pin',
        retries === undefined ? 'Wrong PIN' : `Wrong PIN: ${String(retries)} attempts left before the key locks`,
        { reason: 'wrong', ...(retries === undefined ? {} : { retries }) },
      );
    case CTAP2_ERR.PIN_BLOCKED:
      return new SshModelError(
        'ssh-sk-pin',
        'The security key is locked after too many wrong PINs; reset it with its maker’s tool',
        { reason: 'blocked' },
      );
    case CTAP2_ERR.PIN_AUTH_BLOCKED:
      return new SshModelError(
        'ssh-sk-pin',
        'Too many wrong PINs in a row: unplug the security key and plug it back in to try again',
        { reason: 'blocked' },
      );
    case CTAP2_ERR.PIN_NOT_SET:
      return new SshModelError('ssh-sk-pin', 'This key needs a PIN, but the security key has none set', {
        reason: 'not-set',
      });
    case CTAP2_ERR.USER_ACTION_TIMEOUT:
    case CTAP2_ERR.ACTION_TIMEOUT:
    case CTAP2_ERR.OPERATION_DENIED:
    case CTAP2_ERR.KEEPALIVE_CANCEL:
      return new SshModelError('ssh-sk-not-touched', 'The security key was not touched in time');
    case CTAP2_ERR.NO_CREDENTIALS:
    case CTAP2_ERR.INVALID_CREDENTIAL:
      return new SshModelError('ssh-sk-no-device', 'The security key plugged in did not make this key');
    case CTAP2_ERR.UNSUPPORTED_ALGORITHM:
      return new SshModelError('ssh-sk-unavailable', 'The security key cannot make a key of this type');
    default:
      return new SshModelError('ssh-sk-failed', error.message, { status: error.status });
  }
}

interface OpenAuthenticator {
  readonly ctap: Ctap2;
  readonly product: string;
  close(): Promise<void>;
}

async function openAll(transport: FidoTransport): Promise<OpenAuthenticator[]> {
  const devices = await transport.list();
  if (devices.length === 0) throw new SshModelError('ssh-sk-no-device', 'No security key is plugged in');
  const opened: OpenAuthenticator[] = [];
  let firstError: unknown;
  for (const device of devices) {
    try {
      const hid = await CtapHid.open(await transport.open(device.path));
      opened.push({ ctap: new Ctap2(hid), product: device.product, close: () => hid.close() });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (opened.length === 0) throw asSkError(firstError);
  return opened;
}

const closeAll = async (list: readonly OpenAuthenticator[]): Promise<void> => {
  await Promise.all(list.map((a) => a.close().catch(() => undefined)));
};

/** A PIN token, or the refusal with the attempts left when the PIN is wrong. */
async function tokenFor(ctap: Ctap2, pin: string): Promise<PinToken> {
  const info = await ctap.info();
  try {
    return await ctap.pinToken(pin, info.pinProtocols);
  } catch (error) {
    if (error instanceof CtapError && error.status === CTAP2_ERR.PIN_INVALID) {
      const retries = await ctap.pinRetries(info.pinProtocols).catch(() => undefined);
      throw asSkError(error, retries);
    }
    throw error;
  }
}

const callOptions = (prompts: SkPrompts): { onTouch?: () => void; signal?: AbortSignal } => ({
  ...(prompts.onTouch ? { onTouch: prompts.onTouch } : {}),
  ...(prompts.signal ? { signal: prompts.signal } : {}),
});

/**
 * Signs `data` with the security key that holds `key`, and returns the SSH signature blob (algorithm,
 * signature, flags, counter). With several keys plugged in, the one holding it is found without a touch.
 *
 * @throws SshModelError `ssh-sk-pin` {reason: required|wrong|blocked|not-set, retries?} |
 *   `ssh-sk-no-device` | `ssh-sk-not-touched` | `ssh-sk-unavailable` | `ssh-sk-failed`
 */
export async function skSign(key: SkKey, data: Buffer, prompts: SkPrompts = {}): Promise<Buffer> {
  if ((key.flags & SK_USER_VERIFICATION) !== 0 && !prompts.pin) {
    throw new SshModelError('ssh-sk-pin', 'This security key asks for its PIN on every sign-in', {
      reason: 'required',
    });
  }
  const clientDataHash = sha256(data);
  const opened = await openAll(prompts.transport ?? nodeHidTransport);
  try {
    let chosen = opened[0] as OpenAuthenticator;
    if (opened.length > 1) {
      const holders: OpenAuthenticator[] = [];
      for (const candidate of opened) {
        try {
          await candidate.ctap.getAssertion({
            rpId: key.application,
            clientDataHash,
            credentialId: key.keyHandle,
            userPresence: false,
          });
          holders.push(candidate);
        } catch {
          // Not this one.
        }
      }
      if (holders.length === 0) {
        throw new SshModelError('ssh-sk-no-device', 'None of the security keys plugged in made this key');
      }
      chosen = holders[0] as OpenAuthenticator;
    }
    const pin = prompts.pin ? await tokenFor(chosen.ctap, prompts.pin) : undefined;
    const assertion = await chosen.ctap.getAssertion(
      {
        rpId: key.application,
        clientDataHash,
        credentialId: key.keyHandle,
        userPresence: (key.flags & SK_USER_PRESENCE) !== 0,
        ...(pin ? { pin } : {}),
      },
      callOptions(prompts),
    );
    return skSignatureBlob(key.keyType, assertion.signature, assertion.flags, assertion.counter);
  } catch (error) {
    throw asSkError(error);
  } finally {
    await closeAll(opened);
  }
}

export interface SkEnrollOptions extends SkPrompts {
  readonly keyType: SkKeyType;
  /** The FIDO application; `ssh:` unless the server expects another (it must start with `ssh:`). */
  readonly application?: string;
  /** Asks for the PIN on every sign-in as well as the touch (OpenSSH's `verify-required`). */
  readonly verifyRequired?: boolean;
}

/**
 * Makes a non-resident credential on the one security key plugged in and returns the key, without a
 * comment. With several plugged in it refuses rather than guess which one is meant.
 *
 * @throws SshModelError as {@link skSign}, and `ssh-sk-no-device` {reason: several}
 */
export async function skEnroll(options: SkEnrollOptions): Promise<Omit<SkKey, 'comment'>> {
  const application = options.application ?? 'ssh:';
  if (!application.startsWith('ssh:')) {
    throw new SshModelError('ssh-key-invalid', 'A security key application starts with ssh:');
  }
  if (options.verifyRequired && !options.pin) {
    throw new SshModelError('ssh-sk-pin', 'A key that asks for the PIN is made with the PIN', { reason: 'required' });
  }
  const opened = await openAll(options.transport ?? nodeHidTransport);
  try {
    if (opened.length > 1) {
      throw new SshModelError('ssh-sk-no-device', 'Several security keys are plugged in: leave only the one to use', {
        reason: 'several',
      });
    }
    const { ctap } = opened[0] as OpenAuthenticator;
    const algorithm = options.keyType === SK_ED25519 ? COSE_EDDSA : COSE_ES256;
    const info = await ctap.info();
    if (info.algorithms !== undefined && !info.algorithms.includes(algorithm)) {
      throw new SshModelError(
        'ssh-sk-unavailable',
        options.keyType === SK_ED25519
          ? 'This security key cannot make Ed25519 keys; choose ECDSA'
          : 'This security key cannot make ECDSA keys',
      );
    }
    const pin = options.pin ? await tokenFor(ctap, options.pin) : undefined;
    const made = await ctap.makeCredential(
      {
        rpId: application,
        clientDataHash: sha256(randomBytes(32)),
        algorithm,
        // As OpenSSH does: the user is not part of a non-resident key.
        userId: Buffer.alloc(32),
        userName: 'openssh',
        ...(pin ? { pin } : {}),
      },
      callOptions(options),
    );
    return {
      keyType: options.keyType === SK_ECDSA ? SK_ECDSA : SK_ED25519,
      publicKey: made.publicKey,
      application,
      flags: SK_USER_PRESENCE | (options.verifyRequired ? SK_USER_VERIFICATION : 0),
      keyHandle: made.credentialId,
    };
  } catch (error) {
    throw asSkError(error);
  } finally {
    await closeAll(opened);
  }
}
