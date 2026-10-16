/**
 * Reading a Bruno collection — a folder of `.bru` files, its `bruno.json`, or a JSON export — and
 * mapping it through the OpenCollection mapper into one client import entry. File access stays
 * here, out of the pure converters.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { BrunoError } from '../../errors.js';
import type { MappedClientEntry, MappedClientImport, MappedProtoSet } from '../client-import.js';
import type { ImportFolderErrorCode } from '../read-folder.js';
import { readImportFolder } from '../read-folder.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import { unshieldTemplates } from '../template-dialects.js';
import type { MapOpenCollectionOptions } from '../opencollection/map.js';
import { mapOpenCollection } from '../opencollection/map.js';
import type { OcCollection } from '../opencollection/model.js';
import { ocOfBrunoFolder } from './convert.js';
import { ocOfBrunoExport } from './json-export.js';

/** The largest JSON export read, the other importers' file limit. */
export const MAX_BRUNO_EXPORT_BYTES = 50 * 1024 * 1024;

export type BrunoSource =
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'text'; readonly text: string };

export interface MapBrunoOptions extends MapOpenCollectionOptions {
  /** The name of the APIs, in place of the collection's. */
  readonly name?: string;
  /** The collection's `.proto` texts by root-relative path, for its gRPC API's definition. */
  readonly protoSources?: ReadonlyMap<string, string>;
}

const WALK_CODES: Readonly<Record<ImportFolderErrorCode, string>> = {
  'not-a-folder': 'bruno-not-a-folder',
  'too-many-files': 'bruno-too-many-files',
  'too-deep': 'bruno-too-deep',
  'too-large': 'bruno-too-large',
  'read-failed': 'bruno-read-failed',
};

/** What the folder walk reads: requests, settings and environments, scripts and `.proto` files. `.env` never. */
function readable(name: string): boolean {
  return /\.(?:bru|json|js|proto)$/i.test(name) && !name.startsWith('.env');
}

/** The `.proto` set for a gRPC API whose items name `named`, with a note for each one the collection lacks. */
function protoSet(
  named: readonly string[],
  sources: ReadonlyMap<string, string> | undefined,
  apiName: string,
  report: ReportBuilder,
): MappedProtoSet | undefined {
  if (sources === undefined || named.length === 0) return undefined;
  const roots = named.filter((path) => sources.has(path));
  for (const missing of named.filter((path) => !sources.has(path))) {
    report.note(`${apiName}: the .proto file ${missing} is not in the collection.`);
  }
  if (roots.length === 0) {
    report.note(`${apiName}: needs a definition: import its .proto or use server reflection.`);
    return undefined;
  }
  return { sources: new Map(sources), roots };
}

/**
 * A converted Bruno collection, mapped as one client import entry: its REST, gRPC and WebSocket
 * APIs, the variable plan, the scripts kept as text, and the converter's and mapper's reports.
 *
 * @throws BrunoError `bruno-nothing-to-import` when it holds no request and no environment
 */
export function mapBruno(
  collection: OcCollection,
  report: ImportReport,
  options: MapBrunoOptions = {},
): MappedClientImport {
  const named =
    options.name !== undefined && options.name.trim() !== ''
      ? { ...collection, info: { ...collection.info, name: options.name.trim() } }
      : collection;
  const mapped = mapOpenCollection(named, options);
  if (mapped.counts.requests === 0 && mapped.variables.environments.length === 0) {
    throw new BrunoError(
      'bruno-nothing-to-import',
      'The Bruno collection holds nothing Wirebench can bring across: no HTTP, gRPC or WebSocket request, and no environment.',
    );
  }
  const lines = new ReportBuilder();
  for (const line of report.warnings) lines.warn(line);
  for (const line of report.notes) lines.note(line);
  const grpcProtos =
    mapped.grpc !== undefined ? protoSet(mapped.protoFiles, options.protoSources, mapped.grpc.name, lines) : undefined;
  const mappedReport = mapped.report;
  for (const line of mappedReport.warnings) lines.warn(line);
  for (const line of mappedReport.notes) lines.note(line);

  const entry: MappedClientEntry = {
    name: named.info.name !== '' ? named.info.name : 'Collection',
    ...(mapped.rest !== undefined ? { rest: mapped.rest } : {}),
    ...(mapped.grpc !== undefined ? { grpc: mapped.grpc } : {}),
    ...(grpcProtos !== undefined ? { grpcProtos } : {}),
    ...(mapped.websocket !== undefined ? { websocket: mapped.websocket } : {}),
  };
  const examples = mapped.rest !== undefined ? countExamples(mapped.rest) : 0;
  // Constructs the dialect kept as written were shielded from the shared rewrite: restore them.
  return unshieldTemplates({
    collections: entry.rest !== undefined || entry.grpc !== undefined || entry.websocket !== undefined ? [entry] : [],
    variables: mapped.variables,
    scripts: mapped.scripts,
    counts: {
      collections: 1,
      requests: mapped.counts.requests,
      folders: mapped.counts.folders,
      examples,
      assertions: mapped.counts.assertions,
      scripts: mapped.scripts.length,
    },
    report: lines.build(),
  });
}

