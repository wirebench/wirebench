/**
 * A contract tool's call (#33 spec §4, §5): the operation resolved fresh, the arguments checked, a
 * temporary request built as a new request of the operation would be, sent through the engine as
 * `send` sends it (no scripts, assertions or captures, since none were saved), recorded in History as
 * an ad-hoc entry, and the response read back as JSON. Shared by MCP and `wirebench call`.
 */
import {
  bindingContextFor,
  createRequest,
  envelopeFromJson,
  faultDetailJson,
  jsonFromEnvelope,
  redactHeaders,
  redactStructuredBody,
  validateMessage,
} from '@wirebench/engine';
import type { Project, RequestResult, RestSelected, SentExchange, SoapSelected } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { checkArgs, contractOperations, toolSchemaOf } from './contract-tools.js';
import type { ContractTool } from './contract-tools.js';
import { cutText } from './cut.js';
import { OpsError } from './errors.js';
import { MAX_STORED_CHARS } from './history-entry.js';
import { resolveOperation } from './operation-refs.js';
import type { ResolvedOperation } from './operation-refs.js';
import { clarkToQName, environmentFor, openProject } from './project.js';
import type { OpenedProject } from './project.js';
import { isRecord } from './records.js';
import { redactBody } from './redact.js';
import { restRequestOf } from './rest-args.js';
import { sendAndRecord } from './send.js';

export interface CallResult {
  readonly tool: string;
  /** The operations reference. */
  readonly operation: string;
  readonly kind: 'soap' | 'rest';
  readonly status: number;
  readonly statusText: string;
  /** A 2xx status and no fault. */
  readonly ok: boolean;
  readonly durationMs: number;
  /** Lower-cased, sensitive ones redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body as JSON; a SOAP body element the operation does not describe is its XML text. */
  readonly result?: unknown;
  readonly fault?: { readonly code: string; readonly reason: string; readonly detail?: unknown };
  /** The raw body, only when `result` could not be built. */
  readonly body?: string;
  readonly bodyTruncated?: boolean;
  /** Why `body` is raw, and what the schema could not type or read. */
  readonly notes: readonly string[];
  readonly historyId?: string;
}

const input = z.object({
  tool: z.string().min(1).describe('The tool name'),
  ref: z.string().min(1).describe('The operations reference the tool stands for'),
  args: z.record(z.string(), z.unknown()).describe("The tool's arguments, the environment argument included"),
});

type SoapResolved = Extract<ResolvedOperation, { kind: 'soap' }>;
type RestResolved = Extract<ResolvedOperation, { kind: 'rest' }>;
type SoapExchange = Extract<SentExchange, { kind: 'soap' }>;
type RestExchange = Extract<SentExchange, { kind: 'rest' }>;

function requestNameFor(operationName: string, origin: 'cli' | 'mcp'): string {
  return `${operationName} (${origin === 'mcp' ? 'MCP' : 'CLI'})`;
}

/** The operation by its ref, read fresh; gone when the project no longer has it (spec §6). */
async function resolveFresh(
  opened: OpenedProject,
  projectDir: string,
  tool: string,
  ref: string,
): Promise<ResolvedOperation> {
  try {
    return await resolveOperation(opened.project, projectDir, ref);
  } catch (error) {
    if (
      error instanceof OpsError &&
      (error.code === 'operation-not-found' || error.code === 'definition-cache-missing')
    ) {
      throw new OpsError(
        'operation-gone',
        `The operation "${ref}" behind ${tool} is no longer in the project, or its definition is gone; list the tools again`,
        { tool, ref },
      );
    }
    throw error;
  }
}

