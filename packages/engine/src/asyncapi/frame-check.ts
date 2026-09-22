/**
 * Checks each live WebSocket frame against the messages its channel's contract declares for that
 * direction.
 *
 * Everything here is pure and synchronous, and {@link checkFrame} takes and returns plain data, so a
 * caller can run it in a worker. That matters because a contract's `pattern` is untrusted: the
 * validator refuses the regex shapes known to backtrack badly, but that scan is a heuristic, and a
 * single regex call cannot be interrupted from the same thread. The time budget here stops the
 * check between messages and reports `not-checked` — neither a pass nor a failure — and the worker
 * is what bounds a single call that runs away.
 */
import { validateJsonSchema, type JsonSchemaProblem } from '../json/schema-validate.js';
import type { WsFrame, WsFrameContract } from '../ws/model.js';
import type { AsyncApiDocument, AsyncApiMessage } from './model.js';

/** A text frame bigger than this is not parsed or validated: it is reported `skipped`. */
export const MAX_CHECKED_FRAME_BYTES = 262_144;

/** The default time one frame's check may take before it gives up as `not-checked`. */
export const DEFAULT_FRAME_CHECK_BUDGET_MS = 50;

export type FrameChecker = (frame: WsFrame) => WsFrameContract | undefined;

export interface FrameCheckOptions {
  /** Milliseconds one frame's check may take; past it the result is `not-checked`. */
  readonly budgetMs?: number;
  /** The clock, injectable for tests; defaults to `performance.now`. */
  readonly now?: () => number;
}

/** The messages a channel declares for each of Wirebench's directions — plain data, serialisable. */
export interface ChannelMessages {
  readonly sent: readonly AsyncApiMessage[];
  readonly received: readonly AsyncApiMessage[];
}

export function channelMessages(document: AsyncApiDocument, channel: string): ChannelMessages {
  const pick = (direction: 'sent' | 'received') =>
    document.operations.filter((o) => o.channel === channel && o.direction === direction).flatMap((o) => o.messages);
  return { sent: pick('sent'), received: pick('received') };
}

export function createFrameChecker(
  document: AsyncApiDocument,
  channel: string,
  options?: FrameCheckOptions,
): FrameChecker {
  const messages = channelMessages(document, channel);
  return (frame) => checkFrame(frame, messages[frame.direction], options);
}

function isJsonContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return base === '' || base === 'application/json' || base.endsWith('+json') || base === 'text/json';
}

/**
 * Checks one frame against `messages` (the ones declared for the frame's direction). Returns
 * `undefined` for a frame no contract speaks to (binary and control frames).
 */
export function checkFrame(
  frame: WsFrame,
  messages: readonly AsyncApiMessage[],
  options?: FrameCheckOptions,
): WsFrameContract | undefined {
  if (frame.opcode !== 'text' || frame.text === undefined) return undefined;
  if (frame.size > MAX_CHECKED_FRAME_BYTES) return { status: 'skipped', reason: 'frame too large to check' };
  if (messages.length === 0) return { status: 'unmatched', reason: `no ${frame.direction} messages in the contract` };
  const json = messages.filter((m) => isJsonContentType(m.contentType));
  if (json.length === 0) return { status: 'skipped', reason: 'no JSON message to check against' };

  let value: unknown;
  try {
    value = JSON.parse(frame.text);
  } catch {
    return { status: 'violation', message: json[0]!.name, reason: 'not JSON' };
  }

  const now = options?.now ?? (() => performance.now());
  const budgetMs = options?.budgetMs ?? DEFAULT_FRAME_CHECK_BUDGET_MS;
  const start = now();
  let closest: { name: string; problems: readonly JsonSchemaProblem[] } | undefined;
  // A message whose check stopped on the node or depth cap with nothing wrong found so far: the
  // frame may well be that message, so it is neither the closest violation nor a match.
  let undecided: string | undefined;
  for (const message of json) {
    if (now() - start > budgetMs) return { status: 'not-checked', reason: 'time budget exceeded' };
    const problems = message.payload === undefined ? [] : validateJsonSchema(value, message.payload);
    if (problems.length > 0 && problems.every((p) => p.keyword === 'budget')) {
      undecided ??= problems[0]!.message;
      continue;
    }
    if (problems.length === 0) {
      if (now() - start > budgetMs) return { status: 'not-checked', reason: 'time budget exceeded' };
      return { status: 'ok', message: message.name };
    }
    if (closest === undefined || problems.length < closest.problems.length) closest = { name: message.name, problems };
  }
  if (now() - start > budgetMs) return { status: 'not-checked', reason: 'time budget exceeded' };
  if (undecided !== undefined) return { status: 'not-checked', reason: undecided };
  return { status: 'violation', message: closest!.name, problems: closest!.problems };
}
