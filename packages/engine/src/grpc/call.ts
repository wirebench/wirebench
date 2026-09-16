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
import type { GrpcExchange, GrpcSendInput } from './send.js';
import { sendGrpc } from './send.js';

/** Everything {@link callGrpc} needs: the schema, the method, the message text, and the transport input. */
export interface GrpcCallInput extends Omit<GrpcSendInput, 'messages'> {
  readonly set: ProtoSet;
  /** The request message(s) as JSON text: one object, or an array for a client stream. */
  readonly messageText: string;
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
  const requestMessages = parseMessageText(input.messageText, clientStreams(method.kind));
  const messages = requestMessages.map((message) => encodeMessage(input.set, method.requestType, message));
  const { set, messageText, ...send } = input;
  void messageText;
  const exchange = await sendGrpc({ ...send, messages });
  return {
    exchange,
    methodKind: method.kind,
    requestType: method.requestType,
    responseType: method.responseType,
    requestMessages: requestMessages.map((message) =>
      decodeMessage(set, method.requestType, encodeMessage(set, method.requestType, message)),
    ),
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
