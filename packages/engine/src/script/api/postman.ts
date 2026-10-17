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
import { PART_CRYPTO, PART_EXPECT, PART_PAIRS, PART_PM, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

export const POSTMAN_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_PAIRS +
  PART_CRYPTO +
  PART_PM +
  String.raw`
// --- pm, postman and the globals -----------------------------------------------------------------
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
