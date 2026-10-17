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
import {
  PART_EXPECT,
  PART_JSON_SCHEMA,
  PART_REQUEST,
  PART_RESPONSE,
  PART_UNSUPPORTED,
  PART_VARIABLES,
} from './layer-parts.js';

export const BRUNO_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_JSON_SCHEMA +
  PART_REQUEST +
  PART_RESPONSE +
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
define('req', Object.freeze({
  getUrl: requestUrl,
  setUrl: (url) => setRequestUrl('req.setUrl', url),
  getMethod: () => request.method,
  setMethod: (method) => setRequestMethod('req.setMethod', method),
  getHeader: (name) => requestHeaders.get(name),
  setHeader: (name, value) => requestHeaders.set(String(name), String(value)),
  deleteHeader: (name) => requestHeaders.delete(String(name)),
  getBody: requestBody,
  setBody: (body) => setRequestBody('req.setBody', body),
  getHeaders: () => requestHeaders.toObject(),
  setTimeout: unsupported('req.setTimeout'),
  getTimeout: unsupported('req.getTimeout'),
  setMaxRedirects: unsupported('req.setMaxRedirects'),
  onFail: unsupported('req.onFail'),
  disableParsingResponseJson: unsupported('req.disableParsingResponseJson'),
}));

// --- res ------------------------------------------------------------------------------------------
if (responseView !== undefined) {
  const headers = {};
  for (const { name, value } of responseView.headers.list()) {
    const key = name.toLowerCase();
    headers[key] = key in headers ? headers[key] + ', ' + value : value;
  }
  define('res', Object.freeze({
    status: responseView.status,
    headers: Object.freeze(headers),
    get body() { return responseView.body(); },
    responseTime: responseView.durationMs,
    getStatus: () => responseView.status,
    getBody: () => responseView.body(),
    getHeader: (name) => headers[String(name).toLowerCase()],
    getResponseTime: () => responseView.durationMs,
  }));
} else {
  define('res', undefined);
}
define('require', unsupported('require'));
`;
