/**
 * Reads an Insomnia export, v4 (JSON or YAML, flat `resources` linked by `parentId`) or v5 (YAML,
 * nested), into one tree per workspace (spec 2026-10-15 §4.1). Browser-safe: it takes text.
 */

import { parse as parseYaml } from 'yaml';
import { InsomniaError } from '#core/errors';
import { ReportBuilder } from '#core/import/report';
import type {
  InsBody,
  InsDocument,
  InsEnv,
  InsFolder,
  InsNode,
  InsOtherSetting,
  InsProto,
  InsProtoDir,
  InsRec,
  InsRow,
  InsScripts,
  InsSettings,
  InsTestSuite,
  InsWorkspace,
} from './model.js';
import { MAX_INSOMNIA_BYTES } from './model.js';

/** Deeper nesting than any real collection; stops a hostile document from exhausting the stack. */
const MAX_DEPTH = 64;
/** Most items and folders one export may hold; bounds wide trees and shared YAML aliases. */
const MAX_NODES = 100_000;
const VAULT_KEY = '__insomnia_vault';
const V5_SUFFIXES = ['.insomnia.rest/5.0', '.insomnia/5.0'];
/** The workspace that resources with no workspace above them share. */
const SHARED = '';

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rec(value: unknown): Rec {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sortKey(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Insomnia's sibling order: sort key ascending, ties by id descending. */
function insomniaOrder<T>(items: readonly T[], key: (item: T) => number, id: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const byKey = key(a) - key(b);
    if (byKey !== 0) return byKey;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  });
}

/** Rows with no name are blank editor rows (schema 5.0 still exported them) and are dropped. */
function rows(value: unknown): InsRow[] {
  return records(value).flatMap((row): InsRow[] => {
    const name = text(row['name']);
    if (name === '') return [];
    const description = nonEmpty(row['description']);
    const type = nonEmpty(row['type']);
    const fileName = nonEmpty(row['fileName']);
    const multiline = row['multiline'];
    return [
      {
        name,
        value: text(row['value']),
        disabled: row['disabled'] === true,
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(fileName !== undefined ? { fileName } : {}),
        ...(typeof multiline === 'string' || typeof multiline === 'boolean' ? { multiline } : {}),
      },
    ];
  });
}

/** An auth that counts: it has a `type` and is not disabled. Anything else inherits. */
function auth(value: unknown): InsRec | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string' || value['disabled'] === true) return undefined;
  return value;
}

function body(value: unknown): InsBody {
  const raw = rec(value);
  const mimeType = nonEmpty(raw['mimeType']);
  const bodyText = typeof raw['text'] === 'string' ? raw['text'] : undefined;
  const fileName = nonEmpty(raw['fileName']);
  return {
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(bodyText !== undefined ? { text: bodyText } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(Array.isArray(raw['params']) ? { params: rows(raw['params']) } : {}),
  };
}

function settings(flags: {
  readonly followRedirects: unknown;
  readonly encodeUrl: unknown;
  readonly sendCookies: unknown;
  readonly storeCookies: unknown;
  readonly render: unknown;
  readonly rebuildPath: unknown;
}): InsSettings {
  const other: InsOtherSetting[] = [];
  if (flags.sendCookies === false) other.push('send-cookies-off');
  if (flags.storeCookies === false) other.push('store-cookies-off');
  if (flags.render === false) other.push('render-off');
  if (flags.rebuildPath === false) other.push('rebuild-path-off');
  const redirects = flags.followRedirects;
  return {
    followRedirects: redirects === 'on' || redirects === 'off' ? redirects : 'global',
    encodeUrl: flags.encodeUrl !== false,
    other,
  };
}

function scripts(pre: unknown, post: unknown): InsScripts {
  return { pre: text(pre), post: text(post) };
}

function described<T extends object>(node: T, description: unknown): T {
  const d = nonEmpty(description);
  return d !== undefined ? { ...node, description: d } : node;
}

/**
 * An environment's variables with the vault taken out. Its names come from `__insomnia_vault` and,
 * in v4, from `kvPairData` rows typed `secret`; their values are sealed or masked.
 */
function environment(raw: Rec, isPrivate: unknown, fallbackName: string): InsEnv {
  const { [VAULT_KEY]: sealed, ...data } = rec(raw['data']);
  const vault = new Set(Object.keys(rec(sealed)));
  for (const pair of records(raw['kvPairData'])) {
    const name = nonEmpty(pair['name']);
    if (pair['type'] === 'secret' && name !== undefined && pair['enabled'] !== false) vault.add(name);
  }
  const order = raw['dataPropertyOrder'];
  const color = nonEmpty(raw['color']);
  return {
    name: nonEmpty(raw['name']) ?? fallbackName,
    data,
    ...(isRecord(order) ? { order } : {}),
    ...(color !== undefined ? { color } : {}),
    private: isPrivate === true,
    vault: [...vault],
  };
}

function testSuite(name: unknown, tests: readonly Rec[]): InsTestSuite {
  return {
    name: text(name),
    tests: tests.map((test) => {
      const requestId = nonEmpty(test['requestId']);
      return { name: text(test['name']), ...(requestId !== undefined ? { requestId } : {}) };
    }),
  };
}

function grpcNode(id: string, name: string, raw: Rec): InsNode {
  const protoFileId = nonEmpty(raw['protoFileId']);
  return {
    kind: 'grpc',
    id,
    name,
    url: text(raw['url']),
    ...(protoFileId !== undefined ? { protoFileId } : {}),
    protoMethodName: text(raw['protoMethodName']),
    message: text(rec(raw['body'])['text']),
    metadata: rows(raw['metadata']),
    reflection: rec(raw['reflectionApi'])['enabled'] === true,
  };
}

/** The item count both walkers share, so neither a wide tree nor aliased lists can run unbounded. */
interface Budget {
  nodes: number;
}

/** Counts one visited item against the shared budget. */
function spend(budget: Budget): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    throw insomniaError('insomnia-malformed', `The Insomnia export holds more than ${MAX_NODES} items.`);
  }
}

