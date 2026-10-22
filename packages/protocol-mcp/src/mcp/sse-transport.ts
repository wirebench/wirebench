/**
 * The legacy HTTP+SSE transport (#79), for servers that predate Streamable HTTP.
 *
 * A `GET` to the server's URL opens an event stream that stays open for the whole session. Its
 * first `endpoint` event names the URL client messages are `POST`ed to, resolved against the
 * stream's URL. That URL must have the stream's origin (`mcp-endpoint-origin`): a server, or
 * anything between it and the client, must not be able to send the session's messages, and the
 * credentials on them, somewhere else. Each `POST` is only acknowledged (`202`); every answer
 * arrives on the stream as a `message` event.
 *
 * `start` resolves once the endpoint is known. A stream that ends before naming one fails with
 * `mcp-endpoint-missing`; one that ends during the session closes it. On close, the stream and any
 * call still out are aborted.
 */
import { McpError } from '#core/errors';
import { sendHttp } from '#core/http/client';
import { isEventStream } from '#core/http/sse';
import type { HttpExchange } from '#core/http/types';
import {
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
  settleWithin,
  withHeaders,
  type McpDispatcher,
  type McpHttpCall,
  type McpHttpConnectionOptions,
} from './http-calls.js';
import { MCP_HTTP_CLOSE_MS } from './limits.js';
import type { McpWireCloseOptions, McpWireHandlers, McpWireTransport } from './transport.js';

/** A legacy HTTP+SSE transport, with what the exchange records about its calls. */
export interface McpSseTransport extends McpWireTransport {
  /** The `GET` that opened the stream, then every `POST`, in the order they started. */
  readonly calls: readonly McpHttpCall[];
  /** The URL the `endpoint` event named, resolved; absent until it came. */
  readonly endpoint: string | undefined;
}

