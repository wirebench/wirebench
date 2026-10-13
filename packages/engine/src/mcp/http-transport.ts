/**
 * The Streamable HTTP transport (#79): every client message is a `POST` to the server's URL.
 *
 * Each `POST` says it takes `application/json` or `text/event-stream`, and the server picks. A JSON
 * body is one message (or a batch); an event stream is read event by event, each event's data one
 * message, until the server ends it. A `202` with no body is how a notification, or the client's own
 * answer to a server request, is acknowledged.
 *
 * The session id the server gives in its `initialize` response goes on every later call as
 * `Mcp-Session-Id`, and the protocol version it answered with as `MCP-Protocol-Version`. The
 * transport reads that version off the `initialize` answer itself, so the session stays the same
 * for every transport. On close, a session that has an id is ended with a `DELETE`; a server that
 * does not allow that answers `405`, which is fine.
 *
 * The optional `GET` stream for messages the server sends unasked is not opened: one operation
 * needs only what comes back on its own `POST`.
 *
 * `send` resolves once the call is answered: for an event stream, once the server has ended it. A
 * call answered with a status that is not 2xx fails the session with `mcp-http-status`.
 */
import { McpError } from '../errors.js';
import { sendHttp } from '../http/client.js';
import { isEventStream } from '../http/sse.js';
import type { HttpExchange, HttpStreamHook } from '../http/types.js';
import {
  bodyText,
  callEnd,
  callTimeoutMs,
  closeMcpDispatcher,
  eventStreamReader,
  httpFailedError,
  httpStatusError,
  isSuccess,
  McpHttpCallLog,
  messageSummary,
  openMcpDispatcher,
  tooLargeError,
  withHeaders,
  type McpDispatcher,
  type McpHttpCall,
  settleWithin,
  type McpHttpConnectionOptions,
} from './http-calls.js';
import type { JsonRpcId } from './jsonrpc.js';
import { MCP_HTTP_CLOSE_MS, MCP_MAX_MESSAGE_BYTES } from './limits.js';
import type { McpWireCloseOptions, McpWireHandlers, McpWireTransport } from './transport.js';

/** The `Accept` of every `POST`. */
export const MCP_HTTP_ACCEPT = 'application/json, text/event-stream';