function tooDeep(report: ReportBuilder, name: string): InsNode[] {
  report.warn(`The folder "${name}" is nested more than ${MAX_DEPTH} deep; what is below it was not imported.`);
  return [];
}

function insomniaError(code: string, message: string, cause?: unknown): InsomniaError {
  return new InsomniaError(code, message, cause !== undefined ? { cause } : undefined);
}

// --- v4 -------------------------------------------------------------------------------------

interface V4Context {
  /** Resources by parent id; a top-level resource with no workspace above it is under {@link SHARED}. */
  readonly byParent: ReadonlyMap<string, Rec[]>;
  /** The workspace each resource belongs to. */
  readonly owner: ReadonlyMap<Rec, string>;
  readonly report: ReportBuilder;
  readonly budget: Budget;
}

function v4Id(resource: Rec): string {
  return text(resource['_id']);
}

function v4Children(context: V4Context, parentId: string): Rec[] {
  return insomniaOrder(context.byParent.get(parentId) ?? [], (r) => sortKey(r['metaSortKey']), v4Id);
}

const V4_SKIPPED: Readonly<Record<string, string>> = {
  socketio_request: 'Socket.IO request',
  mcp_request: 'MCP request',
};

function v4Node(context: V4Context, resource: Rec, depth: number): InsNode | undefined {
  const id = v4Id(resource);
  const name = text(resource['name']);
  switch (resource['_type']) {
    case 'request_group': {
      const folderAuth = auth(resource['authentication']);
      const folder: InsFolder = {
        kind: 'folder',
        id,
        name,
        children: v4FolderChildren(context, id, name, depth),
        headers: rows(resource['headers']),
        ...(folderAuth !== undefined ? { auth: folderAuth } : {}),
        ...(isRecord(resource['environment']) ? { environment: resource['environment'] } : {}),
        ...(isRecord(resource['environmentPropertyOrder'])
          ? { environmentOrder: resource['environmentPropertyOrder'] }
          : {}),
        scripts: scripts(resource['preRequestScript'], resource['afterResponseScript']),
      };
      return described(folder, resource['description']);
    }
    case 'request': {
      const requestAuth = auth(resource['authentication']);
      return described(
        {
          kind: 'http' as const,
          id,
          name,
          method: nonEmpty(resource['method']) ?? 'GET',
          url: text(resource['url']),
          parameters: rows(resource['parameters']),
          pathParameters: rows(resource['pathParameters']),
          headers: rows(resource['headers']),
          body: body(resource['body']),
          ...(requestAuth !== undefined ? { auth: requestAuth } : {}),
          settings: settings({
            followRedirects: resource['settingFollowRedirects'],
            encodeUrl: resource['settingEncodeUrl'],
            sendCookies: resource['settingSendCookies'],
            storeCookies: resource['settingStoreCookies'],
            render: resource['settingDisableRenderRequestBody'] === true ? false : undefined,
            rebuildPath: resource['settingRebuildPath'],
          }),
          scripts: scripts(resource['preRequestScript'], resource['afterResponseScript']),
        },
        resource['description'],
      );
    }
    case 'grpc_request':
      return described(grpcNode(id, name, resource), resource['description']);
    case 'websocket_request': {
      const wsAuth = auth(resource['authentication']);
      const payload = v4Children(context, id).find((child) => child['_type'] === 'websocket_payload');
      const mode = payload !== undefined ? nonEmpty(payload['mode']) : undefined;
      return described(
        {
          kind: 'websocket' as const,
          id,
          name,
          url: text(resource['url']),
          headers: rows(resource['headers']),
          parameters: rows(resource['parameters']),
          ...(wsAuth !== undefined ? { auth: wsAuth } : {}),
          ...(payload !== undefined
            ? { payload: { text: text(payload['value']), ...(mode !== undefined ? { mode } : {}) } }
            : {}),
        },
        resource['description'],
      );
    }
    default: {
      const what = V4_SKIPPED[text(resource['_type'])];
      return what !== undefined ? { kind: 'skipped', id, name, what } : undefined;
    }
  }
}

