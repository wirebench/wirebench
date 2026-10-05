/**
 * Reads OpenCollection 1.x YAML, as one document or as a directory of documents, into typed shapes.
 * Browser-safe: it takes text, never a path.
 */

import { parse as parseYaml } from 'yaml';
import { OpenCollectionError } from '../../errors.js';
import type {
  OcAssertion,
  OcCollection,
  OcEnvironment,
  OcInfo,
  OcItem,
  OcKeyValue,
  OcRequestDefaults,
  OcScript,
  OcVariable,
} from './model.js';

const ROOT_FILE = /^opencollection\.ya?ml$/i;
const YAML_FILE = /\.ya?ml$/i;
const FOLDER_FILE = /^folder\.ya?ml$/i;
const ENVIRONMENT_FILE = /^environments\/[^/]+\.ya?ml$/i;
/** Deeper nesting than any real collection; stops a hostile document from exhausting the stack. */
const MAX_DEPTH = 64;
const ENVIRONMENT_EXTRAS = ['extends', 'externalSecrets', 'dotEnvFilePath', 'clientCertificates'] as const;
const CONFIG_EXTRAS = ['proxy', 'clientCertificates'] as const;

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `root` is an OpenCollection document: a record with a string `opencollection` version. */
export function isOpenCollection(root: unknown): boolean {
  return isRecord(root) && typeof root['opencollection'] === 'string';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function readInfo(value: unknown, fallbackName: string): OcInfo {
  const raw = isRecord(value) ? value : {};
  const name = str(raw['name']);
  const type = str(raw['type']);
  const seq = typeof raw['seq'] === 'number' && Number.isFinite(raw['seq']) ? raw['seq'] : undefined;
  return {
    name: name !== undefined && name !== '' ? name : fallbackName,
    ...(type !== undefined ? { type } : {}),
    ...(seq !== undefined ? { seq } : {}),
    ...(raw['description'] !== undefined ? { description: raw['description'] } : {}),
  };
}

function list(value: unknown): readonly Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readKeyValues(value: unknown): readonly OcKeyValue[] {
  const out: OcKeyValue[] = [];
  for (const raw of list(value)) {
    const name = str(raw['name']);
    if (name === undefined) continue;
    const type = str(raw['type']);
    out.push({
      name,
      ...(raw['value'] !== undefined ? { value: raw['value'] } : {}),
      ...(raw['disabled'] === true ? { disabled: true } : {}),
      ...(type !== undefined ? { type } : {}),
    });
  }
  return out;
}

function readVariables(value: unknown): readonly OcVariable[] {
  const out: OcVariable[] = [];
  for (const raw of list(value)) {
    const name = str(raw['name']);
    if (name === undefined) continue;
    out.push({
      name,
      ...(raw['value'] !== undefined ? { value: raw['value'] } : {}),
      ...(raw['secret'] === true ? { secret: true } : {}),
      ...(raw['disabled'] === true ? { disabled: true } : {}),
    });
  }
  return out;
}

function readScripts(value: unknown): readonly OcScript[] {
  const out: OcScript[] = [];
  for (const raw of list(value)) {
    const type = str(raw['type']);
    const code = str(raw['code']);
    if (type !== undefined && code !== undefined) out.push({ type, code });
  }
  return out;
}

function readAssertions(value: unknown): readonly OcAssertion[] {
  const out: OcAssertion[] = [];
  for (const raw of list(value)) {
    const expression = str(raw['expression']);
    const operator = str(raw['operator']);
    if (expression === undefined || operator === undefined) continue;
    const v = raw['value'];
    const text = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
    out.push({
      expression,
      operator,
      ...(text !== undefined ? { value: text } : {}),
      ...(raw['disabled'] === true ? { disabled: true } : {}),
    });
  }
  return out;
}

function readDefaults(value: unknown): OcRequestDefaults | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(Array.isArray(value['headers']) ? { headers: readKeyValues(value['headers']) } : {}),
    ...(value['auth'] !== undefined ? { auth: value['auth'] } : {}),
    ...(Array.isArray(value['variables']) ? { variables: readVariables(value['variables']) } : {}),
    ...(Array.isArray(value['scripts']) ? { scripts: readScripts(value['scripts']) } : {}),
  };
}

