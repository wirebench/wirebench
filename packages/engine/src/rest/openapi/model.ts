/**
 * The subset of OpenAPI 3.0.x and 3.1.x this client consumes, as readonly types.
 *
 * Deliberately a *subset*: an import turns a description into requests you can send, so the model
 * carries what decides a request — where it goes, what it carries, and what it authenticates with —
 * and nothing else. Everything else a document says (callbacks, links, webhooks, vendor extensions)
 * is kept only as a count, so the import summary can say what it did not understand rather than
 * quietly dropping it.
 *
 * Every field is optional where the specification allows it, because a document in the wild will
 * omit anything that is not required, and a parser that insists otherwise refuses documents users
 * legitimately have.
 */

/** A JSON value, as a document literally contains it (an `example`, a `default`, an `enum` member). */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Which specification version a document declares. */
export type OpenApiVersion = '2.0' | '3.0' | '3.1' | '3.2';

/** `info`: what the API is called, and which version of *it* this document describes. */
export interface OpenApiInfo {
  readonly title: string;
  readonly version?: string;
  readonly description?: string;
}

/** One `servers` entry, with the variables its template names. */
export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Readonly<Record<string, OpenApiServerVariable>>;
}

/**
 * One server-template variable: its default, and the values it is allowed to take.
 *
 * `default` is required by the specification but routinely omitted in the wild, and a variable with
 * none has nothing to substitute — so it is optional here, and {@link serverUrl} leaves the template
 * in place for it rather than collapsing the URL to `https://.api.test`.
 */
export interface OpenApiServerVariable {
  readonly default?: string;
  readonly enum?: readonly string[];
  readonly description?: string;
}

/** Where a parameter travels. `cookie` is modelled so the import can say it skipped one. */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** One parameter, after `$ref` resolution. */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required?: boolean;
  readonly deprecated?: boolean;
  readonly description?: string;
  readonly schema?: JsonSchema;
  readonly example?: JsonValue;
  readonly examples?: Readonly<Record<string, OpenApiExample>>;
  /** How an array or object parameter is serialised; carried so the import can note what it ignored. */
  readonly style?: string;
  readonly explode?: boolean;
}

/** One named example, either inline or (unsupported here) external. */
export interface OpenApiExample {
  readonly value?: JsonValue;
  readonly summary?: string;
  readonly externalValue?: string;
  /** OpenAPI 3.2: structured data value, distinct from raw/serialized format. */
  readonly dataValue?: JsonValue;
  /** OpenAPI 3.2: serialized string representation of the example. */
  readonly serializedValue?: string;
}

/** One media type of a request or response body. */
export interface OpenApiMediaType {
  readonly schema?: JsonSchema;
  /** OpenAPI 3.2: item schema for sequential/streaming media types (e.g. text/event-stream). */
  readonly itemSchema?: JsonSchema;
  readonly example?: JsonValue;
  readonly examples?: Readonly<Record<string, OpenApiExample>>;
}

/** A request body: its media types, and whether the operation insists on one. */
export interface OpenApiRequestBody {
  readonly required?: boolean;
  readonly description?: string;
  readonly content: Readonly<Record<string, OpenApiMediaType>>;
}

/**
 * The JSON Schema subset the sample generator reads — Draft 2020-12 as 3.1 uses it, and 3.0's own
 * dialect, which differs in the two ways noted on the fields.
 */
export interface JsonSchema {
  /** 3.0 allows one type; 3.1 allows a list, which is how it spells "nullable". */
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonValue;
  readonly example?: JsonValue;
  /** 3.1 spelling; 3.0 uses `example`. Both are read. */
  readonly examples?: readonly JsonValue[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  /** 3.0 only: 3.1 spells this as a `type` list including `'null'`. */
  readonly nullable?: boolean;
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  /** The `xml` object an XML body's shape honours. */
  readonly xml?: OpenApiXml;
  /** Left in place when a reference could not be resolved, so a sample can say so rather than guess. */
  readonly $ref?: string;
}

/** The `xml` object: how a schema's value is spelled as XML. */
export interface OpenApiXml {
  readonly name?: string;
  readonly namespace?: string;
  readonly prefix?: string;
  readonly attribute?: boolean;
  readonly wrapped?: boolean;
}

/** One operation of one path. */
export interface OpenApiOperation {
  /** Lower-case HTTP method, as the document's key spells it. */
  readonly method: string;
  /** The templated path, exactly as the document writes it, `{braces}` and all. */
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  /** Path-level and operation-level parameters merged, the operation's winning on name and location. */
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  /** An operation's own security requirements; an empty array means "explicitly unauthenticated". */
  readonly security?: readonly OpenApiSecurityRequirement[];
}

/** One security requirement: scheme name to the scopes it needs. */
export type OpenApiSecurityRequirement = Readonly<Record<string, readonly string[]>>;

/** One `securitySchemes` entry. */
export interface OpenApiSecurityScheme {
  /** The name the document files it under, which is what a requirement refers to. */
  readonly name: string;
  readonly type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  readonly description?: string;
  /** `http`: the scheme, lower-cased — `basic`, `bearer`, anything else. */
  readonly scheme?: string;
  readonly bearerFormat?: string;
  /** `apiKey`: the parameter's name and where it travels. */
  readonly in?: ParameterLocation;
  readonly keyName?: string;
  /** `oauth2`: the flows the document offers, by name. */
  readonly flows?: Readonly<Record<string, OpenApiOAuthFlow>>;
}

/** One OAuth2 flow. */
export interface OpenApiOAuthFlow {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly refreshUrl?: string;
  readonly scopes?: Readonly<Record<string, string>>;
}

/** One `tags` entry, for a folder's description. */
export interface OpenApiTag {
  readonly name: string;
  readonly description?: string;
}

/** What a parser could not use, so the summary can report it rather than the import losing it silently. */
export interface OpenApiSkipped {
  /** What kind of thing was skipped — `operation`, `parameter`, `callback`, `webhook`, `extension`… */
  readonly kind: string;
  /** Where it was, as a JSON pointer or a `METHOD /path` — enough for the user to find it. */
  readonly where: string;
  readonly reason: string;
}

/** The document, as this client understands it. */
export interface OpenApiDocument {
  readonly version: OpenApiVersion;
  /** The exact `openapi` string the document declared, for the definition card. */
  readonly declaredVersion: string;
  readonly info: OpenApiInfo;
  readonly servers: readonly OpenApiServer[];
  /** Every operation of every path, in document order. */
  readonly operations: readonly OpenApiOperation[];
  readonly securitySchemes: readonly OpenApiSecurityScheme[];
  /** The document-level security requirements, when it declares any. */
  readonly security?: readonly OpenApiSecurityRequirement[];
  readonly tags: readonly OpenApiTag[];
  /** Everything the model does not carry, counted and located. */
  readonly skipped: readonly OpenApiSkipped[];
}

/** The HTTP methods an operation key may name, per OpenAPI's Path Item Object. */
export const HTTP_METHODS: readonly string[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
  'query',
];

/**
 * The base URL a server entry resolves to, with each `{variable}` replaced by its default.
 *
 * A variable with no default is left as it is: the API's base URL then still shows the template,
 * which is honest — the user has to decide what it should be, and the field is editable.
 */
export function serverUrl(server: OpenApiServer): string {
  return server.url.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const fallback = server.variables?.[name]?.default;
    return fallback === undefined || fallback === '' ? whole : fallback;
  });
}
