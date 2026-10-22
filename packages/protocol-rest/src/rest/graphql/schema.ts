/**
 * A REST API's GraphQL schema (#77): fetched by introspection or imported from a file, and kept in
 * the project as SDL at `apis/<slug>/graphql/schema.graphql`, committed and diffable like a cached
 * OpenAPI definition. The API's `graphqlSchema` field says where it came from.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildClientSchema, buildSchema, getIntrospectionQuery, printSchema, validateSchema } from 'graphql';
import type { GraphQLSchema, IntrospectionQuery } from 'graphql';
import { WirebenchError } from '#core/errors';
import { APIS_DIR, assertPathSegment } from '#core/project/paths';

/** The directory under an API's own that holds its GraphQL schema. */
export const GRAPHQL_DIR = 'graphql';

/** The schema's file name inside {@link GRAPHQL_DIR}. */
export const GRAPHQL_SCHEMA_FILE = 'schema.graphql';

/** The introspection query *Fetch schema* sends, with descriptions and deprecated input values. */
export const INTROSPECTION_QUERY: string = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });

/** The schema file's path relative to the project root. */
export function graphqlSchemaPath(apiSlug: string): string {
  assertPathSegment(apiSlug);
  return `${APIS_DIR}/${apiSlug}/${GRAPHQL_DIR}/${GRAPHQL_SCHEMA_FILE}`;
}

function invalid(message: string, reason?: string): WirebenchError {
  return new WirebenchError('graphql-schema-invalid', message, reason === undefined ? {} : { details: { reason } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first `errors[].message` of a GraphQL response, for a refusal that names what the server said. */
function firstErrorMessage(document: Record<string, unknown>): string | undefined {
  const errors = document['errors'];
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const first: unknown = errors[0];
  return isRecord(first) && typeof first['message'] === 'string' ? first['message'] : 'an error';
}

/** A built schema refused when it does not validate, with its first problem as the reason. */
function checked(schema: GraphQLSchema): GraphQLSchema {
  const problems = validateSchema(schema);
  if (problems.length > 0) throw invalid('The GraphQL schema is not valid', problems[0]!.message);
  return schema;
}

/**
 * The SDL of an introspection result: the response of the introspection query (`{data: {__schema}}`)
 * or its `data` alone (`{__schema}`), as a file holding one usually is.
 *
 * @throws WirebenchError `graphql-schema-invalid` when the document is not an introspection result,
 * names the server's first error when it answered with errors, or describes a schema that is not valid
 */
export function sdlFromIntrospection(document: unknown): string {
  if (!isRecord(document)) throw invalid('The response is not a GraphQL introspection result');
  const data = isRecord(document['data']) ? document['data'] : document;
  if (!isRecord(data['__schema'])) {
    const error = firstErrorMessage(document);
    throw error !== undefined
      ? invalid(`The server answered the introspection query with an error: ${error}`, error)
      : invalid('The response is not a GraphQL introspection result');
  }
  let schema: GraphQLSchema;
  try {
    schema = buildClientSchema(data as unknown as IntrospectionQuery);
  } catch (error) {
    throw invalid('The introspection result does not describe a schema', (error as Error).message);
  }
  return `${printSchema(checked(schema))}\n`;
}

/**
 * The SDL of a schema file a person picked: SDL (`.graphql`, `.graphqls`, `.gql`) is kept as written
 * once it builds and validates, and an introspection result (`.json`) is printed as SDL.
 *
 * @throws WirebenchError `graphql-schema-invalid`
 */
export function sdlFromSchemaFile(text: string, fileName: string): string {
  if (/\.json$/i.test(fileName)) {
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch (error) {
      throw invalid('The file is not valid JSON', (error as Error).message);
    }
    return sdlFromIntrospection(document);
  }
  buildGraphqlSchema(text);
  return text;
}

/**
 * The schema an SDL text describes.
 *
 * @throws WirebenchError `graphql-schema-invalid` when the text does not parse or validate
 */
export function buildGraphqlSchema(sdl: string): GraphQLSchema {
  let schema: GraphQLSchema;
  try {
    schema = buildSchema(sdl);
  } catch (error) {
    throw invalid('The GraphQL schema does not parse', (error as Error).message);
  }
  return checked(schema);
}

/** Built schemas by their SDL: a send checks against the same schema many times. */
const built = new Map<string, GraphQLSchema>();
const BUILT_KEPT = 4;

/** {@link buildGraphqlSchema}, kept for the last few SDL texts; `undefined` for one that does not build. */
export function cachedGraphqlSchema(sdl: string): GraphQLSchema | undefined {
  const kept = built.get(sdl);
  if (kept !== undefined) return kept;
  let schema: GraphQLSchema;
  try {
    schema = buildGraphqlSchema(sdl);
  } catch {
    return undefined;
  }
  if (built.size >= BUILT_KEPT) built.delete(built.keys().next().value!);
  built.set(sdl, schema);
  return schema;
}

/** The stored SDL of an API, or `undefined` when it has none. */
export async function readGraphqlSchema(projectDir: string, apiSlug: string): Promise<string | undefined> {
  try {
    return await readFile(join(projectDir, graphqlSchemaPath(apiSlug)), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Stores an API's SDL, replacing any it had. */
export async function writeGraphqlSchema(projectDir: string, apiSlug: string, sdl: string): Promise<void> {
  const file = join(projectDir, graphqlSchemaPath(apiSlug));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, sdl, 'utf8');
}

/** Removes an API's stored SDL; nothing to remove is not an error. */
export async function removeGraphqlSchema(projectDir: string, apiSlug: string): Promise<void> {
  await rm(join(projectDir, graphqlSchemaPath(apiSlug)), { force: true });
}
