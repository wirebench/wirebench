/**
 * A Thunder Client export or workspace folder read into one shape (spec 2026-10-15 §7.1): its
 * collections with their flat folders and requests, and its environments. Values are left as
 * written; `convert.ts` maps them.
 */

/** The largest export or folder read, the other importers' limit. */
export const MAX_THUNDER_BYTES = 50 * 1024 * 1024;

export type TcRec = Readonly<Record<string, unknown>>;

export interface TcRow {
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
}

export interface TcParam extends TcRow {
  /** A `{name}` path variable rather than a query parameter. */
  readonly isPath: boolean;
}

/** One declarative test row: `{type, custom, action, value}`, all text. */
export interface TcTest {
  readonly type: string;
  readonly custom: string;
  readonly action: string;
  readonly value: string;
}

export interface TcFolder {
  readonly id: string;
  readonly name: string;
  /** The parent folder's id, or `''` for the collection's root. */
  readonly parentId: string;
  readonly sortNum: number | null;
  readonly settings: TcRec;
}

export interface TcRequest {
  readonly id: string;
  readonly name: string;
  /** The folder's id, or `''` for the collection's root. */
  readonly folderId: string;
  readonly method: string;
  readonly url: string;
  readonly reqType?: string;
  readonly params: readonly TcParam[];
  readonly headers: readonly TcRow[];
  readonly body?: TcRec;
  readonly auth?: TcRec;
  readonly tests: readonly TcTest[];
  readonly preReq?: TcRec;
  readonly postReq?: TcRec;
  readonly docs?: string;
  readonly sortNum: number | null;
}

export interface TcCollection {
  readonly id: string;
  readonly name: string;
  readonly settings: TcRec;
  readonly folders: readonly TcFolder[];
  readonly requests: readonly TcRequest[];
}

export interface TcVariable {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
  /** An Enterprise value that cannot be read without its key: treated as missing. */
  readonly encrypted: boolean;
}

export interface TcEnvironment {
  readonly name: string;
  readonly global: boolean;
  readonly variables: readonly TcVariable[];
  /** The `.env` file the environment is linked to, which is never read. */
  readonly envFile?: string;
  /** `default` and `local` when set: noted, never mapped. */
  readonly flags: readonly string[];
}

export interface TcExport {
  readonly collections: readonly TcCollection[];
  readonly environments: readonly TcEnvironment[];
}
