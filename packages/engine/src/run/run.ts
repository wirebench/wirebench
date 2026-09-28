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
import { urlOrigin } from '../project/sequence-guards.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend, scopesFor } from './prepare.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';
import type { TransferResult } from '../sequence/run.js';
import { expandSendInput } from '../project/properties.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { loadOpenApiDocument } from '../script/contracts.js';
import type { RequestSnapshot, ResponseSnapshot, ScriptOutcome, ScriptTest, ScriptValue } from '../script/model.js';
import { scriptProperties } from '../script/props.js';
import {
  activeScripts,
  scriptError,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import {
  SecretPlaceholders,
  applyGrpcSnapshot,
  applyRestSnapshot,
  applySoapSnapshot,
  grpcRequestSnapshot,
  grpcResponseSnapshot,
  restRequestSnapshot,
  restResponseSnapshot,
  soapRequestSnapshot,
  soapResponseSnapshot,
} from '../script/send.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptTypesFor,
  type SentScripts,
} from './script-support.js';

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
  /** Set when this is a sequence step: which sequence, and which of its steps. */
  readonly sequence?: { readonly id: string; readonly name: string; readonly stepId: string };
  /** A sequence step's transfers. A secret one carries no value. */
  readonly transfers?: readonly TransferResult[];
  /** Where the request went, for a sequence step. */
  readonly origin?: string;
  /** What the request's scripts logged, capped. NOT yet redacted. */
  readonly scriptLog?: readonly string[];
  /** True when the request has scripts and they are switched off, so none ran. */
  readonly scriptsOff?: boolean;
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
type RestSelected = Extract<SelectedRequest, { kind: 'rest' }>;

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

/**
 * A SOAP response as assertions and sequence transfers see it, without contract validation: what a
 * host that has no compiled definition at hand (the desktop's sequence runner) can build from the
 * exchange alone.
 */
export function soapResponseSubject(exchange: SoapExchange): AssertionSubject {
  const fault = exchange.response?.fault;
  return {
    protocol: 'soap',
    status: exchange.http.status,
    durationMs: exchange.durationMs,
    bodyText: exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body),
    bodyKind: exchange.response?.isSoap === true ? 'xml' : 'other',
    headers: exchange.http.rawHeaders,
    fault: {
      present: fault !== undefined,
      ...(fault !== undefined ? { summary: [fault.code, fault.reason].filter((s) => s.length > 0).join(' — ') } : {}),
    },
  };
}

