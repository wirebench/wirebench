/**
 * The Import dialog's formats as one table: what each is called, which source tabs it offers, what
 * a new project is named, whether it lands in the workspace rather than a project, and how its file
 * is picked. The dialog reads its choices from here instead of per-format conditions; which IPC
 * call imports a format stays in the dialog.
 */

import type { ImportFormatKind } from '@wirebench/engine/detect';
import type { KindId } from '@shared/kinds/kind-module.js';

export type ImportFormatTab = 'url' | 'file' | 'paste';

export interface ImportFileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface ImportFormatRow {
  readonly kind: ImportFormatKind;
  /** The format picker's text for it. */
  readonly label: string;
  readonly tabs: readonly ImportFormatTab[];
  /** Starts on the File tab: an export, a capture or a request file is a file on disk. */
  readonly fileFirst: boolean;
  /** Offers Folder… beside Browse…, for a format kept as a folder. */
  readonly folder: boolean;
  /** What a new project is named when the source names nothing. */
  readonly defaultName: string;
  /** Lands in the workspace (environments, Globals), so the dialog asks for no project. */
  readonly workspaceOnly: boolean;
  readonly fileFilters: readonly ImportFileFilter[];
  /** The title of the Browse… file picker. */
  readonly pickerTitle: string;
  /** The dialog's title while the format is picked by hand. */
  readonly dialogTitle: string;
  /**
   * The protocol kind the import lands in; a workspace with that kind off is not offered the format
   * (phase 4 spec §4.4). Absent for a format that lands in the workspace (environments, Globals).
   */
  readonly protocol?: KindId;
}

const ALL_TABS: readonly ImportFormatTab[] = ['url', 'file', 'paste'];
/** Nothing to fetch from a URL: a file on disk or its pasted text. */
const NO_URL_TABS: readonly ImportFormatTab[] = ['file', 'paste'];
const ALL_FILES: ImportFileFilter = { name: 'All Files', extensions: ['*'] };
const DEFINITIONS: readonly ImportFileFilter[] = [
  {
    name: 'API Definitions (*.json, *.yaml, *.yml, *.wsdl, *.xml)',
    extensions: ['json', 'yaml', 'yml', 'wsdl', 'xml'],
  },
  ALL_FILES,
];

type RowDefaults = 'tabs' | 'fileFirst' | 'folder' | 'defaultName' | 'workspaceOnly';
type RowInput = Omit<ImportFormatRow, RowDefaults> & Partial<Pick<ImportFormatRow, RowDefaults>>;

function row(input: RowInput): ImportFormatRow {
  return {
    tabs: ALL_TABS,
    fileFirst: false,
    folder: false,
    defaultName: 'Imported API',
    workspaceOnly: false,
    ...input,
  };
}

/** A workspace-only format read from a file or pasted text. */
function variablesRow(input: Omit<RowInput, RowDefaults>): ImportFormatRow {
  return row({ ...input, tabs: NO_URL_TABS, fileFirst: true, workspaceOnly: true });
}