/** A Streamable HTTP transport, with what the exchange records about its calls. */
export interface McpStreamableHttpTransport extends McpWireTransport {
  /** Every call so far, `DELETE` included, in the order they started. */
  readonly calls: readonly McpHttpCall[];
  /** The id the server gave in its `initialize` response; absent when it gave none. */
  readonly sessionId: string | undefined;
  /** The version the server answered `initialize` with, sent on every later call. */
  readonly protocolVersion: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Open a Streamable HTTP transport. Nothing is sent until the session's first message. */
export function openStreamableHttpTransport(options: McpHttpConnectionOptions): McpStreamableHttpTransport {
  const log = new McpHttpCallLog();
  const controller = new AbortController();
  let handlers: McpWireHandlers | undefined;
  let dispatcher: McpDispatcher | undefined;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let initializeId: JsonRpcId | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();

  /** Reads the protocol version off the `initialize` answer, then hands the text on unchanged. */
  const deliver = (text: string): void => {
    if (protocolVersion === undefined && initializeId !== undefined) {
      try {
        const value = JSON.parse(text) as unknown;
        for (const message of Array.isArray(value) ? value : [value]) {
          if (!isRecord(message) || message['id'] !== initializeId || !isRecord(message['result'])) continue;
          const version = message['result']['protocolVersion'];
          if (typeof version === 'string') protocolVersion = version;
        }
      } catch {
        // Not JSON: the session records it as invalid; there is no version to read.
      }
    }
    handlers?.onMessage(text);
  };

  /** The headers of a call after `initialize`: the session id and the version, where known. */
  const sessionHeaders = (): Record<string, string> => ({
    ...(sessionId !== undefined ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(protocolVersion !== undefined ? { 'MCP-Protocol-Version': protocolVersion } : {}),
  });

  const track = <T>(call: Promise<T>): Promise<T> => {
    inFlight.add(call);
    void call.finally(() => inFlight.delete(call)).catch(() => undefined);
    return call;
  };

  const post = async (text: string): Promise<void> => {
    const message = messageSummary(text);
    if (message?.method === 'initialize' && message.id !== undefined) initializeId = message.id;
    const what = message?.method ?? 'a response';
    const headers = withHeaders(options.headers, {
      'Content-Type': 'application/json',
      Accept: MCP_HTTP_ACCEPT,
      ...sessionHeaders(),
    });
    const end = log.begin({ method: 'POST', url: options.url, requestHeaders: headers, message: message ?? {} });

    let streamFailure: McpError | undefined;
    let reader: ReturnType<typeof eventStreamReader> | undefined;
    const stream: HttpStreamHook = {
      accept(status, responseHeaders) {
        if (!isSuccess(status) || !isEventStream(responseHeaders['content-type'])) return undefined;
        const events = eventStreamReader(
          (event, data) => {
            if (event === 'message' && data.trim() !== '') deliver(data);
          },
          (error) => {
            streamFailure = error;
            controller.abort();
          },
        );
        // The parser is flushed when the stream ends, below; an event left open then is dropped.
        reader = events;
        return { onChunk: (bytes) => events.push(bytes, performance.now()) };
      },
    };

    let exchange: HttpExchange;
    try {
      exchange = await sendHttp(
        {
          url: options.url,
          method: 'POST',
          headers,
          body: Buffer.from(text, 'utf8'),
          timeoutMs: callTimeoutMs(options),
          followRedirects: false,
          // One over the cap, so a body that is too large shows as truncated.
          maxSizeBytes: MCP_MAX_MESSAGE_BYTES + 1,
          signal: controller.signal,
          stream,
        },
        { dispatcher: dispatcher!.dispatcher },
      );
    } catch (err) {
      const error = httpFailedError(err, 'POST', options.url);
      end({ error: error.message });
      throw error;
    }
    reader?.end();
    end(callEnd(exchange));

    if (streamFailure !== undefined) throw streamFailure;
    if (!isSuccess(exchange.status)) throw httpStatusError(exchange, what);
    const givenId = exchange.headers['mcp-session-id'];
    if (message?.method === 'initialize' && givenId !== undefined && givenId !== '') sessionId = givenId;
    if (exchange.streamEnd !== undefined) {
      if (exchange.streamEnd.by === 'error' && !closing) {
        throw new McpError(
          'mcp-transport-failed',
          `The event stream answering ${what} broke: ${exchange.streamEnd.error ?? 'unknown error'}`,
          { details: { url: options.url } },
        );
      }
      return;
    }
    if (exchange.truncated) throw tooLargeError(exchange.body.length);
    if (exchange.body.length > 0) deliver(bodyText(exchange.body));
  };

  const endSession = async (): Promise<void> => {
    if (sessionId === undefined || dispatcher === undefined) return;
    const headers = withHeaders(options.headers, sessionHeaders());
    const end = log.begin({ method: 'DELETE', url: options.url, requestHeaders: headers });
    try {
      // Any status is fine: a server that does not end sessions this way answers 405.
      end(
        callEnd(
          await sendHttp(
            {
              url: options.url,
              method: 'DELETE',
              headers,
              timeoutMs: Math.min(MCP_HTTP_CLOSE_MS, callTimeoutMs(options)),
              followRedirects: false,
              maxSizeBytes: 64 * 1024,
            },
            { dispatcher: dispatcher.dispatcher },
          ),
        ),
      );
    } catch (err) {
      end({ error: httpFailedError(err, 'DELETE', options.url).message });
    }
  };

  return {
    get calls() {
      return log.calls;
    },
    get sessionId() {
      return sessionId;
    },
    get protocolVersion() {
      return protocolVersion;
    },

    start(given: McpWireHandlers): Promise<void> {
      handlers = given;
      try {
        const url = new URL(options.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new McpError(
            'mcp-bad-url',
            `An MCP server over HTTP needs an http or https URL, not "${options.url}"`,
            {
              details: { url: options.url },
            },
          );
        }
        dispatcher = openMcpDispatcher(options);
      } catch (err) {
        if (err instanceof McpError) return Promise.reject(err);
        return Promise.reject(
          new McpError('mcp-bad-url', `"${options.url}" is not a URL`, { details: { url: options.url }, cause: err }),
        );
      }
      return Promise.resolve();
    },

    send(text: string): Promise<void> {
      if (dispatcher === undefined || closing) {
        return Promise.reject(new McpError('mcp-connection-closed', 'The MCP server connection is closed'));
      }
      return track(post(text));
    },

    close(closeOptions: McpWireCloseOptions = {}): Promise<void> {
      if (closePromise !== undefined) {
        if (closeOptions.force === true) controller.abort();
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        // A forced close does not wait for answers still coming; a graceful one lets them finish.
        if (closeOptions.force === true) controller.abort();
        else await settleWithin([...inFlight], MCP_HTTP_CLOSE_MS);
        await endSession();
        controller.abort();
        await settleWithin([...inFlight], MCP_HTTP_CLOSE_MS);
        await closeMcpDispatcher(dispatcher, closeOptions.force === true);
      })();
      return closePromise;
    },
  };
}
