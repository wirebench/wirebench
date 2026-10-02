/**
 * The script API, as JavaScript that runs inside the sandbox before the script (spec §API).
 *
 * It is built over `__host` (plain functions of strings) and `__host.inputJson` (the request, the
 * response and the run's values as JSON). It defines the globals a script uses and `__finish()`,
 * which hands back the tests, the values and — for a pre-request script — the changed request. The
 * host checks everything `__finish` returns (`../apply.ts`, `../run.ts`): a script can call
 * `__finish` or `__host` itself, and gains nothing by it.
 *
 * Errors a rule raises carry a name the host maps to a code: `ScriptSecretDenied` →
 * `script-secret-denied`, `ScriptValueInvalid` → `script-value-invalid`, `ScriptUnsupported` →
 * `script-unsupported`.
 */
import type { ProtocolScripting } from '../../protocol/module.js';
import type { ScriptApi, ScriptPhase } from '../model.js';
import { SCRIPT_OUTPUT_LIMITS } from '../model.js';

const COMMON = String.raw`
const input = JSON.parse(__host.inputJson);
const hasOwn = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
const state = { tests: [], values: new Map(), request: undefined };

class ScriptSecretDenied extends Error { constructor(message) { super(message); this.name = 'ScriptSecretDenied'; } }
class ScriptValueInvalid extends Error { constructor(message) { super(message); this.name = 'ScriptValueInvalid'; } }
class ScriptUnsupported extends Error { constructor(message) { super(message); this.name = 'ScriptUnsupported'; } }
class ExpectationFailed extends Error { constructor(message) { super(message); this.name = 'ExpectationFailed'; } }

const define = (name, value) => {
  Object.defineProperty(globalThis, name, { value, writable: false, configurable: true, enumerable: false });
};

const show = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return '[function]';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
};

const utf8Length = (text) => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
};

const writeLog = (...values) => __host.log(values.map(show).join(' '));
define('log', writeLog);
define('console', Object.freeze({ log: writeLog, info: writeLog, warn: writeLog, error: writeLog, debug: writeLog }));

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
define('vars', Object.freeze({
  get(name) {
    const key = String(name);
    if (state.values.has(key)) return state.values.get(key).value;
    return hasOwn(input.vars, key) ? input.vars[key] : undefined;
  },
  set(name, value, options) {
    const key = String(name);
    if (!NAME.test(key)) {
      throw new ScriptValueInvalid('A value name must start with a letter or _ and hold only letters, digits, _, . and -: "' + key + '"');
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ScriptValueInvalid('vars.set("' + key + '") takes a string, number or boolean');
    }
    const text = String(value);
    if (utf8Length(text) > ${String(SCRIPT_OUTPUT_LIMITS.valueBytes)}) {
      throw new ScriptValueInvalid('vars.set("' + key + '") is over ${String(SCRIPT_OUTPUT_LIMITS.valueBytes / 1024)} KiB');
    }
    if (!state.values.has(key) && state.values.size >= ${String(SCRIPT_OUTPUT_LIMITS.values)}) {
      throw new ScriptValueInvalid('A script may set at most ${String(SCRIPT_OUTPUT_LIMITS.values)} values');
    }
    state.values.set(key, { value: text, secret: options !== null && typeof options === 'object' && options.secret === true });
  },
}));

define('props', Object.freeze({
  get(name) {
    const key = String(name);
    return hasOwn(input.props, key) ? input.props[key] : undefined;
  },
}));

define('secrets', Object.freeze({
  get(name) {
    const key = String(name);
    if (hasOwn(input.secrets, key)) return input.secrets[key];
    throw new ScriptSecretDenied('The secret "' + key + '" is not listed in this request\'s scripts.secrets');
  },
}));

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

const deepEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  return keysA.length === keysB.length && keysA.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
};

const makeExpectation = (actual, negated) => {
  const check = (passed, description) => {
    if (passed === negated) {
      throw new ExpectationFailed('Expected ' + show(actual) + (negated ? ' not ' : ' ') + description);
    }
  };
  const matchers = {
    toBe: (expected) => check(Object.is(actual, expected), 'to be ' + show(expected)),
    toEqual: (expected) => check(deepEqual(actual, expected), 'to equal ' + show(expected)),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
    toBeFalsy: () => check(!actual, 'to be falsy'),
    toContain: (item) =>
      check(
        typeof actual === 'string' ? actual.includes(String(item)) : Array.isArray(actual) && actual.some((x) => deepEqual(x, item)),
        'to contain ' + show(item),
      ),
    toMatch: (pattern) =>
      check(typeof actual === 'string' && (pattern instanceof RegExp ? pattern.test(actual) : actual.includes(String(pattern))),
        'to match ' + String(pattern)),
    toBeGreaterThan: (n) => check(typeof actual === 'number' && actual > n, 'to be greater than ' + show(n)),
    toBeLessThan: (n) => check(typeof actual === 'number' && actual < n, 'to be less than ' + show(n)),
    toHaveLength: (n) => check(actual !== null && actual !== undefined && actual.length === n, 'to have length ' + show(n)),
    toHaveProperty: (key, ...value) => {
      const path = Array.isArray(key) ? key : String(key).split('.');
      let current = actual;
      let found = true;
      for (const part of path) {
        if (current !== null && typeof current === 'object' && part in current) current = current[part];
        else { found = false; break; }
      }
      check(found && (value.length === 0 || deepEqual(current, value[0])),
        'to have property ' + path.join('.') + (value.length === 0 ? '' : ' equal to ' + show(value[0])));
    },
  };
  return matchers;
};

define('expect', (actual) => {
  const expectation = makeExpectation(actual, false);
  Object.defineProperty(expectation, 'not', { value: makeExpectation(actual, true) });
  return Object.freeze(expectation);
});

define('test', (name, check) => {
  if (state.tests.length >= ${String(SCRIPT_OUTPUT_LIMITS.tests)}) {
    throw new ScriptValueInvalid('A script may record at most ${String(SCRIPT_OUTPUT_LIMITS.tests)} tests');
  }
  try {
    check();
    state.tests.push({ name: String(name), passed: true });
  } catch (error) {
    state.tests.push({ name: String(name), passed: false, message: error instanceof Error ? error.message : show(error) });
  }
});

const hasCrlf = (text) => /[\r\n\0]/.test(text);

/** A case-insensitive view of an ordered list of [name, value] pairs. */
const pairsApi = (pairs, writable, what) => {
  const lower = (name) => String(name).toLowerCase();
  const refuse = () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const guard = (name, value) => {
    if (hasCrlf(name) || hasCrlf(value)) {
      throw new ScriptValueInvalid('A ' + what + ' name or value may not hold CR, LF or NUL: "' + name + '"');
    }
  };
  return Object.freeze({
    get: (name) => { const hit = pairs.find(([n]) => lower(n) === lower(name)); return hit === undefined ? undefined : hit[1]; },
    getAll: (name) => pairs.filter(([n]) => lower(n) === lower(name)).map(([, v]) => v),
    has: (name) => pairs.some(([n]) => lower(n) === lower(name)),
    list: () => pairs.map(([name, value]) => ({ name, value })),
    toObject: () => Object.fromEntries(pairs.map(([n, v]) => [n, v])),
    set: writable ? (name, value) => {
      const n = String(name); const v = String(value); guard(n, v);
      const at = pairs.findIndex(([x]) => lower(x) === lower(n));
      for (let i = pairs.length - 1; i >= 0; i--) if (lower(pairs[i][0]) === lower(n)) pairs.splice(i, 1);
      pairs.splice(at === -1 ? pairs.length : at, 0, [n, v]);
    } : refuse,
    add: writable ? (name, value) => { const n = String(name); const v = String(value); guard(n, v); pairs.push([n, v]); } : refuse,
    delete: writable ? (name) => { for (let i = pairs.length - 1; i >= 0; i--) if (lower(pairs[i][0]) === lower(name)) pairs.splice(i, 1); } : refuse,
  });
};

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};
`;

const FINISH = String.raw`
globalThis.__finish = () => ({
  tests: state.tests,
  values: [...state.values.entries()].map(([name, entry]) => ({ name, value: entry.value, secret: entry.secret })),
  request: state.request === undefined ? undefined : state.request(),
});
`;

/**
 * The prelude for one script: the common API, the protocol's `request`/`response` from its
 * scripting facet, any extra layer and `__finish`.
 */
export function buildPrelude(scripting: ProtocolScripting, phase: ScriptPhase, api: ScriptApi, layer = ''): string {
  return `'use strict';\n(() => {\n${COMMON}\n${scripting.prelude(phase)}\n${api === 'postman' ? layer : ''}\n${FINISH}\n})();\n`;
}
