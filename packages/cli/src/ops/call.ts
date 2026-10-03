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
import type { RequestResult, RestSelected, SentExchange, SoapSelected } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { checkArgs, toolSchemaOf } from './contract-tools.js';
import { cutText } from './cut.js';
import { OpsError } from './errors.js';
import { MAX_STORED_CHARS } from './history-entry.js';
import { resolveOperation } from './operation-refs.js';
import type { ResolvedOperation } from './operation-refs.js';
import { clarkToQName, environmentFor, openProject } from './project.js';
import type { OpenedProject } from './project.js';
import { isRecord } from './records.js';
import { redactBody } from './redact.js';
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
): Promise<SoapSelected> {
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
  };
}

/** Task 6 replaces this with the REST call. */
function prepareRest(resolved: RestResolved): RestSelected {
  throw new OpsError('unsupported-kind', `${resolved.ref}: REST operations cannot be called yet`, {
    ref: resolved.ref,
  });
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
    const item = resolved.kind === 'soap' ? await prepareSoap(resolved, args, context.origin) : prepareRest(resolved);
    const operationName =
      resolved.kind === 'soap'
        ? resolved.operation.name
        : (resolved.operation.operationId ?? `${resolved.operation.method.toUpperCase()} ${resolved.operation.path}`);
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
    if (exchange.kind !== 'soap' || resolved.kind !== 'soap') {
      throw new Error(`a ${resolved.kind} call came back with a ${exchange.kind} exchange`);
    }
    const outcome = soapOutcome(resolved, exchange, sent.mask);
    const http = exchange.soap.http;
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
      notes: outcome.notes,
      ...(sent.historyId !== undefined ? { historyId: sent.historyId } : {}),
    };
  },
});
