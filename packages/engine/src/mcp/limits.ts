/** The fixed limits of an MCP session (#79). Each is a constant, not a setting. */

/** A message larger than this, in either direction, fails the session with `mcp-message-too-large`. */
export const MCP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** The exchange keeps this many messages; later ones are counted, not kept. */
export const MCP_MAX_MESSAGES = 1_000;

/** The deadline of a whole session when neither the request nor the server sets one. */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/** A stdio server's stderr is kept as text, its last this-many bytes. */
export const MCP_STDERR_CAP_BYTES = 64 * 1024;

/** After stdin is ended, how long a stdio server has to exit before it is sent `SIGTERM`. */
export const MCP_STDIO_TERM_GRACE_MS = 2_000;

/** After `SIGTERM`, how long a stdio server has to exit before it is sent `SIGKILL`. */
export const MCP_STDIO_KILL_GRACE_MS = 2_000;

/** How long the `notifications/cancelled` sent when the deadline passes may take before the session closes anyway. */
export const MCP_CANCEL_NOTICE_MS = 500;

/** How long closing an HTTP session may take: the `DELETE` that ends it, and calls still finishing. */
export const MCP_HTTP_CLOSE_MS = 2_000;
