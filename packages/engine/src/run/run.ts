/**
 * Sends each selected request, evaluates its assertions and summarises the run.
 *
 * One request's error never stops the run unless `bail` asks it to: a pipeline wants the whole
 * picture, not the first thing that went wrong. An errored assertion outranks a failed one for the
 * request's outcome, because "we could not tell" is a different problem from "it is wrong".
 */
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError } from '../errors.js';
import { definitionCacheDir } from '../project/paths.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import type { SoapExchange } from '../types.js';
import { bindingContextFor, validateMessage } from '../validate/index.js';
import { summarizeWsa } from '../wsa/policy-detect.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { prepareSend } from './prepare.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';

export type RequestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

/** What happened to one selected request. */
export interface RequestResult {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly protocol: 'soap' | 'rest';
  readonly outcome: RequestOutcome;
  readonly status?: number;
  readonly durationMs?: number;
  readonly assertions: readonly AssertionResult[];
  /** Set when errored before or during the send. */
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  /** A request with no assertions of its own; reported, and an error under `requireAssertions`. */
  readonly unasserted: boolean;
  /** Raw request and response text, kept for failed and errored requests only. NOT yet redacted. */
  readonly exchange?: { readonly request: string; readonly response: string };
}

export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface RunResult {
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunSummary;
  readonly requests: readonly RequestResult[];
}

export interface RunOptions {
  readonly bail?: boolean;
  readonly defaultSlaMs?: number;
  readonly requireAssertions?: boolean;
  readonly onRequestDone?: (result: RequestResult) => void;
}

type SoapSelected = Extract<SelectedRequest, { kind: 'soap' }>;

/** An interface's cached definition, compiled once per run. */
interface LoadedDefinition {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
  readonly defaultActionByOperation: Readonly<Record<string, string>>;
}

/** Enough of each exchange to keep for a report: a failing response can be megabytes. */
const EXCHANGE_CAP_BYTES = 64 * 1024;

function capped(bytes: Uint8Array): string {
  if (bytes.length <= EXCHANGE_CAP_BYTES) {
    return new TextDecoder().decode(bytes);
  }
  return `${new TextDecoder().decode(bytes.subarray(0, EXCHANGE_CAP_BYTES))}\n… truncated`;
}

function identity(item: SelectedRequest): Pick<RequestResult, 'path' | 'group' | 'name' | 'protocol'> {
  return { path: item.path, group: item.group, name: item.request.name, protocol: item.kind };
}

function erroredResult(item: SelectedRequest, error: NonNullable<RequestResult['error']>): RequestResult {
  return {
    ...identity(item),
    outcome: 'errored',
    assertions: [],
    error,
    unasserted: item.request.assertions.length === 0,
  };
}

function parseClark(clark: string): { namespaceUri: string; localName: string } {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null
    ? { namespaceUri: '', localName: clark }
    : { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}

/**
 * Reads the interface's definition from `interfaces/<slug>/definition/`, as the app hydrates it
 * with `prefer-cache` — minus the network fallback: a run never fetches a WSDL. An interface that
 * does not cache its definition, or whose cache is absent or unreadable, has no contract here.
 */
async function loadDefinition(projectDir: string, iface: SoapSelected['iface']): Promise<LoadedDefinition | undefined> {
  if (!iface.cacheDefinition) {
    return undefined;
  }
  try {
    const bundle = await readDefinitionCache(definitionCacheDir(projectDir, iface.slug));
    const definition = parseWsdlBundle(bundle);
    return {
      definition,
      bundle,
      schemaSet: buildSchemaSet(bundle),
      defaultActionByOperation: summarizeWsa(definition).defaultActionByOperation,
    };
  } catch {
    return undefined;
  }
}

function soapSubject(
  exchange: SoapExchange,
  loaded: LoadedDefinition | undefined,
  item: SoapSelected,
): AssertionSubject {
  const fault = exchange.response?.fault;
  const bodyText = exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body);
  const binding =
    loaded === undefined
      ? undefined
      : bindingContextFor(
          loaded.definition,
          { bindingName: parseClark(item.operation.bindingName), operationName: item.operation.name },
          'response',
        );
  const contentType = exchange.http.headers['content-type'];
  return {
    protocol: 'soap',
    status: exchange.http.status,
    durationMs: exchange.durationMs,
    bodyText,
    bodyKind: exchange.response?.isSoap === true ? 'xml' : 'other',
    fault: {
      present: fault !== undefined,
      ...(fault !== undefined ? { summary: [fault.code, fault.reason].filter((s) => s.length > 0).join(' — ') } : {}),
    },
    ...(loaded !== undefined && binding !== undefined
      ? {
          validateContract: () =>
            validateMessage({
              xml: bodyText,
              direction: 'response',
              schemaSet: loaded.schemaSet,
              bundle: loaded.bundle,
              binding,
              http: { ...(contentType !== undefined ? { contentType } : {}) },
            }).then((r) => r.problems),
        }
      : {}),
  };
}

