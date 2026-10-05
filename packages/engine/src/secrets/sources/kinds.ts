/**
 * One fixed command per kind (secret sources spec D1, ADR-0020): the tool and the argument shape are
 * Wirebench's; the mapping supplies only validated values (`parse.ts`), none of which can be a flag.
 */

import { secretSourceError } from './errors.js';
import type { SecretSource } from './parse.js';

export interface SourceCommand {
  readonly tool: string;
  readonly args: readonly string[];
}

/** The tool a source runs on `platform`. */
export function toolOf(source: SecretSource, platform: NodeJS.Platform): string {
  switch (source.kind) {
    case 'vault':
      return 'vault';
    case 'aws':
      return 'aws';
    case 'gcp':
      return 'gcloud';
    case 'azure':
      return 'az';
    case '1password':
      return 'op';
    case 'keychain':
      return platform === 'darwin' ? 'security' : 'secret-tool';
  }
}

/** The command for `source`. @throws `secret-source-unsupported` for the keychain on Windows. */
export function argvFor(source: SecretSource, platform: NodeJS.Platform): SourceCommand {
  const tool = toolOf(source, platform);
  switch (source.kind) {
    case 'vault':
      return {
        tool,
        args: [
          'kv',
          'get',
          `-field=${source.field}`,
          ...(source.mount !== undefined ? [`-mount=${source.mount}`] : []),
          ...(source.namespace !== undefined ? [`-namespace=${source.namespace}`] : []),
          source.path,
        ],
      };
    case 'aws':
      return {
        tool,
        args: [
          'secretsmanager',
          'get-secret-value',
          '--secret-id',
          source.secretId,
          '--query',
          'SecretString',
          '--output',
          'text',
          ...(source.region !== undefined ? ['--region', source.region] : []),
          ...(source.profile !== undefined ? ['--profile', source.profile] : []),
        ],
      };
    case 'gcp':
      return {
        tool,
        args: [
          'secrets',
          'versions',
          'access',
          source.version ?? 'latest',
          `--secret=${source.secret}`,
          ...(source.project !== undefined ? [`--project=${source.project}`] : []),
        ],
      };
    case 'azure':
      return {
        tool,
        args: ['keyvault', 'secret', 'show', '--vault-name', source.vault, '--name', source.name, '--query', 'value', '--output', 'tsv'],
      };
    case '1password':
      return { tool, args: ['read', source.ref] };
    case 'keychain':
      if (platform === 'win32') {
        throw secretSourceError(
          'secret-source-unsupported',
          '',
          'keychain',
          'The keychain source is not available on Windows yet; map this name to another kind on this machine.',
        );
      }
      return platform === 'darwin'
        ? { tool, args: ['find-generic-password', '-s', source.service, '-a', source.account, '-w'] }
        : { tool, args: ['lookup', 'service', source.service, 'account', source.account] };
  }
}

/** The value in a tool's stdout. @throws `secret-source-failed` when there is none; the message never quotes the output. */
export function parseSourceOutput(source: SecretSource, stdout: string): string {
  const value = stdout.endsWith('\r\n') ? stdout.slice(0, -2) : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (value.length === 0) {
    throw secretSourceError('secret-source-failed', '', source.kind, 'The command returned an empty value.');
  }
  if (source.kind !== 'aws' || source.jsonKey === undefined) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw secretSourceError('secret-source-failed', '', 'aws', `The secret is not JSON, so jsonKey "${source.jsonKey}" cannot be read.`);
  }
  const member =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, source.jsonKey)
      ? (parsed as Record<string, unknown>)[source.jsonKey]
      : undefined;
  if (typeof member !== 'string' || member.length === 0) {
    throw secretSourceError('secret-source-failed', '', 'aws', `The secret has no non-empty string member "${source.jsonKey}".`);
  }
  return member;
}
