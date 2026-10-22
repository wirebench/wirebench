/**
 * The folder (v3) collection format as the reader hands it to the mapper: a tree of folders and
 * request files per collection, each document still a plain record, nothing interpreted beyond the
 * layout. See `docs/specs/2026-10-11-collection-v3-import-design.md`.
 */

import type { ImportReport } from '#core/import/report';

/** A YAML document read from the folder: its root-relative POSIX path and its top-level record. */
export interface V3File {
  readonly path: string;
  readonly doc: Readonly<Record<string, unknown>>;
}

/** One script of a definition or request, its source read from `code` or from the file it names. */
export interface V3Script {
  readonly type: string;
  readonly code: string;
}

export interface V3Request {
  readonly type: 'request';
  /** The request's `name`, else its file name without `.request.yaml`. */
  readonly name: string;
  readonly path: string;
  readonly order: number | undefined;
  /** `$kind`, such as `http-request`. */
  readonly kind: string;
  readonly doc: Readonly<Record<string, unknown>>;
  readonly scripts: readonly V3Script[];
  /** The `*.example.yaml` documents under the request's examples folder, by `order`. */
  readonly examples: readonly V3File[];
  /** The `*.message.yaml` documents under the request's messages folder, by `order`. */
  readonly messages: readonly V3File[];
}

export interface V3Folder {
  readonly type: 'folder';
  /** The definition's `name`, else the folder's own name. */
  readonly name: string;
  /** The folder's root-relative path, without a trailing `/`; empty for a collection read from the root. */
  readonly path: string;
  readonly order: number | undefined;
  /** `.resources/definition.yaml`, when there is one. */
  readonly definition?: Readonly<Record<string, unknown>>;
  readonly scripts: readonly V3Script[];
  /** Folders and requests together, by `order`, then by name. */
  readonly children: readonly (V3Folder | V3Request)[];
}

/** A collection is its root folder. */
export type V3Collection = V3Folder;

export interface V3Workspace {
  readonly collections: readonly V3Collection[];
  /** `environments/*.yaml` of a workspace folder. */
  readonly environments: readonly V3File[];
  /** `globals/*.yaml` of a workspace folder. */
  readonly globals: readonly V3File[];
  /** Files that could not be read, request kinds left as written, refused paths. */
  readonly report: ImportReport;
}

/** The request kinds Wirebench maps. */
export const MAPPED_V3_KINDS = new Set(['http-request', 'grpc-request', 'websocket-request']);

/** The request kinds the format documents that Wirebench has no equivalent for, with a label for the report. */
export const UNMAPPED_V3_KINDS: Readonly<Record<string, string>> = {
  'graphql-request': 'GraphQL',
  'socket.io-request': 'Socket.IO',
  'mqtt-request': 'MQTT',
  'mcp-request': 'MCP',
  'llm-request': 'LLM',
};

/** Every `$kind` a file of the format may carry: documents a detector can recognise on their own. */
export const V3_DOCUMENT_KINDS = new Set([
  'collection',
  ...MAPPED_V3_KINDS,
  ...Object.keys(UNMAPPED_V3_KINDS),
  'http-example',
  'websocket-message',
]);

/** Deeper nesting than any real collection; a deeper file is skipped and reported. */
export const MAX_V3_DEPTH = 64;
