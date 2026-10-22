/**
 * Property expansion for an MCP send (#79): every `${…}` reference in the server's transport and in
 * the request's operation, resolved against the scopes every other send uses.
 *
 * The rules are the other protocols' ones: names as well as values are expanded, and a reference
 * nothing resolves is reported once per place it appears, never guessed at. Two places differ:
 *
 * - **A `tools/call`'s arguments are JSON**, so every value substituted into them is JSON-escaped,
 *   as a raw JSON body's is when it asks: a value with a quote stays one string. A Sequence value is
 *   escaped exactly once, as everywhere (ADR-0015).
 * - **A stdio command line never reads a Sequence value.** Text a server chose may not pick what runs
 *   on this machine, so `${#Sequence#…}` in the command, an argument, the folder or a variable is
 *   expanded without the Sequence scope and so is reported as unresolved. For HTTP, a Sequence value
 *   may not pick the origin, nor carry a line break into the URL or a header.
 */
import { escapeForLanguage } from '#core/http/escape';
import type { KeyValueEntry } from '#core/http/entries';
import { expand } from '#core/project/properties';
import type { PropertyScopes, UnresolvedRef } from '#core/project/properties';
import {
  assertNoControlCharacters,
  assertOriginIndependent,
  expandWithSequenceEscaped,
} from '#core/project/sequence-guards';
import type { McpOperation, McpTransport } from './model.js';

/** What an expansion gives: the same shape, expanded, and the references nothing resolved. */
export interface McpExpanded<T> {
  readonly value: T;
  readonly unresolved: readonly UnresolvedRef[];
}

function withoutSequence(scopes: PropertyScopes): PropertyScopes {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { sequence: _sequence, ...rest } = scopes;
  return rest;
}

/**
 * The transport with every string expanded: the command, each argument, the folder and each
 * variable for stdio; the URL and each header for HTTP. Auth is resolved by the run facet, not here.
 *
 * @throws SequenceError `sequence-origin-from-response` | `sequence-value-invalid` for an HTTP URL or
 * header a Sequence value would steer
 */
export function expandMcpTransport(transport: McpTransport, scopes: PropertyScopes): McpExpanded<McpTransport> {
  const unresolved: UnresolvedRef[] = [];
  if (transport.type === 'stdio') {
    const local = withoutSequence(scopes);
    const run = (text: string): string => {
      const result = expand(text, local);
      unresolved.push(...result.unresolved);
      return result.text;
    };
    return {
      value: {
        ...transport,
        command: run(transport.command),
        args: transport.args.map(run),
        ...(transport.cwd !== undefined ? { cwd: run(transport.cwd) } : {}),
        env: transport.env.map((row) => ({ ...row, name: run(row.name), value: run(row.value) })),
      },
      unresolved,
    };
  }
  const run = (text: string, place: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    assertNoControlCharacters(place, result, scopes);
    return result.text;
  };
  assertOriginIndependent('The MCP server URL', (s) => expand(transport.url, s).text, scopes);
  return {
    value: {
      ...transport,
      url: run(transport.url, 'The MCP server URL'),
      headers: transport.headers.map((row) => ({
        ...row,
        name: run(row.name, 'A header name'),
        value: run(row.value, `The header ${row.name}`),
      })),
    },
    unresolved,
  };
}

/**
 * The operation with every string expanded: the tool, URI or prompt, each prompt argument, and a
 * call's arguments JSON-escaped.
 */
export function expandMcpOperation(operation: McpOperation, scopes: PropertyScopes): McpExpanded<McpOperation> {
  const unresolved: UnresolvedRef[] = [];
  const run = (text: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return result.text;
  };
  const runJson = (text: string): string => {
    unresolved.push(...expand(text, scopes).unresolved);
    return expandWithSequenceEscaped(
      (s) => expand(text, escapedScopes(s)).text,
      scopes,
      (value) => escapeForLanguage(value, 'json'),
    );
  };
  const rows = (entries: readonly KeyValueEntry[]): KeyValueEntry[] =>
    entries.map((row) => ({ ...row, name: run(row.name), value: run(row.value) }));
  switch (operation.method) {
    case 'tools/call':
      return {
        value: { ...operation, tool: run(operation.tool), arguments: runJson(operation.arguments) },
        unresolved,
      };
    case 'resources/read':
      return { value: { ...operation, uri: run(operation.uri) }, unresolved };
    case 'prompts/get':
      return {
        value: { ...operation, prompt: run(operation.prompt), arguments: rows(operation.arguments) },
        unresolved,
      };
    default:
      return { value: operation, unresolved };
  }
}

/** The same scopes with every value JSON-escaped, so substitution escapes as it goes. */
function escapedScopes(scopes: PropertyScopes): PropertyScopes {
  const escapeMap = (map: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(map ?? {})) {
      if (value !== undefined) out[name] = escapeForLanguage(value, 'json');
    }
    return out;
  };
  return {
    ...scopes,
    project: escapeMap(scopes.project),
    global: escapeMap(scopes.global),
    system: escapeMap(scopes.system),
    ...(scopes.env !== undefined ? { env: escapeMap(scopes.env) } : {}),
    ...(scopes.workspace !== undefined ? { workspace: escapeMap(scopes.workspace) } : {}),
  };
}
