/**
 * A REST request's script types, from the OpenAPI operation it is linked to (spec §Types, REST).
 *
 * `WbRequestBody` is the JSON request body's type. `WbResponse` is a union with one arm per declared
 * status. Each arm's `status` is a set of literals — one code, a range less the codes declared on
 * their own, or everything left for `default` — so `response.status === 200` narrows `json()` exactly,
 * and a status the contract does not declare falls into a last arm whose body is `unknown`.
 */
import { ProjectError } from '../errors.js';
import { apiDefinitionDir } from '../project/paths.js';
import { JsonSchemaTypes } from '../script/types/json-schema.js';
import type { RestContractLink } from './model.js';
import { createCachedApiFetch, readApiDefinitionCache } from './openapi/cache.js';
import { parseOpenApi } from './openapi/import.js';
import type { OpenApiDocument, OpenApiOperation } from './openapi/model.js';

/** The JSON media type among a content map's keys, if any. */
function jsonMedia(
  content: Readonly<Record<string, { readonly schema?: unknown }>> | undefined,
): { schema?: unknown } | undefined {
  if (content === undefined) {
    return undefined;
  }
  const key =
    Object.keys(content).find((k) => /^application\/json\b/i.test(k)) ??
    Object.keys(content).find((k) => /\+json\b/i.test(k));
  return key === undefined ? undefined : content[key];
}

export function restScriptTypes(operation: OpenApiOperation | undefined): string {
  if (operation === undefined) {
    return [
      '// This request is not linked to an operation of its API, so its bodies are untyped.',
      'type WbRequestBody = unknown;',
      'type WbResponse = WbResponseArm<WbStatus, unknown>;',
      '',
    ].join('\n');
  }
  const types = new JsonSchemaTypes();
  const requestMedia = jsonMedia(operation.requestBody?.content);
  const requestBody = requestMedia?.schema !== undefined ? types.typeOf(requestMedia.schema) : 'unknown';

  const responses = operation.responses ?? {};
  const exact = Object.keys(responses).filter((key) => /^[1-5]\d\d$/.test(key));
  const ranges = Object.keys(responses).filter((key) => /^[1-5]XX$/i.test(key));
  const exactUnion = exact.length > 0 ? exact.join(' | ') : 'never';
  const rangeTypes = ranges.map((key) => `WbRange${key[0]!}`);

  const arms: string[] = [];
  const bodyOf = (key: string): string => {
    const media = jsonMedia(responses[key]?.content);
    return media?.schema !== undefined ? types.typeOf(media.schema) : 'unknown';
  };
  for (const key of exact) {
    arms.push(`WbResponseArm<${key}, ${bodyOf(key)}>`);
  }
  for (const key of ranges) {
    arms.push(`WbResponseArm<Exclude<WbRange${key[0]!}, ${exactUnion}>, ${bodyOf(key)}>`);
  }
  const covered = [exactUnion, ...rangeTypes].filter((t) => t !== 'never').join(' | ') || 'never';
  const rest = `Exclude<WbStatus, ${covered}>`;
  arms.push(`WbResponseArm<${rest}, ${responses['default'] !== undefined ? bodyOf('default') : 'unknown'}>`);

  const where = `${operation.method.toUpperCase()} ${operation.path}`.replace(/\*\//g, '*\\/');
  return [
    `// Types from the contract's ${where}.`,
    types.declarations(),
    `type WbRequestBody = ${requestBody};`,
    `type WbResponse =\n  | ${arms.join('\n  | ')};`,
    '',
  ].join('\n');
}

/** The operation a REST request is linked to, by its method and templated path. */
export function restOperationFor(
  document: OpenApiDocument | undefined,
  contract: RestContractLink | undefined,
): OpenApiOperation | undefined {
  if (document === undefined || contract === undefined) return undefined;
  return document.operations.find(
    (op) => op.method.toLowerCase() === contract.method.toLowerCase() && op.path === contract.path,
  );
}

/** An API's cached OpenAPI document, read offline; `undefined` when it has none or it cannot be read. */
export async function loadOpenApiDocument(projectDir: string, apiSlug: string): Promise<OpenApiDocument | undefined> {
  const dir = apiDefinitionDir(projectDir, apiSlug);
  try {
    const cached = await readApiDefinitionCache(dir);
    const offline = createCachedApiFetch(cached.manifest, dir, (location) =>
      Promise.reject(
        new ProjectError('definition-cache-missing', `"${location}" is not in this API's definition cache`, {
          details: { location },
        }),
      ),
    );
    const parsed = await parseOpenApi({ kind: 'url', url: cached.manifest.rootLocation }, { fetchDocument: offline });
    return parsed.document;
  } catch {
    return undefined;
  }
}