/** Open a legacy HTTP+SSE transport. Nothing is sent until `start`. */
export function openSseTransport(options: McpHttpConnectionOptions): McpSseTransport {
  const log = new McpHttpCallLog();
  const controller = new AbortController();
  let handlers: McpWireHandlers | undefined;
  let dispatcher: McpDispatcher | undefined;
  let endpoint: URL | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let stream: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();

  const track = <T>(call: Promise<T>): Promise<T> => {
    inFlight.add(call);
    void call.finally(() => inFlight.delete(call)).catch(() => undefined);
    return call;
  };

  /** Opens the stream; resolves once the endpoint is known, and then reads the stream to its end. */
  const open = (streamUrl: URL): Promise<void> =>
    new Promise<void>((started, failed) => {
      let isStarted = false;
      /** Before the endpoint is known, a failure fails `start`; after it, it closes the session. */
      const lose = (error: McpError): void => {
        if (!isStarted) {
          isStarted = true;
          controller.abort();
          failed(error);
        } else if (!closing) {
          handlers?.onClose(error);
        }
      };
      const onEvent = (event: string, data: string): void => {
        if (event === 'endpoint') {
          if (endpoint !== undefined) return;
          let named: URL;
          try {
            named = new URL(data.trim(), streamUrl);
          } catch (err) {
            lose(
              new McpError('mcp-endpoint-invalid', `The MCP server named an endpoint that is not a URL: "${data}"`, {
                details: { endpoint: data },
                cause: err,
              }),
            );
            return;
          }
          if (named.origin !== streamUrl.origin) {
            lose(
              new McpError(
                'mcp-endpoint-origin',
                `The MCP server named an endpoint on another origin (${named.origin}), not ${streamUrl.origin}`,
                {
                  details: {
                    endpoint: named.toString(),
                    origin: streamUrl.origin,
                  },
                },
              ),
            );
            return;
          }
          endpoint = named;
          isStarted = true;
          started();
          return;
        }
        if (event === 'message' && data.trim() !== '') handlers?.onMessage(data);
      };
      const reader = eventStreamReader(onEvent, lose);

      const headers = withHeaders(options.headers, {
        Accept: 'text/event-stream',
      });
      const end = log.begin({
        method: 'GET',
        url: options.url,
        requestHeaders: headers,
      });
      stream = sendHttp(
        {
          url: options.url,
          method: 'GET',
          headers,
          timeoutMs: callTimeoutMs(options),
          followRedirects: false,
          maxSizeBytes: 64 * 1024,
          signal: controller.signal,
          stream: {
            accept: (status, responseHeaders) =>
              isSuccess(status) && isEventStream(responseHeaders['content-type'])
                ? { onChunk: (bytes) => reader.push(bytes, performance.now()) }
                : undefined,
          },
        },
        { dispatcher: dispatcher!.dispatcher },
      ).then(
        (exchange: HttpExchange) => {
          reader.end();
          end(callEnd(exchange));
          if (!isSuccess(exchange.status)) return lose(httpStatusError(exchange, 'the event-stream GET'));
          if (exchange.streamEnd === undefined) {
            return lose(
              new McpError(
                'mcp-stream-expected',
                `The MCP server answered the GET with "${exchange.headers['content-type'] ?? 'no content type'}", not an event stream`,
                {
                  details: {
                    url: options.url,
                    contentType: exchange.headers['content-type'] ?? null,
                  },
                },
              ),
            );
          }
          if (endpoint === undefined) {
            return lose(
              new McpError(
                'mcp-endpoint-missing',
                'The MCP server closed the event stream before naming its endpoint',
                {
                  details: { url: options.url },
                },
              ),
            );
          }
          lose(
            new McpError(
              'mcp-connection-closed',
              exchange.streamEnd.by === 'error'
                ? `The MCP server's event stream broke: ${exchange.streamEnd.error ?? 'unknown error'}`
                : 'The MCP server closed the event stream before the session finished',
              { details: { url: options.url } },
            ),
          );
        },
        (err: unknown) => {
          const error = httpFailedError(err, 'GET', options.url);
          end({ error: error.message });
          lose(error);
        },
      );
    });

  const post = async (text: string): Promise<void> => {
    const url = endpoint!.toString();
    const message = messageSummary(text);
    const headers = withHeaders(options.headers, {
      'Content-Type': 'application/json',
    });
    const end = log.begin({
      method: 'POST',
      url,
      requestHeaders: headers,
      message: message ?? {},
    });
    let exchange: HttpExchange;
    try {
      exchange = await sendHttp(
        {
          url,
          method: 'POST',
          headers,
          body: Buffer.from(text, 'utf8'),
          timeoutMs: callTimeoutMs(options),
          followRedirects: false,
          // The answer comes on the stream; this body is only an acknowledgement.
          maxSizeBytes: 64 * 1024,
          signal: controller.signal,
        },
        { dispatcher: dispatcher!.dispatcher },
      );
    } catch (err) {
      const error = httpFailedError(err, 'POST', url);
      end({ error: error.message });
      throw error;
    }
    end(callEnd(exchange));
    if (!isSuccess(exchange.status)) throw httpStatusError(exchange, message?.method ?? 'a response');
  };

  return {
    get calls() {
      return log.calls;
    },
    get endpoint() {
      return endpoint?.toString();
    },

    start(given: McpWireHandlers): Promise<void> {
      handlers = given;
      let streamUrl: URL;
      try {
        streamUrl = new URL(options.url);
      } catch (err) {
        return Promise.reject(
          new McpError('mcp-bad-url', `"${options.url}" is not a URL`, {
            details: { url: options.url },
            cause: err,
          }),
        );
      }
      if (streamUrl.protocol !== 'http:' && streamUrl.protocol !== 'https:') {
        return Promise.reject(
          new McpError('mcp-bad-url', `An MCP server over HTTP needs an http or https URL, not "${options.url}"`, {
            details: { url: options.url },
          }),
        );
      }
      try {
        dispatcher = openMcpDispatcher(options);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return open(streamUrl);
    },

    send(text: string): Promise<void> {
      if (endpoint === undefined || closing) {
        return Promise.reject(new McpError('mcp-connection-closed', 'The MCP server connection is closed'));
      }
      return track(post(text));
    },

    close(closeOptions: McpWireCloseOptions = {}): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        // A graceful close lets the last acknowledgements in; the stream itself is always aborted.
        if (closeOptions.force !== true) await settleWithin([...inFlight], MCP_HTTP_CLOSE_MS);
        controller.abort();
        await settleWithin([...inFlight, ...(stream !== undefined ? [stream] : [])], MCP_HTTP_CLOSE_MS);
        await closeMcpDispatcher(dispatcher, closeOptions.force === true);
      })();
      return closePromise;
    },
  };
}
