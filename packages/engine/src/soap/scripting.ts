/**
 * What a script sees of a SOAP request and its response (spec §3.4): the snapshots, the converters
 * between an expanded send and a snapshot, the API's declarations, its sandbox-side source, what
 * the script rules check, and the typed `body` a schema gives the script.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair } from '../script/model.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import { recordPairs } from '../script/send.js';
import type { SoapExchange, SoapSendInput } from './types.js';
import type { QName } from '../wsdl/qname.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { projectSoapBody, replaceSoapBody } from './script-types.js';

export interface SoapRequestSnapshot {
  readonly protocol: 'soap';
  readonly endpoint: string;
  readonly soapAction: string;
  readonly headers: readonly HeaderPair[];
  /** The whole envelope, after property expansion and before WS-Addressing or WS-Security. */
  readonly envelope: string;
  /** The body element as the object its schema describes (`types/xsd.ts`); absent when there is no schema. */
  readonly body?: unknown;
}

export interface SoapResponseSnapshot {
  readonly protocol: 'soap';
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  /** The response envelope. */
  readonly text: string;
  readonly durationMs: number;
  readonly fault?: { readonly code: string; readonly reason: string };
  /** The body element as the object its schema describes; absent when there is no schema. */
  readonly body?: unknown;
}

/** A SOAP send already expanded (with placeholders), as a script sees it. */
export function soapRequestSnapshot(expanded: SoapSendInput): SoapRequestSnapshot {
  return {
    protocol: 'soap',
    endpoint: expanded.endpoint,
    soapAction: expanded.soapAction ?? '',
    headers: recordPairs(expanded.headers),
    envelope: expanded.envelopeXml,
  };
}

/** The expanded send with a pre-request script's changes; a header set twice keeps its last value. */
export function applySoapSnapshot(expanded: SoapSendInput, after: SoapRequestSnapshot): SoapSendInput {
  return {
    ...expanded,
    endpoint: after.endpoint,
    ...(after.soapAction !== '' || expanded.soapAction !== undefined ? { soapAction: after.soapAction } : {}),
    headers: Object.fromEntries(after.headers.map(([n, v]) => [n, v])),
    envelopeXml: after.envelope,
  };
}

export function soapResponseSnapshot(exchange: SoapExchange): SoapResponseSnapshot {
  const fault = exchange.response?.fault;
  return {
    protocol: 'soap',
    status: exchange.http.status,
    headers: exchange.http.rawHeaders.map(([n, v]) => [n, v] as const),
    text: exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body),
    durationMs: exchange.durationMs,
    ...(fault !== undefined ? { fault: { code: fault.code, reason: fault.reason } } : {}),
  };
}

const SOAP_PRE = `
declare const request: {
  readonly endpoint: string;
  soapAction: string;
  readonly headers: WbWritablePairs;
  /** The whole envelope, after property expansion and before WS-Addressing and WS-Security. */
  envelope: string;
  /** The SOAP body's element, typed from the operation's input message. */
  body: WbSoapRequestBody;
};
`;

const SOAP_POST = `
declare const request: {
  readonly endpoint: string;
  readonly soapAction: string;
  readonly headers: WbPairs;
  readonly envelope: string;
  readonly body: WbSoapRequestBody;
};
declare const response: {
  readonly status: number;
  readonly headers: WbPairs;
  readonly envelope: string;
  readonly text: string;
  /** The SOAP body's element, typed from the operation's output message. */
  readonly body: WbSoapResponseBody;
  readonly fault?: { readonly code: string; readonly reason: string };
  /** Strings an XPath expression selects in the response envelope. */
  select(xpath: string, namespaces?: Record<string, string>): string[];
  readonly durationMs: number;
};
`;

