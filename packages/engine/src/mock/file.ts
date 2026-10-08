/**
 * The files of one mock (ADR-0021): parsing, validation and serialisation.
 *
 * ```
 * mocks/<mock>/mock.yaml
 * mocks/<mock>/operations/<operation>/operation.yaml
 * mocks/<mock>/operations/<operation>/<response>.response.yaml
 * mocks/<mock>/operations/<operation>/<response>.body.xml|json|txt
 * mocks/<mock>/operations/<operation>/dispatch.ts
 * ```
 *
 * Every file may come from a teammate or a branch just pulled, so it is untrusted input: its size is
 * checked before it is parsed, it is parsed with the project's YAML parser, and every count is bounded
 * by {@link MOCK_LIMITS}. Nothing in a file names a path on disk: a body file is found from the
 * response file's own name and its `body` language.
 *
 * Objects are `looseObject`: an unknown key is ignored and not written back. That is only safe because
 * a `mock.yaml` whose `version` is newer than {@link MOCK_VERSION} is refused whole, and a refused file
 * is never deleted by a save (`load.ts`).
 */

import { z } from 'zod';
import { ProjectError } from '../errors.js';
import { assertPathSegment } from '../project/paths.js';
import { compact, parseYaml, stringifyYaml } from '../project/yaml.js';
import { MOCK_LIMITS, MOCK_VERSION, SCENARIO_NAME_PATTERN } from './model.js';
import type {
  MockBodyLanguage,
  MockDef,
  MockHeader,
  MockMatch,
  MockOperation,
  MockResponse,
  MockScenarioStep,
} from './model.js';

/** Directory holding every mock, beside `interfaces/` and `apis/`. */
export const MOCKS_DIR = 'mocks';
export const MOCK_FILE = 'mock.yaml';
export const MOCK_OPERATIONS_DIR = 'operations';
export const OPERATION_FILE = 'operation.yaml';
export const RESPONSE_SUFFIX = '.response.yaml';
/** The one name a dispatch script may have. */
export const DISPATCH_SCRIPT_FILE = 'dispatch.ts';

const BODY_EXTENSION: Readonly<Record<Exclude<MockBodyLanguage, 'none'>, string>> = {
  xml: 'xml',
  json: 'json',
  text: 'txt',
};

/** Header names a stub may not set: the server computes them, and a wrong one corrupts the reply. */
export const MOCK_RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LINE_BREAK_OR_NUL = /[\r\n\u0000]/;

const nonEmpty = z.string().min(1);
/** A YAML scalar read as text: `equals: 200` means the text "200". */
const text = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const scenarioName = z.string().regex(SCENARIO_NAME_PATTERN, 'letters, digits, _ . or -, at most 64');

const check = { equals: text.optional(), matches: z.string().optional(), exists: z.boolean().optional() };

const matchSchema = z.discriminatedUnion('from', [
  z.looseObject({
    from: z.literal('body'),
    language: z.enum(['xpath', 'jsonpath']),
    expression: nonEmpty,
    namespaces: z.record(z.string(), z.string()).optional(),
    ...check,
  }),
  z.looseObject({ from: z.literal('query'), name: nonEmpty, ...check }),
  z.looseObject({ from: z.literal('header'), name: nonEmpty, ...check }),
  z.looseObject({ from: z.literal('path'), name: nonEmpty, ...check }),
]);

const headerSchema = z
  .looseObject({ name: z.string(), value: text })
  .refine((header) => HEADER_NAME.test(header.name), { message: 'not a valid header name' })
  .refine((header) => !LINE_BREAK_OR_NUL.test(header.value), { message: 'a header value may not hold CR, LF or NUL' })
  .refine((header) => !MOCK_RESERVED_HEADERS.has(header.name.toLowerCase()), {
    message: 'Content-Length, Transfer-Encoding and the connection headers are set by the server',
  });

/** `mock.yaml`, after its `kind` and `version` have been checked. */
export const mockFileSchema = z.looseObject({
  kind: z.literal('mock'),
  version: z.literal(MOCK_VERSION),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int().default(0),
  description: z.string().optional(),
  source: z.looseObject({ container: nonEmpty, binding: nonEmpty.optional() }),
  port: z.number().int().min(0).max(65_535).default(0),
  path: z
    .string()
    .max(MOCK_LIMITS.pathLength)
    .regex(/^\/[^?#\s]*$/, 'a path starts with / and holds no ?, # or space')
    .default('/'),
  validation: z.enum(['reject', 'report', 'off']).default('reject'),
});

/** `operation.yaml`. */
export const operationFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int().default(0),
  operation: nonEmpty,
  dispatch: z.enum(['sequence', 'random', 'match', 'script']).default('sequence'),
  default: nonEmpty.optional(),
});

