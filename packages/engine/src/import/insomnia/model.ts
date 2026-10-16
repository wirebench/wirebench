/** What the Insomnia reader hands the mapper: an export as typed shapes, nothing interpreted. */

import type { ImportReport } from '../report.js';

/** The most text one export may hold (spec §7.1). */
export const MAX_INSOMNIA_BYTES = 50 * 1024 * 1024;

export type Rec = Record<string, unknown>;

/** A header, query parameter, path parameter, form field or gRPC metadata entry. */
export interface InsRow {
  name: string;
  value: string;
  disabled: boolean;
  description?: string;
  type?: string;
  fileName?: string;
  multiline?: string | boolean;
}

export interface InsEnv {
  name: string;
  data: Rec;
  /** Insomnia's `dataPropertyOrder`: `{ "&": [keys], "&~|key": [childKeys] }`. */
  order?: Rec;
  color?: string;
  private: boolean;
}

/** Script texts, kept as written. */
export interface InsScripts {
  pre: string;
  post: string;
}

export interface InsSettings {
  followRedirects: 'global' | 'on' | 'off';
  encodeUrl: boolean;
  /** Names of the cookie, render and rebuild-path settings that are not at their default. */
  other: string[];
}

export type InsNode =
  | {
      kind: 'folder';
      id: string;
      name: string;
      children: InsNode[];
      headers: InsRow[];
      auth?: Rec;
      environment?: Rec;
      scripts: InsScripts;
      description?: string;
    }
  | {
      kind: 'http';
      id: string;
      name: string;
      method: string;
      url: string;
      parameters: InsRow[];
      pathParameters: InsRow[];
      headers: InsRow[];
      body: Rec;
      auth?: Rec;
      settings: InsSettings;
      scripts: InsScripts;
      description?: string;
    }
  | {
      kind: 'grpc';
      id: string;
      name: string;
      url: string;
      protoFileId?: string;
      protoMethodName: string;
      message: string;
      metadata: InsRow[];
      reflection: boolean;
    }
  | {
      kind: 'websocket';
      id: string;
      name: string;
      url: string;
      headers: InsRow[];
      parameters: InsRow[];
      auth?: Rec;
      payload?: string;
    }
  | { kind: 'skipped'; name: string; what: string };

export interface InsWorkspace {
  name: string;
  items: InsNode[];
  baseEnv?: InsEnv;
  subEnvs: InsEnv[];
  protos: { id: string; name: string; text: string; dirId?: string }[];
  /** What the file held that is not read: `cookie jar`, `unit tests`, `API spec`. */
  extras: string[];
}

export interface InsDocument {
  kind: 'collection' | 'environment';
  workspaces: InsWorkspace[];
  report: ImportReport;
}