const SOAP = String.raw`
const soapRequest = (snapshot, writable) => {
  const data = {
    endpoint: snapshot.endpoint,
    soapAction: snapshot.soapAction,
    headers: snapshot.headers.map(([n, v]) => [n, v]),
    envelope: snapshot.envelope,
    body: snapshot.body === undefined ? undefined : JSON.parse(JSON.stringify(snapshot.body)),
  };
  const refuse = (what) => () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const noSchema = () => {
    throw new TypeError('This operation\'s body has no schema element, so request.body is not available; use request.envelope');
  };
  const request = Object.freeze({
    get endpoint() { return data.endpoint; },
    set endpoint(value) { if (!writable) refuse('endpoint')(); data.endpoint = String(value); },
    get soapAction() { return data.soapAction; },
    set soapAction(value) {
      if (!writable) refuse('SOAPAction')();
      const text = String(value);
      if (hasCrlf(text)) throw new ScriptValueInvalid('The SOAPAction may not hold CR, LF or NUL');
      data.soapAction = text;
    },
    headers: pairsApi(data.headers, writable, 'header'),
    get envelope() { return data.envelope; },
    set envelope(value) { if (!writable) refuse('envelope')(); data.envelope = String(value); },
    get body() {
      if (snapshot.body === undefined) noSchema();
      return writable ? data.body : deepFreeze(data.body);
    },
    set body(value) {
      if (!writable) refuse('body')();
      if (snapshot.body === undefined) noSchema();
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('request.body must be a JSON value');
      data.body = JSON.parse(text);
    },
  });
  const snapshotOf = () => ({
    protocol: 'soap',
    endpoint: data.endpoint,
    soapAction: data.soapAction,
    headers: data.headers,
    envelope: data.envelope,
    ...(data.body === undefined ? {} : { body: data.body }),
  });
  return { request, snapshotOf };
};

const soapResponse = (snapshot) => deepFreeze({
  status: snapshot.status,
  headers: pairsApi(snapshot.headers.map(([n, v]) => [n, v]), false, 'header'),
  text: snapshot.text,
  envelope: snapshot.text,
  fault: snapshot.fault,
  body: snapshot.body,
  select: (xpath, namespaces) => JSON.parse(__host.xpath(snapshot.text, String(xpath), JSON.stringify(namespaces === undefined ? {} : namespaces))),
  durationMs: snapshot.durationMs,
});

if (input.phase === 'pre') {
  const built = soapRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', soapRequest(input.request, false).request);
  define('response', soapResponse(input.response));
}
`;

function withBody<T extends object>(snapshot: T, body: unknown): T {
  return body === undefined ? snapshot : { ...snapshot, body };
}

/**
 * What SOAP's script types carry for the typed `request.body` and `response.body`
 * (`RequestScriptTypes.binding`): the schema and the operation's input and output elements.
 */
export interface SoapScriptBinding {
  readonly schemas: SchemaSet;
  readonly input?: QName;
  readonly output?: QName;
}

/** The binding this module put on a request's script types, if it put one. */
function bindingOf(types: RequestScriptTypes): SoapScriptBinding | undefined {
  const binding = types.binding;
  if (typeof binding !== 'object' || binding === null || !('schemas' in binding)) return undefined;
  return binding as SoapScriptBinding;
}

const requestSchema: z.ZodType<SoapRequestSnapshot> = z.object({
  protocol: z.literal('soap'),
  endpoint: z.string(),
  soapAction: z.string(),
  headers: z.array(headerPairSchema),
  envelope: z.string(),
  body: z.unknown().optional(),
});

/** SOAP's scripting facet. */
export const soapScripting: ProtocolScripting<SoapRequestSnapshot, SoapResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? SOAP_PRE : SOAP_POST),
  reference: () => [
    { title: 'SOAP: pre-request', declarations: SOAP_PRE },
    { title: 'SOAP: post-response', declarations: SOAP_POST },
  ],
  prelude: () => SOAP,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.endpoint,
      fixed: null,
      pairs: snapshot.headers,
      lines: [snapshot.endpoint, snapshot.soapAction],
      // Not `body`: it is a view of the envelope. Core runs the rules again on the envelope it is
      // written back into, so a secret added through the body is caught there.
      texts: [snapshot.endpoint, snapshot.soapAction, snapshot.envelope, ...snapshot.headers.flat()],
    };
  },
  views: {
    /** The request with its body projected, when the schema describes the body element. */
    request(snapshot, types) {
      const binding = bindingOf(types);
      return binding === undefined
        ? snapshot
        : withBody(snapshot, projectSoapBody(binding.schemas, binding.input, snapshot.envelope));
    },
    response(snapshot, types) {
      const binding = bindingOf(types);
      return binding === undefined
        ? snapshot
        : withBody(snapshot, projectSoapBody(binding.schemas, binding.output, snapshot.text));
    },
    /**
     * Writes a changed `request.body` back into the envelope, replacing the body element. The body
     * wins over an envelope the script also edited, since it is written into that edited envelope.
     */
    writeBack(before, after, types) {
      const binding = bindingOf(types);
      const { body, ...rest } = after;
      if (body === undefined || JSON.stringify(body) === JSON.stringify(before.body) || binding?.input === undefined) {
        return { ok: true, request: rest };
      }
      try {
        return {
          ok: true,
          request: { ...rest, envelope: replaceSoapBody(binding.schemas, binding.input, rest.envelope, body) },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'script-error',
            message: `request.body could not be written: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    },
  },
};
