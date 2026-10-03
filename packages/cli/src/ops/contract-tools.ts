/**
 * A project's contract operations as MCP tools (#33 spec §2, §3, §8): which operations, their
 * names, descriptions and input schemas, the `--tools` filter, the cap, and the check a call's
 * arguments pass before anything is built.
 */
import {
  loadOpenApiDocument,
  operationJsonSchema,
  summarizeSoapOperations,
  validateJsonSchema,
} from '@wirebench/engine';
import type { JsonSchemaObject, JsonSchemaProblem, Project } from '@wirebench/engine';
import type { OpName } from '../args-ops.js';
import type { Gates } from './context.js';
import { OpsError, toOpsError } from './errors.js';
import { restRef, soapRef } from './operation-refs.js';
import type { ResolvedOperation } from './operation-refs.js';
import { clarkToQName, readWsdl } from './project.js';
import type { LoadedWsdl } from './project.js';
import { isRecord } from './records.js';
import { restToolSchema } from './rest-args.js';

/** The #32 tools, listed first and never renamed: a contract tool of one of these names is suffixed. */
export const FIXED_TOOL_NAMES: readonly OpName[] = [
  'import',
  'operations',
  'generate',
  'send',
  'validate',
  'query',
  'history_list',
  'history_diff',
];

export const CONTRACT_TOOL_CAP = 128;
export const MAX_TOOL_NAME = 64;
export const MAX_TOOL_DESCRIPTION = 1000;
/** A tool schema larger than this, in bytes of UTF-8 JSON, is served in full with a note on stderr. */
export const LARGE_SCHEMA_BYTES = 64 * 1024;

