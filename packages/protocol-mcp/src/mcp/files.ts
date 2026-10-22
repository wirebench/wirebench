/**
 * The MCP files of a project folder (#79): `apis/<slug>/api.yaml` with `kind: mcp`, each
 * `*.request.yaml` of its request tree, and the server's `catalogue.json`.
 */

import { z } from 'zod';
import { assertionsSchema } from '#core/assert/schema';
import { authConfigSchema, keyValueEntrySchema, nonEmpty, scriptsSchema } from '#core/project/schema-parts';
import type { McpCatalogue } from './model.js';

/** A local server: spawned with no shell, from `cwd` (relative to the project folder). */
const mcpStdioTransportSchema = z.looseObject({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.array(keyValueEntrySchema).default([]),
});

/** Streamable HTTP (`http`) or the legacy HTTP+SSE transport (`sse`, whose `url` is the stream). */
const mcpHttpTransportSchema = z.looseObject({
  type: z.enum(['http', 'sse']),
  url: z.string(),
  headers: z.array(keyValueEntrySchema).default([]),
  auth: authConfigSchema.optional(),
});

const mcpTransportSchema = z.discriminatedUnion('type', [mcpStdioTransportSchema, mcpHttpTransportSchema]);

/**
 * A request's one operation. A `tools/call`'s arguments live in the sibling file `arguments.file`
 * names, validated as a path segment before it is read (ADR-0005); prompt arguments are strings,
 * so they are a table.
 */
const mcpOperationSchema = z.discriminatedUnion('method', [
  z.looseObject({ method: z.enum(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']) }),
  z.looseObject({
    method: z.literal('tools/call'),
    tool: z.string(),
    arguments: z.looseObject({ file: nonEmpty }).optional(),
  }),
  z.looseObject({ method: z.literal('resources/read'), uri: z.string() }),
  z.looseObject({
    method: z.literal('prompts/get'),
    prompt: z.string(),
    arguments: z.array(keyValueEntrySchema).default([]),
  }),
]);

/** `apis/<slug>/requests/[<folder>/…]<name>.request.yaml` for an MCP request. */
export const mcpRequestFileSchema = z.looseObject({
  kind: z.literal('mcp'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  operation: mcpOperationSchema,
  settings: z.looseObject({ timeoutMs: z.number().int().positive().optional() }).default({}),
  assertions: assertionsSchema.default([]),
  scripts: scriptsSchema.optional(),
});

/** `apis/<slug>/api.yaml` for an MCP server. */
export const mcpServerFileSchema = z.looseObject({
  kind: z.literal('mcp'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  transport: mcpTransportSchema,
  settings: z
    .looseObject({
      timeoutMs: z.number().int().positive().optional(),
      protocolVersion: nonEmpty.optional(),
    })
    .default({}),
  /** Where `catalogue.json` came from, written by a refresh. */
  catalogue: z
    .looseObject({
      fetchedAt: z.string(),
      serverInfo: z.looseObject({ name: z.string(), version: z.string() }),
      protocolVersion: z.string(),
    })
    .optional(),
});

/** An MCP `api.yaml` as parsed. */
export type McpServerFile = z.infer<typeof mcpServerFileSchema>;
/** An MCP `*.request.yaml` as parsed. */
export type McpRequestFile = z.infer<typeof mcpRequestFileSchema>;

/** The catalogue's file name, beside `api.yaml`. */
export const MCP_CATALOGUE_FILE = 'catalogue.json';

const jsonObject = z.record(z.string(), z.unknown());

/** `apis/<slug>/catalogue.json`: the lists the server advertised, each entry as the server sent it. */
export const mcpCatalogueFileSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), inputSchema: jsonObject })).optional(),
  resources: z.array(z.looseObject({ uri: z.string(), name: z.string() })).optional(),
  resourceTemplates: z.array(z.looseObject({ uriTemplate: z.string(), name: z.string() })).optional(),
  prompts: z.array(z.looseObject({ name: z.string() })).optional(),
});

/** The keys an entry starts with, in this order; any other key follows, sorted. */
const ENTRY_KEY_ORDER = [
  'name',
  'title',
  'uri',
  'uriTemplate',
  'description',
  'mimeType',
  'size',
  'arguments',
  'inputSchema',
  'outputSchema',
  'annotations',
  'icons',
  '_meta',
];

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An entry with its own keys in a fixed order. What is inside each value is kept as it came. */
function orderedEntry(entry: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rank = (key: string): number => {
    const index = ENTRY_KEY_ORDER.indexOf(key);
    return index === -1 ? ENTRY_KEY_ORDER.length : index;
  };
  const keys = Object.keys(entry)
    .filter((key) => entry[key] !== undefined)
    .sort((a, b) => rank(a) - rank(b) || byCodeUnits(a, b));
  return Object.fromEntries(keys.map((key) => [key, entry[key]]));
}

/** A list sorted by `key`, ties broken by the whole entry, so the order never depends on the server's. */
function sortedList(
  list: readonly Readonly<Record<string, unknown>>[] | undefined,
  key: string,
): Record<string, unknown>[] | undefined {
  if (list === undefined) return undefined;
  return list
    .map((entry) => orderedEntry(entry))
    .map((entry) => ({ entry, text: JSON.stringify(entry) }))
    .sort((a, b) => byCodeUnits(String(a.entry[key]), String(b.entry[key])) || byCodeUnits(a.text, b.text))
    .map(({ entry }) => entry);
}

/**
 * `catalogue.json` as written: each list sorted by name (tools, prompts) or URI (resources and
 * templates), each entry's keys in a fixed order, pretty-printed, so a refresh that finds nothing
 * new saves the same bytes.
 */
export function serializeMcpCatalogue(catalogue: McpCatalogue): string {
  const document = {
    ...(catalogue.tools !== undefined ? { tools: sortedList(catalogue.tools, 'name') } : {}),
    ...(catalogue.resources !== undefined ? { resources: sortedList(catalogue.resources, 'uri') } : {}),
    ...(catalogue.resourceTemplates !== undefined
      ? { resourceTemplates: sortedList(catalogue.resourceTemplates, 'uriTemplate') }
      : {}),
    ...(catalogue.prompts !== undefined ? { prompts: sortedList(catalogue.prompts, 'name') } : {}),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Reads `catalogue.json`'s text, or `undefined` when it is not JSON or not a catalogue. Keys other
 * than the four lists are dropped.
 */
export function parseMcpCatalogue(text: string): McpCatalogue | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = mcpCatalogueFileSchema.safeParse(document);
  if (!parsed.success) return undefined;
  const { tools, resources, resourceTemplates, prompts } = parsed.data;
  return {
    ...(tools !== undefined ? { tools } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(resourceTemplates !== undefined ? { resourceTemplates } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
  };
}
