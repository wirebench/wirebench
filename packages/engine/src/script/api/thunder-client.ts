/**
 * The Thunder Client layer (spec §7): `tc`, as JavaScript that runs inside the sandbox after the API
 * and before an imported script. It is written over `vars`, `props`, `request`, `response` and
 * `execution`, so it can do nothing a typed script cannot.
 *
 * Every `tc.setVar` scope (`local`, `global`, `request`) reads `vars` then `props` and writes `vars`
 * (spec §3.3). `tc.replaceVars` expands `{{name}}` through vars then props. `tc.response.json` is a
 * property, as in the collection fixtures (`var json = tc.response.json;`); its header keys are
 * lower-cased. `tc.test` is the typed API's own; its checks use a chai `expect`, available as
 * `tc.expect` and as a global `expect`. Request setters work in a pre-request script only, as in every
 * layer. Sending requests, modules, files, processes and waiting throw `ScriptUnsupported` naming the
 * call.
 */
import { PART_EXPECT, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

export const THUNDER_CLIENT_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  String.raw`
// --- the request --------------------------------------------------------------------------------
const tcBody = () => {
  if (request.body.kind === 'none') return undefined;
  const text = request.body.text;
  try { return JSON.parse(text); } catch { return text; }
};
const tcRequest = Object.freeze({
  get name() { return input.info.requestName; },
  get url() { return request.url; },
  get method() { return request.method; },
  get headers() { return request.headers.toObject(); },
  get body() { return tcBody(); },
  getHeader: (name) => request.headers.get(String(name)),
  setHeader: (name, value) => request.headers.set(String(name), String(value)),
  setBody: (body) => {
    if (typeof body === 'string') request.body.text = body;
    else request.body.json = body;
  },
});

// --- the response -------------------------------------------------------------------------------
let tcResponse;
if (input.phase === 'post') {
  const headers = {};
  for (const { name, value } of response.headers.list()) {
    const key = name.toLowerCase();
    headers[key] = key in headers ? headers[key] + ', ' + value : value;
  }
  tcResponse = Object.freeze({
    status: response.status,
    time: response.durationMs,
    text: response.text,
    headers: Object.freeze(headers),
    // Parsed when the response is JSON; otherwise (or when it does not parse) undefined.
    get json() {
      const type = headers['content-type'];
      if (type === undefined || !/json/i.test(type)) return undefined;
      try { return response.json(); } catch { return undefined; }
    },
    getHeader: (name) => headers[String(name).toLowerCase()],
  });
}

// --- tc -----------------------------------------------------------------------------------------
define('expect', chaiExpect);
define('tc', Object.freeze({
  // The scope argument (local, global, request) picks nothing: every one is a run value.
  getVar: (name) => variables.get(name),
  setVar: (name, value) => variables.set(name, value),
  replaceVars: (text) => variables.replaceIn(text),
  setParam: (name, value) => request.query.set(String(name), String(value)),
  request: tcRequest,
  response: tcResponse,
  test: (name, check) => test(name, () => check()),
  expect: chaiExpect,
  // With no argument it skips the current request; another request's id or name cannot be reached.
  skipRequest: (...args) => {
    if (args.length > 0 && args[0] !== undefined) return unsupported('tc.skipRequest with a request name')();
    return execution.skipRequest();
  },
  runRequest: unsupported('tc.runRequest'),
  retryRequest: unsupported('tc.retryRequest'),
  loadModule: unsupported('tc.loadModule'),
  loadFromPath: unsupported('tc.loadFromPath'),
  readFile: unsupported('tc.readFile'),
  exec: unsupported('tc.exec'),
  delay: unsupported('tc.delay'),
}));
define('require', (path) => unsupported(typeof path === 'string' && path.startsWith('thunder-tests/') ? 'require("thunder-tests/...")' : 'require')());
`;
