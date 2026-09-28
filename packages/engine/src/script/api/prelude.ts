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
import type { ScriptApi, ScriptPhase, ScriptProtocol } from '../model.js';
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

/** Splits and joins a URL's query without a URL class, which QuickJS lacks. */
const REST = String.raw`
const splitUrl = (url) => {
  const hashAt = url.indexOf('#');
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  return {
    base: queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt === -1 ? '' : beforeHash.slice(queryAt + 1),
    fragment,
  };
};
const decode = (text) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
const encode = (text) => encodeURIComponent(text);

const restRequest = (snapshot, writable) => {
  const data = {
    method: snapshot.method,
    url: snapshot.url,
    headers: snapshot.headers.map(([n, v]) => [n, v]),
    body: JSON.parse(JSON.stringify(snapshot.body)),
  };
  const queryPairs = () => {
    const { query } = splitUrl(data.url);
    return query === '' ? [] : query.split('&').filter((p) => p !== '').map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? [decode(part), ''] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))];
    });
  };
  const writeQuery = (pairs) => {
    const { base, fragment } = splitUrl(data.url);
    const query = pairs.map(([n, v]) => encode(n) + '=' + encode(v)).join('&');
    data.url = base + (query === '' ? '' : '?' + query) + fragment;
  };
  const refuse = (what) => () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const query = Object.freeze({
    get: (name) => { const hit = queryPairs().find(([n]) => n === String(name)); return hit === undefined ? undefined : hit[1]; },
    getAll: (name) => queryPairs().filter(([n]) => n === String(name)).map(([, v]) => v),
    list: () => queryPairs().map(([name, value]) => ({ name, value })),
    set: writable ? (name, value) => {
      const pairs = queryPairs().filter(([n]) => n !== String(name));
      pairs.push([String(name), String(value)]);
      writeQuery(pairs);
    } : refuse('query'),
    add: writable ? (name, value) => { const pairs = queryPairs(); pairs.push([String(name), String(value)]); writeQuery(pairs); } : refuse('query'),
    delete: writable ? (name) => writeQuery(queryPairs().filter(([n]) => n !== String(name))) : refuse('query'),
  });
  const headers = pairsApi(data.headers, writable, 'header');
  const bodyText = () => {
    if (data.body.kind === 'text') return data.body.text;
    if (data.body.kind === 'none') return '';
    throw new TypeError('This request\'s body is ' + data.body.description + ', which a script cannot read or change');
  };
  const body = Object.freeze({
    get kind() { return data.body.kind === 'other' ? 'other' : data.body.kind; },
    get text() { return bodyText(); },
    set text(value) {
      if (!writable) refuse('body')();
      if (data.body.kind === 'other') bodyText();
      data.body = { kind: 'text', text: String(value), language: data.body.kind === 'text' ? data.body.language : 'text' };
    },
    get json() { return JSON.parse(bodyText()); },
    set json(value) {
      if (!writable) refuse('body')();
      if (data.body.kind === 'other') bodyText();
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('body.json must be a JSON value');
      data.body = { kind: 'text', text, language: 'json' };
    },
  });
  const request = Object.freeze({
    get method() { return data.method; },
    set method(value) { if (!writable) refuse('method')(); data.method = String(value).toUpperCase(); },
    get url() { return data.url; },
    set url(value) { if (!writable) refuse('URL')(); data.url = String(value); },
    query,
    headers,
    body,
  });
  const snapshotOf = () => ({ protocol: 'rest', method: data.method, url: data.url, headers: data.headers, body: data.body });
  return { request, snapshotOf };
};

const restResponse = (snapshot) => deepFreeze({
  status: snapshot.status,
  statusText: snapshot.statusText,
  headers: pairsApi(snapshot.headers.map(([n, v]) => [n, v]), false, 'header'),
  text: snapshot.text,
  json: () => JSON.parse(snapshot.text),
  durationMs: snapshot.durationMs,
});

if (input.phase === 'pre') {
  const built = restRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', restRequest(input.request, false).request);
  define('response', restResponse(input.response));
}
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

const GRPC = String.raw`
const grpcRequest = (snapshot, writable) => {
  const data = {
    target: snapshot.target,
    method: snapshot.method,
    metadata: snapshot.metadata.map(([n, v]) => [n, v]),
    message: JSON.parse(JSON.stringify(snapshot.message === undefined ? null : snapshot.message)),
  };
  const refuse = (what) => () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const request = Object.freeze({
    get target() { return data.target; },
    get method() { return data.method; },
    metadata: pairsApi(data.metadata, writable, 'metadata'),
    get message() { return writable ? data.message : deepFreeze(data.message); },
    set message(value) {
      if (!writable) refuse('message')();
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('request.message must be a JSON value');
      data.message = JSON.parse(text);
    },
  });
  const snapshotOf = () => ({ protocol: 'grpc', target: data.target, method: data.method, metadata: data.metadata, message: data.message });
  return { request, snapshotOf };
};

const grpcResponse = (snapshot) => deepFreeze({
  status: snapshot.status,
  metadata: pairsApi(snapshot.metadata.map(([n, v]) => [n, v]), false, 'metadata'),
  trailers: pairsApi(snapshot.trailers.map(([n, v]) => [n, v]), false, 'metadata'),
  message: snapshot.message,
  durationMs: snapshot.durationMs,
});

if (input.phase === 'pre') {
  const built = grpcRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', grpcRequest(input.request, false).request);
  define('response', grpcResponse(input.response));
}
`;

const FINISH = String.raw`
globalThis.__finish = () => ({
  tests: state.tests,
  values: [...state.values.entries()].map(([name, entry]) => ({ name, value: entry.value, secret: entry.secret })),
  request: state.request === undefined ? undefined : state.request(),
});
`;

const PROTOCOL: Record<ScriptProtocol, string> = { rest: REST, soap: SOAP, grpc: GRPC };

/**
 * The prelude for one script: the common API, the protocol's `request`/`response`, any extra layer
 * (the Postman one, spec §Postman) and `__finish`. `phase` is read from the input at run time; it is a
 * parameter here only so a layer that differs by phase can be chosen.
 */
export function buildPrelude(protocol: ScriptProtocol, _phase: ScriptPhase, api: ScriptApi, layer = ''): string {
  return `'use strict';\n(() => {\n${COMMON}\n${PROTOCOL[protocol]}\n${api === 'postman' ? layer : ''}\n${FINISH}\n})();\n`;
}