/** A folder with no id cannot be told apart from the resources with no parent, so it stays empty. */
function v4FolderChildren(context: V4Context, id: string, name: string, depth: number): InsNode[] {
  if (id === '') {
    context.report.warn(`The folder "${name}" has no id; its contents were skipped.`);
    return [];
  }
  return depth >= MAX_DEPTH ? tooDeep(context.report, name) : v4Nodes(context, id, depth + 1);
}

function v4Nodes(context: V4Context, parentId: string, depth: number): InsNode[] {
  return v4Children(context, parentId).flatMap((child) => {
    spend(context.budget);
    const node = v4Node(context, child, depth);
    return node !== undefined ? [node] : [];
  });
}

/** Resource kinds the converter reads or reports itself; any other kind is named as an extra. */
const V4_KNOWN = new Set([
  'workspace',
  'request_group',
  'request',
  'grpc_request',
  'websocket_request',
  'websocket_payload',
  'socketio_request',
  'socketio_payload',
  'mcp_request',
  'environment',
  'cookie_jar',
  'proto_file',
  'proto_directory',
  'unit_test_suite',
  'unit_test',
  'api_spec',
]);

/** v4 workspace scopes that hold no requests to import. */
const NOT_COLLECTION_SCOPES: Readonly<Record<string, string>> = {
  'mock-server': 'a mock server',
  mcp: 'an MCP client',
};

const V4_EXTRA_NAMES: Readonly<Record<string, string>> = { mock: 'mock server', mock_route: 'mock server' };

