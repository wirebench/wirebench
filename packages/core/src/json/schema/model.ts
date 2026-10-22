/**
 * A JSON value and the JSON Schema subset the engine reads.
 *
 * In `json/schema/` because an OpenAPI description, an AsyncAPI description and a script's generated
 * types all read the same schemas, and no protocol folder imports another (protocol modules spec
 * §7.2). `rest/openapi/model.ts` re-exports the four names.
 */

/** A JSON value, as a document literally contains it (an `example`, a `default`, an `enum` member). */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

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
  /** Names the property whose value says which `oneOf`/`anyOf` branch an object is. */
  readonly discriminator?: OpenApiDiscriminator;
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

/** The `discriminator` object. `mapping` values are references, kept as the document spells them. */
export interface OpenApiDiscriminator {
  readonly propertyName: string;
  readonly mapping?: Readonly<Record<string, string>>;
}

/** The `xml` object: how a schema's value is spelled as XML. */
export interface OpenApiXml {
  readonly name?: string;
  readonly namespace?: string;
  readonly prefix?: string;
  readonly attribute?: boolean;
  readonly wrapped?: boolean;
}