/** `<slug>.response.yaml`. */
export const responseFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int().default(0),
  status: z.number().int().min(100).max(599).default(200),
  headers: z.array(headerSchema).max(MOCK_LIMITS.headersPerResponse).default([]),
  delayMs: z.number().int().min(0).max(MOCK_LIMITS.maxDelayMs).default(0),
  body: z.enum(['xml', 'json', 'text', 'none']).default('none'),
  match: z.array(matchSchema).max(MOCK_LIMITS.matchesPerResponse).default([]),
  scenario: z
    .looseObject({ name: scenarioName, state: scenarioName.optional(), next: scenarioName.optional() })
    .optional(),
});

// ---------------------------------------------------------------------------------------------------
// Paths

export function mockDirPath(mockSlug: string): string {
  return `${MOCKS_DIR}/${mockSlug}`;
}

export function mockFilePath(mockSlug: string): string {
  return `${mockDirPath(mockSlug)}/${MOCK_FILE}`;
}

export function operationDirPath(mockSlug: string, operationSlug: string): string {
  return `${mockDirPath(mockSlug)}/${MOCK_OPERATIONS_DIR}/${operationSlug}`;
}

export function responseFilePath(operationDir: string, responseSlug: string): string {
  return `${operationDir}/${responseSlug}${RESPONSE_SUFFIX}`;
}

/** The body file of a response, or `undefined` for `none`. */
export function bodyFilePath(operationDir: string, responseSlug: string, body: MockBodyLanguage): string | undefined {
  return body === 'none' ? undefined : `${operationDir}/${responseSlug}.body.${BODY_EXTENSION[body]}`;
}

/** The slug a response file's name gives it, or `undefined` for a name that is not a response file. */
export function responseSlugOf(fileName: string): string | undefined {
  return fileName.endsWith(RESPONSE_SUFFIX) && fileName.length > RESPONSE_SUFFIX.length
    ? fileName.slice(0, -RESPONSE_SUFFIX.length)
    : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Parsing

function refuse(code: string, message: string, file: string, issues?: readonly object[]): never {
  throw new ProjectError(code, message, { details: { file, ...(issues !== undefined ? { issues } : {}) } });
}

function readDocument(bytes: Uint8Array | string, file: string): Record<string, unknown> {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes, 'utf8') : bytes.byteLength;
  if (size > MOCK_LIMITS.fileBytes) {
    refuse('mock-file-invalid', `${file} is larger than ${MOCK_LIMITS.fileBytes} bytes`, file);
  }
  const source = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  let document: unknown;
  try {
    document = parseYaml(source, file);
  } catch (error) {
    refuse('mock-file-invalid', `Malformed YAML in ${file}`, file, [
      { path: '', message: error instanceof Error ? error.message : String(error) },
    ]);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    refuse('mock-file-invalid', `${file} is not a mapping`, file);
  }
  return document as Record<string, unknown>;
}

