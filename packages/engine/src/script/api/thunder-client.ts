/**
 * The Thunder Client layer (spec §7): `tc`, as JavaScript that runs inside the sandbox after the API
 * and before an imported script. It is written over `vars`, `props`, `request`, `response` and
 * `execution`, so it can do nothing a typed script cannot.
 *
 * The shapes follow Thunder Client's scripting API page (https://docs.thunderclient.com/scripting/api):
 * `tc.request.headers` and `tc.response.headers` are arrays of rows (`{ name, value }`, with
 * `isDisabled` on the request's), `tc.response.json` is a property, `tc.info` has the six names the
 * page lists, and `expect` is a chai global used inside `tc.test`. `tc.test` takes a boolean or a
 * function. Every `tc.setVar` scope (`local`, `global`, `request`) reads `vars` then `props` and
 * writes `vars` (spec §3.3); `tc.replaceVars` expands `{{name}}`. Request setters work in a
 * pre-request script only, as in every layer. Sending requests, modules, files, processes, waiting,
 * cookies, binary bodies, charts, `tc.request.auth` and `assert` throw `ScriptUnsupported` naming the
 * call. `tc.request.url` stays a string, so the page's `url.getParam` and `url.setParam` are only
 * scanned (spec §7), not run.
 */
import { PART_EXPECT, PART_REQUEST, PART_RESPONSE, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

/** Why `tc.response` throws in a pre-request script; the converter's TODO repeats it. */
export const TC_NO_RESPONSE_YET = 'there is no response before the request is sent';

export const THUNDER_CLIENT_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_REQUEST +
  PART_RESPONSE +
  String.raw`
// --- the request --------------------------------------------------------------------------------
const tcRequest = Object.freeze({
  id: undefined,
  get name() { return input.info.requestName; },
  get url() { return requestUrl(); },
  get method() { return request.method; },
  // https://docs.thunderclient.com/scripting/api: headers are an array of { name, value, isDisabled }.
  get headers() { return requestHeaders.list().map(({ name, value }) => Object.freeze({ name, value, isDisabled: false })); },
  get body() { return requestBody(); },
  get auth() { return unsupported('tc.request.auth', WHY.auth)(); },
  getHeader: (name) => requestHeaders.get(String(name)),
  setHeader: (name, value) => requestHeaders.set(String(name), String(value)),
  setBody: (body) => setRequestBody('tc.request.setBody', body),
});

// --- the response -------------------------------------------------------------------------------
let tcResponse;
if (responseView !== undefined) {
  // https://docs.thunderclient.com/scripting/api: headers are an array of { name, value }, original casing.
  const rows = Object.freeze(responseView.headers.list().map(({ name, value }) => Object.freeze({ name, value })));
  tcResponse = Object.freeze({
    status: responseView.status,
    time: responseView.durationMs,
    size: utf8Length(responseView.text),
    contentType: responseView.headers.get('content-type'),
    text: responseView.text,
    headers: rows,
    // Parsed when the body is JSON, whatever the content type says; undefined when it does not parse.
    get json() {
      try { return responseView.json(); } catch { return undefined; }
    },
    get cookies() { return unsupported('tc.response.cookies', WHY.cookies)(); },
    get passed() { return unsupported('tc.response.passed')(); },
    getHeader: (name) => responseView.headers.get(String(name)),
    getBinary: unsupported('tc.response.getBinary', WHY.binary),
  });
} else {
  tcResponse = new Proxy({}, {
    get: (target, member) => (typeof member === 'symbol' || member === 'then' || member === 'toJSON' ? undefined : unsupported('tc.response in a pre-request script', '${TC_NO_RESPONSE_YET}')()),
  });
}

// --- tc -----------------------------------------------------------------------------------------
define('expect', chaiExpect);
// The page lists chai's assert as a global too; only expect is run.
define('assert', new Proxy(unsupported('assert', 'use expect'), {
  get: (target, member) => (typeof member === 'symbol' || member === 'then' || member === 'toJSON' ? undefined : unsupported('assert.' + member, 'use expect')),
}));
define('tc', Object.freeze({
  info: Object.freeze({
    environmentName: undefined,
    requestName: input.info.requestName,
    collectionName: undefined,
    folderName: undefined,
    currentIteration: iteration.index,
    totalIterations: iteration.count,
  }),
  // The scope argument (local, global, request) picks nothing: every one is a run value.
  getVar: (name) => variables.get(name),
  setVar: (name, value) => variables.set(name, value),
  replaceVars: (text) => variables.replaceIn(text),
  setParam: (name, value) => requestQuery('tc.setParam').set(String(name), String(value)),
  request: tcRequest,
  response: tcResponse,
  // The page: a boolean or a function that returns a boolean or nothing.
  test: (name, result) => test(name, () => {
    const outcome = typeof result === 'function' ? result() : result;
    if (outcome === false) throw new ExpectationFailed('the test returned false');
  }),
  expect: chaiExpect,
  // With no argument it skips the current request; any argument names another request, which is out of reach.
  skipRequest: (...args) => {
    if (args.length > 0) return unsupported('tc.skipRequest with a request name', 'a script can skip only its own request')();
    return execution.skipRequest();
  },
  runRequest: unsupported('tc.runRequest', WHY.send),
  retryRequest: unsupported('tc.retryRequest', WHY.send),
  loadModule: unsupported('tc.loadModule', WHY.modules),
  loadFromPath: unsupported('tc.loadFromPath', WHY.files),
  readFile: unsupported('tc.readFile', WHY.files),
  getAbsolutePath: unsupported('tc.getAbsolutePath', WHY.files),
  exec: unsupported('tc.exec', WHY.programs),
  delay: unsupported('tc.delay', WHY.wait),
  getCookies: unsupported('tc.getCookies', WHY.cookies),
  setCookie: unsupported('tc.setCookie', WHY.cookies),
  clearCookies: unsupported('tc.clearCookies', WHY.cookies),
  chartHTML: unsupported('tc.chartHTML', WHY.visual),
}));
define('require', (path) => unsupported(typeof path === 'string' && path.startsWith('thunder-tests/') ? 'require("thunder-tests/...")' : 'require', WHY.modules)());
`;