function soapSubject(
  exchange: SoapExchange,
  loaded: LoadedDefinition | undefined,
  item: SoapSelected,
): AssertionSubject {
  const base = soapResponseSubject(exchange);
  const bodyText = base.bodyText;
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
    ...base,
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

/** A REST response as assertions and sequence transfers see it. */
export function restSubject(exchange: RestExchange): AssertionSubject {
  return {
    protocol: 'rest',
    status: exchange.status,
    durationMs: exchange.durationMs,
    bodyText: exchange.text,
    bodyKind: exchange.language === 'json' ? 'json' : exchange.language === 'xml' ? 'xml' : 'other',
    headers: exchange.rawHeaders,
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
    // Metadata first, then trailers: a header assertion or transfer takes the first value it finds.
    headers: [...Object.entries(result.exchange.headers), ...Object.entries(result.exchange.trailers)],
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

/** One request as a run sends it: the response as assertions see it, and what a report keeps. */
export interface SentRequest {
  readonly subject: AssertionSubject;
  readonly raw: { readonly rawRequest: Uint8Array; readonly rawResponse: Uint8Array };
  /** Where the request went: a URL's origin, or a gRPC target. */
  readonly origin?: string;
  /** What the request's scripts produced (#63). */
  readonly script?: SentScripts;
  /** True when the request has scripts and they are switched off. */
  readonly scriptsOff?: boolean;
}

/** What a run's sender may change for one request. */
export type RunSendOverrides = Pick<RunContext, 'sequence' | 'timeoutMs'>;

/** Sends one selected request as a run does. Throws what preparing or sending throws. */
export type RunRequestSender = (item: SelectedRequest, overrides?: RunSendOverrides) => Promise<SentRequest>;

/**
 * A sender for one run: each interface's definition and each gRPC API's schema is loaded once, and one
 * OAuth2 token source serves every request behind the same configuration. `runRequests` sends through
 * it, and so does a sequence run, so a step is sent exactly as a selected request is.
 */
export function createRunSender(context: RunContext): RunRequestSender {
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

  // Each REST API's OpenAPI document is read once per run, for its requests' script types.
  const openApiDocuments = new Map<string, Promise<OpenApiDocument | undefined>>();
  const openApiFor = (api: RestSelected['api']): Promise<OpenApiDocument | undefined> => {
    let loading = openApiDocuments.get(api.id);
    if (loading === undefined) {
      loading = loadOpenApiDocument(context.projectDir, api.slug);
      openApiDocuments.set(api.id, loading);
    }
    return loading;
  };

  return async (item, overrides = {}) => {
    const itemContext: RunContext = {
      ...runContext,
      ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    };
    const loaded = item.kind === 'soap' ? await definitionFor(item.iface) : undefined;
    // Before the send is prepared: without a schema there is no call, so no token is worth fetching.
    const protoSet = item.kind === 'grpc' ? await protoSetFor(item.api) : undefined;
    const withWsa: RunContext = {
      ...itemContext,
      ...(loaded !== undefined
        ? {
            defaultWsaActionFor: (s: SoapSelected) =>
              loaded.defaultActionByOperation[`${s.operation.bindingName}|${s.operation.name}`] ?? '',
          }
        : {}),
    };

    const scripts = activeScripts(item.request.scripts);
    if (scripts !== undefined) {
      if (context.scripting === undefined) {
        throw new WirebenchError('script-unavailable', `"${item.path}" has scripts, and this run cannot run them`, {
          details: { path: item.path },
        });
      }
      const openApi = item.kind === 'rest' ? await openApiFor(item.api) : undefined;
      const scripted: ScriptedRequest = {
        protocol: item.kind,
        path: item.path,
        name: item.request.name,
        slug: item.request.slug,
        scripts,
        types: scriptTypesFor(item, loaded, protoSet, openApi),
      };
      return sendScripted(item, scripted, context.scripting, withWsa, loaded, protoSet);
    }

    const scriptsOff = item.request.scripts !== undefined ? { scriptsOff: true as const } : {};
    const prepared = await prepareSend(item, withWsa);
    if (prepared.kind === 'soap' && item.kind === 'soap') {
      const exchange = await sendSoapRequest(prepared.input, { scopes: prepared.scopes });
      dropRefusedToken(itemContext, prepared.input.auth, exchange.http.status === 401);
      return {
        subject: soapSubject(exchange, loaded, item),
        raw: exchange.http,
        ...originOf(exchange.http.request.url),
        ...scriptsOff,
      };
    }
    if (prepared.kind === 'rest') {
      const exchange = await sendRest(prepared.input);
      dropRefusedToken(itemContext, prepared.input.auth, exchange.status === 401);
      return { subject: restSubject(exchange), raw: exchange, ...originOf(exchange.request.url), ...scriptsOff };
    }
    if (prepared.kind === 'grpc' && protoSet !== undefined) {
      const result = await callGrpc({ ...prepared.input, set: protoSet, messageText: prepared.messageText });
      dropRefusedToken(itemContext, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
      return { subject: grpcSubject(result), raw: result.exchange, origin: prepared.input.target, ...scriptsOff };
    }
    throw new Error('prepareSend returned a send of the wrong protocol');
  };
}

/**
 * Sends a request that has scripts (#63). It is prepared with its secrets behind placeholders, the
 * pre-request script runs on that, the secrets are put back, and the post-response script sees the
 * request as the script left it — placeholders and all — and the response.
 *
 * @throws WirebenchError what preparing or sending throws, `script-type-error`, or a pre-request
 * script's failure; a post-response script's failure is returned with the response
 */
async function sendScripted(
  item: SelectedRequest,
  scripted: ScriptedRequest,
  scripting: RequestScripting,
  context: RunContext,
  loaded: LoadedDefinition | undefined,
  protoSet: ProtoSet | undefined,
): Promise<SentRequest> {
  await scripting.check(scripted);
  const placeholders = new SecretPlaceholders();
  const prepared = await prepareSend(item, { ...context, secretPlaceholders: placeholders });
  const values: ScriptRunValues = {
    vars: context.sequence ?? {},
    props: scriptProperties(scopesFor(context)),
    secrets: await listedSecrets(scripted.scripts.secrets, context.getSecret),
  };
  const collected = {
    tests: [] as ScriptTest[],
    values: [] as ScriptValue[],
    lines: [] as string[],
    truncated: false,
  };
  const collect = (outcome: ScriptOutcome): void => {
    collected.tests.push(...outcome.tests);
    collected.values.push(...outcome.values);
    collected.lines.push(...outcome.log.lines);
    collected.truncated ||= outcome.log.truncated;
  };
  /** Runs the pre-request script, if there is one, on `before`; the request as it will be sent. */
  const pre = async <S extends RequestSnapshot>(before: S): Promise<S> => {
    if (scripted.scripts.pre === undefined) return before;
    const outcome = await scripting.pre(scripted, before, values);
    collect(outcome);
    return (outcome.request ?? before) as S;
  };
  const post = async (sent: RequestSnapshot, response: ResponseSnapshot): Promise<SentScripts> => {
    let error: SentScripts['error'];
    if (scripted.scripts.post !== undefined) {
      const later = {
        ...values,
        vars: { ...values.vars, ...Object.fromEntries(collected.values.map((v) => [v.name, v.value])) },
      };
      const outcome = await scripting.post(scripted, sent, response, later);
      collect(outcome);
      if (!outcome.ok) {
        const thrown = scriptError(outcome.error, scripting.fileOf(scripted, 'post'));
        error = { code: thrown.code, message: thrown.message };
      }
    }
    return {
      tests: collected.tests,
      values: collected.values,
      log: { lines: collected.lines, truncated: collected.truncated },
      ...(error !== undefined ? { error } : {}),
    };
  };

  if (prepared.kind === 'soap' && item.kind === 'soap') {
    const expanded = expandSendInput(prepared.input, prepared.scopes, {
      entitize: prepared.input.entitize ?? false,
    }).input;
    const before = soapRequestSnapshot(expanded);
    const sent = await pre(before);
    const changed = applySoapSnapshot(expanded, sent);
    const restored = await placeholders.restore(
      {
        endpoint: changed.endpoint,
        headers: changed.headers ?? {},
        envelopeXml: changed.envelopeXml,
        ...(changed.soapAction !== undefined ? { soapAction: changed.soapAction } : {}),
      },
      context.getSecret,
    );
    // Already expanded: sent without scopes, so nothing the script wrote is expanded again.
    const exchange = await sendSoapRequest({ ...changed, ...restored });
    dropRefusedToken(context, prepared.input.auth, exchange.http.status === 401);
    return {
      subject: soapSubject(exchange, loaded, item),
      raw: exchange.http,
      ...originOf(exchange.http.request.url),
      script: await post(sent, soapResponseSnapshot(exchange)),
    };
  }
  if (prepared.kind === 'rest') {
    const before = restRequestSnapshot(prepared.input);
    const sent = await pre(before);
    const changed = applyRestSnapshot(prepared.input, before, sent);
    const restored = await placeholders.restore(
      { baseUrl: changed.baseUrl, request: changed.request },
      context.getSecret,
    );
    const exchange = await sendRest({ ...changed, ...restored });
    dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
    return {
      subject: restSubject(exchange),
      raw: exchange,
      ...originOf(exchange.request.url),
      script: await post(sent, restResponseSnapshot(exchange)),
    };
  }
  if (prepared.kind === 'grpc' && protoSet !== undefined) {
    const before = grpcRequestSnapshot(prepared.input, prepared.messageText);
    const sent = await pre(before);
    const changed = applyGrpcSnapshot(prepared.input, prepared.messageText, before, sent);
    const restored = await placeholders.restore(
      { metadata: changed.input.metadata, messageText: changed.messageText },
      context.getSecret,
    );
    const result = await callGrpc({
      ...changed.input,
      metadata: restored.metadata,
      set: protoSet,
      messageText: restored.messageText,
    });
    dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return {
      subject: grpcSubject(result),
      raw: result.exchange,
      origin: prepared.input.target,
      script: await post(sent, grpcResponseSnapshot(result)),
    };
  }
  throw new Error('prepareSend returned a send of the wrong protocol');
}

function originOf(url: string): { readonly origin?: string } {
  const origin = urlOrigin(url);
  return origin !== undefined ? { origin } : {};
}

/**
 * Type-checks the scripts of every selected request before a run sends anything (spec
 * §Type-checking): each request whose scripts are switched on, against its own contract's types.
 * Returns one error per request that fails, in selection order; empty when all pass.
 */
export async function checkRunScripts(
  selected: readonly SelectedRequest[],
  context: RunContext,
): Promise<readonly WirebenchError[]> {
  const scripting = context.scripting;
  const errors: WirebenchError[] = [];
  if (scripting === undefined) return errors;
  const definitions = new Map<string, Promise<LoadedDefinition | undefined>>();
  const protoSets = new Map<string, Promise<ProtoSet | undefined>>();
  const documents = new Map<string, Promise<OpenApiDocument | undefined>>();
  const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    let found = cache.get(key);
    if (found === undefined) {
      found = load();
      cache.set(key, found);
    }
    return found;
  };
  for (const item of selected) {
    const scripts = activeScripts(item.request.scripts);
    if (scripts === undefined) continue;
    const loaded =
      item.kind === 'soap'
        ? await once(definitions, item.iface.id, () => loadDefinition(context.projectDir, item.iface))
        : undefined;
    const protoSet =
      item.kind === 'grpc'
        ? await once(protoSets, item.api.id, () => loadProtoSetFor(context.projectDir, item.api).catch(() => undefined))
        : undefined;
    const openApi =
      item.kind === 'rest'
        ? await once(documents, item.api.id, () => loadOpenApiDocument(context.projectDir, item.api.slug))
        : undefined;
    try {
      await scripting.check({
        protocol: item.kind,
        path: item.path,
        name: item.request.name,
        slug: item.request.slug,
        scripts,
        types: scriptTypesFor(item, loaded, protoSet, openApi),
      });
    } catch (error) {
      errors.push(
        isWirebenchError(error)
          ? error
          : new WirebenchError('script-type-error', error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return errors;
}

/** Runs one request; a throw anywhere on the way becomes an errored result, never a stopped run. */
async function runOne(
  item: SelectedRequest,
  send: RunRequestSender,
  options: RunOptions,
  overrides: RunSendOverrides,
): Promise<{ result: RequestResult; sent?: SentRequest }> {
  try {
    const sent = await send(item, overrides);
    const { subject, raw, script } = sent;
    const own = assertionsOf(item);
    const withDefault: readonly Assertion[] =
      options.defaultSlaMs !== undefined && !own.some((a) => a.type === 'sla')
        ? [...own, { type: 'sla', maxMs: options.defaultSlaMs }]
        : own;
    const assertions = [...(await evaluateAssertions(subject, withDefault)), ...scriptAssertions(script?.tests ?? [])];
    const outcome = script?.error !== undefined ? 'errored' : outcomeOf(assertions);
    return {
      sent,
      result: {
        ...identity(item),
        outcome,
        status: subject.status,
        durationMs: subject.durationMs,
        assertions,
        unasserted: own.length === 0 && (script?.tests.length ?? 0) === 0,
        ...(script?.error !== undefined ? { error: script.error } : {}),
        ...scriptReport(script, sent.scriptsOff === true),
        ...(outcome !== 'passed'
          ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
          : {}),
      },
    };
  } catch (e) {
    return { result: erroredResult(item, errorOf(e)) };
  }
}

/** What a result reports of a request's scripts: their log, or that they were switched off. */
export function scriptReport(
  script: SentScripts | undefined,
  scriptsOff: boolean,
): Pick<RequestResult, 'scriptLog' | 'scriptsOff'> {
  return {
    ...(script !== undefined && script.log.lines.length > 0 ? { scriptLog: script.log.lines } : {}),
    ...(scriptsOff ? { scriptsOff: true } : {}),
  };
}

/** A thrown value as a result's `error`, with the engine's code when it has one. */
export function errorOf(e: unknown): NonNullable<RequestResult['error']> {
  return {
    code: isWirebenchError(e) ? e.code : 'internal-error',
    message: e instanceof Error ? e.message : String(e),
    ...(isWirebenchError(e) && e.details !== undefined ? { details: e.details } : {}),
  };
}

/** A failed or errored exchange as a report keeps it: each side capped, not yet redacted. */
export function cappedExchange(raw: SentRequest['raw']): NonNullable<RequestResult['exchange']> {
  return { request: capped(raw.rawRequest), response: capped(raw.rawResponse) };
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
  const send = createRunSender(context);
  const results: RequestResult[] = [];
  // Values scripts set, which later requests of the run read as `${#Sequence#name}` (#63).
  const runValues = new Map<string, string>(Object.entries(context.sequence ?? {}));
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
    } else if (
      assertionsOf(item).length === 0 &&
      activeScripts(item.request.scripts)?.post === undefined &&
      options.requireAssertions === true
    ) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      const ran = await runOne(item, send, options, { sequence: Object.fromEntries(runValues) });
      result = ran.result;
      mergeScriptValues(runValues, ran.sent?.script?.values ?? [], context.onSecretValue, context.containsKnownSecret);
    }
    results.push(result);
    options.onRequestDone?.(result);
    if (options.bail === true && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  }
  const count = (outcome: RequestOutcome): number => results.filter((r) => r.outcome === outcome).length;
  // Inside a workspace the environment a run names is the workspace's.
  const environments = context.workspace?.workspace.environments ?? context.project.environments;
  const environment = environments.find((e) => e.id === context.environmentId)?.name;
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
