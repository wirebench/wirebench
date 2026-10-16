/**
 * What the Import dialog needs to know about each format it can be pointed at: the dropdown text,
 * which source tabs make sense, the name a new project gets, whether the result lands in the
 * workspace (so no project is asked for) and the filters of the file picker. The IPC call that does
 * the import stays in the dialog; only this data lives here.
 */

import type { ImportFormatKind } from '@wirebench/engine/detect';

/** A source tab. `server` is gRPC reflection; `folder` is a collection saved as a directory. */
export type ImportTab = 'url' | 'file' | 'paste' | 'folder' | 'server';

export interface ImportFileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface ImportFormatRow {
  readonly kind: ImportFormatKind;
  /** The dropdown text. */
  readonly label: string;
  readonly tabs: readonly ImportTab[];
  readonly defaultName: string;
  /** Lands in the workspace, not a project: hides the project picker. */
  readonly workspaceOnly: boolean;
  readonly fileFilters: readonly ImportFileFilter[];
  /**
   * Whether the dialog can import it. An unavailable row is left out of the dropdown, and
   * auto-detecting it says so instead of offering an Import that cannot work.
   */
  readonly available: boolean;
  /** The dialog opens on the File tab: an export, a capture or a request file is a file on disk. */
  readonly startsOnFile: boolean;
}

const URL_FILE_PASTE: readonly ImportTab[] = ['url', 'file', 'paste'];
const FILE_PASTE: readonly ImportTab[] = ['file', 'paste'];
const ALL_FILES: ImportFileFilter = { name: 'All Files', extensions: ['*'] };
const API_DEFINITIONS: readonly ImportFileFilter[] = [
  {
    name: 'API Definitions (*.json, *.yaml, *.yml, *.wsdl, *.xml)',
    extensions: ['json', 'yaml', 'yml', 'wsdl', 'xml'],
  },
  ALL_FILES,
];
const JSON_OR_YAML: readonly ImportFileFilter[] = [
  { name: 'JSON or YAML', extensions: ['json', 'yaml', 'yml'] },
  ALL_FILES,
];

function row(
  kind: ImportFormatKind,
  label: string,
  fields: Partial<Omit<ImportFormatRow, 'kind' | 'label'>>,
): ImportFormatRow {
  return {
    kind,
    label,
    tabs: URL_FILE_PASTE,
    defaultName: 'Imported API',
    workspaceOnly: false,
    fileFilters: API_DEFINITIONS,
    available: true,
    startsOnFile: false,
    ...fields,
  };
}

/** In dropdown order; the client rows and `unknown` follow the formats the dropdown has always had. */
export const IMPORT_FORMATS: readonly ImportFormatRow[] = [
  row('openapi', 'OpenAPI / Swagger', {
    fileFilters: [{ name: 'OpenAPI Specification', extensions: ['json', 'yaml', 'yml'] }, ALL_FILES],
  }),
  row('asyncapi', 'AsyncAPI (WebSocket)', {
    fileFilters: [{ name: 'AsyncAPI Document', extensions: ['json', 'yaml', 'yml'] }, ALL_FILES],
  }),
  row('postman', 'Postman Collection', {
    startsOnFile: true,
    defaultName: 'Imported Collection',
    fileFilters: [{ name: 'Postman Collection', extensions: ['json'] }],
  }),
  row('postman-v3', 'Postman Collection v3 (folder)', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Collection definition (.resources/definition.yaml)', extensions: ['yaml', 'yml'] }],
  }),
  row('postman-environment', 'Postman environment', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
  }),
  row('postman-globals', 'Postman globals', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
  }),
  row('har', 'HAR (recorded traffic)', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported traffic',
    fileFilters: [{ name: 'HAR', extensions: ['har', 'json'] }],
  }),
  row('http-file', '.http file', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported requests',
    fileFilters: [{ name: '.http file', extensions: ['http', 'rest'] }],
  }),
  row('http-env', 'HTTP client environment file', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: [{ name: 'HTTP client environment file', extensions: ['json'] }],
  }),
  row('opencollection', 'OpenCollection', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'OpenCollection', extensions: ['yml', 'yaml'] }],
  }),
  row('wsdl', 'WSDL (SOAP)', { defaultName: 'Imported service' }),
  row('proto', 'Protocol Buffers (gRPC)', {
    tabs: [...URL_FILE_PASTE, 'server'],
    defaultName: 'Imported gRPC API',
    fileFilters: [{ name: 'Protocol Buffers', extensions: ['proto'] }, ALL_FILES],
  }),
  row('legacy-soap-project', 'Legacy SOAP project', {
    startsOnFile: true,
    fileFilters: [{ name: 'Legacy SOAP project', extensions: ['xml'] }, ALL_FILES],
  }),
  // Other API clients: the importers land in later tasks, which flip `available`.
  row('insomnia', 'Insomnia export', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported collection',
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  row('insomnia-environment', 'Insomnia environments', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  row('bruno', 'Bruno collection', {
    startsOnFile: true,
    tabs: ['file', 'paste', 'folder'],
    defaultName: 'Imported collection',
    fileFilters: [],
    available: false,
  }),
  row('hoppscotch', 'Hoppscotch collection', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    defaultName: 'Imported collection',
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  row('hoppscotch-environment', 'Hoppscotch environments', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  row('thunder-client', 'Thunder Client collection', {
    startsOnFile: true,
    tabs: ['file', 'paste', 'folder'],
    defaultName: 'Imported collection',
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  row('thunder-client-environment', 'Thunder Client environment', {
    startsOnFile: true,
    tabs: FILE_PASTE,
    workspaceOnly: true,
    fileFilters: JSON_OR_YAML,
    available: false,
  }),
  // Nothing recognised: treated as a service definition, as the dialog always has.
  row('unknown', 'Unknown', { defaultName: 'Imported service' }),
];

const BY_KIND = new Map(IMPORT_FORMATS.map((item) => [item.kind, item]));

export function importFormatRow(kind: ImportFormatKind): ImportFormatRow {
  const found = BY_KIND.get(kind);
  if (found === undefined) {
    throw new Error(`No import format row for ${kind}`);
  }
  return found;
}

/** The rows the format dropdown offers: the available ones, without the "nothing recognised" row. */
export function dropdownFormats(): readonly ImportFormatRow[] {
  return IMPORT_FORMATS.filter((item) => item.available && item.kind !== 'unknown');
}
