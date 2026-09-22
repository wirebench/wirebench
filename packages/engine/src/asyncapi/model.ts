/**
 * The version-neutral view of an AsyncAPI document that both normalisers (2.x and 3.0) produce.
 *
 * Directions are Wirebench's side of the conversation: the document describes an application, and
 * Wirebench is its peer, so what the application receives is what Wirebench sends.
 */

export type AsyncApiVersion = '2' | '3';

/** One security scheme a server asks for, as the document states it. */
export interface AsyncApiSecurityScheme {
  /** The name the document files it under (`components.securitySchemes` key). */
  readonly key: string;
  /** `http`, `httpApiKey`, `apiKey`, `userPassword`, `oauth2`, … — as written. */
  readonly type: string;
  readonly description?: string;
  /** `http`: `basic`, `bearer`, …, lower-cased. */
  readonly scheme?: string;
  readonly bearerFormat?: string;
  /** `httpApiKey` / `apiKey`: where the key travels (`query`, `header`, `cookie`, `user`, `password`). */
  readonly in?: string;
  /** `httpApiKey`: the parameter's name. */
  readonly name?: string;
}

export interface AsyncApiServer {
  readonly key: string;
  /** The full URL, variables substituted by `default` (else the first `enum` value). */
  readonly url: string;
  readonly protocol: string;
  readonly security: readonly AsyncApiSecurityScheme[];
  /** Variables left as `{name}` in {@link url}: no default and no enum to take one from. */
  readonly unresolvedVariables: readonly string[];
}

export interface AsyncApiMessage {
  readonly key: string;
  readonly name: string;
  readonly contentType: string;
  readonly schemaFormat?: string;
  readonly payload?: unknown;
  readonly example?: unknown;
}

export interface AsyncApiOperation {
  readonly key: string;
  /** The key of the channel it runs on. */
  readonly channel: string;
  /** Wirebench's side: what the described application receives, Wirebench sends. */
  readonly direction: 'sent' | 'received';
  readonly messages: readonly AsyncApiMessage[];
}

export interface AsyncApiChannelParameter {
  readonly default?: string;
  readonly enum?: readonly string[];
  readonly examples?: readonly string[];
}

export interface AsyncApiChannel {
  readonly key: string;
  readonly address: string | null;
  /** The server keys it is available on, or every server. */
  readonly servers: readonly string[] | 'all';
  readonly parameters: Readonly<Record<string, AsyncApiChannelParameter>>;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
}

/** Something in the document that could not be mapped, and why. Never fatal. */
export interface AsyncApiSkip {
  readonly where: string;
  readonly reason: string;
}

export interface AsyncApiDocument {
  readonly version: AsyncApiVersion;
  readonly declaredVersion: string;
  readonly title: string;
  readonly servers: readonly AsyncApiServer[];
  readonly channels: readonly AsyncApiChannel[];
  readonly operations: readonly AsyncApiOperation[];
  readonly notes: readonly AsyncApiSkip[];
}
