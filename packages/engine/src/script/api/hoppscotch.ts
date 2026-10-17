/**
 * The Hoppscotch layer (spec §6): `pw`, `hopp` and `pm`, as JavaScript that runs inside the sandbox
 * after the API and before an imported script. Hoppscotch scripts carry no language marker and may
 * mix the three, so one layer defines all of them. It is written over `vars`, `props`, `request` and
 * `response`, so it can do nothing a typed script cannot.
 *
 * The shapes follow Hoppscotch's own sandbox (hoppscotch-js-sandbox): response headers are a list of
 * `{ key, value }` rows, `pw.response.body` is the parsed JSON for a JSON content type and the text
 * otherwise, `pw.expect` has the jest-style matchers only, and `hopp.expect` has those and the chai
 * chains. `hopp.request` setters change the request before it is sent; after it they throw, as every
 * request setter in a response script does.
 *
 * Every variable scope reads `vars` then `props` and writes `vars` (spec §3.3). `env.resolve` expands
 * `<<name>>`, Hoppscotch's own template form; `pm.variables.replaceIn` expands `{{name}}`.
 * Sending requests, cookies, modules, and the `pm` members Hoppscotch does not have throw
 * `ScriptUnsupported` naming the call.
 */
import {
  PART_CRYPTO,
  PART_EXPECT,
  PART_JEST_EXPECT,
  PART_PAIRS,
  PART_PM,
  PART_UNSUPPORTED,
  PART_VARIABLES,
} from './layer-parts.js';