function v4Workspace(context: V4Context, workspace: Rec, resources: readonly Rec[]): InsWorkspace {
  const id = v4Id(workspace);
  const mine = resources.filter((r) => context.owner.get(r) === id);
  const ofType = (type: string): Rec[] =>
    insomniaOrder(
      mine.filter((r) => r['_type'] === type),
      (r) => sortKey(r['metaSortKey']),
      v4Id,
    );

  const envs = ofType('environment');
  const base = envs.find((env) => text(env['parentId']) === id) ?? (id === SHARED ? envs[0] : undefined);
  const baseId = base !== undefined ? v4Id(base) : undefined;
  const subs = envs.filter((env) => {
    const parent = text(env['parentId']);
    return env !== base && (parent === baseId || parent.startsWith('__BASE_ENVIRONMENT_ID__'));
  });

  const dirOf = (r: Rec): string | undefined => {
    const parent = text(r['parentId']);
    return parent !== id && parent !== '' ? parent : undefined;
  };
  const protos: InsProto[] = ofType('proto_file').map((file) => {
    const dirId = dirOf(file);
    return { id: v4Id(file), name: text(file['name']), text: text(file['protoText']), ...(dirId ? { dirId } : {}) };
  });
  const protoDirs: InsProtoDir[] = ofType('proto_directory').map((dir) => {
    const parentId = dirOf(dir);
    return { id: v4Id(dir), name: text(dir['name']), ...(parentId ? { parentId } : {}) };
  });
  const testSuites = ofType('unit_test_suite').map((suite) =>
    testSuite(
      suite['name'],
      v4Children(context, v4Id(suite)).filter((t) => t['_type'] === 'unit_test'),
    ),
  );
  const extras = new Set<string>();
  for (const resource of mine) {
    const type = text(resource['_type']);
    if (!V4_KNOWN.has(type)) extras.add(V4_EXTRA_NAMES[type] ?? type);
  }
  const scope = nonEmpty(workspace['scope']);
  return described(
    {
      id,
      name: nonEmpty(workspace['name']) ?? 'Imported workspace',
      ...(scope !== undefined ? { scope } : {}),
      items: v4Nodes(context, id, 0),
      ...(base !== undefined ? { baseEnv: environment(base, base['isPrivate'], 'Base Environment') } : {}),
      subEnvs: subs.map((env) => environment(env, env['isPrivate'], 'Environment')),
      protos,
      protoDirs,
      testSuites,
      cookies: ofType('cookie_jar').reduce((n, jar) => n + records(jar['cookies']).length, 0),
      spec: ofType('api_spec').some((spec) => nonEmpty(spec['contents']) !== undefined),
      extras: [...extras],
    },
    workspace['description'],
  );
}

function parseV4(root: Rec): InsDocument {
  const report = new ReportBuilder();
  const resources = records(root['resources']).filter((r) => typeof r['_type'] === 'string');
  const byId = new Map<string, Rec>();
  // A resource with no id is nobody's parent: keyed under '', it would collide with the parentless ones.
  for (const resource of resources) if (v4Id(resource) !== '') byId.set(v4Id(resource), resource);
  const workspaces = resources.filter((r) => r['_type'] === 'workspace' && v4Id(r) !== SHARED);
  const workspaceIds = new Set(workspaces.map(v4Id));
  const first = workspaces.find((w) => NOT_COLLECTION_SCOPES[text(w['scope'])] === undefined);

  // Each resource's workspace, found by walking its parents; with none above it, the shared one.
  const owner = new Map<Rec, string>();
  for (const resource of resources) {
    if (resource['_type'] === 'workspace') continue;
    // Old exports parent sub-environments to a placeholder base; they belong to the first workspace.
    if (
      first !== undefined &&
      resource['_type'] === 'environment' &&
      text(resource['parentId']).startsWith('__BASE_ENVIRONMENT_ID__')
    ) {
      owner.set(resource, v4Id(first));
      continue;
    }
    let current: Rec | undefined = resource;
    const seen = new Set<Rec>();
    let found = SHARED;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (workspaceIds.has(v4Id(current))) {
        found = v4Id(current);
        break;
      }
      const parentId = text(current['parentId']);
      if (workspaceIds.has(parentId)) {
        found = parentId;
        break;
      }
      current = byId.get(parentId);
    }
    owner.set(resource, found);
  }

  const byParent = new Map<string, Rec[]>();
  for (const resource of resources) {
    if (resource['_type'] === 'workspace') continue;
    const parentId = text(resource['parentId']);
    // A parent that is neither a workspace nor any resource: the resource is top-level in its workspace.
    const key = workspaceIds.has(parentId) || byId.has(parentId) ? parentId : (owner.get(resource) ?? SHARED);
    const list = byParent.get(key) ?? [];
    list.push(resource);
    byParent.set(key, list);
  }

  const context: V4Context = { byParent, owner, report, budget: { nodes: 0 } };
  const skipped: string[] = [];
  const roots: Rec[] = workspaces.filter((workspace) => {
    const what = NOT_COLLECTION_SCOPES[text(workspace['scope'])];
    if (what === undefined) return true;
    skipped.push(what);
    report.warn(`"${nonEmpty(workspace['name']) ?? 'Imported workspace'}" is ${what} and was skipped.`);
    return false;
  });
  if ([...owner.values()].includes(SHARED)) roots.push({ _id: SHARED, _type: 'workspace' });
  if (roots.length === 0 && skipped.length > 0) {
    throw insomniaError(
      'insomnia-not-collection',
      `This Insomnia file holds only ${skipped[0]}, not a collection or environments, so it has nothing to import.`,
    );
  }
  const parsed = roots.map((workspace) => v4Workspace(context, workspace, resources));
  const kind = parsed.length > 0 && parsed.every((w) => w.scope === 'environment') ? 'environment' : 'collection';
  return { format: 4, kind, workspaces: parsed, report: report.build() };
}

