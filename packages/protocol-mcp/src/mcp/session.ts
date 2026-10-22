/**
 * One MCP session from connect to close (#79), recorded message by message: `initialize`, the
 * version and capability check, `notifications/initialized`, one operation, close.
 *
 * Wirebench is its own client here, written against the SDK's protocol types and schemas rather
 * than its `Client`, which throws where a test tool must report and hides the wire. So the session
 * keeps every message in both directions with its time, size, id, method and what the schemas
 * found wrong with it, and a message that does not match is kept with a warning, not dropped.
 *
 * The operation is generic here, a method and its params: `operation.ts` builds those for each
 * saved operation and checks each result against its own schema through `validateResult`. The
 * transport is generic too (`transport.ts`); stdio and both HTTP transports plug in unchanged.
 *
 * `runMcpSession` never rejects. Whatever the server does, and whatever goes wrong on the way (a
 * process that exits, the deadline, a cancel), resolves as an outcome with `failure` set. A
 * JSON-RPC error the server answers the operation with is not a failure: it is the `response`.
 *
 * The server may not drive the client. Wirebench declares no client capabilities, and every
 * request a server sends (`roots/list`, `sampling/createMessage`, …) is answered with `-32601`;
 * both messages are recorded (decision 9).
 */
import {
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { McpError } from '#core/errors';
import {
  encodeError,
  encodeNotification,
  encodeRequest,
  errorObjectOf,
  formatIssues,
  JSONRPC_METHOD_NOT_FOUND,
  readMessages,
  resultOf,
  type InspectedMessage,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessageKind,
} from './jsonrpc.js';
import { MCP_CANCEL_NOTICE_MS, MCP_DEFAULT_TIMEOUT_MS, MCP_MAX_MESSAGE_BYTES, MCP_MAX_MESSAGES } from './limits.js';
import type { McpWireTransport } from './transport.js';

/** The capability a server must have advertised for an operation to be sent. */
export type McpCapability = 'tools' | 'resources' | 'prompts';

/** The one operation a session runs after the handshake. */
export interface McpOperationCall {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Checked against the server's `initialize` capabilities before the call is sent. */
  readonly capability?: McpCapability;
  /** What is wrong with a `result`, as warnings on the message that carried it; none when it is right. */
  readonly validateResult?: (result: unknown) => readonly string[];
}

/** What every session is given, whatever it runs after the handshake. */
export interface McpSessionBaseOptions {
  readonly transport: McpWireTransport;
  /** `clientInfo.version` in `initialize`. */
  readonly clientVersion: string;
  /** The version `initialize` asks for. Default: the latest the bundled SDK knows. */
  readonly protocolVersion?: string;
  /** The deadline of the whole session. Default {@link MCP_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called with each message as it is kept, for a live timeline. */
  readonly onMessage?: (message: McpMessage) => void;
}

/** Options for {@link runMcpSession}. */
export interface McpSessionOptions extends McpSessionBaseOptions {
  readonly operation: McpOperationCall;
}

/**
 * What a driven session hands its driver once the handshake is done: the server's `initialize`
 * result, and a way to send one call after another on the same session.
 */
export interface McpSessionDriver {
  /** The server's `initialize` result, as it came. */
  readonly initialize: Readonly<Record<string, unknown>> | undefined;
  /**
   * Sends one call and resolves with its answer. A call whose capability the server did not
   * advertise is refused before it is sent.
   *
   * @throws McpError `mcp-capability-missing`, or the session's failure
   */
  call(operation: McpOperationCall): Promise<McpResponse>;
}

/** One JSON-RPC message of the exchange. */
export interface McpMessage {
  readonly direction: 'sent' | 'received';
  /** ISO 8601. */
  readonly at: string;
  /** UTF-8 bytes. */
  readonly size: number;
  readonly kind: JsonRpcMessageKind;
  readonly id?: JsonRpcId;
  /** A request's or notification's own; for a response, the method of the request it answers. */
  readonly method?: string;
  /** The message as it went or came. Empty for a received message over the size cap, which is not kept. */
  readonly text: string;
  readonly warnings: readonly string[];
  /** Never set by a session: History's cap sets it on a message whose text it left out. */
  readonly payloadTruncated?: true;
}

/** How the server answered the operation. */
export type McpResponse = { readonly result: unknown } | { readonly error: JsonRpcErrorObject };

/** What a session did. */
export interface McpSessionOutcome {
  /** ISO 8601. */
  readonly startedAt: string;
  readonly durationMs: number;
  /** At most {@link MCP_MAX_MESSAGES}, the first ones; the rest are counted in `droppedMessages`. */
  readonly messages: readonly McpMessage[];
  readonly droppedMessages: number;
  /** The server's `initialize` result, as it came. */
  readonly initialize?: Readonly<Record<string, unknown>>;
  /** The version the server answered `initialize` with. */
  readonly protocolVersion?: string;
  /** The operation's answer; absent when the session failed before one came. */
  readonly response?: McpResponse;
  /** Why the session could not finish; absent when it did. */
  readonly failure?: McpError;
}

interface Pending {
  readonly method: string;
  readonly validate?: (result: unknown) => readonly string[];
  readonly answer: (response: McpResponse) => void;
}

/** How a failure ends the session: a forced close, and whether the request still waiting is cancelled first. */
interface FailOptions {
  readonly force?: boolean;
  readonly cancelReason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Run one session to its end: the handshake, `options.operation`, close. Never rejects. */
export function runMcpSession(options: McpSessionOptions): Promise<McpSessionOutcome> {
  const { operation } = options;
  return runDrivenMcpSession(options, (session) => session.call(operation));
}

/**
 * Run one session whose calls after the handshake are `drive`'s, as many as it sends: a catalogue
 * refresh lists each kind and follows its pages on one session. The outcome's `response` is what
 * `drive` resolves with. A `drive` that throws fails the session with its error. Never rejects.
 */
export async function runDrivenMcpSession(
  options: McpSessionBaseOptions,
  drive: (session: McpSessionDriver) => Promise<McpResponse | undefined>,
): Promise<McpSessionOutcome> {
  const { transport } = options;
  const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();

  const messages: McpMessage[] = [];
  let droppedMessages = 0;
  const pending = new Map<JsonRpcId, Pending>();
  let nextId = 1;
  let initializeId: JsonRpcId | undefined;
  let closing = false;
  let finished = false;

  let failure: McpError | undefined;
  let failOptions: FailOptions = {};
  let rejectFailed: (error: McpError) => void = () => undefined;
  // Every step races this, so a failure from anywhere (the transport, the deadline, a cancel)
  // ends whichever step is waiting.
  const failed = new Promise<never>((_, reject) => {
    rejectFailed = reject;
  });
  failed.catch(() => undefined);

  let initialize: Readonly<Record<string, unknown>> | undefined;
  let protocolVersion: string | undefined;
  let response: McpResponse | undefined;

  const fail = (error: McpError, how: FailOptions = {}): void => {
    if (failure !== undefined || finished) return;
    failure = error;
    failOptions = how;
    rejectFailed(error);
  };

  const record = (message: Omit<McpMessage, 'at'>): void => {
    if (messages.length >= MCP_MAX_MESSAGES) {
      droppedMessages += 1;
      return;
    }
    const kept: McpMessage = { at: new Date().toISOString(), ...message };
    messages.push(kept);
    options.onMessage?.(kept);
  };

  const race = <T>(step: Promise<T>): Promise<T> => Promise.race([step, failed]);

  /** Hand one encoded message to the transport and record it. A refused send fails the session. */
  const transmit = async (text: string, entry: Pick<McpMessage, 'kind' | 'id' | 'method'>): Promise<void> => {
    const size = byteLength(text);
    if (size > MCP_MAX_MESSAGE_BYTES) {
      throw new McpError(
        'mcp-message-too-large',
        `The ${entry.method ?? 'message'} message is ${size} bytes, larger than ${MCP_MAX_MESSAGE_BYTES}`,
        {
          details: {
            bytes: size,
            limit: MCP_MAX_MESSAGE_BYTES,
            ...(entry.method !== undefined ? { method: entry.method } : {}),
          },
        },
      );
    }
    record({ direction: 'sent', size, text, warnings: [], ...withoutUndefined(entry) });
    try {
      await race(transport.send(text));
    } catch (err) {
      const error = asMcpError(err);
      fail(error, { force: true });
      throw error;
    }
  };

  const request = async (
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    validate?: (result: unknown) => readonly string[],
  ): Promise<McpResponse> => {
    const id = nextId++;
    if (method === 'initialize') initializeId = id;
    const answered = new Promise<McpResponse>((answer) => {
      pending.set(id, { method, answer, ...(validate !== undefined ? { validate } : {}) });
    });
    await transmit(encodeRequest(id, method, params), { kind: 'request', id, method });
    return race(answered);
  };

  const notify = (method: string, params?: Readonly<Record<string, unknown>>): Promise<void> =>
    transmit(encodeNotification(method, params), { kind: 'notification', method });

  const refuseServerRequest = (message: InspectedMessage & { id: JsonRpcId }): void => {
    // Once closing, the transport may be gone; the request is still recorded, just not answered.
    if (closing) return;
    const text = encodeError(message.id, {
      code: JSONRPC_METHOD_NOT_FOUND,
      message: `Method not found: ${message.method ?? ''}`,
    });
    transmit(text, {
      kind: 'error',
      id: message.id,
      ...(message.method !== undefined ? { method: message.method } : {}),
    }).catch(() => undefined);
  };

  const receive = (message: InspectedMessage, size: number): void => {
    const base = { direction: 'received' as const, size, kind: message.kind, text: message.text };
    const ids = message.id !== undefined ? { id: message.id } : {};
    if (message.kind === 'result' || message.kind === 'error') {
      const waiting = pending.get(message.id!);
      if (waiting === undefined) {
        record({
          ...base,
          ...ids,
          warnings: [...message.warnings, 'The response answers no request this session is waiting on'],
        });
        return;
      }
      pending.delete(message.id!);
      const answer: McpResponse =
        message.kind === 'error' ? { error: errorObjectOf(message.value) } : { result: resultOf(message.value) };
      const resultWarnings =
        'result' in answer && waiting.validate !== undefined ? waiting.validate(answer.result) : [];
      record({ ...base, ...ids, method: waiting.method, warnings: [...message.warnings, ...resultWarnings] });
      waiting.answer(answer);
      return;
    }
    record({
      ...base,
      ...ids,
      ...(message.method !== undefined ? { method: message.method } : {}),
      warnings: message.warnings,
    });
    if (message.kind === 'request') refuseServerRequest(message as InspectedMessage & { id: JsonRpcId });
  };

  const onText = (text: string): void => {
    if (finished) return;
    const size = byteLength(text);
    if (size > MCP_MAX_MESSAGE_BYTES) {
      record({
        direction: 'received',
        size,
        kind: 'invalid',
        text: '',
        warnings: [`The message is ${size} bytes, larger than ${MCP_MAX_MESSAGE_BYTES}, and is not kept`],
      });
      fail(
        new McpError(
          'mcp-message-too-large',
          `The MCP server sent a message of ${size} bytes, larger than ${MCP_MAX_MESSAGE_BYTES}`,
          {
            details: { bytes: size, limit: MCP_MAX_MESSAGE_BYTES },
          },
        ),
        { force: true },
      );
      return;
    }
    const read = readMessages(text);
    for (const message of read) receive(message, read.length === 1 ? size : byteLength(message.text));
  };

  const timer = setTimeout(() => {
    fail(
      new McpError('mcp-timeout', `The MCP session did not finish within ${timeoutMs} ms`, {
        details: { timeoutMs, waitingFor: [...pending.values()].map((p) => p.method) },
      }),
      { force: true, cancelReason: `Timed out after ${timeoutMs} ms` },
    );
  }, timeoutMs);
  const onAbort = (): void =>
    fail(new McpError('mcp-cancelled', 'The MCP send was cancelled'), { force: true, cancelReason: 'Cancelled' });

  let started = false;
  try {
    if (options.signal?.aborted === true) throw new McpError('mcp-cancelled', 'The MCP send was cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    await race(
      transport.start({
        onMessage: onText,
        onClose: (error) => {
          if (closing) return;
          fail(
            error ??
              new McpError('mcp-connection-closed', 'The MCP server closed the connection before the session finished'),
            { force: true },
          );
        },
        onError: (error) => fail(error, { force: true }),
      }),
    );
    started = true;

    const requested = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
    const init = await request(
      'initialize',
      {
        protocolVersion: requested,
        capabilities: {},
        clientInfo: { name: 'wirebench', version: options.clientVersion },
      },
      (result) => {
        const parsed = InitializeResultSchema.safeParse(result);
        return parsed.success
          ? []
          : formatIssues('The initialize result does not match the protocol', parsed.error.issues);
      },
    );
    if ('error' in init) {
      throw new McpError(
        'mcp-initialize-failed',
        `The MCP server refused initialize: ${init.error.code} ${init.error.message}`.trimEnd(),
        { details: { error: init.error } },
      );
    }
    initialize = isRecord(init.result) ? init.result : undefined;
    const offered = initialize?.['protocolVersion'];
    if (typeof offered === 'string') protocolVersion = offered;
    if (typeof offered !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(offered)) {
      throw new McpError(
        'mcp-protocol-unsupported',
        `The MCP server answered with protocol version ${typeof offered === 'string' ? `"${offered}"` : 'none'}, which this client does not support`,
        { details: { requested, offered: offered ?? null, supported: [...SUPPORTED_PROTOCOL_VERSIONS] } },
      );
    }
    const capabilities = initialize?.['capabilities'];
    // `notifications/initialized` goes once, after the first call's capability check, so a call the
    // server cannot take is refused before anything follows the handshake.
    let initialized = false;
    const driver: McpSessionDriver = {
      initialize,
      async call(operation) {
        if (operation.capability !== undefined) {
          const advertised = isRecord(capabilities) ? capabilities[operation.capability] : undefined;
          if (advertised === undefined || advertised === null) {
            throw new McpError(
              'mcp-capability-missing',
              `The MCP server does not advertise "${operation.capability}", which ${operation.method} needs`,
              { details: { capability: operation.capability, method: operation.method } },
            );
          }
        }
        if (!initialized) {
          initialized = true;
          await notify('notifications/initialized');
        }
        return request(operation.method, operation.params, operation.validateResult);
      },
    };
    response = await race(drive(driver));
    if (!initialized) await notify('notifications/initialized');
  } catch (err) {
    // A step that throws its own error (a refused handshake, a capability the server lacks) closes
    // gracefully; one that lost a race to `failed` already set the failure and how to close.
    fail(asMcpError(err));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (failOptions.cancelReason !== undefined && started) {
    // The protocol forbids cancelling `initialize`; any other request still waiting is cancelled
    // before the connection goes, as a courtesy that is not waited on for long.
    const notices = [...pending.keys()]
      .filter((id) => id !== initializeId)
      .map((id) => {
        const text = encodeNotification('notifications/cancelled', { requestId: id, reason: failOptions.cancelReason });
        record({
          direction: 'sent',
          size: byteLength(text),
          kind: 'notification',
          method: 'notifications/cancelled',
          text,
          warnings: [],
        });
        return transport.send(text).catch(() => undefined);
      });
    if (notices.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      const cap = new Promise<void>((done) => {
        timer = setTimeout(done, MCP_CANCEL_NOTICE_MS);
      });
      await Promise.race([Promise.all(notices), cap]);
      clearTimeout(timer);
    }
  }

  closing = true;
  // Always, even when `start` failed or never ran: a transport half-started must still be torn down.
  await transport.close(failOptions.force === true ? { force: true } : {}).catch(() => undefined);
  finished = true;

  return {
    startedAt,
    durationMs: performance.now() - startedMs,
    messages,
    droppedMessages,
    ...(initialize !== undefined ? { initialize } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

function asMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McpError('mcp-transport-failed', message, { cause: err });
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