export const HOPPSCOTCH_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_PAIRS +
  PART_CRYPTO +
  PART_PM +
  PART_JEST_EXPECT +
  String.raw`
// --- shared by pw and hopp ----------------------------------------------------------------------
// Hoppscotch expands <<name>> again inside what it found, up to 10 levels (research §5.1); a name with
// no value becomes "". A cycle stops at the cap, leaving what the last pass produced.
const resolve = (text) => {
  let out = String(text);
  for (let level = 0; level < 10 && out.includes('<<'); level++) {
    const next = out.replace(/<<([^<>]*)>>/g, (whole, name) => {
      const value = variables.get(name.trim());
      return value === undefined ? '' : String(value);
    });
    if (next === out) break;
    out = next;
  }
  return out;
};
const env = {
  get: (name) => variables.get(name),
  set: (name, value) => variables.set(name, value),
  unset: (name) => variables.unset(name),
  resolve,
  getResolve: (name) => { const value = variables.get(name); return value === undefined ? undefined : resolve(value); },
};
const refused = (name) => new Proxy({}, {
  get: (target, member) => (typeof member === 'symbol' || member === 'then' || member === 'toJSON' ? undefined : unsupported(name + '.' + member)),
});

// --- the response: Hoppscotch's own shape -------------------------------------------------------
let pwResponse;
let hoppResponse;
if (input.phase === 'post') {
  const headers = response.headers.list().map(({ name, value }) => Object.freeze({ key: name, value }));
  let body;
  let parsed = false;
  const bodyValue = () => {
    if (!parsed) {
      parsed = true;
      const type = response.headers.get('content-type');
      body = response.text;
      if (type !== undefined && /json/i.test(type)) {
        try { body = response.json(); } catch { body = response.text; }
      }
    }
    return body;
  };
  pwResponse = Object.freeze({
    status: response.status,
    headers: Object.freeze(headers),
    get body() { return bodyValue(); },
  });
  hoppResponse = Object.freeze({
    statusCode: response.status,
    statusText: response.statusText,
    headers: Object.freeze(headers),
    responseTime: response.durationMs,
    body: Object.freeze({
      asJSON: () => {
        const value = bodyValue();
        if (value === null || value === undefined) return null;
        if (typeof value === 'string') {
          try { return JSON.parse(value); } catch { throw new Error('Invalid JSON string'); }
        }
        return value;
      },
      asText: () => {
        const value = bodyValue();
        return value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      },
      bytes: unsupported('hopp.response.body.bytes'),
    }),
  });
}

// --- pw ---------------------------------------------------------------------------------------------
define('pw', Object.freeze({
  env: Object.freeze(env),
  response: pwResponse,
  test: (name, check) => test(name, () => check()),
  expect: jestExpect,
}));

// --- hopp -------------------------------------------------------------------------------------------
// Chai chains with the jest matchers merged in; .not reaches both.
const hoppExpect = (actual, negated = false) => {
  const chai = negated ? chaiExpect(actual).not : chaiExpect(actual);
  const both = Object.create(chai);
  for (const [name, matcher] of Object.entries(jestMatchers(actual, negated))) {
    Object.defineProperty(both, name, { value: matcher, enumerable: true });
  }
  Object.defineProperty(both, 'not', { get: () => hoppExpect(actual, !negated) });
  return both;
};
// get resolves <<name>> and, like Hoppscotch's, answers null for a name that is not set.
const scope = Object.freeze({
  get: (name) => { const value = variables.get(name); return value === undefined ? null : resolve(value); },
  getRaw: (name) => { const value = variables.get(name); return value === undefined ? null : value; },
  set: env.set,
  delete: env.unset,
  reset: unsupported('hopp.env.reset'),
  getInitialRaw: unsupported('hopp.env.getInitialRaw'),
  setInitial: unsupported('hopp.env.setInitial'),
});
const rows = (list) => list.list().map(({ name, value }) => ({ key: name, value }));
const eachRow = (list, apply) => {
  if (!Array.isArray(list)) throw new TypeError('Expected a list of { key, value } rows');
  for (const row of list) apply(row.key, row.value);
};
const bodyKind = () => request.headers.get('content-type') ?? (() => { try { JSON.parse(request.body.text); return 'application/json'; } catch { return 'text/plain'; } })();
const hoppRequest = Object.freeze({
  get url() { return request.url; },
  get method() { return request.method; },
  get headers() { return rows(request.headers); },
  get params() { return rows(request.query); },
  // { contentType, body } as Hoppscotch has it; a body a script cannot read (a form) throws the typed API's own error.
  get body() { return request.body.kind === 'none' ? { contentType: null, body: null } : { contentType: bodyKind(), body: request.body.text }; },
  get auth() { return unsupported('hopp.request.auth')(); },
  setUrl: (url) => { request.url = url; },
  setMethod: (method) => { request.method = method; },
  setHeader: (name, value) => request.headers.set(String(name), String(value)),
  setHeaders: (list) => eachRow(list, (key, value) => request.headers.set(String(key), String(value))),
  removeHeader: (name) => request.headers.delete(String(name)),
  setParam: (name, value) => request.query.set(String(name), String(value)),
  setParams: (list) => eachRow(list, (key, value) => request.query.set(String(key), String(value))),
  removeParam: (name) => request.query.delete(String(name)),
  setBody: (body) => {
    if (body === null || typeof body !== 'object' || !('body' in body)) throw new TypeError('hopp.request.setBody takes { contentType, body }');
    if (typeof body.body === 'string') request.body.text = body.body;
    else request.body.json = body.body;
  },
  setAuth: unsupported('hopp.request.setAuth'),
  variables: Object.freeze({ get: (name) => variables.get(name), set: (name, value) => variables.set(name, value) }),
});
define('hopp', Object.freeze({
  env: Object.freeze({ ...scope, active: scope, global: scope }),
  request: hoppRequest,
  response: hoppResponse,
  test: (name, check) => test(name, () => check()),
  expect: hoppExpect,
  cookies: refused('hopp.cookies'),
  fetch: unsupported('hopp.fetch'),
}));

// --- pm: Postman's object, minus what Hoppscotch's own pm does not have ------------------------------
define('pm', Object.freeze({
  ...pmObject,
  collectionVariables: refused('pm.collectionVariables'),
  iterationData: refused('pm.iterationData'),
  execution: Object.freeze({
    setNextRequest: unsupported('pm.execution.setNextRequest'),
    skipRequest: unsupported('pm.execution.skipRequest'),
  }),
}));
define('require', unsupported('require'));
`;
