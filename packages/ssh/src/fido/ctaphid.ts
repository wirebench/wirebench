import { randomBytes } from 'node:crypto';

/**
 * CTAPHID (FIDO CTAP 2.1 §11.2): CTAP messages framed into 64-byte HID reports on a channel the
 * authenticator allocates. The device itself is behind {@link HidDevice}, so tests drive this layer with a
 * software authenticator and the app with node-hid.
 */

export const REPORT_SIZE = 64;

/** One open FIDO HID interface. */
export interface HidDevice {
  /** Writes one 64-byte output report (the opener adds the report id the OS wants). */
  write(report: Buffer): Promise<void>;
  /** The next 64-byte input report, or undefined when none came within `timeoutMs`. */
  read(timeoutMs: number): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export const CMD_INIT = 0x06;
export const CMD_CBOR = 0x10;
export const CMD_CANCEL = 0x11;
export const CMD_KEEPALIVE = 0x3b;
export const CMD_ERROR = 0x3f;
export const BROADCAST_CID = 0xffffffff;

/** Keep-alive status 2: the authenticator waits for a touch. */
export const STATUS_UPNEEDED = 2;
/** CAPABILITY_CBOR in the INIT reply: the device speaks CTAP2, not only U2F. */
export const CAPABILITY_CBOR = 0x04;

/** How long to wait for any report (a reply or a keep-alive) before giving up on the device. */
const SILENCE_MS = 5000;

export class CtapHidError extends Error {
  constructor(
    readonly kind: 'timeout' | 'transport' | 'u2f-only',
    message: string,
  ) {
    super(message);
    this.name = 'CtapHidError';
  }
}

export interface CborCallOptions {
  /** Called once when the authenticator starts waiting for a touch. */
  readonly onTouch?: () => void;
  /** Cancels a call waiting for a touch (CTAPHID_CANCEL): the device then answers KEEPALIVE_CANCEL. */
  readonly signal?: AbortSignal;
}

export class CtapHid {
  private constructor(
    private readonly device: HidDevice,
    private readonly cid: number,
  ) {}

  /**
   * Allocates a channel. The INIT nonce is random so a reply meant for another program on the broadcast
   * channel is not taken for this one.
   *
   * @throws CtapHidError `u2f-only` when the device does not speak CTAP2 | `timeout` | `transport`
   */
  static async open(device: HidDevice): Promise<CtapHid> {
    const nonce = randomBytes(8);
    await writeMessage(device, BROADCAST_CID, CMD_INIT, nonce);
    for (;;) {
      const reply = await readMessage(device, BROADCAST_CID, CMD_INIT, {});
      if (reply.length < 17 || !reply.subarray(0, 8).equals(nonce)) continue;
      if (((reply[16] ?? 0) & CAPABILITY_CBOR) === 0) {
        throw new CtapHidError('u2f-only', 'This security key speaks only U2F; Wirebench needs a FIDO2 key');
      }
      return new CtapHid(device, reply.readUInt32BE(8));
    }
  }

  /** Sends one CTAP2 command (its byte, then the CBOR) and returns the reply: a status byte, then CBOR. */
  async cbor(request: Buffer, options: CborCallOptions = {}): Promise<Buffer> {
    await writeMessage(this.device, this.cid, CMD_CBOR, request);
    const onAbort = (): void => {
      writeMessage(this.device, this.cid, CMD_CANCEL, Buffer.alloc(0)).catch(() => undefined);
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await readMessage(this.device, this.cid, CMD_CBOR, options);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  close(): Promise<void> {
    return this.device.close();
  }
}

/** Frames `payload` as an initialisation packet and its continuation packets. */
export function framesOf(cid: number, cmd: number, payload: Buffer): Buffer[] {
  const first = Buffer.alloc(REPORT_SIZE);
  first.writeUInt32BE(cid >>> 0, 0);
  first[4] = 0x80 | cmd;
  first.writeUInt16BE(payload.length, 5);
  payload.copy(first, 7, 0, REPORT_SIZE - 7);
  const frames = [first];
  let offset = REPORT_SIZE - 7;
  for (let seq = 0; offset < payload.length; seq++) {
    if (seq > 0x7f) throw new CtapHidError('transport', 'The message is too long for one CTAPHID transaction');
    const next = Buffer.alloc(REPORT_SIZE);
    next.writeUInt32BE(cid >>> 0, 0);
    next[4] = seq;
    payload.copy(next, 5, offset, offset + REPORT_SIZE - 5);
    offset += REPORT_SIZE - 5;
    frames.push(next);
  }
  return frames;
}

async function writeMessage(device: HidDevice, cid: number, cmd: number, payload: Buffer): Promise<void> {
  for (const frame of framesOf(cid, cmd, payload)) await device.write(frame);
}

async function readMessage(device: HidDevice, cid: number, cmd: number, options: CborCallOptions): Promise<Buffer> {
  let touchTold = false;
  const next = async (): Promise<Buffer> => {
    for (;;) {
      const report = await device.read(SILENCE_MS);
      if (report === undefined) throw new CtapHidError('timeout', 'The security key stopped answering');
      // Reports on other channels belong to other programs.
      if (report.length >= 5 && report.readUInt32BE(0) === cid >>> 0) return report;
    }
  };
  for (;;) {
    const report = await next();
    const command = report[4] ?? 0;
    if ((command & 0x80) === 0 || report.length < 7) continue; // a stray continuation packet
    const type = command & 0x7f;
    const length = report.readUInt16BE(5);
    if (type === CMD_KEEPALIVE) {
      if (report[7] === STATUS_UPNEEDED && !touchTold) {
        touchTold = true;
        options.onTouch?.();
      }
      continue;
    }
    if (type === CMD_ERROR) {
      throw new CtapHidError('transport', `The security key refused the request (CTAPHID error ${String(report[7])})`);
    }
    if (type !== cmd) continue;
    const parts = [report.subarray(7, 7 + Math.min(length, REPORT_SIZE - 7))];
    let received = parts[0]?.length ?? 0;
    for (let seq = 0; received < length; seq++) {
      const more = await next();
      if (more[4] !== seq) throw new CtapHidError('transport', 'The security key sent a garbled reply');
      const chunk = more.subarray(5, 5 + Math.min(length - received, REPORT_SIZE - 5));
      parts.push(chunk);
      received += chunk.length;
    }
    return Buffer.concat(parts);
  }
}
