/**
 * A mock service (#59, ADR-0021): one folder under `mocks/`, one folder per contract operation, one
 * file per canned response. This file holds the in-memory model; `file.ts` reads and writes it.
 */

import { generateId } from '../project/model.js';
import type { CreateOptions } from '../project/model.js';
import { slugify } from '../project/paths.js';

/**
 * The newest version a `mock.yaml` may carry. The operation and response files belong to it. Version 2
 * adds response `values` (ADR-0022); a mock is written as version 2 only when a response has them, so a
 * mock without templates stays readable by a build that knows only version 1.
 */
export const MOCK_VERSION = 2;

/** The version a mock with no response `values` is written as. */
export const MOCK_BASE_VERSION = 1;

export const MOCK_LIMITS = Object.freeze({
  /** `mock.yaml`, `operation.yaml` and `*.response.yaml`: larger is refused before parsing. */
  fileBytes: 64 * 1024,
  /** One response body file. */
  bodyBytes: 5 * 1024 * 1024,
  /** `dispatch.ts`. */
  scriptBytes: 256 * 1024,
  /** Every body of one mock together: responses past it are skipped. */
  totalBodyBytes: 64 * 1024 * 1024,
  operations: 1000,
  responsesPerOperation: 500,
  matchesPerResponse: 20,
  headersPerResponse: 100,
  maxDelayMs: 60_000,
  valuesPerResponse: 20,
  pathLength: 1024,
});

/** A scenario's name and every state it can be in. */
export const SCENARIO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** The name of a response template value, which `{{name}}` inserts. */
export const TEMPLATE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The state every scenario is in when a mock starts or is reset. */
export const SCENARIO_START_STATE = 'Started';

/** What the mock does with a request that does not conform to its contract. */
export type MockValidation = 'reject' | 'report' | 'off';

/** How an operation picks one of its responses. */
export type MockDispatch = 'sequence' | 'random' | 'match' | 'script';

/** The language of a response body, which names its file's extension; `none` has no file. */
export type MockBodyLanguage = 'xml' | 'json' | 'text' | 'none';

/** What a match condition checks of the value it reads. None given means `exists: true`. */
export interface MockCheck {
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
}

export interface MockBodyMatch extends MockCheck {
  readonly from: 'body';
  readonly language: 'xpath' | 'jsonpath';
  readonly expression: string;
  /** Prefix bindings for XPath. Absent means the request's own prefixes. */
  readonly namespaces?: Readonly<Record<string, string>>;
}

export interface MockNamedMatch extends MockCheck {
  /** `path` is a REST path parameter; it never holds on SOAP. */
  readonly from: 'query' | 'header' | 'path';
  readonly name: string;
}

export type MockMatch = MockBodyMatch | MockNamedMatch;

/**
 * A request value a response template reads (ADR-0022): the source a match condition reads, without
 * the checks. A template reads the request and nothing else.
 */
export type MockTemplateValue = Omit<MockBodyMatch, keyof MockCheck> | Omit<MockNamedMatch, keyof MockCheck>;

/** A response's place in a scenario. */
export interface MockScenarioStep {
  readonly name: string;
  /** The response is a candidate only while the scenario is in this state. */
  readonly state?: string;
  /** Sending the response moves the scenario to this state. */
  readonly next?: string;
}

export interface MockHeader {
  readonly name: string;
  readonly value: string;
}

/** One canned response (stub). */
export interface MockResponse {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly status: number;
  readonly headers: readonly MockHeader[];
  readonly delayMs: number;
  readonly body: MockBodyLanguage;
  /** The body file's text, sent byte for byte; empty for `none`. */
  readonly bodyText: string;
  readonly match: readonly MockMatch[];
  readonly scenario?: MockScenarioStep;
  /**
   * The request values `{{name}}` inserts into the body and header values (ADR-0022). Absent: the
   * response is literal and sent byte for byte.
   */
  readonly values?: Readonly<Record<string, MockTemplateValue>>;
}

/** One contract operation of a mock, with its responses. */
export interface MockOperation {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  /** The protocol's key: a SOAP operation name in the mock's binding, or REST `<method> <path>`. */
  readonly operation: string;
  readonly dispatch: MockDispatch;
  /** The response used when dispatch picks none. */
  readonly defaultResponseId?: string;
  /** `dispatch.ts`, kept whatever the dispatch style so switching style never loses it. */
  readonly script?: string;
  readonly responses: readonly MockResponse[];
}

export interface MockSource {
  /** The interface's or API's id. */
  readonly containerId: string;
  /** SOAP only: the binding's QName in Clark notation, `{namespace}local`. */
  readonly binding?: string;
}

export interface MockDef {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly source: MockSource;
  /** 0 means any free port. */
  readonly port: number;
  /** Starts with `/`. SOAP: the endpoint path; REST: the prefix every operation path sits under. */
  readonly path: string;
  readonly validation: MockValidation;
  readonly operations: readonly MockOperation[];
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

export interface CreateMockInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly port?: number;
  readonly path?: string;
  readonly validation?: MockValidation;
  readonly operations?: readonly MockOperation[];
}

/**
 * The prefix a mock's `path` puts before every request path: the path without its trailing slashes,
 * and empty for `/`. A loop, not a regular expression, so a request path of many slashes costs
 * linear time.
 */
export function mockPathPrefix(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end -= 1;
  return path.slice(0, end);
}

export function createMock(name: string, source: MockSource, input: CreateMockInput = {}): MockDef {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    source,
    port: input.port ?? 0,
    path: input.path ?? '/',
    validation: input.validation ?? 'reject',
    operations: input.operations ?? [],
  };
}

export interface CreateMockOperationInput extends CreateOptions {
  readonly slug?: string;
  readonly dispatch?: MockDispatch;
  readonly defaultResponseId?: string;
  readonly script?: string;
  readonly responses?: readonly MockResponse[];
}

export function createMockOperation(
  name: string,
  operation: string,
  input: CreateMockOperationInput = {},
): MockOperation {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    operation,
    dispatch: input.dispatch ?? 'sequence',
    ...(input.defaultResponseId !== undefined ? { defaultResponseId: input.defaultResponseId } : {}),
    ...(input.script !== undefined ? { script: input.script } : {}),
    responses: input.responses ?? [],
  };
}

export interface CreateMockResponseInput extends CreateOptions {
  readonly slug?: string;
  readonly status?: number;
  readonly headers?: readonly MockHeader[];
  readonly delayMs?: number;
  readonly body?: MockBodyLanguage;
  readonly bodyText?: string;
  readonly match?: readonly MockMatch[];
  readonly scenario?: MockScenarioStep;
  readonly values?: Readonly<Record<string, MockTemplateValue>>;
}

export function createMockResponse(name: string, input: CreateMockResponseInput = {}): MockResponse {
  const body = input.body ?? (input.bodyText !== undefined && input.bodyText !== '' ? 'text' : 'none');
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    status: input.status ?? 200,
    headers: input.headers ?? [],
    delayMs: input.delayMs ?? 0,
    body,
    bodyText: body === 'none' ? '' : (input.bodyText ?? ''),
    match: input.match ?? [],
    ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
    ...(input.values !== undefined ? { values: input.values } : {}),
  };
}
