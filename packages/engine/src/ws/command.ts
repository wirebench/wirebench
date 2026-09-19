/**
 * The command-line equivalent of a WebSocket session, for the Code panel: what a person would
 * type at a shell to dial the same URL with `websocat`, a generic open-source WebSocket
 * command-line client (as `grpcurl` is in `grpc/command.ts`).
 */

import { quoteForShell } from '../http/curl.js';
import type { WsSessionOptions } from './session.js';

/** Options for {@link wsToCommand}. */
export interface WsToCommandFlags {
  /** `-k`: connect even when the certificate does not verify. */
  readonly insecure?: boolean;
  readonly shell?: 'posix' | 'powershell';
}

/**
 * Renders a session's options as a `websocat` command line: `-H='name: value'` per header, in
 * insertion order, `--protocol` with the subprotocols joined by a comma when there are any, `-k`
 * when the caller says the connection is insecure, and the URL last, every argument quoted for
 * the shell.
 */
export function wsToCommand(
  options: Pick<WsSessionOptions, 'url' | 'headers' | 'subprotocols'>,
  flags: WsToCommandFlags = {},
): string {
  const shell = flags.shell ?? 'posix';
  const q = (value: string): string => quoteForShell(value, shell);
  const parts: string[] = ['websocat'];
  if (flags.insecure === true) {
    parts.push('-k');
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    parts.push(`-H=${q(`${name}: ${value}`)}`);
  }
  if (options.subprotocols !== undefined && options.subprotocols.length > 0) {
    parts.push('--protocol', q(options.subprotocols.join(',')));
  }
  parts.push(q(options.url));
  return parts.join(' ');
}