function restSubject(exchange: RestExchange): AssertionSubject {
  return {
    protocol: 'rest',
    status: exchange.status,
    durationMs: exchange.durationMs,
    bodyText: exchange.text,
    bodyKind: exchange.language === 'json' ? 'json' : exchange.language === 'xml' ? 'xml' : 'other',
  };
}

function outcomeOf(assertions: readonly AssertionResult[]): RequestOutcome {
  if (assertions.some((a) => a.outcome === 'errored')) return 'errored';
  if (assertions.some((a) => a.outcome === 'failed')) return 'failed';
  return 'passed';
}

/** Runs one request; a throw anywhere on the way becomes an errored result, never a stopped run. */
async function runOne(
  item: SelectedRequest,
  context: RunContext,
  options: RunOptions,
  definitionFor: (iface: SoapSelected['iface']) => Promise<LoadedDefinition | undefined>,
): Promise<RequestResult> {
  try {
    const loaded = item.kind === 'soap' ? await definitionFor(item.iface) : undefined;
    const prepared = await prepareSend(item, {
      ...context,
      ...(loaded !== undefined
        ? {
            defaultWsaActionFor: (s: SoapSelected) =>
              loaded.defaultActionByOperation[`${s.operation.bindingName}|${s.operation.name}`] ?? '',
          }
        : {}),
    });
    let subject: AssertionSubject;
    let raw: { rawRequest: Uint8Array; rawResponse: Uint8Array };
    if (prepared.kind === 'soap' && item.kind === 'soap') {
      const exchange = await sendSoapRequest(prepared.input, { scopes: prepared.scopes });
      subject = soapSubject(exchange, loaded, item);
      raw = exchange.http;
    } else if (prepared.kind === 'rest') {
      const exchange = await sendRest(prepared.input);
      subject = restSubject(exchange);
      raw = exchange;
    } else {
      throw new Error('prepareSend returned a send of the wrong protocol');
    }
    const own = item.request.assertions;
    const withDefault: readonly Assertion[] =
      options.defaultSlaMs !== undefined && !own.some((a) => a.type === 'sla')
        ? [...own, { type: 'sla', maxMs: options.defaultSlaMs }]
        : own;
    const assertions = await evaluateAssertions(subject, withDefault);
    const outcome = outcomeOf(assertions);
    return {
      ...identity(item),
      outcome,
      status: subject.status,
      durationMs: subject.durationMs,
      assertions,
      unasserted: own.length === 0,
      ...(outcome !== 'passed'
        ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
        : {}),
    };
  } catch (e) {
    return erroredResult(item, {
      code: isWirebenchError(e) ? e.code : 'internal-error',
      message: e instanceof Error ? e.message : String(e),
      ...(isWirebenchError(e) && e.details !== undefined ? { details: e.details } : {}),
    });
  }
}

/**
 * Sends `selected` in order and reports each. A request after an abort, or after the first
 * failure under `bail`, is `skipped` and never sent.
 */
export async function runRequests(
  selected: readonly SelectedRequest[],
  context: RunContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const definitions = new Map<string, Promise<LoadedDefinition | undefined>>();
  const definitionFor = (iface: SoapSelected['iface']): Promise<LoadedDefinition | undefined> => {
    let loaded = definitions.get(iface.id);
    if (loaded === undefined) {
      loaded = loadDefinition(context.projectDir, iface);
      definitions.set(iface.id, loaded);
    }
    return loaded;
  };
  const results: RequestResult[] = [];
  let stopped = false;
  for (const item of selected) {
    let result: RequestResult;
    if (stopped || context.signal?.aborted === true) {
      result = {
        ...identity(item),
        outcome: 'skipped',
        assertions: [],
        unasserted: item.request.assertions.length === 0,
      };
    } else if (item.request.assertions.length === 0 && options.requireAssertions === true) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      result = await runOne(item, context, options, definitionFor);
    }
    results.push(result);
    options.onRequestDone?.(result);
    if (options.bail === true && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  }
  const count = (outcome: RequestOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const environment = context.project.environments.find((e) => e.id === context.environmentId)?.name;
  return {
    startedAt,
    ...(environment !== undefined ? { environment } : {}),
    summary: {
      total: results.length,
      passed: count('passed'),
      failed: count('failed'),
      errored: count('errored'),
      skipped: count('skipped'),
      durationMs: Math.round(performance.now() - started),
    },
    requests: results,
  };
}