/** Spec §4.1 SOAP: the envelope from the arguments, checked against the XSD, as a new request. */
async function prepareSoap(
  resolved: SoapResolved,
  args: Readonly<Record<string, unknown>>,
  origin: 'cli' | 'mcp',
): Promise<{ readonly item: SoapSelected; readonly notes: readonly string[] }> {
  const { iface, operation, wsdl } = resolved;
  const op = { bindingName: clarkToQName(operation.bindingName), operationName: operation.name };
  const built = envelopeFromJson(wsdl, op, args);
  if (built.problems.length > 0) {
    // Nothing is sent for a body that could not be written whole.
    throw new OpsError('invalid-input', built.problems.join('; '), { problems: built.problems });
  }
  const binding = bindingContextFor(wsdl.definition, op, 'request');
  if (binding !== undefined) {
    const { problems } = await validateMessage({
      xml: built.envelopeXml,
      direction: 'request',
      schemaSet: wsdl.schemaSet,
      bundle: wsdl.bundle,
      binding,
    });
    const errors = problems.filter((problem) => problem.severity === 'error');
    if (errors.length > 0) {
      const where = (problem: (typeof errors)[number]): string => problem.path ?? `line ${String(problem.line ?? 0)}`;
      throw new OpsError(
        'invalid-input',
        `the arguments do not make a valid ${operation.name} message: ` +
          errors.map((problem) => `${where(problem)}: ${problem.message}`).join('; '),
        {
          problems: errors.map((problem) => ({
            ...(problem.path !== undefined ? { path: problem.path } : {}),
            message: problem.message,
          })),
        },
      );
    }
  }
  const endpointId = iface.defaultEndpointId ?? iface.endpoints[0]?.id;
  const name = requestNameFor(operation.name, origin);
  const group = `${iface.name}/${operation.name}`;
  return {
    item: {
      kind: 'soap',
      path: `${group}/${name}`,
      group,
      iface,
      operation,
      request: createRequest(name, {
        envelopeXml: built.envelopeXml,
        soapVersion: built.soapVersion,
        ...(built.soapAction !== undefined ? { soapAction: built.soapAction } : {}),
        ...(endpointId !== undefined ? { endpointId } : {}),
      }),
    },
    // What the envelope met while it was written: schema gaps the call ran into, returned with the result.
    notes: built.notes,
  };
}

/** Spec §4.1 REST: a new request of the endpoint, filled from the arguments, under the API. */
function prepareRest(
  resolved: RestResolved,
  args: Readonly<Record<string, unknown>>,
  operationName: string,
  origin: 'cli' | 'mcp',
): RestSelected {
  const name = requestNameFor(operationName, origin);
  return {
    kind: 'rest',
    path: `${resolved.api.name}/${name}`,
    group: resolved.api.name,
    api: resolved.api,
    chain: [],
    request: restRequestOf(resolved.operation, args, name),
  };
}

/** The engine could not tell where to send: no endpoint (SOAP) or no base URL (REST) — spec revision R4. */
function noEndpoint(result: RequestResult, container: string, environment: string | undefined): OpsError | undefined {
  const error = result.error;
  if (error === undefined) {
    return undefined;
  }
  const problems = error.details?.['problems'];
  const noHost =
    error.code === 'rest-url-incomplete' &&
    Array.isArray(problems) &&
    problems.some((problem) => isRecord(problem) && problem['code'] === 'no-host');
  if (error.code !== 'endpoint-unresolved' && !noHost) {
    return undefined;
  }
  const under = environment === undefined ? '' : ` under the environment "${environment}"`;
  return new OpsError(
    'no-endpoint',
    `"${container}" has no endpoint${under}; set one on the interface or API, or in the environment`,
    { container, ...(environment !== undefined ? { environment } : {}) },
  );
}

/** What the response said, before the JSON redaction. */
interface Outcome {
  readonly result?: unknown;
  readonly fault?: { readonly code: string; readonly reason: string; readonly detail?: unknown };
  readonly body?: string;
  readonly bodyTruncated?: boolean;
  readonly notes: readonly string[];
}

function rawBody(
  text: string,
  contentType: string | undefined,
  mask: (text: string) => string,
  truncated: boolean,
): { readonly body: string; readonly bodyTruncated: boolean } {
  // Masked before it is cut, as `send` does.
  const masked = mask(redactBody(text, contentType));
  return { body: cutText(masked, MAX_STORED_CHARS), bodyTruncated: truncated || masked.length > MAX_STORED_CHARS };
}

