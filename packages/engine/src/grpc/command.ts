/**
 * The command-line equivalent of a call, for the Code panel: what a person would type at a shell
 * to make the same call with a command-line gRPC client that takes JSON and `.proto` files. The
 * same value the send path uses is what is rendered, so what the panel shows is what would be sent;
 * credentials are replaced with a stand-in unless the caller says otherwise.
 */

import { quoteForShell } from '../http/curl.js';
import type { KeyValueEntry } from '../rest/model.js';
import type { GrpcSendInput } from './send.js';

/** Options for {@link grpcToCommand}. */
export interface GrpcToCommandOptions {
  /** Replace secret values with a stand-in. On by default. */
  readonly redactSecrets?: boolean;
  /** The `.proto` files to name with `-proto`; the import root is passed as `-import-path`. */
  readonly protoFiles?: readonly string[];
  readonly importPath?: string;
  readonly shell?: 'posix' | 'powershell';
}

/** The stand-in a redacted secret is rendered as. */
export const GRPC_COMMAND_REDACTED = '<redacted>';

/** Header names whose values are secrets whatever the request calls them. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function headerRows(
  input: Pick<GrpcSendInput, 'metadata' | 'auth' | 'defaultMetadata'>,
  redact: boolean,
): KeyValueEntry[] {
  const rows: KeyValueEntry[] = [];
  for (const [name, value] of Object.entries(input.defaultMetadata ?? {})) {
    rows.push({ name, value, enabled: true });
  }
  if (input.auth !== undefined) {
    switch (input.auth.type) {
      case 'bearer':
        rows.push({
          name: 'authorization',
          value: `${input.auth.scheme ?? 'Bearer'} ${redact ? GRPC_COMMAND_REDACTED : input.auth.token}`,
          enabled: true,
        });
        break;
      case 'oauth2':
        rows.push({
          name: 'authorization',
          value: `Bearer ${redact ? GRPC_COMMAND_REDACTED : input.auth.accessToken}`,
          enabled: true,
        });
        break;
      case 'api-key':
        rows.push({
          name: input.auth.name.toLowerCase(),
          value: redact ? GRPC_COMMAND_REDACTED : input.auth.value,
          enabled: true,
        });
        break;
      case 'basic':
        rows.push({
          name: 'authorization',
          value: `Basic ${redact ? GRPC_COMMAND_REDACTED : Buffer.from(`${input.auth.username}:${input.auth.password}`).toString('base64')}`,
          enabled: true,
        });
        break;
      default:
        break;
    }
  }
  for (const row of input.metadata) {
    if (row.enabled && row.name.trim() !== '') {
      const name = row.name.trim().toLowerCase();
      rows.push({ name, value: redact && SECRET_HEADERS.has(name) ? GRPC_COMMAND_REDACTED : row.value, enabled: true });
    }
  }
  return rows;
}

/**
 * Renders one call as a shell command. `messageText` is the request JSON, one object or an array,
 * passed as the data argument; a client stream is what an array means to such a tool as well.
 */
export function grpcToCommand(
  input: Pick<
    GrpcSendInput,
    'target' | 'tls' | 'service' | 'method' | 'metadata' | 'auth' | 'defaultMetadata' | 'timeoutMs'
  >,
  messageText: string,
  options: GrpcToCommandOptions = {},
): string {
  const shell = options.shell ?? 'posix';
  const q = (value: string): string => quoteForShell(value, shell);
  const parts: string[] = ['grpcurl'];
  if (!input.tls) {
    parts.push('-plaintext');
  }
  if (options.importPath !== undefined) {
    parts.push('-import-path', q(options.importPath));
  }
  for (const file of options.protoFiles ?? []) {
    parts.push('-proto', q(file));
  }
  parts.push('-max-time', String(Math.max(1, Math.ceil(input.timeoutMs / 1000))));
  for (const row of headerRows(input, options.redactSecrets !== false)) {
    parts.push('-H', q(`${row.name}: ${row.value}`));
  }
  const compact = messageText.trim() === '' ? '{}' : messageText.trim();
  parts.push('-d', q(compact));
  parts.push(q(input.target), q(`${input.service}/${input.method}`));
  // One option per line, its value on the same line, so the command reads top to bottom.
  const continuation = shell === 'powershell' ? ' `\n  ' : ' \\\n  ';
  let out = parts[0] ?? '';
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    out += part.startsWith('-') || index === parts.length - 2 ? `${continuation}${part}` : ` ${part}`;
  }
  return out;
}
