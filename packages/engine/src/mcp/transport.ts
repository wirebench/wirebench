/**
 * What an MCP session needs from a transport (#79): a pipe for JSON-RPC text in both directions.
 *
 * The session owns everything above the bytes: ids, the handshake, the deadline, the recording and
 * the size caps. A transport only moves text. Each piece of text it hands to `onMessage` is one
 * message (a stdio line, an SSE event's data, a JSON response body), and `send` is given one
 * encoded message at a time. stdio (`stdio.ts`), Streamable HTTP and the legacy HTTP+SSE transport
 * all implement this, so the session never branches on which one it has.
 *
 * The name says *wire* because `McpTransport` in `model.ts` is the saved configuration.
 */
import type { McpError } from '../errors.js';

/** The callbacks a transport calls; the session passes them to `start`. */
export interface McpWireHandlers {
  /** One message's text, exactly as it arrived. */
  onMessage(text: string): void;
  /**
   * The connection ended. `error` is set when it ended without the session asking (a stdio server
   * that exited, a stream the server closed); a close the session asked for gives none.
   */
  onClose(error?: McpError): void;
  /** Something failed that the session cannot go on after (an oversized line, a broken pipe). */
  onError(error: McpError): void;
}

/** How a session closes its transport. */
export interface McpWireCloseOptions {
  /**
   * Skip the grace periods: a stdio server is killed at once, an HTTP request is aborted. Used when
   * the deadline passes or the caller cancels, so that a stuck server cannot hold the send.
   */
  readonly force?: boolean;
}

/** One connection to one MCP server, for one session. */
export interface McpWireTransport {
  /** Connect. Resolves once messages can be sent. @throws McpError */
  start(handlers: McpWireHandlers): Promise<void>;
  /** Send one encoded message. Resolves once it is handed over (written, or POSTed and answered). @throws McpError */
  send(text: string): Promise<void>;
  /** Idempotent, and never rejects. Resolves once the connection, or the process, is gone. */
  close(options?: McpWireCloseOptions): Promise<void>;
}
