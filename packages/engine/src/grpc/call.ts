/**
 * One gRPC call end to end: the request message text is encoded against the method's request type,
 * sent, and every response message decoded against its response type. This is the function the
 * desktop app calls; `send.ts` beneath it is bytes only, and `codec.ts` beside it is schema only.
 */

import { decodeMessage, encodeMessage, parseMessageText } from './codec.js';
import type { GrpcMethodKind } from './model.js';
import { clientStreams } from './model.js';
import { describeMethod } from './proto/describe.js';
import type { ProtoSet } from './proto/load.js';
import type { GrpcExchange, GrpcSendInput, GrpcStreamHandle } from './send.js';
import { sendGrpc } from './send.js';

/** Everything {@link callGrpc} needs: the schema, the method, the message text, and the transport input. */
export interface GrpcCallInput extends Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'> {
  readonly set: ProtoSet;
  /** The request message(s) as JSON text: one object, or an array for a client stream. */
  readonly messageText: string;
  /**
   * Called for each response message as it arrives, already decoded — the transport's
   * {@link GrpcSendInput.onMessage} with the schema applied, so a caller showing a live stream
   * never sees raw bytes. The same messages still come back in the result.
   */
  readonly onMessage?: (message: GrpcResponseMessage, index: number) => void;
  /** Opts into an interactive call: the request side stays open and the handle drives it. */
  readonly onOpen?: (handle: GrpcCallStreamHandle) => void;
}

/** The client's side of an interactive call, in message text rather than bytes. */
export interface GrpcCallStreamHandle {
  /**
   * Encodes one more request message from its JSON text and writes it, returning the message as it
   * went — the canonical JSON, which is what the caller shows as sent.
   *
   * @throws ProtoError when the text does not parse or encode against the request type; GrpcError
   * `grpc-stream-closed` once the request side is closed
   */
  readonly send: (messageText: string) => unknown;
  /** Half-closes the request side. Idempotent. */
  readonly end: () => void;
  readonly isOpen: () => boolean;
}

/** One response message, decoded when it could be. */
export interface GrpcResponseMessage {
  /** The message as canonical JSON, or `undefined` when it did not decode. */
  readonly json?: unknown;
  /** The message bytes as base64, kept so a message that did not decode is still visible. */
  readonly base64: string;
  readonly bytes: number;
  readonly problem?: string;
}

/** The outcome of {@link callGrpc}. */
export interface GrpcCallResult {
  readonly exchange: GrpcExchange;
  readonly methodKind: GrpcMethodKind;
  readonly requestType: string;
  readonly responseType: string;
  /** The request messages as they were sent, in canonical JSON. */
  readonly requestMessages: readonly unknown[];
  readonly responseMessages: readonly GrpcResponseMessage[];
}

/**
 * Encodes, sends and decodes one call.
 *
 * @throws ProtoError for a method or type the schema does not define, or a message that does not
 * encode; whatever {@link sendGrpc} throws for a failure to get an answer
 */
export async function callGrpc(input: GrpcCallInput): Promise<GrpcCallResult> {
  const method = describeMethod(input.set, input.service, input.method);
  const parsed = parseMessageText(input.messageText, clientStreams(method.kind));
  const messages = parsed.map((message) => encodeMessage(input.set, method.requestType, message));
  const { set, messageText, onMessage, onOpen, ...send } = input;
  void messageText;
  // Every request message in canonical JSON: the ones the text held, then whatever an interactive
  // call pushed afterwards, so the result records the whole conversation rather than its opening.
  const requestMessages: unknown[] = messages.map((bytes) => decodeMessage(set, method.requestType, bytes));
  const exchange = await sendGrpc({
    ...send,
    messages,
    ...(onMessage !== undefined
      ? {
          onMessage: (bytes: Uint8Array, index: number): void => {
            onMessage(decodeResponseMessage(set, method.responseType, bytes), index);
          },
        }
      : {}),
    ...(onOpen !== undefined
      ? {
          onOpen: (handle: GrpcStreamHandle): void => {
            onOpen({
              send: (text: string): unknown => {
                const [message] = parseMessageText(text, false);
                const bytes = encodeMessage(set, method.requestType, message);
                handle.write(bytes);
                const json = decodeMessage(set, method.requestType, bytes);
                requestMessages.push(json);
                return json;
              },
              end: handle.end,
              isOpen: handle.isOpen,
            });
          },
        }
      : {}),
  });
  return {
    exchange,
    methodKind: method.kind,
    requestType: method.requestType,
    responseType: method.responseType,
    requestMessages,
    responseMessages: exchange.messages.map((bytes) => decodeResponseMessage(set, method.responseType, bytes)),
  };
}

/** Decodes one response message, reporting rather than throwing when it does not decode. */
export function decodeResponseMessage(set: ProtoSet, responseType: string, bytes: Uint8Array): GrpcResponseMessage {
  const base64 = Buffer.from(bytes).toString('base64');
  try {
    return { json: decodeMessage(set, responseType, bytes), base64, bytes: bytes.byteLength };
  } catch (error) {
    return { base64, bytes: bytes.byteLength, problem: error instanceof Error ? error.message : String(error) };
  }
}
