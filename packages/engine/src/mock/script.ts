/**
 * Dispatch scripts (spec §Script dispatch): `dispatch.ts` picks an operation's response in the
 * ADR-0016 sandbox. It sees the request, the candidates and the scenario states, and can only name a
 * response and set scenario states. It has no vars, props or secrets, because a mock holds none.
 */

import { clampTimeout } from '../script/sandbox/host.js';
import type { ScriptSandbox } from '../script/sandbox/host.js';
import { StripError, stripTypes } from '../script/strip.js';
import type { DispatchScriptRunner, ScriptDecision } from './dispatch.js';
import { SCENARIO_NAME_PATTERN, SCENARIO_START_STATE } from './model.js';

/** The request body a script sees, at most. */
export const DISPATCH_SCRIPT_BODY_BYTES = 1024 * 1024;
/** Scenario states one run may set. */
const MAX_SCENARIO_SETS = 100;

const PRELUDE = String.raw`
const input = JSON.parse(__host.inputJson);
const hasOwn = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: false, configurable: true, enumerable: false });
};
const freeze = (value) => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
const show = (value) => {
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};
class ScriptValueInvalid extends Error { constructor(message) { super(message); this.name = 'ScriptValueInvalid'; } }

const writeLog = (...values) => __host.log(values.map(show).join(' '));
define('log', writeLog);
define('console', Object.freeze({ log: writeLog, info: writeLog, warn: writeLog, error: writeLog, debug: writeLog }));
define('crypto', Object.freeze({
  hash: (algorithm, data, encoding) => __host.hash(String(algorithm), String(data), encoding === undefined ? undefined : String(encoding)),
  hmac: (algorithm, key, data, encoding) =>
    __host.hmac(String(algorithm), String(key), String(data), encoding === undefined ? undefined : String(encoding)),
  randomUUID: () => __host.uuid(),
}));
define('encoding', Object.freeze({
  base64: (text) => __host.base64(String(text)),
  fromBase64: (text) => __host.fromBase64(String(text)),
  base64url: (text) => __host.base64url(String(text)),
  urlEncode: (text) => __host.urlEncode(String(text)),
}));

const NAME = ${String(SCENARIO_NAME_PATTERN)};
const state = { response: undefined, scenarios: new Map() };
define('request', freeze(input.request));
define('responses', freeze(input.responses));
define('scenarios', Object.freeze({
  get(name) {
    const key = String(name);
    if (state.scenarios.has(key)) return state.scenarios.get(key);
    return hasOwn(input.scenarios, key) ? input.scenarios[key] : ${JSON.stringify(SCENARIO_START_STATE)};
  },
  set(name, value) {
    const key = String(name);
    const next = String(value);
    if (!NAME.test(key) || !NAME.test(next)) {
      throw new ScriptValueInvalid('A scenario name and state hold only letters, digits, _, . and -, at most 64');
    }
    if (!state.scenarios.has(key) && state.scenarios.size >= ${String(MAX_SCENARIO_SETS)}) {
      throw new ScriptValueInvalid('A script may set at most ${String(MAX_SCENARIO_SETS)} scenario states');
    }
    state.scenarios.set(key, next);
  },
}));
define('respond', (name) => {
  state.response = String(name);
});
globalThis.__finish = () => ({ response: state.response, scenarios: Object.fromEntries(state.scenarios) });
`;

function cut(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= DISPATCH_SCRIPT_BODY_BYTES
    ? text
    : bytes.subarray(0, DISPATCH_SCRIPT_BODY_BYTES).toString('utf8');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, state]) =>
        typeof state === 'string' && SCENARIO_NAME_PATTERN.test(key) && SCENARIO_NAME_PATTERN.test(state),
    )
  );
}

/** A {@link DispatchScriptRunner} over `sandbox` (given lazily, so a mock without scripts starts none). */
export function createDispatchScriptRunner(sandbox: () => ScriptSandbox, timeoutMs?: number): DispatchScriptRunner {
  return async ({ operation, operationKey, request, view, candidates, state }) => {
    let code: string;
    try {
      code = stripTypes(operation.script ?? '');
    } catch (error) {
      return { ok: false, message: error instanceof StripError ? error.message : String(error), log: [] };
    }
    const result = await sandbox().run({
      prelude: PRELUDE,
      code,
      filename: 'dispatch.ts',
      timeoutMs: clampTimeout(timeoutMs),
      input: {
        request: {
          operation: operationKey,
          method: request.method,
          path: request.path,
          query: request.query,
          headers: request.headers.map(([name, value]) => [name, value]),
          pathParams: view.pathParams,
          body: cut(request.bodyText),
        },
        responses: candidates.map((response) => ({ id: response.id, name: response.name })),
        scenarios: state.scenarios(),
      },
    });
    const log = result.log.lines;
    if (!result.ok) {
      const where = result.error.position !== undefined ? ` (line ${result.error.position.line})` : '';
      return { ok: false, message: `${result.error.code}: ${result.error.message}${where}`, log };
    }
    const output = result.output as { response?: unknown; scenarios?: unknown } | null;
    const response = output?.response;
    const scenarios = output?.scenarios ?? {};
    if ((response !== undefined && typeof response !== 'string') || !isStringRecord(scenarios)) {
      return { ok: false, message: 'The dispatch script handed back something other than a decision', log };
    }
    const decision: ScriptDecision = {
      ok: true,
      ...(response !== undefined ? { response } : {}),
      scenarios,
      log,
    };
    return decision;
  };
}