export const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** Lower-cased snake_case: camelCase split, every other run of characters one `_`, none at the ends. */
export function snakeName(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `<container>_<operation>`, at most 64 characters: the container part is cut first, then the end. */
export function toolBaseName(containerSlug: string, operationPart: string): string {
  const container = snakeName(containerSlug) || 'contract';
  const operation = snakeName(operationPart) || 'operation';
  const full = `${container}_${operation}`;
  if (full.length <= MAX_TOOL_NAME) {
    return full;
  }
  const room = MAX_TOOL_NAME - operation.length - 1;
  if (room >= 1) {
    const kept = container.slice(0, room).replace(/_+$/, '');
    return kept === '' ? operation : `${kept}_${operation}`;
  }
  return operation.slice(0, MAX_TOOL_NAME).replace(/_+$/, '');
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `_${String(n)}`;
    const candidate = `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Names bases one at a time, in order: each unique, none equal to a fixed tool's. */
function nameAssigner(): (base: string) => string {
  const taken = new Set<string>(FIXED_TOOL_NAMES);
  return (base) => {
    const name = uniqueName(base, taken);
    taken.add(name);
    return name;
  };
}

/** Unique names for `bases`, in order, none equal to a fixed tool's. */
export function assignNames(bases: readonly string[]): string[] {
  return bases.map(nameAssigner());
}

export interface ContractEntry {
  readonly name: string;
  readonly kind: 'soap' | 'rest';
  readonly ref: string;
  readonly container: { readonly name: string; readonly slug: string };
  /** Absent when the definition cannot be read: the operation has a name but no tool. */
  readonly resolved?: ResolvedOperation;
  /** SOAP: the binding's local name. */
  readonly binding?: string;
  /** SOAP: another binding of the interface has an operation of this name. */
  readonly shared: boolean;
}

/**
 * Every contract operation of the project in `operations` order, named over the whole project (so a
 * name does not depend on `--tools`). `include` limits which containers' definitions are read, and
 * whose problems are noted; an API's document is read either way, since its operations take names.
 */
export async function contractOperations(
  project: Project,
  projectDir: string,
  notes: string[],
  include: (container: { readonly name: string; readonly slug: string }) => boolean = () => true,
): Promise<ContractEntry[]> {
  const entries: ContractEntry[] = [];
  const nameOf = nameAssigner();
  for (const iface of [...project.interfaces].sort(byOrder)) {
    let wsdl: LoadedWsdl | undefined;
    if (include(iface)) {
      try {
        wsdl = await readWsdl(projectDir, iface);
      } catch (error) {
        notes.push(`${iface.name}: ${toOpsError(error).message}; it adds no tools`);
      }
    }
    for (const operation of [...iface.operations].sort(byOrder)) {
      const ref = soapRef(iface, operation);
      entries.push({
        name: nameOf(toolBaseName(iface.slug, operation.name)),
        kind: 'soap',
        ref,
        container: { name: iface.name, slug: iface.slug },
        binding: clarkToQName(operation.bindingName).localName,
        shared: iface.operations.filter((candidate) => candidate.name === operation.name).length > 1,
        ...(wsdl !== undefined ? { resolved: { kind: 'soap', ref, iface, operation, wsdl } } : {}),
      });
    }
  }
  for (const api of [...project.apis].sort(byOrder)) {
    let document: Awaited<ReturnType<typeof loadOpenApiDocument>>;
    try {
      document = await loadOpenApiDocument(projectDir, api.slug);
    } catch (error) {
      if (include(api)) notes.push(`${api.name}: ${toOpsError(error).message}; it adds no tools`);
      continue;
    }
    if (document === undefined) {
      if (include(api)) notes.push(`${api.name}: no readable cached OpenAPI document; it adds no tools`);
      continue;
    }
    for (const operation of document.operations) {
      const ref = restRef(api, operation);
      entries.push({
        name: nameOf(toolBaseName(api.slug, operation.operationId ?? `${operation.method}_${operation.path}`)),
        kind: 'rest',
        ref,
        container: { name: api.name, slug: api.slug },
        shared: false,
        ...(include(api) ? { resolved: { kind: 'rest', ref, api, operation, document } } : {}),
      });
    }
  }
  return entries;
}

/** The tool name of every operation that has a tool, keyed `soap:<ref>` or `rest:<ref>`. */
export async function toolNamesByRef(project: Project, projectDir: string): Promise<ReadonlyMap<string, string>> {
  const entries = await contractOperations(project, projectDir, []);
  return new Map(
    entries.flatMap((entry) =>
      entry.resolved !== undefined ? [[`${entry.kind}:${entry.ref}`, entry.name] as const] : [],
    ),
  );
}

export type EnvironmentKey = 'environment' | 'wirebench_environment';

export interface ToolSchema {
  readonly inputSchema: JsonSchemaObject;
  /** `environment`, unless the operation has an argument of that name. */
  readonly environmentKey: EnvironmentKey;
  readonly notes: readonly string[];
  readonly cookies: readonly string[];
}

const ENVIRONMENT_PROPERTY: JsonSchemaObject = {
  type: 'string',
  minLength: 1,
  description: 'The environment to send under, by name; required when the project defines any',
};

/** The tool's input schema: the operation's arguments, with the environment argument first. */
export function toolSchemaOf(resolved: ResolvedOperation): ToolSchema {
  const operationSchema =
    resolved.kind === 'soap'
      ? {
          ...operationJsonSchema(resolved.wsdl, {
            bindingName: clarkToQName(resolved.operation.bindingName),
            operationName: resolved.operation.name,
          }),
          cookies: [],
        }
      : { ...restToolSchema(resolved.api, resolved.operation), notes: [] };
  const { schema } = operationSchema;
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
  const environmentKey: EnvironmentKey = 'environment' in properties ? 'wirebench_environment' : 'environment';
  return {
    inputSchema: { ...schema, type: 'object', properties: { [environmentKey]: ENVIRONMENT_PROPERTY, ...properties } },
    environmentKey,
    notes: operationSchema.notes,
    cookies: operationSchema.cookies,
  };
}

function documentationOf(resolved: ResolvedOperation): string | undefined {
  if (resolved.kind === 'soap') {
    return summarizeSoapOperations(resolved.wsdl.definition).find(
      (summary) =>
        summary.operationName === resolved.operation.name &&
        `{${summary.bindingName.namespaceUri}}${summary.bindingName.localName}` === resolved.operation.bindingName,
    )?.documentation;
  }
  const parts = [resolved.operation.summary, resolved.operation.description].filter(
    (text): text is string => text !== undefined && text.trim() !== '',
  );
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** The contract's own text, cut at 1,000 characters, then what the tool does and which gate it needs. */
export function describeTool(
  entry: ContractEntry,
  resolved: ResolvedOperation,
  gates: Gates,
  cookies: readonly string[],
): string {
  const parts: string[] = [];
  const documentation = documentationOf(resolved)?.trim();
  if (documentation !== undefined && documentation !== '') {
    parts.push(documentation.slice(0, MAX_TOOL_DESCRIPTION));
  }
  if (entry.shared && entry.binding !== undefined) {
    parts.push(`Through the binding ${entry.binding}.`);
  }
  const where = `${resolved.kind === 'soap' ? 'the interface' : 'the API'} "${entry.container.name}"`;
  const environments =
    gates.environments !== undefined ? `, and one of the environments ${gates.environments.join(', ')}` : '';
  parts.push(
    `Sends a real ${resolved.kind === 'soap' ? 'SOAP' : 'REST'} request through ${where}, with its endpoint, ` +
      `auth and secrets, and records it in History. Needs --allow-send${environments}.`,
  );
  if (cookies.length > 0) {
    parts.push(`The operation needs the cookie parameter(s) ${cookies.join(', ')}, which this tool cannot set.`);
  }
  return parts.join('\n\n');
}

/** `schema` with every `#/$defs/…` reference replaced by its definition: a graph the validator walks (R1). */
export function dereferenced(schema: JsonSchemaObject): JsonSchemaObject {
  const defs = isRecord(schema['$defs']) ? schema['$defs'] : {};
  const resolved = new Map<string, Record<string, unknown>>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (!isRecord(node)) {
      return node;
    }
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const key = ref.slice('#/$defs/'.length);
      const known = resolved.get(key);
      if (known !== undefined) {
        return known;
      }
      const target: Record<string, unknown> = {};
      resolved.set(key, target);
      const definition = walk(defs[key] ?? {});
      Object.assign(target, isRecord(definition) ? definition : {});
      return target;
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== '$defs')
        .map(([key, value]) => [key, walk(value)]),
    );
  };
  return walk(schema) as JsonSchemaObject;
}