/** Every format the picker offers, in its order. */
export const IMPORT_FORMATS: readonly ImportFormatRow[] = [
  row({
    kind: 'openapi',
    protocol: 'rest',
    label: 'OpenAPI / Swagger',
    fileFilters: [{ name: 'OpenAPI Specification', extensions: ['json', 'yaml', 'yml'] }, ALL_FILES],
    pickerTitle: 'Import OpenAPI Specification',
    dialogTitle: 'Import OpenAPI',
  }),
  row({
    kind: 'asyncapi',
    protocol: 'websocket',
    label: 'AsyncAPI (WebSocket)',
    fileFilters: [{ name: 'AsyncAPI Document', extensions: ['json', 'yaml', 'yml'] }, ALL_FILES],
    pickerTitle: 'Import AsyncAPI Document',
    dialogTitle: 'Import AsyncAPI',
  }),
  row({
    kind: 'postman',
    protocol: 'rest',
    label: 'Postman Collection',
    fileFirst: true,
    defaultName: 'Imported Collection',
    fileFilters: [{ name: 'Postman Collection', extensions: ['json'] }],
    pickerTitle: 'Import Postman Collection',
    dialogTitle: 'Import Postman Collection',
  }),
  row({
    kind: 'postman-v3',
    protocol: 'rest',
    label: 'Postman Collection v3 (folder)',
    tabs: NO_URL_TABS,
    fileFirst: true,
    folder: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Collection definition (.resources/definition.yaml)', extensions: ['yaml', 'yml'] }],
    pickerTitle: 'Import Collection Definition',
    dialogTitle: 'Import Postman Collection v3',
  }),
  variablesRow({
    kind: 'postman-environment',
    label: 'Postman environment',
    fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
    pickerTitle: 'Import Postman Environment',
    dialogTitle: 'Import Postman Environment',
  }),
  variablesRow({
    kind: 'postman-globals',
    label: 'Postman globals',
    fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
    pickerTitle: 'Import Postman Globals',
    dialogTitle: 'Import Postman Globals',
  }),
  row({
    kind: 'har',
    protocol: 'rest',
    label: 'HAR (recorded traffic)',
    tabs: NO_URL_TABS,
    fileFirst: true,
    defaultName: 'Imported traffic',
    fileFilters: [{ name: 'HAR', extensions: ['har', 'json'] }],
    pickerTitle: 'Import HAR',
    dialogTitle: 'Import HAR',
  }),
  row({
    kind: 'http-file',
    protocol: 'rest',
    label: '.http file',
    tabs: NO_URL_TABS,
    fileFirst: true,
    defaultName: 'Imported requests',
    fileFilters: [{ name: '.http file', extensions: ['http', 'rest'] }],
    pickerTitle: 'Import .http File',
    dialogTitle: 'Import .http File',
  }),
  variablesRow({
    kind: 'http-env',
    label: 'HTTP client environment file',
    fileFilters: [{ name: 'HTTP client environment file', extensions: ['json'] }],
    pickerTitle: 'Import HTTP Client Environments',
    dialogTitle: 'Import HTTP Client Environments',
  }),
  row({
    kind: 'opencollection',
    protocol: 'rest',
    label: 'OpenCollection',
    tabs: NO_URL_TABS,
    fileFirst: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'OpenCollection', extensions: ['yml', 'yaml'] }],
    pickerTitle: 'Import OpenCollection',
    dialogTitle: 'Import OpenCollection',
  }),
  row({
    kind: 'insomnia',
    protocol: 'rest',
    label: 'Insomnia export',
    tabs: NO_URL_TABS,
    fileFirst: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Insomnia export', extensions: ['json', 'yaml', 'yml'] }],
    pickerTitle: 'Import Insomnia Export',
    dialogTitle: 'Import Insomnia Export',
  }),
  variablesRow({
    kind: 'insomnia-environment',
    label: 'Insomnia environments',
    fileFilters: [{ name: 'Insomnia environments', extensions: ['yaml', 'yml', 'json'] }],
    pickerTitle: 'Import Insomnia Environments',
    dialogTitle: 'Import Insomnia Environments',
  }),
  row({
    kind: 'hoppscotch',
    protocol: 'rest',
    label: 'Hoppscotch collection',
    tabs: NO_URL_TABS,
    fileFirst: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Hoppscotch export', extensions: ['json'] }],
    pickerTitle: 'Import Hoppscotch Collection',
    dialogTitle: 'Import Hoppscotch Collection',
  }),
  variablesRow({
    kind: 'hoppscotch-environment',
    label: 'Hoppscotch environments',
    fileFilters: [{ name: 'Hoppscotch environments', extensions: ['json'] }],
    pickerTitle: 'Import Hoppscotch Environments',
    dialogTitle: 'Import Hoppscotch Environments',
  }),
  row({
    kind: 'bruno',
    protocol: 'rest',
    label: 'Bruno collection (folder)',
    tabs: NO_URL_TABS,
    fileFirst: true,
    folder: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Bruno collection (bruno.json) or export', extensions: ['json'] }],
    pickerTitle: 'Import Bruno Collection',
    dialogTitle: 'Import Bruno Collection',
  }),
  row({
    kind: 'thunder-client',
    protocol: 'rest',
    label: 'Thunder Client collection',
    tabs: NO_URL_TABS,
    fileFirst: true,
    folder: true,
    defaultName: 'Imported collection',
    fileFilters: [{ name: 'Thunder Client export', extensions: ['json'] }],
    pickerTitle: 'Import Thunder Client Collection',
    dialogTitle: 'Import Thunder Client Collection',
  }),
  variablesRow({
    kind: 'thunder-client-environment',
    label: 'Thunder Client environment',
    fileFilters: [{ name: 'Thunder Client environment', extensions: ['json'] }],
    pickerTitle: 'Import Thunder Client Environment',
    dialogTitle: 'Import Thunder Client Environment',
  }),
  row({
    kind: 'wsdl',
    protocol: 'soap',
    label: 'WSDL (SOAP)',
    defaultName: 'Imported service',
    fileFilters: DEFINITIONS,
    pickerTitle: 'Import Definition',
    dialogTitle: 'Import WSDL',
  }),
  row({
    kind: 'proto',
    protocol: 'grpc',
    label: 'Protocol Buffers (gRPC)',
    defaultName: 'Imported gRPC API',
    fileFilters: [{ name: 'Protocol Buffers', extensions: ['proto'] }, ALL_FILES],
    pickerTitle: 'Import .proto',
    dialogTitle: 'Import .proto',
  }),
  row({
    kind: 'legacy-soap-project',
    protocol: 'soap',
    label: 'Legacy SOAP project',
    fileFirst: true,
    fileFilters: [{ name: 'Legacy SOAP project', extensions: ['xml'] }, ALL_FILES],
    pickerTitle: 'Import Legacy SOAP Project',
    dialogTitle: 'Import Legacy SOAP Project',
  }),
];

/** What nothing has been recognised as yet: any definition, named as a service. */
const UNKNOWN_ROW = row({
  kind: 'unknown',
  label: 'Unknown',
  defaultName: 'Imported service',
  fileFilters: DEFINITIONS,
  pickerTitle: 'Import Definition',
  dialogTitle: 'Import API or Service',
});

const BY_KIND = new Map(IMPORT_FORMATS.map((format) => [format.kind, format]));

/** The row for `kind`; a kind the picker does not offer is read as one nothing recognised. */
export function importFormatRow(kind: ImportFormatKind): ImportFormatRow {
  return BY_KIND.get(kind) ?? UNKNOWN_ROW;
}

/** The formats a workspace with `enabledKinds` on is offered: every one whose protocol is on, or that has none. */
export function offeredImportFormats(enabledKinds: readonly KindId[]): readonly ImportFormatRow[] {
  return IMPORT_FORMATS.filter((row) => row.protocol === undefined || enabledKinds.includes(row.protocol));
}
