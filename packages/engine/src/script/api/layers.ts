/**
 * The layer each layered script API runs over (spec §Postman): JavaScript that runs inside the
 * sandbox after the common API and before an imported script. An API with no entry is not supported
 * yet, and a script written against it fails before it runs.
 */
import type { LayeredApi } from '../model.js';
import { BRUNO_LAYER } from './bruno.js';
import { HOPPSCOTCH_LAYER } from './hoppscotch.js';
import { INSOMNIA_LAYER } from './insomnia.js';
import { POSTMAN_LAYER } from './postman.js';
import { THUNDER_CLIENT_LAYER } from './thunder-client.js';

export const SCRIPT_LAYERS: Partial<Record<LayeredApi, string>> = {
  postman: POSTMAN_LAYER,
  insomnia: INSOMNIA_LAYER,
  bruno: BRUNO_LAYER,
  hoppscotch: HOPPSCOTCH_LAYER,
  'thunder-client': THUNDER_CLIENT_LAYER,
};
