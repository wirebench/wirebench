/**
 * Reads Insomnia v4 (JSON or YAML) and v5 (YAML) exports into typed shapes. Browser-safe: it takes
 * text, never a path. Templates stay raw; the mapper converts them.
 */

import { parse as parseYaml } from 'yaml';
import { InsomniaError } from '../../errors.js';
import { ReportBuilder } from '../report.js';
import { MAX_INSOMNIA_BYTES } from './model.js';
import type { InsDocument, InsEnv, InsNode, InsRow, InsScripts, InsSettings, InsWorkspace, Rec } from './model.js';

/** Deeper nesting than any real collection; stops a hostile export from exhausting the stack. */
const MAX_DEPTH = 64;
const MAX_ALIAS_COUNT = 100;
/** Most items and folders one export may hold; bounds wide trees and shared YAML aliases. */
const MAX_NODES = 100_000;
const V5_TYPE = /\.insomnia(\.rest)?\/5\.\d+$/;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A string for text, number or boolean; anything else is empty. */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function malformed(message: string, cause?: unknown): InsomniaError {
  return new InsomniaError('insomnia-malformed', message, cause === undefined ? undefined : { cause });
}

/** Whether `text` is past the cap in UTF-8 bytes; most texts are settled by length alone. */
function pastCap(text: string): boolean {
  if (text.length > MAX_INSOMNIA_BYTES) return true;
  if (text.length * 3 <= MAX_INSOMNIA_BYTES) return false;
  return new TextEncoder().encode(text).length > MAX_INSOMNIA_BYTES;
}

function rowsOf(value: unknown, dropUnnamed: boolean): InsRow[] {
  if (!Array.isArray(value)) return [];
  const out: InsRow[] = [];
  for (const entry of value) {
    if (!isRec(entry)) continue;
    const name = scalar(entry['name']);
    if (dropUnnamed && name === '') continue;
    const description = nonEmpty(entry['description']);
    const type = nonEmpty(entry['type']);
    const fileName = nonEmpty(entry['fileName']);
    const multiline = entry['multiline'];
    out.push({
      name,
      value: scalar(entry['value']),
      disabled: entry['disabled'] === true,
      ...(description !== undefined ? { description } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(fileName !== undefined ? { fileName } : {}),
      ...(typeof multiline === 'string' || typeof multiline === 'boolean' ? { multiline } : {}),
    });
  }
  return out;
}

function bodyOf(value: unknown, dropUnnamed: boolean): Rec {
  if (!isRec(value)) return {};
  const body: Rec = { ...value };
  if (dropUnnamed && Array.isArray(body['params'])) {
    body['params'] = body['params'].filter((p) => isRec(p) && nonEmpty(p['name']) !== undefined);
  }
  return body;
}

function envOf(value: unknown, fallbackName: string, privateFlag: unknown): InsEnv {
  const raw = isRec(value) ? value : {};
  const order = raw['dataPropertyOrder'];
  const color = nonEmpty(raw['color']);
  return {
    name: nonEmpty(raw['name']) ?? fallbackName,
    data: isRec(raw['data']) ? raw['data'] : {},
    ...(isRec(order) ? { order } : {}),
    ...(color !== undefined ? { color } : {}),
    private: privateFlag === true,
  };
}

function redirects(value: unknown): InsSettings['followRedirects'] {
  return value === 'on' || value === 'off' ? value : 'global';
}

function authOf(value: unknown): Rec | undefined {
  return isRec(value) ? value : undefined;
}

function nonEmptyRec(value: unknown): Rec | undefined {
  return isRec(value) && Object.keys(value).length > 0 ? value : undefined;
}

/** Sort key ascending, ties by id descending, as Insomnia sorts; folders and requests together. */
function sortSiblings(entries: { key: number; id: string; node: InsNode }[]): InsNode[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.key !== b.entry.key) return a.entry.key - b.entry.key;
      if (a.entry.id !== b.entry.id) return a.entry.id < b.entry.id ? 1 : -1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry.node);
}

