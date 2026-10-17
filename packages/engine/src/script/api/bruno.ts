/**
 * The Bruno layer (spec §5): `bru`, `req`, `res` and an `expect` with `.jsonSchema`, as JavaScript that
 * runs inside the sandbox after the API and before an imported script. Bruno's `test` is the typed
 * API's own. It is written over `vars`, `props`, `request`, `response` and `execution`, so it can do
 * nothing a typed script cannot.
 *
 * Every variable scope reads `vars` then `props` and writes `vars` (spec §3.3). `bru.interpolate` resolves
 * `{{name}}` through vars then props (a dynamic `{{$...}}` or `{{process.env.X}}` stays as written).
 * Sending requests, sleeping, cookies, modules and the request settings throw
 * `ScriptUnsupported` naming the call.
 */
import { PART_EXPECT, PART_JSON_SCHEMA, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

export const BRUNO_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_JSON_SCHEMA +
  String.raw`
// --- expect, with .jsonSchema ---------------------------------------------------------------------
define('expect', chaiExpectSchema);

// --- bru ----------------------------------------------------------------------------------------
const cookies = new Proxy({}, {
  get: (target, name) => (typeof name === 'symbol' || name === 'then' || name === 'toJSON' ? undefined : unsupported('bru.cookies.' + name)),
});
const interpolate = (value) => {
  if (typeof value === 'string') return variables.replaceIn(value);
  if (Array.isArray(value)) return value.map(interpolate);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item)]));
  }
  return value;
};
define('bru', Object.freeze({
  getEnvVar: (name) => variables.get(name),
  setEnvVar: (name, value) => variables.set(name, value),
  getVar: (name) => variables.get(name),
  setVar: (name, value) => variables.set(name, value),
  hasVar: (name) => variables.has(name),
  deleteVar: (name) => variables.unset(name),
  getCollectionVar: (name) => variables.get(name),
  getFolderVar: (name) => variables.get(name),
  getRequestVar: (name) => variables.get(name),
  setNextRequest: (name) => execution.setNextRequest(name),
  runner: Object.freeze({
    skipRequest: () => execution.skipRequest(),
    stopExecution: () => execution.setNextRequest(null),
  }),
  interpolate,
  sendRequest: unsupported('bru.sendRequest'),
  sleep: unsupported('bru.sleep'),
  cookies,
}));

// --- req ------------------------------------------------------------------------------------------
const bodyOf = () => {
  if (request.body.kind === 'none') return undefined;
  const text = request.body.text;
  try { return JSON.parse(text); } catch { return text; }
};
define('req', Object.freeze({
  getUrl: () => request.url,
  setUrl: (url) => { request.url = url; },
  getMethod: () => request.method,
  setMethod: (method) => { request.method = method; },
  getHeader: (name) => request.headers.get(name),
  setHeader: (name, value) => request.headers.set(String(name), String(value)),
  deleteHeader: (name) => request.headers.delete(String(name)),
  getBody: bodyOf,
  setBody: (body) => {
    if (typeof body === 'string') request.body.text = body;
    else request.body.json = body;
  },
  getHeaders: () => request.headers.toObject(),
  setTimeout: unsupported('req.setTimeout'),
  getTimeout: unsupported('req.getTimeout'),
  setMaxRedirects: unsupported('req.setMaxRedirects'),
  onFail: unsupported('req.onFail'),
  disableParsingResponseJson: unsupported('req.disableParsingResponseJson'),
}));

// --- res ------------------------------------------------------------------------------------------
if (input.phase === 'post') {
  const headers = {};
  for (const { name, value } of response.headers.list()) {
    const key = name.toLowerCase();
    headers[key] = key in headers ? headers[key] + ', ' + value : value;
  }
  let body;
  let parsed = false;
  const bodyValue = () => {
    if (!parsed) {
      parsed = true;
      const type = headers['content-type'];
      body = response.text;
      if (type !== undefined && /json/i.test(type)) {
        try { body = response.json(); } catch { body = response.text; }
      }
    }
    return body;
  };
  define('res', Object.freeze({
    status: response.status,
    headers: Object.freeze(headers),
    get body() { return bodyValue(); },
    responseTime: response.durationMs,
    getStatus: () => response.status,
    getBody: () => bodyValue(),
    getHeader: (name) => headers[String(name).toLowerCase()],
    getResponseTime: () => response.durationMs,
  }));
} else {
  define('res', undefined);
}
define('require', unsupported('require'));
`;
