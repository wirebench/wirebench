/**
 * What a run needs to run a request's scripts (#63): the request's script types from the definition
 * the run has loaded, the script's view of properties and listed secrets, and the results a report
 * shows — tests as assertions, values for later requests.
 */
import type { AssertionResult } from '../assert/model.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { resolveSecretTokens, type GetSecret } from '../secrets/resolve.js';
import { grpcMessageTypes, restOperationFor, soapOperationElements } from '../script/contracts.js';
import type {
  RequestSnapshot,
  ResponseSnapshot,
  ScriptLog,
  ScriptOutcome,
  ScriptTest,
  ScriptValue,
} from '../script/model.js';
import {
  scriptError,
  type RequestScripting,
  type RequestScriptTypes,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import { grpcScriptTypes } from '../script/types/grpc.js';
import { restScriptTypes } from '../script/types/rest.js';
import { soapScriptTypes } from '../script/types/xsd.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { SelectedRequest } from './select.js';

/** What running a request's scripts produced, carried with the sent request. */
export interface SentScripts {
  readonly tests: readonly ScriptTest[];
  readonly values: readonly ScriptValue[];
  readonly log: ScriptLog;
  /** A post-response script that failed: the response is kept, the request errors. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** The script types for a selected request, from whatever definition the run has for it. */
export function scriptTypesFor(
  item: SelectedRequest,
  loaded: { readonly definition: WsdlDefinition; readonly schemaSet: SchemaSet } | undefined,
  protoSet: ProtoSet | undefined,
  openApi: OpenApiDocument | undefined,
): RequestScriptTypes {
  switch (item.kind) {
    case 'rest':
      return { generated: restScriptTypes(restOperationFor(openApi, item.request.contract)) };
    case 'grpc': {
      const types = grpcMessageTypes(protoSet, item.request.service, item.request.method);
      return {
        generated: grpcScriptTypes(types === undefined ? undefined : protoSet, types?.input ?? '', types?.output ?? ''),
      };
    }
    case 'soap': {
      if (loaded === undefined) return { generated: soapScriptTypes(undefined) };
      const elements = soapOperationElements(loaded.definition, item.operation.bindingName, item.operation.name);
      return {
        generated: soapScriptTypes(loaded.schemaSet, elements.input, elements.output),
        soap: {
          schemas: loaded.schemaSet,
          ...(elements.input !== undefined ? { input: elements.input } : {}),
          ...(elements.output !== undefined ? { output: elements.output } : {}),
        },
      };
    }
  }
}

/** The values of the secrets a request's scripts list. */
export async function listedSecrets(names: readonly string[], getSecret: GetSecret): Promise<Record<string, string>> {
  return names.length === 0 ? {} : resolveSecretTokens(names, getSecret);
}

/** A script's tests as a report's assertions. */
export function scriptAssertions(tests: readonly ScriptTest[]): AssertionResult[] {
  return tests.map((test) => ({
    type: 'script',
    label: test.name,
    outcome: test.passed ? 'passed' : 'failed',
    ...(test.message !== undefined ? { message: test.message } : {}),
  }));
}

/**
 * Adds a script's values to a run's values. A value marked secret, or holding a credential the run
 * knows, is reported for masking first (ADR-0015).
 */
export function mergeScriptValues(
  target: Map<string, string>,
  values: readonly ScriptValue[],
  onSecretValue: ((value: string) => void) | undefined,
  containsKnownSecret: ((value: string) => boolean) | undefined,
): void {
  for (const { name, value, secret } of values) {
    if (secret || containsKnownSecret?.(value) === true) onSecretValue?.(value);
    target.set(name, value);
  }
}

/** One send's scripts: the pre-request script on the prepared request, the post-response script on the response. */
export interface ScriptSession {
  /**
   * Runs the pre-request script, if there is one, on `before`; the request as it will be sent.
   *
   * @throws WirebenchError the script's failure: the request is not sent
   */
  readonly pre: <S extends RequestSnapshot>(before: S) => Promise<S>;
  /**
   * Runs the post-response script, if there is one, and returns what both scripts did. The
   * post-response script sees the pre-request script's values; its failure is returned, not thrown.
   */
  readonly post: (sent: RequestSnapshot, response: ResponseSnapshot) => Promise<SentScripts>;
}

export interface ScriptSessionOptions {
  /** Told each value a script sets that is secret, or holds a known secret, as soon as it is set. */
  readonly onSecretValue?: (value: string) => void;
  readonly containsKnownSecret?: (value: string) => boolean;
}

/**
 * The scripts of one send of `scripted`. The run and the app both send through this, so a value a
 * script marks secret is masked before anything about the send is shown, in either.
 */
export function scriptSession(
  scripting: RequestScripting,
  scripted: ScriptedRequest,
  values: ScriptRunValues,
  options: ScriptSessionOptions = {},
): ScriptSession {
  const tests: ScriptTest[] = [];
  const set: ScriptValue[] = [];
  const lines: string[] = [];
  let truncated = false;
  const collect = (outcome: ScriptOutcome): void => {
    tests.push(...outcome.tests);
    set.push(...outcome.values);
    lines.push(...outcome.log.lines);
    truncated ||= outcome.log.truncated;
    for (const { value, secret } of outcome.values) {
      if (secret || options.containsKnownSecret?.(value) === true) options.onSecretValue?.(value);
    }
  };
  return {
    pre: async (before) => {
      if (scripted.scripts.pre === undefined) return before;
      const outcome = await scripting.pre(scripted, before, values);
      collect(outcome);
      return (outcome.request ?? before) as typeof before;
    },
    post: async (sent, response) => {
      let error: SentScripts['error'];
      if (scripted.scripts.post !== undefined) {
        const later = { ...values, vars: { ...values.vars, ...Object.fromEntries(set.map((v) => [v.name, v.value])) } };
        const outcome = await scripting.post(scripted, sent, response, later);
        collect(outcome);
        if (!outcome.ok) {
          const thrown = scriptError(outcome.error, scripting.fileOf(scripted, 'post'));
          error = { code: thrown.code, message: thrown.message };
        }
      }
      return { tests, values: set, log: { lines, truncated }, ...(error !== undefined ? { error } : {}) };
    },
  };
}