function validated<S extends z.ZodType>(schema: S, document: unknown, file: string, what: string): z.output<S> {
  const result = schema.safeParse(document);
  if (!result.success) {
    refuse(
      'mock-file-invalid',
      `Invalid ${what} ${file}`,
      file,
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

/** `mock.yaml`'s fields: a {@link MockDef} without its operations. */
export type MockSettings = Omit<MockDef, 'operations'>;

/**
 * Parses `mock.yaml`.
 *
 * @throws ProjectError `mock-file-invalid` (too large, malformed, not a mock, failing the schema),
 * `mock-version-too-new` (a `version` above {@link MOCK_VERSION})
 */
export function parseMockFile(bytes: Uint8Array | string, file: string, slug: string): MockSettings {
  const document = readDocument(bytes, file);
  if (document['kind'] !== 'mock') {
    refuse('mock-file-invalid', `${file} is not a mock (kind: ${String(document['kind'])})`, file);
  }
  const version = document['version'];
  if (typeof version === 'number' && Number.isInteger(version) && version > MOCK_VERSION) {
    refuse(
      'mock-version-too-new',
      `${file} was written by a newer version of Wirebench (mock version ${version}); it was left as it is`,
      file,
    );
  }
  const parsed = validated(mockFileSchema, document, file, 'mock file');
  return {
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    source: {
      containerId: parsed.source.container,
      ...(parsed.source.binding !== undefined ? { binding: parsed.source.binding } : {}),
    },
    port: parsed.port,
    path: parsed.path,
    validation: parsed.validation,
  };
}

/** `operation.yaml`'s fields: a {@link MockOperation} without its responses and script. */
export type MockOperationSettings = Omit<MockOperation, 'responses' | 'script'>;

/** @throws ProjectError `mock-file-invalid` */
export function parseOperationFile(bytes: Uint8Array | string, file: string, slug: string): MockOperationSettings {
  const parsed = validated(operationFileSchema, readDocument(bytes, file), file, 'mock operation file');
  return {
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    operation: parsed.operation,
    dispatch: parsed.dispatch,
    ...(parsed.default !== undefined ? { defaultResponseId: parsed.default } : {}),
  };
}

/** A response file's fields: a {@link MockResponse} without its body text. */
export type MockResponseSettings = Omit<MockResponse, 'bodyText'>;

/** @throws ProjectError `mock-file-invalid` */
export function parseResponseFile(bytes: Uint8Array | string, file: string, slug: string): MockResponseSettings {
  const parsed = validated(responseFileSchema, readDocument(bytes, file), file, 'mock response file');
  return {
    id: parsed.id,
    name: parsed.name,
    slug,
    order: parsed.order,
    status: parsed.status,
    headers: parsed.headers.map((header): MockHeader => ({ name: header.name, value: header.value })),
    delayMs: parsed.delayMs,
    body: parsed.body,
    match: parsed.match.map(toMatch),
    ...(parsed.scenario !== undefined ? { scenario: toScenario(parsed.scenario) } : {}),
  };
}

function checkOf(raw: { equals?: string | undefined; matches?: string | undefined; exists?: boolean | undefined }): {
  equals?: string;
  matches?: string;
  exists?: boolean;
} {
  return {
    ...(raw.equals !== undefined ? { equals: raw.equals } : {}),
    ...(raw.matches !== undefined ? { matches: raw.matches } : {}),
    ...(raw.exists !== undefined ? { exists: raw.exists } : {}),
  };
}

/** Only the fields a condition defines, so an unknown key is not written back. */
function toMatch(raw: z.output<typeof matchSchema>): MockMatch {
  if (raw.from === 'body') {
    return {
      from: 'body',
      language: raw.language,
      expression: raw.expression,
      ...(raw.namespaces !== undefined ? { namespaces: raw.namespaces } : {}),
      ...checkOf(raw),
    };
  }
  return { from: raw.from, name: raw.name, ...checkOf(raw) };
}

function toScenario(raw: { name: string; state?: string | undefined; next?: string | undefined }): MockScenarioStep {
  return {
    name: raw.name,
    ...(raw.state !== undefined ? { state: raw.state } : {}),
    ...(raw.next !== undefined ? { next: raw.next } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// Serialising

export function mockDocument(mock: MockDef): string {
  return stringifyYaml(
    compact({
      kind: 'mock',
      version: MOCK_VERSION,
      id: mock.id,
      name: mock.name,
      order: mock.order,
      description: mock.description,
      source: compact({ container: mock.source.containerId, binding: mock.source.binding }),
      port: mock.port,
      path: mock.path,
      validation: mock.validation,
    }),
  );
}

export function operationDocument(operation: MockOperation): string {
  return stringifyYaml(
    compact({
      id: operation.id,
      name: operation.name,
      order: operation.order,
      operation: operation.operation,
      dispatch: operation.dispatch,
      default: operation.defaultResponseId,
    }),
  );
}

function matchDocument(match: MockMatch): Record<string, unknown> {
  const checks = { equals: match.equals, matches: match.matches, exists: match.exists };
  return match.from === 'body'
    ? compact({
        from: 'body',
        language: match.language,
        expression: match.expression,
        namespaces: match.namespaces,
        ...checks,
      })
    : compact({ from: match.from, name: match.name, ...checks });
}

export function responseDocument(response: MockResponse): string {
  return stringifyYaml(
    compact({
      id: response.id,
      name: response.name,
      order: response.order,
      status: response.status,
      headers:
        response.headers.length > 0
          ? response.headers.map((header) => ({ name: header.name, value: header.value }))
          : undefined,
      delayMs: response.delayMs > 0 ? response.delayMs : undefined,
      body: response.body,
      match: response.match.length > 0 ? response.match.map(matchDocument) : undefined,
      scenario:
        response.scenario !== undefined
          ? compact({ name: response.scenario.name, state: response.scenario.state, next: response.scenario.next })
          : undefined,
    }),
  );
}

/**
 * Every file a mock is written as: path relative to the project root, to its text.
 *
 * @throws ProjectError `project-path-invalid` for a slug the path rules refuse (ADR-0005)
 */
export function mockFiles(mock: MockDef): Map<string, string> {
  assertPathSegment(mock.slug);
  const files = new Map<string, string>();
  files.set(mockFilePath(mock.slug), mockDocument(mock));
  for (const operation of mock.operations) {
    assertPathSegment(operation.slug);
    const dir = operationDirPath(mock.slug, operation.slug);
    files.set(`${dir}/${OPERATION_FILE}`, operationDocument(operation));
    if (operation.script !== undefined) {
      files.set(`${dir}/${DISPATCH_SCRIPT_FILE}`, operation.script);
    }
    for (const response of operation.responses) {
      assertPathSegment(response.slug);
      files.set(responseFilePath(dir, response.slug), responseDocument(response));
      const body = bodyFilePath(dir, response.slug, response.body);
      if (body !== undefined) {
        files.set(body, response.bodyText);
      }
    }
  }
  return files;
}

/**
 * Checks `mock` as a load of its files would: every file rendered and parsed back by its own parser,
 * and the counts and sizes the loader bounds. An editor calls it before accepting an edit, so a mock
 * edited in the app is held to exactly the rules a mock pulled from a teammate is.
 *
 * @throws ProjectError `mock-file-invalid` naming the file and what is wrong; `project-path-invalid`
 * for a slug that is not a safe path segment
 */
export function validateMock(mock: MockDef): void {
  const files = mockFiles(mock);
  parseMockFile(files.get(mockFilePath(mock.slug)) ?? '', mockFilePath(mock.slug), mock.slug);
  if (mock.operations.length > MOCK_LIMITS.operations) {
    refuse('mock-file-invalid', `A mock holds at most ${MOCK_LIMITS.operations} operations`, mockFilePath(mock.slug));
  }
  let totalBodyBytes = 0;
  for (const operation of mock.operations) {
    const dir = operationDirPath(mock.slug, operation.slug);
    const operationFile = `${dir}/${OPERATION_FILE}`;
    parseOperationFile(files.get(operationFile) ?? '', operationFile, operation.slug);
    if (operation.script !== undefined && Buffer.byteLength(operation.script, 'utf8') > MOCK_LIMITS.scriptBytes) {
      refuse(
        'mock-file-invalid',
        `The dispatch script is larger than ${MOCK_LIMITS.scriptBytes} bytes`,
        `${dir}/${DISPATCH_SCRIPT_FILE}`,
      );
    }
    if (operation.responses.length > MOCK_LIMITS.responsesPerOperation) {
      refuse(
        'mock-file-invalid',
        `An operation holds at most ${MOCK_LIMITS.responsesPerOperation} responses`,
        operationFile,
      );
    }
    for (const response of operation.responses) {
      const file = responseFilePath(dir, response.slug);
      parseResponseFile(files.get(file) ?? '', file, response.slug);
      const bytes = Buffer.byteLength(response.bodyText, 'utf8');
      if (bytes > MOCK_LIMITS.bodyBytes) {
        refuse(
          'mock-file-invalid',
          `The body of "${response.name}" is larger than ${MOCK_LIMITS.bodyBytes} bytes`,
          file,
        );
      }
      totalBodyBytes += bytes;
    }
  }
  if (totalBodyBytes > MOCK_LIMITS.totalBodyBytes) {
    refuse(
      'mock-file-invalid',
      `The mock's bodies together exceed ${MOCK_LIMITS.totalBodyBytes} bytes`,
      mockFilePath(mock.slug),
    );
  }
}
