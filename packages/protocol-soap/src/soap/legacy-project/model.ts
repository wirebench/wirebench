/**
 * A legacy single-XML SOAP project file as the import reads it: only what v1 maps, plus enough about
 * everything else to say in the import report what was left behind.
 */

/** A name/value pair from a `properties` list or an environment. */
export interface LegacyProperty {
  readonly name: string;
  readonly value: string;
}

/** One document of an interface's cached definition, keyed by the URL it was fetched from. */
export interface LegacyDefinitionPart {
  readonly url: string;
  readonly content: string;
}

/** The definition an interface carried, so it can be resolved without the network. */
export interface LegacyDefinitionCache {
  /** The URL of the root WSDL among {@link parts}, when the file names one. */
  readonly rootPart?: string;
  readonly parts: readonly LegacyDefinitionPart[];
}

/** The credentials of a saved request. The password itself is never kept. */
export interface LegacyCredentials {
  readonly username?: string;
  readonly domain?: string;
  /** True when the file had a non-empty password, so the report can ask for it to be re-entered. */
  readonly hadPassword: boolean;
  readonly authType?: string;
}

/** A saved request (`call`) under an operation. */
export interface LegacyCall {
  readonly name: string;
  readonly endpoint?: string;
  /** The envelope as text, decompressed when it was stored compressed. Absent when it could not be read. */
  readonly envelope?: string;
  /** Why {@link envelope} is absent. */
  readonly envelopeProblem?: string;
  readonly encoding?: string;
  readonly timeoutMs?: number;
  readonly credentials: LegacyCredentials;
  readonly useWsAddressing: boolean;
  readonly assertions: number;
  readonly attachments: number;
  /** Names of the outgoing and incoming WS-Security configurations the request referenced. */
  readonly wssRefs: readonly string[];
}

/** A binding operation and its saved requests. */
export interface LegacyOperation {
  readonly name: string;
  /** The operation's name in the binding; falls back to {@link name}. */
  readonly bindingOperationName: string;
  readonly action?: string;
  readonly calls: readonly LegacyCall[];
}

/** A SOAP interface (one WSDL binding). */
export interface LegacyInterface {
  readonly name: string;
  readonly definitionUrl?: string;
  /** The binding as `{namespace}localName`. */
  readonly bindingName?: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly cache?: LegacyDefinitionCache;
  readonly endpoints: readonly string[];
  readonly operations: readonly LegacyOperation[];
}

/** A named set of property values and per-interface endpoint overrides. */
export interface LegacyEnvironment {
  readonly name: string;
  readonly properties: readonly LegacyProperty[];
  /** The endpoint URL this environment sends each named interface to. */
  readonly endpoints: readonly { readonly interfaceName: string; readonly url: string }[];
}

/** A script found anywhere in the file, never run. */
export interface LegacyScript {
  /** Names of the owning items from the project down, e.g. `['Smoke', 'Echo once']`. Empty at project level. */
  readonly ownerPath: readonly string[];
  /** The element that held it, e.g. `afterLoadScript`, or `script` for a script test step. */
  readonly element: string;
  readonly language?: string;
  readonly source: string;
}

/** Something in the file that holds user work v1 does not map. */
export interface LegacyUnmapped {
  readonly ownerPath: readonly string[];
  readonly message: string;
}

/** The whole file as read. */
export interface LegacyProject {
  readonly name: string;
  readonly description?: string;
  readonly properties: readonly LegacyProperty[];
  readonly interfaces: readonly LegacyInterface[];
  readonly environments: readonly LegacyEnvironment[];
  readonly scripts: readonly LegacyScript[];
  readonly unmapped: readonly LegacyUnmapped[];
}