function addExtra(extras: string[], label: string): void {
  if (!extras.includes(label)) extras.push(label);
}

interface Context {
  report: ReportBuilder;
  nodes: number;
}

/** Counts one visited item against the shared budget. */
function spend(ctx: Context): void {
  ctx.nodes += 1;
  if (ctx.nodes > MAX_NODES) {
    throw malformed(`The Insomnia export holds more than ${MAX_NODES} items.`);
  }
}

function skipped(ctx: Context, name: string, what: string): InsNode {
  ctx.report.warn(`The ${what} "${name}" cannot be imported and was skipped.`);
  return { kind: 'skipped', name, what };
}

/** True when `value` is an API spec with something in it. */
function hasSpec(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return nonEmptyRec(value) !== undefined;
}

// ---- v4 ----------------------------------------------------------------------------------------

function settingsV4(r: Rec): InsSettings {
  const other: string[] = [];
  if (r['settingStoreCookies'] === false) other.push('storeCookies');
  if (r['settingSendCookies'] === false) other.push('sendCookies');
  if (r['settingDisableRenderRequestBody'] === true) other.push('renderRequestBody');
  if (r['settingRebuildPath'] === false) other.push('rebuildPath');
  return {
    followRedirects: redirects(r['settingFollowRedirects']),
    encodeUrl: r['settingEncodeUrl'] !== false,
    other,
  };
}

function scriptsV4(r: Rec): InsScripts {
  return { pre: str(r['preRequestScript']) ?? '', post: str(r['afterResponseScript']) ?? '' };
}

function readV4(root: Rec): InsDocument {
  const resources = root['resources'];
  if (!Array.isArray(resources)) throw malformed('The Insomnia export has no resources list.');
  const report = new ReportBuilder();
  const ctx: Context = { report, nodes: 0 };
  const all = resources.filter(isRec);
  const children = new Map<string, Rec[]>();
  for (const r of all) {
    const parent = str(r['parentId']);
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [r]);
    else list.push(r);
  }
  const typed = (parent: string, type: string): Rec[] =>
    (children.get(parent) ?? []).filter((r) => r['_type'] === type);

  const workspaces = all.filter((r) => r['_type'] === 'workspace');
  if (workspaces.length === 0) throw malformed('The Insomnia export holds no workspace.');

  const kinds: string[] = [];
  const out: InsWorkspace[] = [];
  let environmentOnly = true;
  for (const w of workspaces) {
    const scope = str(w['scope']);
    const wid = str(w['_id']) ?? '';
    const name = nonEmpty(w['name']) ?? 'Insomnia';
    if (scope === 'mock-server' || scope === 'mcp') {
      kinds.push(scope === 'mcp' ? 'an MCP client' : 'a mock server');
      report.warn(`"${name}" is ${scope === 'mcp' ? 'an MCP client' : 'a mock server'} and was skipped.`);
      continue;
    }
    if (scope !== 'environment') environmentOnly = false;
    out.push(readV4Workspace(ctx, w, wid, name, children, typed, out.length === 0));
  }
  if (out.length === 0) {
    throw new InsomniaError(
      'insomnia-not-collection',
      `This Insomnia file is ${kinds[0] ?? 'not a collection'}, not a collection or an environment.`,
    );
  }
  return { kind: environmentOnly ? 'environment' : 'collection', version: 4, workspaces: out, report: report.build() };
}

