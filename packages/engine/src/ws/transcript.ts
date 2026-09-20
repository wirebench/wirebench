/**
 * What History keeps of a session. Both ends, because the end — the last messages before an
 * unexpected close — is what a person comes back for, and a first-N cap loses exactly that.
 */
import type { WsFrame } from './model.js';

export const WS_HISTORY_HEAD = 400;
export const WS_HISTORY_TAIL = 100;
export const WS_HISTORY_MAX_BYTES = 1_048_576;

export interface WsTranscript {
  readonly frames: readonly WsFrame[];
  readonly truncated: boolean;
  readonly omittedFrames: number;
}

export function capFrames(frames: readonly WsFrame[]): WsTranscript {
  const limit = WS_HISTORY_HEAD + WS_HISTORY_TAIL;
  const kept =
    frames.length <= limit ? [...frames] : [...frames.slice(0, WS_HISTORY_HEAD), ...frames.slice(-WS_HISTORY_TAIL)];
  const omittedFrames = frames.length - kept.length;
  let budget = WS_HISTORY_MAX_BYTES;
  let stripped = false;
  const capped = kept.map((frame): WsFrame => {
    if (frame.size <= budget) {
      budget -= frame.size;
      return frame;
    }
    if (frame.text === undefined && frame.base64 === undefined) return frame;
    stripped = true;
    return {
      index: frame.index,
      direction: frame.direction,
      opcode: frame.opcode,
      at: frame.at,
      size: frame.size,
      ...(frame.close !== undefined ? { close: frame.close } : {}),
      payloadTruncated: true,
    };
  });
  return { frames: capped, truncated: omittedFrames > 0 || stripped, omittedFrames };
}