// --- v5 -------------------------------------------------------------------------------------

function v5Meta(item: Rec): Rec {
  return rec(item['meta']);
}

function v5Id(item: Rec): string {
  return text(v5Meta(item)['id']);
}

function v5Settings(raw: unknown): InsSettings {
  const s = rec(raw);
  const cookies = rec(s['cookies']);
  return settings({
    followRedirects: s['followRedirects'],
    encodeUrl: s['encodeUrl'],
    sendCookies: cookies['send'],
    storeCookies: cookies['store'],
    render: s['renderRequestBody'],
    rebuildPath: s['rebuildPath'],
  });
}

function v5Scripts(raw: unknown): InsScripts {
  const s = rec(raw);
  return scripts(s['preRequest'], s['afterResponse']);
}

/** v5 tells items apart as Insomnia does: `method` is HTTP, `reflectionApi` gRPC, no `url` a folder. */
interface V5Context {
  readonly report: ReportBuilder;
  readonly budget: Budget;
  /** Lists and items already walked: YAML aliases can make the tree reuse one, even in a loop. */
  readonly visited: WeakSet<object>;
}

function v5Node(context: V5Context, item: Rec, depth: number): InsNode {
  const { report } = context;
  const id = v5Id(item);
  const name = text(item['name']);
  const description = v5Meta(item)['description'];
  if (item['method'] !== undefined) {
    const requestAuth = auth(item['authentication']);
    return described(
      {
        kind: 'http' as const,
        id,
        name,
        method: nonEmpty(item['method']) ?? 'GET',
        url: text(item['url']),
        parameters: rows(item['parameters']),
        pathParameters: rows(item['pathParameters']),
        headers: rows(item['headers']),
        body: body(item['body']),
        ...(requestAuth !== undefined ? { auth: requestAuth } : {}),
        settings: v5Settings(item['settings']),
        scripts: v5Scripts(item['scripts']),
      },
      description,
    );
  }
  if (item['reflectionApi'] !== undefined) return described(grpcNode(id, name, item), description);
  if (item['url'] === undefined) {
    const folderAuth = auth(item['authentication']);
    const folder: InsFolder = {
      kind: 'folder',
      id,
      name,
      children: depth >= MAX_DEPTH ? tooDeep(report, name) : v5Nodes(context, item['children'], depth + 1),
      headers: rows(item['headers']),
      ...(folderAuth !== undefined ? { auth: folderAuth } : {}),
      ...(isRecord(item['environment']) ? { environment: item['environment'] } : {}),
      ...(isRecord(item['environmentPropertyOrder']) ? { environmentOrder: item['environmentPropertyOrder'] } : {}),
      scripts: v5Scripts(item['scripts']),
    };
    return described(folder, description);
  }
  if (
    id.startsWith('socketio-req') ||
    item['eventListeners'] !== undefined ||
    rec(item['settings'])['path'] !== undefined
  ) {
    return { kind: 'skipped', id, name, what: 'Socket.IO request' };
  }
  if (id.startsWith('mcp-req')) return { kind: 'skipped', id, name, what: 'MCP request' };
  const wsAuth = auth(item['authentication']);
  return described(
    {
      kind: 'websocket' as const,
      id,
      name,
      url: text(item['url']),
      headers: rows(item['headers']),
      parameters: rows(item['parameters']),
      ...(wsAuth !== undefined ? { auth: wsAuth } : {}),
    },
    description,
  );
}

function v5Nodes(context: V5Context, value: unknown, depth: number): InsNode[] {
  if (Array.isArray(value)) {
    if (context.visited.has(value)) {
      throw insomniaError('insomnia-malformed', 'The Insomnia export reuses a list of items (a YAML alias loop).');
    }
    context.visited.add(value);
  }
  const listed = records(value);
  for (const item of listed) {
    if (context.visited.has(item)) {
      throw insomniaError('insomnia-malformed', 'The Insomnia export reuses an item (a YAML alias loop).');
    }
    context.visited.add(item);
    spend(context.budget);
  }
  const items = insomniaOrder(listed, (item) => sortKey(v5Meta(item)['sortKey']), v5Id);
  return items.map((item) => v5Node(context, item, depth));
}