function readV4Workspace(
  ctx: Context,
  w: Rec,
  wid: string,
  name: string,
  children: Map<string, Rec[]>,
  typed: (parent: string, type: string) => Rec[],
  first: boolean,
): InsWorkspace {
  const extras: string[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string, depth: number): InsNode[] => {
    const entries: { key: number; id: string; node: InsNode }[] = [];
    for (const r of children.get(parentId) ?? []) {
      spend(ctx);
      const id = str(r['_id']) ?? '';
      const type = str(r['_type']);
      if (seen.has(id) && id !== '') continue;
      let node: InsNode | undefined;
      if (type === 'request_group') {
        seen.add(id);
        const folderName = nonEmpty(r['name']) ?? 'Imported Folder';
        let kids: InsNode[] = [];
        if (id === '') ctx.report.warn(`The folder "${folderName}" has no id; its contents were skipped.`);
        else if (depth >= MAX_DEPTH)
          ctx.report.warn(`The folder "${folderName}" is nested too deeply; its contents were skipped.`);
        else kids = walk(id, depth + 1);
        const description = nonEmpty(r['description']);
        const auth = authOf(r['authentication']);
        const environment = nonEmptyRec(r['environment']);
        node = {
          kind: 'folder',
          id,
          name: folderName,
          children: kids,
          headers: rowsOf(r['headers'], false),
          ...(auth !== undefined ? { auth } : {}),
          ...(environment !== undefined ? { environment } : {}),
          scripts: scriptsV4(r),
          ...(description !== undefined ? { description } : {}),
        };
      } else if (type === 'request') {
        seen.add(id);
        const description = nonEmpty(r['description']);
        const auth = authOf(r['authentication']);
        node = {
          kind: 'http',
          id,
          name: nonEmpty(r['name']) ?? 'Imported Request',
          method: nonEmpty(r['method']) ?? 'GET',
          url: scalar(r['url']),
          parameters: rowsOf(r['parameters'], false),
          pathParameters: rowsOf(r['pathParameters'], false),
          headers: rowsOf(r['headers'], false),
          body: bodyOf(r['body'], false),
          ...(auth !== undefined ? { auth } : {}),
          settings: settingsV4(r),
          scripts: scriptsV4(r),
          ...(description !== undefined ? { description } : {}),
        };
      } else if (type === 'grpc_request') {
        seen.add(id);
        node = grpcNode(id, r);
      } else if (type === 'websocket_request') {
        seen.add(id);
        const auth = authOf(r['authentication']);
        const payloads = typed(id, 'websocket_payload')
          .map((p) => ({ key: num(p['metaSortKey']), id: str(p['_id']) ?? '', text: scalar(p['value']) }))
          .sort((a, b) => (a.key !== b.key ? a.key - b.key : a.id < b.id ? 1 : -1));
        const payload = payloads[0]?.text;
        node = {
          kind: 'websocket',
          id,
          name: nonEmpty(r['name']) ?? 'Imported Request',
          url: scalar(r['url']),
          headers: rowsOf(r['headers'], false),
          parameters: rowsOf(r['parameters'], false),
          ...(auth !== undefined ? { auth } : {}),
          ...(payload !== undefined && payload !== '' ? { payload } : {}),
        };
      } else if (type === 'socketio_request') {
        seen.add(id);
        node = skipped(ctx, nonEmpty(r['name']) ?? 'Imported Request', 'Socket.IO request');
      } else if (type === 'mcp_request') {
        seen.add(id);
        node = skipped(ctx, nonEmpty(r['name']) ?? 'Imported Request', 'MCP request');
      } else if (type === 'cookie_jar') {
        addExtra(extras, 'cookie jar');
      } else if (type === 'unit_test_suite') {
        // The mapper reports each suite, with the requests its tests check.
        addExtra(extras, 'unit tests');
      } else if (type === 'api_spec' && hasSpec(r['contents'])) {
        addExtra(extras, 'API spec');
        ctx.report.warn(`"${name}" embeds an API spec; import it as OpenAPI to bring it in.`);
      }
      if (node !== undefined) entries.push({ key: num(r['metaSortKey']), id, node });
    }
    return sortSiblings(entries);
  };

  const items = walk(wid, 0);

  const bases = typed(wid, 'environment');
  const base = bases[0];
  const baseId = base === undefined ? undefined : str(base['_id']);
  const subs = subEnvironmentsOf(children, baseId, first);
  const protos: InsWorkspace['protos'] = [];
  const dirs = new Set(typed(wid, 'proto_directory').map((d) => str(d['_id']) ?? ''));
  const protoParents = [wid, ...dirs];
  for (const parent of protoParents) {
    for (const p of typed(parent, 'proto_file')) {
      protos.push({
        id: str(p['_id']) ?? '',
        name: nonEmpty(p['name']) ?? 'Imported proto',
        text: scalar(p['protoText']),
        ...(parent !== wid ? { dirId: parent } : {}),
      });
    }
  }
  protos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unitTests = typed(wid, 'unit_test_suite').map((suite) => ({
    suite: nonEmpty(suite['name']) ?? 'Unit tests',
    tests: typed(str(suite['_id']) ?? '', 'unit_test').map(testOf),
  }));
  return {
    name,
    items,
    ...(base !== undefined ? { baseEnv: envOf(base, 'Base Environment', base['isPrivate']) } : {}),
    subEnvs: subs.map((s) => envOf(s, 'Imported Environment', s['isPrivate'])),
    protos,
    extras,
    unitTests,
  };
}

