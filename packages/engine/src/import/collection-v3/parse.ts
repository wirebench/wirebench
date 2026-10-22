/**
 * Reads a folder (v3) collection, handed over as a map of root-relative POSIX paths to text, into
 * the tree {@link V3Workspace} describes. Browser-safe: it never touches the file system, so a path
 * a document names — examples, messages, a script file — is only ever looked up in that map, and
 * one that is absolute, holds a backslash, or climbs out of its collection is refused.
 */

import { parse as parseYaml } from 'yaml';
import { ReportBuilder } from '#core/import/report';
import type { V3Collection, V3File, V3Folder, V3Request, V3Script, V3Workspace } from './model.js';
import { MAX_V3_DEPTH } from './model.js';

type Rec = Readonly<Record<string, unknown>>;

const RESOURCES = '.resources';
const DEFINITION_NAMES = ['definition.yaml', 'definition.yml'];
const REQUEST_SUFFIXES = ['.request.yaml', '.request.yml'];
const EXAMPLE_SUFFIXES = ['.example.yaml', '.example.yml'];
const MESSAGE_SUFFIXES = ['.message.yaml', '.message.yml'];
const YAML_SUFFIXES = ['.yaml', '.yml'];
/** The fields a script entry may name its file by, when it has no `code`. */
const SCRIPT_PATH_FIELDS = ['src', 'path', 'file'] as const;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function endsWithAny(name: string, suffixes: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  return suffixes.find((suffix) => lower.endsWith(suffix));
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** A finite `order`, or `undefined`. */
function orderOf(doc: Rec | undefined): number | undefined {
  const order = doc?.['order'];
  return typeof order === 'number' && Number.isFinite(order) ? order : undefined;
}

/** By `order` (missing last), then by name, then by path: the same files always give the same tree. */
function byOrder<T extends { readonly order: number | undefined; readonly name: string; readonly path: string }>(
  a: T,
  b: T,
): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * `relative` resolved against `dir`, kept inside `root` (both root-relative, no trailing `/`), or
 * `undefined` when it is absolute, holds a backslash or NUL, or climbs above `root`.
 */
export function resolveInside(root: string, dir: string, relative: string): string | undefined {
  if (relative === '' || relative.includes('\\') || relative.includes('\u0000')) return undefined;
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return undefined;
  const out = dir === '' ? [] : dir.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const resolved = out.join('/');
  if (root !== '' && resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;
  return resolved;
}

/** A path from the host is root-relative POSIX: no leading `/`, no `\`, no `.` or `..` segment. */
function wellFormedKey(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

class Reader {
  readonly report = new ReportBuilder();
  private readonly docs = new Map<string, Rec | undefined>();
  /** The files directly in each folder, by root-relative folder path (`''` for the root), sorted. */
  private readonly filesIn = new Map<string, string[]>();
  /** The folders directly in each folder, by name. */
  private readonly foldersIn = new Map<string, Set<string>>();
  /** Every folder holding a request file (outside `.resources`) or a folder definition, at any depth. */
  private readonly holding = new Set<string>();

  constructor(private readonly files: ReadonlyMap<string, string>) {
    const keys: string[] = [];
    for (const key of files.keys()) {
      if (!wellFormedKey(key)) {
        this.report.warn(`${key}: not a path inside the folder, so it was skipped.`);
        continue;
      }
      if (key.split('/').length > MAX_V3_DEPTH) {
        this.report.warn(`${key}: nested more than ${String(MAX_V3_DEPTH)} folders deep, so it was skipped.`);
        continue;
      }
      keys.push(key);
    }
    keys.sort();
    // One pass builds the index every lookup below uses, so reading a large tree stays linear.
    for (const key of keys) {
      const dir = dirOf(key);
      const files = this.filesIn.get(dir);
      if (files === undefined) this.filesIn.set(dir, [key]);
      else files.push(key);
      const segments = key.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        const parent = segments.slice(0, depth - 1).join('/');
        const folders = this.foldersIn.get(parent);
        if (folders === undefined) this.foldersIn.set(parent, new Set([segments[depth - 1]!]));
        else folders.add(segments[depth - 1]!);
      }
      const name = segments[segments.length - 1]!;
      const isRequest = !segments.includes(RESOURCES) && endsWithAny(name, REQUEST_SUFFIXES) !== undefined;
      const isDefinition =
        segments.length >= 2 &&
        segments[segments.length - 2] === RESOURCES &&
        DEFINITION_NAMES.includes(name.toLowerCase());
      if (!isRequest && !isDefinition) continue;
      // A request's own folder and its parents; a definition's folder (above `.resources`) and its parents.
      const own = isRequest ? segments.length - 1 : segments.length - 2;
      for (let depth = own; depth >= 0; depth -= 1) this.holding.add(segments.slice(0, depth).join('/'));
    }
  }

  /** The files directly in folder `dir`. */
  filesOf(dir: string): readonly string[] {
    return this.filesIn.get(dir) ?? [];
  }

  /** The folders directly in `dir` that hold collection files, sorted, `.resources` aside. */
  folders(dir: string): string[] {
    return [...(this.foldersIn.get(dir) ?? [])]
      .filter((name) => name !== RESOURCES && this.holding.has(join(dir, name)))
      .sort();
  }

  /** Whether anything at or under `dir` is a request file or a folder definition. */
  holds(dir: string): boolean {
    return this.holding.has(dir);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  text(path: string): string | undefined {
    return this.files.get(path);
  }

  /** The YAML document at `path` when it is a record; anything else is reported once. */
  doc(path: string): Rec | undefined {
    if (this.docs.has(path)) return this.docs.get(path);
    const text = this.files.get(path);
    let doc: Rec | undefined;
    if (text !== undefined) {
      let parsed: unknown;
      try {
        parsed = parseYaml(text.replace(/^﻿/, ''));
      } catch {
        this.report.warn(`${path}: not valid YAML, so it was skipped.`);
        parsed = undefined;
      }
      if (isRecord(parsed)) doc = parsed;
      else if (parsed !== undefined) this.report.warn(`${path}: not a YAML mapping, so it was skipped.`);
    }
    this.docs.set(path, doc);
    return doc;
  }

  /** The definition file of folder `dir`, when there is one that reads. */
  definitionPath(dir: string): string | undefined {
    return DEFINITION_NAMES.map((name) => join(join(dir, RESOURCES), name)).find((path) => this.has(path));
  }

  /** The documents directly inside `dir` whose names end in one of `suffixes`, by `order`. */
  listed(dir: string, suffixes: readonly string[]): V3File[] {
    const found: (V3File & { order: number | undefined; name: string })[] = [];
    for (const key of this.filesOf(dir)) {
      if (endsWithAny(key, suffixes) === undefined) continue;
      const doc = this.doc(key);
      if (doc === undefined) continue;
      found.push({ path: key, doc, order: orderOf(doc), name: str(doc['name']) ?? lastSegment(key) });
    }
    return found.sort(byOrder).map(({ path, doc }) => ({ path, doc }));
  }

  /**
   * A definition's or request's scripts. Source comes from `code`, or from a relative `src`, `path`
   * or `file` looked up among the files handed over, resolved against the document's folder and
   * kept inside `root`.
   */
  scripts(doc: Rec, docPath: string, root: string): V3Script[] {
    const raw = doc['scripts'];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      this.report.warn(`${docPath}: scripts is not a list, so it was skipped.`);
      return [];
    }
    const out: V3Script[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const type = str(entry['type']) ?? '';
      const code = str(entry['code']);
      if (code !== undefined) {
        out.push({ type, code });
        continue;
      }
      const named = SCRIPT_PATH_FIELDS.map((field) => str(entry[field])).find((value) => value !== undefined);
      if (named === undefined) continue;
      const resolved = resolveInside(root, dirOf(docPath), named);
      if (resolved === undefined) {
        this.report.warn(`${docPath}: the script file "${named}" is outside the collection, so it was not read.`);
        continue;
      }
      const text = this.text(resolved);
      if (text === undefined) {
        this.report.warn(`${docPath}: the script file "${named}" was not found in the collection.`);
        continue;
      }
      out.push({ type, code: text });
    }
    return out;
  }

  /**
   * The folder a request's examples or messages live in: the relative path `field` names, else
   * `.resources/<stem>.resources/<sub>` beside the request. A named path outside the collection is
   * refused and reported.
   */
  resourceDir(doc: Rec, docPath: string, root: string, field: string, stem: string, sub: string): string | undefined {
    const named = str(doc[field]);
    const dir = dirOf(docPath);
    if (named === undefined || named === '') return join(join(dir, RESOURCES), `${stem}${RESOURCES}/${sub}`);
    const resolved = resolveInside(root, dir, named);
    if (resolved === undefined) {
      this.report.warn(`${docPath}: its ${field} folder "${named}" is outside the collection, so it was not read.`);
    }
    return resolved;
  }
}

function readRequest(reader: Reader, path: string, root: string): V3Request | undefined {
  const doc = reader.doc(path);
  if (doc === undefined) return undefined;
  const kind = str(doc['$kind']);
  if (kind === undefined) {
    reader.report.warn(`${path}: it has no $kind, so it was skipped.`);
    return undefined;
  }
  const file = lastSegment(path);
  const stem = file.slice(0, file.length - (endsWithAny(file, REQUEST_SUFFIXES)?.length ?? 0));
  const ownName = str(doc['name'])?.trim();
  const examplesDir = reader.resourceDir(doc, path, root, 'examples', stem, 'examples');
  const messagesDir = reader.resourceDir(doc, path, root, 'messages', stem, 'messages');
  return {
    type: 'request',
    name: ownName !== undefined && ownName !== '' ? ownName : stem,
    path,
    order: orderOf(doc),
    kind,
    doc,
    scripts: reader.scripts(doc, path, root),
    examples: examplesDir === undefined ? [] : reader.listed(examplesDir, EXAMPLE_SUFFIXES),
    messages: messagesDir === undefined ? [] : reader.listed(messagesDir, MESSAGE_SUFFIXES),
  };
}

/** The folder at `dir` (root-relative) and everything below it, inside collection `root`. */
function readFolder(reader: Reader, dir: string, root: string, fallbackName: string): V3Folder {
  const definitionPath = reader.definitionPath(dir);
  const definition = definitionPath === undefined ? undefined : reader.doc(definitionPath);
  const requests: V3Request[] = [];
  for (const key of reader.filesOf(dir)) {
    if (endsWithAny(lastSegment(key), REQUEST_SUFFIXES) === undefined) continue;
    const request = readRequest(reader, key, root);
    if (request !== undefined) requests.push(request);
  }
  const folders = reader.folders(dir).map((child) => readFolder(reader, join(dir, child), root, child));
  const ownName = str(definition?.['name'])?.trim();
  return {
    type: 'folder',
    name: ownName !== undefined && ownName !== '' ? ownName : fallbackName,
    path: dir,
    order: orderOf(definition),
    ...(definition !== undefined ? { definition } : {}),
    scripts:
      definition !== undefined && definitionPath !== undefined ? reader.scripts(definition, definitionPath, root) : [],
    children: [...folders, ...requests].sort(byOrder),
  };
}

/** Whether folder `dir` is itself a collection: it has a definition or request files of its own. */
function isCollectionRoot(reader: Reader, dir: string): boolean {
  if (reader.definitionPath(dir) !== undefined) return true;
  return reader.filesOf(dir).some((key) => endsWithAny(lastSegment(key), REQUEST_SUFFIXES) !== undefined);
}

/** The folders directly under `dir` that hold collection files: the collections of a collections folder. */
function collectionDirs(reader: Reader, dir: string): string[] {
  return reader.folders(dir);
}

/** The YAML documents directly in folder `dir`. */
function documentsIn(reader: Reader, dir: string): V3File[] {
  const out: V3File[] = [];
  for (const key of reader.filesOf(dir)) {
    if (endsWithAny(key, YAML_SUFFIXES) === undefined) continue;
    const doc = reader.doc(key);
    if (doc !== undefined) out.push({ path: key, doc });
  }
  return out;
}

/**
 * Reads a picked folder. It is one collection when it has a definition or request files of its own;
 * a workspace folder when it has neither but holds `collections/` (each folder there a collection,
 * with `environments/` and `globals/` beside it); a collections folder when it is named
 * `collections` and has neither (each folder in it a collection); otherwise one collection when
 * requests lie in folders below it. `rootName` is the picked folder's
 * own name: a collection without a definition is named after it.
 */
export function readCollectionV3(files: ReadonlyMap<string, string>, rootName: string): V3Workspace {
  const reader = new Reader(files);
  let collections: V3Collection[];
  let environments: V3File[] = [];
  let globals: V3File[] = [];
  if (isCollectionRoot(reader, '')) {
    collections = [readFolder(reader, '', '', rootName)];
  } else if (collectionDirs(reader, 'collections').length > 0) {
    collections = collectionDirs(reader, 'collections').map((name) =>
      readFolder(reader, `collections/${name}`, `collections/${name}`, name),
    );
    environments = documentsIn(reader, 'environments');
    globals = documentsIn(reader, 'globals');
  } else if (rootName === 'collections') {
    collections = collectionDirs(reader, '').map((name) => readFolder(reader, name, name, name));
  } else if (reader.holds('')) {
    // A collection made only of folders: nothing of its own at the top, requests below.
    collections = [readFolder(reader, '', '', rootName)];
  } else {
    collections = [];
  }
  return { collections, environments, globals, report: reader.report.build() };
}

/** Every request in `folder` and the folders below it, depth-first in order. */
export function v3Requests(folder: V3Folder): V3Request[] {
  return folder.children.flatMap((child) => (child.type === 'request' ? [child] : v3Requests(child)));
}