function parseV5(root: Rec, kind: string): InsDocument {
  const report = new ReportBuilder();
  const envs = root['environments'];
  const subs = isRecord(envs)
    ? insomniaOrder(records(envs['subEnvironments']), (env) => sortKey(v5Meta(env)['sortKey']), v5Id)
    : [];
  const spec = rec(root['spec']);
  const workspace: InsWorkspace = described(
    {
      id: v5Id(root),
      name: nonEmpty(root['name']) ?? 'Imported workspace',
      items: v5Nodes({ report, budget: { nodes: 0 }, visited: new WeakSet() }, root['collection'], 0),
      ...(isRecord(envs) ? { baseEnv: environment(envs, v5Meta(envs)['isPrivate'], 'Base Environment') } : {}),
      subEnvs: subs.map((env) => environment(env, v5Meta(env)['isPrivate'], 'Environment')),
      protos: [],
      protoDirs: [],
      testSuites: records(root['testSuites']).map((suite) => testSuite(suite['name'], records(suite['tests']))),
      cookies: records(rec(root['cookieJar'])['cookies']).length,
      spec: Object.keys(rec(spec['contents'])).length > 0 || nonEmpty(spec['file']) !== undefined,
      extras: [],
    },
    v5Meta(root)['description'],
  );
  return {
    format: 5,
    kind: kind === 'environment' ? 'environment' : 'collection',
    workspaces: [workspace],
    report: report.build(),
  };
}

// --- entry ----------------------------------------------------------------------------------

/** The v5 kind a `type` names (`collection`, `spec`, `environment`, `mock`, `mcpClient`), if any. */
function v5Kind(type: unknown): string | undefined {
  if (typeof type !== 'string') return undefined;
  const suffix = V5_SUFFIXES.find((s) => type.endsWith(s));
  return suffix !== undefined ? type.slice(0, type.length - suffix.length) : undefined;
}

const NOT_COLLECTION: Readonly<Record<string, string>> = { mock: 'a mock server', mcpClient: 'an MCP client' };

/**
 * Reads an Insomnia v4 or v5 export. v5 is told by its `type` value, wherever it sits in the file.
 *
 * @throws InsomniaError `insomnia-too-large` past 50 MB, `insomnia-malformed` when the text is not
 *   JSON or YAML, is not an Insomnia export, reuses a list or item (a YAML alias loop) or holds more
 *   than 100000 items, `insomnia-old-format` for `__export_format` 1 to 3, and
 *   `insomnia-not-collection` for a mock server or MCP client file (or a v4 file holding only those).
 */
export function parseInsomnia(source: string): InsDocument {
  if (source.length > MAX_INSOMNIA_BYTES) {
    throw insomniaError(
      'insomnia-too-large',
      `The Insomnia export is larger than ${MAX_INSOMNIA_BYTES / (1024 * 1024)} MB`,
    );
  }
  let root: unknown;
  try {
    // JSON goes through the JSON parser, which is far faster than the YAML one on a large export.
    root = JSON.parse(source);
  } catch {
    try {
      root = parseYaml(source);
    } catch (cause) {
      throw insomniaError('insomnia-malformed', 'The Insomnia export is not valid JSON or YAML.', cause);
    }
  }
  if (!isRecord(root)) throw insomniaError('insomnia-malformed', 'This is not an Insomnia export.');
  const exportFormat = root['__export_format'];
  if (exportFormat === 4) return parseV4(root);
  if (exportFormat === 1 || exportFormat === 2 || exportFormat === 3) {
    throw insomniaError(
      'insomnia-old-format',
      `This Insomnia export is in format ${exportFormat}, which is no longer read. Export it again from a current Insomnia.`,
    );
  }
  const kind = v5Kind(root['type']);
  if (kind === undefined) throw insomniaError('insomnia-malformed', 'This is not an Insomnia export.');
  if (kind !== 'collection' && kind !== 'spec' && kind !== 'environment') {
    throw insomniaError(
      'insomnia-not-collection',
      `This Insomnia file is ${NOT_COLLECTION[kind] ?? `a "${kind}" file`}, not a collection or environments, so it has nothing to import.`,
    );
  }
  return parseV5(root, kind);
}