function readRuntime(value: unknown): OcItem['runtime'] {
  if (!isRecord(value)) return undefined;
  return {
    ...(Array.isArray(value['variables']) ? { variables: readVariables(value['variables']) } : {}),
    ...(Array.isArray(value['scripts']) ? { scripts: readScripts(value['scripts']) } : {}),
    ...(Array.isArray(value['assertions']) ? { assertions: readAssertions(value['assertions']) } : {}),
  };
}

/** One item document, its `items` (single form) read recursively. */
function readItem(raw: Rec, path: string, fallbackName: string, depth: number): OcItem {
  if (depth > MAX_DEPTH) {
    throw new OpenCollectionError('oc-too-deep', `Items nest deeper than ${MAX_DEPTH} levels at ${path}.`);
  }
  const children = Array.isArray(raw['items']) ? readItems(raw['items'] as unknown[], path, depth + 1) : undefined;
  return itemFrom(raw, path, fallbackName, children);
}

/** The records of an `items` array, each read as an item at `<parent>.items[i]` (or `items[i]` at the top). */
function readItems(raw: readonly unknown[], parent: string, depth: number): OcItem[] {
  const out: OcItem[] = [];
  raw.forEach((child, index) => {
    if (!isRecord(child)) return;
    const path = parent === '' ? `items[${index}]` : `${parent}.items[${index}]`;
    out.push(readItem(child, path, `Item ${index + 1}`, depth));
  });
  return sortBySeq(out);
}

function itemFrom(raw: Rec, path: string, fallbackName: string, children: readonly OcItem[] | undefined): OcItem {
  const info = readInfo(raw['info'], fallbackName);
  const request = readDefaults(raw['request']);
  const http = recordOf(raw['http']);
  const graphql = recordOf(raw['graphql']);
  const grpc = recordOf(raw['grpc']);
  const websocket = recordOf(raw['websocket']);
  const runtime = readRuntime(raw['runtime']);
  const settings = recordOf(raw['settings']);
  const script = info.type === undefined ? str(raw['script']) : undefined;
  return {
    info,
    path,
    ...(children !== undefined ? { items: children } : {}),
    ...(request !== undefined ? { request } : {}),
    ...(http !== undefined ? { http } : {}),
    ...(graphql !== undefined ? { graphql } : {}),
    ...(grpc !== undefined ? { grpc } : {}),
    ...(websocket !== undefined ? { websocket } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(Array.isArray(raw['examples']) ? { examples: raw['examples'] as readonly unknown[] } : {}),
    ...(script !== undefined ? { script } : {}),
  };
}

/** Stable sort by `seq`, a missing one last; equal ones keep the order they came in. */
function sortBySeq<T extends { readonly info: OcInfo }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.info.seq ?? Infinity) - (b.info.seq ?? Infinity) || 0);
}

function readEnvironment(raw: Rec, fallbackName: string): OcEnvironment {
  return {
    name: str(raw['name']) ?? fallbackName,
    variables: readVariables(raw['variables']),
    extras: ENVIRONMENT_EXTRAS.filter((key) => raw[key] !== undefined),
  };
}

function parseDocument(text: string): unknown {
  return parseYaml(text);
}

/** A directory node: the folder document's `info` and `request`, its files, its subdirectories. */
interface DirNode {
  readonly files: Map<string, string>;
  readonly dirs: Map<string, DirNode>;
}

