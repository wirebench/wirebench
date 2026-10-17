/**
 * The Postman layer (spec §Postman): `pm`, `postman`, `CryptoJS`, `btoa` and `atob`, as JavaScript
 * that runs inside the sandbox after the API and before an imported script. It is written over the
 * same API a typed script uses — `vars`, `props`, `test`, `request`, `response`, `crypto`,
 * `encoding` — so it can do nothing a typed script cannot.
 *
 * `setNextRequest` and `skipRequest` are built on `execution` (#335): run control an API or folder
 * run obeys. It covers what imported collections mostly use. Anything else throws `ScriptUnsupported` naming
 * the call, which the host reports as `script-unsupported`.
 */
import { PART_CRYPTO, PART_EXPECT, PART_PAIRS, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

export const POSTMAN_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_PAIRS +
  PART_CRYPTO +
  String.raw`
const pmExpect = chaiExpect;

// --- pm.request / pm.response ------------------------------------------------------------------
const pmRequest = () => {
  const writable = input.phase === 'pre';
  const headers = {
    ...pairs(request.headers),
    add: (header) => request.headers.add(String(header.key), String(header.value)),
    upsert: (header) => request.headers.set(String(header.key), String(header.value)),
    remove: (name) => request.headers.delete(typeof name === 'object' ? String(name.key) : String(name)),
  };
  const body = {};
  if (request.body !== undefined && typeof request.body === 'object' && 'text' in request.body) {
    Object.defineProperty(body, 'raw', {
      get: () => (request.body.kind === 'other' ? undefined : request.body.text),
      set: (text) => { request.body.text = String(text); },
    });
    Object.defineProperty(body, 'mode', { get: () => (request.body.kind === 'text' ? 'raw' : request.body.kind) });
  }
  const url = {
    toString: () => String(request.url),
    getHost: () => /^[a-z]+:\/\/([^/?#:]+)/i.exec(String(request.url))?.[1] ?? '',
    getPath: () => /^[a-z]+:\/\/[^/?#]*([^?#]*)/i.exec(String(request.url))?.[1] ?? '',
    query: request.query === undefined ? undefined : {
      get: (name) => request.query.get(name),
      add: (q) => request.query.add(String(q.key), String(q.value)),
      upsert: (q) => request.query.set(String(q.key), String(q.value)),
      remove: (name) => request.query.delete(String(name)),
      toObject: () => Object.fromEntries(request.query.list().map((q) => [q.name, q.value])),
    },
  };
  return {
    get method() { return request.method; },
    set method(value) { if (writable) request.method = String(value); },
    url,
    headers,
    body,
  };
};

const pmResponse = () => {
  if (input.phase !== 'post') return undefined;
  const status = response.status;
  const code = typeof status === 'number' ? status : status.code;
  const text = response.text !== undefined ? response.text : response.message === undefined ? '' : JSON.stringify(response.message);
  const res = {
    code,
    status: response.statusText !== undefined ? response.statusText : String(code),
    headers: pairs(response.headers !== undefined ? response.headers : response.metadata),
    responseTime: response.durationMs,
    responseSize: text.length,
    json: () => (response.json !== undefined ? response.json() : JSON.parse(text)),
    text: () => text,
  };
  const has = {
    status: (expected) => {
      const passed = typeof expected === 'number' ? code === expected : res.status === String(expected);
      if (!passed) throw new ExpectationFailed('expected response to have status ' + show(expected) + ' but got ' + code);
    },
    header: (name, value) => {
      const actual = res.headers.get(name);
      if (actual === undefined || (value !== undefined && actual !== String(value))) {
        throw new ExpectationFailed('expected response to have header ' + name + (value === undefined ? '' : ' with value ' + show(value)));
      }
    },
    body: (value) => {
      if (value !== undefined && text !== String(value)) throw new ExpectationFailed('expected response body to be ' + show(value));
    },
    jsonBody: (path) => {
      const body = res.json();
      if (path !== undefined && !(String(path).split('.').reduce((o, k) => (o !== null && typeof o === 'object' && k in o ? o[k] : undefined), body) !== undefined)) {
        throw new ExpectationFailed('expected response JSON to have ' + path);
      }
    },
  };
  const be = {
    get ok() { if (code < 200 || code > 299) throw new ExpectationFailed('expected a 2xx response but got ' + code); return undefined; },
    get success() { return be.ok; },
    get clientError() { if (code < 400 || code > 499) throw new ExpectationFailed('expected a 4xx response but got ' + code); return undefined; },
    get serverError() { if (code < 500 || code > 599) throw new ExpectationFailed('expected a 5xx response but got ' + code); return undefined; },
    get error() { if (code < 400) throw new ExpectationFailed('expected an error response but got ' + code); return undefined; },
    get notFound() { if (code !== 404) throw new ExpectationFailed('expected 404 but got ' + code); return undefined; },
    get json() { res.json(); return undefined; },
  };
  res.to = { have: has, be };
  return res;
};

// --- pm, postman and the globals -----------------------------------------------------------------
const pmObject = {
  test: (name, check) => test(name, () => check()),
  expect: pmExpect,
  environment: variables,
  collectionVariables: variables,
  globals: variables,
  variables,
  info: Object.freeze({
    requestName: input.info.requestName,
    eventName: input.phase === 'pre' ? 'prerequest' : 'test',
    iteration: iteration.index,
    iterationCount: iteration.count,
  }),
  request: pmRequest(),
  sendRequest: unsupported('pm.sendRequest'),
  cookies: Object.freeze({ get: () => undefined, has: () => false, toObject: () => ({}), jar: unsupported('pm.cookies.jar') }),
  visualizer: Object.freeze({ set: unsupported('pm.visualizer') }),
  execution: Object.freeze({ setNextRequest: (name) => execution.setNextRequest(name), skipRequest: () => execution.skipRequest() }),
  iterationData: Object.freeze({
    get: (name) => iteration.data.get(name),
    has: (name) => iteration.data.get(name) !== undefined,
    toObject: () => Object.assign({}, input.data),
  }),
  vault: Object.freeze({ get: unsupported('pm.vault') }),
  require: unsupported('pm.require'),
};
const pmResponseValue = pmResponse();
if (pmResponseValue !== undefined) pmObject.response = pmResponseValue;
define('pm', Object.freeze(pmObject));
define('postman', Object.freeze({
  setNextRequest: (name) => execution.setNextRequest(name),
  setEnvironmentVariable: (name, value) => variables.set(name, value),
  getEnvironmentVariable: (name) => variables.get(name),
  setGlobalVariable: (name, value) => variables.set(name, value),
  getGlobalVariable: (name) => variables.get(name),
  clearEnvironmentVariable: (name) => variables.unset(name),
}));
define('require', unsupported('require'));
define('tests', {});
define('responseCode', pmResponseValue === undefined ? undefined : { code: pmResponseValue.code });
`;