/** The JSON Pointer of the first string holding `${`, or undefined. */
function placeholderIn(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') {
    return value.includes('${') ? path || '/' : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = placeholderIn(item, `${path}/${String(index)}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = placeholderIn(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * What the validator says when it could not check something, rather than that a value is wrong: a
 * pattern it will not run (unsafe, or a value too long to test) and a spent node budget. None is a
 * refusal; the XSD check at call time still applies to a SOAP body.
 */
function isNotice(problem: JsonSchemaProblem): boolean {
  return problem.keyword === 'budget' || problem.message.startsWith('pattern not checked');
}

/**
 * Spec §3.3 steps 1 and 2: the arguments against the tool's own schema, then no `${` anywhere.
 *
 * @throws OpsError `invalid-input`, listing each JSON Pointer and keyword
 */
export function checkArgs(inputSchema: JsonSchemaObject, args: Readonly<Record<string, unknown>>): void {
  const problems = validateJsonSchema(args, dereferenced(inputSchema), { redactValues: true }).filter(
    (problem) => !isNotice(problem),
  );
  if (problems.length > 0) {
    throw new OpsError(
      'invalid-input',
      problems.map((problem) => `${problem.path || '/'} ${problem.keyword}: ${problem.message}`).join('; '),
      { problems: problems.map((problem) => ({ path: problem.path, keyword: problem.keyword })) },
    );
  }
  const placeholder = placeholderIn(args, '');
  if (placeholder !== undefined) {
    throw new OpsError(
      'invalid-input',
      `${placeholder}: arguments are sent as written and may not contain \${…} placeholders`,
      { path: placeholder },
    );
  }
}

export interface ContractTool {
  readonly name: string;
  readonly ref: string;
  readonly kind: 'soap' | 'rest';
  readonly container: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly environmentKey: EnvironmentKey;
}

export interface ContractToolSet {
  /** Empty when the count is over the cap. */
  readonly tools: readonly ContractTool[];
  /** Tools per container, counted before the cap; they add up to `total`. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  readonly overCap: boolean;
  /** For stderr: unreadable definitions, schema gaps, large schemas. */
  readonly notes: readonly string[];
}

export interface DeriveOptions {
  readonly projectDir: string;
  readonly gates: Gates;
  /** `--tools`: the containers to serve, by name or slug. Absent: all; empty: none. */
  readonly containers?: readonly string[];
  readonly cap?: number;
}

/**
 * The project's contract tools under `--tools`, with the cap verdict.
 *
 * @throws OpsError `container-not-found` for a `--tools` name no interface or API has
 */
export async function deriveContractTools(project: Project, options: DeriveOptions): Promise<ContractToolSet> {
  const wanted = options.containers;
  for (const name of wanted ?? []) {
    if (
      ![...project.interfaces, ...project.apis].some((container) => container.name === name || container.slug === name)
    ) {
      throw new OpsError(
        'container-not-found',
        `--tools names "${name}", which is no interface or API of this project`,
        {
          container: name,
        },
      );
    }
  }
  const include = (container: { readonly name: string; readonly slug: string }): boolean =>
    wanted === undefined || wanted.includes(container.name) || wanted.includes(container.slug);
  const notes: string[] = [];
  const entries = (await contractOperations(project, options.projectDir, notes, include)).filter((entry) =>
    include(entry.container),
  );
  const tools: ContractTool[] = [];
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const resolved = entry.resolved;
    if (resolved === undefined) {
      continue;
    }
    let schema: ToolSchema;
    try {
      schema = toolSchemaOf(resolved);
    } catch (error) {
      notes.push(`${entry.ref}: ${toOpsError(error).message}; no tool`);
      continue;
    }
    notes.push(...schema.notes.map((note) => `${entry.name}: ${note}`));
    const size = Buffer.byteLength(JSON.stringify(schema.inputSchema));
    if (size > LARGE_SCHEMA_BYTES) {
      notes.push(
        `${entry.name}: its input schema is ${String(Math.round(size / 1024))} KiB of JSON; it is served in full`,
      );
    }
    tools.push({
      name: entry.name,
      ref: entry.ref,
      kind: entry.kind,
      container: entry.container.name,
      description: describeTool(entry, resolved, options.gates, schema.cookies),
      inputSchema: schema.inputSchema,
      environmentKey: schema.environmentKey,
    });
    counts[entry.container.name] = (counts[entry.container.name] ?? 0) + 1;
  }
  const total = tools.length;
  const overCap = total > (options.cap ?? CONTRACT_TOOL_CAP);
  return { tools: overCap ? [] : tools, counts, total, overCap, notes };
}

/** Why the set is over `cap`: the count per container, and how to serve fewer. */
export function capMessage(set: ContractToolSet, cap: number = CONTRACT_TOOL_CAP): string {
  const counts = Object.entries(set.counts)
    .map(([container, count]) => `${container}: ${String(count)}`)
    .join(', ');
  return (
    `${String(set.total)} contract operations is over the cap of ${String(cap)} tools (${counts}); ` +
    'serve fewer with --tools <name,…>, or none with --tools none'
  );
}