function newNode(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

function stem(file: string): string {
  return file.replace(YAML_FILE, '');
}

/** Orders by code point, as the keys of a path map sort, whatever the platform's locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readDirectory(
  node: DirNode,
  prefix: string,
  name: string,
  depth: number,
  unreadable: string[],
  folder: boolean,
): OcItem {
  if (depth > MAX_DEPTH) {
    throw new OpenCollectionError('oc-too-deep', `Folders nest deeper than ${MAX_DEPTH} levels at ${prefix}.`);
  }
  let folderDoc: Rec = {};
  const entries: Array<{ key: string; item: OcItem }> = [];
  for (const [file, text] of [...node.files].sort(([a], [b]) => byCodePoint(a, b))) {
    const key = `${prefix}${file}`;
    let doc: unknown;
    try {
      doc = parseDocument(text);
    } catch {
      unreadable.push(`unreadable:${key}`);
      continue;
    }
    if (!isRecord(doc)) {
      unreadable.push(`unreadable:${key}`);
      continue;
    }
    if (folder && FOLDER_FILE.test(file)) {
      folderDoc = doc;
      continue;
    }
    entries.push({ key: file, item: itemFrom(doc, key, stem(file), undefined) });
  }
  for (const [dir, child] of node.dirs) {
    entries.push({
      key: dir,
      item: readDirectory(child, `${prefix}${dir}/`, dir, depth + 1, unreadable, true),
    });
  }
  entries.sort((a, b) => byCodePoint(a.key, b.key));
  const children = sortBySeq(entries.map((entry) => entry.item));
  const request = readDefaults(folderDoc['request']);
  const info = readInfo(folderDoc['info'], name);
  return {
    info: info.type === undefined ? { ...info, type: 'folder' } : info,
    path: prefix === '' ? '' : prefix.slice(0, -1),
    items: children,
    ...(request !== undefined ? { request } : {}),
  };
}

/** Builds the directory tree from the root-relative POSIX keys, leaving out the root and the environments. */
function buildTree(files: ReadonlyMap<string, string>, rootKey: string | undefined): DirNode {
  const root = newNode();
  for (const [key, text] of files) {
    if (!YAML_FILE.test(key) || ENVIRONMENT_FILE.test(key)) continue;
    if (rootKey !== undefined ? key === rootKey : ROOT_FILE.test(key)) continue;
    const segments = key.split('/').filter((s) => s !== '');
    const file = segments.pop();
    if (file === undefined) continue;
    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = newNode();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(file, text);
  }
  return root;
}

/**
 * True when `rootText` is a document without an `items` list: the root of a collection saved as a
 * folder, whose items are the files beside it. False for anything that does not parse.
 */
export function isFolderRoot(rootText: string): boolean {
  try {
    const root = parseDocument(rootText);
    return isRecord(root) && !Array.isArray(root['items']);
  } catch {
    return false;
  }
}

/**
 * Reads an OpenCollection 1.x collection. `files` maps root-relative POSIX paths to text for the
 * directory form (the root document, with no `items`, is `rootText`) and is absent for a single
 * document. `rootKey` names the root's own key in `files`, so a differently cased root is not read
 * as an item.
 */
export function parseOpenCollection(
  rootText: string,
  files?: ReadonlyMap<string, string>,
  rootKey?: string,
): OcCollection {
  let root: unknown;
  try {
    root = parseDocument(rootText);
  } catch (cause) {
    throw new OpenCollectionError('oc-malformed', 'The OpenCollection document is not valid YAML.', { cause });
  }
  if (!isOpenCollection(root) || !isRecord(root)) {
    throw new OpenCollectionError('oc-not-collection', 'This is not an OpenCollection document.');
  }
  const version = String(root['opencollection']);
  if (version.split('.')[0] !== '1') {
    throw new OpenCollectionError(
      'oc-unsupported-version',
      `OpenCollection ${version} is not supported; this build reads 1.x`,
    );
  }
  const config = isRecord(root['config']) ? root['config'] : {};
  const configExtras: string[] = CONFIG_EXTRAS.filter((key) => config[key] !== undefined);
  const environments = list(config['environments']).map((env, index) =>
    readEnvironment(env, `Environment ${index + 1}`),
  );
  const request = readDefaults(root['request']);
  const info = readInfo(root['info'], '');

  let items: readonly OcItem[];
  if (files !== undefined && !Array.isArray(root['items'])) {
    const unreadable: string[] = [];
    items = readDirectory(buildTree(files, rootKey), '', '', 0, unreadable, false).items ?? [];
    for (const [key, text] of [...files].sort(([a], [b]) => byCodePoint(a, b))) {
      if (!ENVIRONMENT_FILE.test(key)) continue;
      try {
        const doc = parseDocument(text);
        if (isRecord(doc)) environments.push(readEnvironment(doc, stem(key.slice(key.lastIndexOf('/') + 1))));
        else unreadable.push(`unreadable:${key}`);
      } catch {
        unreadable.push(`unreadable:${key}`);
      }
    }
    configExtras.push(...unreadable);
  } else {
    items = readItems(Array.isArray(root['items']) ? (root['items'] as unknown[]) : [], '', 1);
  }

  return {
    version,
    info,
    items,
    ...(request !== undefined ? { request } : {}),
    environments,
    configExtras,
  };
}
