/**
 * The Bruno layer (spec §5): `bru`, `req`, `res` and a `expect` with `.jsonSchema`, as JavaScript that
 * runs inside the sandbox after the API and before an imported script. Bruno's `test` is the typed
 * API's own. It is written over `vars`, `props`, `request`, `response` and `execution`, so it can do
 * nothing a typed script cannot.
 *
 * Every variable scope reads `vars` then `props` and writes `vars` (spec §3.3). `bru.interpolate` is
 * unsupported: the typed script API gives a script no template resolver, and the layer does not
 * invent one. Sending requests, sleeping, cookies, modules and the request settings throw
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
const brunoExpect = (actual) => {
  const expectation = chaiExpect(actual);
  expectation.jsonSchema = (schema) => {
    const problems = jsonSchema(actual, schema);
    if (problems.length > 0) {
      const detail = problems.map((p) => (p.path === '' ? '/' : p.path) + ' ' + p.keyword + ': ' + p.message).join('; ');
      const stopped = problems.some((p) => p.keyword === 'budget');
      throw new ExpectationFailed('expected ' + show(actual) + ' to match the JSON schema' + (stopped ? ' (the check could not finish): ' : ': ') + detail);
    }
    return expectation;
  };
  return expectation;
};
define('expect', brunoExpect);

// --- bru ----------------------------------------------------------------------------------------
const cookies = new Proxy({}, { get: (target, name) => unsupported('bru.cookies.' + String(name)) });
define('bru', Object.freeze({
  getEnvVar: (name) => variables.get(name),
  setEnvVar: (name, value) => variables.set(name, value),
  getVar: (name) => variables.get(name),
  setVar: (name, value) => variables.set(name, value),
  getCollectionVar: (name) => variables.get(name),
  getFolderVar: (name) => variables.get(name),
  getRequestVar: (name) => variables.get(name),
  setNextRequest: (name) => execution.setNextRequest(name),
  runner: Object.freeze({
    skipRequest: () => execution.skipRequest(),
    stopExecution: () => execution.setNextRequest(null),
  }),
  interpolate: unsupported('bru.interpolate'),
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
  setTimeout: unsupported('req.setTimeout'),
}));

// --- res ------------------------------------------------------------------------------------------
if (input.phase === 'post') {
  const contentType = response.headers.get('content-type');
  const bodyValue = (() => {
    if (contentType !== undefined && /json/i.test(contentType)) {
      try { return response.json(); } catch { return response.text; }
    }
    return response.text;
  })();
  define('res', Object.freeze({
    status: response.status,
    headers: response.headers.toObject(),
    body: bodyValue,
    responseTime: response.durationMs,
    getStatus: () => response.status,
    getBody: () => bodyValue,
    getHeader: (name) => response.headers.get(name),
  }));
} else {
  define('res', undefined);
}
define('require', unsupported('require'));
`;