function testOf(test: Rec): { name: string; requestId?: string } {
  const requestId = nonEmpty(test['requestId']);
  return { name: nonEmpty(test['name']) ?? 'Test', ...(requestId !== undefined ? { requestId } : {}) };
}

function subEnvironmentsOf(children: Map<string, Rec[]>, baseId: string | undefined, legacy: boolean): Rec[] {
  const subs: Rec[] = [];
  if (baseId !== undefined) {
    for (const r of children.get(baseId) ?? []) if (r['_type'] === 'environment') subs.push(r);
  }
  for (const [parent, list] of legacy ? children : []) {
    if (!parent.startsWith('__BASE_ENVIRONMENT_ID__')) continue;
    for (const r of list) if (r['_type'] === 'environment') subs.push(r);
  }
  return subs
    .map((s, index) => ({ s, index }))
    .sort((a, b) => {
      const ka = num(a.s['metaSortKey']);
      const kb = num(b.s['metaSortKey']);
      if (ka !== kb) return ka - kb;
      const ia = str(a.s['_id']) ?? '';
      const ib = str(b.s['_id']) ?? '';
      if (ia !== ib) return ia < ib ? 1 : -1;
      return a.index - b.index;
    })
    .map(({ s }) => s);
}

function grpcNode(id: string, r: Rec): InsNode {
  const body = isRec(r['body']) ? r['body'] : {};
  const reflection = isRec(r['reflectionApi']) && r['reflectionApi']['enabled'] === true;
  const protoFileId = nonEmpty(r['protoFileId']);
  return {
    kind: 'grpc',
    id,
    name: nonEmpty(r['name']) ?? 'Imported Request',
    url: scalar(r['url']),
    ...(protoFileId !== undefined ? { protoFileId } : {}),
    protoMethodName: scalar(r['protoMethodName']),
    message: scalar(body['text']),
    metadata: rowsOf(r['metadata'], false),
    reflection,
  };
}

// ---- v5 ----------------------------------------------------------------------------------------

function metaOf(r: Rec): Rec {
  return isRec(r['meta']) ? r['meta'] : {};
}

function settingsV5(r: Rec): InsSettings {
  const s = isRec(r['settings']) ? r['settings'] : {};
  const cookies = isRec(s['cookies']) ? s['cookies'] : {};
  const other: string[] = [];
  if (cookies['store'] === false) other.push('storeCookies');
  if (cookies['send'] === false) other.push('sendCookies');
  if (s['renderRequestBody'] === false) other.push('renderRequestBody');
  if (s['rebuildPath'] === false) other.push('rebuildPath');
  return { followRedirects: redirects(s['followRedirects']), encodeUrl: s['encodeUrl'] !== false, other };
}

function scriptsV5(r: Rec): InsScripts {
  const s = isRec(r['scripts']) ? r['scripts'] : {};
  return { pre: str(s['preRequest']) ?? '', post: str(s['afterResponse']) ?? '' };
}

