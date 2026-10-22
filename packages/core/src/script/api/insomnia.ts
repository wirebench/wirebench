/**
 * The Insomnia layer (spec §4): `insomnia` and `$`, as JavaScript that runs inside the sandbox after
 * the API and before an imported script. Insomnia's script API is Postman-shaped, so both names are
 * the `pm` object (`PART_PM`) plus the members `pm` lacks. `baseEnvironment` and `parentFolders`
 * read through `props` and write to `vars` (spec §3.3), like every other scope. Sending requests,
 * modules, cookie writes and the vault throw `ScriptUnsupported` naming the call.
 */
import { PART_CRYPTO, PART_EXPECT, PART_PAIRS, PART_PM, PART_UNSUPPORTED, PART_VARIABLES } from './layer-parts.js';

export const INSOMNIA_LAYER =
  PART_UNSUPPORTED +
  PART_VARIABLES +
  PART_EXPECT +
  PART_PAIRS +
  PART_CRYPTO +
  PART_PM +
  String.raw`
// --- insomnia and $ ------------------------------------------------------------------------------
const insomniaObject = Object.freeze({
  ...pmObject,
  baseEnvironment: variables,
  parentFolders: variables,
  sendRequest: unsupported('insomnia.sendRequest', WHY.send),
  require: unsupported('insomnia.require', WHY.modules),
  cookies: Object.freeze({
    get: () => undefined,
    has: () => false,
    toObject: () => ({}),
    set: unsupported('insomnia.cookies.set', WHY.cookies),
    unset: unsupported('insomnia.cookies.unset', WHY.cookies),
    clear: unsupported('insomnia.cookies.clear', WHY.cookies),
  }),
  vault: Object.freeze({ get: unsupported('insomnia.vault', WHY.vault) }),
});
define('insomnia', insomniaObject);
define('$', insomniaObject);
define('require', unsupported('require', WHY.modules));
`;
