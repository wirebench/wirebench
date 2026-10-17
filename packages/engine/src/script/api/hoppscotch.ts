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

/**
 * A top-level `import` statement at the start of a line. It is a syntax error in a script, not a call,
 * so the runner refuses it by name before anything runs and the importer lists it as unsupported. A
 * dynamic `import(...)` is a call and is not matched. The pattern is anchored and has no repetition
 * that can overlap.
 */
export const TOP_LEVEL_IMPORT = /^[ \t]*import[ \t]*[\w{*"']/m;

/**
 * The `export {};` line Hoppscotch scripts may start with to mark a module context. It means nothing
 * here and is a syntax error in a script, so the runner blanks it (keeping the line count).
 */
export const MODULE_MARKER = /^[ \t]*export[ \t]*\{[ \t]*\}[ \t]*;?[ \t]*$/gm;

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
const resolve = (text) => String(text).replace(/<<([^<>]*)>>/g, (whole, name) => {
  const value = variables.get(name.trim());
  return value === undefined ? whole : String(value);
});
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
const scope = Object.freeze({
  get: env.get,
  getRaw: (name) => variables.get(name),
  set: env.set,
  delete: env.unset,
  reset: unsupported('hopp.env.reset'),
});
const hoppRequest = Object.freeze({
  get url() { return request.url; },
  get method() { return request.method; },
  get headers() { return request.headers.list().map(({ name, value }) => ({ key: name, value })); },
  get body() { return request.body.kind === 'none' ? '' : request.body.text; },
  setUrl: (url) => { request.url = url; },
  setMethod: (method) => { request.method = method; },
  setHeader: (name, value) => request.headers.set(String(name), String(value)),
  setParam: (name, value) => request.query.set(String(name), String(value)),
  setBody: (body) => {
    if (typeof body === 'string') request.body.text = body;
    else request.body.json = body;
  },
  setAuth: unsupported('hopp.request.setAuth'),
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
