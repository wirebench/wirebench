/**
 * Reading Thunder Client's files (spec 2026-10-15 §7.1): a collection or environment export, the
 * one-file-per-collection `thunder-tests` folder, and the legacy four-file folder. The marker key
 * is `client` in older exports and `clientName` in newer ones; `body.raw`, `docs` and a script are
 * a string or an array of lines. The `ref` hash is ignored. Pure.
 */

import { ThunderError } from '../../errors.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type {
  TcCollection,
  TcEnvironment,
  TcFolder,
  TcParam,
  TcRec,
  TcRequest,
  TcRow,
  TcTest,
  TcVariable,
} from './model.js';
import { MAX_THUNDER_BYTES } from './model.js';

const MARKER = 'Thunder Client';

function isRecord(value: unknown): value is TcRec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** A text written as a string or, by newer versions, an array of lines. */
export function lines(value: unknown): string {
  if (Array.isArray(value)) return value.map(str).join('\n');
  return str(value);
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function sortNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rows(value: unknown): TcRow[] {
  return list(value)
    .filter(isRecord)
    .map((row) => ({ name: str(row['name']), value: str(row['value']), disabled: row['isDisabled'] === true }));
}

function params(value: unknown): TcParam[] {
  return list(value)
    .filter(isRecord)
    .map((row) => ({
      name: str(row['name']),
      value: str(row['value']),
      disabled: row['isDisabled'] === true,
      isPath: row['isPath'] === true,
    }));
}

export function tests(value: unknown): TcTest[] {
  return list(value)
    .filter(isRecord)
    .map((row) => ({
      type: str(row['type']),
      custom: str(row['custom']),
      action: str(row['action']),
      value: str(row['value']),
    }));
}

function request(raw: TcRec): TcRequest {
  const reqType = str(raw['reqType']);
  const docs = lines(raw['docs']);
  return {
    id: str(raw['_id']),
    name: str(raw['name']) !== '' ? str(raw['name']) : 'Untitled request',
    folderId: str(raw['containerId']),
    method: str(raw['method']) !== '' ? str(raw['method']).toUpperCase() : 'GET',
    url: str(raw['url']),
    ...(reqType !== '' ? { reqType } : {}),
    params: params(raw['params']),
    headers: rows(raw['headers']),
    ...(isRecord(raw['body']) ? { body: raw['body'] } : {}),
    ...(isRecord(raw['auth']) ? { auth: raw['auth'] } : {}),
    tests: tests(raw['tests']),
    ...(isRecord(raw['preReq']) ? { preReq: raw['preReq'] } : {}),
    ...(isRecord(raw['postReq']) ? { postReq: raw['postReq'] } : {}),
    ...(docs !== '' ? { docs } : {}),
    sortNum: sortNum(raw['sortNum']),
  };
}

function folder(raw: TcRec): TcFolder {
  return {
    id: str(raw['_id']),
    name: str(raw['name']) !== '' ? str(raw['name']) : 'Untitled folder',
    parentId: str(raw['containerId']),
    sortNum: sortNum(raw['sortNum']),
    settings: isRecord(raw['settings']) ? raw['settings'] : {},
  };
}

function collection(raw: TcRec, name: string, requests: readonly unknown[]): TcCollection {
  return {
    id: str(raw['collectionId'] ?? raw['_id']),
    name: name !== '' ? name : 'Untitled collection',
    settings: isRecord(raw['settings']) ? raw['settings'] : {},
    folders: list(raw['folders']).filter(isRecord).map(folder),
    requests: requests.filter(isRecord).map(request),
  };
}

function variable(raw: TcRec): TcVariable {
  const encrypted = raw['encrypted'] === true;
  return {
    name: str(raw['name']),
    value: encrypted ? '' : str(raw['value']),
    secret: raw['secret'] === true,
    encrypted,
  };
}

function environment(raw: TcRec, name: string, variables: unknown): TcEnvironment {
  const envFile = str(raw['envFile']);
  return {
    name: name !== '' ? name : 'Environment',
    global: raw['global'] === true,
    variables: list(variables)
      .filter(isRecord)
      .filter((v) => str(v['name']) !== '')
      .map(variable),
    ...(envFile !== '' ? { envFile } : {}),
    flags: ['default', 'local'].filter((flag) => raw[flag] === true),
  };
}

function parseJson(text: string, what: string): unknown {
  if (text.length > MAX_THUNDER_BYTES) {
    throw new ThunderError('thunder-too-large', `The Thunder Client ${what} is larger than 50 MB`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ThunderError('thunder-malformed', `The Thunder Client ${what} is not valid JSON.`, { cause: error });
  }
}

function hasMarker(value: TcRec): boolean {
  return value['clientName'] === MARKER || value['client'] === MARKER;
}

/**
 * A collection or environment export.
 *
 * @throws ThunderError `thunder-malformed`, `thunder-too-large`, `thunder-not-export`
 */
export function parseThunderExport(text: string): {
  collections: TcCollection[];
  environments: TcEnvironment[];
  report: ImportReport;
} {
  const parsed = parseJson(text, 'export');
  const report = new ReportBuilder();
  if (isRecord(parsed) && hasMarker(parsed)) {
    if (typeof parsed['collectionName'] === 'string') {
      return {
        collections: [collection(parsed, parsed['collectionName'], list(parsed['requests']))],
        environments: [],
        report: report.build(),
      };
    }
    if (typeof parsed['environmentName'] === 'string') {
      return {
        collections: [],
        environments: [environment(parsed, parsed['environmentName'], parsed['variables'])],
        report: report.build(),
      };
    }
  }
  // A workspace file picked on its own reads as the folder it came from would.
  if (isRecord(parsed) && typeof parsed['colName'] === 'string') {
    return parseThunderFolder(new Map([['collections/tc_col_picked.json', text]]));
  }
  if (isRecord(parsed) && typeof parsed['name'] === 'string' && Array.isArray(parsed['data'])) {
    return parseThunderFolder(new Map([['environments/tc_env_picked.json', text]]));
  }
  throw new ThunderError(
    'thunder-not-export',
    'This is not a Thunder Client export: it needs a collection or environment exported from Thunder Client.',
  );
}

const LEGACY_REQUESTS = /(^|\/)thunderclient\.json$/i;
const LEGACY_COLLECTIONS = /(^|\/)thundercollection\.json$/i;
const LEGACY_ENVIRONMENTS = /(^|\/)thunderenvironment\.json$/i;
const V3_COLLECTION = /(^|\/)collections\/tc_col_[^/]*\.json$/i;
const V3_ENVIRONMENT = /(^|\/)environments\/tc_env_[^/]*\.json$/i;

/**
 * A `thunder-tests` folder: its `collections/tc_col_*.json` and `environments/tc_env_*.json`
 * files, or the legacy `thunderclient.json`, `thunderCollection.json` and `thunderEnvironment.json`
 * (the requests grouped by `colId` into their collections). `files` is every `*.json` under the
 * folder by root-relative POSIX path, `_db-backup*` folders already left out.
 *
 * @throws ThunderError `thunder-malformed`, `thunder-unsupported-layout` when no file is one of those
 */
export function parseThunderFolder(files: ReadonlyMap<string, string>): {
  collections: TcCollection[];
  environments: TcEnvironment[];
  report: ImportReport;
} {
  const report = new ReportBuilder();
  const collections: TcCollection[] = [];
  const environments: TcEnvironment[] = [];
  const sorted = [...files.keys()].sort();
  const read = (path: string): unknown => parseJson(files.get(path) ?? '', `file ${path}`);

  for (const path of sorted.filter((p) => V3_COLLECTION.test(p))) {
    const raw = read(path);
    if (isRecord(raw)) collections.push(collection(raw, str(raw['colName']), list(raw['requests'])));
    else report.warn(`${path} is not a Thunder Client collection, so it was skipped.`);
  }
  for (const path of sorted.filter((p) => V3_ENVIRONMENT.test(p))) {
    const raw = read(path);
    if (isRecord(raw)) environments.push(environment(raw, str(raw['name']), raw['data']));
    else report.warn(`${path} is not a Thunder Client environment, so it was skipped.`);
  }

  const legacyCollections = sorted.find((p) => LEGACY_COLLECTIONS.test(p));
  const legacyRequests = sorted.find((p) => LEGACY_REQUESTS.test(p));
  if (legacyCollections !== undefined) {
    const requests = legacyRequests !== undefined ? list(read(legacyRequests)) : [];
    for (const raw of list(read(legacyCollections)).filter(isRecord)) {
      const id = str(raw['_id']);
      const own = requests.filter((r) => isRecord(r) && str(r['colId']) === id);
      collections.push(collection(raw, str(raw['colName']), own));
    }
  }
  const legacyEnvironments = sorted.find((p) => LEGACY_ENVIRONMENTS.test(p));
  if (legacyEnvironments !== undefined) {
    for (const raw of list(read(legacyEnvironments)).filter(isRecord)) {
      environments.push(environment(raw, str(raw['name']), raw['data'] ?? raw['variables']));
    }
  }

  if (collections.length === 0 && environments.length === 0) {
    throw new ThunderError(
      'thunder-unsupported-layout',
      'No Thunder Client collection or environment was found in the folder. Folders that keep one file per request are not read yet: export the collection from Thunder Client and import that file.',
    );
  }
  return { collections, environments, report: report.build() };
}
