/**
 * Typed shapes of an Insomnia export (v4 JSON or YAML, v5 YAML), as the reader hands them to the
 * converter: one tree per workspace, siblings in Insomnia's own order.
 */

import type { ImportReport } from '../report.js';

/** Insomnia's file size limit, the Postman one. */
export const MAX_INSOMNIA_BYTES = 50 * 1024 * 1024;

export type InsRec = Readonly<Record<string, unknown>>;

/** A header, query parameter, path parameter, metadata entry or body part. */
export interface InsRow {
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly description?: string;
  /** `text` or `file` on a body part. */
  readonly type?: string;
  /** A file part's absolute local path; the file itself is never exported. */
  readonly fileName?: string;
  /** A string is the part's content type; `true` only marks the editor as multiline. */
  readonly multiline?: string | boolean;
}

export interface InsScripts {
  readonly pre: string;
  readonly post: string;
}

/** Settings off their default that the converter can only note, by name. */
export type InsOtherSetting = 'send-cookies-off' | 'store-cookies-off' | 'render-off' | 'rebuild-path-off';

export interface InsSettings {
  readonly followRedirects: 'global' | 'on' | 'off';
  readonly encodeUrl: boolean;
  readonly other: readonly InsOtherSetting[];
}

export interface InsBody {
  readonly mimeType?: string;
  readonly text?: string;
  /** A binary body's absolute local path. */
  readonly fileName?: string;
  readonly params?: readonly InsRow[];
}

export interface InsFolder {
  readonly kind: 'folder';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly children: readonly InsNode[];
  readonly headers: readonly InsRow[];
  /** Absent means inherit: no auth, an empty `{}` or a disabled one. */
  readonly auth?: InsRec;
  readonly environment?: InsRec;
  readonly environmentOrder?: InsRec;
  readonly scripts: InsScripts;
}

export interface InsHttp {
  readonly kind: 'http';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly method: string;
  readonly url: string;
  readonly parameters: readonly InsRow[];
  readonly pathParameters: readonly InsRow[];
  readonly headers: readonly InsRow[];
  readonly body: InsBody;
  /** Absent means inherit; `{ type: 'none' }` stops inheritance. */
  readonly auth?: InsRec;
  readonly settings: InsSettings;
  readonly scripts: InsScripts;
}

export interface InsGrpc {
  readonly kind: 'grpc';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly protoFileId?: string;
  /** `/package.Service/Method`. */
  readonly protoMethodName: string;
  readonly message: string;
  readonly metadata: readonly InsRow[];
  readonly reflection: boolean;
}

export interface InsWebSocket {
  readonly kind: 'websocket';
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly url: string;
  readonly headers: readonly InsRow[];
  readonly parameters: readonly InsRow[];
  readonly auth?: InsRec;
  /** v4 only: v5 does not export payloads. */
  readonly payload?: { readonly text: string; readonly mode?: string };
}

/** An item Wirebench has no request kind for, kept only to be named in the report. */
export interface InsSkipped {
  readonly kind: 'skipped';
  readonly id: string;
  readonly name: string;
  /** What it is, as the report names it: `Socket.IO request`, `MCP request`. */
  readonly what: string;
}

export type InsNode = InsFolder | InsHttp | InsGrpc | InsWebSocket | InsSkipped;

export interface InsEnv {
  readonly name: string;
  /** The variables, with the vault taken out. */
  readonly data: InsRec;
  readonly order?: InsRec;
  readonly color?: string;
  readonly private: boolean;
  /** Vault secret names: their values are sealed or masked and cannot be read. */
  readonly vault: readonly string[];
}

/** A v4 `proto_file`: v5 does not export proto text. */
export interface InsProto {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly dirId?: string;
}

export interface InsProtoDir {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
}

export interface InsTestSuite {
  readonly name: string;
  readonly tests: readonly { readonly name: string; readonly requestId?: string }[];
}

export interface InsWorkspace {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** v4 `scope`: `collection`, `design`, `environment`, …; absent in v5 and very old files. */
  readonly scope?: string;
  readonly items: readonly InsNode[];
  readonly baseEnv?: InsEnv;
  readonly subEnvs: readonly InsEnv[];
  readonly protos: readonly InsProto[];
  readonly protoDirs: readonly InsProtoDir[];
  readonly testSuites: readonly InsTestSuite[];
  /** Cookies in the workspace's jar. */
  readonly cookies: number;
  /** Whether the workspace holds an API spec. */
  readonly spec: boolean;
  /** Other resource kinds found, by name, for the report. */
  readonly extras: readonly string[];
}

export interface InsDocument {
  readonly format: 4 | 5;
  /** `environment` for a global environment file: its base merges into Globals. */
  readonly kind: 'collection' | 'environment';
  readonly workspaces: readonly InsWorkspace[];
  readonly report: ImportReport;
}