function soapOutcome(resolved: SoapResolved, exchange: SoapExchange, mask: (text: string) => string): Outcome {
  const op = { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name };
  const { http, response } = exchange.soap;
  const notes: string[] = [];
  const fault = response?.fault;
  if (fault !== undefined) {
    let detail: unknown;
    if (fault.detailXml !== undefined) {
      const read = faultDetailJson(resolved.wsdl, op, fault.detailXml);
      if (read === undefined) {
        detail = redactBody(fault.detailXml, 'text/xml');
      } else {
        detail = read.value;
        notes.push(...read.notes);
      }
    }
    return { fault: { code: fault.code, reason: fault.reason, ...(detail !== undefined ? { detail } : {}) }, notes };
  }
  if (response?.isSoap === true) {
    const read = jsonFromEnvelope(resolved.wsdl, op, response.envelopeXml);
    notes.push(...read.notes);
    if (read.value !== undefined) {
      return { result: read.value, notes };
    }
  }
  notes.push('the response is not a SOAP message this operation describes; its body is returned as text');
  const text = response?.envelopeXml ?? new TextDecoder().decode(http.body);
  return { ...rawBody(text, http.headers['content-type'], mask, http.truncated), notes };
}

/** A JSON body parsed; anything else, or JSON cut short, as text with a note (spec §4.2). */
function restOutcome(exchange: RestExchange, mask: (text: string) => string): Outcome {
  const { rest } = exchange;
  const contentType = rest.headers['content-type'];
  if (rest.text.trim() === '') {
    return { notes: ['the response has no body'] };
  }
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(rest.text);
  if (looksJson && !rest.truncated) {
    try {
      return { result: JSON.parse(rest.text) as unknown, notes: [] };
    } catch {
      // Returned as text below.
    }
  }
  const why = !looksJson ? 'not JSON' : rest.truncated ? 'cut short' : 'not valid JSON';
  return {
    ...rawBody(rest.text, contentType, mask, rest.truncated),
    notes: [`the response body is ${why}; it is returned as text`],
  };
}

/** A number or boolean, or a key, that holds a resolved secret, masked; strings are `runOp`'s step. */
function maskScalars(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value);
    const masked = mask(text);
    return masked === text ? value : masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskScalars(item, mask));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), maskScalars(item, mask)]));
  }
  return value;
}

/**
 * Spec §5 redaction: secret-key redaction over the JSON, then the resolved secrets wherever they are.
 * A string (XML kept as text) is redacted as XML.
 */
function redactJson(value: unknown, mask: (text: string) => string): unknown {
  if (value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactBody(value, 'text/xml');
  }
  const redacted = JSON.parse(
    redactStructuredBody(JSON.stringify(value), 'application/json', { show: false }),
  ) as unknown;
  return maskScalars(redacted, mask);
}

