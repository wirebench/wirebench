/**
 * The pure half of the WebSocket editor: how a frame reads on one timeline row, what a close code
 * means, whether a composed binary payload parses, and which subprotocol tokens and close codes are
 * legal. Kept apart from the components so each rule is tested on its own.
 */
import type { WsFrameContractWire, WsFrameWire } from '../../../shared/wire-types.js';

/** `mm:ss.mmm` for a frame's offset from the start of the session. */
export function formatFrameTime(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  const minutes = Math.floor(whole / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  const millis = whole % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** `mm:ss` for how long a session has been (or was) open. */
export function formatElapsed(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** The bytes of a base64 string; an undecodable one reads as empty. */
export function base64Bytes(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

/** The first `count` bytes of a payload as space-separated hex. */
export function hexPreview(base64: string, count = 16): string {
  return [...base64Bytes(base64).slice(0, count)].map(hex).join(' ');
}

/** A classic 16-bytes-a-line hex dump: offset, hex, and the printable ASCII beside it. */
export function hexDump(base64: string): string {
  const bytes = base64Bytes(base64);
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = [...bytes.slice(offset, offset + 16)];
    const hexes = row.map(hex).join(' ').padEnd(47, ' ');
    const ascii = row.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexes}  ${ascii}`);
  }
  return lines.join('\n');
}

/** The one-line preview a timeline row shows for a frame. */
export function framePreview(frame: WsFrameWire): string {
  if (frame.payloadTruncated === true) {
    return '(payload not kept)';
  }
  if (frame.opcode === 'close') {
    const code = frame.close?.code;
    if (code === undefined) return 'close';
    const reason = frame.close?.reason ?? '';
    return reason === '' ? String(code) : `${String(code)} ${reason}`;
  }
  if (frame.text !== undefined) {
    return frame.text.replace(/\s+/g, ' ').trim();
  }
  if (frame.base64 !== undefined) {
    return hexPreview(frame.base64);
  }
  return '';
}

/** Whether a row is a control frame (ping, pong, close), which the timeline can hide. */
export function isControlFrame(frame: WsFrameWire): boolean {
  return frame.opcode === 'ping' || frame.opcode === 'pong' || frame.opcode === 'close';
}

/** The registered meaning of a close status code (RFC 6455 §7.4.1 and the IANA registry). */
const CLOSE_MEANINGS: Readonly<Record<number, string>> = {
  1000: 'Normal closure',
  1001: 'Going away',
  1002: 'Protocol error',
  1003: 'Unsupported data',
  1005: 'No status received',
  1006: 'Abnormal closure',
  1007: 'Invalid payload data',
  1008: 'Policy violation',
  1009: 'Message too big',
  1010: 'Mandatory extension',
  1011: 'Internal error',
  1012: 'Service restart',
  1013: 'Try again later',
  1014: 'Bad gateway',
  1015: 'TLS handshake failure',
};

/** What a close code means; a private or unregistered one says so. */
export function closeCodeMeaning(code: number): string {
  const known = CLOSE_MEANINGS[code];
  if (known !== undefined) return known;
  if (code >= 4000 && code <= 4999) return 'Private use';
  if (code >= 3000 && code <= 3999) return 'Registered for libraries and frameworks';
  return 'Unregistered';
}

/** A close code a client may send: 1000, or 3000–4999. */
export function isSendableCloseCode(code: number): boolean {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999));
}

/** The byte length of a string as UTF-8 — a close reason is limited to 123 of them. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The longest close reason, in bytes: a control frame's 125 less the two-byte code. */
export const MAX_CLOSE_REASON_BYTES = 123;

/** The result of reading a composed binary payload. */
export type BinaryParse =
  { readonly ok: true; readonly base64: string } | { readonly ok: false; readonly reason: string };

/**
 * Reads a binary payload typed as hex (`0a ff 10`, `0x0aff10`, with or without spaces) or as
 * base64, and answers it as base64 — the one encoding the wire takes. Hex is tried first because
 * a run of hex digits is also valid base64, and a person typing `0a0b` means two bytes.
 */
export function parseBinaryInput(text: string): BinaryParse {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Type the payload as hex or base64.' };
  }
  const hexText = trimmed.replace(/0x/gi, '').replace(/[\s:,]/g, '');
  if (/^[0-9a-f]+$/i.test(hexText)) {
    if (hexText.length % 2 !== 0) {
      return { ok: false, reason: 'Hex needs two digits per byte.' };
    }
    const bytes = new Uint8Array(hexText.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hexText.slice(i * 2, i * 2 + 2), 16);
    }
    return { ok: true, base64: bytesToBase64(bytes) };
  }
  const compact = trimmed.replace(/\s/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) {
    return { ok: true, base64: compact };
  }
  return { ok: false, reason: 'Not hex or base64.' };
}

/**
 * Why a subprotocol token is refused, or `undefined` when it is legal: a token is visible ASCII
 * with no separators, so a space, a comma or anything outside ASCII cannot be one.
 */
export function subprotocolProblem(token: string): string | undefined {
  if (token === '') return 'A subprotocol cannot be empty.';
  if (/\s/.test(token)) return 'A subprotocol cannot contain a space.';
  if (token.includes(',')) return 'A subprotocol cannot contain a comma.';
  if (!/^[\x21-\x7e]+$/.test(token)) return 'A subprotocol is plain ASCII.';
  return undefined;
}

/**
 * Why a saved binary message's content is not base64, or `undefined` when it is. A saved message
 * is written to its own `.b64` file, so unlike the composer it takes base64 only.
 */
export function base64Problem(text: string): string | undefined {
  const compact = text.replace(/\s/g, '');
  if (compact === '') return undefined;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0 ? undefined : 'Not valid base64.';
}

/** One contract problem as the timeline and the detail spell it: `/text — type: expected string`. */
export function contractProblemText(problem: NonNullable<WsFrameContractWire['problems']>[number]): string {
  return `${problem.path === '' ? '/' : problem.path} — ${problem.keyword}: ${problem.message}`;
}

/**
 * What a frame's timeline marker says, or `undefined` when it gets none. Only a frame that broke
 * the contract, one the contract has no message for, and one whose check ran out of time are
 * marked: an `ok` frame (and a `skipped` one) looks as it would with no contract at all.
 */
export function contractMarkerLabel(contract: WsFrameContractWire | undefined): string | undefined {
  if (contract === undefined) return undefined;
  switch (contract.status) {
    case 'violation': {
      const first = contract.problems?.[0];
      return `Contract problem: ${first === undefined ? (contract.reason ?? 'does not match') : contractProblemText(first)}`;
    }
    case 'unmatched':
      return `Not in the contract: ${contract.reason ?? 'no message matches this frame'}`;
    case 'not-checked':
      return 'Not checked — check took too long';
    default:
      return undefined;
  }
}
