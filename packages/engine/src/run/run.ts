/**
 * Sends each selected request, evaluates its assertions and summarises the run.
 *
 * One request's error never stops the run unless `bail` asks it to: a pipeline wants the whole
 * picture, not the first thing that went wrong. An errored assertion outranks a failed one for the
 * request's outcome, because "we could not tell" is a different problem from "it is wrong".
 */
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import { readGrpcDefinitionCache } from '../grpc/cache.js';
import { callGrpc } from '../grpc/call.js';
import type { GrpcCallResult } from '../grpc/call.js';
import { loadProtoSet } from '../grpc/proto/load.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import { protoSetFromDescriptorSet } from '../grpc/reflection/descriptors.js';
import { apiDefinitionDir, definitionCacheDir } from '../project/paths.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import type { SendAuth, SoapExchange } from '../types.js';
import { bindingContextFor, validateMessage } from '../validate/index.js';
import { summarizeWsa } from '../wsa/policy-detect.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend } from './prepare.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';

export type RequestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

/** What happened to one selected request. */
export interface RequestResult {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly protocol: 'soap' | 'rest' | 'grpc';
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
type GrpcSelected = Extract<SelectedRequest, { kind: 'grpc' }>;

/** A request's own assertions; a gRPC request that never had any carries none. */
const assertionsOf = (item: SelectedRequest): readonly Assertion[] => item.request.assertions ?? [];

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
    unasserted: assertionsOf(item).length === 0,
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

/**
 * Reads a gRPC API's schema from `apis/<slug>/definition/`, as the app's `grpcProtoSetFor` does:
 * the `.proto` sources an import cached, or the descriptor set reflection cached. A run never
 * reflects against a server, so an API with no cache has no schema and none of its calls can run.
 *
 * @throws WirebenchError `grpc-definition-missing` when there is no cache; whatever the loaders
 * throw for one that does not load
 */
async function loadProtoSetFor(projectDir: string, api: GrpcSelected['api']): Promise<ProtoSet> {
  let cache: Awaited<ReturnType<typeof readGrpcDefinitionCache>>;
  try {
    cache = await readGrpcDefinitionCache(apiDefinitionDir(projectDir, api.slug));
  } catch (error) {
    if (isWirebenchError(error) && error.code === 'definition-cache-missing') {
      throw new WirebenchError(
        'grpc-definition-missing',
        `The gRPC API "${api.name}" has no cached definition; import its .proto files or discover it in the app first.`,
        { details: { api: api.name }, cause: error },
      );
    }
    throw error;
  }
  return cache.kind === 'proto'
    ? loadProtoSet(cache.sources, { roots: cache.manifest.roots })
    : protoSetFromDescriptorSet(cache.descriptors, { roots: cache.manifest.roots });
}

/**
 * A unary call's answer as assertions see it: the gRPC status code (0 = OK), and the one response
 * message as JSON. No message, or one that did not decode, leaves nothing a `match` can read.
 * Exported for its unit test; not part of the run module's public surface.
 */
export function grpcSubject(result: GrpcCallResult): AssertionSubject {
  const first = result.responseMessages[0];
  const decoded = first !== undefined && first.json !== undefined;
  return {
    protocol: 'grpc',
    status: result.exchange.status,
    durationMs: result.exchange.durationMs,
    bodyText: decoded ? JSON.stringify(first.json) : '',
    bodyKind: decoded ? 'json' : 'other',
  };
}

/** gRPC's `UNAUTHENTICATED`: the server's word for a credential it will not accept. */
const GRPC_UNAUTHENTICATED = 16;

/**
 * After a server refused the credentials a send carried, drops the run's OAuth2 token among them,
 * so the next request behind that configuration fetches a new one instead of repeating the refusal.
 * The refused request itself is never sent again.
 */
function dropRefusedToken(context: RunContext, auth: SendAuth | undefined, refused: boolean): void {
  if (refused && auth?.type === 'oauth2') {
    context.tokenSource?.reject(auth.accessToken);
  }
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
  protoSetFor: (api: GrpcSelected['api']) => Promise<ProtoSet>,
): Promise<RequestResult> {
  try {
    const loaded = item.kind === 'soap' ? await definitionFor(item.iface) : undefined;
    // Before the send is prepared: without a schema there is no call, so no token is worth fetching.
    const protoSet = item.kind === 'grpc' ? await protoSetFor(item.api) : undefined;
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
      dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
      subject = restSubject(exchange);
      raw = exchange;
    } else if (prepared.kind === 'grpc' && protoSet !== undefined) {
      const result = await callGrpc({ ...prepared.input, set: protoSet, messageText: prepared.messageText });
      dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
      subject = grpcSubject(result);
      raw = result.exchange;
    } else {
      throw new Error('prepareSend returned a send of the wrong protocol');
    }
    const own = assertionsOf(item);
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
  // Each gRPC API's schema is loaded once per run; a failed load is remembered too, since nothing
  // in a run can fix the cache, and every call of that API reports the same error.
  const protoSets = new Map<string, Promise<ProtoSet>>();
  const protoSetFor = (api: GrpcSelected['api']): Promise<ProtoSet> => {
    let loading = protoSets.get(api.id);
    if (loading === undefined) {
      loading = loadProtoSetFor(context.projectDir, api);
      // Observed here so a rejection nobody awaits yet is never reported as unhandled.
      loading.catch(() => undefined);
      protoSets.set(api.id, loading);
    }
    return loading;
  };
  // One token source for the whole run: requests behind the same OAuth2 configuration share a token.
  const runContext: RunContext = {
    ...context,
    tokenSource:
      context.tokenSource ??
      createRunTokenSource({
        getSecret: context.getSecret,
        ...(context.fetchToken !== undefined ? { send: context.fetchToken } : {}),
        ...(context.onSecretValue !== undefined ? { onSecretValue: context.onSecretValue } : {}),
      }),
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
        unasserted: assertionsOf(item).length === 0,
      };
    } else if (assertionsOf(item).length === 0 && options.requireAssertions === true) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      result = await runOne(item, runContext, options, definitionFor, protoSetFor);
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