function readV5(root: Rec, type: string): InsDocument {
  const kind = type.slice(0, type.indexOf('.insomnia'));
  if (kind === 'mock' || kind === 'mcpClient') {
    const what = kind === 'mock' ? 'a mock server' : 'an MCP client';
    throw new InsomniaError(
      'insomnia-not-collection',
      `This Insomnia file is ${what}, not a collection or an environment.`,
    );
  }
  if (kind !== 'collection' && kind !== 'spec' && kind !== 'environment') {
    throw malformed(`Unknown Insomnia file type "${type}".`);
  }
  const report = new ReportBuilder();
  const ctx: Context = { report, nodes: 0 };
  const schema = scalar(root['schema_version']);
  const dropUnnamed = schema === '' || schema.startsWith('5.0');
  const name = nonEmpty(root['name']) ?? 'Insomnia';
  const extras: string[] = [];

  const visited = new WeakSet<object>();
  const walk = (value: unknown, depth: number): InsNode[] => {
    const entries: { key: number; id: string; node: InsNode }[] = [];
    if (!Array.isArray(value)) return [];
    if (visited.has(value)) throw malformed('The Insomnia export reuses a list of items (a YAML alias loop).');
    visited.add(value);
    for (const item of value) {
      if (!isRec(item)) continue;
      if (visited.has(item)) throw malformed('The Insomnia export reuses an item (a YAML alias loop).');
      visited.add(item);
      spend(ctx);
      const meta = metaOf(item);
      const id = str(meta['id']) ?? '';
      const itemName = nonEmpty(item['name']);
      const description = nonEmpty(meta['description']);
      const auth = authOf(item['authentication']);
      let node: InsNode;
      if (item['method'] !== undefined) {
        node = {
          kind: 'http',
          id,
          name: itemName ?? 'Imported Request',
          method: nonEmpty(item['method']) ?? 'GET',
          url: scalar(item['url']),
          parameters: rowsOf(item['parameters'], dropUnnamed),
          pathParameters: rowsOf(item['pathParameters'], dropUnnamed),
          headers: rowsOf(item['headers'], dropUnnamed),
          body: bodyOf(item['body'], dropUnnamed),
          ...(auth !== undefined ? { auth } : {}),
          settings: settingsV5(item),
          scripts: scriptsV5(item),
          ...(description !== undefined ? { description } : {}),
        };
      } else if (item['reflectionApi'] !== undefined) {
        node = grpcNode(id, { ...item, metadata: rowsOf(item['metadata'], dropUnnamed) });
        if (node.kind === 'grpc') node.name = itemName ?? 'Imported Request';
      } else if (item['url'] === undefined) {
        const folderName = itemName ?? 'Imported Folder';
        let kids: InsNode[] = [];
        if (depth >= MAX_DEPTH)
          report.warn(`The folder "${folderName}" is nested too deeply; its contents were skipped.`);
        else kids = walk(item['children'], depth + 1);
        const environment = nonEmptyRec(item['environment']);
        node = {
          kind: 'folder',
          id,
          name: folderName,
          children: kids,
          headers: rowsOf(item['headers'], dropUnnamed),
          ...(auth !== undefined ? { auth } : {}),
          ...(environment !== undefined ? { environment } : {}),
          scripts: scriptsV5(item),
          ...(description !== undefined ? { description } : {}),
        };
      } else if (
        item['eventListeners'] !== undefined ||
        id.startsWith('socketio-req') ||
        (isRec(item['settings']) && item['settings']['path'] !== undefined)
      ) {
        node = skipped(ctx, itemName ?? 'Imported Request', 'Socket.IO request');
      } else {
        node = {
          kind: 'websocket',
          id,
          name: itemName ?? 'Imported Request',
          url: scalar(item['url']),
          headers: rowsOf(item['headers'], dropUnnamed),
          parameters: rowsOf(item['parameters'], dropUnnamed),
          ...(auth !== undefined ? { auth } : {}),
        };
      }
      entries.push({ key: num(meta['sortKey']), id, node });
    }
    return sortSiblings(entries);
  };

  const items = kind === 'environment' ? [] : walk(root['collection'], 0);

  if (nonEmptyRec(root['cookieJar']) !== undefined) addExtra(extras, 'cookie jar');
  const unitTests = (Array.isArray(root['testSuites']) ? root['testSuites'] : []).filter(isRec).map((suite) => ({
    suite: nonEmpty(suite['name']) ?? 'Unit tests',
    tests: (Array.isArray(suite['tests']) ? suite['tests'] : []).filter(isRec).map(testOf),
  }));
  if (Array.isArray(root['testSuites']) && root['testSuites'].length > 0) {
    // The mapper reports each suite, with the requests its tests check.
    addExtra(extras, 'unit tests');
  }
  if (isRec(root['spec']) && hasSpec(root['spec']['contents'])) {
    addExtra(extras, 'API spec');
    report.warn(`"${name}" embeds an API spec; import it as OpenAPI to bring it in.`);
  }

  let baseEnv: InsEnv | undefined;
  let subEnvs: InsEnv[] = [];
  const envs = root['environments'];
  if (isRec(envs)) {
    baseEnv = envOf(envs, 'Base Environment', metaOf(envs)['isPrivate']);
    const subs = Array.isArray(envs['subEnvironments']) ? envs['subEnvironments'].filter(isRec) : [];
    subEnvs = subs
      .map((s, index) => ({ s, index }))
      .sort((a, b) => {
        const ka = num(metaOf(a.s)['sortKey']);
        const kb = num(metaOf(b.s)['sortKey']);
        if (ka !== kb) return ka - kb;
        const ia = str(metaOf(a.s)['id']) ?? '';
        const ib = str(metaOf(b.s)['id']) ?? '';
        if (ia !== ib) return ia < ib ? 1 : -1;
        return a.index - b.index;
      })
      .map(({ s }) => envOf(s, 'Imported Environment', metaOf(s)['isPrivate']));
  }

  const workspace: InsWorkspace = {
    name,
    items,
    ...(baseEnv !== undefined ? { baseEnv } : {}),
    subEnvs,
    protos: [],
    extras,
    unitTests,
  };
  return {
    kind: kind === 'environment' ? 'environment' : 'collection',
    version: 5,
    workspaces: [workspace],
    report: report.build(),
  };
}

