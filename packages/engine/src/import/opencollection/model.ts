/** What the OpenCollection reader hands the mapper: the documents as typed shapes, nothing interpreted. */

export interface OcInfo {
  readonly name: string;
  readonly type?: string;
  readonly seq?: number;
  readonly description?: unknown;
}
export interface OcKeyValue {
  readonly name: string;
  readonly value?: unknown;
  readonly disabled?: boolean;
  readonly type?: string;
}
export interface OcVariable {
  readonly name: string;
  readonly value?: unknown;
  readonly secret?: boolean;
  readonly disabled?: boolean;
}
export interface OcScript {
  readonly type: string;
  readonly code: string;
}
export interface OcAssertion {
  readonly expression: string;
  readonly operator: string;
  readonly value?: string;
  readonly disabled?: boolean;
}
export interface OcRequestDefaults {
  readonly headers?: readonly OcKeyValue[];
  readonly auth?: unknown;
  readonly variables?: readonly OcVariable[];
  readonly scripts?: readonly OcScript[];
}
export interface OcItem {
  readonly info: OcInfo;
  /** Where the item came from: `items[0].items[1]` in a single document, the root-relative file path in a directory. */
  readonly path: string;
  /** A folder's children and defaults. */
  readonly items?: readonly OcItem[];
  readonly request?: OcRequestDefaults;
  readonly http?: Readonly<Record<string, unknown>>;
  readonly graphql?: Readonly<Record<string, unknown>>;
  readonly grpc?: Readonly<Record<string, unknown>>;
  readonly websocket?: Readonly<Record<string, unknown>>;
  readonly runtime?: {
    readonly variables?: readonly OcVariable[];
    readonly scripts?: readonly OcScript[];
    readonly assertions?: readonly OcAssertion[];
  };
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly examples?: readonly unknown[];
  /** A ScriptFile item's source. */
  readonly script?: string;
}
export interface OcEnvironment {
  readonly name: string;
  readonly variables: readonly OcVariable[];
  /** Environment features this build does not read: `extends`, `externalSecrets`, `dotEnvFilePath`, `clientCertificates`. */
  readonly extras: readonly string[];
}
export interface OcCollection {
  readonly version: string;
  readonly info: OcInfo;
  readonly items: readonly OcItem[];
  readonly request?: OcRequestDefaults;
  readonly environments: readonly OcEnvironment[];
  /** `proxy` and `clientCertificates` when present, plus `unreadable:<path>` for each directory file that did not parse. */
  readonly configExtras: readonly string[];
}