export const callOp = defineOp({
  name: 'call',
  title: 'Call a contract operation',
  description:
    'Calls one operation of an imported contract with JSON arguments: builds the request a new request of the ' +
    "operation would be, sends it under the container's endpoint, auth and secrets, records it in History, and " +
    'returns the response as JSON. Needs --allow-send.',
  input,
  async run(value, context): Promise<CallResult> {
    if (!context.gates.send) {
      throw new OpsError(
        'send-not-allowed',
        `This server was started without --allow-send; ${value.tool} sends a request and needs it`,
      );
    }
    const opened = await openProject(context);
    const resolved = await resolveFresh(opened, context.projectDir, value.tool, value.ref);
    const { inputSchema, environmentKey } = toolSchemaOf(resolved);
    checkArgs(inputSchema, value.args);
    const wanted = value.args[environmentKey];
    const environment = environmentFor(
      opened,
      typeof wanted === 'string' ? wanted : undefined,
      context.gates.environments,
    );
    const args = Object.fromEntries(Object.entries(value.args).filter(([key]) => key !== environmentKey));
    const operationName =
      resolved.kind === 'soap'
        ? resolved.operation.name
        : (resolved.operation.operationId ?? `${resolved.operation.method.toUpperCase()} ${resolved.operation.path}`);
    const prepared =
      resolved.kind === 'soap'
        ? await prepareSoap(resolved, args, context.origin)
        : { item: prepareRest(resolved, args, operationName, context.origin), notes: [] };
    const { item } = prepared;
    const container = resolved.kind === 'soap' ? resolved.iface.name : resolved.api.name;
    const sent = await sendAndRecord({
      item,
      opened,
      environment,
      context,
      refuse: (result) => noEndpoint(result, container, environment?.name),
      adHoc: { requestName: requestNameFor(operationName, context.origin), operationName },
    });
    const { exchange } = sent;
    let outcome: Outcome;
    if (exchange.kind === 'soap' && resolved.kind === 'soap') {
      outcome = soapOutcome(resolved, exchange, sent.mask);
    } else if (exchange.kind === 'rest' && resolved.kind === 'rest') {
      outcome = restOutcome(exchange, sent.mask);
    } else {
      throw new Error(`a ${resolved.kind} call came back with a ${exchange.kind} exchange`);
    }
    const http = exchange.kind === 'soap' ? exchange.soap.http : exchange.rest;
    return {
      tool: value.tool,
      operation: resolved.ref,
      kind: resolved.kind,
      status: http.status,
      statusText: http.statusText,
      ok: http.status >= 200 && http.status < 300 && outcome.fault === undefined,
      durationMs: sent.result.durationMs ?? 0,
      headers: redactHeaders(http.headers, { show: false }),
      ...(outcome.result !== undefined ? { result: redactJson(outcome.result, sent.mask) } : {}),
      ...(outcome.fault !== undefined
        ? {
            fault: {
              code: sent.mask(outcome.fault.code),
              reason: sent.mask(outcome.fault.reason),
              ...(outcome.fault.detail !== undefined ? { detail: redactJson(outcome.fault.detail, sent.mask) } : {}),
            },
          }
        : {}),
      ...(outcome.body !== undefined ? { body: outcome.body, bodyTruncated: outcome.bodyTruncated === true } : {}),
      notes: [...prepared.notes, ...outcome.notes],
      ...(sent.historyId !== undefined ? { historyId: sent.historyId } : {}),
    };
  },
});

/**
 * The tool `wanted` names: an `operations` reference of any form first (as `generate` takes it), else
 * a tool name. The cap does not apply here, since one operation is called; neither does `--tools`,
 * which is `wirebench mcp`'s.
 *
 * @throws OpsError `operation-not-found`, `definition-cache-missing`
 */
export async function findContractTool(project: Project, projectDir: string, wanted: string): Promise<ContractTool> {
  const entries = await contractOperations(project, projectDir, []);
  let resolved: ResolvedOperation | undefined;
  try {
    resolved = await resolveOperation(project, projectDir, wanted);
  } catch (error) {
    if (!(error instanceof OpsError) || error.code !== 'operation-not-found') {
      throw error;
    }
  }
  const entry =
    resolved !== undefined
      ? entries.find((candidate) => candidate.kind === resolved.kind && candidate.ref === resolved.ref)
      : entries.find((candidate) => candidate.name === wanted && candidate.resolved !== undefined);
  if (entry === undefined) {
    throw new OpsError(
      'operation-not-found',
      `No operation or tool matches "${wanted}"; wirebench operations lists the references`,
      { operation: wanted },
    );
  }
  const schema = toolSchemaOf(resolved ?? (entry.resolved as ResolvedOperation));
  return {
    name: entry.name,
    ref: entry.ref,
    kind: entry.kind,
    container: entry.container.name,
    description: '',
    inputSchema: schema.inputSchema,
    environmentKey: schema.environmentKey,
  };
}
