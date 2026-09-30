/**
 * What History keeps of a session. Both ends, because the end — the last messages before an
 * unexpected close — is what a person comes back for, and a first-N cap loses exactly that.
 */
import { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '../http/transcript-cap.js';
import type { CapLimits } from '../http/transcript-cap.js';
import type { WsFrame } from './model.js';

export { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL };
export type { CapLimits };

export interface WsTranscript {
  readonly frames: readonly WsFrame[];
  readonly truncated: boolean;
  readonly omittedFrames: number;
}

/** History keeps a frame's contract verdict but not its problem list: the list is for the live
 *  view, and re-checking a saved frame recomputes it. */
function withoutProblems(frame: WsFrame): WsFrame {
  if (frame.contract?.problems === undefined) return frame;
  const { status, message, reason } = frame.contract;
  const contract = {
    status,
    ...(message !== undefined ? { message } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
  return { ...frame, contract };
}

export function capFrames(input: readonly WsFrame[]): WsTranscript {
  const frames = input.map(withoutProblems);
  const limits: CapLimits = { head: WS_HISTORY_HEAD, tail: WS_HISTORY_TAIL, maxBytes: WS_HISTORY_MAX_BYTES };
  const r = capByEnds(
    frames,
    limits,
    (frame) => frame.size,
    (frame) => {
      if (frame.text === undefined && frame.base64 === undefined) return undefined;
      return {
        index: frame.index,
        direction: frame.direction,
        opcode: frame.opcode,
        at: frame.at,
        size: frame.size,
        ...(frame.close !== undefined ? { close: frame.close } : {}),
        ...(frame.contract !== undefined ? { contract: frame.contract } : {}),
        payloadTruncated: true,
      };
    },
  );
  return { frames: r.items, truncated: r.truncated, omittedFrames: r.omitted };
}
