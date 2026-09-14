/**
 * Deterministic generator for the `crafted/large.json` OpenAPI performance fixture.
 *
 * A realistic large description is a few hundred operations over a few hundred schemas, which is
 * roughly a megabyte of JSON — too large to commit, so only this generator and its seed
 * ({@link LARGE_OPENAPI_SEED}) live in the repo, exactly as the `large-schema` WSDL fixture does.
 * `pnpm fixtures:refresh` writes it into `fixtures/openapi/crafted/` (git-ignored) and the perf
 * suite writes it into a temp directory at run time.
 *
 * The output is byte-identical for a given seed: no clock, no randomness, no iteration over an
 * unordered map. That is what lets a budget be attached to it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Shape knobs for {@link generateLargeOpenApi}; the defaults produce ~1 MB of JSON. */
export interface LargeOpenApiSeed {
  /** Number of paths, each carrying a `get` and a `post`. */
  readonly paths: number;
  /** Number of component schemas, referenced round-robin by the operations. */
  readonly schemas: number;
  /** Number of properties in each generated schema. */
  readonly propertiesPerSchema: number;
  /** Number of query parameters on each `get`. */
  readonly parametersPerOperation: number;
  /** Number of tags, which become the imported API's folders. */
  readonly tags: number;
}

/**
 * The committed seed: the single source of truth for the fixture's size and shape. Changing it
 * changes the fixture, so the budgets in `test/bench/budgets.ts` are tied to these numbers.
 */
export const LARGE_OPENAPI_SEED: LargeOpenApiSeed = {
  paths: 150,
  schemas: 280,
  propertiesPerSchema: 20,
  parametersPerOperation: 4,
  tags: 12,
};

/** A generated fixture: the document text and how big it turned out. */
export interface GeneratedLargeOpenApi {
  readonly file: string;
  readonly text: string;
  readonly bytes: number;
  readonly operations: number;
}

/** The scalar types the generated properties cycle through, so schemas are not all alike. */
const TYPES = [
  { type: 'string' },
  { type: 'integer', format: 'int64' },
  { type: 'boolean' },
  { type: 'string', format: 'date-time' },
  { type: 'number', format: 'double' },
] as const;

/** One component schema: an object with `propertiesPerSchema` properties, a third of them required. */
function schemaFor(index: number, seed: LargeOpenApiSeed): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let field = 0; field < seed.propertiesPerSchema; field += 1) {
    const name = `field${String(field)}`;
    // Every third property references another schema, so `$ref` resolution and the sample
    // generator's depth cap are both exercised rather than only flat objects.
    properties[name] =
      field % 3 === 2
        ? { $ref: `#/components/schemas/Model${String((index + field) % seed.schemas)}` }
        : { ...TYPES[field % TYPES.length], description: `Field ${String(field)} of model ${String(index)}` };
    if (field % 3 === 0) {
      required.push(name);
    }
  }
  return { type: 'object', required, properties };
}

/** The document, as an object ready to be serialised. */
export function generateLargeOpenApi(seed: LargeOpenApiSeed = LARGE_OPENAPI_SEED): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (let index = 0; index < seed.schemas; index += 1) {
    schemas[`Model${String(index)}`] = schemaFor(index, seed);
  }

  const paths: Record<string, unknown> = {};
  for (let index = 0; index < seed.paths; index += 1) {
    const tag = `Tag${String(index % seed.tags)}`;
    const ref = `#/components/schemas/Model${String(index % seed.schemas)}`;
    const parameters = Array.from({ length: seed.parametersPerOperation }, (_unused, position) => ({
      name: `filter${String(position)}`,
      in: 'query',
      required: position === 0,
      description: `Filter ${String(position)}`,
      schema: { type: 'string' },
    }));
    paths[`/resource${String(index)}/{id}`] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'id-1' }],
      get: {
        operationId: `getResource${String(index)}`,
        summary: `Read resource ${String(index)}`,
        tags: [tag],
        parameters,
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } },
      },
      post: {
        operationId: `createResource${String(index)}`,
        summary: `Create resource ${String(index)}`,
        tags: [tag],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: ref } } } },
        responses: { '201': { description: 'created' } },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: { title: 'Large', version: '1.0.0' },
    servers: [{ url: 'https://large.test' }],
    tags: Array.from({ length: seed.tags }, (_unused, index) => ({ name: `Tag${String(index)}` })),
    paths,
    components: { schemas, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
  };
}

/** Writes the generated fixture into `dir` as `large.json`, creating the directory if needed. */
export async function writeLargeOpenApiFixture(
  dir: string,
  seed: LargeOpenApiSeed = LARGE_OPENAPI_SEED,
): Promise<GeneratedLargeOpenApi> {
  await mkdir(dir, { recursive: true });
  const text = `${JSON.stringify(generateLargeOpenApi(seed), null, 2)}\n`;
  const file = join(dir, 'large.json');
  await writeFile(file, text, 'utf-8');
  return { file, text, bytes: Buffer.byteLength(text, 'utf-8'), operations: seed.paths * 2 };
}