// ---- entry -------------------------------------------------------------------------------------

/** Reads an Insomnia export (v4 JSON or YAML, v5 YAML) into typed shapes. */
export function parseInsomnia(text: string): InsDocument {
  if (pastCap(text)) {
    throw new InsomniaError(
      'insomnia-too-large',
      `The Insomnia export is larger than ${MAX_INSOMNIA_BYTES / (1024 * 1024)} MB.`,
    );
  }
  let root: unknown;
  try {
    // JSON is read by the much faster JSON parser; anything else (or invalid JSON) is read as YAML.
    root = JSON.parse(text);
  } catch {
    root = undefined;
  }
  if (root === undefined)
    try {
      root = parseYaml(text, { maxAliasCount: MAX_ALIAS_COUNT, logLevel: 'error' });
    } catch (error) {
      throw malformed('The file is not valid JSON or YAML.', error);
    }
  if (!isRec(root)) throw malformed('The file is not an Insomnia export.');

  const format = root['__export_format'];
  if (format !== undefined) {
    if (typeof format === 'number' && format >= 1 && format <= 3) {
      throw new InsomniaError(
        'insomnia-old-format',
        `This export uses Insomnia format ${format}, which is too old to read. Re-export it from a current Insomnia.`,
      );
    }
    if (format !== 4) throw malformed(`Unsupported Insomnia export format ${scalar(format)}.`);
    return readV4(root);
  }
  const type = root['type'];
  if (typeof type === 'string' && V5_TYPE.test(type)) return readV5(root, type);
  throw malformed('The file is not an Insomnia export.');
}
