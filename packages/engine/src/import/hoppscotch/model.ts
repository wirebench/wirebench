/**
 * A Hoppscotch export read into its newest shape (spec 2026-10-15 §6.1): every collection, folder
 * and request migrated from whichever version it was written in, values left as written. Nothing
 * here is interpreted; `convert.ts` maps it.
 */

/** The largest export read, the other importers' file limit. */
export const MAX_HOPPSCOTCH_BYTES = 50 * 1024 * 1024;

/** The newest versions this build reads; a newer one is read as these and named in the report. */
export const NEWEST = { collection: 12, rest: 17, graphql: 10, environment: 2 } as const;

export type HopRec = Readonly<Record<string, unknown>>;

export interface HopRow {
  readonly key: string;
  readonly value: string;
  readonly active: boolean;
  readonly description?: string;
}

export interface HopVariable {
  readonly key: string;
  /** `currentValue`, else `initialValue`, else an older file's `value`; empty for a secret. */
  readonly value: string;
  readonly secret: boolean;
}

export interface HopBody {
  readonly contentType: string | null;
  readonly body: unknown;
}

export interface HopResponse {
  readonly name: string;
  readonly code?: number;
  readonly status?: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
  readonly body: string;
}

interface HopRequestBase {
  readonly name: string;
  readonly headers: readonly HopRow[];
  /** `{authType, authActive, …}`, migrated to the newest shape. */
  readonly auth: HopRec;
  readonly pre: string;
  readonly test: string;
  readonly responses: readonly HopResponse[];
  readonly description?: string;
}

export interface HopRestRequest extends HopRequestBase {
  readonly kind: 'rest';
  readonly method: string;
  readonly endpoint: string;
  readonly params: readonly HopRow[];
  readonly body: HopBody;
  readonly requestVariables: readonly HopRow[];
}

export interface HopGraphqlRequest extends HopRequestBase {
  readonly kind: 'graphql';
  readonly url: string;
  readonly query: string;
  /** A JSON object's text, as Hoppscotch keeps it. */
  readonly variables: string;
}

export type HopRequest = HopRestRequest | HopGraphqlRequest;

export interface HopCollection {
  readonly name: string;
  readonly folders: readonly HopCollection[];
  readonly requests: readonly HopRequest[];
  readonly auth: HopRec;
  readonly headers: readonly HopRow[];
  readonly variables: readonly HopVariable[];
  readonly description?: string;
  readonly pre: string;
  readonly test: string;
}

export interface HopEnvironment {
  readonly name: string;
  /** `Global` for the global environment, which merges into Globals. */
  readonly id?: string;
  readonly variables: readonly HopVariable[];
}