function countExamples(container: {
  readonly folders: readonly { readonly folders: readonly unknown[]; readonly requests: readonly unknown[] }[];
  readonly requests: readonly { readonly examples?: readonly unknown[] }[];
}): number {
  const own = container.requests.reduce((sum, r) => sum + (r.examples?.length ?? 0), 0);
  return own + container.folders.reduce((sum, f) => sum + countExamples(f as typeof container), 0);
}

/**
 * Every `.bru`, `.json`, `.js` and `.proto` file of the collection at `root`, by root-relative POSIX
 * path; `mocks/` is skipped, and a `.env` file is never opened.
 *
 * @throws BrunoError the walk's codes: `bruno-not-a-folder`, `bruno-too-many-files`, `bruno-too-deep`,
 *   `bruno-too-large`, `bruno-read-failed`
 */
export async function readBrunoFolder(root: string): Promise<Map<string, string>> {
  return readImportFolder(root, {
    readFile: readable,
    skipFolder: (rel) => rel === 'mocks',
    error: (code, message, cause) =>
      new BrunoError(WALK_CODES[code], message, cause !== undefined ? { cause } : undefined),
  });
}

async function readExportFile(path: string): Promise<string> {
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_BRUNO_EXPORT_BYTES) {
    throw new BrunoError('bruno-too-large', 'The Bruno export is larger than 50 MB');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new BrunoError(
      'bruno-read-failed',
      `Failed to read the Bruno export "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseExport(text: string): unknown {
  if (text.length > MAX_BRUNO_EXPORT_BYTES) {
    throw new BrunoError('bruno-too-large', 'The Bruno export is larger than 50 MB');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BrunoError('bruno-malformed', 'The Bruno export is not valid JSON.', { cause: error });
  }
}

/**
 * Reads and maps a Bruno collection. A folder, or its `bruno.json`, is read as the folder of `.bru`
 * files; any other file, or text, as a JSON export.
 *
 * @throws BrunoError the walk's and converters' codes, `bruno-malformed`, `bruno-not-export` and
 *   `bruno-nothing-to-import`
 */
export async function importBruno(source: BrunoSource, options: MapBrunoOptions = {}): Promise<MappedClientImport> {
  if (source.kind === 'text') {
    const { collection, report } = ocOfBrunoExport(parseExport(source.text));
    return mapBruno(collection, report, options);
  }
  const path = resolve(source.path);
  const folder = source.kind === 'folder' || basename(path).toLowerCase() === 'bruno.json';
  if (!folder) {
    const { collection, report } = ocOfBrunoExport(parseExport(await readExportFile(path)));
    return mapBruno(collection, report, options);
  }
  const root = source.kind === 'folder' ? path : dirname(path);
  const files = await readBrunoFolder(root);
  const protoSources = new Map([...files].filter(([rel]) => rel.toLowerCase().endsWith('.proto')));
  const { collection, report } = ocOfBrunoFolder(files, basename(root));
  return mapBruno(collection, report, { rootDir: root, protoSources, ...options });
}
